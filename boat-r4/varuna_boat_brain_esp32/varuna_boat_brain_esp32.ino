// =============================================================================
// VARUNA AIR-BOAT BRAIN  -  ESP32 dev board (ESP32-WROOM-32, "ESP32 Dev Module")
// =============================================================================
// The same brain as the UNO R4 version (brain.cpp is the very same file): the
// boat's flight controller, no Pixhawk. It drives the two air motors (normal
// forward-only ESCs: 1000 us stop .. 2000 us full), the fin servo, the basket's
// lift-gate servo, the brushes' relay and the alert relay, and runs MANUAL / ACRO /
// HOLD / LOITER / AUTO / GUIDED / RTL itself. Position and heading come from the
// phone (VARUNA Boat Link 2.2 or newer, plugged into this board's USB socket with
// an OTG cable). It speaks MAVLink exactly like an ArduRover Pixhawk, so the
// laptop's boat program, the VARUNA app and Mission Planner work unchanged.
//
//   Phone (USB OTG cable) <--USB--> ESP32 dev board USB (CH340 / CP2102) = Serial
//
// WIRING (signal pins; all GNDs together; servos/ESCs powered from a BEC, never
// from the ESP32's 3V3 / 5V pins). These pins stay quiet while the ESP32 boots, so
// nothing twitches at power-up.
//   GPIO25  OUT1  LEFT fin servo (under the left motor)   SERVO1_FUNCTION 26
//   GPIO26  OUT2  scoop servo (digital hobby servo, 50 Hz)  SERVO2_MIN 1000 = raised, _MAX 2000 =
//                 lowered; glides AB_GATE_SPEED us/s. Full 180 deg servos (DS3218): MIN 500, MAX 2500
//   GPIO32  OUT3  LEFT  air motor ESC signal        SERVO3_FUNCTION 73, 1000 stop .. 2000 full
//   GPIO33  OUT4  RIGHT air motor ESC signal        SERVO4_FUNCTION 74, 1000 stop .. 2000 full
//   GPIO27  OUT5  RIGHT fin servo (under the right motor)  SERVO5_FUNCTION 26, moves with OUT1
//   GPIO13  OUT6  spare servo
//   GPIO18  RELAY1  relay IN: LED strip + buzzer (plastic alert)
//   GPIO19  RELAY2  relay IN: the two brush motors (AB_BRUSH_RELAY 2)
//   GPIO23  FS-iA6B PPM out (receiver set to PPM; its CH1 pin): CH3 throttle, CH4 both fins,
//           CH5 SwD manual/auto, CH6 SwA brushes, CH7 VrB scoop
//   GPIO16  receiver iBUS out (FS-iA6B "SERVO/iBUS" port, Serial2) - instead of PPM, optional
//   GPIO35  battery voltage through a 10k + 1k divider (max 3.3 V on the pin!) - BATT_MONITOR 1
//   GPIO2   the board's blue LED: slow blink = disarmed, on = armed, fast = failsafe
//
// Board: "ESP32 Dev Module" (esp32 by Espressif, 3.x). No extra libraries.
// Settings are parameters kept in the ESP32's flash (EEPROM emulation).
// =============================================================================

#include <Arduino.h>
#include <EEPROM.h>
#include <esp_task_wdt.h>

#include "brain.h"

// ----------------------------------------------------------------- pins
const uint8_t NOPIN = 0xFF;
const uint8_t OUT_PINS[8] = {25, 26, 32, 33, 27, 13, NOPIN, NOPIN};  // outputs 1-8
const uint8_t RELAY_PINS[4] = {18, 19, NOPIN, NOPIN};  // on = HIGH; a "low level trigger" board: AB_RELAY_LOW 1
const uint8_t PPM_PIN = 23;
const uint8_t IBUS_RX_PIN = 16;
const uint8_t BATT_PIN = 35;
const uint8_t LED_PIN = 2;
const float BATT_DIVIDER = 11.0f;        // 10k + 1k divider -> x11
const uint32_t USB_BAUD = 115200;        // must match VARUNA Boat Link (it sets the same)
const uint16_t STORE_SIZE = 1024;        // the brain uses 12 + 4 x 176 = 716 bytes

// Servo / ESC pulses with the ESP32's LED PWM hardware: 50 Hz, 16 bit (0.3 us steps).
const uint32_t PWM_HZ = 50;
const uint8_t PWM_BITS = 16;

