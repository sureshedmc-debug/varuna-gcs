// =============================================================================
// VARUNA AIR-BOAT BRAIN  -  Arduino UNO R4 WiFi
// =============================================================================
// The boat's flight controller (no Pixhawk). It drives the two air motors (normal
// forward-only ESCs: 1000 us stop .. 2000 us full), the one fin servo, the basket's
// lift-gate servo, the brushes' relay and the alert relay, and runs MANUAL / ACRO / HOLD / LOITER /
// AUTO / GUIDED / RTL itself. Position and heading come from the phone's GPS and
// compass + gyro (VARUNA Boat Link 2.1 on the phone, plugged into this board's
// USB-C). Heading is held like a drone holds yaw: an angle loop sets the turn
// rate, a rate loop on the phone's gyro (50 Hz) steers the fin AND speeds one
// motor up / slows the other down, so the bow points straight at the target.
// It speaks MAVLink exactly like an ArduRover Pixhawk, so the laptop's boat
// program, the VARUNA app and Mission Planner work with it unchanged.
//
//   Phone (USB-C OTG cable) <--USB--> UNO R4 WiFi USB-C
//
// WIRING (signal pins; all GNDs together; servos/ESCs powered from a BEC, not the R4)
//   D9   OUT1  fin servo (the one servo for the fin)  SERVO1_FUNCTION 26
//   D10  OUT2  basket lift-gate servo                 SERVO2_MIN 1000 = closed, _MAX 2000 = open
//   D5   OUT3  LEFT  air motor ESC signal (white)     SERVO3_FUNCTION 73, 1000 stop .. 2000 full
//   D6   OUT4  RIGHT air motor ESC signal (white)     SERVO4_FUNCTION 74, 1000 stop .. 2000 full
//   D11  OUT5  RIGHT fin servo (SERVO5_FUNCTION 26, moves with the left fin on D9)
//   D12  OUT6  spare servo
//   D7   RELAY1  5 V relay IN: LED strip + buzzer (plastic alert)
//   D8   RELAY2  5 V relay IN: the two brush motors (AB_BRUSH_RELAY 2)
//   D2   FS-iA6B PPM out (receiver set to PPM; CH1 pin = PPM): CH3 throttle, CH4 fin,
//        CH5 SwD manual/auto, CH6 SwA brushes, CH7 VrB gate
//   D0   receiver iBUS out (FS-iA6B "SERVO/iBUS" port, Serial1) - instead of PPM, optional
//   A0   battery voltage through a divider (BATT_DIVIDER below) - optional, BATT_MONITOR 1
//
// Board: Arduino UNO R4 WiFi.  Libraries: all built in (Servo, EEPROM, WDT, Arduino_LED_Matrix).
// Settings (fin, motors, speeds, gains, failsafes) are parameters: change them from the
// laptop / Mission Planner; they are kept in the board's EEPROM.
// =============================================================================

#include <Arduino.h>
#include <Arduino_LED_Matrix.h>
#include <EEPROM.h>
#include <Servo.h>
#include <WDT.h>

#include "brain.h"

// ----------------------------------------------------------------- pins
const uint8_t OUT_PINS[8] = {9, 10, 5, 6, 11, 12, 0xFF, 0xFF};  // outputs 1-8 (0xFF = not wired)
const uint8_t RELAY_PINS[4] = {7, 8, 0xFF, 0xFF};  // relay boards: on = HIGH; a "low level trigger" board: AB_RELAY_LOW 1
const uint8_t PPM_PIN = 2;
const uint8_t BATT_PIN = A0;
const float BATT_DIVIDER = 11.0f;        // e.g. 10k + 1k divider -> x11
const uint32_t USB_BAUD = 115200;        // must match VARUNA Boat Link (it sets the same)

Servo servos[8];
bool attached[8] = {false};
bool relay_ready[4] = {false};
uint16_t last_us[8] = {0};
ArduinoLEDMatrix matrix;

// ----------------------------------------------------------------- HAL for the brain
void hal_write(const uint8_t* data, uint16_t n) { Serial.write((uint8_t*)data, n); }
uint16_t hal_write_room() { return 512; }  // the R4's Serial.write waits until sent

