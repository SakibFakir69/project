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
): Promise<{ url: string; filename: string; type: string }> {
  console.log("[Cobalt] Attempting download for:", url);

  const cleanQuality = quality.toString().toLowerCase().replace("p", "");

  const response = await fetch(`${process.env.COBALT_URL}/`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Accept": "application/json",
    },
    body: JSON.stringify({
      url,
      videoQuality: cleanQuality,
      filenameStyle: "classic",
    }),
  });

  if (!response.ok) {
    const errorBody = await response.text().catch(() => "No error body");
    console.error("[Cobalt] Rejected payload:", errorBody);
    throw new Error(`Cobalt error: ${response.status}`);
  }

  const data = (await response.json()) as any;

  switch (data.status) {
    case "tunnel":
    case "redirect":
      return { url: data.url, filename: data.filename ?? "video.mp4", type: data.status };

    case "picker":
      return { url: data.picker[0].url, filename: data.filename ?? "video.mp4", type: "picker" };

    case "error":
      throw new Error(data.error?.code ?? "Cobalt failed");

    default:
      throw new Error("Unknown response from Cobalt");
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
  const args = buildYtDlpArgs(url, ["-f", "best", "--get-url"]);

  const { stdout } = await execFilePromise("yt-dlp", args, {
    timeout: TIMEOUTS.url,
    maxBuffer: 1024 * 256,
  });

  const [videoUrl, audioUrl] = stdout.trim().split("\n").filter(Boolean);

  if (!videoUrl) throw new Error("No download URL found via yt-dlp");

  return { videoUrl, audioUrl: audioUrl ?? null };
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

  // ── Try Cobalt First ────────────────────────────────────────────────────────
  try {
    const result = await getCobaltDownloadUrl(url, "720");
    console.log("[Cobalt] Info success for:", url);

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
    const { title, thumbnail, duration, ext } = await getYtDlpInfo(url);

    return reply.code(200).send({
      success: true,
      source: "ytdlp",
      message: "Fetch video info successful (via yt-dlp)",
      data: { title, thumbnail, duration, ext },
    });
  } catch (ytdlpError: any) {
    req.log.error({ err: ytdlpError, url }, "Both Cobalt and yt-dlp failed for info");
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

  // ── Try Cobalt First ────────────────────────────────────────────────────────
  try {
    const result = await getCobaltDownloadUrl(url, String(quality));
    console.log("[Cobalt] Download success for:", url);

    return reply.code(200).send({
      success: true,
      source: "cobalt",
      data: {
        videoUrl: result.url,
        filename: result.filename,
        type: result.type,
      },
    });
  } catch (cobaltError: any) {
    console.warn("[Cobalt] Download failed, falling back to yt-dlp:", cobaltError.message);
  }

  // ── Fallback: yt-dlp ────────────────────────────────────────────────────────
  try {
    const { videoUrl, audioUrl } = await getYtDlpDownloadUrl(url);

    return reply.code(200).send({
      success: true,
      source: "ytdlp",
      data: {
        videoUrl,
        audioUrl,
      },
    });
  } catch (ytdlpError: any) {
    req.log.error({ err: ytdlpError, url }, "Both Cobalt and yt-dlp failed for download");
    const stderr = ytdlpError?.stderr ?? ytdlpError?.message ?? "";
    return reply.code(500).send({
      success: false,
      message: classifyError(stderr),
      ...(process.env.NODE_ENV === "development" && { error: ytdlpError?.message }),
    });
  }
};

export const downloadController = {
  getVideoInfo,
  getDownloadLink,
};