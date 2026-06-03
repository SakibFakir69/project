import dotenv from "dotenv";
dotenv.config();
import fastify from "fastify";
import { downloadRoutes } from "./app/downloader/downloader.route.js";
import cors from '@fastify/cors';
import { fastifyRateLimitMiddleware } from "./middleware/index.js";
import { initCookies } from "./utils/cookies.js";
import { downloadController } from "./app/downloader/downloader.controller.js";

initCookies();

const app = fastify({ logger: true });

await fastifyRateLimitMiddleware(app);

app.addHook("onRequest", (req, reply, done) => {
  console.log(req.method);
  done();
});

app.register(cors, {
  origin: "*",
  methods: ['POST', 'GET']
});

app.get("/", async (req, reply) => {
  return { message: "Hello World", time: process.uptime() };
});


app.get('/tunnel', downloadController.tunnel);

// Routes WITH /api/v1 prefix
app.register(downloadRoutes, { prefix: '/api/v1' });


app.get('/home', (request, reply) => {
  return { message: "Welcome to authservices" };
});

export const MainServer = app;