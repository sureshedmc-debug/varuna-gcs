# VARUNA drone backend (drone Raspberry Pi)

Runs on the **drone's** Raspberry Pi. The VARUNA app (Home, Live, Missions,
System tabs) talks to it over NetBird. It talks to the drone's Pixhawk
(ArduCopter) with **pymavlink**, and streams the camera at **1280×720, 30 fps**.

```
 VARUNA app (laptop) ──NetBird──▶ drone Pi: this service ──MAVLink (TELEM2 or USB)──▶ Pixhawk + GPS
   Live: video + AI detection        /api/camera/h264, /video_feed (720p)          ArduCopter flies:
   Missions: plan → upload → start   missions → ArduCopter mission                   take-off, waypoints,
   flight commands, telemetry         arm / take-off / RTH / land / STOP              loiter, land, RTL
```

**No Pi on the drone?** A phone can carry the video (IP Webcam) and an ESP32 the
telemetry, with this backend running on the laptop instead: see
[phone-link/README.md](phone-link/README.md).

## Easiest way: the VARUNA Drone Pi Tool

Double-click **VARUNA Drone Pi Tool.exe**. Build it with `drone-installer\build.bat`; it lands in `drone-installer\dist\`.

1. Enter the drone Pi's IP, username and password.
2. Choose **1) Full setup**. It asks how the Pixhawk is wired (TELEM2 / USB) and which camera you have (auto-detect — the default — USB webcam, or Pi camera module).
3. Over SSH it then:
   - installs everything (including ffmpeg for the camera)
   - copies this backend
   - sets up the serial port and the camera
   - installs the auto-start service
   - optionally joins NetBird
   - checks that the Pixhawk and the 720p30 video work

When it's done, it prints the address for the app: System → Connection.

The same tool can also:
- **9) Camera test** — takes a picture with the drone camera and opens it on the laptop
- **13) Camera** — switch between auto-detect, USB webcam and Pi camera module; it sets up the camera module too
- update the code (this also switches the camera to auto-detect: USB webcam or Pi camera module, names the connected camera module in the Pi's boot settings so it is found on every boot, and turns the Pi's Wi-Fi power saving off; it also switches the Pi's desktop off — the drone doesn't use it, and it takes ~350 MB of memory. To get it back: `sudo systemctl set-default graphical.target`, then reboot)
- show status and live logs
- restart the service
- open an SSH terminal
- reboot the Pi
- check that the backend starts on boot
- **10)** upload the VARUNA web app to the Pi

## Camera: 1280×720 at 30 fps on a Pi 3

| Camera | How it is captured | Load on a Pi 3 |
|---|---|---|
| **Pi camera module** (recommended) | `rpicam-vid` with the Pi's hardware H.264 encoder, 720p | low |
| USB webcam, `camera_codec` = `h264` | its raw 640×480 picture into the Pi's hardware H.264 encoder (`h264_v4l2m2m`) | low |
| USB webcam with MJPEG 720p30 | ffmpeg passes the camera's own JPEG frames through untouched | low CPU, but 3–4× the bandwidth |
| USB webcam without MJPEG | ffmpeg encodes the raw frames on the Pi | high: may drop below 30 fps |

The camera module's video goes to the app as **H.264** (`/api/camera/h264`), much sharper than MJPEG for the same bandwidth: 720p at 15 fps and 3 Mbit/s by default (`video_bitrate_kbps`, up to 15000). The app decodes it in the browser (WebCodecs); browsers that can't — the app opened over plain `http://` from another computer — get MJPEG from `/video_feed` instead, which the Pi then decodes from the H.264 (more CPU). USB webcams send H.264 too (640×480, from the same hardware encoder); if the encoder can't start (Pi 5, or an ffmpeg without `h264_v4l2m2m`) they fall back to their own MJPEG. `camera_codec` = `mjpeg` in System → Live tuning switches both cameras to MJPEG.

With `camera_codec` = `h264` the camera module runs at `stream_fps` (15), not 30: H.264 frames depend on each other, so frames can't be dropped for the stream later.

**Standby:** the camera only runs while someone watches it (the app's video, `/video_feed`, a snapshot). 30 s after the last viewer leaves it switches off — camera and encoder running nonstop is what warms the Pi — and it comes back in about 2 s when the video is opened again. System → Camera shows STANDBY meanwhile.

**Where detections are:** with `/api/camera/h264?pose=1` every frame carries the drone's position, height, heading, roll and pitch at the moment it was taken (telemetry at 10 Hz — 20 Hz over USB — interpolated to the frame's capture time). The app's detection places each item on the map from the pose of the very frame it found it in, not from telemetry that arrived up to a second later, so plastic seen while the drone moves or turns lands where it really is. Without a Pixhawk (or with a USB webcam) the app uses the live telemetry as before.

