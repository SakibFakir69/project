/**
 * download.controller.ts — v7.1 (Tunnel-First + 100MB Limit)
 * - Removed VidBee
 * - Enforced 100MB max file size across all download paths
 * - Tunnel handles internal Cobalt routing for short-lived URLs
 */

import { execFile } from "node:child_process";
import { statSync } from "node:fs";
import { promisify } from "node:util";
import type { FastifyRequest, FastifyReply } from "fastify";
import { spawn } from "node:child_process";
import { createWriteStream, unlinkSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";

import { isUrlSafe } from "../../utils/download.utils.js";
import { getReferer, TIMEOUTS } from "../../constant/index.contant.js";
import type { VideoQuality, DownloadType, AudioFormat } from "../../types/index.js";
import { proxyPool } from "../../Proxy/Proxy.pool.js";
import { cookieManager } from "../../cookies/Cookie.manager.js";
import { identityManager } from "../../manager/Identity.manager.js";
import { getAdapter } from "../../index/index.adapter.js";
import { scheduleDaily } from "../../cron/Updater.cron.js";
import type { AttemptContext } from "../../adapter/Base.adapter.js";

// ── Config ────────────────────────────────────────────────────────────────────

const TUNNEL_BASE_URL = process.env.API_URL ?? "https://downtubebest.duckdns.org";
const COBALT_URL = process.env.COBALT_URL ?? "http://cobalt-api:9000";
const REDIS_URL = process.env.REDIS_URL ?? "";
const NODE_ENV = process.env.NODE_ENV ?? "production";
const IS_DEV = NODE_ENV === "development";

const YTDLP_MAX_AGE_DAYS = parseInt(process.env.YTDLP_MAX_AGE_DAYS ?? "7", 10);
const MAX_FILE_SIZE_BYTES = 100 * 1024 * 1024; // ✅ 100 MB Limit

const execFilePromise = promisify(execFile);

const EXEC_OPTS = {
  killSignal: "SIGKILL" as const,
  maxBuffer: 8 * 1024 * 1024,
};

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
  filesize?: number;
  filesize_approx?: number;
}

// ── Structured JSON logger ────────────────────────────────────────────────────

type LogLevel = "info" | "warn" | "error" | "debug";

function log(level: LogLevel, service: string, msg: string, extra?: Record<string, any>) {
  const entry = { ts: new Date().toISOString(), level, service, msg, ...extra };
  if (level === "error") process.stderr.write(JSON.stringify(entry) + "\n");
  else process.stdout.write(JSON.stringify(entry) + "\n");
}

// ── Cache ─────────────────────────────────────────────────────────────────────

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

const PLATFORM_TTL_MS: Record<string, number> = {
  youtube: 6 * 60 * 60_000,
  vimeo: 4 * 60 * 60_000,
  reddit: 2 * 60 * 60_000,
  twitter: 1 * 60 * 60_000,
  tiktok: 10 * 60_000,
  instagram: 45 * 60_000,
  facebook: 30 * 60_000,
  generic: 60 * 60_000,
};

function cacheTtl(platform: string): number {
  return PLATFORM_TTL_MS[platform] ?? 60 * 60_000;
}

// ── yt-dlp freshness check ────────────────────────────────────────────────────

async function checkYtDlpFreshness(): Promise<void> {
  try {
    const { stdout } = await execFilePromise("which", ["yt-dlp"], { encoding: "utf8" });
    const { mtimeMs } = statSync((stdout as string).trim());
    const ageDays = (Date.now() - mtimeMs) / 86_400_000;
    if (ageDays > YTDLP_MAX_AGE_DAYS)
      log("warn", "ytdlp", `Binary is ${ageDays.toFixed(1)} days old`, { ageDays });
    else
      log("info", "ytdlp", `Binary is fresh (${ageDays.toFixed(1)} days old)`);
  } catch (err: any) {
    log("warn", "ytdlp", "Could not check binary age", { error: err?.message });
  }
}

checkYtDlpFreshness();
setInterval(checkYtDlpFreshness, 12 * 60 * 60_000);

// ── CDN allowlist ─────────────────────────────────────────────────────────────

const CDN_ALLOWLIST = [
  /googlevideo\.com$/i,
  /youtube\.com\/videoplayback/i,
  /tiktokcdn\.com$/i,
  /tiktokcdn-us\.com$/i,
  /tiktok\.com\/aweme\/v\d+\/play/i,
  /\.tiktok\.com$/i,
  /fbcdn\.net$/i,
  /cdninstagram\.com$/i,
  /twimg\.com$/i,
  /video\.twimg\.com$/i,
  /redditmedia\.com$/i,
  /reddituploads\.com$/i,
  /vimeocdn\.com$/i,
  /clips-media-assets2\.twitch\.tv$/i,
  /vod-secure\.twitch\.tv$/i,
];

function isCdnAllowed(url: string): boolean {
  try {
    const { hostname, href } = new URL(url);
    return CDN_ALLOWLIST.some(p => p.test(hostname) || p.test(href));
  } catch { return false; }
}

