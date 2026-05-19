import fastifyRateLimit from "@fastify/rate-limit";
import { FastifyInstance } from "fastify";

export const fastifyRateLimitMiddleware = async (app: FastifyInstance) => {
  app.register(fastifyRateLimit, {
    global: true, //// apply all route
    max: 100, //// 100 request
    timeWindow: "1 minute",
    ban: 5,

    //  Custom error response
    errorResponseBuilder: (req, context) => ({
      success: false,
      message: "Too many requests — slow down",
      retryAfter: context.after,
    }),

    addHeaders: {
      "x-ratelimit-limit": true,
      "x-ratelimit-remaining": true,
      "x-ratelimit-reset": true,
      "retry-after": true,
    },

    //  kip rate limit for your own IPs
    skipOnError: false,

    allowList: ["127.0.0.1", "::1"],
  });
};
