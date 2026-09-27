# VARUNA AI — Ground Control UI

Premium, field-first frontend for the VARUNA river-cleanup drone. React + Vite +
Tailwind + Framer Motion. Talks to the existing FastAPI backend on the Raspberry
Pi over the **exact** endpoints it already exposes — no backend changes.

> **The build never runs on the Pi.** The Pi has 1 GB RAM and cannot build a
> modern JS app. Build on a laptop/CI, copy only `dist/` to the Pi.

## Two ways to run the same app

One codebase, one `dist/`, two shells:

| | Command | How it reaches the Pi |
| --- | --- | --- |
| **Browser (dev)** | `npm run dev` | Vite's dev proxy (§1) |
| **Windows app** | `npm run electron:build` → installer (§4) | The app's own built-in proxy |

AI trash detection runs **on the machine** in both (local ONNX models, no
backend and no API key), so it works even with the Pi offline.

---

## 1. Develop on the laptop (against the real Pi)

```bash
npm install
cp .env.local.example .env.local     # then edit it
npm run dev
```

Edit `.env.local` so the dev server proxies to your real backend — you'll see
**live** video/telemetry/detections while iterating. The Pi is reached over
**Netbird** (a private WireGuard mesh), so use its mesh address — run
`netbird status` on the Pi to find it:

```
VITE_DEV_API_TARGET=http://varuna-pi.netbird.cloud:8000
# or by IP, if you'd rather not rely on Netbird DNS:
# VITE_DEV_API_TARGET=http://100.92.14.7:8000
```

Plain `http://` is correct here — WireGuard already encrypts the link, so there
is no TLS certificate to manage.

This value is **dev-only**. It is read by `vite.config.js` for the dev *and*
preview proxies and is *never* compiled into the production bundle.

Because the proxy forwards server-side, the browser only ever talks to
`http://localhost` — which means **no CORS to configure and no mixed-content
blocking**. Leave `VITE_API_BASE` unset to keep it that way. Set it (or fill in
System → Connection) only if you want the browser to call the Pi directly, which
does require CORS headers from FastAPI.

**The Pi must bind `0.0.0.0:8000`, not `127.0.0.1`** — otherwise the Netbird peer
cannot reach it. Endpoints the app expects: `/api/ws` (telemetry WebSocket),
`/video_feed` (MJPEG), and the `/api/*` routes in the table below.

## 2. Build for production

```bash
npm run build        # -> dist/
npm run check:clean  # verifies dist/ has no dev host baked in
```

`check:clean` is the zero-edit guarantee: it fails loudly if `localhost`,
`127.0.0.1`, or any hardcoded LAN `http://IP:port` leaked into the bundle.
Netbird addresses (`100.64.x.x`–`100.127.x.x`, `*.netbird.cloud`) are allowed —
they're private to the mesh and meaningless to anyone outside it. The app calls
the API via **relative paths** resolved against `window.location.origin`, so the
same `dist/` works unmodified whether it's served from the Pi, from the Vite
preview proxy, or reached over any mesh address.

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

## 4. Run it as a Windows app

```bash
npm run electron:dev     # dev: app window on the Vite server, hot reload intact
npm run electron:start   # run the built app locally
npm run electron:build   # -> release/  (installer + portable .exe)
```

`electron:build` produces `VARUNA GCS-Setup-<version>.exe` (Start-menu and
desktop shortcuts, user-level install — no admin needed) and a portable
`.exe` that runs without installing.

**How it works, and why.** The desktop app doesn't load `dist/` off disk with
`file://`. It runs a tiny HTTP server on `127.0.0.1` and points the window at
that, because three things have to be true at once and loopback is the only
place they all are:

- `/models/*.onnx` and ONNX Runtime's `/ort/` wasm are **absolute paths** — they
  need a real HTTP origin, which `file://` isn't.
- The webcam and microphone need a **secure context** — `file://` isn't one, but
  Chromium treats loopback as trustworthy.
- The Pi is plain `http://` over Netbird. An `http` page calling `http` is fine;
  an `https` (or custom-scheme) page would get those calls **blocked as mixed
  content**.

