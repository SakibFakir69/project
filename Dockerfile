FROM node:20-slim

# Install system dependencies + build tools required for curl_cffi compilation
RUN apt-get update && apt-get install -y \
    ffmpeg \
    python3 \
    python3-pip \
    python3-dev \
    build-essential \
    libssl-dev \
    curl \
    wget \
    unzip \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Force an upgrade of pip/setuptools, then install yt-dlp with full dependencies
RUN pip3 install --break-system-packages -U pip setuptools wheel && \
    pip3 install --break-system-packages -U "yt-dlp[default,plugins]" curl_cffi

WORKDIR /app

COPY package*.json ./

# Install packages including dev dependencies (needed if building types/TS scripts)
RUN npm ci

COPY . .

# Build app
RUN npm run build

# Remove dev deps to keep production footprint small
RUN npm prune --production

EXPOSE 5000

CMD ["node", "dist/server.js"]