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
- sets up the USB camera (ffmpeg) and I2C (turbidity sensor)
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

Set these with Mission Planner or QGroundControl, or from the Pi: the backend
reads and sets parameters itself (`GET /api/pixhawk/params?names=A,B`,
`POST /api/pixhawk/params {"values": {...}}`, disarmed only, each confirmed by
the Pixhawk) and restarts the Pixhawk (`POST /api/pixhawk/reboot`).

| Parameter | Value | Why |
|---|---|---|
| `FRAME_CLASS` | 2 | Boat |
| `SERIAL2_PROTOCOL` | 2 | MAVLink2 on TELEM2 |
| `SERIAL2_BAUD` | 57 | 57600 baud, which matches `mav_baud` |
| `WP_RADIUS` | 1.5 | "Arrived" radius in metres (GPS is about ±2 m) |
| `WP_SPEED` | 0.8 | Default cruise speed in m/s (each mission sets its own as well) |
| `MIS_DONE_BEHAVE` | 0 | Hold once the mission is done |
| `FS_GCS_ENABLE` | 1 | If the Pi stops sending heartbeats, the failsafe triggers |
| `FS_GCS_TIMEOUT` | 3 | …after 3 s without one |
| `FS_ACTION` | 2 | Failsafe = Hold (stop) |
| `FENCE_ENABLE` | 1 | Draw a fence around the water so the boat can never reach the bank |

### Drive: one motor in the middle, steered by a rudder servo

The boat has **one** forward-only motor in the middle and a **rudder servo**
(it was a twin-motor skid-steer boat until 2026-11-06). The Pixhawk outputs:

| MAIN OUT | `SERVOn_FUNCTION` | MIN / TRIM / MAX | What |
|---|---|---|---|
| 1 | 26 GroundSteering | 1100 / 1500 / 1900 | Rudder servo: 1500 = straight. Wrong way? `SERVO1_REVERSED` 1 |
| 2 | 0 (the Pi drives it) | 1000 / 1000 / 2000 | Collector scoop servo (R1) |
| 3 | 70 Throttle | 950 / 950 / 2000 | The motor's ESC. Forward-only: **TRIM = MIN = stopped**, so pulling the stick back never reverses |

Saved before the change: `pixhawk/boat_pixhawk_backup_2026-11-06.param` (twin
motors); after: `pixhawk/boat_pixhawk_single_motor_2026-11-06.param`. A rudder
only steers with water flowing past it: the boat can't turn on the spot any
more. Motor matching (Boat tab) and ESC calibration now work on the one motor
(function 70) and never touch the rudder servo; the older 73 / 74 twin-motor
setup still works.

### Driving by hand with a game controller (no RC transmitter)

Set `"rc_source": "gamepad"` (the Boat Pi Tool asks in Full setup, or use its
**13. Driving by hand**). A USB / Bluetooth game controller on the PC then
drives the boat through the VARUNA app (Boat tab → Game controller):

| Control | Does |
|---|---|
| Left stick up / down | Throttle (forward / reverse), up to the throttle limit (`gamepad_max_throttle`, 60 %) |
| Right stick left / right | Steering (the rudder servo) |
| A / B / X / Y (PS2: ✕ ○ □ △) | MANUAL (drive) / HOLD (stop) / resume mission / return home |
| Hold START / BACK (PS2: SELECT) 1 s | Arm / disarm |
| R1 (RB) | Collector scoop: to its extreme position / back to 0 (the old roller: run / stop) |
| L1 + R1 together | **Brake**: motors stop and the boat disarms at once (force-disarm), then roller off and HOLD |
| MODE (HOME / GUIDE) | Next flight mode: MANUAL → ACRO → (LOITER with a GPS fix) → HOLD |
| D-pad left / right | Servo 1 / servo 2 on / off (see **Two extra servos**) |

