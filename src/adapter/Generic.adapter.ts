
import { BaseAdapter, type AttemptContext } from "./Base.adapter.js";


export class GenericAdapter extends BaseAdapter {
  readonly platform       = "generic";
  readonly cookiePlatform = "generic" as const;
  maxAttempts             = 3;
  useCobalt               = false;
  useGalleryDl            = true;

  ytdlpPlatformArgs(_ctx: AttemptContext): string[] {
    return [];
  }
}