
import { BaseAdapter, type AttemptContext } from "./ Base.adapter.js";


export class YouTubeAdapter extends BaseAdapter {
  readonly platform       = "youtube";
  readonly cookiePlatform = "youtube" as const;
  maxAttempts             = 5;
  useCobalt               = true;
  useGalleryDl            = false;

  formatStrategies = [
    "bestvideo[ext=mp4][height<=1080]+bestaudio[ext=m4a]/bestvideo[ext=mp4]+bestaudio/best[ext=mp4]",
    "bestvideo[height<=720]+bestaudio/best[height<=720]",
    "best[ext=mp4]/best[ext=webm]/best",
    "bestvideo+bestaudio/best",
  ];

  ytdlpPlatformArgs(ctx: AttemptContext): string[] {
    const clients = [
      "web_creator,web,android",
      "android,web",
      "ios,web",
      "mweb,web",
      "android_vr,android",
    ];
    const client = clients[ctx.attemptIndex % clients.length];
    return [
      "--extractor-args", `youtube:player_client=${client}`,
      "--extractor-args", "youtube:skip=dash",
    ];
  }
}