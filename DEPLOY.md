# Hosted web demo: Vercel (frontend) + Render (backend)

This is a **public demo**. It never reaches a real vehicle.

| Piece | Where | What it is |
|---|---|---|
| Frontend | Vercel (`vercel.json`) | The normal Vite build of this app |
| Backend | Render (`render.yaml`, `server/`) | `server/web.cjs`: sign-in + records (`electron/localData.cjs`) and the boat backend in `--sim` mode |

## How requests flow

- `/local/*` (sign-in, records): the browser calls Vercel, and Vercel rewrites to Render, so it stays same-origin.
- Boat: the build sets `VITE_BOAT_BASE=https://varuna-gcs-api.onrender.com/boat`, so the browser calls Render directly. This is what makes the WebSocket and video stream work, because Vercel can't proxy those.
- Drone (`/api`, `/video_feed`, `/stream`, `/tune`): rewritten to Render, which answers 503. The drone shows as offline because there is no drone simulator.

## Limits (Render free plan)

- The service sleeps after 15 minutes idle, and the first visit after that takes about a minute.
- No disk: accounts and records are wiped on every restart or redeploy.

## Settings

- **Vercel** project env: `VITE_BOAT_BASE=https://<render-service>.onrender.com/boat`
- **Vercel** `vercel.json` rewrites: point them at the same Render host.
- **Render** env `ALLOWED_ORIGINS`: the Vercel address(es). `*` matches preview suffixes.

## Run the backend locally

```bash
cd boat-pi && pip install -r requirements.txt && cd ..
PORT=10010 PYTHON=python3 node server/web.cjs
```
