/**
 * base.adapter.ts
 * Abstract base that every platform adapter extends.
 * Each adapter owns: extractor args, cookie strategy, proxy strategy, retry rules.
 */
// import { CookiePlatform } from "../utils/cookie.manager.js";
// import type { Identity }       from "../utils/identity.manager.js";
import { CookiePlatform } from "../cookies/Cookie.manager.js";
import { identityManager, Identity } from "../manager/Identity.manager.js";
identityManager
import type { Proxy } from "../Proxy/Proxy.pool.js";



export interface AttemptContext {
  attemptIndex: number;
  proxy: Proxy | null;
  cookiePath: string | null;
  identity: Identity;
  signal?: AbortSignal;
}

export interface AdapterResult {
  videoUrl:  string;
  audioUrl:  string | null;
  title:     string;
  thumbnail: string | null;
  duration:  number;
  ext:       string;
  source:    string;
}

export abstract class BaseAdapter {
  abstract readonly platform: string;
  abstract readonly cookiePlatform: CookiePlatform;

  /** Max attempts before giving up (excluding Playwright fallback) */
  maxAttempts = 4;

  /** yt-dlp format strategy cascade — override per platform */
  formatStrategies: string[] = [
    "bestvideo[ext=mp4][height<=1080]+bestaudio[ext=m4a]/bestvideo[ext=mp4]+bestaudio/best[ext=mp4]",
    "bestvideo[height<=1080]+bestaudio/bestvideo+bestaudio/best",
    "best[ext=mp4]/best[ext=webm]/best",
    "bestvideo+bestaudio/best",
  ];

  /** Extra yt-dlp args specific to this platform */
  abstract ytdlpPlatformArgs(ctx: AttemptContext): string[];

  /** Extra gallery-dl args specific to this platform */
  galleryDlPlatformArgs(_ctx: AttemptContext): string[] { return []; }

  /** Whether Cobalt should be tried first for this platform */
  useCobalt = true;

  /** Whether gallery-dl should be tried as tier-3 fallback */
  useGalleryDl = true;
}