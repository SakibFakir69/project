# ── Build stage ───────────────────────────────────────────────────────────────
FROM node:20-slim AS builder

WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY . .
RUN npm run build     # tsc → dist/

# ── Runtime stage ─────────────────────────────────────────────────────────────
FROM node:20-slim AS runtime

# System deps: Python3 (for yt-dlp/gallery-dl), ffmpeg (muxing), curl (healthcheck)
RUN apt-get update && apt-get install -y --no-install-recommends \
        python3 \
        python3-pip \
        ffmpeg \
        curl \
        wget \
        ca-certificates \
    && pip3 install --break-system-packages --no-cache-dir \
        yt-dlp \
        gallery-dl \
    && rm -rf /var/lib/apt/lists/*

# Keep extractors fresh: update yt-dlp + gallery-dl at container start
# (avoids needing a full image rebuild just for extractor updates)
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

WORKDIR /app
COPY --from=builder /app/dist        ./dist
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/package.json ./

# Non-root user for security
RUN groupadd --gid 1001 nodeapp \
 && useradd  --uid 1001 --gid nodeapp --shell /bin/bash --create-home nodeapp \
 && chown -R nodeapp:nodeapp /app
USER nodeapp

EXPOSE 5000

ENTRYPOINT ["docker-entrypoint.sh"]
CMD ["node", "dist/server.js"]