void hal_outputs(const uint16_t us[8]) {
  for (int i = 0; i < 8; i++) {
    if (OUT_PINS[i] == 0xFF) continue;
    if (us[i] == 0) {
      if (attached[i]) {
        servos[i].detach();
        attached[i] = false;
        digitalWrite(OUT_PINS[i], LOW);
      }
      continue;
    }
    if (!attached[i]) {
      servos[i].attach(OUT_PINS[i], 500, 2500);
      attached[i] = true;
      last_us[i] = 0;
    }
    if (us[i] != last_us[i]) {
      servos[i].writeMicroseconds(us[i]);
      last_us[i] = us[i];
    }
  }
}

// The brain says the pin level (it knows whether the relay board switches on HIGH or LOW).
// The pins stay inputs until then, so a relay never clicks on at power-up.
void hal_relay(uint8_t index, bool high) {
  if (index > 3 || RELAY_PINS[index] == 0xFF) return;
  if (!relay_ready[index]) {
    pinMode(RELAY_PINS[index], OUTPUT);   // (the level set next follows within microseconds)
    relay_ready[index] = true;
  }
  digitalWrite(RELAY_PINS[index], high ? HIGH : LOW);
}

void hal_store_read(uint16_t addr, uint8_t* data, uint16_t n) {
  for (uint16_t i = 0; i < n; i++) data[i] = EEPROM.read(addr + i);
}
void hal_store_write(uint16_t addr, const uint8_t* data, uint16_t n) {
  for (uint16_t i = 0; i < n; i++) {
    EEPROM.update(addr + i, data[i]);  // only writes bytes that changed
    WDT.refresh();
  }
}
void hal_reboot() {
  Serial.flush();
  delay(50);
  NVIC_SystemReset();
}
float hal_battery_v() {
  int raw = analogRead(BATT_PIN);
  return raw * (5.0f / 1023.0f) * BATT_DIVIDER;
}

// ----------------------------------------------------------------- receiver: PPM (D2)
volatile uint16_t ppm_ch[8];
volatile uint8_t ppm_n = 0, ppm_idx = 0;
volatile uint32_t ppm_last_us = 0, ppm_frame_us = 0;
volatile bool ppm_new = false;

void ppm_isr() {
  uint32_t now = micros();
  uint32_t dt = now - ppm_last_us;
  ppm_last_us = now;
  if (dt > 2300) {                 // sync gap (channels are at most ~2100 us): a frame ended
    if (ppm_idx >= 4 && ppm_idx <= 8) {
      ppm_n = ppm_idx;
      ppm_new = true;
      ppm_frame_us = now;
    }
    ppm_idx = 0;
  } else if (ppm_idx < 8) {
    if (dt >= 800 && dt <= 2200) ppm_ch[ppm_idx++] = (uint16_t)dt;
    else ppm_idx = 9;              // nonsense: drop this frame
  }
}

// ----------------------------------------------------------------- receiver: iBUS (Serial1, D0)
uint8_t ibus_buf[32];
uint8_t ibus_n = 0;
uint16_t ibus_ch[8];
bool ibus_new = false;

