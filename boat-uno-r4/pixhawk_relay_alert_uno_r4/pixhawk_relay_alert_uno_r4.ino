// ==============================================================================
// VARUNA Boat: Pixhawk -> Arduino UNO R4 WiFi -> Relay alert (4 beeps)
// No Wi-Fi used. Wired signal, zero delay. NO EXTRA RESISTOR NEEDED.
//
// How it works:
// 1. Pixhawk AUX 1 (RELAY1) sends 3.3V when plastic is detected.
// 2. The UNO R4 reads it on A0 and pulses the 5V relay on D7 exactly 4 times.
// 3. Buzzer and LED strip beep/flash together through the relay.
// 4. A new detection can only beep again after the signal has been OFF for
//    1 s, so the Pi's own 4-pulse rhythm, a held signal or a flicker never
//    gives more than 4 beeps per detection.
//
// No pull-down resistor: before every reading the pin's own pull-up charges
// A0 toward 5V, then analogRead() switches it off and measures. So:
//   Pixhawk driving 3.3V -> reads ~675  -> ON
//   Pixhawk driving 0V   -> reads ~0    -> OFF
//   wire unplugged / Pixhawk off -> pin floats at 5V -> reads ~1023 -> NOT
//   CONNECTED (treated as OFF, never as a detection)
//
// WIRING:
//   Pixhawk AUX 1 [S] (Signal) -> UNO R4 A0
//   Pixhawk AUX 1 [-] (GND)    -> UNO R4 GND (common ground)
//
//   UNO R4 D7                  -> 5V Relay [ IN ]
//   UNO R4 5V                  -> 5V Relay [ VCC ]
//   UNO R4 GND                 -> 5V Relay [ GND ]
//
//   Relay [ NO ]               -> LED Strip (-) AND Buzzer (-) together
//   Relay [ COM ]              -> Battery (-)
//   Battery (+)                -> LED Strip (+) AND Buzzer (+) directly
//
// LED MATRIX ANIMATION (built into the R4 WiFi, no wiring):
//   While the 4 beeps play, a plastic bottle floats in on the waves from the
//   right, bobbing up and down, and drifts out on the left exactly when the
//   last beep ends. The top corners flash with every beep.
//
// Board: "Arduino UNO R4 WiFi" (Boards Manager: "Arduino UNO R4 Boards").
// Serial Monitor: 115200 (status line every 2 s).
// ==============================================================================

#include "Arduino_LED_Matrix.h"     // comes with the UNO R4 board package

const int PIXHAWK_IN_PIN = A0;      // A0: reads signal from Pixhawk AUX 1
const int RELAY_OUT_PIN = 7;        // D7: controls 5V relay IN
const int ONBOARD_LED = LED_BUILTIN;// D13 LED on the board
const bool RELAY_ACTIVE_LOW = true; // true for standard 5V relay modules

// A0 reading bands (10-bit: 0..1023 = 0..5V)
const int LOW_MAX = 250;            // below ~1.2V          -> Pixhawk says OFF
const int ON_MIN  = 450;            // ~2.2V ..
const int ON_MAX  = 880;            // .. ~4.3V (3.3V ~675) -> Pixhawk says ON
                                    // above ~4.3V          -> not connected
const int CONFIRM_SAMPLES = 5;      // same reading this many times in a row (~12 ms)

// The signal must stay OFF this long before a new detection can beep again.
const unsigned long REARM_LOW_MS = 1000;

// Alert rhythm: exactly 4 beeps/flashes (250ms ON, 200ms OFF x 4 times)
const int CADENCE_STEPS = 8;
const int CADENCE_DURS[CADENCE_STEPS] = {250, 200, 250, 200, 250, 200, 250, 200};
const bool CADENCE_STATES[CADENCE_STEPS] = {true, false, true, false, true, false, true, false};

const unsigned long ALERT_TOTAL_MS = 1800; // 4 x (250 + 200)

// ---------------- LED matrix (12 x 8) animation ----------------
ArduinoLEDMatrix matrix;
const int MX_W = 12, MX_H = 8;
uint8_t frame[MX_H][MX_W];
const unsigned long FRAME_MS = 30;  // ~33 fps redraw
unsigned long nextFrame = 0;
unsigned long alertStart = 0;
bool beepOn = false;                // true while the buzzer is sounding

// Plastic bottle lying on its side, cap leading to the left (7 x 3)
const int BOT_W = 7, BOT_H = 3;
const char *BOTTLE[BOT_H] = {
  "..#####",
  "###...#",
  "..#####",
};

void setPx(int x, int y) {
  if (x >= 0 && x < MX_W && y >= 0 && y < MX_H) frame[y][x] = 1;
}

void clearMatrix() {
  memset(frame, 0, sizeof(frame));
  matrix.renderBitmap(frame, 8, 12);
}

void drawAlertFrame(unsigned long t) {
  memset(frame, 0, sizeof(frame));

  // Water: bottom row solid, wave crests rolling to the left on the row above
  int wavePhase = (t / 110) % 4;
  for (int x = 0; x < MX_W; x++) {
    setPx(x, 7);
    if ((x + wavePhase) % 4 == 0) setPx(x, 6);
  }

  // Bottle drifts from just off the right edge to just off the left edge,
  // finishing exactly as the last beep ends.
  long travel = MX_W + BOT_W;                       // 19 pixel steps
  int bx = MX_W - (int)((long)min(t, ALERT_TOTAL_MS) * travel / ALERT_TOTAL_MS);
  // Gentle bob: up, up, down, down (in step with the waves)
  int by = (((t / 110) % 4) < 2) ? 2 : 3;
  for (int r = 0; r < BOT_H; r++)
    for (int c = 0; c < BOT_W; c++)
      if (BOTTLE[r][c] == '#') setPx(bx + c, by + r);

  // Both top corners flash with each beep (kept clear of the bottle)
  if (beepOn) {
    setPx(0, 0);  setPx(1, 0);
    setPx(10, 0); setPx(11, 0);
  }

  matrix.renderBitmap(frame, 8, 12);
}

