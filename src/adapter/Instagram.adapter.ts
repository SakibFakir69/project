import { BaseAdapter, type AttemptContext } from "./Base.adapter.js";

export class InstagramAdapter extends BaseAdapter {
  readonly platform       = "instagram";
  readonly cookiePlatform = "instagram" as const;
  maxAttempts             = 4;
  useCobalt               = true;
  useGalleryDl            = true;

  formatStrategies = [
    "best[ext=mp4][height<=1080]/best[ext=mp4]",
    "bestvideo[ext=mp4]+bestaudio/best[ext=mp4]",
    "bestvideo+bestaudio/best",
    "best",
  ];

  ytdlpPlatformArgs(ctx: AttemptContext): string[] {
    const impersonateTargets = ["chrome", "chrome-120", "safari", "chrome-116"];
    const impersonate = impersonateTargets[ctx.attemptIndex % impersonateTargets.length];

    return [
      "--impersonate",    impersonate,
      "--add-header",     "Referer:https://www.instagram.com/",
      "--add-header",     "Accept-Encoding:identity",
      "--socket-timeout", "45",
    ];
  }

  galleryDlPlatformArgs(_ctx: AttemptContext): string[] {
    return ["--config-ignore"];
  }
}