void ibus_poll() {
  while (Serial1.available()) {
    uint8_t b = Serial1.read();
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

// ----------------------------------------------------------------- LED matrix (12 x 8)
uint8_t frame[8][12];
// 3x5 font for the mode letter
const uint8_t GLYPHS[][5] = {
  {0b101, 0b111, 0b111, 0b101, 0b101},  // M  MANUAL
  {0b010, 0b101, 0b111, 0b101, 0b101},  // A  AUTO
  {0b101, 0b101, 0b111, 0b101, 0b101},  // H  HOLD
  {0b100, 0b100, 0b100, 0b100, 0b111},  // L  LOITER
  {0b111, 0b100, 0b101, 0b101, 0b111},  // G  GUIDED
  {0b110, 0b101, 0b110, 0b101, 0b101},  // R  RTL
  {0b011, 0b100, 0b100, 0b100, 0b011},  // C  ACRO
  {0b111, 0b010, 0b010, 0b010, 0b010},  // ? -> T
};

int glyph_for(uint8_t mode) {
  switch (mode) {
    case brain::MANUAL: case brain::STEERING: return 0;
    case brain::AUTO: return 1;
    case brain::HOLD: return 2;
    case brain::LOITER: return 3;
    case brain::GUIDED: return 4;
    case brain::RTL: case brain::SMART_RTL: return 5;
    case brain::ACRO: return 6;
    default: return 7;
  }
}

void px(int x, int y) {
  if (x >= 0 && x < 12 && y >= 0 && y < 8) frame[y][x] = 1;
}

// Plastic alert: a bottle floating in on the waves (the relay is on).
const char* BOTTLE[3] = {"..#####", "###...#", "..#####"};
void draw_alert(uint32_t t) {
  int phase = (t / 110) % 4;
  for (int x = 0; x < 12; x++) {
    px(x, 7);
    if ((x + phase) % 4 == 0) px(x, 6);
  }
  uint32_t tt = t % 1800;
  int bx = 12 - (int)(tt * 19 / 1800);
  int by = ((t / 220) % 4) < 2 ? 2 : 3;
  for (int r = 0; r < 3; r++)
    for (int c = 0; c < 7; c++)
      if (BOTTLE[r][c] == '#') px(bx + c, by + r);
  if ((t / 250) % 2 == 0) {
    px(0, 0); px(1, 0); px(10, 0); px(11, 0);
  }
}

// Normal screen: mode letter, armed bar, GPS / compass / link / failsafe dots, motor bars.
void draw_status(const brain::Status& s, uint32_t t) {
  const uint8_t* g = GLYPHS[glyph_for(s.mode)];
  for (int r = 0; r < 5; r++)
    for (int c = 0; c < 3; c++)
      if (g[r] & (4 >> c)) px(c, r);
  if (s.armed) for (int x = 0; x < 3; x++) px(x, 6);
  // dots: GPS, compass/heading, phone link, laptop - blink when missing
  bool blink = (t / 300) % 2;
  if (s.gps_ok || blink) px(5, 0);
  if (s.heading_ok || blink) px(6, 0);
  if (s.link_ok || blink) px(7, 0);
  if (s.gcs_ok || blink) px(8, 0);
  if (s.radio_ok) px(9, 0);
  if (s.failsafe && blink) {
    for (int x = 5; x < 12; x++) px(x, 1);
  }
  // left / right motor bars (rows 2..7, columns 5-6 and 10-11), fin in the middle.
  // Forward thrust grows up from the bottom, reverse grows down from the top.
  int hl = (int)(fabsf(s.thr_left) * 6 + 0.5f), hr = (int)(fabsf(s.thr_right) * 6 + 0.5f);
  for (int k = 0; k < hl; k++) {
    int y = s.thr_left >= 0 ? 7 - k : 2 + k;
    px(5, y); px(6, y);
  }
  for (int k = 0; k < hr; k++) {
    int y = s.thr_right >= 0 ? 7 - k : 2 + k;
    px(10, y); px(11, y);
  }
  int fx = 8 + (int)(s.steer * 1.5f + (s.steer >= 0 ? 0.5f : -0.5f));
  for (int y = 3; y < 8; y++) px(fx, y);
}

void render(uint32_t now) {
  memset(frame, 0, sizeof frame);
  const brain::Status& s = brain::status();
  if (s.alert_until_ms && (int32_t)(now - s.alert_until_ms) < 0) draw_alert(now);
  else draw_status(s, now);
  matrix.renderBitmap(frame, 8, 12);
}

// ----------------------------------------------------------------- setup / loop
uint8_t usb_buf[256];
uint32_t t_render = 0;

void setup() {
  pinMode(LED_BUILTIN, OUTPUT);
  Serial.begin(USB_BAUD);
  Serial1.begin(115200);               // iBUS receiver (if wired)
  pinMode(PPM_PIN, INPUT_PULLUP);
  attachInterrupt(digitalPinToInterrupt(PPM_PIN), ppm_isr, RISING);
  analogReadResolution(10);
  matrix.begin();
  brain::begin(millis());              // loads settings; motors 1000 us (the ESCs arm), fin centred,
                                       // gate closed, relays off
  WDT.begin(2000);                     // a hang = reboot (motors stop) within 2 s
}

void loop() {
  WDT.refresh();
  uint32_t now = millis();
  // bytes from the phone (GPS, compass, the laptop's commands)
  int n = Serial.available();
  while (n > 0) {
    int k = Serial.readBytes(usb_buf, n > (int)sizeof usb_buf ? sizeof usb_buf : n);
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
    noInterrupts();
    cnt = ppm_n;
    for (int i = 0; i < 8; i++) ch[i] = ppm_ch[i];
    ppm_new = false;
    interrupts();
    brain::rc_input(ch, cnt, now);
  }
  brain::update(now);
  // status display ~25 fps, onboard LED = armed
  if (now - t_render >= 40) {
    t_render = now;
    render(now);
    digitalWrite(LED_BUILTIN, brain::status().armed ? HIGH : LOW);
  }
}