// ── Direct URL priority + Tunnel Fallback ─────────────────────────────────────

interface PreparedUrls {
  directUrl: string;
  tunnelUrl: string | null;
  tunnelAllowed: boolean;
}

function prepareCobaltTunnelUrl(rawUrl: string): string | null {
  if (!rawUrl || !rawUrl.includes('/tunnel?id=')) return null;
  try {
    const url = new URL(rawUrl, TUNNEL_BASE_URL);
    return `${TUNNEL_BASE_URL}/tunnel${url.search}`;
  } catch {
    return null;
  }
}

function prepareUrls(raw: string): PreparedUrls {
  if (!raw) return { directUrl: "", tunnelUrl: null, tunnelAllowed: false };

  const cobaltTunnel = prepareCobaltTunnelUrl(raw);
  if (cobaltTunnel) {
    return {
      directUrl: cobaltTunnel,
      tunnelUrl: cobaltTunnel,
      tunnelAllowed: true,
    };
  }

  const isAllowed = isCdnAllowed(raw);

  return {
    directUrl: raw,
    tunnelUrl: isAllowed ? `${TUNNEL_BASE_URL}/tunnel?url=${encodeURIComponent(raw)}` : null,
    tunnelAllowed: isAllowed,
  };
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
  if (s.includes("exceeds") || s.includes("too large"))
    return { message: "File size exceeds the 100 MB limit", retryable: false, statusCode: 413, category: "size_limit" };
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

// ── In-flight deduplication ───────────────────────────────────────────────────

const inFlight = new Map<string, Promise<any>>();

function dedupe<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const existing = inFlight.get(key);
  if (existing) {
    log("debug", "dedupe", "Coalescing request", { key: key.slice(0, 80) });
    return existing;
  }
  const p = fn()
    .then(res => {
      if (res && typeof res === "object" && "_error" in res) inFlight.delete(key);
      return res;
    })
    .catch(err => { inFlight.delete(key); throw err; })
    .finally(() => inFlight.delete(key));
  inFlight.set(key, p);
  return p;
}

// ── Short URL resolver ────────────────────────────────────────────────────────

async function resolveRedirectUrl(url: string): Promise<string> {
  const isShort = /vt\.tiktok|vm\.tiktok|pin\.it|fb\.watch|redd\.it|youtu\.be|t\.co/i.test(url);
  if (!isShort && !url.includes('/share/')) return url;

  try {
    const res = await fetch(url, {
      method: "GET",
      redirect: "follow",
      signal: AbortSignal.timeout(8_000),
      headers: {
        "User-Agent": "Mozilla/5.0 (Linux; Android 10; SM-G975F) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36",
      },
    });

    res.body?.cancel();

    const resolved = res.url || url;
    if (resolved !== url)
      log("debug", "resolver", "Resolved redirect", { from: url.slice(0, 80), to: resolved.slice(0, 120) });

    return resolved;
  } catch {
    return url;
  }
}

// ── Attempt context builder ───────────────────────────────────────────────────

function buildAttemptContext(
  url: string,
  platform: Platform,
  attemptIndex: number,
  signal?: AbortSignal,
): AttemptContext {
  const proxy = proxyPool.pickByIndex(attemptIndex, platform);
  const cookie = cookieManager.byIndex(platform as any, attemptIndex);
  const identity = identityManager.forAttempt(attemptIndex);
  return { attemptIndex, proxy, cookiePath: cookie, identity, signal };
}

// ── yt-dlp arg builder ────────────────────────────────────────────────────────

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
    "--add-header", `User-Agent:${ctx.identity.userAgent}`,
    "--hls-prefer-native",
    "--merge-output-format", "mp4",
    ...identityManager.ytdlpHeaderArgs(ctx.identity),
    ...proxyPool.ytdlpArgs(ctx.proxy),
    ...adapter.ytdlpPlatformArgs(ctx),
    ...(referer ? ["--add-header", `Referer:${referer}`] : []),
    ...extra,
    url,
  ];

  if (ctx.cookiePath && !args.includes("--cookies")) {
    const targetUrl = args.pop();
    args.push("--cookies", ctx.cookiePath, targetUrl!);
  }
  return args;
}

// ── gallery-dl arg builder ────────────────────────────────────────────────────