**PS2 controller (on a USB adapter) or any pad without the standard layout:**
its buttons are numbered its own way. In the app, Boat tab → Game controller →
**Set up buttons**, then do what it asks: left stick up, right stick right, R1,
L1, START, SELECT, ✕ ○ □ △, D-pad ◀ ▶ ▼ (MODE can be skipped). It is remembered
for that controller on that PC. While it runs, the boat only gets centred
sticks and no button does anything. On a PS2 pad press **ANALOG** first (red
light on), or the sticks send nothing. "Standard" forgets it again.

Pixhawk parameters for driving with no transmitter (set on the VARUNA boat):

| Parameter | Value | Why |
|---|---|---|
| `FS_THR_ENABLE` | 0 | No radio receiver, so no radio failsafe |
| `RC1_MIN` / `RC1_TRIM` / `RC1_MAX` | 1100 / 1500 / 1900 | Steering: the Pi's range, 1500 = straight |
| `RC3_MIN` / `RC3_TRIM` / `RC3_MAX` | 1100 / 1500 / 1900 | Throttle: the Pi's range, **1500 = stopped**. With `RC3_TRIM` at 1000, the Pi's "stopped" would read as half throttle forward |
| `ARMING_SKIPCHK` | 4172 | Skip the RC (no receiver), compass, GPS-lock and GPS-config arming checks, so MANUAL arms with no GPS and no compass calibration. Modes that need a position still refuse without a GPS fix |
| `COMPASS_USE` / `EK3_SRC1_YAW` | 0 / 8 | No compass: the heading comes from GPS while moving (GSF), for GUIDED/AUTO. Restart the Pixhawk after changing |
| `FS_GCS_ENABLE` / `FS_GCS_TIMEOUT` / `FS_ACTION` | 1 / 3 / 2 | The failsafe is the Pi's heartbeat: Hold if the Pi goes quiet for 3 s |

How it stays safe without a transmitter:

* The Pi sends the Pixhawk RC override values (steering ch 1, throttle ch 3)
  ten times a second, **always** — neutral (1500) when nobody drives.
* If the **boat Pi dies**, its heartbeats stop and the Pixhawk's GCS failsafe
  holds the boat after `FS_GCS_TIMEOUT` (3 s). Until then the last stick value
  stays in force: with no receiver, ArduPilot keeps the last override.
  The tool's menu 13 and the app's Game controller card check this.
* If the **PC or controller link drops**, the Pi centres the sticks after 0.5 s
  and, if the boat was being driven in MANUAL or ACRO, switches to HOLD after 3 s.
* The app only drives while its window has focus (an unfocused window may keep
  reporting the last stick position).
* The sticks only move the boat in MANUAL and ACRO; AUTO, GUIDED, HOLD, LOITER
  and RTL ignore them. The app's Boat tab → **Flight mode** switches modes;
  MANUAL, ACRO and HOLD work with no GPS fix.
* The Pixhawk must have proper power (power module or 5 V BEC): on the Pi's USB
  alone it reads about 4.2 V and refuses to arm (*Board out of range*).

