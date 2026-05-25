import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { FastifyRequest, FastifyReply } from "fastify";

import { buildFormatSelector, isUrlSafe } from "../../utils/download.utils.js";
import {
  getRandomUserAgent,
  getReferer,
  getCookieFile,
  TIMEOUTS,
} from "../../constant/index.contant.js";
import { getProxyArgs } from "../../utils/proxy.utils.js";
import type { VideoQuality, DownloadType, AudioFormat } from "../../types/index.js";

// ── Config ────────────────────────────────────────────────────────────────────
const BASE_URL = process.env.API_URL ?? "https://downtubebest.duckdns.org/api/v1";
if (!process.env.API_URL) {
  console.warn("[Config] API_URL not set, using default:", BASE_URL);
}

const COBALT_URL = process.env.COBALT_URL ?? "http://cobalt-api:9000";

const execFilePromise = promisify(execFile);

interface TunnelQuery   { url?: string; }
interface VideoInfoBody { url: string; }
interface DownloadBody  {
  url: string;
  type?: DownloadType;
  quality?: VideoQuality;
  audioFormat?: AudioFormat;
}

// ── Platform Detection ────────────────────────────────────────────────────────
type Platform =
  | "youtube"
  | "tiktok"
  | "instagram"
  | "twitter"
  | "reddit"
  | "facebook"
  | "generic";

function detectPlatform(url: string): Platform {
  if (/youtube\.com|youtu\.be/i.test(url))    return "youtube";
  if (/tiktok\.com|vm\.tiktok|vt\.tiktok/i.test(url)) return "tiktok";
  if (/instagram\.com/i.test(url))            return "instagram";
  if (/twitter\.com|x\.com/i.test(url))       return "twitter";
  if (/reddit\.com|redd\.it/i.test(url))      return "reddit";
  if (/facebook\.com|fb\.watch/i.test(url))   return "facebook";
  return "generic";
}

// ── Error Classifier ──────────────────────────────────────────────────────────
interface ClassifiedError {
  message: string;
  retryable: boolean;
  statusCode: number;
}

function classifyError(stderr: string): ClassifiedError {
  const s = (stderr ?? "").toLowerCase();

  if (s.includes("429") || s.includes("rate limit") || s.includes("too many requests"))
    return { message: "Rate limit hit — try again in a few minutes", retryable: true, statusCode: 429 };

  if (s.includes("private") || s.includes("members only") || s.includes("login required"))
    return { message: "Video is private or requires login", retryable: false, statusCode: 403 };

  if (s.includes("unavailable") || s.includes("has been removed") || s.includes("no longer available"))
    return { message: "Video is unavailable or has been removed", retryable: false, statusCode: 404 };

  if (s.includes("geo") || s.includes("not available in your country"))
    return { message: "Video is geo-restricted in this region", retryable: false, statusCode: 451 };

  if (s.includes("copyright") || s.includes("blocked"))
    return { message: "Video is blocked due to copyright", retryable: false, statusCode: 403 };

  if (s.includes("network") || s.includes("connection") || s.includes("timeout"))
    return { message: "Network error — retrying", retryable: true, statusCode: 503 };

  if (s.includes("nsig") || s.includes("player") || s.includes("cipher"))
    return { message: "YouTube player error — yt-dlp may need updating", retryable: false, statusCode: 500 };

  return { message: "Failed to process video URL", retryable: false, statusCode: 500 };
}

// ── Retry Helper ──────────────────────────────────────────────────────────────
async function withRetry<T>(
  fn: () => Promise<T>,
  {
    retries   = 2,
    baseDelay = 800,
    label     = "op",
  }: { retries?: number; baseDelay?: number; label?: string } = {}
): Promise<T> {
  let lastErr: any;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (err: any) {
      lastErr = err;
      const classified = classifyError(err?.stderr ?? err?.message ?? "");
      if (!classified.retryable || attempt === retries) break;
      const delay = baseDelay * 2 ** attempt;
      console.warn(`[${label}] attempt ${attempt + 1} failed, retrying in ${delay}ms:`, err?.message);
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  throw lastErr;
}

// ── Short URL Resolver ────────────────────────────────────────────────────────
async function resolveRedirectUrl(url: string): Promise<string> {
  try {
    const res = await fetch(url, {
      method: "HEAD",
      redirect: "follow",
      signal: AbortSignal.timeout(8000),
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
          "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
      },
    });

    let resolved = res.url && res.url !== "" ? res.url : url;

    // Strip TikTok tracking params
    if (resolved.includes("tiktok.com") && resolved.includes("?")) {
      resolved = resolved.split("?")[0];
    }

    console.log(`[Resolver] ${url} → ${resolved}`);
    return resolved;
  } catch (err: any) {
    console.warn("[Resolver] Could not resolve, using original:", err?.message);
    return url;
  }
}

