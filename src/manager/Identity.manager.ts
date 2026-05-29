/**
 * identity.manager.ts
 * Rotates User-Agents and client identities per attempt index.
 * Attempt 0 = desktop web, Attempt 1 = Android, Attempt 2 = iOS, etc.
 */

export interface Identity {
  userAgent:    string;
  clientName:   string;
  ytdlpClient:  string;
  headers:      Record<string, string>;
}

const IDENTITIES: Identity[] = [
  {
    userAgent:   "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    clientName:  "web",
    ytdlpClient: "web_creator,web",
    headers:     { "Accept-Language": "en-US,en;q=0.9" },
  },
  {
    userAgent:   "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.6367.82 Mobile Safari/537.36",
    clientName:  "android",
    ytdlpClient: "android,web",
    headers:     { "Accept-Language": "en-US,en;q=0.9" },
  },
  {
    userAgent:   "Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1",
    clientName:  "ios",
    ytdlpClient: "ios,web",
    headers:     { "Accept-Language": "en-US,en;q=0.9" },
  },
  {
    userAgent:   "com.zhiliaoapp.musically/2023209060 (Linux; U; Android 9; en_US; SM-G960N; Build/PPR1.180610.011) okhttp/3.14.9",
    clientName:  "mweb",
    ytdlpClient: "android_vr,android",
    headers:     { "Accept-Encoding": "identity", "Accept-Language": "en-US" },
  },
  {
    userAgent:   "Mozilla/5.0 (Linux; Android 13; SM-G991B) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/23.0 Chrome/115.0.0.0 Mobile Safari/537.36",
    clientName:  "mweb",
    ytdlpClient: "mweb,web",
    headers:     { "Accept-Language": "en-US,en;q=0.8" },
  },
];

export const identityManager = {
  forAttempt(index: number): Identity {
    return IDENTITIES[index % IDENTITIES.length];
  },
  ytdlpHeaderArgs(identity: Identity): string[] {
    const args: string[] = ["--add-header", `User-Agent:${identity.userAgent}`];
    for (const [k, v] of Object.entries(identity.headers)) {
      if (v) args.push("--add-header", `${k}:${v}`);
    }
    return args;
  },
  count: IDENTITIES.length,
};