import { FastifyReply, FastifyRequest } from "fastify";
import { spawn } from "child_process";
import fs from "fs";
import path from "path";
import os from "os";
import crypto from "crypto";

const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/122 Safari/537.36";

export const videoStream = async (
  req: FastifyRequest,
  reply: FastifyReply
) => {
  try {
    const { url } = req.query as { url: string };

    const cleanUrl = decodeURIComponent(url || "").trim();

    if (!cleanUrl) {
      return reply.code(400).send({
        error: "Invalid URL",
      });
    }

    // unique temp filename
    const uniqueId = crypto.randomUUID();

    const tempDir = path.join(os.tmpdir(), "downloads");

    if (!fs.existsSync(tempDir)) {
      fs.mkdirSync(tempDir, { recursive: true });
    }

    const outputTemplate = path.join(
      tempDir,
      `${uniqueId}.%(ext)s`
    );

    const yt = spawn("/usr/local/bin/yt-dlp", [
      "--no-playlist",

      "--cookies",
      "./cookies.txt",

      "--user-agent",
      USER_AGENT,

      "--add-header",
      "Referer: https://www.tiktok.com/",

      "--add-header",
      "Origin: https://www.tiktok.com",

      "-f",
      "mp4",

      "-o",
      outputTemplate,

      cleanUrl,
    ]);

    let errorLogs = "";

    yt.stderr.on("data", (data) => {
      const msg = data.toString();

      errorLogs += msg;

      console.log(msg);
    });

    yt.on("close", async (code) => {
      if (code !== 0) {
        console.log(errorLogs);

        return reply.code(500).send({
          error: "TikTok download failed",
          logs: errorLogs,
        });
      }

      // find downloaded file
      const files = fs.readdirSync(tempDir);

      const file = files.find((f) => f.startsWith(uniqueId));

      if (!file) {
        return reply.code(500).send({
          error: "Downloaded file not found",
        });
      }

      const filePath = path.join(tempDir, file);

      reply.header("Content-Type", "video/mp4");

      reply.header(
        "Content-Disposition",
        'attachment; filename="tiktok.mp4"'
      );

      const stream = fs.createReadStream(filePath);

      stream.pipe(reply.raw);

      stream.on("close", () => {
        // auto cleanup
        fs.unlink(filePath, () => {});
      });
    });

    req.raw.on("close", () => {
      if (!yt.killed) {
        yt.kill("SIGINT");
      }
    });
  } catch (error: any) {
    console.log(error);

    return reply.code(500).send({
      error: error.message,
    });
  }
};


==> 
Menu
==> ///////////////////////////////////////////////////////////
{"level":30,"time":1778154688233,"pid":1,"hostname":"srv-d7tifdhj2pic73abj830-hibernate-7f69fd675-r5cs2","reqId":"req-3","req":{"method":"POST","url":"/api/v1/video/formats","host":"test-pqfw.onrender.com","remoteAddress":"127.0.0.1","remotePort":37264},"msg":"incoming request"}
POST
  https://vt.tiktok.com/ZS9pgPbV3/
{"level":30,"time":1778154697812,"pid":1,"hostname":"srv-d7tifdhj2pic73abj830-hibernate-7f69fd675-r5cs2","reqId":"req-3","res":{"statusCode":200},"responseTime":9579.052326083183,"msg":"request completed"}
{"level":30,"time":1778154719968,"pid":1,"hostname":"srv-d7tifdhj2pic73abj830-hibernate-7f69fd675-r5cs2","reqId":"req-4","req":{"method":"GET","url":"/api/v1/video/tiktok/stream?url=https%3A%2F%2Fvt.tiktok.com%2FZS9pgPbV3%2F","host":"test-pqfw.onrender.com","remoteAddress":"127.0.0.1","remotePort":37264},"msg":"incoming request"}
GET
{"level":30,"time":1778154719971,"pid":1,"hostname":"srv-d7tifdhj2pic73abj830-hibernate-7f69fd675-r5cs2","reqId":"req-4","res":{"statusCode":200},"responseTime":3.22988498210907,"msg":"request completed"}
==> Detected service running on port 5000
==> Docs on specifying a port: https://render.com/docs/web-services#port-binding


can solve tik tok video not download problem