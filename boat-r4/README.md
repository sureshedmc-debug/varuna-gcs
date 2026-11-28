# VARUNA air boat: UNO R4 brain

The boat is an **air boat**. Two BLDC motors with propellers sit up in the air on
**normal forward-only ESCs** and blow over the fin, which **one servo** turns. A
V at the bow and **two round brushes** sweep the floating waste into the middle,
where it falls into an open **mesh basket** with a servo-driven **lift gate**.
There is no Pixhawk. An **Arduino UNO R4 WiFi** is the boat's brain. It runs the
motors, the fin, the gate, the brushes' relay and the alert relay, plus every
driving mode: MANUAL, ACRO, HOLD, LOITER, AUTO missions, GUIDED go-to and RTL.

- **SwD up = MANUAL.** The R4 works as a bridge. The FS-i6 throttle (CH3) gives
  **both motors the identical signal**, CH4 moves the fin, SwA switches the
  brushes and VrB opens the gate.
- **SwD down = auto** (a loaded mission, or the laptop). The bow is held on course
  like a drone holds its yaw, from the phone's compass and gyro 50 times a second.
  The brushes run and the gate opens by themselves while it collects.

The **phone** that is the boat's camera (VARUNA Boat Link 2.1) is plugged into the
R4's USB-C. It gives the brain its **GPS position** 10 times a second, its
**compass heading and gyro turn rate** 50 times a second, and it carries the link
to the laptop. The brain talks MAVLink **exactly like an ArduRover Pixhawk**, so
the laptop's boat program, the VARUNA app and Mission Planner all work with it
unchanged.

```
 laptop (Start VARUNA Boat)  <--Tailscale / Wi-Fi, TCP 5760-->  phone (VARUNA Boat Link 2.1, Tailscale name varuna-boat)
                                                                 |  USB-C OTG cable
 FS-i6  ~~2.4 GHz~~>  FS-iA6B --PPM--> D2                        v
   fin servo, 2 air-motor ESCs, gate servo, brushes relay, alert relay  <--  UNO R4 WiFi (varuna_boat_brain)
```

## Wiring

Connect all the grounds together, including the R4, the ESCs, the BEC, the
receiver and the relay board. Power the servos from a BEC (5–6 V, 3 A or more),
**never from the R4's 5 V pin**. Use only the ESCs' **signal** wire and ground. If
an ESC has a BEC, its red wire may feed the receiver, but **only one** BEC may feed
the servo rail.