// ── yt-dlp Args Builder ───────────────────────────────────────────────────────
function buildYtDlpArgs(url: string, extra: string[]): string[] {
  const platform  = detectPlatform(url);
  const referer   = getReferer(url);
  const cookie    = getCookieFile(url);
  const proxyArgs = getProxyArgs() || [];

  const platformArgs: string[] = [];

  switch (platform) {
    case "tiktok":
      // TikTok needs extractor-args to avoid watermark when possible
      platformArgs.push(
        "--extractor-args", "tiktok:api_hostname=api16-normal-c-useast1a.tiktokv.com",
        "--add-header", "Accept-Encoding:identity",
      );
      break;

    case "instagram":
      // Instagram benefits from more generous timeouts
      platformArgs.push("--socket-timeout", "30");
      break;

    case "youtube":
      // PO Token workaround: use web_creator client as fallback
      platformArgs.push(
        "--extractor-args", "youtube:player_client=web_creator,web",
        "--extractor-args", "youtube:skip=dash",
      );
      break;

    case "twitter":
      platformArgs.push("--add-header", "Accept-Language:en-US,en;q=0.9");
      break;

    default:
      break;
  }

  const args: string[] = [
    "--no-check-certificate",
    "--no-playlist",
    "--socket-timeout", String(TIMEOUTS.socket ?? 30),
    "--retries", "3",
    "--fragment-retries", "3",
    "--impersonate", "chrome",
    ...proxyArgs,
    ...(referer ? ["--add-header", `Referer: ${referer}`] : []),
    ...platformArgs,
    ...extra,
    url,
  ];

  if (cookie) args.push("--cookies", cookie);
  return args;
}

// ── Cobalt Service ────────────────────────────────────────────────────────────
interface CobaltResult {
  url: string;
  audioUrl: string | null;
  filename: string;
  type: string;
}

async function getCobaltDownloadUrl(
  resolvedUrl: string,
  quality = "720"
): Promise<CobaltResult> {
  console.log("[Cobalt] Attempting download for:", resolvedUrl);

  const validQualities = ["144", "240", "360", "480", "720", "1080", "1440", "2160"];
  const cleanQuality = validQualities.includes(quality.replace("p", ""))
    ? quality.replace("p", "")
    : "720";

  const response = await fetch(`${COBALT_URL}/`, {
    method: "POST",
    signal: AbortSignal.timeout(15000),
    headers: {
      "Content-Type": "application/json",
      "Accept": "application/json",
    },
    body: JSON.stringify({
      url: resolvedUrl,
      videoQuality: cleanQuality,
      filenameStyle: "classic",
      downloadMode: "auto",
      youtubeVideoCodec: "h264",
    }),
  });

  if (!response.ok) {
    const errorBody = await response.text().catch(() => "No error body");
    console.error("[Cobalt] Rejected — status:", response.status, "body:", errorBody);
    throw new Error(`Cobalt error: ${response.status}`);
  }

  const data = (await response.json()) as any;
  console.log("[Cobalt] Response status:", data.status);

  switch (data.status) {
    case "tunnel":
    case "redirect":
      return {
        url:      data.url,
        audioUrl: null,
        filename: data.filename ?? "video.mp4",
        type:     data.status,
      };

    case "picker": {
      const videoItem = data.picker?.find((p: any) => p.type === "video") ?? data.picker?.[0];
      const audioItem = data.picker?.find((p: any) => p.type === "audio") ?? null;
      return {
        url:      videoItem?.url ?? data.picker[0].url,
        audioUrl: audioItem?.url ?? null,
        filename: data.filename ?? "video.mp4",
        type:     "picker",
      };
    }

    case "error":
      throw new Error(data.error?.code ?? "Cobalt returned error status");

    default:
      throw new Error(`Unknown Cobalt response status: ${data.status}`);
  }
}

// ── yt-dlp: Format Strategies (ordered best → most compatible) ────────────────
const FORMAT_STRATEGIES = [
  // Strategy 1: Best MP4 with separate audio (highest quality)
  "bestvideo[ext=mp4][height<=1080]+bestaudio[ext=m4a]/bestvideo[ext=mp4]+bestaudio/best[ext=mp4]",
  // Strategy 2: Any best combined stream
  "best[ext=mp4]/best[ext=webm]/best",
  // Strategy 3: Absolute fallback — whatever yt-dlp can get
  "bestvideo+bestaudio/best",
];

