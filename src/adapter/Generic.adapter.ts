import { BaseAdapter, type AttemptContext } from "./Base.adapter.js";

export class GenericAdapter extends BaseAdapter {
  readonly platform       = "generic";
  readonly cookiePlatform = "generic" as const;
  maxAttempts             = 3;
  useCobalt               = false;
  useGalleryDl            = true;

  formatStrategies = [
    "bestvideo[ext=mp4]+bestaudio/best[ext=mp4]",
    "bestvideo+bestaudio/best",
    "best[ext=mp4]/best",
  ];

  ytdlpPlatformArgs(ctx: AttemptContext): string[] {
    const impersonateTargets = ["chrome", "chrome-116", "safari"];
    const impersonate = impersonateTargets[ctx.attemptIndex % impersonateTargets.length];

    return [
      "--impersonate", impersonate,
      "--add-header",  "Accept-Encoding:identity",
    ];
  }
}