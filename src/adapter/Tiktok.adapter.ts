import { BaseAdapter, type AttemptContext } from "./Base.adapter.js";

export class TikTokAdapter extends BaseAdapter {
  readonly platform       = "tiktok";
  readonly cookiePlatform = "tiktok" as const;
  maxAttempts             = 4;
  useCobalt               = true;
  useGalleryDl            = true;

  formatStrategies = [
    "bestvideo[ext=mp4]+bestaudio/best[ext=mp4]",
    "best[ext=mp4]/best",
    "bestvideo+bestaudio/best",
    "best",
  ];

  ytdlpPlatformArgs(ctx: AttemptContext): string[] {
    const apiHosts = [
      "api16-normal-c-useast1a.tiktokv.com",
      "api19-normal-c-useast1a.tiktokv.com",
      "api22-normal-c-useast1a.tiktokv.com",
    ];
    const host = apiHosts[ctx.attemptIndex % apiHosts.length];

    const impersonateTargets = ["chrome", "chrome-116", "chrome-120", "safari"];
    const impersonate = impersonateTargets[ctx.attemptIndex % impersonateTargets.length];

    return [
      "--impersonate",    impersonate,
      "--extractor-args", `tiktok:api_hostname=${host}`,
      "--add-header",     "Accept-Encoding:identity",
      "--add-header",     "Referer:https://www.tiktok.com/",
    ];
  }

  galleryDlPlatformArgs(_ctx: AttemptContext): string[] {
    return ["--config-ignore"];
  }
}