// Signal levels (plain ints: the Arduino IDE's auto-prototypes break on enum types)
const int LVL_OFF = 0, LVL_ON = 1, LVL_OPEN = 2, LVL_UNSURE = 3;

bool alerting = false;
unsigned long nextPulseTime = 0;
int pulseStep = 0;
bool pixState = false;          // confirmed signal state
bool lastPixState = false;
bool armed = true;              // ready to beep on the next detection
bool lowTiming = false;         // signal is OFF and we are timing it
unsigned long lowSince = 0;
int onCount = 0, offCount = 0;
int lastRaw = 0;
int lastLevel = LVL_UNSURE;
unsigned long nextStatus = 0;

// The UNO R4 drives a full 5V, so a plain HIGH/LOW switches the relay
// cleanly (its indicator LED is fully off when the relay is off).
void setRelay(bool on) {
  bool level = RELAY_ACTIVE_LOW ? !on : on;
  digitalWrite(RELAY_OUT_PIN, level ? HIGH : LOW);
  digitalWrite(ONBOARD_LED, on ? HIGH : LOW);
  beepOn = on;
}

int readLevel() {
  pinMode(PIXHAWK_IN_PIN, INPUT_PULLUP);  // pre-charge: an unconnected pin rises to 5V
  delayMicroseconds(50);
  lastRaw = analogRead(PIXHAWK_IN_PIN);   // analogRead turns the pull-up off, then measures
  if (lastRaw <= LOW_MAX) return LVL_OFF;
  if (lastRaw >= ON_MIN && lastRaw <= ON_MAX) return LVL_ON;
  if (lastRaw > ON_MAX) return LVL_OPEN;
  return LVL_UNSURE;                      // between bands: keep the last state
}

const char *levelName(int l) {
  switch (l) {
    case LVL_OFF:  return "OFF";
    case LVL_ON:   return "ON";
    case LVL_OPEN: return "NOT CONNECTED";
    default:       return "unsure";
  }
}

void setup() {
  Serial.begin(115200);

  pinMode(ONBOARD_LED, OUTPUT);
  pinMode(RELAY_OUT_PIN, OUTPUT);
  setRelay(false);              // start with the relay completely OFF

  analogReadResolution(10);

  matrix.begin();
  clearMatrix();

  Serial.println("\n==========================================");
  Serial.println("VARUNA Pixhawk -> UNO R4 Relay Driver Ready");
  Serial.println("Waiting for signal from Pixhawk AUX 1 on A0...");
  Serial.println("==========================================");
}

void loop() {
  unsigned long now = millis();

  // Read Pixhawk AUX 1 and confirm it over several samples
  int lvl = readLevel();
  lastLevel = lvl;
  if (lvl == LVL_ON) {
    if (onCount < CONFIRM_SAMPLES) onCount++;
    offCount = 0;
  } else if (lvl == LVL_OFF || lvl == LVL_OPEN) {
    if (offCount < CONFIRM_SAMPLES) offCount++;
    onCount = 0;
  }
  if (onCount >= CONFIRM_SAMPLES) pixState = true;
  if (offCount >= CONFIRM_SAMPLES) pixState = false;

  // Re-arm only after the signal has stayed OFF for REARM_LOW_MS
  if (pixState) {
    lowTiming = false;
  } else if (!lowTiming) {
    lowTiming = true;
    lowSince = now;
  }
  if (!armed && !alerting && lowTiming && now - lowSince >= REARM_LOW_MS) {
    armed = true;
  }

  // Trigger once when the signal turns ON (rising edge), never mid-alert
  if (pixState && !lastPixState && armed && !alerting) {
    Serial.println("-> PLASTIC DETECTED! Starting 4 Buzzer Beeps...");
    alerting = true;
    armed = false;
    pulseStep = 0;
    nextPulseTime = now;
    alertStart = now;
    nextFrame = now;
  }
  lastPixState = pixState;

  // Execute rhythmic alert pulsing (exactly 4 beeps)
  if (alerting) {
    if (pulseStep >= CADENCE_STEPS) {
      Serial.println("-> 4 beeps finished. Relay OFF.");
      alerting = false;
      setRelay(false);
      clearMatrix();
    } else if (now >= nextPulseTime) {
      bool state = CADENCE_STATES[pulseStep];
      setRelay(state);
      nextPulseTime = now + CADENCE_DURS[pulseStep];
      pulseStep++;
    }
  }

  // Smooth bottle-on-the-waves animation while the beeps play
  if (alerting && now >= nextFrame) {
    nextFrame = now + FRAME_MS;
    drawAlertFrame(now - alertStart);
  }

  // Status every 2 s, so you can check the wiring in Serial Monitor
  if (now >= nextStatus) {
    nextStatus = now + 2000;
    Serial.print("A0 raw=");
    Serial.print(lastRaw);
    Serial.print("  signal=");
    Serial.println(levelName(lastLevel));
  }

  delay(2);
}
