# VARUNA project notes

A summary of the VARUNA work gathered from past Claude sessions, saved so later
sessions (cloud or laptop) can pick up where things were left. Last updated
2026-11-27.

## What the project is

VARUNA AI is a river-cleanup drone and boat system. `varuna-gcs` is its ground
control app.

- **Frontend:** React + Vite + Tailwind + Framer Motion. The same build also
  ships as a Windows desktop app through Electron (`npm run electron:build`).
- **Backend:** FastAPI on a Raspberry Pi, reached over Netbird at
  `varuna-pi.netbird.cloud:8000`. The Pi has 1 GB RAM, so the app is built on a
  laptop or CI and only `dist/` is copied to the Pi. See `README.md` and
  `RASPI_BACKEND_GUIDE.md`.
- **AI detection:** runs on the laptop with local ONNX models, so it works even
  when the Pi is offline.

## Done on `main`

- Plastic detector trained on TACO, plus a second detection model that can be
  picked as a test option.
- Self-learning filter that learns from the operator's feedback and obeys their
  answers.
- Assistant endpoints in the desktop app: Gemini, OpenRouter and custom.
- Voice assistant: wakes reliably, speaks Hindi and English, talks like a
  companion.
- Tidier layout: auto-hiding sidebar, slimmer headers, cleaner Home.
- Three intro effects: sensor scan, staged light power-up, launch mist.

## Boat Vision (branch `boat-vision`, only on the laptop)

Hardware: Raspberry Pi Zero (32-bit), Pi Camera 3 above the intake ramp tilted
about 15° down, turbidity sensor read through an ADS1115 ADC, Pixhawk running
ArduRover. The Pi Zero is too slow to run the AI models, so the app does the
seeing and the boat makes the decisions.

1. **Last-metre homing:** within 8 m of a plastic point the boat switches from
   GPS to the camera, steers onto the item, drives through it and checks the
   ramp.
2. **Wildlife-safe mode:** holds when a bird, person or animal is in the zone
   ahead, and resumes once the zone has been clear for 5 s. After 60 s it asks
   the operator to Wait, Resume or Skip.
3. **Catch counter:** a ramp motion counter counts and names each item (bottle,
   bag, cup, container) with a photo, and warns when the bin is 90% full.
4. **Water turbidity:** logs NTU with GPS every 2 s, has a "Measure here" button
   (holds and averages 20 s), and calibrates once in clear water.

App changes: new **Boat Vision** and **Water Lab** tabs, plus a boat row on
Home, widgets on the Boat tab, upload options on Collect, new report sections
and an assistant tool. The Boat Pi Tool gets a 32-bit install path, a camera and
sensor setup step, and menu items 9 to 12 (camera test, turbidity check,
clear-water calibration, find the Pixhawk).

Testing: in the simulator, all 37 boat vision checks and the 31 existing boat
checks pass. The real app works against the simulated boat, and the Boat Pi
Tool works on a fake 32-bit Pi. **Not yet tuned on the real boat:** camera
tilt, ramp line, motion sensitivity and turbidity calibration.

### Open items

- `boat-vision` is **not pushed to GitHub** and has uncommitted changes. From
  the laptop, run:
  `git add -A && git commit -m "Boat vision work" && git push -u origin boat-vision`
- The flaky boat-pi vision test fix (commit `b89e164`) is committed on
  `boat-vision` but not pushed.
- The last "VARUNA AI" session was waiting on: commit to `boat-vision` and
  rebuild the desktop app?
- The "varuna ai boat" session asked for the phase 2 goals and an F1 score
  target of 0.99. Neither has been defined yet.

## Boat status (late November 2026)

From the boat chat's work on the `boat-vision` branch (8 commits not yet on
`main`) and the boat's Pixhawk parameter backups:

- **Name:** Nirmal Dhara Jalyan, thermocol (EPS) hull, tricolour.
- **On-board computer:** an Android phone (vivo Y11 5G) running the
  **VARUNA Boat Link** app (`boat-phone/`) replaces the Raspberry Pi. It streams
  the camera (MJPEG, port 8080), sends its GPS to the Pixhawk (`GPS1_TYPE 14`)
  and bridges MAVLink to the Pixhawk over USB OTG (TCP port 5760). An ESP32
  Wi-Fi bridge (`boat-esp32/`) is the other link.
- **Boat backend:** `boat-pi/` now runs on the operator's laptop and reaches the
  phone over NetBird first, so everything works over mobile data.
- **Drive:** one forward-only BLDC motor (`SERVO3_FUNCTION 70`) with a rudder
  servo (`SERVO1_FUNCTION 26`); FlySky FS-i6 transmitter for manual control.
  The user reports the submerged BLDC is not working and is moving to an air
  propeller (see `boat-design/`, VARUNA AI Pod with air-prop drive).
- **Camera-guided collection (19 Nov):** the motor runs only for verified
  plastic (plastic class, 2 frames running or once at 80%, tracking, distance
  from camera geometry, target lock), stops inside scoop range, then the intake
  roller ramp lifts the item into the bin. Safety: stops on target loss, app
  watchdog, disarm, mode change, STOP/pause; a detection never arms the boat.
- **Website:** `src/site/` (Vercel). The "The boat" section and FAQ describe the
  above; keep them in step when the boat changes.

## Other branches on GitHub

- `claude/kind-goodall-70os2j`, `claude/kind-goodall-koo00k`,
  `claude/kind-goodall-taowhd`: daily idea logs and briefs on detection
  accuracy, one commit each on top of `main`.

## Saved pages (claude.ai artifacts)

- [VARUNA Boat Vision Plan](https://claude.ai/artifact/R5FgAPG1D9qnX6Kk7wJXzA)
- [VARUNA Home Dashboard](https://claude.ai/artifact/Jc5J9EhQM2Ed2qfhXMo1qN)
- [Varuna GCS DJI-style mockup](https://claude.ai/artifact/LDUxDUJnqgoNZJBCBYDCh9)
