/**
 * proxy.pool.ts — Proxy rotation with health scoring
 * Set PROXY_LIST env var (comma or newline separated):
 *   PROXY_LIST=http://user:pass@host1:3128,http://user:pass@host2:3128
 */

export interface Proxy {
  url:       string;
  label:     string;
  score:     number;
  failures:  number;
  successes: number;
  lastUsed:  number;
  banned:    Set<string>;
}

function log(msg: string, extra?: any) {
  process.stdout.write(JSON.stringify({ ts: new Date().toISOString(), service: "proxy.pool", msg, ...extra }) + "\n");
}

class ProxyPool {
  private proxies: Proxy[] = [];

  constructor() { this.load(); }

  private load(): void {
    const raw  = process.env.PROXY_LIST ?? "";
    const urls = raw.split(/[\n,]+/).map(s => s.trim()).filter(Boolean);
    this.proxies = urls.map((url, i) => ({
      url, label: `proxy-${i + 1}`, score: 100,
      failures: 0, successes: 0, lastUsed: 0, banned: new Set<string>(),
    }));
    if (this.proxies.length) log(`Loaded ${this.proxies.length} proxies`);
    else                     log("No proxies configured — direct connection");
  }

  reload(): void { this.load(); }
  get count(): number { return this.proxies.length; }

  /** Pick best proxy for platform — excludes banned, prefers high score + LRU */
  pick(platform?: string): Proxy | null {
    if (!this.proxies.length) return null;
    const candidates = this.proxies.filter(p => p.score > 10 && (!platform || !p.banned.has(platform)));
    if (!candidates.length) {
      this.proxies.forEach(p => { p.score = 50; p.failures = 0; });
      log("All proxies degraded — scores reset");
      return this.proxies[0];
    }
    const now = Date.now();
    return candidates.sort((a, b) => {
      const sa = a.score - (now - a.lastUsed < 5_000 ? 20 : 0);
      const sb = b.score - (now - b.lastUsed < 5_000 ? 20 : 0);
      return sb - sa;
    })[0];
  }

  /** Pick by attempt index — each retry attempt gets a different proxy */
  pickByIndex(index: number): Proxy | null {
    if (!this.proxies.length) return null;
    return this.proxies[index % this.proxies.length];
  }

  success(proxy: Proxy): void {
    proxy.successes++;
    proxy.score    = Math.min(100, proxy.score + 5);
    proxy.failures = 0;
  }

  failure(proxy: Proxy, platform?: string, isBan = false): void {
    proxy.failures++;
    proxy.score = Math.max(0, proxy.score - 15);
    if (isBan && platform) {
      proxy.banned.add(platform);
      log(`Proxy ${proxy.label} banned for ${platform}`);
    }
  }

  ytdlpArgs(proxy: Proxy | null): string[] {
    return proxy ? ["--proxy", proxy.url] : [];
  }

  stats(): object {
    return this.proxies.map(p => ({
      label: p.label, score: p.score, failures: p.failures, banned: [...p.banned],
    }));
  }
}

export const proxyPool = new ProxyPool();