| R4 pin | Output | What | Parameter |
|---|---|---|---|
| D9  | OUT1 | **fin servo** | `SERVO1_FUNCTION 26`, 1100–1900 µs |
| D10 | OUT2 | **basket lift-gate servo** | `AB_GATE_OUT 2`, `SERVO2_MIN 1000` = closed, `SERVO2_MAX 2000` = open |
| D5  | OUT3 | **left** motor ESC signal | `SERVO3_FUNCTION 73`, 1000 stop … 2000 full |
| D6  | OUT4 | **right** motor ESC signal | `SERVO4_FUNCTION 74`, 1000 stop … 2000 full |
| D11 | OUT5 | right fin servo | `SERVO5_FUNCTION 26` |
| D12 | OUT6 | spare | `SERVOn_FUNCTION 0` |
| D7  | relay 1 | 5 V relay IN: LED strip + buzzer (plastic alert) | relay 0 in MAVLink |
| D8  | relay 2 | 5 V relay IN: **both brush motors** (one relay) | `AB_BRUSH_RELAY 2` (relay 1 in MAVLink) |
| D2  | | **FS-iA6B PPM** (the receiver's CH1 pin when it is set to PPM) | |
| D0  | | FS-iA6B iBUS (instead of PPM, optional) | |
| A0  | | battery through a 10k + 1k divider (optional) | `BATT_MONITOR 1` |
| USB-C | | the phone (OTG cable or USB-C to USB-C) | |

- **Brushes.** The battery's + goes through the relay's COM → NO contacts to both
  brush motors, which are wired in parallel, and their − goes back to the
  battery. Put a fuse in that line and a flyback diode across each motor. Most
  relay modules switch on when IN is HIGH. If yours is a "low level trigger"
  board, set `AB_RELAY_LOW 1`. The relay pins stay off from power-up until the
  brain has started.
- **Gate.** The brain closes the gate at power-up. If the servo moves the wrong
  way, set `SERVO2_REVERSED 1`, or swap the servo horn. Set `SERVO2_MIN` / `_MAX`
  so that it closes and opens fully without stalling.

## ESP32 instead of the UNO R4

`boat-r4/varuna_boat_brain_esp32` is the same brain for a plain **ESP32 dev
board** (ESP32-WROOM-32, CH340 or CP2102 USB chip). `brain.cpp`, `brain.h` and
`mav_msgs.h` are copies of the R4 ones, so keep them identical when you change
one. It works exactly like the R4: same parameters, same app, same FS-i6
switches. The phone needs **VARUNA Boat Link 2.2.0** or newer
(`release/VARUNA-Boat-Link-2.2.0.apk`), which talks to the CH340 / CP2102 USB
chip and never resets the ESP32 when it opens the port.

| ESP32 pin | What | (UNO R4 pin) |
|---|---|---|
| GPIO25 | **left** fin servo signal (under the left motor) | D9 |
| GPIO27 | **right** fin servo signal (under the right motor) | D11 |
| GPIO26 | scoop servo signal (digital hobby servo) | D10 |
| GPIO32 | **left** ESC signal | D5 |
| GPIO33 | **right** ESC signal | D6 |
| GPIO18 | relay 1 IN: LED strip + buzzer | D7 |
| GPIO19 | relay 2 IN: both brushes | D8 |
| GPIO23 | FS-iA6B PPM (receiver CH1 pin) | D2 |
| GPIO16 | FS-iA6B iBUS (optional, instead of PPM) | D0 |
| GPIO35 | battery through 10k + 1k (**max 3.3 V on the pin**) | A0 |
| GPIO2  | blue LED: slow blink disarmed, on armed, fast failsafe | LED matrix |
| USB    | the phone (OTG cable) | USB-C |

- The ESP32 runs on **3.3 V logic**. ESCs, servos and the FS-iA6B's PPM all work
  with it. Use a relay module of the "high level trigger" kind, or one marked
  3.3 V. A 5 V low-trigger board may not switch fully off from 3.3 V.
- Power the ESP32 from the phone's USB, or 5 V on its VIN pin from a BEC, never
  both at once. Servos and ESCs get their own BEC, and every GND is joined.

### Logging the real boat (step 1 of training it in a simulator)

VARUNA Boat Link **2.3.0** (`release/VARUNA-Boat-Link-2.3.0.apk`) records every run
to a `.tlog` while the ESP32 is plugged in. The brain sends its outputs and the sticks
25 times a second (`AB_LOG_HZ 25`), and the phone adds its compass, gyro and GPS.
`sysid/TEST_RUNS.md` says what to drive. `sysid/get_logs.py` copies the logs to
the laptop, and `sysid/analyze_log.py` learns the boat's model from them:
`sysid/out/boat_model.json`, `report.md` and `fit.png`. `sysid/test_sysid.py`
checks the analyzer on a fake boat with known numbers (11/11).

### Two fin servos, the scoop servo, and no lag

- **Two fin servos**, one under each fin, get the same steering signal (outputs 1
  and 5, both `SERVOn_FUNCTION 26`). If one moves its fin the wrong way, set
  `SERVO5_REVERSED 1`. Centre each one on its own with `SERVO1_TRIM` / `SERVO5_TRIM`.
- **Scoop servo** (digital hobby servo, e.g. DS3218): a 50 Hz pulse, like a
  Pixhawk sends. 1000–2000 µs is the safe range for every servo. For the full
  180° of a DS3218, set `SERVO2_MIN 500` and `SERVO2_MAX 2500`. If it buzzes or
  strains at an end, move that end in by 50 µs. It glides at `AB_GATE_SPEED`
  µs per second (default 1000) with a soft start and a soft stop, so a heavy
  scoop never jerks. 0 = jump at once.
- **No lag with the FS-i6:** the brain works each receiver frame the moment it
  arrives, instead of waiting for its next 20 ms tick. In MANUAL from the FS-i6,
  the throttle goes straight to the ESCs with no ramp (`AB_MAN_SLEW 0`), just as
  quick as the receiver wired straight to them. `AB_MAN_SLEW 4` (for example)
  softens it again. Auto modes still use `AB_SLEW`.
- This update adds parameters, so the first start sets all of them back to
  their defaults. Set again anything you had changed: failsafe, RC calibration,
  trims.
- Upload: Arduino IDE → board **ESP32 Dev Module**, the board's COM port,
  Upload. If it hangs at "Connecting…", hold the board's **BOOT** button until
  writing starts.
- On real hardware (2026-11-26):
  - **22/22 checks pass** over USB: heartbeat, parameters, both ESCs getting
    the identical signal, the brushes relay, the gate, and settings kept in
    flash across a reboot.
  - Under the phone's full load (50 Hz heading + 10 Hz GPS) it answered 40 of
    40 requests in 9 ms (worst 25 ms) with a steady 1 Hz heartbeat.

## ESC signal (from the ESC makers and ArduPilot)

A normal BLDC ESC reads a servo pulse 50 times a second. **1000 µs is stop and
2000 µs is full.** It arms only when it sees a low-throttle pulse, about 1000 µs,
at power-up: it beeps its cell count and then a long "ready" beep. It will not
arm if the signal is too high, which protects you. Most ESCs start turning the
motor at about 1050–1100 µs.

The brain sends 1000 µs from power-up and whenever the boat is disarmed or
stopped, so the ESCs always arm on the first try.

**Calibrate each ESC once, with the props OFF.** Use a servo tester, or the
receiver's CH3 output directly:

1. Throttle full (2000 µs).
2. Power the ESC and wait for the beeps.
3. Throttle down (1000 µs).
4. Wait for the confirm beeps.

Both ESCs must use the same calibration, so that the same signal gives the same
speed.

## FlySky FS-i6 + FS-iA6B setup

1. **Receiver to PPM:** on the FS-i6 go to *System → RX setup → Output mode* and
   pick **PPM** (iBUS / PPM). The PPM signal then comes out of the receiver's
   **CH1** pin. Wire that pin to D2, the receiver's + to 5 V and its − to GND.
2. **Switches** (*Functions → Aux. channels*): **Channel 5 = SwD**,
   **Channel 6 = SwA**.
3. **VrB on Channel 7.** The stock FS-i6 firmware sends only 6 channels. For the
   gate knob, flash the 10-channel firmware (FlyPlusI6X) and set
   **Channel 7 = VrB**. Without it, everything else still works: the gate then
   works only from the app and by itself in auto. Another option is
   `AB_GATE_CH 6`, which puts the gate on SwA's channel and moves the brushes to
   auto and the app only.
4. **Sticks (Mode 2):** CH3 is throttle (left stick up/down) and CH4 is the fin
   (left stick left/right). The throttle stick's **bottom is stop**. Throttle
   never reverses.
5. **SwD direction:** SwD **up = MANUAL**. If your switch works the other way,
   set `RC5_REVERSED 1`. SwA works the same way, with `RC6_REVERSED`.
6. **Failsafe (important).** The iA6B keeps sending the **last stick positions**
   if the signal is lost, unless you set its failsafe. The brain treats
   **CH3 below 960 µs** (`FS_THR_VALUE`) as "radio lost" and stops in HOLD.
   To set it:
   1. Open *Functions → End points* and set CH3's low end to **120 %**.
   2. Put the throttle fully down.
   3. Open *Functions → Failsafe → Channel 3*, turn it **On**, and hold OK to save.
   4. Set the CH3 end point back to **100 %**.

   Test it with the props off: switch the transmitter off, and the app must
   show "Failsafe: radio lost - HOLD".
7. **Arm with the sticks:** in MANUAL, hold the throttle down and CH4 right for
   2 s. CH4 left for 2 s disarms. You can also arm from the app.

## Flash it

1. Arduino IDE → open `boat-r4/varuna_boat_brain/varuna_boat_brain.ino`.
   This version lays out the settings differently, so the first start after the
   upload loads the new defaults. Set your own values again afterwards.
2. Select the board **Arduino UNO R4 WiFi** and its COM port, then Upload. Every
   library it uses is built in. It uses 39 % of the flash and 68 % of the RAM.
3. The LED matrix shows:
   - the mode letter;
   - a bar when armed;
   - dots for phone, GPS, heading and laptop;
   - the two motor bars and the fin (middle column).

   It animates while the plastic alert is on.

The settings are parameters kept in the R4's EEPROM. Change them from the app's
motor setup, the laptop, or Mission Planner (connect to the phone's
`tcp:<phone>:5760`).

## Phone

Install `release/VARUNA-Boat-Link-2.1.0.apk`. Mount the phone **upright with the
back camera looking over the bow**, or lying flat with its top edge towards the
bow; the app detects which. It finds the R4 by itself and shows "UNO R4 boat
brain on USB", the heading and the turn rate. If it says **CALIBRATE**, wave the
phone in a figure 8 away from the motors.

## First power-up (props OFF!)

1. Turn on the transmitter first with **SwD up and the throttle down**. Then power
   the boat: the ESCs beep "ready" and the gate closes. The app shows MANUAL,
   disarmed.
2. Arm with the sticks. Raise the throttle: **both motors must speed up exactly
   together**, and the app's servo readout shows the same µs on outputs 3 and 4. If
   one motor starts later, recalibrate both ESCs. You can also use the app's
   motor setup "Starts here — save" for that motor.
3. **Fin.** Push CH4 right. The fin's trailing edge must swing so the air pushes
   the **stern left**, which turns the bow right. If it goes the wrong way, set
   `SERVO1_REVERSED 1`. Centre and travel are set by `SERVO1_TRIM / _MIN / _MAX`.
4. **Propellers** must blow air **backwards** over the fin. If one blows forwards,
   swap any two of that motor's three wires. A forward-only ESC cannot be fixed
   by a setting.
5. **SwA** turns the brushes on and off, and the app shows "Brushes on/off".
   **VrB** opens and closes the gate. The gate does not move until you turn VrB
   (by more than 40 µs), so a forgotten knob cannot open it.
6. Flip **SwD down**. With a mission loaded the boat goes to AUTO: brushes on,
   gate open. Without one it goes to HOLD and the laptop drives. Flip SwD back up
   and you have the boat again at once.

## How it drives (parameters, all changeable)

- **MANUAL / SwD up (the bridge):** throttle goes to both ESCs as the same pulse
  (`AB_MAN_DIFF 0`, `AB_MAN_HOLD 0`, `AB_STEER_EXPO 0`), and CH4 goes straight to
  the fin. The laptop's sticks are ignored while the FS-i6 has the boat, and the
  laptop cannot change the mode (it gets "refused: transmitter SwD is on MANUAL").
- **Heading control (auto modes, ACRO), like a drone's yaw.** An angle loop turns
  the heading error into a wanted turn rate (`AB_HDG_P`, at most `AB_RATE_MAX`).
  A rate loop on the phone's gyro (`AB_RATE_FF`, `AB_RATE_P`, `AB_RATE_I`) turns
  that into one steering command. That command moves the fin and speeds one
  motor up and the other down (`AB_DIFF_MIX`).
- **ACRO** (from the app): the stick sets the turn rate; centred, it holds the
  heading. A 40°/s gust is pulled back within about 2°.
- **AUTO / GUIDED / RTL:**
  - It follows the track line at `CRUISE_SPEED`, slows over the last
    `AB_SLOW_DIST` m, and counts a point as reached within `WP_RADIUS`.
  - With forward-only ESCs it cannot brake with reverse thrust, so it coasts
    the last metre.
  - Above `AB_PIVOT_DEG` of heading error it turns hard on the fin, with one
    motor fast and the other slow, keeping `AB_TURN_THR` % thrust.
- **Brushes:**
  - `AB_BRUSH_AUTO 1`: on while armed in AUTO / GUIDED, off otherwise.
  - The app's relay button switches them too.
  - In MANUAL, SwA decides (`AB_BRUSH_CH 6`).
- **Gate:**
  - `AB_GATE_AUTO 1`: open while collecting in AUTO / GUIDED, closed in HOLD,
    LOITER and RTL, so the catch stays in.
  - The app's scoop button (DO_SET_SERVO 2) overrides it until the next mode
    change.
  - In MANUAL, VrB decides (`AB_GATE_CH 7`).
- **Bidirectional ESCs** remain possible: set `AB_REVERSIBLE 1`,
  `SERVO3_TRIM / SERVO4_TRIM 1500` and `RC3_TRIM 1500`.

## Failsafes

| Event | What the brain does |
|---|---|
| Transmitter off / out of range (CH3 < `FS_THR_VALUE` 960, or no PPM) | `FS_ACTION` 2 → HOLD, motors stop; flip SwD to take control again |
| GPS lost | HOLD (motors stop) in any self-driving mode |
| Laptop lost (`FS_GCS_TIMEOUT` 6 s) | `FS_ACTION` (HOLD) while driving itself |
| App motor push or game controller stops sending (`RC_OVERRIDE_TIME` 3 s) | motors stop |
| Phone unplugged (`AB_LINK_TIMEOUT` 2 s, no receiver) | motors stop |
| Board hangs | watchdog resets it in 2 s; it restarts disarmed, motors at 1000 µs |

## Tested (without hardware)

`boat-r4/sim` runs **the same `brain.cpp`** in the Android emulator. It has
forward-only ESCs that start at 1060 µs, an air-boat physics model, a side
current, GPS noise, an 8° compass error and an FS-i6 on PPM (`rc …` side
commands):

- `run_sim.ps1` starts it (`--bidir` switches to bidirectional ESCs).
- `test_brain_e2e.py` drives it through the laptop's own `BoatLink`: **78/78
  checks pass**. They cover:
  - parameters;
  - the laptop's manual drive: both motors equal, and no reverse;
  - ACRO heading hold after a gust;
  - the gate and relays from the app;
  - motor tests;
  - a mission in AUTO to completion, GUIDED, RTL;
  - GPS and override failsafes;
  - an older phone app.
  - **The FS-i6 section:**
    - SwD → MANUAL, and laptop mode changes refused;
    - stick arming;
    - CH3 gives both motors the same µs, and CH4 moves the fin;
    - the laptop's sticks are ignored;
    - SwA brushes on/off, and VrB gate 1500 / 2000 / 1000;
    - SwD down → AUTO with brushes on and the gate open, then HOLD with
      brushes off and the gate closed;
    - CH3 failsafe → HOLD.
  - brake, and a reboot that keeps parameters.
- `test_backend_api.py` drives a scratch copy of the boat program over HTTP, as
  the app does: **12/12 pass**.

`tools/gen_mavlink.py` regenerates `mav_msgs.h` from pymavlink's own definitions.
