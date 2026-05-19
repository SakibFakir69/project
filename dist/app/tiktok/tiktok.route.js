import { tikTokController } from "./tiktok.controller.js";
const urlRateLimit = {
    config: { rateLimit: { max: 30, timeWindow: "1 minute" } },
};
const streamRateLimit = {
    config: { rateLimit: { max: 10, timeWindow: "1 minute" } },
};
export const tiktokRoutes = async (app) => {
    app.post("/tiktok/download-url", urlRateLimit, tikTokController.getTikTokDownloadUrl);
    app.get("/tiktok/stream", streamRateLimit, tikTokController.streamTikTok);
};
//# sourceMappingURL=tiktok.route.js.map