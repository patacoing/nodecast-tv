# NodeCast TV Docker Image
#
# Hardware acceleration:
#   - VAAPI (Intel/AMD): Mount /dev/dri and add video/render groups
#   - NVIDIA NVENC: Requires nvidia-container-toolkit on host + --gpus flag
#   - Intel QSV: Mount /dev/dri
#
# Build: docker compose build
# Run with VAAPI: docker run --device /dev/dri:/dev/dri --group-add video ...

# node:20 supporte amd64, arm64 et arm/v7 (armhf) nativement
FROM node:20-slim

# Install FFmpeg and build tools (needed for better-sqlite3 native compilation)
ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg \
    python3 \
    make \
    g++ \
    && rm -rf /var/lib/apt/lists/*

# Verify FFmpeg installed
RUN ffmpeg -version

WORKDIR /app

# Copy package files
COPY package*.json ./

# Install dependencies (better-sqlite3 will build from source using g++ installed above)
RUN npm ci --only=production

# Copy application files
COPY . .

# Create data and cache directories
RUN mkdir -p /app/data /app/transcode-cache && chmod 777 /app/transcode-cache

# Expose port
EXPOSE 3000

# Start server
CMD ["node", "server/index.js"]
