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
const BASE_URL = process.env.API_URL ?? "https://downtubebest.duckdns.org";
if (!process.env.API_URL) {
  console.warn("[Config] API_URL not set, using default:", BASE_URL);
}

const MAX_TUNNEL_BYTES = 500 * 1024 * 1024;

const ALLOWED_TUNNEL_HOSTS = [
  'tiktok.com',
  'tiktokcdn.com',
  'tiktokv.com',
  'v19-webapp.tiktok.com',
  'v19-webapp-prime.tiktok.com',
  'v19.tiktokcdn.com',
  'googlevideo.com',
  'fbcdn.net',
  'cdninstagram.com',
  'twimg.com',
  'video.twimg.com',
  'redd.it',
  'redditmedia.com',
  'reddituploads.com',
  'youtube.com',
];

const execFilePromise = promisify(execFile);

interface TunnelQuery   { url?: string; }
interface VideoInfoBody { url: string; }
interface DownloadBody  {
  url: string;
  type?: DownloadType;
  quality?: VideoQuality;
  audioFormat?: AudioFormat;
}

// ── Error Classifier ──────────────────────────────────────────────────────────
function classifyError(stderr: string): string {
  if (stderr.includes("429") || stderr.includes("rate limit"))
    return "Rate limit hit — try again later";
  if (stderr.includes("private") || stderr.includes("unavailable"))
    return "Video is private or unavailable";
  if (stderr.includes("geo"))
    return "Video is not available in this region";
  return "Failed to process video URL";
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
  const referer   = getReferer(url);
  const cookie    = getCookieFile(url);
  const ua        = getRandomUserAgent();
  const proxyArgs = getProxyArgs() || [];

  const args: string[] = [
    "--no-check-certificate",
    "--no-playlist",
    "--socket-timeout", String(TIMEOUTS.socket),
    "--user-agent", ua,
    ...proxyArgs,
    ...(referer ? ["--add-header", `Referer: ${referer}`] : []),
    ...extra,
    url,
  ];

  if (cookie) args.push("--cookies", cookie);
  return args;
}

// ── Cobalt Service ────────────────────────────────────────────────────────────
async function getCobaltDownloadUrl(
  resolvedUrl: string,
  quality: string = "720"
): Promise<{ url: string; audioUrl: string | null; filename: string; type: string }> {

  console.log("[Cobalt] Attempting download for:", resolvedUrl);

  // Normalize quality — "best" or non-numeric → "720"
  const validQualities = ["144","240","360","480","720","1080","1440","2160"];
  const cleanQuality = validQualities.includes(quality.replace("p",""))
    ? quality.replace("p","")
    : "720";

  const cobaltUrl = process.env.COBALT_URL ?? "http://cobalt-api:9000";

  const response = await fetch(`${cobaltUrl}/`, {
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
    timeout:    TIMEOUTS.info,
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

// ── yt-dlp Download ───────────────────────────────────────────────────────────
async function getYtDlpDownloadUrl(url: string) {
  const args = buildYtDlpArgs(url, [
    "-f", "best[ext=mp4]/bestvideo[ext=mp4]+bestaudio[ext=m4a]/best",
    "--get-url",
  ]);

  const { stdout } = await execFilePromise("yt-dlp", args, {
    timeout:    TIMEOUTS.url,
    killSignal: "SIGKILL",
    maxBuffer:  1024 * 256,
  });

  const urls     = stdout.trim().split("\n").filter(Boolean);
  const videoUrl = urls[0];
  const audioUrl = urls.length > 1 ? urls[1] : null;

  if (!videoUrl) throw new Error("No download URL found via yt-dlp");
  return { videoUrl, audioUrl };
}

// ── 1. Get Video Info ─────────────────────────────────────────────────────────
export const getVideoInfo = async (
  req: FastifyRequest<{ Body: VideoInfoBody }>,
  reply: FastifyReply,
) => {
  const { url } = req.body;

  if (!url || typeof url !== "string") {
    return reply.code(400).send({ success: false, message: "URL is required" });
  }

  // ✅ Resolve FIRST then safety check on resolved URL
  const resolvedUrl = await resolveRedirectUrl(url);

  if (!isUrlSafe(resolvedUrl)) {
    console.warn("[Info] Unsafe URL rejected:", resolvedUrl);
    return reply.code(400).send({ success: false, message: "Invalid or unsupported URL" });
  }

  try {
    const result = await getCobaltDownloadUrl(resolvedUrl, "720");
    return reply.code(200).send({
      success: true,
      source:  "cobalt",
      message: "Fetch video info successful (via Cobalt)",
      data: {
        title:     result.filename.replace(/\.[^/.]+$/, ""),
        thumbnail: null,
        duration:  0,
        ext:       result.filename.split(".").pop() ?? "mp4",
      },
    });
  } catch (cobaltError: any) {
    console.warn("[Cobalt] Info failed, falling back to yt-dlp:", cobaltError.message);
  }

  try {
    const { title, thumbnail, duration, ext } = await getYtDlpInfo(resolvedUrl);
    return reply.code(200).send({
      success: true,
      source:  "ytdlp",
      message: "Fetch video info successful (via yt-dlp)",
      data: { title, thumbnail, duration, ext },
    });
  } catch (ytdlpError: any) {
    req.log.error({ err: ytdlpError, url: resolvedUrl }, "Both Cobalt and yt-dlp failed for info");
    return reply.code(500).send({
      success: false,
      message: "Failed to fetch video info from all sources",
      ...(process.env.NODE_ENV === "development" && { error: ytdlpError?.message }),
    });
  }
};

// ── 2. Get Download Link ──────────────────────────────────────────────────────
export const getDownloadLink = async (
  req: FastifyRequest<{ Body: DownloadBody }>,
  reply: FastifyReply,
) => {
  const { url, quality = "720" } = req.body;

  if (!url || typeof url !== "string") {
    return reply.code(400).send({ success: false, message: "Invalid or missing URL" });
  }

  // ✅ Resolve FIRST — short URLs like vt.tiktok.com expand to tiktok.com
  const resolvedUrl = await resolveRedirectUrl(url);

  // ✅ Safety check on RESOLVED url, not the original short url
  if (!isUrlSafe(resolvedUrl)) {
    console.warn("[Download] Unsafe URL rejected:", resolvedUrl);
    return reply.code(400).send({ success: false, message: "Invalid or missing URL" });
  }

  // Normalize quality — strip "p", fallback to "720"
  const validQualities = ["144","240","360","480","720","1080","1440","2160"];
  const normalizedQuality = validQualities.includes(String(quality).replace("p",""))
    ? String(quality).replace("p","")
    : "720";

  // ── Try Cobalt ────────────────────────────────────────────────────────────
  try {
    const result = await getCobaltDownloadUrl(resolvedUrl, normalizedQuality);
    console.log("[Cobalt] Download success for:", resolvedUrl);

    let finalVideoUrl = result.url;
    if (result.type === "tunnel") {
      finalVideoUrl = `${BASE_URL}/tunnel?url=` + encodeURIComponent(result.url);
    }

    // Also proxy audioUrl if present
    const finalAudioUrl = result.audioUrl
      ? `${BASE_URL}/tunnel?url=` + encodeURIComponent(result.audioUrl)
      : null;

    return reply.code(200).send({
      success: true,
      source:  "cobalt",
      type:    result.type,
      data: {
        videoUrl: finalVideoUrl,
        audioUrl: finalAudioUrl,
        filename: result.filename,
        type:     result.type,
      },
    });
  } catch (cobaltError: any) {
    console.warn("[Cobalt] Download failed, falling back to yt-dlp:", cobaltError.message);
  }

  // ── Fallback: yt-dlp ──────────────────────────────────────────────────────
  try {
    const { videoUrl, audioUrl } = await getYtDlpDownloadUrl(resolvedUrl);

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
      },
    });
  } catch (ytdlpError: any) {
    req.log.error({ err: ytdlpError, url: resolvedUrl }, "Both Cobalt and yt-dlp failed");
    const stderr = ytdlpError?.stderr ?? ytdlpError?.message ?? "";
    return reply.code(500).send({
      success: false,
      message: classifyError(stderr),
      ...(process.env.NODE_ENV === "development" && { error: ytdlpError?.message }),
    });
  }
};

