import { BaseAdapter, type AttemptContext } from "./Base.adapter.js";

// ✅ 1. MUST extend BaseAdapter just like TikTokAdapter does!
export class TwitterAdapter extends BaseAdapter {
  // ✅ 2. Use readonly and "as const" just like TikTokAdapter
  readonly platform       = "twitter";
  readonly cookiePlatform = "twitter" as const;

  // Cobalt handles Twitter very well, so we try it first
  useCobalt = true;
  
  // gallery-dl is useless for Twitter videos
  useGalleryDl = false;
  
  // 3 attempts: 1 without proxy, 2 with rotating proxies/cookies
  maxAttempts = 3;

  // ✅ CRITICAL FIX: These format strategies explicitly request MP4 containers.
  // This prevents yt-dlp from returning .m3u8 HLS playlists which React Native cannot download.
  formatStrategies = [
    "bestvideo[ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/best",
    "bestvideo[vcodec^=avc1]+bestaudio[acodec^=mp4a]/best[vcodec^=avc1]/best",
    "bv*[ext=mp4]+ba[ext=m4a]/b[ext=mp4]/b"
  ];

  /**
   * Custom yt-dlp arguments for Twitter/X
   */
  ytdlpPlatformArgs(ctx: AttemptContext): string[] {
    return [
      "--extractor", "twitter",
      "--no-playlist", 
    ];
  }

  /**
   * gallery-dl args (Unused for Twitter)
   */
  galleryDlPlatformArgs(ctx: AttemptContext): string[] {
    return [];
  }
}