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

const execFilePromise = promisify(execFile);

const COBALT_URL = process.env.COBALT_URL || "http://localhost:9000";

interface VideoInfoBody { url: string; }
interface DownloadBody {
  url: string;
  type?: DownloadType;
  quality?: VideoQuality;
  audioFormat?: AudioFormat;
}

// ── Platform Detection ────────────────────────────────────────────────────────

function isYouTubeUrl(url: string): boolean {
  try {
    const { hostname } = new URL(url);
    return /(?:^|\.)(?:youtube\.com|youtu\.be)$/i.test(hostname);
  } catch { return false; }
}

function isTikTokUrl(url: string): boolean {
  try {
    const { hostname } = new URL(url);
    const lowerHost = hostname.toLowerCase();
    return lowerHost === "tiktok.com" || lowerHost.endsWith(".tiktok.com");
  } catch { return false; }
}

function isCobaltPlatform(url: string): boolean {
  return isYouTubeUrl(url) || isTikTokUrl(url);
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

// ── yt-dlp Args Builder ───────────────────────────────────────────────────────

function buildYtDlpArgs(url: string, extra: string[]): string[] {
  const referer = getReferer(url);
  const cookie  = getCookieFile(url);
  const ua      = getRandomUserAgent();

const proxyArgs = getProxyArgs() || [];

  const args: string[] = [
    "--no-check-certificate",
    "--no-playlist",
    "--socket-timeout", String(TIMEOUTS.socket),
    "--user-agent", ua,
    ...proxyArgs, // Always inject proxy configuration arguments securely
    ...(referer ? ["--add-header", `Referer: ${referer}`] : []),
    ...extra,
    url,
  ];

  if (cookie) args.push("--cookies", cookie);
  return args;
}

// ── Cobalt Service ────────────────────────────────────────────────────────────

// ── Cobalt Service ────────────────────────────────────────────────────────────

async function getCobaltDownloadUrl(
  url: string,
  quality: string = "720"
): Promise<{ url: string; filename: string; type: string }> {
  console.log("Routing request to Cobalt Instance:", process.env.COBALT_URL);

  // SANITIZATION: If quality is "720p", convert it to "720". If it's "1080p", convert to "1080".
  const cleanQuality = quality.toString().toLowerCase().replace("p", "");

  const response = await fetch(`${process.env.COBALT_URL}/`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Accept": "application/json",
    },
    body: JSON.stringify({
      url,
      videoQuality: cleanQuality,     // Use the sanitized clean quality string
      filenameStyle: "classic", // Valid Cobalt v10 option
    }),
  });

  if (!response.ok) {
    // If it still fails, let's log the body text from Cobalt so you can see exactly why!
    const errorBody = await response.text().catch(() => "No error body");
    console.error("Cobalt rejected payload with text:", errorBody);
    throw new Error(`Cobalt error: ${response.status}`);
  }

  const data = (await response.json()) as any;

  switch (data.status) {
    case "tunnel":
    case "redirect":
      return {
        url: data.url,
        filename: data.filename ?? "video.mp4",
        type: data.status,
      };

    case "picker":
      return {
        url: data.picker[0].url,
        filename: data.filename ?? "video.mp4",
        type: "picker",
      };

    case "error":
      throw new Error(data.error?.code ?? "Cobalt failed");

    default:
      throw new Error("Unknown response from Cobalt");
  }
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

  // FIXED: Route YouTube & TikTok directly through Cobalt for metadata calculations 
  // to prevent throwing signature and DRM errors on raw terminal execution.
  if (isCobaltPlatform(url)) {
    console.log(url , 'tik tok or yt')
    try {
      const result = await getCobaltDownloadUrl(url, "720");
      console.log(result)

      return reply.code(200).send({
        success: true,
        message: "Fetch video info successful (via Cobalt)",
        data: {
          title: result.filename.replace(/\.[^/.]+$/, ""), // Strip extension for title
          thumbnail: null, // Cobalt stream targets don't return standalone image attachments directly
          duration: 0,
          ext: result.filename.split('.').pop() ?? "mp4"
        },
      });
    } catch (error: any) {
      req.log.error({ err: error, url }, "Cobalt info routing failed");
      return reply.code(500).send({ success: false, message: error.message ?? "Cobalt metadata lookup failed" });
    }
  }

  // Generic fallback processing engine
  try {
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

    if (!title) {
      return reply.code(404).send({ success: false, message: "Video not found" });
    }

    return reply.code(200).send({
      success: true,
      message: "Fetch video info successful",
      data: { title, thumbnail, duration, ext },
    });

  } catch (error: any) {
    const stderr = error?.stderr ?? error?.message ?? "";
    req.log.error({ err: error, stderr, url }, "getVideoInfo failed");
    return reply.code(500).send({
      success: false,
      message: "Failed to fetch video info",
      ...(process.env.NODE_ENV === "development" && { error: error?.message }),
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

  // ── YouTube & TikTok → Cobalt ─────────────────────────────────────────────
  if (isCobaltPlatform(url)) {
    console.log(isCobaltPlatform(url))
    try {
      const result = await getCobaltDownloadUrl(url, quality);
      return reply.code(200).send({
        success: true,
        source: "cobalt",
        platform: isYouTubeUrl(url) ? "youtube" : "tiktok",
        data: {
          videoUrl: result.url,
          filename: result.filename,
          type: result.type,
        },
      });
    } catch (error: any) {
      req.log.error({ err: error, url }, "Cobalt failed");
      return reply.code(500).send({
        success: false,
        message: error.message ?? "Cobalt failed",
        ...(process.env.NODE_ENV === "development" && { error: error?.message }),
      });
    }
  }

  // ── Other Platforms → yt-dlp ──────────────────────────────────────────────
  try {
    // FIXED: Proxy values are now handled explicitly inside buildYtDlpArgs implementation securely
    const args = buildYtDlpArgs(url, ["-f", "best", "--get-url"]);

    const { stdout } = await execFilePromise("yt-dlp", args, {
      timeout: TIMEOUTS.url,
      maxBuffer: 1024 * 256,
    });

    const [videoUrl, audioUrl] = stdout.trim().split("\n").filter(Boolean);

    if (!videoUrl) {
      return reply.code(500).send({ success: false, message: "No download URL found" });
    }

    return reply.code(200).send({
      success: true,
      source: "ytdlp",
      platform: "other",
      data: {
        videoUrl,
        audioUrl: audioUrl ?? null,
      },
    });

  } catch (error: any) {
    req.log.error({ err: error, url }, "yt-dlp failed");
    const stderr = error?.stderr ?? error?.message ?? "";
    return reply.code(500).send({
      success: false,
      message: classifyError(stderr),
      ...(process.env.NODE_ENV === "development" && { error: error?.message }),
    });
  }
};

export const downloadController = {
  getVideoInfo,
  getDownloadLink,
};