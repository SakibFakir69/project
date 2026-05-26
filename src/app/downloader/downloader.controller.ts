
import { execFile } from "node:child_process";
import { promisify }  from "node:util";
import type { FastifyRequest, FastifyReply } from "fastify";

import { isUrlSafe }                              from "../../utils/download.utils.js";
import { getReferer, getCookieFile, TIMEOUTS }    from "../../constant/index.contant.js";
import { getProxyArgs }                           from "../../utils/proxy.utils.js";
import type { VideoQuality, DownloadType, AudioFormat } from "../../types/index.js";

// ── Config ────────────────────────────────────────────────────────────────────

const BASE_URL   = process.env.API_URL   ?? "https://downtubebest.duckdns.org/api/v1";
const COBALT_URL = process.env.COBALT_URL ?? "http://cobalt-api:9000";
const NODE_ENV   = process.env.NODE_ENV  ?? "production";
const IS_DEV     = NODE_ENV === "development";

if (!process.env.API_URL)   console.warn('[Config] API_URL not set, using default:', BASE_URL);
if (!process.env.COBALT_URL) console.warn('[Config] COBALT_URL not set, using default:', COBALT_URL);

const execFilePromise = promisify(execFile);

// Shared child-process options ─────────────────────────────────────────────────
const EXEC_OPTS = {
  killSignal: "SIGKILL" as const,
  maxBuffer:  8 * 1024 * 1024,   // 8 MB  (yt-dlp JSON can be large)
};

// ── Types ─────────────────────────────────────────────────────────────────────

interface VideoInfoBody { url: string; }
interface DownloadBody  {
  url:         string;
  type?:       DownloadType;
  quality?:    VideoQuality;
  audioFormat?: AudioFormat;
}

// ── Platform Detection ────────────────────────────────────────────────────────

type Platform =
  | "youtube" | "tiktok"  | "instagram" | "twitter"
  | "reddit"  | "facebook"| "pinterest" | "tumblr"
  | "vimeo"   | "twitch"  | "generic";

function detectPlatform(url: string): Platform {
  if (/youtube\.com|youtu\.be/i.test(url))                     return "youtube";
  if (/tiktok\.com|vm\.tiktok|vt\.tiktok/i.test(url))         return "tiktok";
  if (/instagram\.com/i.test(url))                             return "instagram";
  if (/twitter\.com|x\.com/i.test(url))                       return "twitter";
  if (/reddit\.com|redd\.it/i.test(url))                      return "reddit";
  if (/facebook\.com|fb\.watch/i.test(url))                   return "facebook";
  if (/pinterest\.com|pin\.it/i.test(url))                    return "pinterest";
  if (/tumblr\.com/i.test(url))                               return "tumblr";
  if (/vimeo\.com/i.test(url))                                return "vimeo";
  if (/twitch\.tv|clips\.twitch\.tv/i.test(url))             return "twitch";
  return "generic";
}

// ── Error Classifier ──────────────────────────────────────────────────────────

export interface ClassifiedError {
  message:    string;
  retryable:  boolean;
  statusCode: number;
  category:   string;
}

function classifyError(raw: string): ClassifiedError {
  const s = (raw ?? "").toLowerCase();

  // ── Rate limiting
  if (s.includes("429") || s.includes("rate limit") || s.includes("too many requests") ||
      s.includes("ratelimit") || s.includes("slow down"))
    return { message: "Rate limit hit — try again in a few minutes", retryable: true,  statusCode: 429, category: "rate_limit" };

  // ── Auth / private
  if (s.includes("private") || s.includes("members only") || s.includes("login required") ||
      s.includes("sign in") || s.includes("authenticate") || s.includes("age-restricted") ||
      s.includes("age restricted") || s.includes("confirm your age"))
    return { message: "Video is private or requires login", retryable: false, statusCode: 403, category: "auth" };

  // ── Gone / unavailable
  if (s.includes("unavailable") || s.includes("has been removed") || s.includes("no longer available") ||
      s.includes("video unavailable") || s.includes("deleted") || s.includes("not found") ||
      s.includes("does not exist") || s.includes("404"))
    return { message: "Video is unavailable or has been removed", retryable: false, statusCode: 404, category: "not_found" };

  // ── Geo-restriction
  if (s.includes("geo") || s.includes("not available in your country") ||
      s.includes("region") || s.includes("your location"))
    return { message: "Video is geo-restricted in this region", retryable: false, statusCode: 451, category: "geo" };

  // ── Copyright / blocked
  if (s.includes("copyright") || s.includes("blocked") || s.includes("content warning") ||
      s.includes("takedown") || s.includes("dmca"))
    return { message: "Video is blocked due to copyright", retryable: false, statusCode: 403, category: "copyright" };

  // ── Network / transient
  if (s.includes("network") || s.includes("connection") || s.includes("timeout") ||
      s.includes("timed out") || s.includes("eof") || s.includes("reset by peer") ||
      s.includes("broken pipe") || s.includes("temporarily") || s.includes("503") ||
      s.includes("502") || s.includes("504"))
    return { message: "Network error — retrying", retryable: true, statusCode: 503, category: "network" };

  // ── YouTube player / signature
  if (s.includes("nsig") || s.includes("player") || s.includes("cipher") ||
      s.includes("signature") || s.includes("sabotage") || s.includes("po token") ||
      s.includes("potoken") || s.includes("bot") || s.includes("automated"))
    return { message: "YouTube player error — yt-dlp may need updating", retryable: false, statusCode: 500, category: "player" };

  // ── Format / extraction failures (retryable with different format)
  if (s.includes("no video formats") || s.includes("requested format") ||
      s.includes("format is not available") || s.includes("unable to extract"))
    return { message: "No matching video format found", retryable: true, statusCode: 500, category: "format" };

  // ── Disk / resource
  if (s.includes("no space") || s.includes("disk full") || s.includes("out of memory"))
    return { message: "Server resource error", retryable: false, statusCode: 500, category: "resource" };

  return { message: "Failed to process video URL", retryable: false, statusCode: 500, category: "unknown" };
}

