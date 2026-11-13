# Hosted web app: Vercel (frontend) + Render (backend)

This is a **public demo**. It never reaches a real vehicle: both vehicle backends run inside the Render container.

| Piece | Where | What it is |
|---|---|---|
| Frontend | Vercel (`vercel.json`) | The normal Vite build of this app |
| Backend | Render (`render.yaml`, `server/`) | `server/web.cjs`, which runs three things in one container (below) |

What runs in the Render container:
- **Sign-in and records:** `electron/localData.cjs`, under `/local/*`.
- **Drone:** `drone-pi/main.py` with no Pixhawk and a small test camera (320×240, 5 fps). Screens, missions and video work. Flight commands answer "No Pixhawk found".
- **Boat:** `boat-pi/main.py --sim`, a fully simulated boat, under `/boat/*`.

## How requests flow

- **Sign-in and records** (`/local/*`): the browser calls Vercel, and Vercel rewrites to Render, so it stays same-origin.
- **Drone and boat:** the build sets `VITE_API_BASE` and `VITE_BOAT_BASE` to the Render address, so the browser calls Render directly. This is what makes the WebSockets and video streams work, because Vercel can't proxy those.

## Limits (Render free plan)

- The service sleeps after 15 minutes idle, and the first visit after that takes about a minute.
- No disk: accounts, records and missions are wiped on every restart or redeploy.

## Settings

- **Vercel** project env:
  - `VITE_API_BASE=https://varuna-gcs-api.onrender.com`
  - `VITE_BOAT_BASE=https://varuna-gcs-api.onrender.com/boat`
- **Vercel** `vercel.json`: the `/local` rewrite points at the same Render host.
- **Render** env `ALLOWED_ORIGINS`: the Vercel address(es). `*` matches preview suffixes.
- **Render** Blueprint branch: `boat-vision`.

## Run the backend locally

```bash
pip install -r boat-pi/requirements.txt -r drone-pi/requirements.txt
PORT=10010 PYTHON=python3 DRONE_CAMERA_SOURCE=test node server/web.cjs
```
