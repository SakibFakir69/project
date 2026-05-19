import { exec } from 'child_process';
import { promisify } from 'util';
const execPromise = promisify(exec);
export class YouTubeTokenService {
    static poToken = null;
    static visitorData = null;
    static lastUpdate = 0;
    // Refresh every 12 hours (tokens typically last 24h)
    static REFRESH_INTERVAL = 12 * 60 * 60 * 1000;
    static async getTokens() {
        const now = Date.now();
        if (!this.poToken || (now - this.lastUpdate > this.REFRESH_INTERVAL)) {
            await this.refreshTokens();
        }
        return { poToken: this.poToken, visitorData: this.visitorData };
    }
    static async refreshTokens() {
        try {
            console.log("[youtube-token] Refreshing PO Token...");
            // Use a dedicated script or tool to extract the token
            // Example using the common 'npx yt-dlp-get-potoken' tool
            const { stdout } = await execPromise('npx yt-dlp-get-potoken --headless');
            const data = JSON.parse(stdout);
            this.poToken = data.po_token;
            this.visitorData = data.visitor_data;
            this.lastUpdate = Date.now();
            console.log("[youtube-token] Refresh successful");
        }
        catch (error) {
            console.error("[youtube-token] Failed to refresh tokens:", error);
        }
    }
}
// if (isYouTube) {
//   const proxyFlag = getProxyFlag();
//   const cookieFlag = getCookieFlag(url);
//   const formatSelector = buildFormatSelector(type, quality, url);
//   const command = [
//     "yt-dlp",
//     "--no-check-certificate",
//     "--no-playlist",
//     "--socket-timeout 15",
//     `--user-agent "${USER_AGENT}"`,
//     // 💡 FIX 1: Impersonate a specific client TLS fingerprint
//     "--impersonate-client chrome",
//     // 💡 FIX 2: Use the mweb client which has lighter PO Token enforcement
//     '--extractor-args "youtube:player_client=mweb,android,ios"',
//     // 💡 FIX 3: Point to your PO Token provider (if using the plugin)
//     // If you don't have a plugin, you MUST pass a static PO Token like this:
//     process.env.YT_PO_TOKEN 
//       ? `--extractor-args "youtube:po_token=web+${process.env.YT_PO_TOKEN};visitor_data=${process.env.YT_VISITOR_DATA}"` 
//       : "",
//     proxyFlag,
//     cookieFlag,
//     formatSelector,
//     "--get-url",
//     JSON.stringify(url),
//   ].filter(Boolean).join(" ");
//   // ... execution logic
// }
//# sourceMappingURL=token-services.js.map