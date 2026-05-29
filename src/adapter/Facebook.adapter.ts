// import { BaseAdapter, type AttemptContext } from "./base.adapter.js";

import { BaseAdapter, type AttemptContext } from "./ Base.adapter.js";




export class FacebookAdapter extends BaseAdapter {
  readonly platform       = "facebook";
  readonly cookiePlatform = "facebook" as const;
  maxAttempts             = 3;
  useCobalt               = true;
  useGalleryDl            = false;

  formatStrategies = [
    "best[ext=mp4]/best",
    "bestvideo+bestaudio/best",
    "best",
  ];

  ytdlpPlatformArgs(ctx: AttemptContext): string[] {
    const args = ["--no-check-certificate"];
    if (ctx.cookiePath) args.push("--cookies", ctx.cookiePath);
    return args;
  }
}