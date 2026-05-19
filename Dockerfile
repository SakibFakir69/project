FROM node:20

# Install system dependencies
RUN apt-get update && apt-get install -y \
    ffmpeg \
    python3 \
    python3-pip \  
    python3-venv \
    curl \
    && rm -rf /var/lib/apt/lists/*

# Install yt-dlp with absolute dependencies for network spoofing
RUN pip3 install --break-system-packages -U "yt-dlp[default,curl_ciphers]"

WORKDIR /app

COPY package*.json ./
RUN npm install

COPY . .

RUN npm run build
RUN npm prune --production

EXPOSE 5000

CMD ["node", "dist/server.js"]