**Camera module not found after a reboot?** With `camera_auto_detect=1` the Pi's firmware probes for the camera at boot and sometimes misses it (Pi 3 with the camera v1 especially). The setup tool's Update finds which camera module is connected (starting it on the spot if it wasn't found) and writes `camera_auto_detect=0` + `dtoverlay=<sensor>` (e.g. `ov5647`) to `/boot/firmware/config.txt`, so it loads on every boot. The original file is kept as `config.txt.before-varuna`.

With `camera_source` = `auto` (the default) the drone uses whichever camera is connected: the Pi camera module if there is one (its hardware H.264 is the coolest, lowest-delay stream), else the USB webcam. If the camera in use fails or is unplugged, it switches to the other one by itself. You can also pick the camera in the app: System → Live tuning → `camera_source` (it switches straight away; "Save to disk" keeps it after a restart).

**Phone camera:** `camera_source` = `url` (or `auto` with `camera_url` set) reads a phone's MJPEG stream, e.g. the Android IP Webcam app at `http://<phone NetBird IP>:8080/video`. The phone's JPEGs pass straight through to the app, the AI detection and snapshots; set the resolution and quality in the phone app. See [phone-link/README.md](phone-link/README.md).

If the camera can't do 720p30, the backend falls back by itself: first to encoding on the Pi, then to 640×480. System → Camera in the app shows the real resolution and fps.

MJPEG video at 720p, 15 fps and quality 55 needs about **4 Mbit/s** to the laptop (H.264: 3 by default). On a weak link, lower **stream_fps**, **video_bitrate_kbps** (H.264) or **camera_quality** (MJPEG) in System → Live tuning. The setup tool turns the Pi's Wi-Fi power saving off (it makes the video stall); the Pi 3B+ also streams more smoothly on 5 GHz Wi-Fi than on 2.4 GHz.

## Pixhawk (ArduCopter) settings

| Parameter | Value | Why |
|---|---|---|
| `SERIAL2_PROTOCOL` | 2 | MAVLink2 on TELEM2 (skip if you use USB) |
| `SERIAL2_BAUD` | 57 | 57600 baud, which matches `telem2_baud` |
| `BRD_SER2_RTSCTS` | 0 | The Pi's 3-wire cable has no flow-control wires |
| `FS_GCS_ENABLE` | 1 | If the Pi stops sending heartbeats → failsafe (RTL / land) |
| `FS_OPTIONS` | 17 | Bit 0: keep flying the mission if the RC transmitter is lost (it still RTLs at the end) |
| `RTL_ALT` | e.g. 1500 | Height (cm) the drone climbs to before coming home |
| `DISARM_DELAY` | 10 | Motors disarm 10 s after landing / sitting armed on the ground |
| `FENCE_ENABLE` | 1 | Keep the drone inside a safe area |
| `FENCE_TYPE` | 3 | Height limit + a circle around home for manual flying. During a mission the Pi switches it to 5 (height + the mission fence) and back afterwards |
| `FENCE_ALT_MAX` / `FENCE_RADIUS` | 120 / 300 | Height limit (m, the Pi keeps it at `max_altitude_m`) and the manual-flying circle (m) |
| `FENCE_ACTION` | 1 | Crossing a fence → RTL (or LAND if RTL isn't possible) |

### Mission fence

With every mission upload the Pi also uploads a geofence polygon drawn `mission_fence_m` (30 m) around home and all the waypoints — the convex hull of a 30 m circle around each point, so every leg and the way home lie well inside it. The app's Missions map draws the same orange dashed shape while you plan. On **Start** the Pi switches the Pixhawk's fence to height limit + that polygon; when the mission is over (landed and disarmed, or cleared) it puts the fence back to what it was, so a manual flight somewhere else isn't caught by an old mission's area. Waypoints must stay 5 m under the height fence. `mission_fence_m = 0` turns the mission fence off. With the fence on, arming needs a GPS position.

Wiring for TELEM2:
- TELEM2 TX → Pi GPIO15 (pin 10)
- TELEM2 RX → GPIO14 (pin 8)
- GND → GND (pin 6)

Power the Pi from its own 5 V regulator.

## What the app's buttons do here

| App | Pixhawk |
|---|---|
| ARM | Arms in the current mode if it is a safe one (STABILIZE, ALT_HOLD, LOITER, GUIDED, POSHOLD); otherwise switches to GUIDED first. It never arms in AUTO, so the drone can't move off by itself. |
| TAKEOFF | GUIDED, arm if needed, then take off to the height you chose |
| RTH | RTL |
| LAND | LAND here |
| STOP (emergency) | LAND here, which cancels any mission |
| Mission → Start | Take off, then fly each waypoint (waypoint / loiter / land), then RTL. If the last point is "land", it lands there instead. |
| Pause (API) | GUIDED: hovers in place without needing an RC stick |

If the Pixhawk refuses something (pre-arm checks, no GPS fix), the app shows the Pixhawk's own reason. If a start fails after arming, the motors are disarmed again.

## Keyboard flight (the app's Control tab)

The Control tab flies the drone from the laptop keyboard over a plain live view
(no AI detection). The boat is driven with its game controller instead; the
two never share inputs.

| Key | Does |
|---|---|
| W / S, A / D | Forward / back, left / right (relative to the nose) |
| ↑ / ↓, ← / → | Climb / descend, turn left / right |
| Shift | Slow (40 %) |
| G | Take keyboard control: GUIDED, holding position (only in the air) |
| Space | BRAKE: stop now |
| Esc | Release: BRAKE (hovers in place) |

The keys are not raw sticks. The app sends the held keys to `/api/control` 20
times a second, and the Pi (`control.py`) turns them into GUIDED velocity commands.
ArduCopter keeps the drone level and in place by itself, so no keys means hover.

Safety (tested on ArduCopter SITL with `test_keyboard.py`):

* **When it acts:** only in GUIDED, armed and in the air. Any mode button, or the RC
  transmitter's mode switch, ends keyboard flight at once.
* **Limits on the Pi:**
  * speed `kb_speed_mps`, climb `kb_climb_mps`, turn `kb_yaw_dps`;
  * never below `kb_min_alt_m` by keyboard (land with LAND), never above
    `max_altitude_m`, never farther than `max_distance_m` from home.
* **App:** only flies while its window has focus and no text field or dialog is
  active. Losing focus releases every key (hover). Leaving the Control tab parks
  the drone in BRAKE, not LOITER, because LOITER follows the transmitter's
  throttle stick and a stick left low makes the drone sink.
* **App silent:** hover within 0.5 s; after `kb_lost_s` (20 s) → `kb_lost_action`
  (return home).
* **Pi dies:** ArduCopter stops 3 s after the last command and holds. With
  `FS_GCS_ENABLE = 1` it then returns home. The Drone Pi Tool's menu 12 checks
  this and can set it.

## Test it on a laptop (no drone)

```bash
cd drone-pi
python -m venv venv && venv\Scripts\activate
pip install -r requirements.txt httpx websockets
```

Run against ArduPilot's real ArduCopter simulator. Use the Windows SITL build from
`firmware.ardupilot.org/Tools/MissionPlanner/sitl/` plus `copter.parm` from ArduPilot's
`Tools/autotest/default_params/`:

```bash
ArduCopter.elf --model quad --speedup 3 --defaults copter.parm -I1 --home 17.4239,78.4738,10,0 --serial0 tcp:0
python main.py --connection tcp:127.0.0.1:5770 --camera test
python test_e2e.py
```

`test_e2e.py` covers 37 checks:
- camera at 720p, H.264 stream, snapshot, MJPEG stream
- take-off, RTL, a land-at-point mission
- emergency stop, the link-loss failsafe
- live tuning, link switching, WebSocket

`test_keyboard.py` tests keyboard flight on its own: run SITL with `-I0`. The
test holds port 5760 and runs the backend on 5762, so it can kill the backend
like a crashed Pi.

## Settings (`drone_config.json`)

The tool writes this file. You can also edit it, or set `DRONE_<KEY>` environment variables. The live-tunable ones can be changed from the app.

| Key | Default | Meaning |
|---|---|---|
| `link_prefer` | `auto` | `usb`, `telem2`, or `auto` (USB if plugged in, else TELEM2). The app can also change it (System → Advanced). Over USB the Pixhawk can go in any of the Pi's USB ports (it is found by its `/dev/serial/by-id` name, which survives a replug), the Pi switches to it within a second of plugging in, and it asks for telemetry at 10 Hz and position/attitude at 20 Hz (TELEM2: 5 Hz and 10 Hz). |
| `camera_source` | `auto` | `auto` (USB webcam if plugged in, else Pi camera module), `usb`, `csi`, `test` or `off` (live) |
| `camera_width/height/fps` | 1280/720/30 | Capture size and rate |
| `camera_codec` | `h264` | Pi camera module video: `h264` (hardware encoder) or `mjpeg` (live) |
| `video_bitrate_kbps` | 3000 | H.264 bitrate (live) |
| `stream_fps` | 15 | Frames per second sent to the app (live) |
| `takeoff_alt_m` | 10 | Default take-off height (live) |
| `max_altitude_m` | 120 | Highest take-off or waypoint allowed (live) |
| `loiter_time_s` | 10 | Hover time at "loiter" waypoints (live) |
| `max_distance_m` | 1500 | Reject waypoints farther than this from home (live) |
| `mission_fence_m` | 30 | Geofence this far around home + the waypoints during a mission; 0 = off (live) |
| `operator_lost_action` | `none` | If the app goes silent mid-mission: `none`, `rtl` or `land` (live) |
| `operator_pin` | empty | Optional PIN for `/api/auth/verify_pin` |
