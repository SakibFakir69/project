
import { BaseAdapter, type AttemptContext } from "./Base.adapter.js";



export class InstagramAdapter extends BaseAdapter {
  readonly platform       = "instagram";
  readonly cookiePlatform = "instagram" as const;
  maxAttempts             = 4;
  useCobalt               = true;
  useGalleryDl            = true;

  formatStrategies = [
    "best[ext=mp4]/best",
    "bestvideo+bestaudio/best",
    "best",
    "worst",
  ];

  ytdlpPlatformArgs(ctx: AttemptContext): string[] {
    const args = ["--socket-timeout", "45"];
    // Instagram needs cookies on every attempt
    if (ctx.cookiePath) {
      args.push("--cookies", ctx.cookiePath);
    }
    return args;
  }

  galleryDlPlatformArgs(_ctx: AttemptContext): string[] {
    return ["--config-ignore"];
  }
}