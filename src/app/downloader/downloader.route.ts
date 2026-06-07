import type { FastifyInstance } from "fastify";
import { downloadController } from "./downloader.controller.js";

export async function downloadRoutes(app: FastifyInstance) {


  app.post("/video/formats", {
    config: {
      rateLimit: {
        max: 30,
        timeWindow: "1 minute",
      },
    },
    schema: {
      body: {
        type: "object",
        required: ["url"],
        properties: { url: { type: "string" } },
      },
    },
  }, downloadController.getVideoInfo);

  app.get("/video/merge", downloadController.mergeVideoAudio),
    app.get('/health', downloadController.healthCheck);

  app.get("/resolve-url", downloadController.resolveUrl);
  app.post("/video/download", {
    config: {
      rateLimit: {
        max: 30,
        timeWindow: "1 minute",
      },
    },
    schema: {
      body: {
        type: "object",
        required: ["url"],
        properties: {
          url: { type: "string" },
          type: {
            type: "string",
            enum: ["video", "audio"],
            default: "video",
          },
          quality: {
            type: "string",
            enum: ["best", "144", "240", "360", "480", "720", "1080", "1440", "2160"],
            default: "720",
          },
          audioFormat: {
            type: "string",
            enum: ["mp3", "m4a", "opus", "wav"],
          },
        },
      },
    },
  }, downloadController.getDownloadLink);


}