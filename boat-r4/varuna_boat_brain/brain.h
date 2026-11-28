// VARUNA air-boat brain: the part of the UNO R4 sketch that is plain C++ (no
// Arduino headers), so the very same code also runs in the PC test harness
// (boat-r4/sim). It speaks MAVLink exactly like an ArduRover Pixhawk, so the
// laptop's boat program, the VARUNA app and Mission Planner work unchanged.
//
//   phone (VARUNA Boat Link, USB)  --bytes-->  brain::feed()
//   receiver (FS-i6, optional)     --us----->  brain::rc_input()
//   loop() at >= 100 Hz            --------->  brain::update()
//   brain -> hal_write() (to the phone/laptop), hal_outputs() (servos/ESCs), hal_relay()
#pragma once
#include <stdint.h>

namespace brain {

// ArduRover mode numbers (what the laptop and Mission Planner expect).
enum Mode : uint8_t {
  MANUAL = 0, ACRO = 1, STEERING = 3, HOLD = 4, LOITER = 5, AUTO = 10, RTL = 11,
  SMART_RTL = 12, GUIDED = 15, INITIALISING = 16
};

struct Status {
  uint8_t mode;
  bool armed;
  bool gps_ok;          // a fresh, accurate enough phone GPS fix
  bool heading_ok;      // phone compass or GPS course is fresh
  bool link_ok;         // bytes from the phone within the last 2 s
  bool gcs_ok;          // laptop heartbeat within FS_GCS_TIMEOUT
  bool radio_ok;        // receiver frames arriving
  bool failsafe;
  bool relay[4];
  uint16_t out[8];      // µs on outputs 1-8
  float heading_deg;    // -1 = unknown
  float target_dist_m;  // -1 = no target
  float thr_left, thr_right;   // -1..1 (- = reverse on bidirectional ESCs)
  float steer;          // -1..1
  uint32_t alert_until_ms;     // the relay was pulsed (plastic alert) - the sketch animates until then
};

void begin(uint32_t now_ms);
void feed(const uint8_t* data, uint16_t n, uint32_t now_ms);
void rc_input(const uint16_t* us, uint8_t count, uint32_t now_ms);
void update(uint32_t now_ms);
const Status& status();
const char* mode_name(uint8_t mode);

}  // namespace brain

// ---- provided by the sketch (or the PC harness)
void hal_write(const uint8_t* data, uint16_t n);           // to the phone (and on to the laptop)
uint16_t hal_write_room();                                  // bytes that fit without blocking
void hal_outputs(const uint16_t us[8]);                     // pulse width per output, 0 = no pulse
void hal_relay(uint8_t index, bool high);   // relay pin level (the brain applies AB_RELAY_LOW)
void hal_store_read(uint16_t addr, uint8_t* data, uint16_t n);
void hal_store_write(uint16_t addr, const uint8_t* data, uint16_t n);
void hal_reboot();
float hal_battery_v();                                      // < 0: no battery monitor
