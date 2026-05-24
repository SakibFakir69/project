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
const BASE_URL =
  process.env.API_URL && process.env.API_URL !== "undefined"
    ? process.env.API_URL
    : "https://downtubebest.duckdns.org";


const execFilePromise = promisify(execFile);
interface TunnelQuery {
  url?: string;
}

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
// Resolves redirect-based short URLs (vt.tiktok.com, youtu.be, ig.me, etc.)
// to their full canonical URL before passing to Cobalt or yt-dlp.

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

    // FIX: Clean the URL for Cobalt. Strip out everything after the "?" if it contains tracking garbage.
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
  const referer    = getReferer(url);
  const cookie     = getCookieFile(url);
  const ua         = getRandomUserAgent();
  const proxyArgs  = getProxyArgs() || [];

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
  url: string,
  quality: string = "720"
): Promise<{ url: string; audioUrl: string | null; filename: string; type: string }> {

  // FIX 1: Always resolve short/redirect URLs before sending to Cobalt
  const resolvedUrl = await resolveRedirectUrl(url);
  console.log("[Cobalt] Attempting download for:", resolvedUrl);

  const cleanQuality = quality.toString().toLowerCase().replace("p", "");

  const response = await fetch(`${process.env.COBALT_URL}/`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Accept": "application/json",
    },
    // FIX 2: Added downloadMode and youtubeVideoCodec — required by modern Cobalt
    body: JSON.stringify({
      url: resolvedUrl,
      videoQuality: cleanQuality,
      filenameStyle: "classic",
      downloadMode: "auto",        // required — tells Cobalt how to pick streams
      youtubeVideoCodec: "h264",   // prevents VP9/AV1 which mobile apps can't always play
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
        url: data.url,
        audioUrl: null,
        filename: data.filename ?? "video.mp4",
        type: data.status,
      };

    case "picker": {
      // picker = Cobalt found multiple streams (e.g. video + audio split)
      // Find the video stream and audio stream separately
      const videoItem = data.picker?.find((p: any) => p.type === "video") ?? data.picker?.[0];
      const audioItem = data.picker?.find((p: any) => p.type === "audio") ?? null;
      return {
        url: videoItem?.url ?? data.picker[0].url,
        audioUrl: audioItem?.url ?? null,
        filename: data.filename ?? "video.mp4",
        type: "picker",
      };
    }

    case "error":
      throw new Error(data.error?.code ?? "Cobalt returned error status");

    default:
      throw new Error(`Unknown Cobalt response status: ${data.status}`);
  }
}

// ── yt-dlp Info Fallback ──────────────────────────────────────────────────────

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
    timeout: TIMEOUTS.info,
    maxBuffer: 1024 * 512,
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

// ── yt-dlp Download Fallback ──────────────────────────────────────────────────

