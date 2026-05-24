FROM node:20

# Install system dependencies
RUN apt-get update && apt-get install -y \
    ffmpeg \
    python3 \
    python3-pip \
    python3-venv \
    curl \
    wget \
    unzip \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Install latest yt-dlp + curl_cffi
RUN pip3 install --break-system-packages -U \
    "yt-dlp[default,curl_cffi]" \
    curl-cffi

WORKDIR /app

COPY package*.json ./

RUN npm install

COPY . .

# Build app
RUN npm run build

# Remove dev deps
RUN npm prune --production

EXPOSE 5000

CMD ["node", "dist/server.js"]