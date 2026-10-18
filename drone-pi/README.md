# VARUNA drone backend (drone Raspberry Pi)

Runs on the **drone's** Raspberry Pi. The VARUNA app (Home, Live, Missions,
System tabs) talks to it over NetBird. It talks to the drone's Pixhawk
(ArduCopter) with **pymavlink**, and streams the camera at **1280×720, 30 fps**.

```
 VARUNA app (laptop) ──NetBird──▶ drone Pi: this service ──MAVLink (TELEM2 or USB)──▶ Pixhawk + GPS
   Live: video + AI detection        /video_feed  (MJPEG 720p30)                   ArduCopter flies:
   Missions: plan → upload → start   missions → ArduCopter mission                   take-off, waypoints,
   flight commands, telemetry         arm / take-off / RTH / land / STOP              loiter, land, RTL
```

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
- update the code (this also switches the camera to auto-detect: USB webcam or Pi camera module)
- show status and live logs
- restart the service
- open an SSH terminal
- reboot the Pi
- check that the backend starts on boot
- **10)** upload the VARUNA web app to the Pi

## Camera: 1280×720 at 30 fps on a Pi 3

| Camera | How it is captured | Load on a Pi 3 |
|---|---|---|
| **USB webcam with MJPEG 720p30** (recommended) | ffmpeg asks the camera for its own JPEG frames and passes them through untouched | very low |
| USB webcam without MJPEG | ffmpeg encodes the raw frames on the Pi | high: may drop below 30 fps |
| Pi camera module | `rpicam-vid` encodes MJPEG | moderate |

With `camera_source` = `auto` (the default) the drone uses whichever camera is connected: the USB webcam if one is plugged in, else the Pi camera module. If the camera in use fails or is unplugged, it switches to the other one by itself. You can also pick the camera in the app: System → Live tuning → `camera_source` (it switches straight away; "Save to disk" keeps it after a restart).

If the camera can't do 720p30, the backend falls back by itself: first to encoding on the Pi, then to 640×480. System → Camera in the app shows the real resolution and fps.

Video at 720p30 needs about **8–25 Mbit/s** to the laptop. On a weak link, lower **stream_fps** in System → Live tuning; the camera keeps running at 30 fps.

## Pixhawk (ArduCopter) settings

| Parameter | Value | Why |
|---|---|---|
| `SERIAL2_PROTOCOL` | 2 | MAVLink2 on TELEM2 (skip if you use USB) |
| `SERIAL2_BAUD` | 57 | 57600 baud, which matches `telem2_baud` |
| `FS_GCS_ENABLE` | 1 | If the Pi stops sending heartbeats → failsafe (RTL / land) |
| `RTL_ALT` | e.g. 1500 | Height (cm) the drone climbs to before coming home |
| `FENCE_ENABLE` | 1 | Keep the drone inside a safe area |

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
- camera at 720p30, snapshot, MJPEG stream
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
| `link_prefer` | `auto` | `usb`, `telem2`, or `auto` (USB if plugged in, else TELEM2). The app can also change it (System → Advanced). |
| `camera_source` | `auto` | `auto` (USB webcam if plugged in, else Pi camera module), `usb`, `csi`, `test` or `off` (live) |
| `camera_width/height/fps` | 1280/720/30 | Capture size and rate |
| `stream_fps` | 30 | Frames per second sent to the app (live) |
| `takeoff_alt_m` | 10 | Default take-off height (live) |
| `max_altitude_m` | 120 | Highest take-off or waypoint allowed (live) |
| `loiter_time_s` | 10 | Hover time at "loiter" waypoints (live) |
| `max_distance_m` | 1500 | Reject waypoints farther than this from home (live) |
| `operator_lost_action` | `none` | If the app goes silent mid-mission: `none`, `rtl` or `land` (live) |
| `operator_pin` | empty | Optional PIN for `/api/auth/verify_pin` |
