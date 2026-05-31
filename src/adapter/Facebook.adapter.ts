import { BaseAdapter, type AttemptContext } from "./Base.adapter.js";

export class FacebookAdapter extends BaseAdapter {
  readonly platform       = "facebook";
  readonly cookiePlatform = "facebook" as const;
  maxAttempts             = 4;
  useCobalt               = true;
  useGalleryDl            = false;

  formatStrategies = [
    "best[ext=mp4][height<=1080]/best[ext=mp4]",
    "bestvideo[ext=mp4]+bestaudio/best[ext=mp4]",
    "bestvideo+bestaudio/best",
    "best",
  ];

  ytdlpPlatformArgs(ctx: AttemptContext): string[] {
    const impersonateTargets = ["chrome", "chrome-116", "chrome-120", "edge"];
    const impersonate = impersonateTargets[ctx.attemptIndex % impersonateTargets.length];

    return [
      "--impersonate",    impersonate,
      "--add-header",     "Referer:https://www.facebook.com/",
      "--add-header",     "Accept-Encoding:identity",
      "--socket-timeout", "45",
    ];
  }
}