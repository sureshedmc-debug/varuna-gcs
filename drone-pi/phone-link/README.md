# Phone link: fly without the drone Pi

> **No backend to start (phone only, 2026-11-17):** with only the phone on the
> drone (video and GPS, no telemetry link), `npm run dev` is all that runs. Open
> VARUNA Cam (2.5 or later) on the phone, put the phone and the laptop on the
> same Wi-Fi or hotspot, and open http://localhost:5173. The dev server finds
> the phone by itself, follows it if its address changes, and serves its video
> and GPS to the app (`electron/droneDirect.cjs`; test:
> `node scripts/test-drone-direct.mjs`). If `start_laptop_backend.bat` is
> running anyway, the app uses that backend instead, as below.

When the drone has no Raspberry Pi, a phone on the drone carries the video and an
ESP32 carries the telemetry. The VARUNA drone backend runs on the laptop instead
of the Pi, so the app works as before.

```
Pixhawk TELEM2 ──wires──► ESP32 ──USB-C cable (or hotspot Wi-Fi)──► phone
                                                                     ├─ VARUNA Cam       :8080  video
                                                                     └─ relay.py (Termux) :14551 telemetry
                                                                           │  same Wi-Fi
                                                                           ▼
                       laptop: start_laptop_backend.bat (port 8000) ──► VARUNA app
```

The ESP32 reaches the phone in one of two ways. Set up one of them:

- **USB-C cable (recommended), section 1A:** the phone powers the ESP32, there's
  no hotspot to set up, and nothing on the drone depends on Wi-Fi.
- **Wi-Fi hotspot, section 1B:** the ESP32 runs DroneBridge and joins the phone's
  hotspot.

**Same network (how the drone flies):** the phone and the laptop on the same
Wi-Fi, or the laptop joined to the phone's hotspot. The laptop finds VARUNA Cam
by itself and follows it if its address changes; VARUNA Cam shows the address it
is using (for example 192.168.1.3). Nothing to type in, and the video crosses
the Wi-Fi directly, which is what keeps the picture close to live.

**NetBird (only when the drone is somewhere else):** if the phone is also on
your NetBird network, the laptop asks its peers too and can reach the drone
over mobile data from anywhere. A local address always wins when there is one,
so having NetBird on the phone never slows the normal case down. To pin one
address, set `VARUNA_NETBIRD_PHONES`, or put the phone's 100.x address in
`drone-pi/phone-link/phone_ip.txt`. Check what NetBird can see with
`py boat-pi/netbird.py`. (The BOAT's phone is the other way round — it is
normally reached over NetBird; see `boat-pi/README.md`.)

**Without the telemetry link (phone GPS):** the ESP32 and `relay.py` can be left
out. VARUNA Cam 2.2 or newer then gives the drone's position from the phone's own
GPS, and the camera's heading and tilt from its sensors (gyroscope, or compass +
accelerometer on phones without one). The backend reads them from
`http://<phone>:8080/location/stream` and shows them as the drone's position:
the floating map on the Live tab, the path flown, and each detection placed on
the water from the exact moment its video frame was taken. Allow **Location
(precise)** when VARUNA Cam asks, and keep Location on in the phone's settings.
The first good fix becomes the take-off point (height 0). Tap **Set take-off
point here** in VARUNA Cam (or in the enlarged map on the Live tab) at the launch
spot. Phones without a barometer give height from GPS, which is several metres
rough. For accurate detection positions, set `phone_fixed_alt_m` to the height
you fly at (System → Live tuning). `position_source` picks the source: `auto`
(the Pixhawk's GPS when it has a fix, else the phone's), `phone` or `pixhawk`.
Mount the phone with the camera **looking straight down**. Arm, take-off and
land buttons are hidden while no flight controller is connected: fly by RC.

**Why the relay is needed:** the ESP32 hangs off the phone (USB or hotspot), so
the laptop can't reach it directly. `relay.py` on the phone passes the MAVLink
across. `./relay.sh` uses USB when the ESP32 is plugged in, and the hotspot
otherwise.

## 1A. ESP32 on the phone's USB-C port

1. **Flash the bridge sketch:**
   - **Open:** in Arduino IDE (with the "esp32" boards package by Espressif),
     open `esp32_usb_bridge/esp32_usb_bridge.ino`.
   - **Board:** pick your board. For an ESP32-S3 or C3 that has only the native
     USB port, also set Tools > USB CDC On Boot > Enabled.
   - **Upload:** upload it from the laptop.
   - **What it does:** copies bytes between the Pixhawk and USB, with Wi-Fi and
     Bluetooth off. It compiles with no errors or warnings for ESP32, ESP32-S3
     and ESP32-C3 (esp32 core 3.3.2).
