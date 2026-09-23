# VARUNA AI — Ground Control UI

Premium, field-first frontend for the VARUNA river-cleanup drone. React + Vite +
Tailwind + Framer Motion. Talks to the existing FastAPI backend on the Raspberry
Pi over the **exact** endpoints it already exposes — no backend changes.

> **The build never runs on the Pi.** The Pi has 1 GB RAM and cannot build a
> modern JS app. Build on a laptop/CI, copy only `dist/` to the Pi.

---

## 1. Develop on the laptop (against the real Pi)

```bash
npm install
cp .env.local.example .env.local     # then edit it
npm run dev
```

Edit `.env.local` so the dev server proxies to your real backend — you'll see
**live** video/telemetry/detections while iterating:

```
VITE_DEV_API_TARGET=http://<pi-ip>:8000
# or an ngrok/tunnel URL:
# VITE_DEV_API_TARGET=https://your-tunnel.ngrok-free.app
```

This value is **dev-only**. It is read by `vite.config.js` for the dev proxy and
is *never* compiled into the production bundle.

## 2. Build for production

```bash
npm run build        # -> dist/
npm run check:clean  # verifies dist/ has no dev host baked in
```

`check:clean` is the zero-edit guarantee: it fails loudly if `localhost`,
`127.0.0.1`, an ngrok host, or any hardcoded `http://IP:port` leaked into the
bundle. The app calls the API via **relative paths** resolved against
`window.location.origin`, so the same `dist/` works unmodified via the Pi's LAN
IP, a Tailscale address, or the ngrok tunnel.

> Map tiles are fetched by the browser from `tile.openstreetmap.org` — that is a
> client-side asset host, not the backend, and is the one allowed external host.
> If the operator is offline the map degrades gracefully (editor still works by
> coordinates).

## 3. Drop it on the Pi (copy-paste, zero edits)

From the laptop, in this project folder after `npm run build`:

```bash
# copy the fresh build next to the current one
scp -r dist pi@<pi-ip>:/home/pi/varuna-ai-enterprise/dist_new

# on the Pi: swap it in and restart the service
ssh pi@<pi-ip> "cd /home/pi/varuna-ai-enterprise && \
  rm -rf dist_old && (mv dist dist_old || true) && mv dist_new dist && \
  sudo systemctl restart varuna"
```

Adjust the service name (`varuna`) and path to match your deployment. If the
backend serves the frontend some other way (e.g. a static mount pointing at
`dist/`), just replace the folder it serves and restart that process.

---

## What's in here

| Screen | Purpose | Endpoints used |
| --- | --- | --- |
| **Map (home)** | Mission-control command view: satellite map centerpiece with the live aircraft, floating glass panels (Selected Aircraft, System Overview w/ live sparklines, Platform Health, Event Log), a radial ARM/launch control, and a Live-Feed panel with speed/altitude HUD tapes | telemetry, `/api/ws`, `/api/health`, `/api/ping`, `/api/system/pi`, `/api/camera/status`, `/api/ai/status`, `/api/ai/detections`, `/api/mavlink/arm`, `/video_feed` |
| **Live** | Video centerpiece + core telemetry + arm/takeoff/RTL/land + AI toggle + snapshot | `/video_feed`, `/api/telemetry`, `/api/ws`, `/api/ai/status`, `/api/ai/toggle`, `/api/camera/snapshot`, `/api/mavlink/{arm,takeoff,rtl,land}` |
| **Mission** | Map waypoint editor (click to add, drag to move, per-point alt/speed/action), upload + start, saved list | `/api/mission/upload`, `/api/mission/start`, `/api/mission/list`, telemetry for home center |
| **Detections** | Detection log (GPS or "unlocated"), environmental report + export | `/api/ai/detections`, `/api/ai/report` |
| **System** | Health lights, Pi metrics, camera/AI status, live tuning, link preference | `/api/health`, `/api/system/pi`, `/api/camera/status`, `/api/ai/status`, `/api/config`, `/api/config/save`, `/api/mavlink/prefer` |

Cross-cutting:

- **PIN gate** (`/api/auth/verify_pin`) — simple lock screen, session kept per-tab.
- **Ping** (`/api/ping`) every 4 s — backend-reachability, distinct from drone health.
- **Undervoltage / throttle banner** from `/api/system/pi` `throttledState` — a
  full-width, pulsing, impossible-to-miss banner (this fault has crashed the
  stream before), never buried in settings.
- **Staleness everywhere** — every live block shows `live / stale / disconnected`
  with a "last updated" age. WebSocket with 2 s auto-reconnect and HTTP polling
  fallback.
- **`{success, message}` handling** — every mutating call checks `success` and
  shows `message` as a toast (including the takeoff altitude-clamp note), never
  relying on HTTP status.

## Design

**"Mission control" dark theme**, modelled on a modern drone-GCS command
console. Near-black base (`#0A0C0F`) with a full-bleed satellite map, frosted
glass panels (`backdrop-filter` blur), a left icon rail, and a top status strip.
Orange (`#F26B2E`) is the brand/active accent; mint (`#34D399`) is the secondary
selection colour. Reserved status colours used nowhere else: green `#34D399`,
amber `#F59E0B`, red `#EF4444`. Tabular-numeral mono for all telemetry.

Signature motion: a **cinematic 3D-panel-tilt** intro (the whole console tilts
into place on load), a rotating/pulsing **radial launch control** on the map,
live **sparklines** in the System Overview tiles fed by a rolling buffer of real
telemetry, and an FPV-style **speed/altitude HUD** over the video feed.

All artwork (icons, drone glyph, radial control, HUD) is original and the UI
carries VARUNA's own branding. Satellite tiles are fetched client-side from Esri
World Imagery (a map-tile host, not the backend); the map degrades gracefully
offline. The layout is responsive — floating panels over the map on tablet/
desktop, a stacked layout with a bottom nav on phones.

## Notes for the backend owner

No new endpoints were invented and no response shapes were assumed rigidly —
telemetry, `/api/config`, and `/api/system/pi` are all read **defensively**
(missing fields render as "no data", not 0). No `[NEEDS BACKEND CHANGE]` items
were required to build this UI. Two things worth confirming on-device (behavior,
not new endpoints):

- **`/api/ws` message shape** — the client unwraps `{telemetry|data|...}` or a
  bare object and merges fields by common aliases. If your socket wraps payloads
  differently, tell me the exact shape and I'll match it precisely.
- **`/api/auth/verify_pin`** — the gate treats HTTP 401 or `{success:false}` as
  "wrong PIN" and anything else as success. If auth is disabled server-side,
  decide whether to keep the gate.