function buildGalleryDlArgs(
  url: string,
  platform: Platform,
  ctx: AttemptContext,
  extra: string[],
): string[] {
  const adapter = getAdapter(platform);
  const proxyStr = ctx.proxy?.url ?? null;
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

interface CobaltApiResponse {
  status?: "tunnel" | "redirect" | "picker" | "error" | "local-processing";
  url?: string;
  filename?: string;
  audio?: string;
  audioFilename?: string;
  picker?: Array<{ type: string; url: string; thumb?: string }>;
  tunnel?: string[];
  output?: { filename: string; type: string; metadata?: Record<string, string> };
  error?: { code: string; context?: { service?: string; limit?: number } };
}

interface CobaltResult {
  url: string; audioUrl: string | null; filename: string; type: string;
}

async function getCobaltDownloadUrl(
  resolvedUrl: string,
  quality: string = "1080",
  platform: Platform,
  downloadMode: "auto" | "audio" | "mute" = "auto",
  signal?: AbortSignal,
): Promise<CobaltResult> {

  if (!cobaltReachable) throw new Error("[Cobalt] Unreachable");
  if (cbIsOpen("cobalt")) throw new Error("[CB] Cobalt circuit open");

  try { resolvedUrl = decodeURIComponent(resolvedUrl).trim(); } catch { }
  if (!/^https?:\/\//i.test(resolvedUrl)) throw new Error("Invalid URL");

  const q = quality.replace("p", "").trim();
  const validQ = ["max", "4320", "2160", "1440", "1080", "720", "480", "360", "240", "144"];
  const videoQuality = validQ.includes(q) ? q : "1080";
  const isTikTok = platform === "tiktok";
  const isYouTube = platform === "youtube";

  const cobaltProxy = proxyPool.pick(platform) ?? proxyPool.pick();
  const timeoutSignal = AbortSignal.timeout(25_000);
  const fetchSignal = signal ? AbortSignal.any([timeoutSignal, signal]) : timeoutSignal;

  const body: Record<string, any> = {
    url: resolvedUrl,
    videoQuality,
    downloadMode,
    filenameStyle: "basic",
    audioFormat: "mp3",
    audioBitrate: "128",
    youtubeVideoCodec: "h264",
    tiktokFullAudio: isTikTok && downloadMode === "audio",
    ...(isYouTube && {
      youtubeHLS: false,
      allowH265: false,
    }),
  };

  // Force alwaysProxy for platforms with short-lived CDN URLs
  if (
    process.env.COBALT_PROXY_ENABLED === "true" ||
    isTikTok ||
    platform === "instagram" ||
    platform === "facebook"
  ) {
    body.alwaysProxy = true;
  }

  const response = await fetch(`${COBALT_URL}/`, {
    method: "POST",
    signal: fetchSignal,
    headers: {
      "Content-Type": "application/json",
      "Accept": "application/json",
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    let err: any = null;
    try { err = await response.json(); } catch { err = await response.text(); }

    log("warn", "cobalt", "request_failed", {
      status: response.status,
      error: err,
      platform,
      url: resolvedUrl.slice(0, 80),
      body: JSON.stringify(body).slice(0, 200),
    });

    if (cobaltProxy) proxyPool.failure(cobaltProxy, platform, response.status === 429);
    if (response.status === 429 || response.status >= 500) cbFailure("cobalt");

    throw new Error(`Cobalt ${response.status}: ${err?.error?.code || err || "unknown_error"}`);
  }

  if (cobaltProxy) proxyPool.success(cobaltProxy);

  const data: CobaltApiResponse = await response.json();

  switch (data.status) {
    case "tunnel":
    case "redirect":
      cbSuccess("cobalt");
      return {
        url: data.url!,
        audioUrl: null,
        filename: data.filename ?? "video.mp4",
        type: data.status,
      };

    case "local-processing":
      cbSuccess("cobalt");
      return {
        url: data.tunnel?.[0] ?? "",
        audioUrl: data.tunnel?.[1] ?? null,
        filename: data.output?.filename ?? "video.mp4",
        type: "local-processing",
      };

    case "picker": {
      cbSuccess("cobalt");

      const bestVideo =
        data.picker?.find(p => p.type === "video" && p.url) ??
        data.picker?.find(p => p.url) ??
        data.picker?.[0];

      if (!bestVideo?.url) {
        cbFailure("cobalt");
        throw new Error("Cobalt picker: no valid video URL found");
      }

      return {
        url: bestVideo.url,
        audioUrl: (data as any).audio ?? null,
        filename: (data as any).audioFilename ?? "video.mp4",
        type: "picker",
      };
    }

    case "error":
      cbFailure("cobalt");
      throw new Error(`Cobalt error: ${data.error?.code}`);

    default:
      cbFailure("cobalt");
      throw new Error(`Unknown Cobalt status: ${data.status}`);
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

  for (let attempt = 0; attempt < adapter.maxAttempts; attempt++) {
    const ctx = buildAttemptContext(url, platform, attempt, signal);
    const strategy = strategies[attempt % strategies.length];

    log("info", "ytdlp", `Attempt ${attempt + 1}/${adapter.maxAttempts}`, {
      client: ctx.identity.clientName,
      proxy: ctx.proxy ? ctx.proxy.url.replace(/:[^@]+@/, ":***@") : "none",
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

      // ✅ Check filesize metadata from yt-dlp
      const fileSize = meta.filesize ?? meta.filesize_approx ?? 0;
      if (fileSize > 0 && fileSize > MAX_FILE_SIZE_BYTES) {
        throw new Error("File size exceeds the 100 MB limit");
      }

      if (ctx.proxy) proxyPool.success(ctx.proxy);
      if (ctx.cookiePath) cookieManager.markSuccess(platform as any, ctx.cookiePath);

      cbSuccess("ytdlp");
      log("info", "ytdlp", `Success on attempt ${attempt + 1}`, { strategy: attempt });
      return {
        videoUrl, audioUrl,
        title: meta.title ?? "video",
        thumbnail: meta.thumbnail ?? null,
        duration: meta.duration ?? 0,
        ext: meta.ext ?? "mp4",
        strategyUsed: attempt,
      };

    } catch (err: any) {
      lastErr = err;
      const c = classifyError(err?.stderr ?? err?.message ?? "");

      if (ctx.proxy) proxyPool.failure(ctx.proxy, platform, c.category === "rate_limit");
      if (ctx.cookiePath) cookieManager.markFailed(platform as any, ctx.cookiePath);

      log("warn", "ytdlp", `Attempt ${attempt + 1} failed`, {
        category: c.category,
        error: err?.message?.slice(0, 100),
      });

      if (c.category === "rate_limit" || c.category === "network" || c.statusCode >= 500)
        cbFailure("ytdlp");

      if (!c.retryable) break;

      if (attempt < adapter.maxAttempts - 1)
        await new Promise(r => setTimeout(r, 800 * (attempt + 1)));
    }
  }

  throw lastErr;
}

async function getYtDlpInfo(
  url: string,
  platform: Platform,
): Promise<{ title: string; thumbnail: string | null; duration: number; ext: string }> {
  const ctx = buildAttemptContext(url, platform, 0);
  const args = buildYtDlpArgs(url, platform, ctx, ["--dump-json", "--skip-download", "--no-playlist"]);

  const { stdout } = await withSemaphore(() =>
    execFilePromise("yt-dlp", args, { ...EXEC_OPTS, timeout: TIMEOUTS.info ?? 60_000 })
  );

  const lines = stdout.trim().split("\n").filter(Boolean);
  let meta: YtDlpMeta;
  try { meta = JSON.parse(lines[lines.length - 1]); }
  catch { throw new Error("yt-dlp info: non-JSON output"); }
  if (!meta?.title) throw new Error("Video not found via yt-dlp");
  return { title: meta.title, thumbnail: meta.thumbnail ?? null, duration: meta.duration ?? 0, ext: meta.ext ?? "mp4" };
}

// ─────────────────────────────────────────────────────────────────────────────
// TIER 3: gallery-dl
// ─────────────────────────────────────────────────────────────────────────────

interface GalleryDlResult {
  videoUrl: string; audioUrl: string | null;
  filename: string; title: string; thumbnail: string | null;
}

async function getGalleryDlDownloadUrl(
  url: string,
  platform: Platform,
  signal?: AbortSignal,
): Promise<GalleryDlResult> {
  if (cbIsOpen("gallerydl")) throw new Error("[CB] gallery-dl circuit open");

  const ctx = buildAttemptContext(url, platform, 0, signal);

  const args = buildGalleryDlArgs(url, platform, ctx, [
    "--dump-json", "--no-download", "--no-part", "--retries", "3",
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
    directUrl = meta;
    filename = meta.split("/").pop()?.split("?")[0] ?? "video.mp4";
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

// ── Mime helper ───────────────────────────────────────────────────────────────

function guessMime(filename: string): string {
  const ext = (filename.split(".").pop() ?? "").toLowerCase();
  return ({
    mp4: "video/mp4", webm: "video/webm", mkv: "video/x-matroska",
    mov: "video/quicktime", m4a: "audio/mp4", aac: "audio/aac",
    mp3: "audio/mpeg", ogg: "audio/ogg", ts: "video/mp2t", flv: "video/x-flv",
  } as Record<string, string>)[ext] ?? "application/octet-stream";
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

    if (cobaltReachable) {
      try {
        log("info", "info", "Tier 1 (Cobalt) info", { url: resolvedUrl.slice(0, 80) });
        const res = await getCobaltDownloadUrl(resolvedUrl, "720", platform, "auto");
        if (res?.url) {
          return {
            source: "cobalt" as const,
            data: {
              title: res.filename?.replace(/\.[^/.]+$/, "") ?? `Video from ${platform}`,
              thumbnail: null,
              duration: 0,
              ext: res.filename?.split(".").pop() ?? "mp4",
            },
          };
        }
      } catch (e: any) {
        log("warn", "info", "Tier 1 (Cobalt) info failed", { error: e.message?.slice(0, 100) });
      }
    }

    try {
      log("info", "info", "Tier 2 (yt-dlp) info", { url: resolvedUrl.slice(0, 80) });
      const data = await getYtDlpInfo(resolvedUrl, platform);
      if (data) return { source: "ytdlp" as const, data };
    } catch (e: any) {
      log("warn", "info", "Tier 2 (yt-dlp) info failed", { error: e.message?.slice(0, 100) });
    }

    try {
      log("info", "info", "Tier 3 (yt-dlp mutation) info", { url: resolvedUrl.slice(0, 80) });
      const res = await getYtDlpWithMutation(resolvedUrl, platform, "720");
      if (res) {
        return {
          source: "ytdlp" as const,
          data: {
            title: res.title,
            thumbnail: res.thumbnail,
            duration: res.duration,
            ext: res.ext,
          },
        };
      }
    } catch (e: any) {
      log("warn", "info", "Tier 3 (yt-dlp mutation) info failed", { error: e.message?.slice(0, 100) });
    }

    return null;
  });

  if (result) {
    await cache.set(cacheKey, result.data, 15 * 60_000);
    return reply.code(200).send({
      success: true,
      source: result.source,
      message: "Fetch video info successful",
      data: result.data,
    });
  }

  log("warn", "info", "All info tiers failed — returning soft fail", { url: resolvedUrl.slice(0, 80) });
  return reply.code(200).send({
    success: true,
    source: "unknown",
    message: "Info unavailable, but download might work",
    data: {
      title: `Video from ${platform}`,
      thumbnail: null,
      duration: 0,
      ext: "mp4",
    },
  });
};

// ─────────────────────────────────────────────────────────────────────────────
// 2. GET DOWNLOAD LINK
// ─────────────────────────────────────────────────────────────────────────────

export const getDownloadLink = async (
  req: FastifyRequest<{ Body: DownloadBody }>,
  reply: FastifyReply,
) => {
  const { url, type = "video", quality = "720p", audioFormat = "mp3" } = req.body;

  if (!url || typeof url !== "string")
    return reply.code(400).send({ success: false, message: "URL is required" });

  const resolvedUrl = await resolveRedirectUrl(url.trim());
  if (!isUrlSafe(resolvedUrl))
    return reply.code(400).send({ success: false, message: "Invalid or unsupported URL" });

  const platform = detectPlatform(resolvedUrl);
  const cacheKey = `download:${platform}:${type}:${quality}:${audioFormat}:${resolvedUrl}`;

  const cached = await cache.get(cacheKey);
  if (cached) {
    log("debug", "download", "Cache HIT", { url: resolvedUrl.slice(0, 80) });
    return reply.code(200).send({ success: true, source: "cache", message: "Download link generated successfully", data: cached });
  }

  const clientDisconnectController = new AbortController();
  let responseFinished = false;

  req.raw.on("close", () => {
    if (responseFinished) return;
    log("info", "download", "Client disconnected — aborting pipeline");
    clientDisconnectController.abort();
  });

  try {
    const finalResult = await dedupe(cacheKey, async () => {
      let payload: any = null;
      let usedTier: string = "unknown";

      if (clientDisconnectController.signal.aborted)
        throw new Error("Aborted before pipeline start");

      const adapter = getAdapter(platform);

      // TIER 1: COBALT
      if (adapter.useCobalt) {
        try {
          log("info", "download", "Tier 1 (Cobalt)", { url: resolvedUrl.slice(0, 80) });
          const res = await getCobaltDownloadUrl(
            resolvedUrl, quality, platform, "auto", clientDisconnectController.signal,
          );
          const urls = prepareUrls(res.url);
          payload = {
            url: urls.directUrl,
            tunnelUrl: urls.tunnelUrl,
            audioUrl: res.audioUrl ? prepareUrls(res.audioUrl).directUrl : null,
            audioTunnelUrl: res.audioUrl ? prepareUrls(res.audioUrl).tunnelUrl : null,
            title: res.filename.replace(/\.[^/.]+$/, ""),
            thumbnail: null,
            duration: 0,
            ext: res.filename.split(".").pop() ?? "mp4",
            mimeType: guessMime(res.filename),
            tunnelAllowed: urls.tunnelAllowed,
          };
          usedTier = "cobalt";
        } catch (err: any) {
          log("warn", "download", "Tier 1 (Cobalt) failed", { error: err.message });
        }
      }

      // TIER 2: YT-DLP
      if (!payload) {
        try {
          log("info", "download", "Tier 2 (yt-dlp)", { url: resolvedUrl.slice(0, 80) });
          const res = await getYtDlpWithMutation(
            resolvedUrl, platform, quality, clientDisconnectController.signal,
          );
          const urls = prepareUrls(res.videoUrl);
          payload = {
            url: urls.directUrl,
            tunnelUrl: urls.tunnelUrl,
            audioUrl: res.audioUrl ? prepareUrls(res.audioUrl).directUrl : null,
            audioTunnelUrl: res.audioUrl ? prepareUrls(res.audioUrl).tunnelUrl : null,
            title: res.title,
            thumbnail: res.thumbnail,
            duration: res.duration,
            ext: res.ext,
            mimeType: guessMime(`video.${res.ext}`),
            tunnelAllowed: urls.tunnelAllowed,
            strategyUsed: res.strategyUsed,
          };
          usedTier = "ytdlp";
        } catch (err: any) {
          log("warn", "download", "Tier 2 (yt-dlp) failed", { error: err.message });
          if (err?.message?.includes("100 MB limit")) {
            return reply.code(413).send({ success: false, message: err.message });
          }
        }
      }

      // TIER 3: GALLERY-DL
      if (!payload && adapter.useGalleryDl) {
        try {
          log("info", "download", "Tier 3 (gallery-dl)", { url: resolvedUrl.slice(0, 80) });
          const res = await getGalleryDlDownloadUrl(
            resolvedUrl, platform, clientDisconnectController.signal,
          );
          const urls = prepareUrls(res.videoUrl);
          payload = {
            url: urls.directUrl,
            tunnelUrl: urls.tunnelUrl,
            audioUrl: null,
            audioTunnelUrl: null,
            title: res.title,
            thumbnail: res.thumbnail,
            duration: 0,
            ext: res.filename.split(".").pop() ?? "mp4",
            mimeType: guessMime(res.filename),
            tunnelAllowed: urls.tunnelAllowed,
          };
          usedTier = "gallerydl";
        } catch (err: any) {
          log("warn", "download", "Tier 3 (gallery-dl) failed", { error: err.message });
        }
      }

      if (!payload) return null;
      return { source: usedTier, data: payload };
    });

    if (!finalResult)
      return reply.code(500).send({ success: false, message: "All extractors exhausted." });

    const isCobaltTunnel =
      finalResult.source === 'cobalt' &&
      finalResult.data.url?.includes('/tunnel?id=');

    if (!isCobaltTunnel) {
      await cache.set(cacheKey, finalResult.data, cacheTtl(platform));
    } else {
      log('debug', 'download', 'Skipping cache — Cobalt tunnel URL expires in ~90s');
    }

    responseFinished = true;
    return reply.code(200).send({
      success: true,
      source: finalResult.source,
      message: "Download link generated successfully",
      data: finalResult.data,
    });

  } catch (outerException: any) {
    if (outerException?._isBusy)
      return reply.code(503).send({ success: false, message: "Server busy — queue full." });
    log("error", "download", "Unhandled exception", { error: outerException.message });
    return reply.code(500).send({ success: false, message: "Internal server error" });
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
    if (!isUrlSafe(resolvedUrl))
      return reply.code(400).send({ success: false, message: "Invalid or unsupported URL" });
    return reply.code(200).send({ success: true, resolvedUrl, platform: detectPlatform(resolvedUrl) });
  } catch {
    return reply.code(500).send({ success: false, message: "Failed to resolve URL" });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// 4. TUNNEL (Handles External CDNs + Internal Cobalt routing)
// ─────────────────────────────────────────────────────────────────────────────

export const tunnel = async (req: FastifyRequest, reply: FastifyReply) => {
  const { url: rawUrl, filename: rawFilename, id: tunnelId } = req.query as { url?: string; filename?: string; id?: string };

  if (tunnelId && !rawUrl) {
    try {
      const queryString = req.url.split('?')[1];
      const cobaltTunnelUrl = `${COBALT_URL}/tunnel?${queryString}`;

      const upstream = await fetch(cobaltTunnelUrl, {
        headers: {
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
          "Accept": "*/*",
        },
        signal: AbortSignal.timeout(120_000)
      });

      if (!upstream.ok && upstream.status !== 206) {
        return reply.code(502).send({ success: false, message: `Cobalt tunnel failed: ${upstream.status}` });
      }

      // ✅ Check Cobalt stream size limit
      const contentLength = upstream.headers.get("content-length");
      if (contentLength && parseInt(contentLength, 10) > MAX_FILE_SIZE_BYTES) {
        log("warn", "tunnel", "Cobalt stream exceeds 100MB limit", { size: contentLength });
        upstream.body?.cancel();
        return reply.code(413).send({ success: false, message: "File size exceeds the 100 MB limit." });
      }

      reply.status(upstream.status);
      reply.header("Content-Type", upstream.headers.get("content-type") ?? "video/mp4");
      if (contentLength) reply.header("Content-Length", contentLength);
      reply.header("Content-Range", upstream.headers.get("content-range") ?? "");
      reply.header("Accept-Ranges", "bytes");
      reply.header("Cache-Control", "no-store");
      reply.header("Access-Control-Allow-Origin", "*");

      const filename = rawFilename ?? `video_${tunnelId}.mp4`;
      reply.header("Content-Disposition", `attachment; filename="${filename.replace(/[^\w.\-]/g, "_")}"`);

      return reply.send(upstream.body);
    } catch (err: any) {
      log("error", "tunnel", "Cobalt tunnel fetch error", { error: err?.message });
      return reply.code(502).send({ success: false, message: "Cobalt tunnel upstream unreachable" });
    }
  }

  if (!rawUrl) return reply.code(400).send({ success: false, message: "url query param is required" });

  let targetUrl: string;
  try { targetUrl = decodeURIComponent(rawUrl); } catch {
    return reply.code(400).send({ success: false, message: "Invalid url encoding" });
  }

  if (!/^https?:\/\//i.test(targetUrl))
    return reply.code(400).send({ success: false, message: "Invalid tunnel target URL" });

  const isInternalCobalt = targetUrl.startsWith(COBALT_URL) && targetUrl.includes('/tunnel?id=');

  if (!isCdnAllowed(targetUrl) && !isInternalCobalt) {
    log("warn", "tunnel", "Blocked non-CDN URL", { url: targetUrl.slice(0, 120) });
    return reply.code(403).send({ success: false, message: "Tunnel target not allowed" });
  }

  const rangeHeader = (req.headers as any)["range"];

  // Detect platform from URL
  const isTikTok = targetUrl.includes('tiktok') || targetUrl.includes('tiktokcdn');
  const isInstagram = targetUrl.includes('cdninstagram') || targetUrl.includes('fbcdn');
  const isTwitter = targetUrl.includes('twimg');
  const isYouTube = targetUrl.includes('googlevideo') || targetUrl.includes('youtube');
  const isFacebook = targetUrl.includes('facebook') || targetUrl.includes('fbcdn');

  // Base headers
  const upstreamHeaders: Record<string, string> = {
    "User-Agent": "Mozilla/5.0 (Linux; Android 13; SM-G991B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36",
    "Accept": "video/webm,video/mp4,video/*;q=0.9,*/*;q=0.8",
    "Accept-Encoding": "identity",
    "Accept-Language": "en-US,en;q=0.9",
    "Connection": "keep-alive",
  };

  if (rangeHeader) upstreamHeaders["Range"] = rangeHeader;

  // Platform-specific headers
  if (!isInternalCobalt) {
    if (isTikTok) {
      upstreamHeaders["Referer"] = "https://www.tiktok.com/";
      upstreamHeaders["Origin"] = "https://www.tiktok.com";
      upstreamHeaders["Sec-Fetch-Dest"] = "video";
      upstreamHeaders["Sec-Fetch-Mode"] = "no-cors";
      upstreamHeaders["Sec-Fetch-Site"] = "cross-site";
    } else if (isInstagram) {
      upstreamHeaders["Referer"] = "https://www.instagram.com/";
      upstreamHeaders["Origin"] = "https://www.instagram.com";
      upstreamHeaders["Sec-Fetch-Dest"] = "video";
      upstreamHeaders["Sec-Fetch-Mode"] = "no-cors";
      upstreamHeaders["Sec-Fetch-Site"] = "cross-site";
    } else if (isFacebook) {
      upstreamHeaders["Referer"] = "https://www.facebook.com/";
      upstreamHeaders["Origin"] = "https://www.facebook.com";
      upstreamHeaders["Sec-Fetch-Dest"] = "video";
      upstreamHeaders["Sec-Fetch-Mode"] = "no-cors";
      upstreamHeaders["Sec-Fetch-Site"] = "cross-site";
    } else if (isTwitter) {
      upstreamHeaders["Referer"] = "https://twitter.com/";
      upstreamHeaders["Origin"] = "https://twitter.com";
    } else if (isYouTube) {
      upstreamHeaders["Referer"] = "https://www.youtube.com/";
      upstreamHeaders["Origin"] = "https://www.youtube.com";
    } else {
      const referer = getReferer(targetUrl);
      if (referer) upstreamHeaders["Referer"] = referer;
    }
  }

  try {
    const upstream = await fetch(targetUrl, { headers: upstreamHeaders, signal: AbortSignal.timeout(180_000) });
    if (!upstream.ok && upstream.status !== 206) {
      log("error", "tunnel", "Upstream error", { status: upstream.status, isInternalCobalt });
      return reply.code(502).send({ success: false, message: `Upstream returned ${upstream.status}` });
    }

    // ✅ Check stream size limit
    const contentLength = upstream.headers.get("content-length");
    if (contentLength && parseInt(contentLength, 10) > MAX_FILE_SIZE_BYTES) {
      log("warn", "tunnel", "Direct stream exceeds 100MB limit", { size: contentLength });
      upstream.body?.cancel();
      return reply.code(413).send({ success: false, message: "File size exceeds the 100 MB limit." });
    }

    reply.status(upstream.status);
    const ct = upstream.headers.get("content-type") ?? guessMime(rawFilename ?? targetUrl);
    const cr = upstream.headers.get("content-range");
    const ar = upstream.headers.get("accept-ranges");
    reply.header("Content-Type", ct);
    reply.header("Accept-Ranges", ar ?? "bytes");
    reply.header("Cache-Control", "no-store");
    reply.header("X-Content-Type-Options", "nosniff");
    reply.header("Access-Control-Allow-Origin", "*");
    if (contentLength) reply.header("Content-Length", contentLength);
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
    ytdlpAgeDays = parseFloat(
      ((Date.now() - statSync((stdout as string).trim()).mtimeMs) / 86_400_000).toFixed(1)
    );
  } catch { /* yt-dlp not found */ }

  return reply.code(200).send({
    status: "ok",
    version: "v7.1",
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
    memory: {
      heapUsedMb: Math.round(process.memoryUsage().heapUsed / 1024 / 1024),
      heapTotalMb: Math.round(process.memoryUsage().heapTotal / 1024 / 1024),
    },
  });
};


export const mergeVideoAudio = async (req: FastifyRequest, reply: FastifyReply) => {
  const { videoUrl, audioUrl } = req.query as { videoUrl?: string; audioUrl?: string };

  if (!videoUrl || !audioUrl) {
    return reply.code(400).send({ success: false, message: "videoUrl and audioUrl are required" });
  }

  let decodedVideoUrl: string;
  let decodedAudioUrl: string;

  try {
    decodedVideoUrl = decodeURIComponent(videoUrl);
    decodedAudioUrl = decodeURIComponent(audioUrl);
  } catch {
    return reply.code(400).send({ success: false, message: "Invalid URL encoding" });
  }

  // Validate both are CDN-allowed
  if (!isCdnAllowed(decodedVideoUrl) || !isCdnAllowed(decodedAudioUrl)) {
    return reply.code(403).send({ success: false, message: "URL not allowed" });
  }

  const tmpVideo = join(tmpdir(), `vid_${Date.now()}_v.mp4`);
  const tmpAudio = join(tmpdir(), `vid_${Date.now()}_a.m4a`);
  const tmpOut = join(tmpdir(), `vid_${Date.now()}_out.mp4`);

  try {
    log("info", "merge", "Downloading video stream", { url: decodedVideoUrl.slice(0, 80) });

    // Download video stream
    const vRes = await fetch(decodedVideoUrl, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
        "Accept": "*/*",
        "Referer": "https://www.youtube.com/",
      },
      signal: AbortSignal.timeout(120_000),
    });
    if (!vRes.ok) throw new Error(`Video stream fetch failed: ${vRes.status}`);

    // ✅ Check video stream size limit
    const vContentLength = vRes.headers.get("content-length");
    if (vContentLength && parseInt(vContentLength, 10) > MAX_FILE_SIZE_BYTES) {
      vRes.body?.cancel();
      throw new Error("Video stream exceeds the 100 MB limit");
    }

    await pipeline(Readable.fromWeb(vRes.body as any), createWriteStream(tmpVideo));

    log("info", "merge", "Downloading audio stream", { url: decodedAudioUrl.slice(0, 80) });

    // Download audio stream
    const aRes = await fetch(decodedAudioUrl, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
        "Accept": "*/*",
        "Referer": "https://www.youtube.com/",
      },
      signal: AbortSignal.timeout(60_000),
    });
    if (!aRes.ok) throw new Error(`Audio stream fetch failed: ${aRes.status}`);
    await pipeline(Readable.fromWeb(aRes.body as any), createWriteStream(tmpAudio));

    log("info", "merge", "Running FFmpeg mux");

    // FFmpeg mux
    await new Promise<void>((resolve, reject) => {
      const ff = spawn("ffmpeg", [
        "-y",
        "-i", tmpVideo,
        "-i", tmpAudio,
        "-c:v", "copy",
        "-c:a", "aac",
        "-movflags", "+faststart",
        tmpOut,
      ]);

      let stderr = "";
      ff.stderr.on("data", (d: Buffer) => { stderr += d.toString(); });
      ff.on("close", (code) => {
        if (code === 0) resolve();
        else reject(new Error(`FFmpeg exited ${code}: ${stderr.slice(-300)}`));
      });
      ff.on("error", reject);
    });

    log("info", "merge", "Streaming merged file to client");

    // Stream result back
    const { size } = await import("node:fs").then(fs =>
      new Promise<{ size: number }>((res, rej) =>
        fs.stat(tmpOut, (err, s) => err ? rej(err) : res({ size: s.size }))
      )
    );

    // ✅ Final 100MB limit check on merged file
    if (size > MAX_FILE_SIZE_BYTES) {
      throw new Error("Merged video exceeds the 100 MB limit");
    }

    reply.header("Content-Type", "video/mp4");
    reply.header("Content-Length", String(size));
    reply.header("Content-Disposition", `attachment; filename="video_${Date.now()}.mp4"`);
    reply.header("Cache-Control", "no-store");
    reply.header("Access-Control-Allow-Origin", "*");

    const fileStream = (await import("node:fs")).createReadStream(tmpOut);
    return reply.send(fileStream);

  } catch (err: any) {
    log("error", "merge", "Merge failed", { error: err?.message });
    
    if (err?.message?.includes("100 MB limit")) {
      return reply.code(413).send({ success: false, message: err.message });
    }
    
    return reply.code(502).send({ success: false, message: `Merge failed: ${err?.message}` });
  } finally {
    // Cleanup temp files
    for (const f of [tmpVideo, tmpAudio, tmpOut]) {
      try { if (existsSync(f)) unlinkSync(f); } catch { /* ignore */ }
    }
  }
};

export const downloadController = {
  getVideoInfo, getDownloadLink, resolveUrl, tunnel, healthCheck, mergeVideoAudio
};