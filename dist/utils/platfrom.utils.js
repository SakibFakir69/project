// utils/platform.utils.ts
const INVIDIOUS_INSTANCES = [
    "https://inv.nadeko.net",
    "https://invidious.nerdvpn.de",
    "https://invidious.privacyredirect.com",
];
export const extractYouTubeId = (url) => {
    return url.match(/(?:youtube\.com\/(?:shorts\/|watch\?v=)|youtu\.be\/)([a-zA-Z0-9_-]{11})/)?.[1] ?? null;
};
export const fetchFromInvidious = async (videoId) => {
    for (const instance of INVIDIOUS_INSTANCES) {
        try {
            const res = await fetch(`${instance}/api/v1/videos/${videoId}`, {
                signal: AbortSignal.timeout(8000),
            });
            if (res.ok)
                return await res.json();
        }
        catch {
            continue;
        }
    }
    throw new Error("All Invidious instances failed");
};
//# sourceMappingURL=platfrom.utils.js.map