# Phone link: fly without the drone Pi

When the drone has no Raspberry Pi, a phone on the drone carries the video and an
ESP32 carries the telemetry. The VARUNA drone backend runs on the laptop instead
of the Pi, so the app works as before.

```
Pixhawk TELEM2 ──wires──► ESP32 ──USB-C cable (or hotspot Wi-Fi)──► phone
                                                                     ├─ IP Webcam        :8080  video
                                                                     └─ relay.py (Termux) :14551 telemetry
                                                                           │  4G + NetBird
                                                                           ▼
                       laptop: start_laptop_backend.bat (port 8000) ──► VARUNA app
```

The ESP32 reaches the phone in one of two ways. Set up one of them:

- **USB-C cable (recommended), section 1A:** the phone powers the ESP32, there's
  no hotspot to set up, and nothing on the drone depends on Wi-Fi.
- **Wi-Fi hotspot, section 1B:** the ESP32 runs DroneBridge and joins the phone's
  hotspot.

**Why the relay is needed:** NetBird gives only the phone itself an address on
the private network. The ESP32 hangs off the phone (USB or hotspot), not on
NetBird. `relay.py` on the phone passes the MAVLink across. `./relay.sh` uses USB
when the ESP32 is plugged in, and the hotspot otherwise.

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

1. **Data (and hotspot):** turn **mobile data on**. Turn the **hotspot on** only
   for an ESP32 on Wi-Fi (1B).
2. **NetBird:** install NetBird, sign in to the same network as the laptop, and
   connect. Note the phone's **NetBird IP** (100.x.x.x).
3. **IP Webcam** (video):
   - **Settings:** video resolution **640x480** (or 800x480), quality about
     **50**, FPS limit **15**. No login or password; NetBird already keeps it
     private.
   - **Start:** tap **Start server**. The free version shows an ad first: close
     it with its ✕, and don't tap Install. The server address is shown at the
     bottom of the camera screen.
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
     - **What it does:** opens IP Webcam and starts the relay in Termux at the
       same time. In IP Webcam, tap **Start server** and OK the ad. IP Webcam
       lets other apps open its screen, but not start its server.
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
   background, and NetBird drops first. Do all four:
   - **Background power:** set Termux, NetBird and IP Webcam to **Allow
     background power usage**. On vivo: Settings → Battery → Background power
     control.
   - **IP Webcam:** under Optional permissions, turn on **Allow streaming in
     background**, and allow display over other apps.
   - **Lock in Recents:** open Recents, tap the ▼ next to each of the three
     apps, and choose Lock. vivo's memory cleaner skips locked apps.
   - **Never swipe them away:** swiping an app away in Recents closes it.

## 3. Laptop

1. **NetBird:** make sure it's connected. If it sticks at "Connecting", run
   `netbird down`, then `netbird up`.
2. **Start the backend:** run `drone-pi\phone-link\start_laptop_backend.bat`.
   - **First time:** it asks for the phone's NetBird IP, then remembers it in
     `phone_ip.txt`.
   - **If the phone's IP changes:** run `start_laptop_backend.bat <new IP>`.
3. **App address:** the app's dev server already points at
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

- **Telemetry delay:** about 0.2–0.5 s over 4G.
- **Video delay:** about 0.5–1 s. Fine for monitoring, missions and AI
  detection; don't fly by the video.
- **If 4G drops:** the app loses the drone, but the Pixhawk keeps flying on its
  own failsafes. Keep the RC transmitter in hand.

## Test without the drone

- **Whole chain:** `python drone-pi/test_phone_link.py` runs a simulated
  vehicle, the relay, a fake IP Webcam and the real backend on this computer. It
  checks that telemetry, commands and video all pass through.
- **USB mode:** `python drone-pi/test_relay_usb.py` checks the relay's USB mode
  against fake CH340, CP2102 and ESP32-S3 devices:
  - the setup requests and baud rate
  - MAVLink framing
  - telemetry out and commands in
