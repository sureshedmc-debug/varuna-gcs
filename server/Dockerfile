# Hosted backend for the VARUNA GCS web demo (Render).
# Build context is the repo root (see render.yaml and .dockerignore).
FROM node:20-bookworm-slim

# ffmpeg draws the drone's test-camera picture.
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 python3-venv ffmpeg \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Vehicle backends: the boat in --sim mode, the drone with no Pixhawk.
COPY boat-pi/requirements.txt boat-pi/requirements.txt
COPY drone-pi/requirements.txt drone-pi/requirements.txt
RUN python3 -m venv /opt/venv \
 && /opt/venv/bin/pip install --no-cache-dir -r boat-pi/requirements.txt -r drone-pi/requirements.txt

COPY server/package.json server/package.json
RUN cd server && npm install --omit=dev --no-audit --no-fund

COPY server/web.cjs server/web.cjs
COPY electron/localData.cjs electron/localData.cjs
COPY public/config/rivers.json public/config/rivers.json
COPY boat-pi/ boat-pi/
COPY drone-pi/ drone-pi/

# The free plan has a tenth of a CPU: keep the drone's test video small.
ENV NODE_ENV=production \
    PYTHON=/opt/venv/bin/python \
    VARUNA_DATA_DIR=/tmp/varuna-data \
    DRONE_CAMERA_SOURCE=test \
    DRONE_CAMERA_CODEC=mjpeg \
    DRONE_CAMERA_WIDTH=320 \
    DRONE_CAMERA_HEIGHT=240 \
    DRONE_CAMERA_FPS=5

EXPOSE 10000
CMD ["node", "server/web.cjs"]
