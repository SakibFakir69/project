import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { isUrlSafe, } from "../../utils/download.utils.js";
import { getRandomUserAgent, getReferer, getCookieFile, TIMEOUTS, } from "../../constant/index.contant.js";
import { getProxyArgs } from "../../utils/proxy.utils.js";
const execFilePromise = promisify(execFile);
// ── Helpers ───────────────────────────────────────────────────────────────────
/** Matches youtube.com and youtu.be — used to branch between API and yt-dlp. */
function isYouTubeUrl(url) {
    try {
        const { hostname } = new URL(url);
        return hostname.endsWith("youtube.com") || hostname === "youtu.be";
    }
    catch {
        return false;
    }
}
/** Extracts the 11-char YouTube video ID from any YouTube URL variant. */
function extractYouTubeId(url) {
    return (url.match(/(?:youtube\.com\/(?:shorts\/|watch\?v=)|youtu\.be\/)([a-zA-Z0-9_-]{11})/)?.[1] ?? null);
}
/** Converts an ISO 8601 duration (PT1H2M3S) to total seconds. */
function parseIsoDuration(iso) {
    const m = iso.match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/);
    return (parseInt(m?.[1] ?? "0") * 3600 +
        parseInt(m?.[2] ?? "0") * 60 +
        parseInt(m?.[3] ?? "0"));
}
/**
 * Classifies common yt-dlp stderr messages into user-facing error strings.
 * Returns a generic fallback for unknown errors.
 */
function classifyError(stderr) {
    if (stderr.includes("429") || stderr.includes("rate limit"))
        return "Rate limit hit — try again later";
    if (stderr.includes("private") || stderr.includes("unavailable"))
        return "Video is private or unavailable";
    if (stderr.includes("geo"))
        return "Video is not available in this region";
    return "Failed to process video URL";
}
/**
 * Shared yt-dlp args builder — no shell interpolation, safe for execFile/spawn.
 * `extra` is appended before the URL (e.g. ["--get-url"] or ["-o", "-"]).
 */
function buildYtDlpArgs(url, extra) {
    const referer = getReferer(url);
    const cookie = isYouTubeUrl(url) ? null : getCookieFile(url); // skip for YT
    const ua = getRandomUserAgent();
    const args = [
        "--no-check-certificate",
        "--no-playlist",
        "--socket-timeout", String(TIMEOUTS.socket),
        "--user-agent", ua,
        ...(referer ? ["--add-header", `Referer: ${referer}`] : []),
        ...extra,
        url,
    ];
    if (cookie)
        args.push("--cookies", cookie);
    return args;
}
// ── 1. Get video info ─────────────────────────────────────────────────────────
export const getVideoInfo = async (req, reply) => {
    const { url } = req.body;
    if (!url || typeof url !== "string") {
        return reply.code(400).send({ success: false, message: "URL is required" });
    }
    if (!isUrlSafe(url)) {
        return reply.code(400).send({ success: false, message: "Invalid or unsupported URL" });
    }
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
            try {
                return JSON.parse(line);
            }
            catch {
                return null;
            }
        });
        if (!title) {
            return reply.code(404).send({ success: false, message: "Video not found" });
        }
        return reply.code(200).send({
            success: true,
            message: "Fetch video info successful",
            data: { title, thumbnail, duration, ext },
        });
    }
    catch (error) {
        const stderr = error?.stderr ?? error?.message ?? "";
        req.log.error({ err: error, stderr, url }, "getVideoInfo failed");
        return reply.code(500).send({
            success: false,
            message: "Failed to fetch video info",
            ...(process.env.NODE_ENV === "development" && { error: error?.message }),
        });
    }
};
// ── 2. Get download link ──────────────────────────────────────────────────────
export const getDownloadLink = async (req, reply) => {
    const { url } = req.body;
    if (!url || typeof url !== "string" || !isUrlSafe(url)) {
        return reply.code(400).send({ success: false, message: "Invalid or missing URL" });
    }
    try {
        const youtubeExtras = isYouTubeUrl(url)
            ? ["--extractor-args", "youtube:player_client=web", ...getProxyArgs()]
            : [];
        const args = buildYtDlpArgs(url, [
            ...youtubeExtras,
            "-f", "best",
            "--get-url",
        ]);
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
            data: { videoUrl, audioUrl: audioUrl ?? null },
        });
    }
    catch (error) {
        req.log.error({ err: error, url }, "getDownloadLink failed");
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
//# sourceMappingURL=downloader.controller.js.map