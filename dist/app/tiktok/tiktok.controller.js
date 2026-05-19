import { spawn } from "node:child_process";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { isUrlSafe } from "../../utils/download.utils.js";
import { TIMEOUTS, FORMATS, getCookieFile, } from "../../constant/index.contant.js";
import { getProxyArgs } from "../../utils/proxy.utils.js";
const execFilePromise = promisify(execFile);
/** Strict TikTok URL validation — rejects anything that isn't a known TikTok hostname. */
function isValidTikTokUrl(url) {
    try {
        const { protocol, hostname } = new URL(url);
        return (protocol === "https:" &&
            (hostname === "tiktok.com" ||
                hostname.endsWith(".tiktok.com") ||
                hostname === "vm.tiktok.com"));
    }
    catch {
        return false;
    }
}
function buildTikTokArgs(url, extra) {
    const cookieFile = getCookieFile(url);
    const args = [
        "--no-check-certificate",
        "--no-playlist",
        "--socket-timeout",
        String(TIMEOUTS.socket),
        // Switch from manual spoofing to built-in browser impersonation
        "--impersonate",
        "chrome:android",
        "-f",
        FORMATS.best,
        ...getProxyArgs(),
        ...extra,
        url,
    ];
    if (cookieFile)
        args.push("--cookies", cookieFile);
    return args;
}
/** Maps common yt-dlp stderr patterns to a user-friendly message. */
function classifyStderr(stderr) {
    if (stderr.includes("429") || stderr.includes("rate limit")) {
        return "TikTok rate limit hit — try again later";
    }
    if (stderr.includes("private") || stderr.includes("unavailable")) {
        return "Video is unavailable or private";
    }
    return "Failed to process TikTok URL";
}
// ── 1. Get TikTok direct download URL (no watermark) ─────────────────────────
export const getTikTokDownloadUrl = async (req, reply) => {
    const { url } = req.body;
    if (!url || typeof url !== "string") {
        return reply.code(400).send({ success: false, message: "URL is required" });
    }
    if (!isValidTikTokUrl(url) || !isUrlSafe(url)) {
        return reply
            .code(400)
            .send({ success: false, message: "Invalid TikTok URL" });
    }
    try {
        const args = buildTikTokArgs(url, ["--get-url"]);
        const { stdout } = await execFilePromise("yt-dlp", args, {
            timeout: TIMEOUTS.url,
            maxBuffer: 1024 * 256,
        });
        const [videoUrl, audioUrl] = stdout.trim().split("\n").filter(Boolean);
        if (!videoUrl) {
            return reply
                .code(500)
                .send({ success: false, message: "No download URL found" });
        }
        return reply.code(200).send({
            success: true,
            data: {
                videoUrl,
                audioUrl: audioUrl ?? null,
            },
        });
    }
    catch (error) {
        req.log.error({ err: error, url }, "getTikTokDownloadUrl failed");
        const stderr = error?.stderr ?? error?.message ?? "";
        return reply
            .code(500)
            .send({ success: false, message: classifyStderr(stderr) });
    }
};
// ── 2. Stream TikTok video directly to the client ────────────────────────────
export const streamTikTok = async (req, reply) => {
    const { url } = req.query;
    const cleanUrl = decodeURIComponent(url ?? "").trim();
    if (!cleanUrl || !isValidTikTokUrl(cleanUrl) || !isUrlSafe(cleanUrl)) {
        return reply
            .code(400)
            .send({ success: false, message: "Invalid TikTok URL" });
    }
    // ✅ "-o -" tells yt-dlp to write to stdout so we can pipe it to the response
    const args = buildTikTokArgs(cleanUrl, ["-o", "-"]);
    const child = spawn("yt-dlp", args);
    let headersSent = false;
    let errorOutput = "";
    child.stdout.on("data", (chunk) => {
        if (!headersSent) {
            reply.raw.writeHead(200, {
                "Content-Type": "video/mp4",
                "Content-Disposition": 'attachment; filename="tiktok.mp4"',
                "Transfer-Encoding": "chunked",
                "Cache-Control": "no-cache",
            });
            headersSent = true;
        }
        reply.raw.write(chunk);
    });
    child.stderr.on("data", (data) => {
        errorOutput += data.toString();
    });
    child.on("close", (code) => {
        console.log("[yt-dlp] exit code:", code);
        console.log("[yt-dlp] stderr:", errorOutput);
        console.log("[yt-dlp] headersSent:", headersSent);
        if (!headersSent) {
            // yt-dlp exited without writing a single byte
            req.log.error({ code, stderr: errorOutput, url: cleanUrl }, "streamTikTok — no data written");
            if (!reply.sent) {
                reply.code(500).send({
                    success: false,
                    message: classifyStderr(errorOutput) || "yt-dlp produced no output",
                });
            }
            return;
        }
        reply.raw.end();
    });
    // ✅ Handle spawn failures (e.g. yt-dlp not installed)
    child.on("error", (err) => {
        req.log.error({ err }, "Failed to spawn yt-dlp");
        if (!headersSent && !reply.sent) {
            reply
                .code(500)
                .send({ success: false, message: "Internal server error" });
        }
    });
    // ✅ Kill yt-dlp immediately when the client disconnects — saves CPU + bandwidth
    req.raw.on("close", () => {
        if (!child.killed) {
            child.kill("SIGTERM");
            req.log.info({ url: cleanUrl }, "Client disconnected — yt-dlp killed");
        }
    });
};
export const tikTokController = {
    getTikTokDownloadUrl,
    streamTikTok,
};
//# sourceMappingURL=tiktok.controller.js.map