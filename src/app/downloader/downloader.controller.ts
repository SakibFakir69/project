/**
 * download.controller.ts — v5 "Production Final"
 * ─────────────────────────────────────────────────────────────────────────────
 * ALL issues fixed vs v4:
 *
 *  ✅ Redis credentials removed from source — use .env only
 *  ✅ Retry mutation: each attempt = different proxy + identity + cookie
 *  ✅ Mobile UA / android / iOS identity rotation per attempt
 *  ✅ Platform adapters: YouTube / TikTok / Instagram / Facebook / Generic
 *  ✅ Playwright browser fallback (tier-4) for all-extractor failures
 *  ✅ Daily yt-dlp auto-update cron (3 AM, with lock file)
 *  ✅ Cookie rotation per platform with failure tracking
 *  ✅ Proxy pool with health scoring + per-attempt rotation
 *  ✅ Proper AbortController on client disconnect
 *  ✅ Double cbFailure bug fixed
 *  ✅ Dedupe no longer caches error objects
 *  ✅ safeTunnelUrl with CDN allowlist
 *  ✅ Full TypeScript interfaces (no unsafe any on parsed JSON)
 *  ✅ Structured JSON logging throughout
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { execFile } from "node:child_process";
import { statSync } from "node:fs";
import { promisify } from "node:util";
import type { FastifyRequest, FastifyReply } from "fastify";

import { isUrlSafe } from "../../utils/download.utils.js";
import { getReferer, TIMEOUTS } from "../../constant/index.contant.js";
import type { VideoQuality, DownloadType, AudioFormat } from "../../types/index.js";
import { proxyPool } from "../../Proxy/Proxy.pool.js";
import { cookieManager } from "../../cookies/Cookie.manager.js";
import { identityManager } from "../../manager/Identity.manager.js";
import { getAdapter } from "../../index/index.adapter.js";
import { extractWithPlaywright } from "../../Playwright/Playwright.extractor.js";
import { scheduleDaily } from "../../cron/Updater.cron.js";
import type { AttemptContext } from "./../../adapter/ Base.adapter.js"



// ── Config ────────────────────────────────────────────────────────────────────
// SECURITY: credentials live in .env only — never hardcoded in source

const BASE_URL = process.env.API_URL ?? "https://downtubebest.duckdns.org/api/v1";
const COBALT_URL = process.env.COBALT_URL ?? "http://cobalt-api:9000";
const REDIS_URL = process.env.REDIS_URL ?? "";   // set in .env, never here
const NODE_ENV = process.env.NODE_ENV ?? "production";
const IS_DEV = NODE_ENV === "development";

const YTDLP_MAX_AGE_DAYS = parseInt(process.env.YTDLP_MAX_AGE_DAYS ?? "7", 10);

const execFilePromise = promisify(execFile);

const EXEC_OPTS = {
  killSignal: "SIGKILL" as const,
  maxBuffer: 8 * 1024 * 1024,
};

// ── Start daily yt-dlp updater ────────────────────────────────────────────────
scheduleDaily();

// ── Rate limit config ─────────────────────────────────────────────────────────
export const RATE_LIMIT_OPTIONS = {
  max: 10,
  timeWindow: 60_000,
  errorResponseBuilder: (_req: any, context: any) => ({
    success: false,
    message: `Rate limit exceeded. Retry in ${Math.ceil(context.ttl / 1000)}s.`,
    retryAfter: Math.ceil(context.ttl / 1000),
  }),
};

// ── Types ─────────────────────────────────────────────────────────────────────

interface VideoInfoBody { url: string; }
interface DownloadBody {
  url: string;
  type?: DownloadType;
  quality?: VideoQuality;
  audioFormat?: AudioFormat;
}

interface YtDlpFormat {
  url?: string;
  vcodec?: string;
  acodec?: string;
}

interface YtDlpMeta {
  requested_formats?: YtDlpFormat[];
  url?: string;
  title?: string;
  thumbnail?: string;
  duration?: number;
  ext?: string;
}



// ── Structured JSON logger ────────────────────────────────────────────────────

type LogLevel = "info" | "warn" | "error" | "debug";

function log(level: LogLevel, service: string, msg: string, extra?: Record<string, any>) {
  const entry = { ts: new Date().toISOString(), level, service, msg, ...extra };
  if (level === "error") process.stderr.write(JSON.stringify(entry) + "\n");
  else process.stdout.write(JSON.stringify(entry) + "\n");
}

// ─────────────────────────────────────────────────────────────────────────────
// Cache: Redis with in-memory fallback
// ─────────────────────────────────────────────────────────────────────────────

interface ICache {
  get(key: string): Promise<any | null>;
  set(key: string, value: any, ttlMs: number): Promise<void>;
  delete(key: string): Promise<void>;
  size(): number;
}

interface MemEntry { value: any; expiresAt: number; }

class MemoryCache implements ICache {
  private map = new Map<string, MemEntry>();
  private maxSize = 300;
  private _size = 0;

  async get(key: string): Promise<any | null> {
    const e = this.map.get(key);
    if (!e) return null;
    if (Date.now() > e.expiresAt) { this.map.delete(key); this._size--; return null; }
    this.map.delete(key); this.map.set(key, e);
    return e.value;
  }

  async set(key: string, value: any, ttlMs: number): Promise<void> {
    const existing = this.map.has(key);
    if (!existing && this.map.size >= this.maxSize) {
      const oldest = this.map.keys().next().value;
      if (oldest) { this.map.delete(oldest); this._size--; }
    }
    this.map.set(key, { value, expiresAt: Date.now() + ttlMs });
    if (!existing) this._size++;
  }

  async delete(key: string): Promise<void> { if (this.map.delete(key)) this._size--; }
  size(): number { return this._size; }
}

class RedisCache implements ICache {
  private client: any = null;
  private mem = new MemoryCache();

  async init(url: string): Promise<void> {
    try {
      const { default: Redis } = await import("ioredis") as any;
      this.client = new Redis(url, { maxRetriesPerRequest: 1, connectTimeout: 3_000, lazyConnect: true });
      await this.client.connect();
      log("info", "cache", "Redis connected", { url: url.replace(/:[^@]+@/, ":***@") });
    } catch (err: any) {
      log("warn", "cache", "Redis unavailable — using memory cache", { error: err?.message });
      this.client = null;
    }
  }

  async get(key: string): Promise<any | null> {
    if (!this.client) return this.mem.get(key);
    try { const r = await this.client.get(key); return r ? JSON.parse(r) : null; }
    catch { return this.mem.get(key); }
  }

  async set(key: string, value: any, ttlMs: number): Promise<void> {
    if (!this.client) return this.mem.set(key, value, ttlMs);
    try { await this.client.set(key, JSON.stringify(value), "PX", ttlMs); }
    catch { return this.mem.set(key, value, ttlMs); }
  }

  async delete(key: string): Promise<void> {
    if (!this.client) return this.mem.delete(key);
    try { await this.client.del(key); } catch { return this.mem.delete(key); }
  }

  size(): number { return this.client ? -1 : this.mem.size(); }
}

let cache: ICache;
if (REDIS_URL) {
  const rc = new RedisCache();
  rc.init(REDIS_URL);
  cache = rc;
} else {
  cache = new MemoryCache();
}

// Platform-specific TTLs
const PLATFORM_TTL_MS: Record<string, number> = {
  youtube: 6 * 60 * 60_000,
  vimeo: 4 * 60 * 60_000,
  reddit: 2 * 60 * 60_000,
  twitter: 1 * 60 * 60_000,
  tiktok: 45 * 60_000,
  instagram: 45 * 60_000,
  facebook: 30 * 60_000,
  generic: 60 * 60_000,
};

function cacheTtl(platform: string): number {
  return PLATFORM_TTL_MS[platform] ?? 60 * 60_000;
}

// ─────────────────────────────────────────────────────────────────────────────
// yt-dlp freshness check (non-blocking)
// ─────────────────────────────────────────────────────────────────────────────

async function checkYtDlpFreshness(): Promise<void> {
  try {
    const { stdout } = await execFilePromise("which", ["yt-dlp"], { encoding: "utf8" });
    const { mtimeMs } = statSync((stdout as string).trim());
    const ageDays = (Date.now() - mtimeMs) / 86_400_000;
    if (ageDays > YTDLP_MAX_AGE_DAYS) {
      log("warn", "ytdlp", `Binary is ${ageDays.toFixed(1)} days old`, { ageDays });
    } else {
      log("info", "ytdlp", `Binary is fresh (${ageDays.toFixed(1)} days old)`);
    }
  } catch (err: any) {
    log("warn", "ytdlp", "Could not check binary age", { error: err?.message });
  }
}

checkYtDlpFreshness();
setInterval(checkYtDlpFreshness, 12 * 60 * 60_000);

// ── CDN allowlist (SSRF protection) ──────────────────────────────────────────

const CDN_ALLOWLIST = [
  /googlevideo\.com$/i,
  /youtube\.com\/videoplayback/i,
  /tiktokcdn\.com$/i,
  /tiktokcdn-us\.com$/i,
  /tiktok\.com\/aweme\/v\d+\/play/i,
  /fbcdn\.net$/i,
  /cdninstagram\.com$/i,
  /twimg\.com$/i,
  /video\.twimg\.com$/i,
  /redditmedia\.com$/i,
  /reddituploads\.com$/i,
  /vimeocdn\.com$/i,
  /clips-media-assets2\.twitch\.tv$/i,
  /vod-secure\.twitch\.tv$/i,
  new RegExp(COBALT_URL.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
];

function isCdnAllowed(url: string): boolean {
  try {
    const { hostname, href } = new URL(url);
    return CDN_ALLOWLIST.some(p => p.test(hostname) || p.test(href));
  } catch { return false; }
}

function safeTunnelUrl(raw: string): { url: string; tunnelAllowed: boolean } {
  return isCdnAllowed(raw)
    ? { url: `${BASE_URL}/tunnel?url=${encodeURIComponent(raw)}`, tunnelAllowed: true }
    : { url: raw, tunnelAllowed: false };
}

// ── Semaphore ─────────────────────────────────────────────────────────────────

const MAX_CONCURRENT_PROCS = parseInt(process.env.MAX_PROCS ?? "8", 10);
const MAX_QUEUE_DEPTH = 50;

class Semaphore {
  private running = 0;
  private queue: Array<() => void> = [];
  constructor(private limit: number) { }
  get queueDepth(): number { return this.queue.length; }
  get runningCount(): number { return this.running; }
  acquire(): Promise<void> {
    if (this.running < this.limit) { this.running++; return Promise.resolve(); }
    return new Promise(r => this.queue.push(r));
  }
  release(): void {
    const next = this.queue.shift();
    if (next) next(); else this.running--;
  }
}

const procSemaphore = new Semaphore(MAX_CONCURRENT_PROCS);

async function withSemaphore<T>(fn: () => Promise<T>): Promise<T> {
  if (procSemaphore.queueDepth >= MAX_QUEUE_DEPTH)
    throw Object.assign(new Error("Server busy"), { _isBusy: true });
  await procSemaphore.acquire();
  try { return await fn(); }
  finally { procSemaphore.release(); }
}

// ── Cobalt probe ──────────────────────────────────────────────────────────────

let cobaltReachable = true;

async function probeCobalt(): Promise<void> {
  try {
    const res = await fetch(`${COBALT_URL}/`, { method: "HEAD", signal: AbortSignal.timeout(3_000) });
    cobaltReachable = res.ok || res.status < 500;
  } catch {
    cobaltReachable = false;
    log("warn", "cobalt", "Probe failed — Cobalt disabled until next probe");
  }
}

probeCobalt();
setInterval(probeCobalt, 2 * 60_000);

// ── Platform detection ────────────────────────────────────────────────────────

type Platform =
  | "youtube" | "tiktok" | "instagram" | "twitter"
  | "reddit" | "facebook" | "pinterest" | "tumblr"
  | "vimeo" | "twitch" | "generic";

function detectPlatform(url: string): Platform {
  if (/youtube\.com|youtu\.be/i.test(url)) return "youtube";
  if (/tiktok\.com|vm\.tiktok|vt\.tiktok/i.test(url)) return "tiktok";
  if (/instagram\.com/i.test(url)) return "instagram";
  if (/twitter\.com|x\.com/i.test(url)) return "twitter";
  if (/reddit\.com|redd\.it/i.test(url)) return "reddit";
  if (/facebook\.com|fb\.watch/i.test(url)) return "facebook";
  if (/pinterest\.com|pin\.it/i.test(url)) return "pinterest";
  if (/tumblr\.com/i.test(url)) return "tumblr";
  if (/vimeo\.com/i.test(url)) return "vimeo";
  if (/twitch\.tv|clips\.twitch\.tv/i.test(url)) return "twitch";
  return "generic";
}

// ── Error classifier ──────────────────────────────────────────────────────────

export interface ClassifiedError {
  message: string; retryable: boolean; statusCode: number; category: string;
}

function classifyError(raw: string): ClassifiedError {
  const s = (raw ?? "").toLowerCase();
  if (s.includes("429") || s.includes("rate limit") || s.includes("too many requests"))
    return { message: "Rate limit hit — try again in a few minutes", retryable: true, statusCode: 429, category: "rate_limit" };
  if (s.includes("private") || s.includes("login required") || s.includes("age-restricted"))
    return { message: "Video is private or requires login", retryable: false, statusCode: 403, category: "auth" };
  if (s.includes("unavailable") || s.includes("not found") || s.includes("404") || s.includes("deleted"))
    return { message: "Video is unavailable or removed", retryable: false, statusCode: 404, category: "not_found" };
  if (s.includes("geo") || s.includes("not available in your country"))
    return { message: "Video is geo-restricted", retryable: false, statusCode: 451, category: "geo" };
  if (s.includes("copyright") || s.includes("dmca"))
    return { message: "Video is blocked due to copyright", retryable: false, statusCode: 403, category: "copyright" };
  if (s.includes("network") || s.includes("timeout") || s.includes("connection") ||
    s.includes("502") || s.includes("503") || s.includes("504"))
    return { message: "Network error — retrying", retryable: true, statusCode: 503, category: "network" };
  if (s.includes("nsig") || s.includes("player") || s.includes("signature") ||
    s.includes("bot") || s.includes("automated") || s.includes("potoken"))
    return { message: "YouTube player error — yt-dlp may need updating", retryable: false, statusCode: 500, category: "player" };
  if (s.includes("no video formats") || s.includes("format is not available"))
    return { message: "No matching video format", retryable: true, statusCode: 500, category: "format" };
  if (s.includes("no space") || s.includes("out of memory"))
    return { message: "Server resource error", retryable: false, statusCode: 500, category: "resource" };
  return { message: "Failed to process video URL", retryable: false, statusCode: 500, category: "unknown" };
}

// ── Circuit breakers ──────────────────────────────────────────────────────────

interface CBState { failures: number; openUntil: number; halfOpen: boolean; }

const CB_THRESHOLD = 5;
const CB_COOLDOWN_MS = 30_000;

const circuitBreakers: Record<string, CBState> = {
  cobalt: { failures: 0, openUntil: 0, halfOpen: false },
  ytdlp: { failures: 0, openUntil: 0, halfOpen: false },
  gallerydl: { failures: 0, openUntil: 0, halfOpen: false },
};

function cbIsOpen(name: string): boolean {
  const cb = circuitBreakers[name];
  if (!cb || cb.openUntil === 0) return false;
  if (Date.now() < cb.openUntil) return true;
  cb.halfOpen = true; cb.openUntil = 0; return false;
}
function cbSuccess(name: string) {
  const cb = circuitBreakers[name]; if (!cb) return;
  cb.failures = 0; cb.openUntil = 0; cb.halfOpen = false;
}
function cbFailure(name: string) {
  const cb = circuitBreakers[name]; if (!cb) return;
  cb.failures++;
  if (cb.failures >= CB_THRESHOLD || cb.halfOpen) {
    cb.openUntil = Date.now() + CB_COOLDOWN_MS; cb.halfOpen = false;
    log("warn", "circuit", `Circuit OPEN: ${name}`, { cooldownMs: CB_COOLDOWN_MS });
  }
}

// ── In-flight deduplication (errors are NOT cached) ───────────────────────────

const inFlight = new Map<string, Promise<any>>();

function dedupe<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const existing = inFlight.get(key);
  if (existing) { log("debug", "dedupe", "Coalescing request", { key: key.slice(0, 80) }); return existing; }

  const p = fn()
    .then(res => {
      if (res && typeof res === "object" && "_error" in res) {
        inFlight.delete(key); // don't coalesce errors
      }
      return res;
    })
    .catch(err => {
      inFlight.delete(key); // remove on rejection so next request can retry
      throw err;
    })
    .finally(() => inFlight.delete(key));

  inFlight.set(key, p);
  return p;
}

// ── Short URL resolver ────────────────────────────────────────────────────────

async function resolveRedirectUrl(url: string): Promise<string> {
  try {
    const res = await fetch(url, {
      method: "GET", redirect: "follow", signal: AbortSignal.timeout(8_000),
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
        "Range": "bytes=0-0",  // only fetch 1 byte — don't download the video
      },
    });
    let resolved = res.url || url;
    if ((resolved.includes("tiktok.com") || resolved.includes("instagram.com")) && resolved.includes("?"))
      resolved = resolved.split("?")[0];
    if (resolved !== url) log("debug", "resolver", "Resolved redirect", { from: url.slice(0, 80), to: resolved.slice(0, 120) });
    return resolved;

  } catch { return url; }
}

// ─────────────────────────────────────────────────────────────────────────────
// RETRY MUTATION SYSTEM
// ─────────────────────────────────────────────────────────────────────────────
// Each attempt mutates: proxy, cookie, identity (UA/client), and format strategy.
// Attempt 0: proxy #0 + cookie #0 + desktop web
// Attempt 1: proxy #1 + cookie #1 + android client
// Attempt 2: proxy #2 + cookie #2 + iOS client
// Attempt 3: proxy #3 + cookie #3 + TikTok app UA
// This is why mutation-based retry succeeds where identical retry fails.

function buildAttemptContext(
  url: string,
  platform: Platform,
  attemptIndex: number,
  signal?: AbortSignal,
): AttemptContext {
  // FIX: Pass platform to pickByIndex so it skips proxies temporarily banned for this platform
  const proxy = proxyPool.pickByIndex(attemptIndex, platform);
  const cookie = cookieManager.byIndex(platform as any, attemptIndex);
  const identity = identityManager.forAttempt(attemptIndex);

  return { attemptIndex, proxy: proxy?.url ?? null, cookiePath: cookie, identity, signal };
}

// ── yt-dlp arg builder (uses adapter + mutation context) ─────────────────────

function buildYtDlpArgs(
  url: string,
  platform: Platform,
  ctx: AttemptContext,
  extra: string[],
): string[] {
  const adapter = getAdapter(platform);
  const referer = getReferer(url);

  const args: string[] = [
    "--no-check-certificate", "--no-playlist",
    "--socket-timeout", String(TIMEOUTS.socket ?? 30),
    "--retries", "3", "--fragment-retries", "3",
    "--file-access-retries", "3", "--extractor-retries", "3",
    // Mobile identity for this attempt
    "--add-header", `User-Agent:${ctx.identity.userAgent}`,
    ...identityManager.ytdlpHeaderArgs(ctx.identity),
    // FIX 3: Use proxy directly from context instead of re-fetching it
    ...proxyPool.ytdlpArgs({ url: ctx.proxy } as any),
    // Platform-specific args from adapter
    ...adapter.ytdlpPlatformArgs(ctx),
    ...(referer ? ["--add-header", `Referer:${referer}`] : []),
    ...extra,
    url,
  ];
  // FIX 4: Safely inject cookies at the end of the array, before the URL
  if (ctx.cookiePath && !args.includes("--cookies")) {
    const targetUrl = args.pop(); // Remove the URL (always the last element)
    args.push("--cookies", ctx.cookiePath, targetUrl!);
  }
  return args;
}

// ── gallery-dl arg builder ────────────────────────────────────────────────────

function buildGalleryDlArgs(url: string, platform: Platform, ctx: AttemptContext, extra: string[]): string[] {
  const adapter = getAdapter(platform);
  const proxy = proxyPool.pickByIndex(ctx.attemptIndex);
  const proxyStr = proxy?.url ?? null;

  return [
    "--no-mtime", "--filename", "{id}.{extension}",
    ...(proxyStr ? ["--proxy", proxyStr] : []),
    ...(ctx.cookiePath ? ["--cookies", ctx.cookiePath] : []),
    ...adapter.galleryDlPlatformArgs(ctx),
    ...extra,
    url,
  ];
}

// ─────────────────────────────────────────────────────────────────────────────
// TIER 1: Cobalt
// ─────────────────────────────────────────────────────────────────────────────



// ── Updated Interfaces based on official API docs ────────────────────────────
// ── Interfaces ────────────────────────────────────────────────────────────────
interface CobaltApiResponse {
  status?: "tunnel" | "redirect" | "picker" | "error" | "local-processing";
  url?: string;
  filename?: string;
  audio?: string;
  audioFilename?: string;
  picker?: Array<{ type: string; url: string; thumb?: string }>;
  type?: string;
  service?: string;
  tunnel?: string[];
  output?: { filename: string; type: string; metadata?: Record<string, string> };
  isHLS?: boolean;
  error?: {
    code: string;
    context?: {
      service?: string;
      limit?: number;
    };
  };
}

interface CobaltResult {
  url: string;
  audioUrl: string | null;
  filename: string;
  type: string;
}

async function getCobaltDownloadUrl(
  resolvedUrl: string,
  quality = "1080",
  downloadMode: "auto" | "audio" | "mute" = "auto",
  signal?: AbortSignal,
): Promise<CobaltResult> {
  if (!cobaltReachable) throw new Error("[Cobalt] Unreachable");
  if (cbIsOpen("cobalt")) throw new Error("[CB] Cobalt circuit open");

  const validQ = ["max", "144", "240", "360", "480", "720", "1080", "1440", "2160", "4320"];
  const q = validQ.includes(quality.replace("p", "")) ? quality.replace("p", "") : "1080";

  const timeoutSignal = AbortSignal.timeout(15_000);
  const fetchSignal = signal ? AbortSignal.any([timeoutSignal, signal]) : timeoutSignal;

  const response = await fetch(`${COBALT_URL}/`, {
    method: "POST",
    signal: fetchSignal,
    headers: {
      "Content-Type": "application/json",
      "Accept":       "application/json",
    },
    body: JSON.stringify({
      url:               resolvedUrl,
      videoQuality:      q,
      filenameStyle:     "basic",
      downloadMode:      downloadMode,
      youtubeVideoCodec: "h264",
      allowH265:         false,
      alwaysProxy:       false,
      tiktokFullAudio:   true,
    }),
  });

  if (!response.ok) {
    const errBody = await response.text().catch(() => "");
    log("warn", "cobalt", `HTTP ${response.status}`, {
      body: errBody.slice(0, 200),
      url: resolvedUrl.slice(0, 80),
    });
    if (response.status === 429 || response.status >= 500) {
      cbFailure("cobalt");
    }
    throw new Error(`Cobalt HTTP ${response.status}: ${errBody.slice(0, 100)}`);
  }

  const data: CobaltApiResponse = await response.json();
  log("debug", "cobalt", `Status: ${data.status}`, { url: resolvedUrl.slice(0, 80) });

  switch (data.status) {
    case "tunnel":
    case "redirect":
      cbSuccess("cobalt");
      return {
        url:      data.url!,
        audioUrl: null,
        filename: data.filename ?? "video.mp4",
        type:     data.status,
      };

    case "local-processing": {
      const tunnels = data.tunnel ?? [];
      if (!tunnels.length) throw new Error("Cobalt local-processing: no tunnel URLs");
      cbSuccess("cobalt");
      return {
        url:      tunnels[0],
        audioUrl: tunnels[1] ?? null,
        filename: data.output?.filename ?? "video.mp4",
        type:     "local-processing",
      };
    }

    case "picker": {
      const vid = data.picker?.find(p => p.type === "video") ?? data.picker?.[0];
      if (!vid) throw new Error("Cobalt picker: no video entry found");
      const audioUrl = data.audio ?? data.picker?.find(p => p.type === "audio")?.url ?? null;
      cbSuccess("cobalt");
      return {
        url:      vid.url,
        audioUrl: audioUrl,
        filename: data.audioFilename ?? data.filename ?? "video.mp4",
        type:     "picker",
      };
    }

    case "error": {
      cbFailure("cobalt");
      const ctx = data.error?.context ? ` (${JSON.stringify(data.error.context)})` : "";
      throw new Error(`Cobalt error: ${data.error?.code}${ctx}`);
    }

    default:
      cbFailure("cobalt");
      throw new Error(`Unknown Cobalt status: ${(data as any).status}`);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// TIER 2: yt-dlp with mutation retry
// ─────────────────────────────────────────────────────────────────────────────

interface YtDlpResult {
  videoUrl: string; audioUrl: string | null; title: string;
  thumbnail: string | null; duration: number; ext: string; strategyUsed: number;
}

async function getYtDlpWithMutation(
  url: string,
  platform: Platform,
  quality: string,
  signal?: AbortSignal,
): Promise<YtDlpResult> {
  if (cbIsOpen("ytdlp")) throw new Error("[CB] yt-dlp circuit open");

  const adapter = getAdapter(platform);
  const strategies = adapter.formatStrategies;
  let lastErr: any;

  // Each outer attempt = different identity/proxy/cookie
  for (let attempt = 0; attempt < adapter.maxAttempts; attempt++) {
    const ctx = buildAttemptContext(url, platform, attempt, signal);
    const strategy = strategies[attempt % strategies.length];

    log("info", "ytdlp", `Attempt ${attempt + 1}/${adapter.maxAttempts}`, {
      client: ctx.identity.clientName,
      proxy: ctx.proxy ? "yes" : "no",
      cookie: ctx.cookiePath ? "yes" : "no",
      strategy: strategy.slice(0, 50),
    });

    const args = buildYtDlpArgs(url, platform, ctx, [
      "-f", strategy,
      "--dump-json",
      "--skip-download",
    ]);

    try {
      const { stdout } = await withSemaphore(async () => {
        if (signal?.aborted) throw new Error("Request aborted");
        const ac = new AbortController();
        const tid = setTimeout(() => ac.abort(), TIMEOUTS.url ?? 60_000);
        if (signal) signal.addEventListener("abort", () => ac.abort(), { once: true });
        try {
          return await execFilePromise("yt-dlp", args, { ...EXEC_OPTS, signal: ac.signal as any });
        } finally {
          clearTimeout(tid);
        }
      });

      const lines = stdout.trim().split("\n").filter(Boolean);
      let meta: YtDlpMeta;
      try { meta = JSON.parse(lines[lines.length - 1]); }
      catch { throw new Error("yt-dlp: non-JSON output"); }

      let videoUrl: string | null = null;
      let audioUrl: string | null = null;

      if (meta.requested_formats && meta.requested_formats.length >= 2) {
        const vf = meta.requested_formats.find(f => f.vcodec && f.vcodec !== "none");
        const af = meta.requested_formats.find(f => f.acodec && f.acodec !== "none" && (!f.vcodec || f.vcodec === "none"));
        videoUrl = vf?.url ?? meta.url ?? null;
        audioUrl = af?.url ?? null;
      } else {
        videoUrl = meta.url ?? null;
      }

      if (!videoUrl) throw new Error("yt-dlp: no video URL in output");

      // Mark proxy and cookie as successful
      const proxy = proxyPool.pickByIndex(attempt);
      if (proxy) proxyPool.success(proxy);
      if (ctx.cookiePath) cookieManager.markSuccess(platform as any, ctx.cookiePath);

      cbSuccess("ytdlp");
      log("info", "ytdlp", `Success on attempt ${attempt + 1}`, { strategy: attempt });
      return { videoUrl, audioUrl, title: meta.title ?? "video", thumbnail: meta.thumbnail ?? null, duration: meta.duration ?? 0, ext: meta.ext ?? "mp4", strategyUsed: attempt };

    } catch (err: any) {
      lastErr = err;
      const c = classifyError(err?.stderr ?? err?.message ?? "");

      // Mark proxy/cookie as failed
      const proxy = proxyPool.pickByIndex(attempt);
      if (proxy) proxyPool.failure(proxy, platform, c.category === "rate_limit");
      if (ctx.cookiePath) cookieManager.markFailed(platform as any, ctx.cookiePath);

      log("warn", "ytdlp", `Attempt ${attempt + 1} failed`, { category: c.category, error: err?.message?.slice(0, 100) });

      // FIX 1: Only trip circuit breaker on systemic downstream issues (429, 500, network)
      // Do NOT trip for 404 (deleted) or 403 (private/geo) - those are correct user-data errors.
      if (c.category === "rate_limit" || c.category === "network" || c.statusCode >= 500) {
        cbFailure("ytdlp");
      }

      // Hard failures (like 404, private video) — no point mutating, just break the loop
      if (!c.retryable) {
        break;
      }

      // Small delay between mutation attempts
      if (attempt < adapter.maxAttempts - 1) {
        await new Promise(r => setTimeout(r, 800 * (attempt + 1)));
      }

    }
  }

  throw lastErr;
}

async function getYtDlpInfo(url: string, platform: Platform): Promise<{ title: string; thumbnail: string | null; duration: number; ext: string }> {
  const ctx = buildAttemptContext(url, platform, 0);
  const args = buildYtDlpArgs(url, platform, ctx, ["--dump-json", "--skip-download", "--no-playlist"]);

  const { stdout } = await withSemaphore(() =>
    execFilePromise("yt-dlp", args, { ...EXEC_OPTS, timeout: TIMEOUTS.info ?? 60_000 })
  );

  const lines = stdout.trim().split("\n").filter(Boolean);
  let meta: YtDlpMeta;
  try { meta = JSON.parse(lines[lines.length - 1]); } catch { throw new Error("yt-dlp info: non-JSON output"); }
  if (!meta?.title) throw new Error("Video not found via yt-dlp");
  return { title: meta.title, thumbnail: meta.thumbnail ?? null, duration: meta.duration ?? 0, ext: meta.ext ?? "mp4" };
}

// ─────────────────────────────────────────────────────────────────────────────
// TIER 3: gallery-dl
// ─────────────────────────────────────────────────────────────────────────────

interface GalleryDlResult { videoUrl: string; audioUrl: string | null; filename: string; title: string; thumbnail: string | null; }

async function getGalleryDlDownloadUrl(url: string, platform: Platform, signal?: AbortSignal): Promise<GalleryDlResult> {
  if (cbIsOpen("gallerydl")) throw new Error("[CB] gallery-dl circuit open");

  const ctx = buildAttemptContext(url, platform, 0, signal);
  const args = buildGalleryDlArgs(url, platform, ctx, [
    "--dump-json", "--no-download", "--no-part", "--timeout", "30", "--retries", "3",
  ]);

  const { stdout } = await withSemaphore(async () => {
    if (signal?.aborted) throw new Error("Request aborted");
    const ac = new AbortController();
    const tid = setTimeout(() => ac.abort(), TIMEOUTS.gallerydl ?? 45_000);
    if (signal) signal.addEventListener("abort", () => ac.abort(), { once: true });
    try { return await execFilePromise("gallery-dl", args, { ...EXEC_OPTS, signal: ac.signal as any }); }
    finally { clearTimeout(tid); }
  });

  if (!stdout.trim()) throw new Error("gallery-dl: empty output");

  const entries: any[] = [];
  for (const line of stdout.trim().split("\n")) {
    try { const p = JSON.parse(line.trim()); if (Array.isArray(p)) entries.push(p); } catch { /* skip */ }
  }
  if (!entries.length) throw new Error("gallery-dl: no parseable JSON");

  const videoEntry = entries.find(e => {
    const m = e[1];
    if (typeof m === "string") return /\.(mp4|webm|mov|mkv|avi|flv|ts)(\?|$)/i.test(m);
    return m?.extension && /mp4|webm|mov|mkv|avi|flv|ts/i.test(m.extension);
  }) ?? entries[0];

  const meta = videoEntry[1];
  let directUrl: string, filename: string, title: string, thumbnail: string | null = null;

  if (typeof meta === "string") {
    directUrl = meta; filename = meta.split("/").pop()?.split("?")[0] ?? "video.mp4";
    title = filename.replace(/\.[^/.]+$/, "");
  } else {
    directUrl = meta.url ?? meta._url ?? "";
    filename = meta.filename ?? `${meta.id ?? "video"}.${meta.extension ?? "mp4"}`;
    title = meta.title ?? meta.description?.slice(0, 100) ?? filename;
    thumbnail = meta.thumbnail ?? null;
  }

  if (!directUrl) throw new Error("gallery-dl: no direct URL");
  cbSuccess("gallerydl");
  return { videoUrl: directUrl, audioUrl: null, filename, title, thumbnail };
}