2. **Wiring:**

   | Pixhawk TELEM2 | ESP32 DevKit | ESP32-S3 | ESP32-C3 |
   |---|---|---|---|
   | TX | GPIO 16 (RX2) | GPIO 18 | GPIO 4 |
   | RX | GPIO 17 (TX2) | GPIO 17 | GPIO 5 |
   | GND | GND | GND | GND |
   | 5 V | **don't connect** | **don't connect** | **don't connect** |

   - **Pins:** to use other pins, change `FC_RX_PIN` / `FC_TX_PIN` at the top of
     the sketch.
   - **Pixhawk side:** no change. TELEM2 stays MAVLink2 at 57600.
3. **Cable to the phone:**
   - **Power:** the phone powers the ESP32 through the cable (OTG).
   - **Use an OTG adapter:** a USB-C OTG adapter (USB-C plug to USB-A socket)
     plus a USB-A to USB-C cable to the ESP32. Many ESP32 boards lack the USB-C
     resistors that make a phone supply power over a plain C-to-C cable, so
     the adapter is the reliable way.
   - **Check:** the ESP32's power LED lights when it's plugged in.
   - **vivo phones:** turn on **Settings → Other network & connections → OTG**.
     vivo turns it off after a few idle minutes, so turn it on just before
     starting the relay.
4. **Termux, once:** run `pkg install -y termux-api`. That provides
   `termux-usb`, which the Play Store Termux needs to use USB devices.
5. **Supported USB chips:** the relay drives the ESP32's USB chip itself:
   - CH340 / CH341
   - CP2102 / CP210x
   - CH9102 and other CDC devices
   - the native USB of the ESP32-S3 / C3

   It talks to the chip at 115200 baud (`USB_BAUD` in the sketch).

## 1B. ESP32 on the phone's hotspot: DroneBridge

1. **Flash it:** use DroneBridge for ESP32 from its web flasher,
   <https://drone-bridge.com/flasher/>, in Chrome or Edge with the ESP32 on USB.
   The project page is <https://github.com/DroneBridge/ESP32>.
2. **Open its settings:** join the ESP32's own Wi-Fi, "DroneBridge ESP32" with
   password `dronebridge`. Then open <http://192.168.2.1>.
3. **Set:**
   - **Wi-Fi mode:** Wi-Fi client. Use the phone hotspot's name and password.
   - **UART serial protocol:** MAVLink.
   - **UART baud:** **57600**. It must match the Pixhawk's `SERIAL2_BAUD = 57`.
   - **UART TX pin / RX pin:** the GPIO pins you wire to (step 4).
   - Save and reboot.
4. **Wiring:**

   | Pixhawk TELEM2 | ESP32 |
   |---|---|
   | TX | RX pin |
   | RX | TX pin |
   | GND | GND |
   | 5 V | **don't connect**; power the ESP32 from a 5 V BEC |

   Both run at 3.3 V logic, so no level shifter is needed. The Pixhawk side needs
   no change: TELEM2 is already MAVLink2 at 57600, as it was for the Pi.

No static IP or UDP target is needed: the relay finds the ESP32 on the hotspot by
itself. If the search doesn't work on your phone, give the ESP32 a fixed IP in
DroneBridge and start the relay with `--esp <that IP>`.

## 2. Phone (Android)

1. **Network:** join the same Wi-Fi as the laptop. Or turn the phone's
   **hotspot on** and join the laptop to it; the hotspot is also what an ESP32 on
   Wi-Fi (1B) uses.
2. **Phone's IP:** VARUNA Cam shows it under "Video address" (for example
   `http://192.168.1.3:8080/video`). The laptop needs it once.
