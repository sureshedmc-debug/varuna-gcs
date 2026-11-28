# Step 1: logging the real boat (to learn its model)

The boat phone records every run by itself. **VARUNA Boat Link 2.3.0** writes a
`.tlog` whenever the ESP32 brain is plugged into it. The brain has to be the new
build, with `AB_LOG_HZ 25`, so it sends the motor, fin and scoop outputs 25 times a
second. The phone's screen shows `LOG: recording varuna_….tlog`.

## Before you go

- **Flash the new ESP32 code.** It resets all settings to their defaults the first
  time, so set the FS-iA6B failsafe and the trims again.
- **Calibrate the compass.** Wave the phone in a figure 8, away from the motors.
  Then fix the phone firmly to the boat: if it wobbles, the data is bad.
- **Choose calm water,** with open sky for the GPS. Note the wind. A windless
  day is best for the first logs.
- **Use a full battery.**

## The runs (all in MANUAL, SwD up, with the FS-i6)

Do them in any order. 10 to 15 minutes in total is plenty. Each item below is
something the report checks for.

1. **Straight runs at 3 speeds.** Use about 30 %, 60 % and 100 % throttle,
   15 seconds each, fins centred.
2. **Coast-downs (3 or more).** At speed, drop the throttle to zero and let the
   boat glide for 10 seconds. This measures the drag.
3. **Fin steps (6 or more).** At a steady 60 %, flick the rudder stick to full
   left and hold for 3 seconds, centre it, then do the same to the right. Also
   do some at half stick.
4. **Zig-zag.** At 80 %, swap the rudder from left to right every 3 seconds, 8 times.
5. **Scoop lowered vs raised.** Do a 60 % straight run of 20 seconds with VrB
   turned to lowered, then one with it raised. This measures the scoop's drag.
6. **Standing still (30 seconds).** Disarmed, with the boat floating quietly.
   This measures the sensor noise.
7. **Optional: an AUTO or ACRO run.** In MANUAL both motors always get the same
   signal. Auto modes also drive one motor harder than the other, which teaches
   the model that effect too.

## On the laptop

The phone's address is on the Boat Link screen. Run:
```powershell
py boat-r4\sysid\get_logs.py --phone <phone address>
```
```powershell
py boat-r4\sysid\analyze_log.py
```
- `boat-r4\sysid\out\report.md` shows the boat's numbers, how well the model
  predicts 5 seconds ahead, and **what runs are still missing**.
- `boat-r4\sysid\out\boat_model.json` holds the numbers the training simulator
  uses (step 2).
- `boat-r4\sysid\out\fit.png` plots what the boat did against what the model
  predicts.

`py boat-r4\sysid\test_sysid.py` checks the analyzer itself. It builds a fake
boat with known numbers and confirms the analyzer finds them again (11 checks).