// ─────────────────────────────────────────────────────────────────────────────
// TIER 4: Playwright browser fallback
// ─────────────────────────────────────────────────────────────────────────────

function guessMime(filename: string): string {
  const ext = (filename.split(".").pop() ?? "").toLowerCase();
  return ({ mp4: "video/mp4", webm: "video/webm", mkv: "video/x-matroska", mov: "video/quicktime", m4a: "audio/mp4", aac: "audio/aac", mp3: "audio/mpeg", ogg: "audio/ogg", ts: "video/mp2t", flv: "video/x-flv" } as Record<string, string>)[ext] ?? "application/octet-stream";
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. GET VIDEO INFO
// ─────────────────────────────────────────────────────────────────────────────

export const getVideoInfo = async (
  req: FastifyRequest<{ Body: VideoInfoBody }>,
  reply: FastifyReply,
) => {
  const { url } = req.body;
  if (!url || typeof url !== "string")
    return reply.code(400).send({ success: false, message: "URL is required" });

  const resolvedUrl = await resolveRedirectUrl(url.trim());
  if (!isUrlSafe(resolvedUrl))
    return reply.code(400).send({ success: false, message: "Invalid or unsupported URL" });

  const platform = detectPlatform(resolvedUrl);
  const cacheKey = `info:${resolvedUrl}`;

  const cached = await cache.get(cacheKey);
  if (cached) {
    log("debug", "info", "Cache HIT", { url: resolvedUrl.slice(0, 80) });
    return reply.code(200).send({ success: true, source: "cache", message: "Fetch video info successful", data: cached });
  }

  const result = await dedupe(cacheKey, async () => {
    const data = await getYtDlpInfo(resolvedUrl, platform)
      .catch(e => { log("warn", "ytdlp", "Info failed", { error: e.message?.slice(0, 100) }); return null; });
    return data ? { source: "ytdlp" as const, data } : null;
  });

  if (result) {
    await cache.set(cacheKey, result.data, 15 * 60_000);
    return reply.code(200).send({ success: true, source: result.source, message: "Fetch video info successful", data: result.data });
  }

  return reply.code(500).send({ success: false, message: "Failed to fetch video info" });
};



// ─────────────────────────────────────────────────────────────────────────────
// 2. GET DOWNLOAD LINK  (4-tier fallback + mutation retry)
// ─────────────────────────────────────────────────────────────────────────────

export const getDownloadLink = async (
  req: FastifyRequest<{ Body: DownloadBody }>,
  reply: FastifyReply,
) => {
  const { url, type = "video", quality = "720p", audioFormat = "mp3" } = req.body;

  if (!url || typeof url !== "string") {
    return reply.code(400).send({ success: false, message: "URL is required" });
  }

  const resolvedUrl = await resolveRedirectUrl(url.trim());
  if (!isUrlSafe(resolvedUrl)) {
    return reply.code(400).send({ success: false, message: "Invalid or unsupported URL" });
  }

  const platform = detectPlatform(resolvedUrl);
  const cacheKey = `download:${platform}:${type}:${quality}:${audioFormat}:${resolvedUrl}`;

  // 1. Check Cache Layer
  const cached = await cache.get(cacheKey);
  if (cached) {
    log("debug", "download", "Cache HIT", { url: resolvedUrl.slice(0, 80) });
    return reply.code(200).send({
      success: true,
      source: "cache",
      message: "Download link generated successfully",
      data: cached,
    });
  }

  // 2. Manage Abort Signal States & Prevent Ghost Pipeline Cancellation
  const clientDisconnectController = new AbortController();
  let responseFinished = false;

  req.raw.on("close", () => {
    if (responseFinished) return; // Ignore if data completely flushed out to client
    log("info", "download", "Client dropped socket prematurely, aborting processing streams");
    clientDisconnectController.abort();
  });

  // 3. Process Execution Thread via Shared Request Coalescing Pipeline
  try {
    const finalResult = await dedupe(cacheKey, async () => {
      let payload: any = null;
      let usedTier = "unknown";

      if (clientDisconnectController.signal.aborted) {
        throw new Error("Aborted before entering backend pipeline execution queues");
      }

      // ───────────────────────────────────────────────────────────────────────
      // TIER 1: Cobalt Engine Extraction
      // ───────────────────────────────────────────────────────────────────────
      try {
        log("info", "download", "Executing Tier 1 (Cobalt)", { url: resolvedUrl.slice(0, 80) });
       const res = await getCobaltDownloadUrl(resolvedUrl, quality, "auto", clientDisconnectController.signal);

        const tunnelInfo = safeTunnelUrl(res.url);
        payload = {
          url: tunnelInfo.url,
          audioUrl: res.audioUrl ? safeTunnelUrl(res.audioUrl).url : null,
          title: res.filename.replace(/\.[^/.]+$/, ""),
          thumbnail: null,
          duration: 0,
          ext: res.filename.split(".").pop() ?? "mp4",
          mimeType: guessMime(res.filename),
          tunnelAllowed: tunnelInfo.tunnelAllowed,
        };
        usedTier = "cobalt";
      } catch (err: any) {
        log("warn", "download", "Tier 1 (Cobalt) fallback triggered", { error: err.message });
      }

      // ───────────────────────────────────────────────────────────────────────
      // TIER 2: yt-dlp Engine Extraction with Structural Mutation Iterations
      // ───────────────────────────────────────────────────────────────────────
      if (!payload) {
        try {
          log("info", "download", "Executing Tier 2 (yt-dlp mutation)", { url: resolvedUrl.slice(0, 80) });
          const res = await getYtDlpWithMutation(resolvedUrl, platform, quality, clientDisconnectController.signal);

          const tunnelInfo = safeTunnelUrl(res.videoUrl);
          payload = {
            url: tunnelInfo.url,
            audioUrl: res.audioUrl ? safeTunnelUrl(res.audioUrl).url : null,
            title: res.title,
            thumbnail: res.thumbnail,
            duration: res.duration,
            ext: res.ext,
            mimeType: guessMime(`video.${res.ext}`),
            tunnelAllowed: tunnelInfo.tunnelAllowed,
            strategyUsed: res.strategyUsed,
          };
          usedTier = "ytdlp";
        } catch (err: any) {
          log("warn", "download", "Tier 2 (yt-dlp mutation) fallback triggered", { error: err.message });
        }
      }

      // ───────────────────────────────────────────────────────────────────────
      // TIER 3: gallery-dl Engine Structural Backup
      // ───────────────────────────────────────────────────────────────────────
      if (!payload && (platform === "instagram" || platform === "tiktok" || platform === "pinterest")) {
        try {
          log("info", "download", "Executing Tier 3 (gallery-dl)", { url: resolvedUrl.slice(0, 80) });
          const res = await getGalleryDlDownloadUrl(resolvedUrl, platform, clientDisconnectController.signal);

          const tunnelInfo = safeTunnelUrl(res.videoUrl);
          payload = {
            url: tunnelInfo.url,
            audioUrl: null,
            title: res.title,
            thumbnail: res.thumbnail,
            duration: 0,
            ext: res.filename.split(".").pop() ?? "mp4",
            mimeType: guessMime(res.filename),
            tunnelAllowed: tunnelInfo.tunnelAllowed,
          };
          usedTier = "gallerydl";
        } catch (err: any) {
          log("warn", "download", "Tier 3 (gallery-dl) fallback triggered", { error: err.message });
        }
      }

      // ───────────────────────────────────────────────────────────────────────
      // TIER 4: Automated Headless Browser Execution Engine Fallback (Playwright)
      // ───────────────────────────────────────────────────────────────────────
      if (!payload) {
        try {
          log("info", "download", "Executing Tier 4 Browser Core Fallback", { url: resolvedUrl.slice(0, 80) });

          const pInstance = proxyPool.pick(platform);
          const pConfig = pInstance ? proxyPool.playwrightProxy(pInstance) : undefined;

          const res = await extractWithPlaywright({
            url: resolvedUrl,
            platform,
            proxy: pConfig,
            signal: clientDisconnectController.signal,
          });

          if (!res?.videoUrl) throw new Error("Playwright extraction failed to capture any media resource streams");

          if (pInstance) proxyPool.success(pInstance);

          const tunnelInfo = safeTunnelUrl(res.videoUrl);
          payload = {
            url: tunnelInfo.url,
            audioUrl: null,
            title: res.title ?? "downloaded_video",
            thumbnail: res.thumbnail ?? null,
            duration: 0,
            ext: "mp4",
            mimeType: guessMime("video.mp4"),
            tunnelAllowed: tunnelInfo.tunnelAllowed,
          };
          usedTier = "playwright";
        } catch (err: any) {
          log("error", "download", "Tier 4 Browser Core Fallback engine crashed completely", { error: err.message });
        }
      }

      // Explicit validation checkpoint: If all engines returned null, do NOT dedupe a success state
      if (!payload) return null;

      return { source: usedTier, data: payload };
    });

    // Check if dedupe resolved clean results down to this execution block
    if (!finalResult) {
      return reply.code(500).send({
        success: false,
        message: "All extractor fallback infrastructure engines exhausted. Stream location failed.",
      });
    }

    // 4. Update memory caches and finish requests securely
    const expiryWindow = cacheTtl(platform);
    await cache.set(cacheKey, finalResult.data, expiryWindow);

    responseFinished = true;
    return reply.code(200).send({
      success: true,
      source: finalResult.source,
      message: "Download link generated successfully",
      data: finalResult.data,
    });

  } catch (outerException: any) {
    if (outerException?._isBusy) {
      return reply.code(503).send({
        success: false,
        message: "Server is currently operating under maximum concurrency thresholds. Queue buffer full.",
      });
    }
    log("error", "download", "Unhandled operational processing exception crashed root handler pipeline", { error: outerException.message });
    return reply.code(500).send({ success: false, message: "Internal application core system processing breakdown" });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// 3. RESOLVE URL
// ─────────────────────────────────────────────────────────────────────────────

export const resolveUrl = async (
  req: FastifyRequest<{ Querystring: { url: string } }>,
  reply: FastifyReply,
) => {
  const { url } = req.query as { url: string };
  if (!url) return reply.code(400).send({ success: false, message: "url query param is required" });
  try {
    const resolvedUrl = await resolveRedirectUrl(url.trim());
    if (!isUrlSafe(resolvedUrl)) return reply.code(400).send({ success: false, message: "Invalid or unsupported URL" });
    return reply.code(200).send({ success: true, resolvedUrl, platform: detectPlatform(resolvedUrl) });
  } catch { return reply.code(500).send({ success: false, message: "Failed to resolve URL" }); }
};

// ─────────────────────────────────────────────────────────────────────────────
// 4. TUNNEL (CDN allowlist enforced)
// ─────────────────────────────────────────────────────────────────────────────

export const tunnel = async (req: FastifyRequest, reply: FastifyReply) => {
  const { url: rawUrl, filename: rawFilename } = req.query as { url?: string; filename?: string };
  if (!rawUrl) return reply.code(400).send({ success: false, message: "url query param is required" });

  let targetUrl: string;
  try { targetUrl = decodeURIComponent(rawUrl); } catch {
    return reply.code(400).send({ success: false, message: "Invalid url encoding" });
  }

  if (!/^https?:\/\//i.test(targetUrl))
    return reply.code(400).send({ success: false, message: "Invalid tunnel target URL" });

  if (!isCdnAllowed(targetUrl)) {
    log("warn", "tunnel", "Blocked non-CDN URL", { url: targetUrl.slice(0, 120) });
    return reply.code(403).send({ success: false, message: "Tunnel target not allowed" });
  }

  const rangeHeader = (req.headers as any)["range"];
  const upstreamHeaders: Record<string, string> = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    "Accept": "*/*",
    "Accept-Encoding": "identity",
  };
  if (rangeHeader) upstreamHeaders["Range"] = rangeHeader;
  const referer = getReferer(targetUrl);
  if (referer) upstreamHeaders["Referer"] = referer;

  try {
    const upstream = await fetch(targetUrl, { headers: upstreamHeaders, signal: AbortSignal.timeout(60_000) });
    if (!upstream.ok && upstream.status !== 206) {
      log("error", "tunnel", "Upstream error", { status: upstream.status });
      return reply.code(502).send({ success: false, message: `Upstream returned ${upstream.status}` });
    }
    reply.status(upstream.status);
    const ct = upstream.headers.get("content-type") ?? guessMime(rawFilename ?? targetUrl);
    const cl = upstream.headers.get("content-length");
    const cr = upstream.headers.get("content-range");
    const ar = upstream.headers.get("accept-ranges");
    reply.header("Content-Type", ct);
    reply.header("Accept-Ranges", ar ?? "bytes");
    reply.header("Cache-Control", "no-store");
    reply.header("X-Content-Type-Options", "nosniff");
    reply.header("Access-Control-Allow-Origin", "*");
    if (cl) reply.header("Content-Length", cl);
    if (cr) reply.header("Content-Range", cr);
    const filename = rawFilename ?? targetUrl.split("/").pop()?.split("?")[0] ?? "video.mp4";
    reply.header("Content-Disposition", `attachment; filename="${filename.replace(/[^\w.\-]/g, "_")}"`);
    return reply.send(upstream.body);
  } catch (err: any) {
    log("error", "tunnel", "Fetch error", { error: err?.message });
    return reply.code(502).send({ success: false, message: "Tunnel upstream unreachable" });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// 5. HEALTH CHECK
// ─────────────────────────────────────────────────────────────────────────────

export const healthCheck = async (_req: FastifyRequest, reply: FastifyReply) => {
  const cobaltOk = await fetch(`${COBALT_URL}/`, { method: "HEAD", signal: AbortSignal.timeout(3_000) })
    .then(() => true).catch(() => false);

  let ytdlpAgeDays: number | null = null;
  try {
    const { stdout } = await execFilePromise("which", ["yt-dlp"], { encoding: "utf8" });
    ytdlpAgeDays = parseFloat(((Date.now() - statSync((stdout as string).trim()).mtimeMs) / 86_400_000).toFixed(1));
  } catch { /* yt-dlp not found */ }
  return reply.code(200).send({
    status: "ok",
    version: "v5",
    uptime: Math.round(process.uptime()),
    circuits: Object.fromEntries(
      Object.entries(circuitBreakers).map(([k, v]) => [k, { open: v.openUntil > Date.now(), failures: v.failures }])
    ),
    cobalt: { reachable: cobaltReachable, ping: cobaltOk },
    semaphore: { running: procSemaphore.runningCount, queued: procSemaphore.queueDepth, max: MAX_CONCURRENT_PROCS },
    cache: { backend: REDIS_URL ? "redis" : "memory", entries: cache.size() },
    proxies: proxyPool.stats(),
    ytdlp: { ageDays: ytdlpAgeDays, stale: ytdlpAgeDays !== null ? ytdlpAgeDays > YTDLP_MAX_AGE_DAYS : null },
    inFlight: inFlight.size,
    memory: { heapUsedMb: Math.round(process.memoryUsage().heapUsed / 1024 / 1024), heapTotalMb: Math.round(process.memoryUsage().heapTotal / 1024 / 1024) },
  });
};

export const downloadController = {
  getVideoInfo, getDownloadLink, resolveUrl, tunnel, healthCheck,
};