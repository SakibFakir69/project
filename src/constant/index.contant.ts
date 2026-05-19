// ── Allowed platforms ─────────────────────────────────────────────────────────
export const ALLOWED_HOSTS = [
  "youtube.com",
  "youtu.be",
  "instagram.com",
  "facebook.com",
  "fb.watch",        // ✅ Facebook short links
  "tiktok.com",
  "vm.tiktok.com",   // ✅ TikTok short links
  "x.com",           // ✅ Twitter/X
  "twitter.com",
] as const;

export type AllowedHost = (typeof ALLOWED_HOSTS)[number];

// ── User agents ───────────────────────────────────────────────────────────────
// ✅ Rotate to avoid rate limiting — especially TikTok and YouTube

export const USER_AGENTS = [
  // Chrome Windows
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  // Chrome Android
  "Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36",
  // Safari iPhone
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1",
  // Firefox Android
  "Mozilla/5.0 (Android 14; Mobile; rv:120.0) Gecko/120.0 Firefox/120.0",
] as const;

// Keep single USER_AGENT for backward compatibility
export const USER_AGENT = USER_AGENTS[0];

// ✅ Get random UA — use this in controllers instead of USER_AGENT directly
export function getRandomUserAgent(): string {
  return USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
}

// ── Platform-specific referers ────────────────────────────────────────────────
// ✅ Some platforms check referer header — wrong referer = 403
export const REFERERS: Record<string, string> = {
  "tiktok.com":    "https://www.tiktok.com/",
  "vm.tiktok.com": "https://www.tiktok.com/",
  "youtube.com":   "https://www.youtube.com/",
  "youtu.be":      "https://www.youtube.com/",
  "instagram.com": "https://www.instagram.com/",
  "facebook.com":  "https://www.facebook.com/",
  "fb.watch":      "https://www.facebook.com/",
  "x.com":         "https://x.com/",
  "twitter.com":   "https://twitter.com/",
};

// ✅ Get correct referer for any URL
export function getReferer(url: string): string {
  try {
    const { hostname } = new URL(url);
    const match = Object.keys(REFERERS).find((host) => hostname.endsWith(host));
    return match ? REFERERS[match] : "";
  } catch {
    return "";
  }
}

// ── Cookies ───────────────────────────────────────────────────────────────────
export const COOKIES_DIR = process.env.COOKIES_DIR ?? "/tmp/cookies";


export const COOKIE_FILES: Partial<Record<string, string>> = {
  "youtube.com":   `${COOKIES_DIR}/youtube.txt`,
  "youtu.be":      `${COOKIES_DIR}/youtube.txt`,
  "instagram.com": `${COOKIES_DIR}/instagram.txt`,
  "facebook.com":  `${COOKIES_DIR}/facebook.txt`,
  "fb.watch":      `${COOKIES_DIR}/facebook.txt`,
  "tiktok.com":    `${COOKIES_DIR}/tiktok.txt`,
  "vm.tiktok.com": `${COOKIES_DIR}/tiktok.txt`,
};


export const TIMEOUTS = {
  info:     20_000,   // getVideoInfo — just metadata
  url:      20_000,   // getDownloadLink — just URL extraction
  stream:   90_000,   // streaming — full video
  socket:   15,       // yt-dlp --socket-timeout (seconds)
} as const;


export const FORMATS = {
  // Single stream — fast, good for short reels/TikTok
  best:        "best[ext=mp4]/best",
  // Separate video+audio — needed for YouTube 1080p+
  bestSplit:   "bestvideo+bestaudio/best",
  // Audio only
  audio:       "bestaudio[ext=m4a]/bestaudio",
} as const;


export function getCookieFile(url: string): string | null {
  try {
    const { hostname } = new URL(url);
    const match = Object.keys(COOKIE_FILES).find((host) =>
      hostname.endsWith(host)
    );
    return (match && COOKIE_FILES[match]) ?? null;
  } catch {
    return null;
  }
}