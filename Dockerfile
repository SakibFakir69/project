# ── Build stage ───────────────────────────────────────────────────────────────
FROM node:20-slim AS builder

WORKDIR /app
COPY package*.json ./

# 1. Install ALL dependencies (including devDependencies) so tsc can compile
RUN npm ci

COPY . .
RUN npm run build     # tsc → dist/

# 2. Prune devDependencies after build so they don't bloat the runtime image
RUN npm prune --omit=dev

# ── Runtime stage ─────────────────────────────────────────────────────────────
FROM node:20-slim AS runtime

# 3. Install Playwright system dependencies FIRST (required for Chromium to run)
RUN npx playwright install --with-deps chromium

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
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

WORKDIR /app

# Copy built application and pruned node_modules from builder
COPY --from=builder /app/dist        ./dist
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/package.json ./

# 4. Fix Playwright permissions for non-root user
# Playwright installs Chromium for root by default. We must move it to a place the 'nodeapp' user can access.
ENV PLAYWRIGHT_BROWSERS_PATH=/opt/playwright
RUN mkdir -p /opt/playwright && chown -R nodeapp:nodeapp /opt/playwright

# Non-root user for security
RUN groupadd --gid 1001 nodeapp \
 && useradd  --uid 1001 --gid nodeapp --shell /bin/bash --create-home nodeapp \
 && chown -R nodeapp:nodeapp /app
USER nodeapp

EXPOSE 5000

ENTRYPOINT ["docker-entrypoint.sh"]
CMD ["node", "dist/server.js"]