// ── yt-dlp Info ───────────────────────────────────────────────────────────────
async function getYtDlpInfo(url: string) {
  const args = buildYtDlpArgs(url, [
    "--simulate",
    "--no-playlist",
    "--print", "%(title)j",
    "--print", "%(thumbnail)j",
    "--print", "%(duration)j",
    "--print", "%(ext)j",
  ]);

  const { stdout } = await execFilePromise("yt-dlp", args, {
    timeout:   TIMEOUTS.info ?? 60_000,
    killSignal: "SIGKILL",
    maxBuffer:  1024 * 512,
  });

  const [title, thumbnail, duration, ext] = stdout
    .trim()
    .split("\n")
    .map((line) => {
      try { return JSON.parse(line); }
      catch { return null; }
    });

  if (!title) throw new Error("Video not found via yt-dlp");
  return { title, thumbnail, duration, ext };
}

// ── yt-dlp Download (with multi-format fallback) ──────────────────────────────
async function getYtDlpDownloadUrl(
  url: string,
  strategyIndex = 0
): Promise<{ videoUrl: string; audioUrl: string | null; strategyUsed: number }> {
  const format = FORMAT_STRATEGIES[strategyIndex] ?? FORMAT_STRATEGIES[FORMAT_STRATEGIES.length - 1];

  console.log(`[yt-dlp] Trying format strategy ${strategyIndex}: ${format.slice(0, 60)}…`);

  const args = buildYtDlpArgs(url, ["-f", format, "--get-url"]);

  const { stdout } = await execFilePromise("yt-dlp", args, {
    timeout:   TIMEOUTS.url ?? 60_000,
    killSignal: "SIGKILL",
    maxBuffer:  1024 * 256,
  });

  const urls     = stdout.trim().split("\n").filter(Boolean);
  const videoUrl = urls[0];
  const audioUrl = urls.length > 1 ? urls[1] : null;

  if (!videoUrl) throw new Error("No download URL returned by yt-dlp");
  return { videoUrl, audioUrl, strategyUsed: strategyIndex };
}

// ── yt-dlp Download with cascading format fallback ───────────────────────────
async function getYtDlpDownloadUrlWithFallback(
  url: string
): Promise<{ videoUrl: string; audioUrl: string | null; strategyUsed: number }> {
  let lastErr: any;

  for (let i = 0; i < FORMAT_STRATEGIES.length; i++) {
    try {
      return await getYtDlpDownloadUrl(url, i);
    } catch (err: any) {
      lastErr = err;
      const classified = classifyError(err?.stderr ?? err?.message ?? "");
      // Don't retry non-retryable errors (private, geo-blocked, removed)
      if (!classified.retryable && classified.statusCode !== 500) {
        console.warn(`[yt-dlp] Non-retryable error on strategy ${i}, stopping:`, err?.message);
        break;
      }
      console.warn(`[yt-dlp] Strategy ${i} failed, trying next format:`, err?.message?.slice(0, 100));
    }
  }

  throw lastErr;
}

// ── 1. Get Video Info ─────────────────────────────────────────────────────────
export const getVideoInfo = async (
  req: FastifyRequest<{ Body: VideoInfoBody }>,
  reply: FastifyReply
) => {
  const { url } = req.body;

  if (!url || typeof url !== "string") {
    return reply.code(400).send({ success: false, message: "URL is required" });
  }

  const resolvedUrl = await resolveRedirectUrl(url);

  if (!isUrlSafe(resolvedUrl)) {
    console.warn("[Info] Unsafe URL rejected:", resolvedUrl);
    return reply.code(400).send({ success: false, message: "Invalid or unsupported URL" });
  }

  // Try Cobalt and yt-dlp in parallel for speed; use whichever succeeds first
  const cobaltPromise = getCobaltDownloadUrl(resolvedUrl, "720")
    .then((r) => ({
      source: "cobalt" as const,
      data: {
        title:     r.filename.replace(/\.[^/.]+$/, ""),
        thumbnail: null,
        duration:  0,
        ext:       r.filename.split(".").pop() ?? "mp4",
      },
    }))
    .catch((e) => {
      console.warn("[Cobalt] Info parallel attempt failed:", e.message);
      return null;
    });

  const ytdlpPromise = getYtDlpInfo(resolvedUrl)
    .then((d) => ({ source: "ytdlp" as const, data: d }))
    .catch((e) => {
      console.warn("[yt-dlp] Info parallel attempt failed:", e.message);
      return null;
    });

  // Race: prefer Cobalt but accept yt-dlp if it resolves first
  const [cobaltResult, ytdlpResult] = await Promise.all([cobaltPromise, ytdlpPromise]);

  const winner = ytdlpResult ?? cobaltResult; // yt-dlp has richer metadata

  if (winner) {
    return reply.code(200).send({
      success: true,
      source:  winner.source,
      message: "Fetch video info successful",
      data:    winner.data,
    });
  }

  return reply.code(500).send({
    success: false,
    message: "Failed to fetch video info from all sources",
  });
};

