import { existsSync, copyFileSync, mkdirSync } from "fs";
import { join } from "path";
const COOKIES_SOURCE = "/etc/secrets";
const COOKIES_WRITABLE = "/tmp/cookies"; // /tmp is always writable
export const initCookies = () => {
    const files = ["youtube.txt", "instagram.txt", "tiktok.txt", "facebook.txt"];
    // Create writable cookies dir
    mkdirSync(COOKIES_WRITABLE, { recursive: true });
    for (const file of files) {
        const src = join(COOKIES_SOURCE, file);
        const dest = join(COOKIES_WRITABLE, file);
        if (existsSync(src)) {
            copyFileSync(src, dest);
            console.log(`[cookies] copied ${file} to ${dest}`);
        }
    }
};
//# sourceMappingURL=cookies.js.map