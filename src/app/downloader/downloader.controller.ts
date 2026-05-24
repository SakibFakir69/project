import dotenv from "dotenv";
dotenv.config();


import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { FastifyRequest, FastifyReply } from "fastify";

import { buildFormatSelector, isUrlSafe } from "../../utils/download.utils.js";
import {
  USER_AGENT,
  getRandomUserAgent,
  getReferer,
  getCookieFile,
  TIMEOUTS,
} from "../../constant/index.contant.js";
import { getProxyArgs } from "../../utils/proxy.utils.js";
import type { VideoQuality, DownloadType, AudioFormat } from "../../types/index.js";

// ── Config ────────────────────────────────────────────────────────────────────
if (!process.env.API_URL || process.env.API_URL === "undefined") {
  throw new Error("API_URL environment variable is required");
}
const BASE_URL = process.env.API_URL;

const MAX_TUNNEL_BYTES = 500 * 1024 * 1024; // 500 MB

// Hosts that Cobalt/yt-dlp legitimately return — only these can be tunneled
const ALLOWED_TUNNEL_HOSTS = [
  'tiktok.com',
  'v19-webapp.tiktok.com',
  'v19.tiktokcdn.com',
  'googlevideo.com',
  'fbcdn.net',
  'cdninstagram.com',
  'twimg.com',
  'redd.it',
  'redditmedia.com',
  'reddituploads.com',
  'cobalt.tools',
  'youtube.com',
];

const execFilePromise = promisify(execFile);

interface TunnelQuery  { url?: string; }
interface VideoInfoBody { url: string; }
interface DownloadBody {
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

    // Strip TikTok tracking params — Cobalt rejects URLs with query garbage
    if (resolved.includes("tiktok.com") && resolved.includes("?")) {
      resolved = resolved.split("?")[0];
    }

    console.log(`[Resolver] ${url} → ${resolved}`);
    return resolved;
  } catch (err: any) {
    console.warn("[Resolver] Could not resolve short URL, using original:", err?.message);
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
// NOTE: expects a pre-resolved URL — do NOT pass short URLs here
async function getCobaltDownloadUrl(
  resolvedUrl: string,
  quality: string = "720"
): Promise<{ url: string; audioUrl: string | null; filename: string; type: string }> {

  console.log("[Cobalt] Attempting download for:", resolvedUrl);

  const cleanQuality = quality.toString().toLowerCase().replace("p", "");

  // FIX: AbortSignal timeout so we don't hang if Cobalt is down
  const response = await fetch(`${process.env.COBALT_URL}/`, {
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
    killSignal: 'SIGKILL', // FIX: actually kill zombie processes on timeout
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
    killSignal: 'SIGKILL', // FIX: kill zombie processes on timeout
    maxBuffer:  1024 * 256,
  });

  const urls      = stdout.trim().split("\n").filter(Boolean);
  const videoUrl  = urls[0];
  const audioUrl  = urls.length > 1 ? urls[1] : null;

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
  if (!isUrlSafe(url)) {
    return reply.code(400).send({ success: false, message: "Invalid or unsupported URL" });
  }

  const resolvedUrl = await resolveRedirectUrl(url);

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

  if (!url || typeof url !== "string" || !isUrlSafe(url)) {
    return reply.code(400).send({ success: false, message: "Invalid or missing URL" });
  }

  // Resolve once here — getCobaltDownloadUrl no longer re-resolves
  const resolvedUrl = await resolveRedirectUrl(url);

  // ── Try Cobalt ────────────────────────────────────────────────────────────
  try {
    const result = await getCobaltDownloadUrl(resolvedUrl, String(quality));
    console.log("[Cobalt] Download success for:", resolvedUrl);

    let finalVideoUrl = result.url;
    if (result.type === "tunnel") {
      finalVideoUrl = `${BASE_URL}/tunnel?url=` + encodeURIComponent(result.url);
    }

    return reply.code(200).send({
      success: true,
      source:  "cobalt",
      type:    result.type,
      data: {
        videoUrl: finalVideoUrl,
        audioUrl: result.audioUrl,
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

    return reply.code(200).send({
      success: true,
      source:  "ytdlp",
      type:    audioUrl ? "split" : "tunnel",
      data: {
        videoUrl: finalVideoUrl,
        audioUrl: audioUrl,
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

// ── 3. Resolve URL (standalone endpoint) ─────────────────────────────────────
export const resolveUrl = async (
  req: FastifyRequest<{ Querystring: { url: string } }>,
  reply: FastifyReply,
) => {
  const { url } = req.query as { url: string };

  if (!url || typeof url !== "string") {
    return reply.code(400).send({ success: false, message: "url query param is required" });
  }

  // FIX: safety check on the standalone resolve endpoint too
  if (!isUrlSafe(url)) {
    return reply.code(400).send({ success: false, message: "Invalid or unsupported URL" });
  }

  try {
    const resolvedUrl = await resolveRedirectUrl(url);
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

  // FIX 1: Safety check — no SSRF
  if (!isUrlSafe(url)) {
    return reply.code(403).send({ success: false, message: "URL not allowed" });
  }

  // FIX 2: Only allow known CDN hosts — prevents open proxy abuse
  let parsedHost: string;
  try {
    parsedHost = new URL(url).hostname;
  } catch {
    return reply.code(400).send({ success: false, message: "Invalid URL format" });
  }

  const isAllowedHost = ALLOWED_TUNNEL_HOSTS.some(h => parsedHost.endsWith(h));
  if (!isAllowedHost) {
    console.warn("[Tunnel] Blocked host:", parsedHost);
    return reply.code(403).send({ success: false, message: "Tunnel host not permitted" });
  }

  try {
    const response = await fetch(url, {
      signal: AbortSignal.timeout(30000), // FIX 3: timeout on tunnel fetch
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124 Safari/537.36",
      },
    });

    if (!response.ok) {
      return reply.code(response.status).send({ success: false, message: "Failed to fetch stream" });
    }

    // FIX 4: Reject oversized files before streaming
    const contentLength = response.headers.get("content-length");
    if (contentLength && parseInt(contentLength) > MAX_TUNNEL_BYTES) {
      response.body?.cancel();
      return reply.code(413).send({ success: false, message: "File too large to tunnel" });
    }

    // FIX 5: Cancel upstream fetch if client disconnects — prevents memory leak
    req.raw.on("close", () => {
      response.body?.cancel();
    });

    const contentType = response.headers.get("content-type") || "video/mp4";
    reply.header("Content-Type", contentType);
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