That server also proxies `/api`, `/video_feed`, `/stream` and `/tune` to the Pi —
the same job Vite's dev proxy does — so there's **no CORS to configure**. Set the
Pi's address in **System → Connection**; it's stored per-user and applies without
restarting. **Test connection** runs from the app's own process, so it reports the
real fault (DNS, refused, timeout) instead of a generic browser error.

> The loopback port is deliberately **fixed**. The app's settings, API keys and
> detection log live in `localStorage`, which is scoped to the origin — a port
> that changed per launch would look like all your data had been wiped.

---

## What's in here

| Screen | Purpose | Endpoints used |
| --- | --- | --- |
| **Map (home)** | Mission-control command view: satellite map centerpiece with the live aircraft, floating glass panels (Selected Aircraft, System Overview w/ live sparklines, Platform Health, Event Log), a radial ARM/launch control, and a Live-Feed panel with speed/altitude HUD tapes | telemetry, `/api/ws`, `/api/health`, `/api/ping`, `/api/system/pi`, `/api/camera/status`, `/api/ai/status`, `/api/ai/detections`, `/api/mavlink/arm`, `/video_feed` |
| **Live** | Video centerpiece + core telemetry + arm/takeoff/RTL/land + AI toggle + snapshot | `/video_feed`, `/api/telemetry`, `/api/ws`, `/api/ai/status`, `/api/ai/toggle`, `/api/camera/snapshot`, `/api/mavlink/{arm,takeoff,rtl,land}` |
| **Mission** | Map waypoint editor (click to add, drag to move, per-point alt/speed/action), upload + start, saved list | `/api/mission/upload`, `/api/mission/start`, `/api/mission/list`, telemetry for home center |
| **Detections** | Detection log (GPS or "unlocated") with persisted photos and an optional ✓/✗ on each row, environmental report + export | `/api/ai/detections`, `/api/ai/report` |
| **System** | Health lights, Pi metrics, camera/AI status, self-learning stats + dataset export, offline map download, live tuning, link preference | `/api/health`, `/api/system/pi`, `/api/camera/status`, `/api/ai/status`, `/api/config`, `/api/config/save`, `/api/mavlink/prefer` |

## The detector teaches itself

The trash model gets better the more the app is flown, with nobody labelling
anything. Three signals the app already produces are used as labels:

| Signal | Meaning | Verdict |
| --- | --- | --- |
| **Temporal consistency** | A box that survives many frames while the aircraft moves is a real object | positive |
| **Flicker** | A box that appears and dies within a few frames is noise | negative |
| **Cross-model disagreement** | The trash model fires on something the person/face model calls a human | negative |
| **Operator ✓/✗** | Optional, on any row in the Detections tab | either, weighted highest |

Those verdicts do two things. **Live**, every sample keeps a cheap visual
fingerprint (`src/lib/embed.js`), and incoming boxes matching a known false
positive are suppressed immediately — reject a pile of clothes once and clothes
stop scoring as trash, with no retraining and no restart. **Offline**, the same
verdicts accumulate as a real YOLO dataset: clean, un-annotated frames plus box
coordinates, with negatives exported as background images, which is by far the
most effective way to stop a model hallucinating. System → Self-learning shows
the counts and exports the archive; unzip it and run `python train.py`.

Two limits stop a self-training loop from amplifying its own mistakes: the live
filter never overrules a high-confidence detection, so a bad negative can dim a
weak class but can never blind the detector; and near-duplicate samples are
dropped so the dataset stays diverse. Both are in `src/lib/selfLearn.js`.

Each detection therefore stores **two** images — the boxed frame the operator
saw, used in the Detections tab and the Word report, and a clean frame with no
overlay, used only for training. A training image with rectangles painted on it
teaches the model to find rectangles.

Cross-cutting:

- **Detection photos persist** — in IndexedDB, not localStorage, so a JPEG per
  location doesn't blow the ~5MB quota. Evidence survives a reload, a relaunch
  and a reboot, and the Word report still has its photos days later. Capped at
  ~400MB and pruned oldest-first; training frames are pinned and never pruned.
- **Offline maps** — every satellite tile any map draws is cached locally and
  re-served from there, including with no connection at all. An area can be
  downloaded ahead of a flight from System → Offline maps. Caching is
  opportunistic: if storage or the tile host's CORS headers are unavailable,
  the map falls back to loading tiles normally.
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
