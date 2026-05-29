import { COOKIES_DIR } from "../constant/index.contant.js";
import { join } from "node:path";
import { existsSync, mkdirSync } from "node:fs";
// ── Allowed input hosts (platforms users submit) ──────────────────────────────
const ALLOWED_INPUT_HOSTS = [
    // YouTube
    "youtube.com",
    "www.youtube.com",
    "youtu.be",
    "m.youtube.com",
    // TikTok
    "tiktok.com",
    "www.tiktok.com",
    "vm.tiktok.com",
    "vt.tiktok.com",
    // Instagram
    "instagram.com",
    "www.instagram.com",
    // Facebook
    "facebook.com",
    "www.facebook.com",
    "fb.watch",
    // Twitter / X
    "twitter.com",
    "www.twitter.com",
    "x.com",
    "www.x.com",
    // Reddit
    "reddit.com",
    "www.reddit.com",
    "old.reddit.com",
    "redd.it",
    // Pinterest
    "pinterest.com",
    "www.pinterest.com",
    "pin.it",
    // Tumblr
    "tumblr.com",
    "www.tumblr.com",
    // Vimeo
    "vimeo.com",
    "www.vimeo.com",
    // Twitch
    "twitch.tv",
    "www.twitch.tv",
    "clips.twitch.tv",
    "m.twitch.tv",
    // Dailymotion
    "dailymotion.com",
    "www.dailymotion.com",
    "dai.ly",
    // Streamable
    "streamable.com",
    "www.streamable.com",
    // Bilibili
    "bilibili.com",
    "www.bilibili.com",
    "b23.tv",
    // SoundCloud
    "soundcloud.com",
    "www.soundcloud.com",
    "on.soundcloud.com",
    // Rumble
    "rumble.com",
    "www.rumble.com",
    // Odysee / LBRY
    "odysee.com",
    "www.odysee.com",
    // Likee
    "likee.video",
    "www.likee.video",
    // Snapchat
    "snapchat.com",
    "www.snapchat.com",
    "t.snapchat.com",
];
// ── Allowed CDN hosts (where actual media files are served from) ──────────────
const ALLOWED_CDN_HOSTS = [
    // YouTube CDN
    "googlevideo.com",
    "youtube.com",
    // TikTok CDN
    "tiktokcdn.com",
    "tiktokv.com",
    "tiktok.com",
    "musical.ly",
    "v19-webapp-prime.tiktok.com",
    "v19-webapp.tiktok.com",
    "v26-webapp.tiktok.com",
    // Instagram / Facebook CDN
    "cdninstagram.com",
    "fbcdn.net",
    "facebook.com",
    // Twitter CDN
    "twimg.com",
    "video.twimg.com",
    "pbs.twimg.com",
    "ton.twitter.com",
    // Reddit CDN
    "v.redd.it",
    "preview.redd.it",
    "i.redd.it",
    "reddit.com",
    "redd.it",
    // Vimeo CDN
    "vimeocdn.com",
    "vimeo.com",
    "player.vimeo.com",
    // Twitch CDN
    "clips-media-assets2.twitch.tv",
    "video.twitch.tv",
    "vod-secure.twitch.tv",
    "vod-metro.twitch.tv",
    // Dailymotion CDN
    "dmcdn.net",
    "dailymotion.com",
    // Streamable CDN
    "streamable.com",
    "cdn-cf-east.streamable.com",
    // Bilibili CDN
    "bilivideo.com",
    "bilivideo.cn",
    "upos-sz-mirrorali.bilivideo.com",
    // Cobalt tunnel (our own server)
    "downtubebest.duckdns.org",
];
// ── Helpers ───────────────────────────────────────────────────────────────────
export function ensureDir(dir) {
    if (!existsSync(dir))
        mkdirSync(dir, { recursive: true });
}
export function buildFormatSelector(type, quality, url) {
    if (type === "audio") {
        return `-f bestaudio/best`;
    }
    // Single-stream platforms — no merging needed
    const isSingleStreamPlatform = [
        "instagram.com",
        "tiktok.com",
        "vt.tiktok.com",
        "facebook.com",
        "fb.watch",
        "v.redd.it",
    ].some((domain) => url.includes(domain));
    if (isSingleStreamPlatform) {
        return `-f best`;
    }
    if (!quality || quality === "best") {
        return `-f "bv*+ba/b"`;
    }
    return `-f "bestvideo[height<=${quality}][vcodec^=avc1]+bestaudio[acodec^=mp4a]/bestvideo[height<=${quality}]+bestaudio/best[height<=${quality}]"`;
}
// ── URL Safety Check ──────────────────────────────────────────────────────────
export const isUrlSafe = (url) => {
    try {
        const decodedUrl = decodeURIComponent(url);
        const parsed = new URL(url);
        // Protocol must be http or https
        if (!["http:", "https:"].includes(parsed.protocol))
            return false;
        // Block shell injection characters
        if (/[$`<>\\]/.test(decodedUrl))
            return false;
        // Must have a hostname
        if (!parsed.hostname)
            return false;
        const allAllowed = [...ALLOWED_INPUT_HOSTS, ...ALLOWED_CDN_HOSTS];
        // Hostname must match or be a subdomain of an allowed host
        const isAllowed = allAllowed.some((host) => parsed.hostname === host ||
            parsed.hostname.endsWith("." + host));
        return isAllowed;
    }
    catch {
        return false;
    }
};
// ── Cookie Helper ─────────────────────────────────────────────────────────────
export const getCookieFlag = (url) => {
    const map = {
        "instagram.com": "instagram.txt",
        "tiktok.com": "tiktok.txt",
        "facebook.com": "facebook.txt",
        "twitter.com": "twitter.txt",
        "x.com": "twitter.txt",
        "youtube.com": "youtube.txt",
    };
    for (const [domain, file] of Object.entries(map)) {
        if (url.includes(domain)) {
            const full = join(COOKIES_DIR, file);
            console.log(`[cookies] checking path: ${full}`);
            console.log(`[cookies] exists: ${existsSync(full)}`);
            return existsSync(full) ? `--cookies "${full}"` : "";
        }
    }
    return "";
};
//# sourceMappingURL=download.utils.js.map