// ── Circuit Breaker ───────────────────────────────────────────────────────────
// Prevents hammering a failing service on every request.

interface CBState {
  failures:   number;
  openUntil:  number;   // epoch ms; 0 = closed
  halfOpen:   boolean;
}

const CB_THRESHOLD   = 5;           // consecutive failures to open
const CB_COOLDOWN_MS = 30_000;      // 30 s cool-down before half-open

const circuitBreakers: Record<string, CBState> = {
  cobalt:     { failures: 0, openUntil: 0, halfOpen: false },
  ytdlp:      { failures: 0, openUntil: 0, halfOpen: false },
  gallerydl:  { failures: 0, openUntil: 0, halfOpen: false },
};

function cbIsOpen(name: string): boolean {
  const cb = circuitBreakers[name];
  if (!cb) return false;
  if (cb.openUntil === 0) return false;
  if (Date.now() < cb.openUntil) return true;
  // Enter half-open: allow one probe
  cb.halfOpen = true;
  cb.openUntil = 0;
  return false;
}

function cbSuccess(name: string) {
  const cb = circuitBreakers[name];
  if (!cb) return;
  cb.failures  = 0;
  cb.openUntil = 0;
  cb.halfOpen  = false;
}

function cbFailure(name: string) {
  const cb = circuitBreakers[name];
  if (!cb) return;
  cb.failures++;
  if (cb.failures >= CB_THRESHOLD || cb.halfOpen) {
    cb.openUntil = Date.now() + CB_COOLDOWN_MS;
    cb.halfOpen  = false;
    console.warn(`[CB] Circuit OPEN for ${name} — cooldown ${CB_COOLDOWN_MS}ms`);
  }
}

// ── In-Flight Deduplication ───────────────────────────────────────────────────
// Same URL never runs two concurrent heavy extractions.

const inFlight = new Map<string, Promise<any>>();

function dedupe<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const existing = inFlight.get(key);
  if (existing) {
    console.log(`[Dedupe] Coalescing request for key: ${key.slice(0, 80)}`);
    return existing;
  }
  const p = fn().finally(() => inFlight.delete(key));
  inFlight.set(key, p);
  return p;
}

// ── Retry Helper ──────────────────────────────────────────────────────────────

async function withRetry<T>(
  fn:       () => Promise<T>,
  opts: { retries?: number; baseDelay?: number; label?: string } = {}
): Promise<T> {
  const { retries = 2, baseDelay = 800, label = "op" } = opts;
  let lastErr: any;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (err: any) {
      lastErr = err;
      const c = classifyError(err?.stderr ?? err?.message ?? "");
      if (!c.retryable || attempt === retries) break;
      const delay = baseDelay * 2 ** attempt;
      console.warn(`[${label}] attempt ${attempt + 1} failed, retry in ${delay}ms:`, err?.message?.slice(0, 120));
      await new Promise(r => setTimeout(r, delay));
    }
  }
  throw lastErr;
}

// ── Short URL Resolver ────────────────────────────────────────────────────────