bool attached[8] = {false};
bool relay_ready[4] = {false};
uint16_t last_us[8] = {0};
bool store_dirty = false;

// ----------------------------------------------------------------- HAL for the brain
void hal_write(const uint8_t* data, uint16_t n) { Serial.write(data, n); }
uint16_t hal_write_room() {
  int r = Serial.availableForWrite();
  return r > 0 ? (uint16_t)r : 0;
}

static uint32_t duty_for(uint16_t us) {
  return (uint32_t)(((uint64_t)us * ((1UL << PWM_BITS) - 1)) / (1000000UL / PWM_HZ));
}

void hal_outputs(const uint16_t us[8]) {
  for (int i = 0; i < 8; i++) {
    uint8_t pin = OUT_PINS[i];
    if (pin == NOPIN) continue;
    if (us[i] == 0) {                    // no pulse on this output
      if (attached[i]) {
        ledcDetach(pin);
        attached[i] = false;
        pinMode(pin, OUTPUT);
        digitalWrite(pin, LOW);
      }
      continue;
    }
    if (!attached[i]) {
      if (!ledcAttach(pin, PWM_HZ, PWM_BITS)) continue;   // (no free channel: never with 6 outputs)
      attached[i] = true;
      last_us[i] = 0;
    }
    if (us[i] != last_us[i]) {
      ledcWrite(pin, duty_for(us[i]));
      last_us[i] = us[i];
    }
  }
}

// The brain says the pin level (it knows whether the relay board switches on HIGH or LOW).
// The pins stay inputs until then, so a relay never clicks on at power-up.
void hal_relay(uint8_t index, bool high) {
  if (index > 3 || RELAY_PINS[index] == NOPIN) return;
  digitalWrite(RELAY_PINS[index], high ? HIGH : LOW);
  if (!relay_ready[index]) {
    pinMode(RELAY_PINS[index], OUTPUT);
    digitalWrite(RELAY_PINS[index], high ? HIGH : LOW);
    relay_ready[index] = true;
  }
}

void hal_store_read(uint16_t addr, uint8_t* data, uint16_t n) {
  for (uint16_t i = 0; i < n; i++) data[i] = (addr + i < STORE_SIZE) ? EEPROM.read(addr + i) : 0xFF;
}
// Changes go to the RAM copy; loop() writes them to flash once per batch.
void hal_store_write(uint16_t addr, const uint8_t* data, uint16_t n) {
  for (uint16_t i = 0; i < n; i++) {
    if (addr + i >= STORE_SIZE) break;
    if (EEPROM.read(addr + i) != data[i]) {
      EEPROM.write(addr + i, data[i]);
      store_dirty = true;
    }
  }
}
void hal_reboot() {
  if (store_dirty) EEPROM.commit();
  Serial.flush();
  delay(50);
  ESP.restart();
}
float hal_battery_v() {
  return analogReadMilliVolts(BATT_PIN) / 1000.0f * BATT_DIVIDER;
}

// ----------------------------------------------------------------- receiver: PPM (GPIO23)
volatile uint16_t ppm_ch[8];
volatile uint8_t ppm_n = 0, ppm_idx = 0;
volatile uint32_t ppm_last_us = 0;
volatile bool ppm_new = false;
portMUX_TYPE ppm_mux = portMUX_INITIALIZER_UNLOCKED;

void IRAM_ATTR ppm_isr() {
  uint32_t now = micros();
  portENTER_CRITICAL_ISR(&ppm_mux);
  uint32_t dt = now - ppm_last_us;
  ppm_last_us = now;
  if (dt > 2300) {                 // sync gap (channels are at most ~2100 us): a frame ended
    if (ppm_idx >= 4 && ppm_idx <= 8) {
      ppm_n = ppm_idx;
      ppm_new = true;
    }
    ppm_idx = 0;
  } else {
    uint8_t i = ppm_idx;
    if (i < 8) {
      if (dt >= 800 && dt <= 2200) {
        ppm_ch[i] = (uint16_t)dt;
        ppm_idx = i + 1;
      } else {
        ppm_idx = 9;               // nonsense: drop this frame
      }
    }
  }
  portEXIT_CRITICAL_ISR(&ppm_mux);
}