3. **VARUNA Cam** (video): our own camera app, in `varuna-cam/`.
   - **What it does:** streams the back camera on port 8080, with no ads and no
     login, so use it only on your own Wi-Fi or hotspot.
     - **H.264 (`/h264`), the main video:** from the phone's hardware encoder,
       like a drone video link: 720p at 30 fps in about 2–3 Mbit/s, no B-frames.
       The phone fits the bitrate to the Wi-Fi as it goes. A viewer that falls
       behind skips to a fresh keyframe instead of building up delay. The
       backend uses it by itself.
     - **MJPEG (`/video`), a light backup:** 640 wide, for older backends and
       browsers. Pictures are only encoded while someone watches it.
   - **Getting the APK onto a phone without USB debugging:** plug the phone in
     for file transfer and copy `app-debug.apk` into its Download folder. On the
     phone, open it from Files and allow installing from that app when asked.
   - **Build and install it from the laptop,** with the phone on USB and USB
     debugging on:
     ```
     cd drone-pi\phone-link\varuna-cam
     set JAVA_HOME=C:\Program Files\Android\Android Studio\jbr
     gradlew assembleDebug
     adb install -r app\build\outputs\apk\debug\app-debug.apk
     ```
     It needs the Android SDK from Android Studio. If Gradle can't find it,
     create `local.properties` with
     `sdk.dir=C\:\\Users\\<you>\\AppData\\Local\\Android\\Sdk`.
   - **First start:** open **VARUNA Cam** and allow **Camera** and
     **Notifications**. It starts streaming straight away and shows the video
     addresses. Stop it with **Stop streaming** or from its notification.
   - **Video quality** (buttons in VARUNA Cam; it remembers the choice):
     - **720p 30fps (best), the default:** smooth, live video and the detail
       the app's long-range 2x2 scan uses. At most 3 Mbit/s of H.264, which
       ordinary 2.4 GHz Wi-Fi carries.
     - **1080p sharp (strong Wi-Fi):** up to 6 Mbit/s; for 5 GHz Wi-Fi.
     - **480p light:** up to 1.5 Mbit/s, for a far-away drone or a weak signal.
     - If the Wi-Fi can't carry the MJPEG backup even at its lowest JPEG
       quality, VARUNA Cam makes the picture smaller by itself and says so;
       tap a quality to try again.
     - It also turns on the lens's optical stabilisation (or electronic
       stabilisation if the lens has none), for a steadier picture on the drone.
     - Its screen shows the H.264 size, fps and Mbit/s, and how many are
       watching. Each viewer gets its own copy over the Wi-Fi, so keep the
       backend the only one: don't leave a browser tab open on the phone's
       address.
   - **Display over other apps:** tap **Allow display over other apps** in
     VARUNA Cam and switch it on. Without it, vivo and similar phones close the
     camera as soon as VARUNA Cam is in the background. While streaming it shows
     a small **● VARUNA LIVE** badge.
   - **Port 8080:** if another camera app such as IP Webcam is serving on 8080,
     VARUNA Cam says the port is busy. Stop that app first.
4. **Termux** (telemetry relay):
   - **Install:** get Termux from Google Play (publisher Fredrik Fornwall) or from F-Droid.
   - **Set up, in Termux:**
     ```
     pkg install -y python termux-api
     curl -fsSLO https://raw.githubusercontent.com/sureshedmc-debug/varuna-gcs/boat-vision/drone-pi/phone-link/relay.py
     curl -fsSLO https://raw.githubusercontent.com/sureshedmc-debug/varuna-gcs/boat-vision/drone-pi/phone-link/relay.sh
     chmod +x relay.sh
     ```
   - **Home-screen shortcut: VARUNA-Start (camera and relay together):**
     - **Install the script, in Termux:**
       ```
       mkdir -p ~/.shortcuts
       curl -fsS https://raw.githubusercontent.com/sureshedmc-debug/varuna-gcs/boat-vision/drone-pi/phone-link/VARUNA-Start -o ~/.shortcuts/VARUNA-Start
       chmod +x ~/.shortcuts/VARUNA-Start
       ```
     - **Add it to the home screen:** long-press the home screen, open
       **Widgets**, find **Termux**, and add the shortcut. Then pick
       **VARUNA-Start**.
     - **What it does:** starts VARUNA Cam streaming, comes back to Termux, and
       starts the relay, all with one tap.
     - **When the relay stops:** it releases the wake lock and waits for Enter.
       The camera keeps running.
   - **Each flight:** tap **VARUNA-Start**, or run `./relay.sh` for the relay
     alone. It keeps the phone awake.
   - **With the ESP32 on USB:**
     - **First time:** Android asks whether Termux may use the USB device. Tick
       "always" if offered, then tap OK.
     - **Startup line:** it prints `ESP32 on USB (CH340/CH341 …)`, or whichever
       chip the board has.
     - **Drone data:** it prints `drone link over USB` once the Pixhawk's data
       arrives.
   - **With the ESP32 on Wi-Fi:** it prints `drone link from 192.168.x.x` once
     the ESP32 answers.
   - **Then:** `ground station … connected` once the laptop backend runs. A
     status line every 10 s counts packets each way.
   - **Stopping it:** press CTRL on Termux's extra-keys row, then `c`.
   - The relay finds the ESP32 by reading the phone's network interfaces. That
     works on Android 16, where `ip addr` is not allowed.
5. **Keep everything running:** otherwise the phone closes these apps in the
   background. Do all of these:
   - **VARUNA Cam:** allow display over other apps (step 3).
   - **Background power:** set Termux and VARUNA Cam to **Allow background power
     usage**. On vivo: Settings → Battery → Background power control.
   - **Free memory:** on a phone with 4 GB of RAM, opening the camera can make
     Android close background apps. Close other apps before a flight.
   - **Lock in Recents:** open Recents, tap the ▼ next to Termux and VARUNA Cam,
     and choose Lock. vivo's memory cleaner skips locked apps.
   - **Never swipe them away:** swiping an app away in Recents closes it.