async function getYtDlpDownloadUrl(url: string) {
  // FIX 3: Prefer mp4 explicitly so the mobile app can always play it
  // "best[ext=mp4]/bestvideo[ext=mp4]+bestaudio[ext=m4a]/best" covers:
  //   - single-file mp4 (most platforms)
  //   - split video+audio mp4/m4a (YouTube)
  //   - any best stream as last resort
  const args = buildYtDlpArgs(url, [
    "-f", "best[ext=mp4]/bestvideo[ext=mp4]+bestaudio[ext=m4a]/best",
    "--get-url",
  ]);

  const { stdout } = await execFilePromise("yt-dlp", args, {
    timeout: TIMEOUTS.url,
    maxBuffer: 1024 * 256,
  });

  const urls = stdout.trim().split("\n").filter(Boolean);
  const videoUrl = urls[0];
  // If yt-dlp returned two lines, the second is the audio stream (split track)
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
  if (!isUrlSafe(url)) {
    return reply.code(400).send({ success: false, message: "Invalid or unsupported URL" });
  }

  // Resolve short URL once — reuse for both Cobalt and yt-dlp
  const resolvedUrl = await resolveRedirectUrl(url);

  // ── Try Cobalt First ────────────────────────────────────────────────────────
  try {
    const result = await getCobaltDownloadUrl(resolvedUrl, "720");
    console.log("[Cobalt] Info success for:", resolvedUrl);

    return reply.code(200).send({
      success: true,
      source: "cobalt",
      message: "Fetch video info successful (via Cobalt)",
      data: {
        title: result.filename.replace(/\.[^/.]+$/, ""),
        thumbnail: null,
        duration: 0,
        ext: result.filename.split(".").pop() ?? "mp4",
      },
    });
  } catch (cobaltError: any) {
    console.warn("[Cobalt] Info failed, falling back to yt-dlp:", cobaltError.message);
  }

  // ── Fallback: yt-dlp ────────────────────────────────────────────────────────
  try {
    const { title, thumbnail, duration, ext } = await getYtDlpInfo(resolvedUrl);

    return reply.code(200).send({
      success: true,
      source: "ytdlp",
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
    return reply.code(400).send({
      success: false,
      message: "Invalid or missing URL",
    });
  }

  // Resolve short URLs first
  const resolvedUrl = await resolveRedirectUrl(url);

  // ─────────────────────────────────────────────────────────────
  // TRY COBALT FIRST
  // ─────────────────────────────────────────────────────────────
  try {
    const result = await getCobaltDownloadUrl(
      resolvedUrl,
      String(quality)
    );

    console.log("[Cobalt] Download success for:", resolvedUrl);

    // IMPORTANT:
    // Proxy tunnel URLs through YOUR backend
    let finalVideoUrl = result.url;

    if (result.type === "tunnel") {
      finalVideoUrl =
        `${BASE_URL}/tunnel?url=` +
        encodeURIComponent(result.url);
    }
    return reply.code(200).send({
      success: true,
      source: "cobalt",

      type: result.type,

      data: {
        videoUrl: finalVideoUrl,
        audioUrl: result.audioUrl,
        filename: result.filename,
        type: result.type,
      },
    });

  } catch (cobaltError: any) {
    console.warn(
      "[Cobalt] Download failed, falling back to yt-dlp:",
      cobaltError.message
    );
  }

  // ─────────────────────────────────────────────────────────────
  // FALLBACK: yt-dlp
  // ─────────────────────────────────────────────────────────────
  try {
    const { videoUrl, audioUrl } = await getYtDlpDownloadUrl(resolvedUrl);

    // FIX: Just like Cobalt, we must tunnel yt-dlp outputs so the mobile client doesn't hit a 403 error.
    let finalVideoUrl = videoUrl;
    
    // Always proxy fallback links through our stream pipeline
    finalVideoUrl = `${BASE_URL}/tunnel?url=` + encodeURIComponent(videoUrl);

    return reply.code(200).send({
      success: true,
      source: "ytdlp",
      type: audioUrl ? "split" : "tunnel", // Changed from 'redirect' to 'tunnel'
      data: {
        videoUrl: finalVideoUrl,
        audioUrl: audioUrl,
        type: audioUrl ? "split" : "tunnel",
      },
    });

  } catch (ytdlpError: any) {

    req.log.error(
      {
        err: ytdlpError,
        url: resolvedUrl,
      },
      "Both Cobalt and yt-dlp failed for download"
    );

    const stderr =
      ytdlpError?.stderr ??
      ytdlpError?.message ??
      "";

    return reply.code(500).send({
      success: false,
      message: classifyError(stderr),

      ...(process.env.NODE_ENV === "development" && {
        error: ytdlpError?.message,
      }),
    });
  }
};

// ── 3. Resolve Short URL (Optional standalone endpoint) ───────────────────────
// Expose this if your mobile app needs to resolve URLs client-side before calling download.
// Route: GET /api/v1/resolve-url?url=https://vt.tiktok.com/xxx

export const resolveUrl = async (
  req: FastifyRequest<{ Querystring: { url: string } }>,
  reply: FastifyReply,
) => {
  const { url } = req.query as { url: string };

  if (!url || typeof url !== "string") {
    return reply.code(400).send({ success: false, message: "url query param is required" });
  }

  try {
    const resolvedUrl = await resolveRedirectUrl(url);
    return reply.code(200).send({ success: true, resolvedUrl });
  } catch (err: any) {
    return reply.code(500).send({ success: false, message: "Failed to resolve URL" });
  }
};

 const tunnel = async (
  req: FastifyRequest<{ Querystring: TunnelQuery }>,
  reply: FastifyReply
) => {
  try {
    const { url } = req.query;

    if (!url) {
      return reply.code(400).send({
        success: false,
        message: "Missing tunnel URL",
      });
    }

    const response = await fetch(url, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124 Safari/537.36",
      },
    });

    if (!response.ok) {
      return reply.code(response.status).send({
        success: false,
        message: "Failed to fetch stream",
      });
    }

    const contentType =
      response.headers.get("content-type") || "video/mp4";

    reply.header("Content-Type", contentType);
    reply.header("Access-Control-Allow-Origin", "*");

    return reply.send(response.body);

  } catch (error: any) {
    console.log(error);

    return reply.code(500).send({
      success: false,
      message: error.message || "Tunnel failed",
    });
  }
};

export const downloadController = {
  getVideoInfo,
  getDownloadLink,
  resolveUrl,   // register this route in your router if needed
  tunnel
};