With `"rc_source": "transmitter"` (the default) the Pi sends no stick values,
so a real transmitter keeps full control.

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
| **USB webcam** (one that outputs MJPEG) | Above the intake ramp, pointing forward and about **15° down**. The ramp fills the bottom ~20 % of the picture; the horizon sits near the top. On a Pi Zero plug it into the micro-USB port marked **USB** (not PWR) through an OTG adapter. Set its horizontal field of view (`camera_hfov_deg`, from the spec sheet) in Boat Vision → Settings. |
| **Or an Android phone** (Android 14+, USB webcam mode) | Mounted where the webcam would go. Connect it to the Pi through a **powered USB hub**: a Pi Zero cannot charge a phone and browns out. On the phone, choose USB preferences → **Webcam**. Set `"camera_source": "phone"` (Boat Pi Tool → 14. Boat camera). The boat captures the phone's MJPEG at **1920×1080, 30 fps** (`phone_width`, `phone_height`, `phone_fps`) and passes it straight through, with no re-encoding. If the phone refuses that size, it falls back to 720p, then 640×480. The app gets `stream_fps` of those frames (10 on a Pi Zero). Real 1080p frames are about 150–300 KB, so even 10 a second is 12–24 Mbit/s over Wi-Fi and NetBird. If the video lags, send fewer frames or choose 720p. `/api/camera/status` reports the data rate. |
| **Phone without USB webcam mode** (e.g. vivo) | Same cable and hub. On the phone: Developer options → **USB debugging** on, install the free **IP Webcam** app, and tap Allow on "Allow USB debugging?" the first time. With `camera_source` "phone" and no webcam-mode phone, the boat uses `adb` (installed by the Boat Pi Tool) to forward the app's port (`phone_app_port`, 8080) over USB, opens the app's server, sets it to `phone_width`×`phone_height` at `camera_quality`, and reads its MJPEG with curl. The phone encodes and the Pi only copies, at about 25 fps for 1080p on a Pi Zero. Nothing goes over Wi-Fi. Keep the phone charged and set IP Webcam to keep running with the screen off. |
| **Turbidity sensor** (analog module, e.g. DFRobot SEN0189) | Probe below the waterline; its board in the dry. |
| **ADS1115 ADC** (the Pi has no analog input) | VDD → 3.3 V (pin 1), GND → pin 6, SDA → pin 3, SCL → pin 5. Sensor VCC → 5 V, signal → 10 kΩ → A0, A0 → 20 kΩ → GND (keeps A0 under 3.3 V; `turb_divider` 1.5 undoes it). |

### Who does what

A Pi Zero is far too slow for the AI models, so **the app sees and the boat decides**:

```
 USB camera ─MJPEG + capture time─▶ VARUNA app (laptop)         boat Pi (this service)
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

## Live collect (drone and boat together, no planned mission)

While the drone flies and its AI finds plastic, the boat goes after each find
as it comes in (`live_collect.py`). Start it from the app: **Boat tab → Live
collect → Start**. It needs a GPS fix on the boat (GUIDED mode).

```
 drone AI ─ find + position ─▶ VARUNA app ── /api/live/targets ──▶ boat Pi: queue
                                (sent automatically while               │ nearest item first, GUIDED
                                 live collect runs)                     ▼
                              ◀── telemetry.live.collected ─── roller on → camera homing → catch counter