async function resolveRedirectUrl(url: string): Promise<string> {
  try {
    const res = await fetch(url, {
      method:   "HEAD",
      redirect: "follow",
      signal:   AbortSignal.timeout(8_000),
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
      },
    });
    let resolved = res.url && res.url !== "" ? res.url : url;
    // Strip TikTok / Instagram tracking params
    if ((resolved.includes("tiktok.com") || resolved.includes("instagram.com")) && resolved.includes("?")) {
      resolved = resolved.split("?")[0];
    }
    if (resolved !== url) console.log(`[Resolver] ${url.slice(0, 80)} → ${resolved.slice(0, 80)}`);
    return resolved;
  } catch (err: any) {
    console.warn("[Resolver] Could not resolve, using original:", err?.message);
    return url;
  }
}

// ── yt-dlp Arg Builder ────────────────────────────────────────────────────────

function buildYtDlpArgs(url: string, extra: string[]): string[] {
  const platform  = detectPlatform(url);
  const referer   = getReferer(url);
  const cookie    = getCookieFile(url);
  const proxyArgs = getProxyArgs() ?? [];

  const platformArgs: string[] = [];

  switch (platform) {
    case "tiktok":
      platformArgs.push(
        "--extractor-args", "tiktok:api_hostname=api16-normal-c-useast1a.tiktokv.com",
        "--add-header",     "Accept-Encoding:identity",
      );
      break;
    case "instagram":
      platformArgs.push("--socket-timeout", "45");
      break;
    case "youtube":
      platformArgs.push(
        "--extractor-args", "youtube:player_client=web_creator,web,android",
        "--extractor-args", "youtube:skip=dash",
      );
      break;
    case "twitter":
      platformArgs.push("--add-header", "Accept-Language:en-US,en;q=0.9");
      break;
    case "reddit":
      platformArgs.push("--add-header", "Accept-Language:en-US,en;q=0.9");
      break;
    case "facebook":
      platformArgs.push("--no-check-certificate");
      break;
    default:
      break;
  }

  const args: string[] = [
    "--no-check-certificate",
    "--no-playlist",
    "--socket-timeout",    String(TIMEOUTS.socket ?? 30),
    "--retries",           "3",
    "--fragment-retries",  "3",
    "--file-access-retries", "3",
    "--extractor-retries", "3",
    "--impersonate",       "chrome",
    ...proxyArgs,
    ...(referer ? ["--add-header", `Referer:${referer}`] : []),
    ...platformArgs,
    ...extra,
    url,
  ];

  if (cookie) args.splice(args.indexOf(url), 0, "--cookies", cookie);
  return args;
}

// ── gallery-dl Arg Builder ────────────────────────────────────────────────────

function buildGalleryDlArgs(url: string, extra: string[]): string[] {
  const platform  = detectPlatform(url);
  const proxyArgs = getProxyArgs() ?? [];
  const cookie    = getCookieFile(url);

  // Map proxy args: yt-dlp uses --proxy; gallery-dl uses --proxy too
  const proxyStr = (() => {
    const idx = proxyArgs.indexOf("--proxy");
    return idx !== -1 ? proxyArgs[idx + 1] : null;
  })();

  const platformArgs: string[] = [];

  switch (platform) {
    case "instagram":
      platformArgs.push("--config-ignore");   // avoid polluting with user config
      break;
    case "twitter":
      platformArgs.push("--config-ignore");
      break;
    case "reddit":
      platformArgs.push("--config-ignore");
      break;
    default:
      break;
  }

  const args: string[] = [
    "--no-mtime",
    "--filename",    "{id}.{extension}",
    ...(proxyStr ? ["--proxy", proxyStr] : []),
    ...(cookie     ? ["--cookies", cookie] : []),
    ...platformArgs,
    ...extra,
    url,
  ];

  return args;
}

// ─────────────────────────────────────────────────────────────────────────────
// ── TIER 1: Cobalt ────────────────────────────────────────────────────────────
// ─────────────────────────────────────────────────────────────────────────────

interface CobaltResult {
  url:      string;
  audioUrl: string | null;
  filename: string;
  type:     string;
}

