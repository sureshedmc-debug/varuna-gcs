# VARUNA boat backend (boat Raspberry Pi)

Runs on the **boat's** Raspberry Pi — a separate device from the drone's Pi.
The VARUNA app (Boat and Collect tabs) talks to it over NetBird; it talks to
the boat's Pixhawk (ArduRover, boat frame) with **pymavlink**.

```
 VARUNA app (laptop)  ──NetBird──▶  boat Pi: this service  ──MAVLink (TELEM2)──▶  Pixhawk + GPS
   Collect tab: pick plastic         turns the points into        drives to each point in AUTO,
   → Upload → Start                  an ArduRover mission,        holds there, returns home
   Boat tab: live status, commands   uploads + starts it,         (MISSION_ITEM_REACHED → app
                                     streams telemetry back        marks the item collected)
```

The boat also has a **camera and a water sensor** (see [Boat camera and water
sensor](#boat-camera-and-water-sensor)): last-metre homing onto each item,
wildlife-safe mode, a catch counter on the intake ramp, and water turbidity
along the route.

## Easiest way: the VARUNA Boat Pi Tool

Double-click **VARUNA Boat Pi Tool.exe**. Build it with `boat-installer\build.bat`; it lands in `boat-installer\dist\`. Enter the boat Pi's IP, username and password, then choose **1) Full setup**. It does sections 4–5 below automatically over SSH:
- installs the packages and libraries
- copies this backend
- sets up the Pixhawk serial port
- turns on the Pi Camera and I2C (turbidity sensor)
- installs the auto-start service
- optionally joins NetBird

When it's done, it prints the address to enter in the app. The same tool can also:
- update the boat code
- show status and live logs
- restart the service
- open an SSH terminal on the Pi
- reboot the Pi
- take a camera test picture (9), check the turbidity sensor (10), calibrate it in clear water (11), show what the Pixhawk search tried (12)

It works on 32-bit Raspberry Pi OS too (Pi Zero): there FastAPI and pydantic come from the OS packages, because compiling pydantic on a Pi Zero takes hours. Use Raspberry Pi OS based on Debian 13 ("trixie"), whose FastAPI is new enough.

You still do section 3 (Pixhawk parameters) yourself in Mission Planner or QGroundControl.

## 1. Try it on a laptop first (no hardware)

The backend has a built-in simulated Pixhawk that speaks real MAVLink, so the
whole chain can be tested before anything is wired:

```bash
cd boat-pi
python -m venv venv
venv\Scripts\activate            # Windows   (Linux/Mac: source venv/bin/activate)
pip install -r requirements.txt
python main.py --sim --port 8001
```

- `npm run dev`: the app's Vite proxy already points `/boat` at port 8001
  (override with `VITE_DEV_BOAT_TARGET` in `.env.local`).
- Desktop app (.exe): System → **Boat connection** → enter this PC's address with
  port 8001 → Save & reconnect.

Then open **Collect**, select the plastic, **Upload**, **Start** and watch the
boat collect on the **Boat** tab.

Automated check of the whole backend (34 checks, about a minute):

```bash
pip install httpx websockets
python test_e2e.py
```

### Test against the real ArduRover firmware (recommended before the water)

ArduPilot publishes a Windows build of its simulator (the one Mission Planner
uses) at `firmware.ardupilot.org/Tools/MissionPlanner/sitl/`. Download
`RoverStable/ArduRover.elf` and the `cyg*.dll` files from that folder into one
folder, plus `rover.parm` and `motorboat.parm` from ArduPilot's
`Tools/autotest/default_params/`. Then:

```bash
ArduRover.elf --model motorboat --speedup 5 --defaults rover.parm,motorboat.parm -I0 --home 17.4239,78.4738,10,0 --serial0 tcp:0
python main.py --connection tcp:127.0.0.1:5760 --port 8001
```

The app (Collect / Boat tabs) now drives the real firmware. Verified this way:
- upload of a 6-item mission
- hold at each item
- pause and resume
- collector servo
- return home
- auto-disarm at the end
- link-loss RTL
- a clear "no GPS fix" refusal when AUTO is not possible

## 2. Wiring (Pixhawk ↔ Pi 3)

| Pixhawk TELEM2 | Raspberry Pi 3 |
|---|---|
| TX | GPIO15 / RXD (pin 10) |
| RX | GPIO14 / TXD (pin 8) |
| GND | GND (pin 6) |

Do **not** connect the 5 V pin: power the Pi from its own 5 V buck converter.
Alternatively, plug the Pixhawk's USB port into the Pi and use `/dev/ttyACM0` at 115200.

You don't have to get the port or speed exactly right. If the Pixhawk doesn't
answer on the configured link within a few seconds, the backend tries every USB
port and TELEM2 at 57600, 115200, 921600, 230400, 460800, 500000 and 1500000
baud in turn. It saves the one that answers to `boat_config.json`. Until then,
`/api/health` → `link_error` says what it saw on each port: nothing at all
(wiring or power), or data that isn't MAVLink (wrong `SERIAL2_PROTOCOL` or baud).

## 3. Pixhawk (ArduRover) parameters

Set these with Mission Planner or QGroundControl:

| Parameter | Value | Why |
|---|---|---|
| `FRAME_CLASS` | 2 | Boat |
| `SERIAL2_PROTOCOL` | 2 | MAVLink2 on TELEM2 |
| `SERIAL2_BAUD` | 57 | 57600 baud, which matches `mav_baud` |
| `WP_RADIUS` | 1.5 | "Arrived" radius in metres (GPS is about ±2 m) |
| `WP_SPEED` | 0.8 | Default cruise speed in m/s (each mission sets its own as well) |
| `MIS_DONE_BEHAVE` | 0 | Hold once the mission is done |
| `FS_GCS_ENABLE` | 1 | If the Pi stops sending heartbeats, the failsafe triggers |
| `FS_ACTION` | 1 | Failsafe = RTL |
| `FENCE_ENABLE` | 1 | Draw a fence around the water so the boat can never reach the bank |

## 4. Install on the boat Pi

Use Raspberry Pi OS **Lite 64-bit**. Enable the UART and turn off the serial console:

```bash
sudo raspi-config   # Interface Options → Serial Port → login shell: No, hardware: Yes
# Pi 3 only: give the good UART to GPIO14/15 by moving Bluetooth off it
echo "dtoverlay=disable-bt" | sudo tee -a /boot/firmware/config.txt
sudo systemctl disable hciuart
sudo reboot
```

Copy this folder to the Pi as `/home/pi/varuna-boat`, then:

```bash
sudo apt update && sudo apt install -y python3-venv python3-dev libxml2-dev libxslt1-dev
cd /home/pi/varuna-boat
python3 -m venv venv
venv/bin/pip install -r requirements.txt
venv/bin/python main.py            # quick test; Ctrl+C to stop
```

Run it on every boot:

```bash
sudo cp varuna-boat.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now varuna-boat
journalctl -u varuna-boat -f       # live log
```

If your Pi's user isn't `pi`, change `User=` and the paths in `varuna-boat.service`.

## 5. NetBird

Join the boat Pi to the **same** NetBird network as the laptop and the drone Pi
(see `RASPI_BACKEND_GUIDE.md` §5). Then `netbird status` shows its `100.x.x.x` IP.
In the app: System → **Boat connection** → `http://100.x.x.x:8000` → Test
connection → Save & reconnect.

The app only unlocks boat commands when that address answers as the boat
backend (`"vehicle": "boat"`), so a mistyped address can never send boat
commands to the drone.

## 6. Settings

Copy `boat_config.example.json` to `boat_config.json` and edit it. Every key can
also be set as an environment variable `BOAT_<KEY>`, e.g. `BOAT_MAV_CONNECTION=/dev/ttyACM0`.

| Key | Default | Meaning |
|---|---|---|
| `mav_connection` / `mav_baud` | `/dev/serial0` / 57600 | Link to the Pixhawk, tried first (others are searched if it's silent) |
| `http_port` | 8000 | Port the app connects to |
| `default_hold_s` | 8 | Seconds held over each item (the app sends its own value) |
| `default_speed_mps` | 0.8 | Cruise speed (the app sends its own value) |
| `max_distance_m` | 1500 | Rejects any target farther than this from the boat |
| `collector_servo` | 0 | Servo or relay output for a collector motor (0 = none); switched on for the mission with `collector_pwm_on`/`off` |
| `disarm_on_complete` | `true` | Switch the motors off when the collection is finished and the boat is home, so it is safe to lift out. If a start fails after arming, the boat is always disarmed again. |
| `operator_lost_action` | `none` | If the app goes silent mid-mission for `operator_lost_s` seconds: `none` (keep collecting), `hold`, or `rtl` |

## Boat camera and water sensor

### Hardware

| Part | How it's fitted |
|---|---|
| **Pi Camera 3** | Above the intake ramp, pointing forward and about **15° down**. The ramp fills the bottom ~20 % of the picture; the horizon sits near the top. On a Pi Zero use the narrow Zero ribbon cable. |
| **Turbidity sensor** (analog module, e.g. DFRobot SEN0189) | Probe below the waterline; its board in the dry. |
| **ADS1115 ADC** (the Pi has no analog input) | VDD → 3.3 V (pin 1), GND → pin 6, SDA → pin 3, SCL → pin 5. Sensor VCC → 5 V, signal → 10 kΩ → A0, A0 → 20 kΩ → GND (keeps A0 under 3.3 V; `turb_divider` 1.5 undoes it). |

### Who does what

A Pi Zero is far too slow for the AI models, so **the app sees and the boat decides**:

```
 Pi Camera ─MJPEG + capture time─▶ VARUNA app (laptop)          boat Pi (this service)
                                    plastic model ──┐
                                    animal model  ──┼─ /api/vision/observe (5×/s) ─▶ homing · wildlife hold
                                    ramp motion   ──┘─ /api/catch/item ───────────▶ catch log · bin count
 turbidity sensor ─ADS1115/I2C─────────────────────────────────────────────────▶ water log · "Measure here"
```

Each frame carries `X-Frame-Time` (when the boat captured it). The app sends
it back with its detections and the boat looks up where it was at that moment
(`mav_link.pose_at`), so network delay doesn't skew the steering.

- **Last-metre homing** (`vision.py`): within `homing_start_m` (8 m) of a
  plastic point in AUTO, the boat switches to GUIDED, slows to
  `homing_speed_mps`, finds the item in the picture, steers onto it, drives
  1.5 m through it, and waits up to 4 s for the catch counter. Collected or
  missed, it then goes back to AUTO at the next item. One try per item.
- **Wildlife-safe mode**: a bird, person, dog, cat or farm animal in the
  danger zone (the centre strip ahead, ~5 m to the ramp) → HOLD. Zone clear
  for 5 s → carry on (into homing again if it was homing). Still blocked
  after 60 s → the app asks: Wait / Resume / Skip item. Fish and turtles are
  not in the model.
- **Catch counter**: something crossing the counting line on the ramp toward
  the bin is one item; the plastic model names it from a crop. Bin warning at
  90 %, "full" at `bin_capacity_items`.
- **Water**: a turbidity reading every 2 s with GPS (`/api/water/track`), and
  "Measure here" (hold, average 20 s). Calibrate once in clear water.
- **Camera link lost** (`on_vision_lost`): `slow` (default) drops to
  `vision_lost_speed_mps`, `hold` stops, `continue` carries on by GPS.
- **Priority**: operator commands > wildlife > water measurement > homing >
  mission. Any Hold / RTH / Stop / Pause / mode change / disarm from the app
  stands the automation down until Start/Resume.

### Try it on the laptop

`python main.py --sim --port 8001` also simulates the camera (needs Pillow):
plastic floats 1–2.5 m off each uploaded point, items ride up the ramp when
collected, and the app's **Boat Vision** tab has a "Sim: duck ahead" button.
In the simulator the app uses the boat's `/api/sim/detections` instead of its
AI models (they don't recognise drawn shapes) — marked *SIM DETECTIONS*.

```bash
pip install pillow httpx
python test_vision.py      # homing, catch count, water test, duck pauses, vision loss, operator override
```

### Camera and vision settings

Live-tunable from the app (Boat Vision → Settings, Water Lab → Calibrate):
`homing_enabled`, `wildlife_enabled`, `homing_start_m`, `homing_speed_mps`,
`homing_search_s`, `homing_capture_m`, `wildlife_clear_s`, `wildlife_alert_s`,
`on_vision_lost`, `vision_lost_speed_mps`, `bin_capacity_items`,
`motion_sensitivity`, `camera_height_m` (0.6), `camera_tilt_deg` (15),
`camera_hfov_deg` (66), `ramp_top`, `count_line`, `zone_x1/x2/y1`,
`measure_s`. Camera: `camera_source` (`auto` tries the camera module first),
640×360 at 15 fps by default (a Pi Zero's software JPEG budget).

## API (what the app calls)

| Method | Path | |
|---|---|---|
| GET | `/api/ping`, `/api/health`, `/api/system/pi` | Liveness, Pixhawk link, Pi metrics |
| GET / WS | `/api/telemetry`, `/api/ws` | Position, mode, battery, GPS, mission progress, Pixhawk messages |
| GET | `/api/telemetry/history` | Recent track for the map trail |
| POST | `/api/mavlink/arm` `{arm}`, `/mode` `{mode}`, `/hold`, `/rtl`, `/stop` | Boat commands (`stop` = HOLD + disarm) |
| POST | `/api/mission/upload` `{name, waypoints:[{id,lat,lng}], hold_s, speed_mps}` | Builds the ArduRover mission and uploads it to the Pixhawk |
| POST | `/api/mission/start`, `/pause`, `/clear` | Start/resume (arms in HOLD, then AUTO), pause (HOLD) |
| GET | `/api/mission/status`, `/api/mission/list` | Progress, history (incl. `missed`, `how` = camera / gps) |
| GET | `/video_feed`, `/api/camera/status`, `/api/camera/snapshot` | Boat camera (MJPEG with `X-Frame-Time` per frame) |
| POST | `/api/vision/observe` `{frame_time, frame_w, frame_h, targets, hazards}` | What the app's AI saw in a frame |
| GET / POST | `/api/vision/status`, `/api/vision/config` | Homing / wildlife state, live settings |
| POST / GET | `/api/catch/item`, `/api/catch`, `/api/catch/photo/{id}`, `/api/catch/empty` | Catch counter, bin |
| GET / POST | `/api/wildlife`, `/api/wildlife/action` `{wait\|resume\|skip}`, `/api/wildlife/photo/{id}` | Wildlife pauses and sightings |
| GET / POST | `/api/water/status`, `/api/water/track`, `/api/water/readings`, `/api/water/measure`, `/api/water/calibrate` `{clear\|reference\|reset}` | Turbidity |

Every command answers `{"success": true|false, "message": "..."}`. A refusal
from the Pixhawk (for example a pre-arm check) comes back as `success: false`
with the Pixhawk's own reason.
