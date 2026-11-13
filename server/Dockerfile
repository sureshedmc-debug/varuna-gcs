# Hosted backend for the VARUNA GCS web demo (Render).
# Build context is the repo root (see render.yaml and .dockerignore).
FROM node:20-bookworm-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 python3-venv \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Boat backend (runs in --sim mode: no Pixhawk, no camera, no GPIO).
COPY boat-pi/requirements.txt boat-pi/requirements.txt
RUN python3 -m venv /opt/venv \
 && /opt/venv/bin/pip install --no-cache-dir -r boat-pi/requirements.txt

COPY server/package.json server/package.json
RUN cd server && npm install --omit=dev --no-audit --no-fund

COPY server/web.cjs server/web.cjs
COPY electron/localData.cjs electron/localData.cjs
COPY public/config/rivers.json public/config/rivers.json
COPY boat-pi/ boat-pi/

ENV NODE_ENV=production \
    PYTHON=/opt/venv/bin/python \
    VARUNA_DATA_DIR=/tmp/varuna-data

EXPOSE 10000
CMD ["node", "server/web.cjs"]
