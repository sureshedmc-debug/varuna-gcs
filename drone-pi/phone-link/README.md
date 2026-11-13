# Phone link: fly without the drone Pi

When the drone has no Raspberry Pi, a phone on the drone carries the video and an
ESP32 carries the telemetry. The VARUNA drone backend runs on the laptop instead
of the Pi, so the app works as before.

```
Pixhawk TELEM2 ──wires──► ESP32 (DroneBridge) ──phone hotspot Wi-Fi──► phone
                                                                        ├─ IP Webcam        :8080  video
                                                                        └─ relay.py (Termux) :14551 telemetry
                                                                              │  4G + NetBird
                                                                              ▼
                          laptop: start_laptop_backend.bat (port 8000) ──► VARUNA app
```

**Why the relay is needed:** NetBird gives only the phone itself an address on
the private network. The ESP32 is behind the phone's hotspot, and Android doesn't
route NetBird traffic to hotspot devices. `relay.py` on the phone passes the
MAVLink across.

## 1. ESP32: DroneBridge

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

1. **Hotspot and data:** turn the **hotspot on**, with **mobile data on**.
2. **NetBird:** install NetBird, sign in to the same network as the laptop, and
   connect. Note the phone's **NetBird IP** (100.x.x.x).
3. **IP Webcam** (video):
   - **Settings:** video resolution **640x480** (or 800x480), quality about
     **50**, FPS limit **15**. No login or password; NetBird already keeps it
     private.
   - **Start:** tap **Start server**.
4. **Termux** (telemetry relay):
   - **Install:** get Termux from **F-Droid**. The Play Store version is outdated.
   - **Copy the relay:** put `relay.py` on the phone, for example in Downloads.
   - **Run, in Termux:**
     ```
     pkg install python
     termux-setup-storage
     cp ~/storage/downloads/relay.py ~/
     termux-wake-lock
     python relay.py
     ```
   - **What you should see:** within a few seconds it prints
     `drone link from 192.168.x.x` once the ESP32 answers, then
     `ground station … connected` once the laptop backend runs. A status line
     every 10 s counts packets each way.
5. **Keep everything running:** in Android settings, set **battery optimisation
   off** (Unrestricted) for Termux, NetBird and IP Webcam. Otherwise Android stops
   them in the background.

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

`python drone-pi/test_phone_link.py` runs a simulated vehicle, the relay, a fake
IP Webcam and the real backend on this computer. It checks that telemetry,
commands and video all pass through.