// ----------------------------------------------------------------- receiver: iBUS (Serial2, GPIO16)
uint8_t ibus_buf[32];
uint8_t ibus_n = 0;
uint16_t ibus_ch[8];
bool ibus_new = false;

void ibus_poll() {
  while (Serial2.available()) {
    uint8_t b = Serial2.read();
    if (ibus_n == 0 && b != 0x20) continue;
    if (ibus_n == 1 && b != 0x40) {
      ibus_n = 0;
      continue;
    }
    ibus_buf[ibus_n++] = b;
    if (ibus_n == 32) {
      ibus_n = 0;
      uint16_t sum = 0xFFFF;
      for (int i = 0; i < 30; i++) sum -= ibus_buf[i];
      if (sum == (uint16_t)(ibus_buf[30] | (ibus_buf[31] << 8))) {
        for (int c = 0; c < 8; c++) ibus_ch[c] = (ibus_buf[2 + 2 * c] | (ibus_buf[3 + 2 * c] << 8)) & 0x0FFF;
        ibus_new = true;
      }
    }
  }
}

// ----------------------------------------------------------------- status LED
void led(uint32_t now) {
  const brain::Status& s = brain::status();
  bool on;
  if (s.alert_until_ms && (int32_t)(now - s.alert_until_ms) < 0) on = (now / 60) % 2;   // plastic alert
  else if (s.failsafe) on = (now / 100) % 2;
  else if (s.armed) on = true;
  else on = (now / 500) % 2;
  digitalWrite(LED_PIN, on ? HIGH : LOW);
}

// ----------------------------------------------------------------- setup / loop
uint8_t usb_buf[512];
uint32_t t_led = 0, t_commit = 0;

void setup() {
  pinMode(LED_PIN, OUTPUT);
  Serial.setRxBufferSize(4096);        // the phone sends GPS + 50 Hz heading + the laptop's commands
  Serial.setTxBufferSize(4096);
  Serial.begin(USB_BAUD);
  Serial2.begin(115200, SERIAL_8N1, IBUS_RX_PIN, -1);   // iBUS receiver (if wired)
  pinMode(PPM_PIN, INPUT_PULLUP);
  attachInterrupt(digitalPinToInterrupt(PPM_PIN), ppm_isr, RISING);
  analogSetPinAttenuation(BATT_PIN, ADC_11db);
  EEPROM.begin(STORE_SIZE);
  brain::begin(millis());              // loads settings; motors 1000 us (the ESCs arm), fin centred,
                                       // gate closed, relays off
  if (store_dirty) {                   // first start: the defaults were just written
    EEPROM.commit();
    store_dirty = false;
  }
  // A hang = reboot (motors stop) within 2 s.
  esp_task_wdt_config_t wdt = {};
  wdt.timeout_ms = 2000;
  wdt.idle_core_mask = 0;
  wdt.trigger_panic = true;
  if (esp_task_wdt_reconfigure(&wdt) != ESP_OK) esp_task_wdt_init(&wdt);
  esp_task_wdt_add(NULL);
}

void loop() {
  esp_task_wdt_reset();
  uint32_t now = millis();
  // bytes from the phone (GPS, compass, the laptop's commands)
  int n = Serial.available();
  while (n > 0) {
    int k = Serial.read(usb_buf, n > (int)sizeof usb_buf ? sizeof usb_buf : n);
    if (k <= 0) break;
    brain::feed(usb_buf, (uint16_t)k, now);
    n = Serial.available();
  }
  // receiver
  ibus_poll();
  if (ibus_new) {
    ibus_new = false;
    brain::rc_input(ibus_ch, 8, now);
  } else if (ppm_new) {
    uint16_t ch[8];
    uint8_t cnt;
    portENTER_CRITICAL(&ppm_mux);
    cnt = ppm_n;
    for (int i = 0; i < 8; i++) ch[i] = ppm_ch[i];
    ppm_new = false;
    portEXIT_CRITICAL(&ppm_mux);
    brain::rc_input(ch, cnt, now);
  }
  brain::update(now);
  // changed settings -> flash (the brain batches them; at most twice a second)
  if (store_dirty && now - t_commit >= 500) {
    t_commit = now;
    store_dirty = false;
    EEPROM.commit();
  }
  if (now - t_led >= 20) {
    t_led = now;
    led(now);
  }
  delay(1);                            // lets the other tasks run; the loop still runs ~900 times a second
}
