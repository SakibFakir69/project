# ── Build stage ───────────────────────────────────────────────────────────────
FROM node:20-slim AS builder

WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build
RUN npm prune --omit=dev

# ── Runtime stage ─────────────────────────────────────────────────────────────
FROM node:20-slim AS runtime

RUN apt-get update && apt-get install -y --no-install-recommends \
        python3 \
        python3-pip \
        python3-dev \
        gcc \
        g++ \
        make \
        ffmpeg \
        curl \
        wget \
        ca-certificates \
        chromium \
        chromium-driver \
        libssl-dev \
        libcurl4-openssl-dev \
        libnss3 \
        libglib2.0-0 \
    && rm -rf /var/lib/apt/lists/*

# Upgrade pip
RUN pip3 install --break-system-packages --no-cache-dir --upgrade \
    pip setuptools wheel

# KEY FIX: curl_cffi must be 0.10.x-0.14.x for yt-dlp 2026.x
# 0.7.4 is explicitly rejected by yt-dlp
RUN pip3 install --break-system-packages --no-cache-dir --prefer-binary \
    "yt-dlp" \
    "gallery-dl" \
    "curl_cffi==0.10.0"

# Verify at build time — fails build if still unavailable
RUN /usr/bin/python3 -c "import curl_cffi; print('curl_cffi OK:', curl_cffi.__version__)" && \
    yt-dlp --list-impersonate-targets | grep -i chrome | grep -iv unavailable && \
    echo "✅ impersonate chrome CONFIRMED WORKING"

ENV PLAYWRIGHT_BROWSERS_PATH=/usr/bin
ENV PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/usr/bin/chromium
ENV PYTHONUNBUFFERED=1

WORKDIR /app
COPY --from=builder /app/dist         ./dist
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/package.json ./

COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

RUN groupadd --gid 1001 nodeapp \
 && useradd --uid 1001 --gid nodeapp --shell /bin/bash --create-home nodeapp \
 && chown -R nodeapp:nodeapp /app

USER nodeapp

EXPOSE 5000

ENTRYPOINT ["docker-entrypoint.sh"]
CMD ["node", "dist/server.js"]