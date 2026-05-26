#!/bin/bash
# docker-entrypoint.sh
# Runs as the non-root nodeapp user.
# On every container start, try to self-update yt-dlp + gallery-dl
# so extractors stay fresh without a full image rebuild.
set -e
 
echo "[Entrypoint] Updating yt-dlp and gallery-dl..."
pip3 install --break-system-packages --no-cache-dir -U yt-dlp gallery-dl 2>/dev/null \
  || echo "[Entrypoint] WARNING: extractor update failed (offline?), using bundled version"
 
echo "[Entrypoint] yt-dlp   version: $(yt-dlp   --version 2>/dev/null || echo unknown)"
echo "[Entrypoint] gallery-dl version: $(gallery-dl --version 2>/dev/null || echo unknown)"
 
exec "$@"
 