```

- **The app** sends every located drone find (not laptop-webcam finds) not yet
  collected, from the last 15 minutes or since Start, about every 1.5 s, and
  again when more sightings move its position. It marks what the boat reports
  collected, like mission items. The tick box "Send the drone's finds to the
  boat automatically" turns the feed off.
- **The boat** keeps the queue (finds within `live_merge_m` of a queued one are
  the same item; finds farther than `max_distance_m` are refused) and always
  drives to the **nearest** item still to collect. The intake roller
  (`collector_servo`, `collector_pwm_on/off`) goes on within
  `live_roller_on_m` (5 m) and when the camera homing takes over, and off when
  nothing is close. Near the item the camera homing (`homing_start_m`) finds
  it, drives through it and waits for the catch counter: collected
  ("camera") or missed. Without the camera, the boat drives through the GPS
  point and waits `live_dwell_s` ("gps"). An item not reached within
  `live_target_timeout_s` is missed.
- **Nothing left**: the boat stops and holds where it is for more finds
  ("Wait here"), or with "Return home" goes home after `live_return_after_s`
  (30 s) and live collect ends.
- **You stay in charge**: any mode change, Hold, RTL, Stop, disarm (app,
  controller, failsafe) pauses it; **Resume** carries on. Wildlife holds and
  water tests win and are waited out. A planned mission and live collect never
  run together. The queue survives a Pi restart; live collect itself restarts
  off.
- **The roller** (`collector.py`): see below.

## Collector scoop (digital servo)

The default collector (`collector_kind` `"scoop"`): a digital servo tipping the
scoop, on a free Pixhawk MAIN OUT (`collector_servo`, e.g. 2 where the belt ESC
was; its `SERVOn_FUNCTION` must be 0).

- It starts at its **0 position** (`scoop_pwm_zero`, 1000 µs).
- **R1** (or the Boat tab's *To extreme* / *Back to 0* button, `POST /api/collector`)
  sends it to its **extreme** (`scoop_pwm_extreme`, 2000 µs); R1 again brings it
  back to 0, and so on.
- Nothing else moves it: no automation near items, and disarm / brake /
  emergency stop leave it where it is. A relay pin set for the old belt is ignored.
- Set the output and both positions with the Boat Pi Tool, **15. Collector scoop
  servo** (500–2500 µs; don't drive the scoop against a stop — the servo stalls).
  Power the servo from its own 5–6 V BEC.

```
python test_scoop.py          # 0 at start, R1 → extreme, R1 → 0, never moves by itself
```

## Intake roller (`collector_kind` "roller")

**Relay module on the Pi** (the VARUNA boat: `collector_relay_gpio` 17). The Pi
switches it with `pinctrl`. Wiring, on the Pi's header:

| Relay module | Pi pin |
|---|---|
| VCC | 5 V (pin 2) |
| GND | GND (pin 6) |
| IN | GPIO17 (pin 11) |
| COM / NO | in series with the roller motor's + wire from its battery (NO: off unless switched) |

Active-low modules (most: IN low = on, `collector_relay_active_low` true): on
drives the pin low, off releases it, so the module is fully off, and off at
start, at shutdown and whenever the service isn't running. An active-high
module: set `collector_relay_active_low` false.

**Or a brushed ESC on a free Pixhawk output** (`collector_servo`, no relay set;
that output's `SERVOn_FUNCTION` must be 0): a forward/reverse ESC stops at
`collector_pwm_off` 1500 and runs at `collector_pwm_on` 1800 (1200 if it turns
the wrong way); a forward-only one stops at 1000.

- **R1** on the game controller (or Run / Stop on the Boat tab's Game controller
  card, `POST /api/collector`) runs / stops it.
- It **runs by itself at each target**: in live collect when the boat closes
  in on an item (`live_roller_on_m`, 5 m) or the camera homing takes over; in a
  planned mission near the item the Pixhawk is heading to. It stops again
  when nothing is close. Last command wins: R1 can stop it near an item and it
  stays stopped until the next one.
- **Disarm, brake (L1 + R1) or emergency stop** always stops it. With an ESC,
  the stop signal is sent when the Pixhawk connects, so the ESC arms on a valid neutral.

```bash
python test_live_collect.py   # queue, nearest first, roller, operator pause, return home, camera homing
python test_relay.py          # the relay: on / off, off at start and shutdown, disarm, active-high
```

## Two extra servos

Two two-position servos (gates, flaps, an arm) on Pixhawk outputs 6 and 7,
worked from the RC transmitter **or** the app (Boat tab → Servos, or the
controller's D-pad ◀ / ▶). Each output passes an RC channel straight through:

| Servo | Output | Channel | Parameter |
|---|---|---|---|
| 1 | 6 | 6 | `SERVO6_FUNCTION 56` (RCIN6) |
| 2 | 7 | 7 | `SERVO7_FUNCTION 57` (RCIN7) |

The Boat tab's **Set up the outputs** button sets these (disarmed only; it
never takes an output that already has a function, or the roller's). The
channels must have no switch function (`RC6_OPTION` / `RC7_OPTION` 0). Restart
the Pixhawk if an output doesn't move after the change.

* **Transmitter** (`rc_source "transmitter"`): put a 2-position switch on
  channels 6 and 7; it moves the servos with the Pi doing nothing. Moving one
  from the app overrides that channel only (the sticks stay with the
  transmitter), and the app keeps it until you **Give back** (D-pad ▼), or the
  app has been gone `servo_app_lost_s` (10 s). Then it goes to wherever the switch is.
* **No transmitter** (`rc_source "gamepad"`): the Pi sends both servo channels
  with the sticks; they start off and stay where you put them.

Settings: `servoN_name`, `servoN_output`, `servoN_channel`, `servoN_pwm_off`
(start position, 1100), `servoN_pwm_on` (1900). Endpoints: `POST /api/servo`
`{servo: 1|2, on?: bool}` (no `on` = toggle), `POST /api/servo/release`
`{servo?}`, `GET|POST /api/servos/setup`.

## API (what the app calls)

| Method | Path | |
|---|---|---|
| GET | `/api/ping`, `/api/health`, `/api/system/pi` | Liveness, Pixhawk link, Pi metrics |
| GET / WS | `/api/telemetry`, `/api/ws` | Position, mode, battery, GPS, mission progress, Pixhawk messages |
| GET | `/api/telemetry/history` | Recent track for the map trail |
| POST | `/api/mavlink/arm` `{arm}`, `/mode` `{mode}`, `/hold`, `/rtl`, `/stop`, `/brake` | Boat commands (`stop` = HOLD + disarm; `brake` = force-disarm at once, then roller off + HOLD) |
| POST | `/api/mission/upload` `{name, waypoints:[{id,lat,lng}], hold_s, speed_mps}` | Builds the ArduRover mission and uploads it to the Pixhawk |
| POST | `/api/mission/start`, `/pause`, `/clear` | Start/resume (arms in HOLD, then AUTO), pause (HOLD) |
| GET | `/api/mission/status`, `/api/mission/list` | Progress, history (incl. `missed`, `how` = camera / gps) |
| GET | `/video_feed`, `/api/camera/status`, `/api/camera/snapshot` | Boat camera (MJPEG with `X-Frame-Time` per frame) |
| POST | `/api/vision/observe` `{frame_time, frame_w, frame_h, targets, hazards}` | What the app's AI saw in a frame |
| GET / POST | `/api/vision/status`, `/api/vision/config` | Homing / wildlife state, live settings |
| POST / GET | `/api/catch/item`, `/api/catch`, `/api/catch/photo/{id}`, `/api/catch/empty` | Catch counter, bin |
| GET / POST | `/api/wildlife`, `/api/wildlife/action` `{wait\|resume\|skip}`, `/api/wildlife/photo/{id}` | Wildlife pauses and sightings |
| GET / POST | `/api/water/status`, `/api/water/track`, `/api/water/readings`, `/api/water/measure`, `/api/water/calibrate` `{clear\|reference\|reset}` | Turbidity |
| POST | `/api/live/targets` `{targets:[{id,lat,lng,source?,confidence?}]}` | Live collect: add / update the drone's finds (added, merged, refused) |
| POST / GET | `/api/live/start` `{when_empty: wait\|return}`, `/pause`, `/stop` `{rtl}`, `/skip` `{id}`, `/clear`, `/api/live/status` | Live collect control and queue (also `telemetry.live`) |
| GET / POST | `/api/pixhawk/params?names=A,B`, `/api/pixhawk/params` `{values}`, `/api/pixhawk/reboot` | Read / set Pixhawk parameters (disarmed), restart it |
| POST / GET | `/api/pixhawk/motor_test` `{motor, pwm, seconds}`, `/motor_start` `{motor, pwm}`, `/api/pixhawk/motors` | Motor matching: spin the motor (`motor`; twin-motor boats `left` / `right`; stops by itself), save its start point |
| POST / GET | `/api/pixhawk/esc_calibration` `{step: auto\|cancel, outputs}` | Timed ESC calibration (battery unplugged first) |

Every command answers `{"success": true|false, "message": "..."}`. A refusal
from the Pixhawk (for example a pre-arm check) comes back as `success: false`
with the Pixhawk's own reason.
