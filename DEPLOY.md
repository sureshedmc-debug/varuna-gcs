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

## Website (Vercel build only)

Vercel builds with `vite build --mode site` (`.env.site` sets `VITE_SITE=1`). That puts a website in front of the app:

- `/` (also `/explore`): the home page, with **Open the app** and **Explore Varuna** at the top and Log in in the top bar. Below them: the problem, how it works, the machines, a comparison, the gallery and film, who made it, and a feedback form.
- **Download the VARUNA app** (hero button, top bar, menu, footer): opens a dialog with Android, Windows and "Install on this device". It reads the newest GitHub release of `sureshedmc-debug/varuna-gcs` at run time (the `.apk`, and the `Setup*.exe` / `.exe` / `.msi`), so publishing a release with those files attached updates the website with no rebuild. Until then the Android and Windows rows say "Coming soon". `VITE_DOWNLOAD_ANDROID` / `VITE_DOWNLOAD_WINDOWS` on Vercel take priority, and `VITE_RELEASES_REPO` points it at another repo.
- `/try`: anyone can test the plastic detector on their own webcam, no sign-in. It runs in the browser (onnxruntime-web, `public/models`), saves nothing and asks for no location. In the website build the app's Live tab also uses the visitor's webcam (started with a click) instead of the backend's test camera; the Drone button still switches to it.
- `/login` and `/app`: `/app` plays the app's own intro, then opens the app only for a signed-in user (sign-in comes first otherwise). Then the "Install VARUNA AI" card slides up from the bottom, which installs the site as an app (`public/sw.js`, `public/site/manifest.webmanifest`). Set `VITE_DOWNLOAD_ANDROID` / `VITE_DOWNLOAD_WINDOWS` on Vercel to links of the APK / installer to add download buttons to that card.

The media in `public/site` is cut from *varuna project videos*. The desktop and Android builds drop `public/site` and `sw.js` from `dist`, and never load the website code. To try it locally, run `npx vite --mode site`.

Feedback goes to the backend (`POST /site/feedback`, rewritten by Vercel). Each entry is printed to the Render log as a `[feedback]` line and appended to `feedback.csv`, which is wiped on restart. Download it with:

```bash
curl -H "Authorization: Bearer $FEEDBACK_KEY" https://varuna-gcs-api.onrender.com/site/feedback
```

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
