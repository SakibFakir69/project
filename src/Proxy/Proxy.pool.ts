/**
 * proxy.pool.ts — Proxy rotation with health scoring & Playwright support
 * Set PROXY_LIST env var (comma or newline separated):
 * PROXY_LIST=http://user:pass@host1:3128,http://user:pass@host2:3128
 */

export interface Proxy {
  url:       string;
  label:     string;
  score:     number;
  failures:  number;
  successes: number;
  lastUsed:  number;
  banned:    Map<string, number>; // Platform -> Ban Expiry Timestamp
}

function log(msg: string, extra?: any) {
  process.stdout.write(JSON.stringify({ ts: new Date().toISOString(), service: "proxy.pool", msg, ...extra }) + "\n");
}

const BAN_DURATION_MS = 30 * 60_000; // Bans last 30 minutes

class ProxyPool {
  private proxies: Proxy[] = [];

  constructor() { this.load(); }

  private load(): void {
    const raw  = process.env.PROXY_LIST ?? "";
    const urls = raw.split(/[\n,]+/).map(s => s.trim()).filter(Boolean);
    this.proxies = urls.map((url, i) => ({
      url, label: `proxy-${i + 1}`, score: 100,
      failures: 0, successes: 0, lastUsed: 0, banned: new Map(),
    }));
    if (this.proxies.length) log(`Loaded ${this.proxies.length} proxies`);
    else                     log("No proxies configured — direct connection");
  }

  reload(): void { this.load(); }
  get count(): number { return this.proxies.length; }

  /** Internal helper to locate the true reference tracking object by URL string */
  private findRealProxy(proxyInput: Proxy | string | null): Proxy | null {
    if (!proxyInput) return null;
    const urlStr = typeof proxyInput === "string" ? proxyInput : proxyInput.url;
    return this.proxies.find(p => p.url === urlStr) ?? null;
  }

  /** Pick best proxy for platform — excludes recently banned, prefers high score */
  pick(platform?: string): Proxy | null {
    if (!this.proxies.length) return null;
    const now = Date.now();
    
    // Clean up expired bans before picking
    for (const p of this.proxies) {
      for (const [plat, expiry] of p.banned.entries()) {
        if (now > expiry) p.banned.delete(plat);
      }
    }

    const candidates = this.proxies.filter(p => p.score > 10 && (!platform || !p.banned.has(platform)));
    if (!candidates.length) {
      this.proxies.forEach(p => { p.score = 50; p.failures = 0; p.banned.clear(); });
      log("All proxies degraded or banned — scores/bans reset");
      return this.proxies[0];
    }
    
    const chosen = candidates.sort((a, b) => {
      const sa = a.score - (now - a.lastUsed < 5_000 ? 20 : 0);
      const sb = b.score - (now - b.lastUsed < 5_000 ? 20 : 0);
      return sb - sa;
    })[0];

    if (chosen) chosen.lastUsed = now;
    return chosen;
  }

  /** Pick by attempt index — each retry attempt gets a different proxy */
  pickByIndex(index: number, platform?: string): Proxy | null {
    if (!this.proxies.length) return null;
    
    const now = Date.now();
    // Clean expired bans
    for (const p of this.proxies) {
      for (const [plat, expiry] of p.banned.entries()) {
        if (now > expiry) p.banned.delete(plat);
      }
    }

    // Try to find a proxy for this index that isn't banned for this platform
    for (let i = 0; i < this.proxies.length; i++) {
      const proxyIndex = (index + i) % this.proxies.length;
      const proxy = this.proxies[proxyIndex];
      if (!platform || !proxy.banned.has(platform)) {
        proxy.lastUsed = now;
        return proxy;
      }
    }
    
    const fallbackProxy = this.proxies[index % this.proxies.length];
    fallbackProxy.lastUsed = now;
    return fallbackProxy;
  }

  /** FIXED: Uses lookups to find the accurate array reference */
  success(proxyInput: Proxy | string): void {
    const proxy = this.findRealProxy(proxyInput);
    if (!proxy) return;

    proxy.successes++;
    proxy.score    = Math.min(100, proxy.score + 5);
    proxy.failures = 0;
  }

  /** FIXED: Safely matches reference arrays and handles dynamic rotations */
  failure(proxyInput: Proxy | string, platform?: string, isBan = false): void {
    const proxy = this.findRealProxy(proxyInput);
    if (!proxy) return;

    proxy.failures++;
    proxy.score = Math.max(0, proxy.score - 15);
    
    // Webshare Rotate handling: drop the score quickly on explicit rate limits (429)
    if (isBan) {
      proxy.score = Math.max(0, proxy.score - 25);
      if (platform) {
        proxy.banned.set(platform, Date.now() + BAN_DURATION_MS);
        log(`Proxy ${proxy.label} banned for ${platform} for 30 mins`);
      }
    }
  }

  ytdlpArgs(proxyInput: Proxy | string | null): string[] {
    const proxy = this.findRealProxy(proxyInput);
    return proxy ? ["--proxy", proxy.url] : [];
  }

  playwrightProxy(proxyInput: Proxy | string | null): { server: string; username?: string; password?: string } | undefined {
    const proxy = this.findRealProxy(proxyInput);
    if (!proxy) return undefined;
    try {
      const parsed = new URL(proxy.url);
      return {
        server: `${parsed.protocol}//${parsed.hostname}:${parsed.port}`,
        username: parsed.username || undefined,
        password: parsed.password || undefined,
      };
    } catch {
      return { server: proxy.url };
    }
  }

  stats(): object {
    const now = Date.now();
    return this.proxies.map(p => ({
      label: p.label, score: p.score, failures: p.failures, 
      banned: Object.fromEntries([...p.banned.entries()].map(([k, v]) => [k, v > now ? 'yes' : 'no'])),
    }));
  }
}

export const proxyPool = new ProxyPool();