// ── 3. Resolve URL ────────────────────────────────────────────────────────────
export const resolveUrl = async (
  req: FastifyRequest<{ Querystring: { url: string } }>,
  reply: FastifyReply,
) => {
  const { url } = req.query as { url: string };

  if (!url || typeof url !== "string") {
    return reply.code(400).send({ success: false, message: "url query param is required" });
  }

  // ✅ Resolve first, then check safety on resolved URL
  try {
    const resolvedUrl = await resolveRedirectUrl(url);
    if (!isUrlSafe(resolvedUrl)) {
      return reply.code(400).send({ success: false, message: "Invalid or unsupported URL" });
    }
    return reply.code(200).send({ success: true, resolvedUrl });
  } catch (err: any) {
    return reply.code(500).send({ success: false, message: "Failed to resolve URL" });
  }
};

// ── 4. Tunnel ─────────────────────────────────────────────────────────────────
const tunnel = async (
  req: FastifyRequest<{ Querystring: TunnelQuery }>,
  reply: FastifyReply,
) => {
  const { url } = req.query;

  if (!url) {
    return reply.code(400).send({ success: false, message: "Missing tunnel URL" });
  }

  // Parse host first
  let parsedHost: string;
  try {
    parsedHost = new URL(url).hostname;
  } catch {
    return reply.code(400).send({ success: false, message: "Invalid URL format" });
  }

  // ✅ Check against CDN allowlist — no isUrlSafe() here since CDN URLs
  // won't be in ALLOWED_INPUT_HOSTS, only in ALLOWED_TUNNEL_HOSTS
  const isAllowedHost = ALLOWED_TUNNEL_HOSTS.some(h => parsedHost.endsWith(h));
  if (!isAllowedHost) {
    console.warn("[Tunnel] Blocked host:", parsedHost);
    return reply.code(403).send({ success: false, message: "Tunnel host not permitted" });
  }

  try {
    const response = await fetch(url, {
      signal: AbortSignal.timeout(30000),
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124 Safari/537.36",
      },
    });

    if (!response.ok) {
      return reply.code(response.status).send({ success: false, message: "Failed to fetch stream" });
    }

    const contentLength = response.headers.get("content-length");
    if (contentLength && parseInt(contentLength) > MAX_TUNNEL_BYTES) {
      response.body?.cancel();
      return reply.code(413).send({ success: false, message: "File too large to tunnel" });
    }

    req.raw.on("close", () => {
      response.body?.cancel();
    });

    reply.header("Content-Type", response.headers.get("content-type") || "video/mp4");
    reply.header("Access-Control-Allow-Origin", "*");
    return reply.send(response.body);

  } catch (error: any) {
    console.error("[Tunnel] Error:", error.message);
    return reply.code(500).send({
      success: false,
      message: error.message || "Tunnel failed",
    });
  }
};

export const downloadController = {
  getVideoInfo,
  getDownloadLink,
  resolveUrl,
  tunnel,
};