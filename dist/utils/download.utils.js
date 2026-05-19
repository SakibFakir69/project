import { join } from "node:path";
import { existsSync, mkdirSync } from "node:fs";
import { COOKIES_DIR } from "../constant/index.contant.js";
const ALLOWED_INPUT_HOSTS = [
    "youtube.com",
    "www.youtube.com",
    "youtu.be",
    "m.youtube.com",
    "tiktok.com",
    "www.tiktok.com",
    "vm.tiktok.com",
    "vt.tiktok.com",
    "instagram.com",
    "www.instagram.com",
    "facebook.com",
    "www.facebook.com",
    "fb.watch",
    "twitter.com",
    "x.com",
    "www.twitter.com",
];
const ALLOWED_CDN_HOSTS = [
    "googlevideo.com",
    "tiktokcdn.com",
    "tiktokv.com",
    "tiktok.com",
    "cdninstagram.com",
    "fbcdn.net",
    "twimg.com",
    "video.twimg.com",
    "v19-webapp-prime.tiktok.com",
];
export function ensureDir(dir) {
    if (!existsSync(dir))
        mkdirSync(dir, { recursive: true });
}
export function buildFormatSelector(type, quality, url) {
    if (type === "audio") {
        return `-f bestaudio/best`;
    }
    // Instagram, TikTok, Facebook — single stream only, no merging
    const isSingleStreamPlatform = [
        "instagram.com",
        "tiktok.com",
        "vt.tiktok.com",
        "facebook.com",
        "fb.watch",
    ].some((domain) => url.includes(domain));
    if (isSingleStreamPlatform) {
        // Just grab the best available — no format splitting
        return `-f best`;
    }
    if (!quality) {
        return `-f "bv*+ba/b"`;
    }
    return `-f "bestvideo[height<=${quality}][vcodec^=avc1]+bestaudio[acodec^=mp4a]/bestvideo[height<=${quality}]+bestaudio/best[height<=${quality}]"`;
}
// utils/download.utils.ts
export const isUrlSafe = (url) => {
    try {
        // 1. Decode the URL to ensure no malicious characters are hidden via percent-encoding
        const decodedUrl = decodeURIComponent(url);
        const parsed = new URL(url);
        // 2. Protocol check
        if (!["http:", "https:"].includes(parsed.protocol))
            return false;
        /**
         * 3. UPDATED REGEX:
         * Removed '&' and ';' because they are standard URL separators.
         * We kept backticks, dollar signs, and brackets which are
         * common in shell interpolation but rare/invalid in raw URLs.
         */
        if (/[$`<>\\]/.test(decodedUrl))
            return false;
        // 4. Hostname check
        if (!parsed.hostname)
            return false;
        const allAllowed = [...ALLOWED_INPUT_HOSTS, ...ALLOWED_CDN_HOSTS];
        // Check if the hostname matches or ends with any of our allowed domains
        const isAllowed = allAllowed.some((host) => parsed.hostname === host || parsed.hostname.endsWith("." + host));
        return isAllowed;
    }
    catch {
        return false;
    }
};
// const COOKIES_DIR = join(process.cwd(), "cookies");
export const getCookieFlag = (url) => {
    const map = {
        "instagram.com": "instagram.txt",
        "tiktok.com": "tiktok.txt",
        "facebook.com": "facebook.txt",
    };
    for (const [domain, file] of Object.entries(map)) {
        if (url.includes(domain)) {
            const full = join(COOKIES_DIR, file);
            console.log(`[cookies] checking path: ${full}`); // 👈
            console.log(`[cookies] exists: ${existsSync(full)}`); // 👈
            return existsSync(full) ? `--cookies "${full}"` : "";
        }
    }
    return "";
};
//# sourceMappingURL=download.utils.js.map