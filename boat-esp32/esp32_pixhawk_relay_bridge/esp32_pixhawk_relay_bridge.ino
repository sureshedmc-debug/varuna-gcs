// ==============================================================================
// VARUNA Boat: Pixhawk-to-ESP32 Hardware Relay Controller
// No Wi-Fi required! Zero delay, zero network dropouts!
//
// How it works:
// 1. Pixhawk AUX 1 sends a 3.3V signal to ESP32 Pin D4.
// 2. ESP32 detects the signal and pulses the 5V Relay on D23 in an alert rhythm.
// 3. Buzzer and E-minus LED strip flash and sound together in exact rhythm.
// 4. When idle, ESP32 puts D23 in floating mode -> Green light on relay is 100% OFF!
//
// WIRING:
//   Pixhawk AUX 1 [S] (Signal) -> ESP32 D4  (GPIO 4)
//   Pixhawk AUX 1 [-] (GND)    -> ESP32 GND (Common Ground)
//
//   ESP32 D23                  -> 5V Relay [ IN ]
//   ESP32 VIN (5V)             -> 5V Relay [ VCC ]
//   ESP32 GND                  -> 5V Relay [ GND ]
//
//   Relay [ NO ]               -> LED Strip (-) AND Buzzer (-) together
//   Relay [ COM ]              -> Battery (-)
//   Battery (+)                -> LED Strip (+) AND Buzzer (+) directly
// ==============================================================================

const int PIXHAWK_IN_PIN = 4;       // D4: Reads Signal from Pixhawk AUX 1
const int RELAY_OUT_PIN = 23;       // D23: Controls 5V Relay IN
const int ONBOARD_LED = 2;          // Blue LED on ESP32 board
const bool RELAY_ACTIVE_LOW = true; // true for standard Arduino 5V relay modules

// The signal must stay OFF this long before a new detection can beep again,
// so a flickering, held, or PWM signal can never give more than 8 beeps.
const unsigned long REARM_LOW_MS = 300;

// Alert rhythm: exactly 8 beeps/flashes (250ms ON, 200ms OFF x 8 times)
const int CADENCE_STEPS = 16;
const int CADENCE_DURS[CADENCE_STEPS] = {250, 200, 250, 200, 250, 200, 250, 200, 250, 200, 250, 200, 250, 200, 250, 200};
const bool CADENCE_STATES[CADENCE_STEPS] = {true, false, true, false, true, false, true, false, true, false, true, false, true, false, true, false};

bool alerting = false;
unsigned long nextPulseTime = 0;
int pulseStep = 0;
bool lastPixState = false;
bool armed = true;              // ready to beep on the next detection
bool lowTiming = false;         // signal is OFF and we are timing it
unsigned long lowSince = 0;

// Hardware Relay Drive (Open-Drain Floating trick)
void setRelay(bool on) {
  if (on) {
    pinMode(RELAY_OUT_PIN, OUTPUT);
    digitalWrite(RELAY_OUT_PIN, RELAY_ACTIVE_LOW ? LOW : HIGH);
    digitalWrite(ONBOARD_LED, HIGH);
  } else {
    // When OFF: Set pin to INPUT (high impedance / floating).
    // The relay's internal pull-up holds it high with 0V drop.
    // The relay Green indicator LED will be 100% OFF!
    if (RELAY_ACTIVE_LOW) {
      pinMode(RELAY_OUT_PIN, INPUT);
    } else {
      pinMode(RELAY_OUT_PIN, OUTPUT);
      digitalWrite(RELAY_OUT_PIN, LOW);
    }
    digitalWrite(ONBOARD_LED, LOW);
  }
}

void setup() {
  Serial.begin(115200);

  pinMode(ONBOARD_LED, OUTPUT);
  digitalWrite(ONBOARD_LED, LOW);

  // Pin D4 input with pull-down so it stays clean 0V when disconnected
  pinMode(PIXHAWK_IN_PIN, INPUT_PULLDOWN);

  // Start with Relay completely OFF
  setRelay(false);

  Serial.println("\n==========================================");
  Serial.println("VARUNA Pixhawk -> ESP32 Relay Driver Ready");
  Serial.println("Waiting for signal from Pixhawk AUX 1...");
  Serial.println("==========================================");
}

void loop() {
  unsigned long now = millis();

  // Read Pixhawk AUX 1 signal (HIGH = 3.3V = Trigger from Pixhawk)
  bool pixState = (digitalRead(PIXHAWK_IN_PIN) == HIGH);

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

  // Trigger once when Pixhawk signal goes HIGH (rising edge), never mid-alert
  if (pixState && !lastPixState && armed && !alerting) {
    Serial.println("-> PLASTIC DETECTED! Starting 8 Buzzer Beeps...");
    alerting = true;
    armed = false;
    pulseStep = 0;
    nextPulseTime = now;
  }
  lastPixState = pixState;

  // Execute rhythmic alert pulsing (exactly 8 beeps)
  if (alerting) {
    if (pulseStep >= CADENCE_STEPS) {
      Serial.println("-> 8 beeps finished. Relay OFF.");
      alerting = false;
      setRelay(false);
    } else if (now >= nextPulseTime) {
      bool state = CADENCE_STATES[pulseStep];
      setRelay(state);
      nextPulseTime = now + CADENCE_DURS[pulseStep];
      pulseStep++;
    }
  }

  delay(2);
}
