  /**
   * playwright.extractor.ts — v2 Optimized
   * ─────────────────────────────────────────────────────────────────────────────
   * CRITICAL FIXES:
   *  ✅ Singleton Browser (prevents OOM crashes, 10x faster launch)
   *  ✅ Concurrency Semaphore (max 2 tabs at a time to save RAM)
   *  ✅ Replaced slow "networkidle" with "domcontentloaded" + video selector wait
   *  ✅ Filtered out .ts segment spam (only captures master .m3u8 or .mp4)
   *  ✅ Robust context/page cleanup in finally block
   * ─────────────────────────────────────────────────────────────────────────────
   */

  function log(level: string, msg: string, extra?: any) {
    process.stdout.write(JSON.stringify({ ts: new Date().toISOString(), level, service: "playwright", msg, ...extra }) + "\n");
  }

  export interface PlaywrightResult {
    videoUrl:  string;
    audioUrl:  string | null;
    title:     string;
    thumbnail: string | null;
  }

  // Match master video files, but ignore tiny HLS .ts segments
  const VIDEO_URL_RE = /\.(mp4|webm|m3u8|mpd|mov)(\?|$)/i;
  const SKIP_EXTENSIONS = /\.(js|css|png|jpg|gif|svg|ico|woff|woff2|ttf|ts)(\?|$)/i;

  // ── Concurrency Limiter ──────────────────────────────────────────────────────
  // Prevents OOM on CX23 server by limiting concurrent browser tabs to 2

  class Semaphore {
    private running = 0;
    private queue: Array<() => void> = [];
    constructor(private limit: number) {}
    acquire(): Promise<void> {
      if (this.running < this.limit) { this.running++; return Promise.resolve(); }
      return new Promise(r => this.queue.push(r));
    }
    release(): void {
      const next = this.queue.shift();
      if (next) next(); else this.running--;
    }
  }

  const browserSemaphore = new Semaphore(2);

  // ── Singleton Browser Instance ───────────────────────────────────────────────
  // Launching a browser takes 1-2s and 300MB RAM. Reusing it takes 0.1s and 30MB.

  let browserInstance: any = null;

  async function getBrowser(): Promise<any> {
    // If browser exists and is connected, reuse it
    if (browserInstance && browserInstance.isConnected()) {
      return browserInstance;
    }

    log("info", "Launching singleton browser instance...");
    const playwright = await import("playwright");
    
    browserInstance = await playwright.chromium.launch({
  executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ?? "/usr/bin/chromium",
  headless: true,
  args: [
    "--no-sandbox",
    "--disable-setuid-sandbox",
    "--disable-dev-shm-usage",
    "--disable-blink-features=AutomationControlled",
    "--disable-web-security",
    "--disable-extensions",
  ],
});

    // Auto-restart if browser crashes unexpectedly
    browserInstance.on("disconnected", () => {
      log("warn", "Browser instance disconnected/crashed");
      browserInstance = null;
    });

    return browserInstance;
  }

  // ── Main Extractor Function ──────────────────────────────────────────────────

  export async function extractWithPlaywright(
    url:      string,
    platform: string,
    signal?:  AbortSignal,
  ): Promise<PlaywrightResult> {
    await browserSemaphore.acquire();
    
    let context: any = null;
    let page: any = null;

    try {
      if (signal?.aborted) throw new Error("Request aborted before browser extraction");

      const browser = await getBrowser();

      log("info", "Creating browser context", { url: url.slice(0, 80), platform });

      const mobileUA = "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.6367.82 Mobile Safari/537.36";

      context = await browser.newContext({
        userAgent:          mobileUA,
        viewport:           { width: 390, height: 844 },
        isMobile:           true,
        hasTouch:           true,
        locale:             "en-US",
        timezoneId:         "America/New_York",
        extraHTTPHeaders: {
          "Accept-Language":  "en-US,en;q=0.9",
          "Sec-Ch-Ua-Mobile": "?1",
        },
      });

      // Hide automation signals
      await context.addInitScript(() => {
        Object.defineProperty(navigator, "webdriver", { get: () => undefined });
        Object.defineProperty(navigator, "plugins",   { get: () => [1, 2, 3, 4, 5] });
        Object.defineProperty(navigator, "languages", { get: () => ["en-US", "en"] });
        (window as any).chrome = { runtime: {} };
      });

      page = await context.newPage();
      
      // Block unnecessary resources to speed up loading
      await page.route(SKIP_EXTENSIONS, (route: any) => route.abort());

      const captured: string[] = [];

      // Intercept network requests for video URLs
      page.on("request", (req: any) => {
        const reqUrl = req.url();
        if (VIDEO_URL_RE.test(reqUrl) && !SKIP_EXTENSIONS.test(reqUrl)) {
          captured.push(reqUrl);
        }
      });

      // Intercept JSON API responses that might contain video URLs
      page.on("response", async (res: any) => {
        const resUrl      = res.url();
        const contentType = res.headers()["content-type"] ?? "";

        if (res.status() === 200 && contentType.includes("application/json")) {
          try {
            const body = await res.text().catch(() => "");
            const videoMatches = body.match(/https?:\/\/[^"'\s]+\.(mp4|webm|m3u8)(\?[^"'\s]*)?/gi) ?? [];
            for (const match of videoMatches) {
              if (!captured.includes(match)) captured.push(match);
            }
          } catch { /* ignore */ }
        }

        if (VIDEO_URL_RE.test(resUrl) && !SKIP_EXTENSIONS.test(resUrl) && !captured.includes(resUrl)) {
          captured.push(resUrl);
        }
      });

      // Navigate using "domcontentloaded" (much faster than "networkidle")
      await page.goto(url, {
        waitUntil: "domcontentloaded",
        timeout:   20_000,
      });

      // Wait specifically for a video element to appear (max 5 seconds)
      await page.waitForSelector("video", { timeout: 5_000 }).catch(() => {});
      
      if (signal?.aborted) throw new Error("Request aborted during browser extraction");

      // Extract video src from DOM directly
      const videoSrc = await page.evaluate(() => {
        const video = document.querySelector("video[src], video source[src]") as HTMLVideoElement | null;
        return video?.src ?? null;
      }).catch(() => null);

      if (videoSrc && VIDEO_URL_RE.test(videoSrc) && !captured.includes(videoSrc)) {
        captured.unshift(videoSrc); // Prioritize DOM video element
      }

      // Extract metadata
      const [pageTitle, thumbnail] = await Promise.all([
        page.title().catch(() => ""),
        page.evaluate(() => {
          const meta = document.querySelector('meta[property="og:image"]') as HTMLMetaElement | null;
          return meta?.content ?? null;
        }).catch(() => null),
      ]);

      if (!captured.length) {
        throw new Error("Playwright: no video URL captured from page");
      }

      // Prioritize: mp4 > webm > m3u8
      const best = captured.find(u => /\.mp4(\?|$)/i.test(u))
        ?? captured.find(u => /\.webm(\?|$)/i.test(u))
        ?? captured.find(u => /\.m3u8(\?|$)/i.test(u))
        ?? captured[0];

      log("info", "Browser extraction successful", { url: best.slice(0, 100), totalCaptured: captured.length });

      return {
        videoUrl:  best,
        audioUrl:  null,
        title:     pageTitle || url.split("/").pop() || "video",
        thumbnail: thumbnail ?? null,
      };

    } catch (err: any) {
      log("error", "Browser extraction failed", { error: err.message?.slice(0, 100) });
      throw err;
    } finally {
      // CRITICAL: Clean up page and context to prevent memory leaks
      if (page) await page.close().catch(() => {});
      if (context) await context.close().catch(() => {});
      
      // Release the semaphore so the next request can run
      browserSemaphore.release();
    }
  }