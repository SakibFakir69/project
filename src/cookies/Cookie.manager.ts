/**
 * cookie.manager.ts — Cookie rotation per platform
 * Set env vars:
 *   COOKIES_YOUTUBE=cookies1.txt,cookies2.txt
 *   COOKIES_TIKTOK=tt1.txt,tt2.txt
 *   COOKIES_INSTAGRAM=ig1.txt
 *   COOKIES_DEFAULT=default.txt
 */

export type CookiePlatform = "youtube"|"tiktok"|"instagram"|"twitter"|"reddit"|"facebook"|"generic";

interface CookieEntry {
  path:      string;
  useCount:  number;
  failCount: number;
  disabled:  boolean;
}

function log(msg: string, extra?: any) {
  process.stdout.write(JSON.stringify({ ts: new Date().toISOString(), service: "cookie.mgr", msg, ...extra }) + "\n");
}

class CookieManager {
  private pools   = new Map<string, CookieEntry[]>();
  private cursors = new Map<string, number>();

  constructor() { this.load(); }

  private load(): void {
    const platforms: CookiePlatform[] = ["youtube","tiktok","instagram","twitter","reddit","facebook","generic"];
    for (const p of platforms) {
      const env   = process.env[`COOKIES_${p.toUpperCase()}`] ?? (p === "generic" ? process.env.COOKIES_DEFAULT ?? "" : "");
      const files = env.split(",").map(s => s.trim()).filter(Boolean);
      if (files.length) {
        this.pools.set(p, files.map(path => ({ path, useCount: 0, failCount: 0, disabled: false })));
        log(`Loaded ${files.length} cookie file(s) for ${p}`);
      }
    }
  }

  /** Round-robin next cookie for platform */
  next(platform: CookiePlatform): string | null {
    const pool = this.pools.get(platform) ?? this.pools.get("generic");
    if (!pool?.length) return null;
    const active = pool.filter(e => !e.disabled);
    if (!active.length) {
      pool.forEach(e => { e.disabled = false; e.failCount = 0; });
      return pool[0]?.path ?? null;
    }
    const cursor = (this.cursors.get(platform) ?? 0) % active.length;
    const entry  = active[cursor];
    this.cursors.set(platform, cursor + 1);
    entry.useCount++;
    return entry.path;
  }

  /** Pick cookie by attempt index — mutation retry uses different cookie each time */
  byIndex(platform: CookiePlatform, index: number): string | null {
    const pool   = this.pools.get(platform) ?? this.pools.get("generic");
    const active = pool?.filter(e => !e.disabled) ?? [];
    if (!active.length) return null;
    return active[index % active.length]?.path ?? null;
  }

  markFailed(platform: CookiePlatform, cookiePath: string): void {
    const entry = this.pools.get(platform)?.find(e => e.path === cookiePath);
    if (!entry) return;
    entry.failCount++;
    if (entry.failCount >= 3) {
      entry.disabled = true;
      log("Cookie disabled (too many failures)", { path: cookiePath, platform });
      setTimeout(() => { entry.disabled = false; entry.failCount = 0; }, 30 * 60_000);
    }
  }

  markSuccess(platform: CookiePlatform, cookiePath: string): void {
    const entry = this.pools.get(platform)?.find(e => e.path === cookiePath);
    if (entry) entry.failCount = Math.max(0, entry.failCount - 1);
  }

  hasCookies(platform: CookiePlatform): boolean {
    return (this.pools.get(platform)?.filter(e => !e.disabled).length ?? 0) > 0
        || (this.pools.get("generic")?.filter(e => !e.disabled).length ?? 0) > 0;
  }
}

export const cookieManager = new CookieManager();