// ── 2. Get Download Link ──────────────────────────────────────────────────────
export const getDownloadLink = async (
  req: FastifyRequest<{ Body: DownloadBody }>,
  reply: FastifyReply
) => {
  const { url, quality = "720" } = req.body;

  if (!url || typeof url !== "string") {
    return reply.code(400).send({ success: false, message: "Invalid or missing URL" });
  }

  const resolvedUrl = await resolveRedirectUrl(url);

  if (!isUrlSafe(resolvedUrl)) {
    console.warn("[Download] Unsafe URL rejected:", resolvedUrl);
    return reply.code(400).send({ success: false, message: "Invalid or missing URL" });
  }

  const validQualities = ["144", "240", "360", "480", "720", "1080", "1440", "2160"];
  const normalizedQuality = validQualities.includes(String(quality).replace("p", ""))
    ? String(quality).replace("p", "")
    : "720";

  const platform = detectPlatform(resolvedUrl);
  console.log(`[Download] Platform detected: ${platform} for ${resolvedUrl}`);

  // ── Tier 1: Cobalt ────────────────────────────────────────────────────────
  try {
    const result = await withRetry(
      () => getCobaltDownloadUrl(resolvedUrl, normalizedQuality),
      { retries: 1, baseDelay: 500, label: "Cobalt" }
    );
    console.log("[Cobalt] ✅ Download success for:", resolvedUrl);

    const finalAudioUrl = result.audioUrl
      ? `${BASE_URL}/tunnel?url=` + encodeURIComponent(result.audioUrl)
      : null;

    return reply.code(200).send({
      success: true,
      source:  "cobalt",
      type:    result.type,
      data: {
        videoUrl: result.url,
        audioUrl: finalAudioUrl,
        filename: result.filename,
        type:     result.type,
      },
    });
  } catch (cobaltError: any) {
    console.warn("[Cobalt] ❌ All attempts failed:", cobaltError.message?.slice(0, 120));
  }

  // ── Tier 2 & 3: yt-dlp with cascading format strategies ──────────────────
  try {
    const { videoUrl, audioUrl, strategyUsed } = await withRetry(
      () => getYtDlpDownloadUrlWithFallback(resolvedUrl),
      { retries: 1, baseDelay: 1000, label: "yt-dlp" }
    );

    console.log(`[yt-dlp] ✅ Download success (strategy ${strategyUsed}) for:`, resolvedUrl);

    const finalVideoUrl = `${BASE_URL}/tunnel?url=` + encodeURIComponent(videoUrl);
    const finalAudioUrl = audioUrl
      ? `${BASE_URL}/tunnel?url=` + encodeURIComponent(audioUrl)
      : null;

    return reply.code(200).send({
      success: true,
      source:  "ytdlp",
      type:    audioUrl ? "split" : "tunnel",
      data: {
        videoUrl: finalVideoUrl,
        audioUrl: finalAudioUrl,
        type:     audioUrl ? "split" : "tunnel",
        strategyUsed,
      },
    });
  } catch (ytdlpError: any) {
    req.log.error({ err: ytdlpError, url: resolvedUrl }, "All download sources exhausted");

    const stderr     = ytdlpError?.stderr ?? ytdlpError?.message ?? "";
    const classified = classifyError(stderr);

    return reply.code(classified.statusCode).send({
      success: false,
      message: classified.message,
      platform,
      ...(process.env.NODE_ENV === "development" && { error: ytdlpError?.message }),
    });
  }
};

// ── 3. Resolve URL ────────────────────────────────────────────────────────────
export const resolveUrl = async (
  req: FastifyRequest<{ Querystring: { url: string } }>,
  reply: FastifyReply
) => {
  const { url } = req.query as { url: string };

  if (!url || typeof url !== "string") {
    return reply.code(400).send({ success: false, message: "url query param is required" });
  }

  try {
    const resolvedUrl = await resolveRedirectUrl(url);
    if (!isUrlSafe(resolvedUrl)) {
      return reply.code(400).send({ success: false, message: "Invalid or unsupported URL" });
    }
    return reply.code(200).send({
      success: true,
      resolvedUrl,
      platform: detectPlatform(resolvedUrl),
    });
  } catch (err: any) {
    return reply.code(500).send({ success: false, message: "Failed to resolve URL" });
  }
};

// ── 4. Tunnel ─────────────────────────────────────────────────────────────────
const tunnel = async (req: FastifyRequest, reply: FastifyReply) => {
  const queryString = new URLSearchParams(req.query as any).toString();

  const response = await fetch(`${COBALT_URL}/tunnel?${queryString}`, {
    signal: AbortSignal.timeout(30000),
  });

  reply.header("Content-Type", response.headers.get("content-type") || "video/mp4");
  const contentLength = response.headers.get("content-length");
  if (contentLength) reply.header("Content-Length", contentLength);

  return reply.send(response.body);
};

export const downloadController = {
  getVideoInfo,
  getDownloadLink,
  resolveUrl,
  tunnel,
};