## 3. Laptop

1. **Network:** join the same Wi-Fi as the phone, or the phone's hotspot.
2. **Start the backend:** run `drone-pi\phone-link\start_laptop_backend.bat`.
   - **First time:** it asks for the phone's IP (shown in VARUNA Cam), then
     remembers it in `phone_ip.txt`.
   - **If the phone's IP changes:** run `start_laptop_backend.bat <new IP>`. A
     router may give the phone a new IP after a while; reserving its address in
     the router stops that.
3. **Stabilisation (on by default):** the backend steadies the phone's video
   before the app gets it (`stabilize.py`). It tracks the picture's shake,
   smooths the camera's path, taking out vibration and jitter but keeping real
   turns, and zooms in 12% to hide the moving edges. It needs ffmpeg and OpenCV
   on the laptop; the start script installs OpenCV if it's missing.
   - **Delay:** it adds about 0.4 s (`stabilize_delay_ms` = 300 plus encoding).
     Lower `stabilize_delay_ms` in **System → Live tuning** for less delay and
     a bit less smoothing, or set `video_stabilize` to `off`.
   - **Vibration faster than one frame** (wobbly "jello" picture) can't be
     taken out in software: mount the phone on foam or dampers.
   - **Test it:** `py drone-pi\test_stabilize.py` shakes a test video and checks
     how much shake is left.
4. **Smooth playback in the app:** the app shows pictures on the camera's own
   rhythm, 150 ms behind the quickest arrival, so uneven Wi-Fi delivery doesn't
   show as stutter. A picture that arrives later still shows at once.
5. **App address:** the app's dev server already points at
   `http://localhost:8000`, via `VITE_DEV_API_TARGET` in `.env.local`. In any
   other copy of the app, set **System → Connection** to `http://localhost:8000`.

## Mounting on the drone

- **Distance:** keep the phone and the ESP32 **at least 10 cm from the GPS/compass
  mast**. Phones disturb the compass. Run a compass check after mounting.
- **Mounting:** put the phone on soft foam or dampers, camera pointing down or
  forward, and strap it so it can't slide.
- **Hover throttle:** the phone weighs about 150–200 g. The Pixhawk re-learns
  hover throttle in flight (`MOT_HOVER_LEARN = 1`).
- **Heat:** keep the phone out of direct sun, and turn Bluetooth and screen
  brightness down.

## What to expect

- **Telemetry delay:** under 0.1 s on Wi-Fi.
- **Video delay:** with H.264 the phone itself adds about 0.1 s. Stabilisation on
  the laptop adds its look-ahead (`stabilize_delay_ms`, 160 ms) plus about 0.1 s,
  and the app's smooth playback 80 ms (localStorage `varuna.videoBufferMs`). That
  is about 0.4 s in all at 30 fps (720p) on a good Wi-Fi signal. A phone sending
  fewer frames (an old VARUNA Cam, low light) waits a frame's time at each step, so
  it lags more: keep VARUNA Cam up to date. If the laptop is too busy to keep up
  (AI detection in the browser takes most of a laptop's CPU), stabilisation turns
  itself off after 2 s of running 0.8 s behind, and the phone's own video goes on
  (about 0.1 s). Stabilisation is off by default for the least delay; turn
  `video_stabilize` on in System → Live tuning for a steadier picture.
- **Position indoors:** with no GPS, the phone gives a Wi-Fi/cell position
  (±100 m, every ~20 s). It is held for 60 s and shown as a coarse fix: take
  off outdoors and wait for "GPS" with a few metres' accuracy. Fine for monitoring, missions and AI detection;
  don't fly by the video.
- **Range:** the drone must stay within Wi-Fi range of the laptop. **If the
  link drops:** the app loses the drone, but the Pixhawk keeps flying on its
  own failsafes. Keep the RC transmitter in hand.

## Test without the drone

- **Whole chain:** `python drone-pi/test_phone_link.py` runs a simulated
  vehicle, the relay, a fake phone camera and the real backend on this computer. It
  checks that telemetry, commands and video all pass through.
- **USB mode:** `python drone-pi/test_relay_usb.py` checks the relay's USB mode
  against fake CH340, CP2102 and ESP32-S3 devices:
  - the setup requests and baud rate
  - MAVLink framing
  - telemetry out and commands in

## Far away, over the internet (optional)

Off your Wi-Fi, NetBird can carry the same link over 4G: install NetBird on the
phone and the laptop, sign both in to the same network, and give
`start_laptop_backend.bat` the phone's NetBird IP (100.x.x.x) instead. Lock
NetBird in Recents too, since vivo closes it in the background.