async function getCobaltDownloadUrl(resolvedUrl: string, quality = "720"): Promise<CobaltResult> {
  if (cbIsOpen("cobalt")) throw new Error("[CB] Cobalt circuit is open");

  const validQualities = ["144","240","360","480","720","1080","1440","2160"];
  const cleanQuality   = validQualities.includes(quality.replace("p","")) ? quality.replace("p","") : "720";

  console.log(`[Cobalt] → ${resolvedUrl.slice(0, 80)} @ ${cleanQuality}p`);

  const response = await fetch(`${COBALT_URL}/`, {
    method: "POST",
    signal: AbortSignal.timeout(15_000),
    headers: { "Content-Type": "application/json", "Accept": "application/json" },
    body: JSON.stringify({
      url:              resolvedUrl,
      videoQuality:     cleanQuality,
      filenameStyle:    "classic",
      downloadMode:     "auto",
      youtubeVideoCodec: "h264",
    }),
  });

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    cbFailure("cobalt");
    throw new Error(`Cobalt HTTP ${response.status}: ${body.slice(0, 200)}`);
  }

  const data = (await response.json()) as any;

  switch (data.status) {
    case "tunnel":
    case "redirect":
      cbSuccess("cobalt");
      return { url: data.url, audioUrl: null, filename: data.filename ?? "video.mp4", type: data.status };

    case "picker": {
      const videoItem = data.picker?.find((p: any) => p.type === "video") ?? data.picker?.[0];
      const audioItem = data.picker?.find((p: any) => p.type === "audio") ?? null;
      cbSuccess("cobalt");
      return {
        url:      videoItem?.url ?? data.picker[0].url,
        audioUrl: audioItem?.url ?? null,
        filename: data.filename ?? "video.mp4",
        type:     "picker",
      };
    }

    case "error":
      cbFailure("cobalt");
      throw new Error(`Cobalt error: ${data.error?.code ?? JSON.stringify(data.error)}`);

    default:
      cbFailure("cobalt");
      throw new Error(`Unknown Cobalt status: ${data.status}`);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// ── TIER 2: yt-dlp ────────────────────────────────────────────────────────────
// ─────────────────────────────────────────────────────────────────────────────

// Format strategies: ordered best → most compatible
const FORMAT_STRATEGIES = [
  "bestvideo[ext=mp4][height<=1080]+bestaudio[ext=m4a]/bestvideo[ext=mp4]+bestaudio/best[ext=mp4]",
  "bestvideo[height<=1080]+bestaudio/bestvideo+bestaudio/best",
  "best[ext=mp4]/best[ext=webm]/best",
  "bestvideo+bestaudio/best",   // absolute last resort
] as const;

interface YtDlpResult {
  videoUrl:     string;
  audioUrl:     string | null;
  title:        string;
  thumbnail:    string | null;
  duration:     number;
  ext:          string;
  strategyUsed: number;
}

/**
 * Use --dump-json (single JSON blob per video) instead of --get-url.
 * Much more reliable: gives us URLs + metadata in one shot, handles
 * multi-stream formats correctly, and avoids ordering ambiguity.
 */
async function getYtDlpDownloadData(url: string, strategyIndex = 0): Promise<YtDlpResult> {
  if (cbIsOpen("ytdlp")) throw new Error("[CB] yt-dlp circuit is open");

  const format = FORMAT_STRATEGIES[strategyIndex] ?? FORMAT_STRATEGIES[FORMAT_STRATEGIES.length - 1];
  console.log(`[yt-dlp] strategy ${strategyIndex}: ${format.slice(0, 70)}…`);

  const args = buildYtDlpArgs(url, [
    "-f", format,
    "--dump-json",
    "--no-simulate",    // needed alongside --dump-json in some yt-dlp versions
    "--skip-download",  // don't actually download, just extract info + URLs
  ]);

  const { stdout } = await execFilePromise("yt-dlp", args, {
    ...EXEC_OPTS,
    timeout: TIMEOUTS.url ?? 60_000,
  });

  // yt-dlp may emit one JSON object per entry; take the last non-empty line
  const lines   = stdout.trim().split("\n").filter(Boolean);
  const jsonLine = lines[lines.length - 1];

  let meta: any;
  try {
    meta = JSON.parse(jsonLine);
  } catch {
    throw new Error("yt-dlp returned non-JSON output");
  }

  // ── Extract video + audio URLs from the JSON ──────────────────────────────
  let videoUrl: string | null = null;
  let audioUrl: string | null = null;

  if (meta.requested_formats && meta.requested_formats.length >= 2) {
    // Separate video + audio streams
    const vf = meta.requested_formats.find((f: any) => f.vcodec && f.vcodec !== "none");
    const af = meta.requested_formats.find((f: any) => f.acodec && f.acodec !== "none" && (!f.vcodec || f.vcodec === "none"));
    videoUrl = vf?.url ?? meta.url ?? null;
    audioUrl = af?.url ?? null;
  } else {
    // Combined stream
    videoUrl = meta.url ?? null;
    audioUrl = null;
  }
  if (!videoUrl) throw new Error("yt-dlp: no video URL in JSON output");

  cbSuccess("ytdlp");
  return {
    videoUrl,
    audioUrl,
    title:        meta.title     ?? "video",
    thumbnail:    meta.thumbnail ?? null,
    duration:     meta.duration  ?? 0,
    ext:          meta.ext       ?? "mp4",
    strategyUsed: strategyIndex,
  };
}

async function getYtDlpInfo(url: string) {
  const args = buildYtDlpArgs(url, [
    "--dump-json",
    "--skip-download",
    "--no-playlist",
  ]);

  const { stdout } = await execFilePromise("yt-dlp", args, {
    ...EXEC_OPTS,
    timeout: TIMEOUTS.info ?? 60_000,
  });

  const lines  = stdout.trim().split("\n").filter(Boolean);
  let meta: any;
  try {
    meta = JSON.parse(lines[lines.length - 1]);
  } catch {
    throw new Error("yt-dlp info: non-JSON output");
  }

  if (!meta?.title) throw new Error("Video not found via yt-dlp");
  return {
    title:     meta.title,
    thumbnail: meta.thumbnail ?? null,
    duration:  meta.duration  ?? 0,
    ext:       meta.ext       ?? "mp4",
  };
}
/** Cascades through FORMAT_STRATEGIES before giving up */
async function getYtDlpWithFallback(url: string): Promise<YtDlpResult> {
  let lastErr: any;
  for (let i = 0; i < FORMAT_STRATEGIES.length; i++) {
    try {
      return await getYtDlpDownloadData(url, i);
    } catch (err: any) {
      lastErr = err;
      const c = classifyError(err?.stderr ?? err?.message ?? "");
      // Hard failures: no point trying another format
      if (!c.retryable && c.statusCode !== 500 && c.category !== "format") {
        console.warn(`[yt-dlp] Hard failure on strategy ${i} (${c.category}), aborting cascade`);
        cbFailure("ytdlp");
        break;
      }
      console.warn(`[yt-dlp] Strategy ${i} failed → next:`, err?.message?.slice(0, 100));
    }
  }
  throw lastErr;
}

// ─────────────────────────────────────────────────────────────────────────────
// ── TIER 3: gallery-dl ────────────────────────────────────────────────────────
// ─────────────────────────────────────────────────────────────────────────────

interface GalleryDlResult {
  videoUrl:  string;    // direct CDN URL extracted by gallery-dl
  audioUrl:  string | null;
  filename:  string;
  title:     string;
  thumbnail: string | null;
}

/**
 * gallery-dl --dump-json outputs one JSON object per file item.
 * We parse all lines and pick the best video entry.
 */
async function getGalleryDlDownloadUrl(url: string): Promise<GalleryDlResult> {
  if (cbIsOpen("gallerydl")) throw new Error("[CB] gallery-dl circuit is open");

  console.log(`[gallery-dl] → ${url.slice(0, 80)}`);

  const args = buildGalleryDlArgs(url, [
    "--dump-json",         // print JSON for each item, don't download
    "--no-download",
    "--no-part",
    "--timeout",    "30",
    "--retries",    "3",
  ]);

  const { stdout } = await execFilePromise("gallery-dl", args, {
    ...EXEC_OPTS,
    timeout: TIMEOUTS?.gallerydl ?? 45_000,
  });

  if (!stdout.trim()) throw new Error("gallery-dl: empty output");

  // gallery-dl emits one JSON array per item: [version, url_or_meta, ...]
  // Format:  [3, {...metadata...}]  or  [2, "https://..."]
  const entries: any[] = [];
  for (const line of stdout.trim().split("\n")) {
    try {
      const parsed = JSON.parse(line.trim());
      if (Array.isArray(parsed)) entries.push(parsed);
    } catch { /* skip malformed lines */ }
  }

  if (!entries.length) throw new Error("gallery-dl: no parseable JSON entries");

  // Prefer video entries; fall back to first entry
  const videoEntry = entries.find(e => {
    const meta = e[1];
    if (typeof meta === "string") return /\.(mp4|webm|mov|mkv|avi|flv|ts)(\?|$)/i.test(meta);
    return meta?.extension && /mp4|webm|mov|mkv|avi|flv|ts/i.test(meta.extension);
  }) ?? entries[0];

  const meta = videoEntry[1];
  let directUrl: string;
  let filename:  string;
  let title:     string;
  let thumbnail: string | null = null;

  if (typeof meta === "string") {
    directUrl = meta;
    filename  = meta.split("/").pop()?.split("?")[0] ?? "video.mp4";
    title     = filename.replace(/\.[^/.]+$/, "");
  } else {
    directUrl = meta.url        ?? meta._url    ?? "";
    filename  = meta.filename   ?? `${meta.id ?? "video"}.${meta.extension ?? "mp4"}`;
    title     = meta.title      ?? meta.description?.slice(0, 100) ?? filename;
    thumbnail = meta.thumbnail  ?? null;
  }

  if (!directUrl) throw new Error("gallery-dl: could not extract direct URL");

  cbSuccess("gallerydl");
  console.log(`[gallery-dl] ✅ ${directUrl.slice(0, 80)}`);
  return { videoUrl: directUrl, audioUrl: null, filename, title, thumbnail };
}

// ─────────────────────────────────────────────────────────────────────────────
// ── Handler helpers ───────────────────────────────────────────────────────────
// ─────────────────────────────────────────────────────────────────────────────

/** Wrap a raw CDN URL with our tunnel proxy endpoint */
function tunnelUrl(raw: string): string {
  return `${BASE_URL}/tunnel?url=${encodeURIComponent(raw)}`;
}

/** Determine MIME type from URL / filename */
function guessMime(filename: string): string {
  const ext = filename.split(".").pop()?.toLowerCase() ?? "";
  const map: Record<string,string> = {
    mp4:  "video/mp4",
    webm: "video/webm",
    mkv:  "video/x-matroska",
    mov:  "video/quicktime",
    m4a:  "audio/mp4",
    aac:  "audio/aac",
    mp3:  "audio/mpeg",
    ogg:  "audio/ogg",
    ts:   "video/mp2t",
    flv:  "video/x-flv",
  };
  return map[ext] ?? "application/octet-stream";
}

// ─────────────────────────────────────────────────────────────────────────────
// ── 1. GET VIDEO INFO ─────────────────────────────────────────────────────────
// ─────────────────────────────────────────────────────────────────────────────

export const getVideoInfo = async (
  req: FastifyRequest<{ Body: VideoInfoBody }>,
  reply: FastifyReply,
) => {
  const { url } = req.body;

  if (!url || typeof url !== "string") {
    return reply.code(400).send({ success: false, message: "URL is required" });
  }

  const resolvedUrl = await resolveRedirectUrl(url.trim());

  if (!isUrlSafe(resolvedUrl)) {
    console.warn("[Info] Unsafe URL rejected:", resolvedUrl);
    return reply.code(400).send({ success: false, message: "Invalid or unsupported URL" });
  }

  const cacheKey = `info:${resolvedUrl}`;

  const result = await dedupe(cacheKey, async () => {
    // yt-dlp gives richer metadata; run it first, Cobalt as fallback
    const ytdlpPromise = getYtDlpInfo(resolvedUrl)
      .then(d => ({ source: "ytdlp" as const, data: d }))
      .catch(e => { console.warn("[yt-dlp] Info failed:", e.message?.slice(0, 100)); return null; });

    const cobaltPromise = getCobaltDownloadUrl(resolvedUrl, "720")
      .then(r => ({
        source: "cobalt" as const,
        data: {
          title:     r.filename.replace(/\.[^/.]+$/, ""),
          thumbnail: null,
          duration:  0,
          ext:       r.filename.split(".").pop() ?? "mp4",
        },
      }))
      .catch(e => { console.warn("[Cobalt] Info failed:", e.message?.slice(0, 100)); return null; });

    const [ytdlp, cobalt] = await Promise.all([ytdlpPromise, cobaltPromise]);
    return ytdlp ?? cobalt;
  });

  if (result) {
    return reply.code(200).send({
      success: true,
      source:  result.source,
      message: "Fetch video info successful",
      data:    result.data,
    });
  }

  return reply.code(500).send({ success: false, message: "Failed to fetch video info from all sources" });
};

// ─────────────────────────────────────────────────────────────────────────────
// ── 2. GET DOWNLOAD LINK ──────────────────────────────────────────────────────
// ─────────────────────────────────────────────────────────────────────────────

export const getDownloadLink = async (
  req: FastifyRequest<{ Body: DownloadBody }>,
  reply: FastifyReply,
) => {
  const { url, quality = "720" } = req.body;

  if (!url || typeof url !== "string") {
    return reply.code(400).send({ success: false, message: "Invalid or missing URL" });
  }

  const resolvedUrl = await resolveRedirectUrl(url.trim());

  if (!isUrlSafe(resolvedUrl)) {
    console.warn("[Download] Unsafe URL rejected:", resolvedUrl);
    return reply.code(400).send({ success: false, message: "Invalid or unsupported URL" });
  }

  const validQualities   = ["144","240","360","480","720","1080","1440","2160"];
  const normalizedQuality = validQualities.includes(String(quality).replace("p",""))
    ? String(quality).replace("p","")
    : "720";

  const platform   = detectPlatform(resolvedUrl);
  const cacheKey   = `dl:${resolvedUrl}:${normalizedQuality}`;

  console.log(`[Download] platform=${platform} quality=${normalizedQuality} url=${resolvedUrl.slice(0,80)}`);

  const execute = async () => {
    // ── TIER 1: Cobalt ──────────────────────────────────────────────────────
    if (!cbIsOpen("cobalt")) {
      try {
        const result = await withRetry(
          () => getCobaltDownloadUrl(resolvedUrl, normalizedQuality),
          { retries: 1, baseDelay: 500, label: "Cobalt" },
        );
        console.log("[Cobalt] ✅", resolvedUrl.slice(0, 80));

        return {
          success:  true,
          source:   "cobalt",
          type:     result.type,
          data: {
            videoUrl: result.url,
            audioUrl: result.audioUrl ? tunnelUrl(result.audioUrl) : null,
            filename: result.filename,
            type:     result.type,
          },
        };
      } catch (e: any) {
        console.warn("[Cobalt] ❌", e.message?.slice(0, 120));
      }
    } else {
      console.warn("[Cobalt] ⚡ Circuit open, skipping");
    }

    // ── TIER 2: yt-dlp ──────────────────────────────────────────────────────
    if (!cbIsOpen("ytdlp")) {
      try {
        const result = await withRetry(
          () => getYtDlpWithFallback(resolvedUrl),
          { retries: 1, baseDelay: 1_000, label: "yt-dlp" },
        );
        console.log(`[yt-dlp] ✅ strategy=${result.strategyUsed}`, resolvedUrl.slice(0, 80));

        return {
          success:  true,
          source:   "ytdlp",
          type:     result.audioUrl ? "split" : "tunnel",
          data: {
            videoUrl:     tunnelUrl(result.videoUrl),
            audioUrl:     result.audioUrl ? tunnelUrl(result.audioUrl) : null,
            type:         result.audioUrl ? "split" : "tunnel",
            strategyUsed: result.strategyUsed,
            title:        result.title,
            thumbnail:    result.thumbnail,
          },
        };
      } catch (e: any) {
        console.warn("[yt-dlp] ❌", e.message?.slice(0, 120));
        cbFailure("ytdlp");
      }
    } else {
      console.warn("[yt-dlp] ⚡ Circuit open, skipping");
    }

    // ── TIER 3: gallery-dl ──────────────────────────────────────────────────
    if (!cbIsOpen("gallerydl")) {
      try {
        const result = await withRetry(
          () => getGalleryDlDownloadUrl(resolvedUrl),
          { retries: 1, baseDelay: 1_000, label: "gallery-dl" },
        );
        console.log("[gallery-dl] ✅", resolvedUrl.slice(0, 80));

        return {
          success:  true,
          source:   "gallerydl",
          type:     "tunnel",
          data: {
            videoUrl:  tunnelUrl(result.videoUrl),
            audioUrl:  null,
            filename:  result.filename,
            title:     result.title,
            thumbnail: result.thumbnail,
            type:      "tunnel",
          },
        };
      } catch (e: any) {
        console.warn("[gallery-dl] ❌", e.message?.slice(0, 120));
        cbFailure("gallerydl");

        // Build the most meaningful error from all failed sources
        const stderr     = e?.stderr ?? e?.message ?? "";
        const classified = classifyError(stderr);

        return {
          _error:   true,
          statusCode: classified.statusCode,
          body: {
            success:  false,
            message:  classified.message,
            platform,
            ...(IS_DEV && { debug: e?.message }),
          },
        };
      }
    }

    return {
      _error:     true,
      statusCode: 503,
      body: {
        success: false,
        message: "All download services are temporarily unavailable. Please try again shortly.",
        platform,
      },
    };
  };

  const result = await dedupe(cacheKey, execute);

  if ((result as any)._error) {
    const err = result as any;
    req.log.error({ url: resolvedUrl, platform }, err.body.message);
    return reply.code(err.statusCode).send(err.body);
  }

  return reply.code(200).send(result);
};

// ─────────────────────────────────────────────────────────────────────────────
// ── 3. RESOLVE URL ────────────────────────────────────────────────────────────
// ─────────────────────────────────────────────────────────────────────────────

export const resolveUrl = async (
  req: FastifyRequest<{ Querystring: { url: string } }>,
  reply: FastifyReply,
) => {
  const { url } = req.query as { url: string };

  if (!url || typeof url !== "string") {
    return reply.code(400).send({ success: false, message: "url query param is required" });
  }

  try {
    const resolvedUrl = await resolveRedirectUrl(url.trim());
    if (!isUrlSafe(resolvedUrl)) {
      return reply.code(400).send({ success: false, message: "Invalid or unsupported URL" });
    }
    return reply.code(200).send({
      success:     true,
      resolvedUrl,
      platform:    detectPlatform(resolvedUrl),
    });
  } catch (err: any) {
    return reply.code(500).send({ success: false, message: "Failed to resolve URL" });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// ── 4. TUNNEL ─────────────────────────────────────────────────────────────────
// Streams ANY direct CDN URL (Cobalt, yt-dlp, gallery-dl) back to the client.
// Supports Range requests so mobile video players can seek.
// ─────────────────────────────────────────────────────────────────────────────

export const tunnel = async (req: FastifyRequest, reply: FastifyReply) => {
  const { url: rawUrl, filename: rawFilename } = req.query as { url?: string; filename?: string };

  if (!rawUrl) {
    return reply.code(400).send({ success: false, message: "url query param is required" });
  }

  let targetUrl: string;
  try {
    targetUrl = decodeURIComponent(rawUrl);
  } catch {
    return reply.code(400).send({ success: false, message: "Invalid url encoding" });
  }

  // Safety: only allow https / http URLs pointing to known CDN patterns
  if (!/^https?:\/\//i.test(targetUrl)) {
    return reply.code(400).send({ success: false, message: "Invalid tunnel target URL" });
  }

  // Forward Range header if client is seeking
  const rangeHeader = (req.headers as any)["range"];
  const upstreamHeaders: Record<string, string> = {
    "User-Agent":      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    "Accept":          "*/*",
    "Accept-Encoding": "identity",
  };
  if (rangeHeader) upstreamHeaders["Range"] = rangeHeader;

  // Add referer for known domains that check it
  const referer = getReferer(targetUrl);
  if (referer) upstreamHeaders["Referer"] = referer;

  try {
    const upstream = await fetch(targetUrl, {
      headers: upstreamHeaders,
      signal:  AbortSignal.timeout(60_000),
    });

    if (!upstream.ok && upstream.status !== 206) {
      console.error(`[Tunnel] Upstream error ${upstream.status} for ${targetUrl.slice(0,80)}`);
      return reply.code(502).send({ success: false, message: `Upstream returned ${upstream.status}` });
    }

    // Pass status through (200 or 206 Partial Content)
    reply.status(upstream.status);

    // Content headers
    const contentType   = upstream.headers.get("content-type")   ?? guessMime(rawFilename ?? targetUrl);
    const contentLength = upstream.headers.get("content-length");
    const contentRange  = upstream.headers.get("content-range");
    const acceptRanges  = upstream.headers.get("accept-ranges");

    reply.header("Content-Type",              contentType);
    reply.header("Accept-Ranges",             acceptRanges ?? "bytes");
    reply.header("Cache-Control",             "no-store");
    reply.header("X-Content-Type-Options",    "nosniff");
    reply.header("Access-Control-Allow-Origin", "*");

    if (contentLength) reply.header("Content-Length", contentLength);
    if (contentRange)  reply.header("Content-Range",  contentRange);

    // Content-Disposition so browsers save with a nice filename
    const filename = rawFilename ?? targetUrl.split("/").pop()?.split("?")[0] ?? "video.mp4";
    const safeName = filename.replace(/[^\w\s.\-]/g, "_");
    reply.header("Content-Disposition", `attachment; filename="${safeName}"`);

    return reply.send(upstream.body);

  } catch (err: any) {
    console.error("[Tunnel] Fetch error:", err?.message);
    return reply.code(502).send({ success: false, message: "Tunnel upstream unreachable" });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// ── 5. HEALTH CHECK ───────────────────────────────────────────────────────────
// ─────────────────────────────────────────────────────────────────────────────

export const healthCheck = async (_req: FastifyRequest, reply: FastifyReply) => {
  const cobaltOk = await fetch(`${COBALT_URL}/`, {
    method:  "HEAD",
    signal:  AbortSignal.timeout(3_000),
  }).then(() => true).catch(() => false);

  return reply.code(200).send({
    status:   "ok",
    uptime:   process.uptime(),
    circuits: Object.fromEntries(
      Object.entries(circuitBreakers).map(([k, v]) => [
        k,
        { open: v.openUntil > Date.now(), failures: v.failures },
      ])
    ),
    cobalt:   cobaltOk ? "up" : "down",
    inFlight: inFlight.size,
  });
};

// ─────────────────────────────────────────────────────────────────────────────

export const downloadController = {
  getVideoInfo,
  getDownloadLink,
  resolveUrl,
  tunnel,
  healthCheck,
};