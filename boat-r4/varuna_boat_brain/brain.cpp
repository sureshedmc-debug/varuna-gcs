// VARUNA air-boat brain - see brain.h.
//
// Hardware it drives (outputs, ArduRover numbering and SERVOn_FUNCTION values):
//   1  LEFT fin servo (behind the left motor)    26  GroundSteering
//   2  scoop / gate servo                  0  collect_outputs() (+ the laptop's scoop button),
//                                             glides at AB_GATE_SPEED - no jerk
//   3  LEFT  air motor ESC                73  ThrottleLeft
//   4  RIGHT air motor ESC                74  ThrottleRight
//   5  RIGHT fin servo (behind the right motor)  26  GroundSteering (moves with fin 1)
//   6-8 spare                               0
//   relay 2 (D8): the two brushes; relay 1 (D7): the plastic alert
// The two motors push air over the fin behind them. Normal forward-only ESCs
// (AB_REVERSIBLE 0): 1000 us stopped, 2000 us full. (AB_REVERSIBLE 1 = bidirectional
// ESCs, 1500 stopped, below = reverse.)
//
// FlySky FS-i6 + FS-iA6B on PPM: SwD (CH5) up = MANUAL - the brain is a bridge,
// run the moment each receiver frame arrives (no slew: as direct as the bare
// receiver), CH3 gives both motors the same signal, CH4 moves both fins, SwA (CH6) switches the
// brushes, VrB (CH7) opens the gate. SwD down = auto (mission / laptop): brushes
// and gate work by themselves while it collects.
//
// Heading is held like a drone holds its yaw: an angle loop (AB_HDG_P) asks for a
// turn rate, a rate loop on the phone's GYRO (AB_RATE_*) turns that into one
// steering command, and the steering command drives BOTH the fin servo and the
// difference between the two motors (AB_DIFF_MIX). The phone sends its fused
// compass heading and gyro yaw rate 50 times a second (ATTITUDE over USB), so the
// loop works on fresh numbers with no differentiating and almost no delay.
//
// Position comes from the phone's GPS (GPS_INPUT, 10 Hz). The compass error (how
// the phone sits on the boat, iron nearby) is learnt from the GPS course while
// the boat runs straight (AB_COG_LEARN).

#include "brain.h"

#include <math.h>
#include <stdio.h>
#include <string.h>

#include "mav_msgs.h"

namespace brain {
namespace {

// ------------------------------------------------------------------ constants
const uint8_t SYS_ID = 1, COMP_ID = 1;
const uint8_t MAV_TYPE_SURFACE_BOAT = 11, MAV_AUTOPILOT_ARDUPILOTMEGA = 3;
const uint8_t MAV_PARAM_TYPE_REAL32 = 9;
const uint8_t ACCEPTED = 0, DENIED = 2, UNSUPPORTED = 3, FAILED = 4;
const uint16_t MAX_ITEMS = 120;
const float DEG = 0.01745329252f;
const double EARTH_R = 6378137.0;
const uint32_t STORE_MAGIC = 0x56524231;  // "VRB1"

// ------------------------------------------------------------------ small helpers
float clampf(float v, float lo, float hi) { return v < lo ? lo : (v > hi ? hi : v); }
float wrap180(float a) {
  while (a > 180.f) a -= 360.f;
  while (a < -180.f) a += 360.f;
  return a;
}
float wrap360(float a) {
  while (a >= 360.f) a -= 360.f;
  while (a < 0.f) a += 360.f;
  return a;
}
// metres north / east of (lat0, lon0) to (lat1, lon1), all in 1e-7 degrees
void ne_of(int32_t lat0, int32_t lon0, int32_t lat1, int32_t lon1, float* n, float* e) {
  double dlat = (double)(lat1 - lat0) * 1e-7 * DEG;
  double dlon = (double)(lon1 - lon0) * 1e-7 * DEG;
  double c = cos((double)lat0 * 1e-7 * DEG);
  *n = (float)(dlat * EARTH_R);
  *e = (float)(dlon * EARTH_R * c);
}
float dist_m(int32_t lat0, int32_t lon0, int32_t lat1, int32_t lon1) {
  float n, e;
  ne_of(lat0, lon0, lat1, lon1, &n, &e);
  return sqrtf(n * n + e * e);
}
float bearing_deg(int32_t lat0, int32_t lon0, int32_t lat1, int32_t lon1) {
  float n, e;
  ne_of(lat0, lon0, lat1, lon1, &n, &e);
  return wrap360(atan2f(e, n) / DEG);
}
uint32_t name_hash(const char* s) {  // FNV-1a
  uint32_t h = 2166136261u;
  while (*s) h = (h ^ (uint8_t)*s++) * 16777619u;
  return h;
}

// ------------------------------------------------------------------ parameters
struct Param {
  char name[17];
  float v, def;
};
const uint16_t MAX_PARAMS = 176;
Param P[MAX_PARAMS];
uint16_t NP = 0;
uint32_t layout_hash = 2166136261u;

uint16_t addp(const char* name, float def) {
  if (NP >= MAX_PARAMS) return NP - 1;
  strncpy(P[NP].name, name, 16);
  P[NP].name[16] = 0;
  P[NP].v = P[NP].def = def;
  layout_hash = (layout_hash ^ name_hash(name)) * 16777619u;
  return NP++;
}
int findp(const char* name) {
  for (uint16_t i = 0; i < NP; i++)
    if (strncmp(P[i].name, name, 16) == 0) return i;
  return -1;
}
// Frequently used values, by index.
struct {
  uint16_t fs_thr_enable, fs_action, fs_timeout, fs_gcs_enable, fs_gcs_timeout, rc_override_time;
  uint16_t mot_thr_max, rcmap_roll, rcmap_throttle, mode_ch, mode[6], arming_rudder, arming_check;
  uint16_t wp_radius, wp_speed, cruise_speed, cruise_throttle, loit_radius, rtl_speed, mis_done;
  uint16_t hdg_p, rate_max, rate_p, rate_i, rate_ff, rate_imax, diff_mix, turn_thr, min_thr, pivot_deg;
  uint16_t spd_p, spd_i, slow_dist, reversible, mot_dz, slew, rev_delay, rev_fin, brake, man_hold, guided_rad;
  uint16_t loit_speed, lookahead, compass_use, compass_ofs, cog_learn, gps_min_acc, gps_timeout;
  uint16_t batt_monitor, batt_low, sysid, acro_rate, steer_expo, link_timeout, log_hz;
  uint16_t mode_sw, fs_thr_value, man_diff, brush_relay, brush_ch, brush_auto, gate_out, gate_ch, gate_auto, relay_low;
  uint16_t gate_speed, man_slew;
  uint16_t rc_min[8], rc_max[8], rc_trim[8], rc_dz[8], rc_rev[8], rc_opt[8];
  uint16_t sv_fn[8], sv_min[8], sv_max[8], sv_trim[8], sv_rev[8];
} I;
float pv(uint16_t i) { return P[i].v; }

void define_params() {
  NP = 0;
  layout_hash = 2166136261u;
  // --- ArduRover names the laptop's boat program reads / writes
  I.sysid = addp("SYSID_THISMAV", 1);
  I.fs_thr_enable = addp("FS_THR_ENABLE", 1);   // receiver lost -> FS_ACTION (only once a receiver was seen)
  I.fs_action = addp("FS_ACTION", 2);           // 0 nothing, 1 RTL, 2 HOLD
  I.fs_timeout = addp("FS_TIMEOUT", 1.5f);
  // The FS-iA6B keeps sending the last sticks when it loses the transmitter, unless its
  // failsafe puts the throttle below this: then the brain knows the radio is gone.
  I.fs_thr_value = addp("FS_THR_VALUE", 960);
  I.fs_gcs_enable = addp("FS_GCS_ENABLE", 1);   // laptop lost while driving itself -> FS_ACTION
  I.fs_gcs_timeout = addp("FS_GCS_TIMEOUT", 6);
  I.rc_override_time = addp("RC_OVERRIDE_TIME", 3);
  I.mot_thr_max = addp("MOT_THR_MAX", 100);
  I.rcmap_roll = addp("RCMAP_ROLL", 4);        // steering (the fin) = CH4, the FS-i6 rudder stick
  I.rcmap_throttle = addp("RCMAP_THROTTLE", 3); // CH3: both motors, the same signal
  I.mode_ch = addp("MODE_CH", 5);               // CH5 = SwD
  // 1: MODE_CH is a 2-position switch (FS-i6 SwD): up = MANUAL (the sticks drive),
  //    down = auto (AUTO if a mission is loaded, else HOLD and the laptop drives).
  // 0: a 6-position mode switch on MODE_CH (MODE1..6, ArduRover style).
  I.mode_sw = addp("AB_MODE_SW", 1);
  const float modes[6] = {MANUAL, HOLD, HOLD, LOITER, AUTO, ACRO};
  char n[17];
  for (int k = 0; k < 6; k++) {
    snprintf(n, sizeof n, "MODE%d", k + 1);
    I.mode[k] = addp(n, modes[k]);
  }
  I.arming_rudder = addp("ARMING_RUDDER", 2);   // throttle low + CH4 right 2 s = arm, left 2 s = disarm
  I.arming_check = addp("ARMING_CHECK", 1);
  I.wp_radius = addp("WP_RADIUS", 3);
  I.wp_speed = addp("WP_SPEED", 0);             // 0 = CRUISE_SPEED
  I.cruise_speed = addp("CRUISE_SPEED", 1.0f);
  I.cruise_throttle = addp("CRUISE_THROTTLE", 40);
  I.loit_radius = addp("LOIT_RADIUS", 3);
  I.rtl_speed = addp("RTL_SPEED", 0);
  I.mis_done = addp("MIS_DONE_BEHAVE", 1);      // after the last item: 0 HOLD, 1 keep the position (LOITER)
  I.batt_monitor = addp("BATT_MONITOR", 0);
  I.batt_low = addp("BATT_LOW_VOLT", 0);
  // --- the air boat itself (AB_)
  // Heading: angle loop -> wanted turn rate -> rate loop on the phone's gyro -> steering.
  I.hdg_p = addp("AB_HDG_P", 1.8f);             // deg/s of turn asked for per degree of heading error
  I.rate_max = addp("AB_RATE_MAX", 40);         // deg/s: fastest turn the heading loop asks for
  I.rate_p = addp("AB_RATE_P", 0.006f);         // steering per deg/s of turn-rate error
  I.rate_i = addp("AB_RATE_I", 0.012f);         // steering per deg/s*s (trims out a crooked fin / motor)
  I.rate_ff = addp("AB_RATE_FF", 0.004f);       // steering per deg/s asked for (the turn it needs)
  I.rate_imax = addp("AB_RATE_IMAX", 0.4f);
  I.diff_mix = addp("AB_DIFF_MIX", 0.4f);       // motor speed difference at full steering (0..1), self-driving
  I.man_diff = addp("AB_MAN_DIFF", 0);          // the same in MANUAL: 0 = both motors always the same speed
  I.turn_thr = addp("AB_TURN_THR", 35);         // % thrust while turning hard (forward-only ESCs)
  I.min_thr = addp("AB_MIN_THR", 18);           // % thrust that still gives the fins some air
  I.pivot_deg = addp("AB_PIVOT_DEG", 70);       // heading error above this: turn on the spot first
  I.spd_p = addp("AB_SPD_P", 20);               // % throttle per m/s of speed error
  I.spd_i = addp("AB_SPD_I", 6);
  I.slow_dist = addp("AB_SLOW_DIST", 6);        // slow down over the last metres to a point
  // Bidirectional ESCs.
  I.reversible = addp("AB_REVERSIBLE", 0);      // 0 = normal forward-only ESCs (1000 stop .. 2000 full)
                                                // 1 = bidirectional ESCs (stopped at SERVOn_TRIM 1500)
  I.mot_dz = addp("AB_MOT_DZ", 25);             // us each side of the stop where the ESC does not turn yet
  I.slew = addp("AB_SLEW", 6);                  // thrust change per second (1 = full) - spares the ESCs
  I.man_slew = addp("AB_MAN_SLEW", 0);         // MANUAL with the FS-i6: thrust change per second, 0 = none
                                                // (the sticks go straight to the ESCs, like the bare receiver)
  I.rev_delay = addp("AB_REV_DELAY", 0.15f);    // s stopped before a motor changes direction
  I.rev_fin = addp("AB_REV_FIN", 0);            // fin share when both motors blow backwards (-1..1)
  I.brake = addp("AB_BRAKE", 30);               // % reverse thrust allowed to slow down / stop on a point
  I.man_hold = addp("AB_MAN_HOLD", 0);          // 1 = MANUAL: steering stick centred = hold the heading
                                                // (0: MANUAL is a straight bridge, stick -> fin)
  I.guided_rad = addp("AB_GUIDED_RAD", 1.0f);   // m: a GUIDED point (the plastic) counts as reached
  I.loit_speed = addp("AB_LOIT_SPEED", 0.5f);   // m/s when moving back onto the held position
  I.lookahead = addp("AB_LOOKAHEAD", 6);        // m along the track line it steers at
  I.acro_rate = addp("AB_ACRO_RATE", 60);       // ACRO: deg/s at full stick; centred = keep this heading
  I.steer_expo = addp("AB_STEER_EXPO", 0);
  I.compass_use = addp("COMPASS_USE", 1);       // 1 = phone compass, 0 = GPS course only
  I.compass_ofs = addp("COMPASS_OFS", 0);       // deg added to the phone's heading (how it is mounted)
  I.cog_learn = addp("AB_COG_LEARN", 1);        // learn the compass error from the GPS course
  I.gps_min_acc = addp("GPS_MIN_ACC", 10);      // m: worse than this is not used to drive
  I.gps_timeout = addp("GPS_TIMEOUT", 3);
  I.link_timeout = addp("AB_LINK_TIMEOUT", 2);  // s with no bytes from the phone -> motors off
  I.log_hz = addp("AB_LOG_HZ", 25);            // outputs (SERVO_OUTPUT_RAW) + sticks (RC_CHANNELS) per second
                                                // for the phone's log (learning the boat's model); 0 = 4 / 2 Hz
  // --- collecting: two brushes on one relay, the basket's lift gate on a servo
  I.brush_relay = addp("AB_BRUSH_RELAY", 2);    // relay number of the brushes (2 = D8), 0 = none
  I.brush_ch = addp("AB_BRUSH_CH", 6);          // CH6 = SwA: brushes on / off in MANUAL
  I.brush_auto = addp("AB_BRUSH_AUTO", 1);      // 1 = brushes run by themselves while collecting (AUTO, GUIDED)
  I.gate_out = addp("AB_GATE_OUT", 2);          // output of the gate servo (2 = D10); SERVOn_MIN closed, _MAX open
  I.gate_ch = addp("AB_GATE_CH", 7);            // CH7 = VrB: the gate in MANUAL (once the knob is turned)
  I.gate_auto = addp("AB_GATE_AUTO", 1);        // 1 = gate open while collecting, closed in HOLD / LOITER / RTL
  I.gate_speed = addp("AB_GATE_SPEED", 1000);   // us per second the gate / scoop servo moves (0 = at once):
                                                // a heavy scoop glides to its end, no jerk; 1000 = 1000..2000 in 1 s
  I.relay_low = addp("AB_RELAY_LOW", 0);        // 1 = relay boards switched on by LOW ("low level trigger")
  // --- receiver channels
  for (int c = 0; c < 8; c++) {
    snprintf(n, sizeof n, "RC%d_MIN", c + 1);       I.rc_min[c] = addp(n, 1000);
    snprintf(n, sizeof n, "RC%d_MAX", c + 1);       I.rc_max[c] = addp(n, 2000);
    // Throttle (CH3) stopped at the bottom, 1000: the FS-i6 throttle stick does not spring
    // back. (Bidirectional ESCs with a centring stick: RC3_TRIM 1500, below = reverse.)
    snprintf(n, sizeof n, "RC%d_TRIM", c + 1);      I.rc_trim[c] = addp(n, c == 2 ? 1000 : 1500);
    snprintf(n, sizeof n, "RC%d_DZ", c + 1);        I.rc_dz[c] = addp(n, 30);
    snprintf(n, sizeof n, "RC%d_REVERSED", c + 1);  I.rc_rev[c] = addp(n, 0);
    snprintf(n, sizeof n, "RC%d_OPTION", c + 1);    I.rc_opt[c] = addp(n, 0);
  }
  // --- outputs
  // Two fin servos, one behind each motor, both steered together: output 1 (left) and
  // output 5 (right) - SERVO5_REVERSED 1 if the right one is mounted mirrored. The gate /
  // scoop servo (2), the two air motors (3, 4); 6-8 spare.
  const float fn[8] = {26, 0, 73, 74, 26, 0, 0, 0};
  for (int s = 0; s < 8; s++) {
    bool motor = fn[s] == 73 || fn[s] == 74;
    snprintf(n, sizeof n, "SERVO%d_FUNCTION", s + 1); I.sv_fn[s] = addp(n, fn[s]);
    snprintf(n, sizeof n, "SERVO%d_MIN", s + 1);      I.sv_min[s] = addp(n, motor ? 1000 : (s == 1 ? 1000 : 1100));
    snprintf(n, sizeof n, "SERVO%d_MAX", s + 1);      I.sv_max[s] = addp(n, motor ? 2000 : (s == 1 ? 2000 : 1900));
    // Motors: 1000 = stopped (normal ESCs; 1500 for bidirectional ones). Gate: 1000 = closed.
    snprintf(n, sizeof n, "SERVO%d_TRIM", s + 1);     I.sv_trim[s] = addp(n, (s == 1 || motor) ? 1000 : 1500);
    snprintf(n, sizeof n, "SERVO%d_REVERSED", s + 1); I.sv_rev[s] = addp(n, 0);
  }
}

// Stored values: [magic][layout hash][count][float x count]
const uint16_t STORE_HDR = 12;
uint32_t save_due_ms = 0;
bool save_mask[MAX_PARAMS];

void load_params() {
  uint32_t hdr[3] = {0, 0, 0};
  hal_store_read(0, (uint8_t*)hdr, sizeof hdr);
  if (hdr[0] == STORE_MAGIC && hdr[1] == layout_hash && hdr[2] == NP) {
    for (uint16_t i = 0; i < NP; i++) {
      float v;
      hal_store_read(STORE_HDR + 4 * i, (uint8_t*)&v, 4);
      if (v == v && v > -1e7f && v < 1e7f) P[i].v = v;  // not NaN, sane
    }
    return;
  }
  // First start (or the parameter list changed): write the defaults.
  hdr[0] = STORE_MAGIC;
  hdr[1] = layout_hash;
  hdr[2] = NP;
  for (uint16_t i = 0; i < NP; i++) hal_store_write(STORE_HDR + 4 * i, (const uint8_t*)&P[i].v, 4);
  hal_store_write(0, (const uint8_t*)hdr, sizeof hdr);
}

// ------------------------------------------------------------------ MAVLink out
uint8_t tx_seq = 0;

uint16_t crc_acc(uint8_t b, uint16_t crc) {
  uint8_t t = b ^ (uint8_t)(crc & 0xff);
  t ^= (uint8_t)(t << 4);
  return (crc >> 8) ^ ((uint16_t)t << 8) ^ ((uint16_t)t << 3) ^ (t >> 4);
}

bool send(uint32_t id, uint8_t crc_extra, const uint8_t* payload, uint8_t len, bool must = false) {
  while (len > 1 && payload[len - 1] == 0) len--;  // MAVLink 2 trims trailing zeros
  uint8_t f[12 + MAV_MAX_PAYLOAD];
  f[0] = 0xFD;
  f[1] = len;
  f[2] = 0;
  f[3] = 0;
  f[4] = tx_seq;
  f[5] = SYS_ID;
  f[6] = COMP_ID;
  f[7] = id & 0xff;
  f[8] = (id >> 8) & 0xff;
  f[9] = (id >> 16) & 0xff;
  memcpy(f + 10, payload, len);
  uint16_t crc = 0xffff;
  for (int i = 1; i < 10 + len; i++) crc = crc_acc(f[i], crc);
  crc = crc_acc(crc_extra, crc);
  f[10 + len] = crc & 0xff;
  f[11 + len] = crc >> 8;
  uint16_t total = 12 + len;
  // Telemetry is dropped when the USB buffer is full; replies (ACKs, params,
  // mission) wait for room - they are answers someone is waiting for.
  if (!must && hal_write_room() < total) return false;
  tx_seq++;
  hal_write(f, total);
  return true;
}
#define SEND(NAME, m, must)                                     \
  do {                                                          \
    uint8_t _b[MAV_LEN_##NAME];                                 \
    memset(_b, 0, sizeof _b);                                   \
    uint8_t _n = mav_pack_##NAME##_fn(_b, &(m));                \
    send(MAV_ID_##NAME, MAV_CRC_##NAME, _b, _n, must);          \
  } while (0)
// map NAME -> lower-case pack function
#define mav_pack_HEARTBEAT_fn mav_pack_heartbeat
#define mav_pack_SYS_STATUS_fn mav_pack_sys_status
#define mav_pack_GPS_RAW_INT_fn mav_pack_gps_raw_int
#define mav_pack_ATTITUDE_fn mav_pack_attitude
#define mav_pack_GLOBAL_POSITION_INT_fn mav_pack_global_position_int
#define mav_pack_MISSION_CURRENT_fn mav_pack_mission_current
#define mav_pack_SERVO_OUTPUT_RAW_fn mav_pack_servo_output_raw
#define mav_pack_RC_CHANNELS_fn mav_pack_rc_channels
#define mav_pack_VFR_HUD_fn mav_pack_vfr_hud
#define mav_pack_COMMAND_ACK_fn mav_pack_command_ack
#define mav_pack_STATUSTEXT_fn mav_pack_statustext
#define mav_pack_PARAM_VALUE_fn mav_pack_param_value
#define mav_pack_MISSION_COUNT_fn mav_pack_mission_count
#define mav_pack_MISSION_ITEM_INT_fn mav_pack_mission_item_int
#define mav_pack_MISSION_ITEM_fn mav_pack_mission_item
#define mav_pack_MISSION_REQUEST_INT_fn mav_pack_mission_request_int
#define mav_pack_MISSION_ACK_fn mav_pack_mission_ack
#define mav_pack_MISSION_ITEM_REACHED_fn mav_pack_mission_item_reached
#define mav_pack_HOME_POSITION_fn mav_pack_home_position
#define mav_pack_POWER_STATUS_fn mav_pack_power_status
#define mav_pack_NAV_CONTROLLER_OUTPUT_fn mav_pack_nav_controller_output

// STATUSTEXT, also kept for the sketch's own use. Severity: 2 critical, 4 warning, 6 info.
void text(uint8_t severity, const char* fmt, ...);

// ------------------------------------------------------------------ state
Status st;
uint32_t now_ms = 0, boot_ms = 0;
uint8_t mode = MANUAL;
bool armed = false;
uint32_t last_rx_ms = 0;            // any byte from the phone
uint32_t last_gcs_hb_ms = 0;        // laptop heartbeat
bool gcs_seen = false;
uint8_t gcs_sys = 255, gcs_comp = 190;

// GPS + heading (from the phone)
struct {
  bool have = false;
  uint32_t t_ms = 0;
  int32_t lat = 0, lon = 0;
  float alt = 0, hacc = 99, hdop = 99, vn = 0, ve = 0, speed = 0;
  bool vel_ok = false;
  uint8_t fix = 0, sats = 0;
  bool yaw_ok = false;
  uint32_t yaw_t_ms = 0;
  uint32_t msg_count = 0;           // GPS_INPUT messages seen (with or without a fix)
  float yaw = 0;                    // phone compass, deg
} gps;
float heading = -1;                 // what the brain steers by (deg), -1 unknown
uint32_t heading_t_ms = 0;
float compass_bias = 0;             // learnt from the GPS course
uint32_t straight_since_ms = 0;
float cog_deg = -1;
// The phone reports a few times a second: keep the last measured heading and a
// filtered turn rate, and predict between reports (smooth 50 Hz steering, and a
// damping term that does not kick the fins at every new compass sample).
uint32_t hdg_src_n = 0;             // gps.msg_count of the last report used
float hdg_meas = -1;                // last measured heading (deg)
uint32_t hdg_meas_t = 0;
float hdg_rate = 0;                 // deg/s, + = turning right (the gyro's, or filtered)
// The turn rate comes from the phone's gyro (50 Hz ATTITUDE). Without it (an older
// phone app) the rate is differentiated from a 5-10 Hz heading - late and noisy -
// so the heading loops run at about half gain (GYRO_LESS_GAIN).
bool gyro_heading = false;
const float GYRO_LESS_GAIN = 0.5f;
// The phone's fused compass + gyro at 50 Hz (ATTITUDE from VARUNA Boat Link 2.1+):
// the fast heading source. Without it (older app) the GPS_INPUT yaw is used.
struct {
  uint32_t n = 0;                   // messages seen
  uint32_t t_ms = 0;
  float yaw = 0;                    // deg, 0..360 (true north, before COMPASS_OFS / the learnt bias)
  float rate = 0;                   // deg/s from the gyro, + = turning right
} att;
bool att_fresh() { return att.n && now_ms - att.t_ms <= 300; }

// home
bool home_set = false;
int32_t home_lat = 0, home_lon = 0;
float home_alt = 0;

// RC: receiver + overrides
uint16_t radio_us[8] = {0};
uint8_t radio_count = 0;
uint32_t radio_t_ms = 0;
bool rc_fresh = false;               // a new receiver frame since the last control pass
bool radio_seen = false;
uint16_t ovr_us[8] = {0};
uint32_t ovr_t_ms[8] = {0};
bool gamepad_thr = false;            // the laptop's CH3 came with CH1: its game controller (1500 = stop)
int8_t last_mode_pos = -1;
uint32_t stick_arm_since = 0, stick_disarm_since = 0;

// outputs
uint16_t servo_set[8] = {0};        // DO_SET_SERVO values (function 0 outputs)
uint32_t motor_test_until = 0;
uint8_t motor_test_seq = 0;
float motor_test_val = 0;           // µs (motor_test_pwm) or % thrust
bool motor_test_pwm = true;
bool relay_on[4] = {false};          // what the relays are doing now
bool relay_cmd[4] = {false};         // what the laptop / mission asked (DO_SET_RELAY)
bool brush_now = false;
uint16_t gate_us = 1000;             // the gate servo's pulse now (glides towards gate_goal)
float gate_pos = 1000;               // ... with the fraction of a microsecond
float gate_goal = 1000;              // where the gate / scoop servo is going
uint16_t gate_cmd_us = 0;            // the laptop's gate command (scoop button), until the mode changes
uint16_t knob_ref = 0;               // VrB where it was when MANUAL began
bool knob_live = false;              // VrB turned since: it drives the gate
bool gate_auto_open = false;
int8_t rc_side = -1;                 // SwD: -1 not seen yet, 0 MANUAL, 1 auto
uint32_t reboot_at = 0;

// control
float steer_cmd = 0, thr_cmd = 0;   // -1..1, -1..1 (before the mixer; thrust < 0 = reverse)
float rate_int = 0;                 // rate loop integrator (steering)
float rate_want = 0;                // deg/s the heading loop asked for (reported)
float spd_int = 0;
float man_hold = -1;                // MANUAL heading hold (stick centred), -1 = none
// Each motor's thrust as it is sent (slew limited, stops before it reverses).
float mot_now[2] = {0, 0};
int8_t mot_dir[2] = {0, 0};         // direction it last turned: +1 / -1
uint32_t mot_zero_ms[2] = {0, 0};   // when it got to a stop
float target_speed = -1;            // DO_CHANGE_SPEED (m/s), -1 = default
float acro_hold = -1;

// targets
struct Target {
  bool valid = false;
  int32_t lat = 0, lon = 0;
  bool have_origin = false;         // track line from origin -> target
  int32_t olat = 0, olon = 0;
  float radius = 3;
};
Target tgt;
bool loiter_moving = false;         // position keeping: correcting back onto the point
float nav_bearing = 0, nav_dist = -1, nav_xtrack = 0;

// mission
struct Item {
  uint16_t cmd;
  uint8_t frame;
  float p1, p2, p3, p4;
  int32_t x, y;
  float z;
};
Item mission[MAX_ITEMS];
uint16_t mis_count = 0;            // incl. item 0 (home)
uint16_t mis_cur = 0;
uint16_t mis_start = 0;            // set-current while not in AUTO: where AUTO starts (DO items included)
bool mis_reached = false;           // current nav item reached (holding there)
uint32_t mis_hold_until = 0;
bool mis_done = false;
uint32_t mis_delay_until = 0;
// upload in progress
bool up_active = false;
uint16_t up_count = 0, up_next = 0;
uint32_t up_t_ms = 0;
uint8_t up_tries = 0;
uint8_t up_sys = 255, up_comp = 190;
Item up_buf[MAX_ITEMS];
// download
uint8_t dl_sys = 255, dl_comp = 190;

// stream timing
uint32_t t_hb = 0, t_pos = 0, t_att = 0, t_servo = 0, t_rc = 0;
bool want_power = false;
uint32_t t_power = 0;
uint32_t msgs_rx = 0;

// ------------------------------------------------------------------ STATUSTEXT
}  // namespace
}  // namespace brain

#include <stdarg.h>

namespace brain {
namespace {

void text(uint8_t severity, const char* fmt, ...) {
  mav_statustext_t m;
  memset(&m, 0, sizeof m);
  m.severity = severity;
  va_list ap;
  va_start(ap, fmt);
  char buf[51];
  vsnprintf(buf, sizeof buf, fmt, ap);
  va_end(ap);
  memcpy(m.text, buf, strlen(buf) < 50 ? strlen(buf) : 50);
  SEND(STATUSTEXT, m, true);
}

void ack(uint16_t cmd, uint8_t result, uint8_t to_sys, uint8_t to_comp) {
  mav_command_ack_t m;
  memset(&m, 0, sizeof m);
  m.command = cmd;
  m.result = result;
  m.target_system = to_sys;
  m.target_component = to_comp;
  SEND(COMMAND_ACK, m, true);
}

// ------------------------------------------------------------------ RC input -> -1..1 / 0..1
// What channel c (0-based) reads now: an override from the laptop, else the receiver, else 0.
// The transmitter has the boat: SwD on MANUAL (AB_MODE_SW 1) and the receiver is live.
bool rx_drives() { return pv(I.mode_sw) > 0.5f && st.radio_ok && rc_side == 0; }
bool ovr_live(uint8_t c) {
  return c < 8 && ovr_us[c] && now_ms - ovr_t_ms[c] <= (uint32_t)(pv(I.rc_override_time) * 1000.f);
}
// The laptop's sticks (app / game controller): 1100..1500..1900 us, 1500 = centre / stop,
// whatever the transmitter's RC calibration is (ArduRover's own default range).
float laptop_norm(uint16_t us) {
  float d = (float)us - 1500.f;
  if (fabsf(d) <= 30.f) return 0;
  return clampf((d - (d > 0 ? 30.f : -30.f)) / 370.f, -1, 1);
}

uint16_t chan_us(uint8_t c) {
  if (c >= 8) return 0;
  if (rx_drives() && c < radio_count) return radio_us[c];     // the pilot wins
  uint32_t ovr_ms = (uint32_t)(pv(I.rc_override_time) * 1000.f);
  if (ovr_us[c] && now_ms - ovr_t_ms[c] <= ovr_ms) return ovr_us[c];
  if (st.radio_ok && c < radio_count) return radio_us[c];
  return 0;
}
// ArduPilot's pwm_to_angle_dz_trim, as -1..1 (steering) or 0..1 (throttle, trim at the bottom)
float chan_norm(uint8_t c, uint16_t us) {
  float mn = pv(I.rc_min[c]), mx = pv(I.rc_max[c]), tr = pv(I.rc_trim[c]), dz = pv(I.rc_dz[c]);
  float r;
  if (us > tr + dz) r = (us - (tr + dz)) / fmaxf(1.f, mx - (tr + dz));
  else if (us < tr - dz) r = -((tr - dz) - us) / fmaxf(1.f, (tr - dz) - mn);
  else r = 0;
  r = clampf(r, -1, 1);
  if (pv(I.rc_rev[c]) > 0.5f) r = -r;
  return r;
}
float stick_steer() {
  float s;
  if (!rx_drives() && ovr_live(0)) {
    s = laptop_norm(ovr_us[0]);                 // the laptop always steers on CH1
  } else {
    uint8_t c = (uint8_t)clampf(pv(I.rcmap_roll), 1, 8) - 1;   // the transmitter: CH4
    uint16_t us = chan_us(c);
    if (!us) return 0;
    s = chan_norm(c, us);
  }
  float e = clampf(pv(I.steer_expo), 0, 0.9f);
  return (1 - e) * s + e * s * s * s;
}
bool reversible() { return pv(I.reversible) > 0.5f; }
// Throttle stick -1..1 (below RC3_TRIM = reverse, bidirectional ESCs only).
float stick_throttle() {
  uint8_t c = (uint8_t)clampf(pv(I.rcmap_throttle), 1, 8) - 1;
  if (!rx_drives() && ovr_live(c) && gamepad_thr)
    return clampf(laptop_norm(ovr_us[c]), reversible() ? -1 : 0, 1);
  // The transmitter, or the app's motor push (it reads RC3_MIN/TRIM/MAX and sends CH3 alone).
  uint16_t us = chan_us(c);
  if (!us) return 0;
  return clampf(chan_norm(c, us), reversible() ? -1 : 0, 1);
}
bool throttle_low() { return fabsf(stick_throttle()) < 0.05f; }

// The receiver's channel ch1 (1-based) is there now.
bool rc_has(uint8_t ch1) { return ch1 >= 1 && ch1 <= 8 && st.radio_ok && ch1 <= radio_count; }
// A 2-position switch (SwA, SwD) is down (> 1500 us; RCn_REVERSED flips it).
bool sw_high(uint8_t ch1) {
  bool hi = radio_us[ch1 - 1] > 1500;
  return pv(I.rc_rev[ch1 - 1]) > 0.5f ? !hi : hi;
}
// The transmitter's SwD is on MANUAL: the pilot drives, the laptop cannot change the mode.
bool rc_manual_lock() { return pv(I.mode_sw) > 0.5f && st.radio_ok && rc_side == 0; }

// ------------------------------------------------------------------ position / heading
bool gps_ok() {
  return gps.have && gps.fix >= 3 && now_ms - gps.t_ms <= (uint32_t)(pv(I.gps_timeout) * 1000.f) &&
         gps.hacc <= pv(I.gps_min_acc);
}
bool heading_ok() { return heading >= 0 && now_ms - heading_t_ms <= 1500; }

// Learn the compass error while running straight and fast enough for a good GPS
// course (time constant ~10 s at 5-10 fixes a second, so a side current's crab
// averages out). raw = compass heading before the learnt bias.
void learn_compass(float raw, bool course) {
  if (course && pv(I.cog_learn) > 0.5f && fabsf(hdg_rate) < 6.f && gps.speed > 1.0f) {
    if (!straight_since_ms) straight_since_ms = now_ms;
    if (now_ms - straight_since_ms > 2000) {
      float err = wrap180(cog_deg - wrap360(raw + compass_bias));
      if (fabsf(err) < 45) compass_bias = clampf(compass_bias + 0.02f * err, -60, 60);
    }
  } else {
    straight_since_ms = 0;
  }
}

void update_heading() {
  bool course = gps.vel_ok && gps.speed > 0.7f && now_ms - gps.t_ms <= 1500;
  cog_deg = course ? wrap360(atan2f(gps.ve, gps.vn) / DEG) : -1;
  bool fresh = gps.msg_count != hdg_src_n;
  // Fast path: the phone's compass + gyro at 50 Hz. The gyro gives the turn rate
  // directly (no differentiating, no lag); the heading is carried forward with it
  // for the few ms since the last message.
  if (pv(I.compass_use) > 0.5f && att_fresh()) {
    float age = fminf((now_ms - att.t_ms) / 1000.f, 0.1f);
    float raw = wrap360(att.yaw + pv(I.compass_ofs) + att.rate * age);
    if (fresh) {
      hdg_src_n = gps.msg_count;
      learn_compass(raw, course);
    }
    hdg_rate = att.rate;
    gyro_heading = true;
    heading = wrap360(raw + compass_bias);
    heading_t_ms = att.t_ms;
    hdg_meas = heading;
    hdg_meas_t = now_ms;
    return;
  }
  bool compass = pv(I.compass_use) > 0.5f && gps.yaw_ok && now_ms - gps.yaw_t_ms <= 1500;
  gyro_heading = false;
  if (!fresh) {
    // Between reports: predict with the turn rate (for at most 0.4 s).
    if (hdg_meas >= 0 && now_ms - heading_t_ms <= 1500) {
      float age = fminf((now_ms - hdg_meas_t) / 1000.f, 0.4f);
      heading = wrap360(hdg_meas + hdg_rate * age);
    }
    return;
  }
  hdg_src_n = gps.msg_count;
  float h = -1;
  if (compass) {
    float raw = wrap360(gps.yaw + pv(I.compass_ofs));
    learn_compass(raw, course);
    h = wrap360(raw + compass_bias);
  } else if (course) {
    h = cog_deg;
  }
  if (h < 0) {
    hdg_rate = 0;
    return;
  }
  if (hdg_meas >= 0 && now_ms - hdg_meas_t < 1000 && now_ms > hdg_meas_t) {
    float r = wrap180(h - hdg_meas) / ((now_ms - hdg_meas_t) / 1000.f);
    hdg_rate += 0.35f * (clampf(r, -180, 180) - hdg_rate);
  } else {
    hdg_rate = 0;
  }
  hdg_meas = h;
  hdg_meas_t = now_ms;
  heading = h;
  heading_t_ms = now_ms;
}

void send_home();

void set_home_here(bool quiet) {
  if (!gps_ok()) return;
  home_lat = gps.lat;
  home_lon = gps.lon;
  home_alt = gps.alt;
  bool was = home_set;
  home_set = true;
  if (!quiet || !was) text(6, "Home set %.6f %.6f", home_lat * 1e-7, home_lon * 1e-7);
  send_home();   // as ArduPilot: tell the ground station whenever home moves
}

// ------------------------------------------------------------------ modes
bool needs_position(uint8_t m) { return m == AUTO || m == GUIDED || m == RTL || m == SMART_RTL || m == LOITER; }
bool mode_known(uint8_t m) {
  return m == MANUAL || m == ACRO || m == STEERING || m == HOLD || m == LOITER || m == AUTO || m == RTL ||
         m == SMART_RTL || m == GUIDED;
}

void reset_control() {
  rate_int = 0;
  spd_int = 0;
  man_hold = -1;
  loiter_moving = false;
}

void loiter_here() {
  tgt.valid = gps_ok();
  tgt.lat = gps.lat;
  tgt.lon = gps.lon;
  tgt.have_origin = false;
  tgt.radius = pv(I.loit_radius);
  loiter_moving = false;
}

void start_mission_item();

// Returns 0 if switched, else the MAV_RESULT and a reason already sent as STATUSTEXT.
uint8_t set_mode(uint8_t m, const char* why) {
  if (!why && m != MANUAL && rc_manual_lock()) {
    text(4, "Mode change to %s refused: transmitter SwD is on MANUAL", mode_name(m));
    return DENIED;
  }
  if (!mode_known(m)) {
    text(4, "Mode %u not supported", m);
    return UNSUPPORTED;
  }
  if (needs_position(m) && !gps_ok()) {
    text(4, "Mode change to %s failed: requires position", mode_name(m));
    return FAILED;
  }
  if (m == AUTO && mis_count < 2) {
    text(4, "Mode change to AUTO failed: no mission");
    return FAILED;
  }
  if ((m == RTL || m == SMART_RTL) && !home_set) {
    text(4, "Mode change to RTL failed: no home");
    return FAILED;
  }
  uint8_t old = mode;
  mode = m;
  if (old != m) gate_cmd_us = 0;    // a new mode: the gate follows its own rule again
  reset_control();
  tgt.valid = false;
  acro_hold = -1;
  if (m == LOITER) loiter_here();
  if (m == RTL || m == SMART_RTL) {
    tgt.valid = true;
    tgt.lat = home_lat;
    tgt.lon = home_lon;
    tgt.have_origin = gps_ok();
    tgt.olat = gps.lat;
    tgt.olon = gps.lon;
    tgt.radius = pv(I.wp_radius);
  }
  if (m == GUIDED) loiter_here();   // until a target comes: keep the position
  if (m == AUTO) {
    if (mis_start >= 1 && mis_start < mis_count) mis_cur = mis_start;
    mis_start = 0;
    if (mis_cur < 1 || mis_cur >= mis_count) mis_cur = 1;
    mis_done = false;
    start_mission_item();
  }
  if (old != m) text(6, "Mode %s%s%s", mode_name(m), why ? " - " : "", why ? why : "");
  return ACCEPTED;
}

void do_arm(bool on, const char* why) {
  if (armed == on) return;
  armed = on;
  reset_control();
  if (on) {
    if (gps_ok()) set_home_here(false);
    text(6, "Throttle armed%s%s", why ? " - " : "", why ? why : "");
  } else {
    motor_test_until = 0;
    text(6, "Throttle disarmed%s%s", why ? " - " : "", why ? why : "");
  }
}

// MAV_RESULT for an arming request (reason sent as STATUSTEXT).
uint8_t try_arm(bool force) {
  if (!force && pv(I.arming_check) > 0.5f) {
    if (!throttle_low()) {
      text(4, "PreArm: Throttle (RC%d) is not neutral", (int)pv(I.rcmap_throttle));
      return FAILED;
    }
    if (needs_position(mode) && !gps_ok()) {
      text(4, "PreArm: need a GPS fix in %s", mode_name(mode));
      return FAILED;
    }
    if (needs_position(mode) && !heading_ok()) {
      text(4, "PreArm: no heading (phone compass)");
      return FAILED;
    }
  }
  do_arm(true, force ? "forced" : nullptr);
  return ACCEPTED;
}

// ------------------------------------------------------------------ failsafe
bool fs_gps = false, fs_gcs = false, fs_radio = false;

void failsafe_action(const char* reason, bool can_rtl) {
  int act = (int)pv(I.fs_action);
  if (act == 1 && can_rtl && home_set && gps_ok()) {
    text(2, "Failsafe: %s - RTL", reason);
    set_mode(RTL, "failsafe");
  } else if (act != 0) {
    text(2, "Failsafe: %s - HOLD", reason);
    set_mode(HOLD, "failsafe");
  } else {
    text(2, "Failsafe: %s", reason);
  }
}

bool overrides_active() {
  uint32_t ovr_ms = (uint32_t)(pv(I.rc_override_time) * 1000.f);
  for (int c = 0; c < 8; c++)
    if (ovr_us[c] && now_ms - ovr_t_ms[c] <= ovr_ms) return true;
  return false;
}

void check_failsafes() {
  bool selfdriving = mode == AUTO || mode == GUIDED || mode == RTL || mode == SMART_RTL || mode == LOITER;
  bool manual = mode == MANUAL || mode == ACRO || mode == STEERING;
  // The phone (GPS, laptop) went silent: nothing may keep pushing (see mix_and_output).
  st.link_ok = last_rx_ms && now_ms - last_rx_ms <= (uint32_t)(pv(I.link_timeout) * 1000.f);
  st.gcs_ok = gcs_seen && now_ms - last_gcs_hb_ms <= (uint32_t)(pv(I.fs_gcs_timeout) * 1000.f);
  st.radio_ok = radio_count && now_ms - radio_t_ms <= (uint32_t)(pv(I.fs_timeout) * 1000.f);
  if (st.radio_ok && pv(I.fs_thr_enable) > 0.5f) {
    uint8_t tc = (uint8_t)clampf(pv(I.rcmap_throttle), 1, 8) - 1;
    if (tc < radio_count && radio_us[tc] < pv(I.fs_thr_value)) st.radio_ok = false;
  }
  // GPS lost while driving itself -> HOLD (it can't go anywhere without knowing where it is).
  if (!fs_gps && armed && selfdriving && !gps_ok()) {
    fs_gps = true;
    failsafe_action("GPS lost", false);
  } else if (fs_gps && gps_ok()) {
    fs_gps = false;
    text(6, "GPS back");
  }
  // Laptop lost while driving itself.
  bool gcs_bad = pv(I.fs_gcs_enable) > 0.5f && gcs_seen && !st.gcs_ok;
  if (!fs_gcs && armed && selfdriving && gcs_bad) {
    fs_gcs = true;
    failsafe_action("laptop link lost", true);
  } else if (fs_gcs && !gcs_bad) {
    fs_gcs = false;
    text(6, "Laptop link back");
  }
  // Transmitter lost while it was driving (laptop overrides keep a manual mode alive).
  bool radio_bad = radio_seen && !st.radio_ok && pv(I.fs_thr_enable) > 0.5f && !overrides_active();
  if (!fs_radio && armed && manual && radio_bad) {
    fs_radio = true;
    failsafe_action("radio lost", true);
  } else if (fs_radio && st.radio_ok) {
    fs_radio = false;
    text(6, pv(I.mode_sw) > 0.5f ? "Radio back - flip SwD to take control again" : "Radio back");
  }
  st.failsafe = fs_gps || fs_gcs || fs_radio || (armed && !st.link_ok && !st.radio_ok);
}

// ------------------------------------------------------------------ navigation
float DT = 0.02f;  // seconds since the last control pass (50 Hz, or each new receiver frame)

// Speed through the water along the bow (+ forward, - backwards), m/s.
float fwd_speed() {
  if (!gps.vel_ok || now_ms - gps.t_ms > 1500) return 0;
  if (!heading_ok()) return gps.speed;
  float h = heading * DEG;
  return gps.vn * cosf(h) + gps.ve * sinf(h);
}

// Rate loop (the drone's inner loop): one steering command that makes the boat
// turn at `want` deg/s, measured by the phone's gyro. Feed-forward gives the
// turn at once, P corrects it, I trims out a crooked fin or unequal motors.
void rate_control(float want) {
  float rmax = fmaxf(5.f, pv(I.rate_max));
  want = clampf(want, -rmax * 1.5f, rmax * 1.5f);   // the sticks (ACRO) may ask a bit more
  rate_want = want;
  float g = gyro_heading ? 1.f : GYRO_LESS_GAIN;
  float e = want - hdg_rate;
  float ff = pv(I.rate_ff) * want;
  float p = pv(I.rate_p) * g * e;
  float u = ff + p + rate_int;
  // Integrate only while the output is not stuck at the end the error pushes towards.
  if (!((u >= 1.f && e > 0) || (u <= -1.f && e < 0)))
    rate_int = clampf(rate_int + pv(I.rate_i) * g * e * DT, -pv(I.rate_imax), pv(I.rate_imax));
  steer_cmd = clampf(ff + p + rate_int, -1, 1);
}

// Angle loop (the drone's outer loop): heading error -> wanted turn rate.
// Returns the heading error (deg).
float heading_control(float want_deg) {
  float err = wrap180(want_deg - heading);
  float rmax = fmaxf(5.f, pv(I.rate_max));
  float g = gyro_heading ? 1.f : GYRO_LESS_GAIN;
  rate_control(clampf(pv(I.hdg_p) * g * err, -rmax, rmax));
  return err;
}

// Steering + thrust to run along `want_deg` at `speed_target` m/s.
void steer_to_heading(float want_deg, float speed_target, bool keep_thrust_on_turns) {
  if (!heading_ok()) {
    // No heading yet (no compass, standing still): go gently straight to get a GPS course.
    steer_cmd = 0;
    thr_cmd = pv(I.min_thr) / 100.f;
    return;
  }
  float err = heading_control(want_deg);
  bool rev = reversible();
  float brake = rev ? clampf(pv(I.brake), 0, 100) / 100.f : 0;
  float v = fwd_speed();
  float pivot = pv(I.pivot_deg);
  if (fabsf(err) > pivot) {
    if (rev) {
      // Way off: turn on the spot - the motors spin opposite ways (the mixer does it
      // at zero thrust); brake first if it is still running forward.
      thr_cmd = v > 0.4f ? -brake * 0.5f : 0;
      spd_int = 0;
    } else {
      // Forward-only ESCs: turn on air over the fins + motor difference.
      thr_cmd = pv(I.turn_thr) / 100.f;
    }
    return;
  }
  // Ask for less speed while the bow is not yet on the line (smooth, no wide arcs).
  float c = cosf(fminf(fabsf(err), 89.f) * DEG);
  float target = speed_target * fmaxf(0.25f, c);
  // Thrust: speed controller (reverse thrust brakes when it is too fast).
  float cruise_thr = pv(I.cruise_throttle) / 100.f;
  float cruise = fmaxf(0.1f, pv(I.cruise_speed));
  float base = cruise_thr * clampf(target / cruise, 0, 2);
  float spd_err = gps.vel_ok ? target - v : 0;
  float thr = base + pv(I.spd_p) / 100.f * spd_err + spd_int;
  if (!((thr >= 1.f && spd_err > 0) || (thr <= -brake && spd_err < 0)))
    spd_int = clampf(spd_int + pv(I.spd_i) / 100.f * spd_err * DT, -0.3f, 0.3f);
  thr = base + pv(I.spd_p) / 100.f * spd_err + spd_int;
  if (fabsf(err) > 25 && !rev)
    thr = fmaxf(thr * 0.6f, keep_thrust_on_turns ? pv(I.turn_thr) / 100.f * 0.8f : pv(I.min_thr) / 100.f);
  // Turning hard needs air over the fin, unless it is braking.
  float lo = (fabsf(steer_cmd) > 0.3f && spd_err > -0.2f) ? pv(I.min_thr) / 100.f : -brake;
  thr_cmd = clampf(thr, lo, 1);
}

// On the point: stop it gliding past (reverse thrust, bow kept straight), then let it drift.
void brake_here() {
  steer_cmd = 0;
  thr_cmd = 0;
  if (!reversible() || !heading_ok() || !armed) return;
  float v = fwd_speed();
  if (fabsf(v) > 0.2f) {
    float brake = clampf(pv(I.brake), 0, 100) / 100.f;
    thr_cmd = clampf(-pv(I.spd_p) / 100.f * 2.f * v, -brake, brake);
    rate_control(0);
  }
}

float nav_to(const Target& t, float speed) {
  float d = dist_m(gps.lat, gps.lon, t.lat, t.lon);
  float b = bearing_deg(gps.lat, gps.lon, t.lat, t.lon);
  nav_xtrack = 0;
  if (t.have_origin) {
    // Pure pursuit on the line origin -> target: aim at a point AB_LOOKAHEAD metres ahead along it.
    float on, oe, pn, pe;
    ne_of(t.olat, t.olon, t.lat, t.lon, &on, &oe);
    ne_of(t.olat, t.olon, gps.lat, gps.lon, &pn, &pe);
    float L = sqrtf(on * on + oe * oe);
    if (L > 1.f) {
      float ux = on / L, uy = oe / L;
      float along = pn * ux + pe * uy;
      nav_xtrack = pn * uy - pe * ux;  // + = left of the line... sign only for the report
      float la = fmaxf(pv(I.lookahead), 2.f);
      float aim = fminf(L, fmaxf(0.f, along) + la);
      float an = ux * aim - pn, ae = uy * aim - pe;
      if (d > la) b = wrap360(atan2f(ae, an) / DEG);
    }
  }
  // Slow down over the last metres so it does not overshoot (an air boat glides).
  float slow = fmaxf(1.f, pv(I.slow_dist));
  float v = speed;
  if (d < slow) v = fmaxf(pv(I.loit_speed), speed * d / slow);
  steer_to_heading(b, v, true);
  nav_bearing = b;
  nav_dist = d;
  return d;
}

// Keep the boat on a point: drift freely inside LOIT_RADIUS, push back when it leaves.
void keep_position(const Target& t) {
  if (!t.valid || !gps_ok()) {
    steer_cmd = 0;
    thr_cmd = 0;
    return;
  }
  float d = dist_m(gps.lat, gps.lon, t.lat, t.lon);
  float r = fmaxf(1.f, t.radius);
  if (d > r) loiter_moving = true;
  else if (d < r * 0.5f) loiter_moving = false;
  nav_dist = d;
  if (!loiter_moving) {
    reset_control();
    brake_here();            // bidirectional ESCs: stop the glide, then drift with the motors off
    loiter_moving = false;
    return;
  }
  Target t2 = t;
  t2.have_origin = false;
  nav_to(t2, fmaxf(0.2f, pv(I.loit_speed)));
}

float wanted_speed() {
  if (target_speed > 0) return target_speed;
  if (mode == RTL && pv(I.rtl_speed) > 0) return pv(I.rtl_speed);
  if (pv(I.wp_speed) > 0) return pv(I.wp_speed);
  return pv(I.cruise_speed);
}

// ------------------------------------------------------------------ mission
bool is_nav(uint16_t cmd) { return cmd == 16 || cmd == 17 || cmd == 19 || cmd == 20 || cmd == 21 || cmd == 31; }

void send_mission_current() {
  mav_mission_current_t m;
  memset(&m, 0, sizeof m);
  m.seq = mis_cur;
  m.total = mis_count ? mis_count - 1 : 0;
  m.mission_state = mode == AUTO ? 3 : (mis_count > 1 ? 2 : 1);  // ACTIVE / NOT_STARTED / NO_MISSION
  m.mission_mode = mode == AUTO ? 1 : 0;
  SEND(MISSION_CURRENT, m, false);
}

void reached(uint16_t seq) {
  mav_mission_item_reached_t m;
  m.seq = seq;
  SEND(MISSION_ITEM_REACHED, m, true);
  text(6, "Reached waypoint #%u", seq);
}

void do_set_servo(int out, int us);
void do_set_relay(int idx, bool on);

void mission_finished() {
  mis_done = true;
  text(6, "Mission complete");
  if (pv(I.mis_done) > 0.5f) {
    loiter_here();
    tgt.radius = pv(I.loit_radius);
  } else {
    tgt.valid = false;
  }
}

// Run DO items from mis_cur until a NAV item (which becomes the target).
void start_mission_item() {
  mis_reached = false;
  mis_hold_until = 0;
  int guard = 0;
  while (mis_cur < mis_count && guard++ < MAX_ITEMS) {
    Item& it = mission[mis_cur];
    if (is_nav(it.cmd)) {
      Target prev = tgt;
      tgt.valid = true;
      if (it.cmd == 20) {               // RETURN_TO_LAUNCH
        tgt.lat = home_lat;
        tgt.lon = home_lon;
      } else {
        tgt.lat = it.x;
        tgt.lon = it.y;
      }
      // Track line from the previous point (or where the boat is now).
      tgt.have_origin = true;
      if (prev.valid && (prev.lat != tgt.lat || prev.lon != tgt.lon)) {
        tgt.olat = prev.lat;
        tgt.olon = prev.lon;
      } else {
        tgt.olat = gps.lat;
        tgt.olon = gps.lon;
      }
      tgt.radius = (it.cmd == 16 && it.p2 > 0.5f) ? it.p2 : pv(I.wp_radius);
      send_mission_current();
      return;
    }
    // DO / CONDITION commands run at once
    switch (it.cmd) {
      case 178:                         // DO_CHANGE_SPEED: p2 m/s
        if (it.p2 > 0) target_speed = it.p2;
        break;
      case 183:                         // DO_SET_SERVO
        do_set_servo((int)it.p1, (int)it.p2);
        break;
      case 181:                         // DO_SET_RELAY
        do_set_relay((int)it.p1, it.p2 > 0.5f);
        break;
      case 179:                         // DO_SET_HOME
        if (it.p1 > 0.5f) set_home_here(false);
        else if (it.x || it.y) {
          home_lat = it.x;
          home_lon = it.y;
          home_set = true;
        }
        break;
      case 112:                         // CONDITION_DELAY: hold here p1 s
        mis_delay_until = now_ms + (uint32_t)(it.p1 * 1000.f);
        loiter_here();
        send_mission_current();
        return;
      default:
        break;
    }
    mis_cur++;
  }
  if (mis_cur >= mis_count) mission_finished();
}

void mission_update() {
  if (mis_done) {
    if (pv(I.mis_done) > 0.5f) keep_position(tgt);
    else {
      steer_cmd = 0;
      thr_cmd = 0;
    }
    return;
  }
  if (mis_delay_until) {
    keep_position(tgt);
    if ((int32_t)(now_ms - mis_delay_until) >= 0) {
      mis_delay_until = 0;
      mis_cur++;
      start_mission_item();
    }
    return;
  }
  if (mis_cur >= mis_count) {
    mission_finished();
    return;
  }
  Item& it = mission[mis_cur];
  if (!mis_reached) {
    float d = nav_to(tgt, wanted_speed());
    if (d <= tgt.radius) {
      mis_reached = true;
      reached(mis_cur);
      reset_control();
      if (it.cmd == 17 || (it.cmd == 20 && mis_cur + 1 >= mis_count)) {
        // LOITER_UNLIM, or RTL as the last item: stay here
        mis_hold_until = 0xFFFFFFFFu;
      } else {
        float hold = (it.cmd == 16 || it.cmd == 19) ? it.p1 : 0;
        mis_hold_until = now_ms + (uint32_t)(fmaxf(0, hold) * 1000.f);
      }
    }
    return;
  }
  // At the point: keep position while the hold time runs.
  Target here = tgt;
  here.radius = pv(I.loit_radius);
  keep_position(here);
  if (mis_hold_until != 0xFFFFFFFFu && (int32_t)(now_ms - mis_hold_until) >= 0) {
    mis_cur++;
    start_mission_item();
  }
}

// ------------------------------------------------------------------ outputs
void do_set_servo(int out, int us) {
  if (out < 1 || out > 8) return;
  servo_set[out - 1] = (uint16_t)clampf((float)us, 500, 2500);
  if (out == (int)pv(I.gate_out)) gate_cmd_us = servo_set[out - 1];   // the laptop's gate button
}
void do_set_relay(int idx, bool on) {
  if (idx < 0 || idx > 3) return;
  relay_cmd[idx] = on;
  if (on && idx == 0) st.alert_until_ms = now_ms + 1500;
}
void set_relay_pin(int k, bool on) {
  relay_on[k] = on;
  hal_relay((uint8_t)k, on != (pv(I.relay_low) > 0.5f));   // true = pin HIGH
}
int gate_index() {
  int g = (int)pv(I.gate_out) - 1;
  return (g >= 0 && g < 8 && (int)pv(I.sv_fn[g]) == 0) ? g : -1;
}

// Brushes (one relay) and the basket's lift gate (one servo):
//  - SwD on MANUAL: SwA switches the brushes; VrB sets the gate once the knob is turned
//    (until then the gate stays where it is - a 6-channel FS-i6 has no VrB channel).
//  - auto: the brushes run and the gate is open while collecting (armed in AUTO or
//    GUIDED); otherwise brushes off, gate closed so the catch stays in. The laptop's
//    relay / scoop buttons still work (the gate command lasts until the mode changes).
void gate_glide();
void collect_outputs() {
  bool manual_mode = mode == MANUAL || mode == ACRO || mode == STEERING;
  bool rcman = st.radio_ok && (pv(I.mode_sw) > 0.5f ? rc_side == 0 : manual_mode);
  bool collecting = armed && (mode == AUTO || mode == GUIDED);
  int b = (int)pv(I.brush_relay) - 1;
  if (b >= 0 && b < 4) {
    uint8_t bc = (uint8_t)pv(I.brush_ch);
    bool on = (rcman && rc_has(bc)) ? sw_high(bc) : (relay_cmd[b] || (pv(I.brush_auto) > 0.5f && collecting));
    if (on != brush_now) {
      brush_now = on;
      text(6, "Brushes %s", on ? "on" : "off");
    }
  } else b = -1;
  for (int k = 0; k < 4; k++) {
    bool want = k == b ? brush_now : relay_cmd[k];
    if (want != relay_on[k]) set_relay_pin(k, want);
  }
  int g = gate_index();
  if (g < 0) return;
  float closed = pv(I.sv_min[g]), open = pv(I.sv_max[g]);
  if (pv(I.sv_rev[g]) > 0.5f) {           // SERVO2_REVERSED 1: the servo opens towards MIN
    float t = closed;
    closed = open;
    open = t;
  }
  uint8_t gc = (uint8_t)pv(I.gate_ch);
  bool knob = rcman && rc_has(gc);
  if (knob) {
    uint16_t us = radio_us[gc - 1];
    if (!knob_ref) knob_ref = us;
    else if (!knob_live && (us > knob_ref + 40 || us + 40 < knob_ref)) knob_live = true;
    if (knob_live) {
      float f = clampf((us - 1000.f) / 1000.f, 0, 1);
      if (pv(I.rc_rev[gc - 1]) > 0.5f) f = 1 - f;
      float g2 = closed + f * (open - closed);
      // ignore the receiver's few-us flicker: a digital servo would buzz on it
      if (fabsf(g2 - gate_goal) >= 4.f || f <= 0.f || f >= 1.f) gate_goal = g2;
      gate_glide();
      return;
    }
  } else {
    knob_ref = 0;
    knob_live = false;
  }
  if (gate_cmd_us) {
    gate_goal = gate_cmd_us;
  } else if (pv(I.gate_auto) > 0.5f && !manual_mode) {
    gate_goal = collecting ? open : closed;
    if (collecting != gate_auto_open) {
      gate_auto_open = collecting;
      text(6, "Gate %s", collecting ? "open" : "closed");
    }
  }
  // MANUAL with the knob untouched: the gate stays where it is.
  gate_glide();
}

// The gate / scoop servo glides to gate_goal at AB_GATE_SPEED us/s, easing in at the
// start and out at the end, so a heavy scoop never jerks (0 = jump straight there).
float gate_vel = 0;   // us/s now
void gate_glide() {
  float vmax = pv(I.gate_speed);
  float d = gate_goal - gate_pos;
  if (vmax <= 0.f || fabsf(d) < 0.5f) {
    gate_pos = gate_goal;
    gate_vel = 0;
  } else {
    float acc = vmax * 4.f;                                   // full speed after 1/4 s
    float stop_v = sqrtf(2.f * acc * fabsf(d));               // the speed it can still stop from
    float want = (d > 0 ? 1.f : -1.f) * fminf(vmax, stop_v);
    gate_vel += clampf(want - gate_vel, -acc * DT, acc * DT);
    float step = gate_vel * DT;
    if ((d > 0 && step >= d) || (d < 0 && step <= d)) {
      gate_pos = gate_goal;
      gate_vel = 0;
    } else gate_pos += step;
  }
  gate_us = (uint16_t)(gate_pos + 0.5f);
}

// A servo (the fin): -1..1 around SERVOn_TRIM.
uint16_t scale_out(int s, float v) {
  float mn = pv(I.sv_min[s]), mx = pv(I.sv_max[s]), tr = pv(I.sv_trim[s]);
  if (pv(I.sv_rev[s]) > 0.5f) v = -v;
  v = clampf(v, -1, 1);
  float us = v >= 0 ? tr + v * (mx - tr) : tr + v * (tr - mn);
  return (uint16_t)clampf(us, 500, 2500);
}

// An air motor's ESC: thrust -1..1 -> pulse.
//  bidirectional (AB_REVERSIBLE 1): SERVOn_TRIM (1500) = stopped, up to MAX forward,
//    down to MIN reverse, jumping the ESC's own dead band (AB_MOT_DZ) so the first
//    bit of thrust already turns the propeller. SERVOn_REVERSED flips the direction
//    (a propeller that blows the wrong way - no rewiring needed).
//  forward-only (AB_REVERSIBLE 0): SERVOn_TRIM (1000) = stopped, up to MAX.
//
// The app's motor-matching card (laptop main.py, written for forward-only ESCs)
// still works and is safe: its raw-pulse tests (900-1500 us) are read as FORWARD
// thrust 0-50 % (motor_test_us_fwd), and the "starts here" point it saves in
// SERVOn_TRIM/MIN (e.g. 1085) is not taken as the stop signal - the ESC stays
// stopped at 1500 - but as that motor's own start jump (dead band), so both
// motors still start together.
struct MotorRange {
  float stop, dz, lo, hi;
};
MotorRange motor_range(int s) {
  float mn = pv(I.sv_min[s]), mx = pv(I.sv_max[s]), tr = pv(I.sv_trim[s]);
  MotorRange m;
  bool matched = tr < 1400.f;               // a forward-only start point, not a neutral
  m.stop = (tr >= 1400.f && tr <= 1600.f) ? tr : 1500.f;
  m.dz = matched ? clampf((tr + 15.f - 1000.f) / 2.f, 0, 200) : clampf(pv(I.mot_dz), 0, 200);
  m.hi = mx > m.stop + 100.f ? mx : 2000.f;
  m.lo = (!matched && mn < m.stop - 100.f) ? mn : 2.f * m.stop - m.hi;
  return m;
}

uint16_t motor_us(int s, float v) {
  float us;
  if (!reversible()) {
    float mx = pv(I.sv_max[s]), tr = pv(I.sv_trim[s]);
    us = tr + clampf(v, 0, 1) * (mx - tr);
  } else {
    MotorRange m = motor_range(s);
    if (pv(I.sv_rev[s]) > 0.5f) v = -v;
    v = clampf(v, -1, 1);
    if (fabsf(v) < 0.002f) us = m.stop;
    else if (v > 0) us = m.stop + m.dz + v * (m.hi - m.stop - m.dz);
    else us = m.stop - m.dz + v * (m.stop - m.dz - m.lo);
  }
  return (uint16_t)clampf(us, 500, 2500);
}

// A raw-pulse motor test (the forward-only matching card) on a bidirectional ESC:
// 1000 us = stopped ... 2000 us = full forward, straight (no start jump), so the
// card finds where the motor really starts. It can never spin a motor backwards.
uint16_t motor_test_us_fwd(int s, float pwm) {
  MotorRange m = motor_range(s);
  float f = clampf((pwm - 1000.f) / 1000.f, 0, 1);
  if (pv(I.sv_rev[s]) > 0.5f) return (uint16_t)(m.stop - f * (m.stop - m.lo));
  return (uint16_t)(m.stop + f * (m.hi - m.stop));
}

// Thrust actually sent to motor i: limited change per second (AB_SLEW), and a
// short stop (AB_REV_DELAY) before it turns the other way - a bidirectional ESC
// and its propeller live longer without instant full reversals.
float motor_slew(int i, float want, bool on) {
  if (!on) {
    mot_now[i] = 0;
    return 0;
  }
  float cur = mot_now[i];
  // MANUAL from the FS-i6 on forward-only ESCs: straight through (AB_MAN_SLEW 0), as
  // quick as the receiver wired to the ESCs. Everything else: AB_SLEW.
  bool direct = !reversible() && rx_drives() && (mode == MANUAL || mode == STEERING || mode == ACRO);
  float rate = direct ? pv(I.man_slew) : fmaxf(0.5f, pv(I.slew));
  if (direct && rate <= 0.f) {
    mot_now[i] = want;
    if (want > 0) mot_dir[i] = 1;
    return want;
  }
  float step = fmaxf(0.5f, rate) * DT;
  // Changing direction: down to a stop first.
  if (cur * want < 0) want = 0;
  if (cur == 0 && want != 0) {
    int8_t dir = want > 0 ? 1 : -1;
    if (mot_dir[i] && dir != mot_dir[i] && now_ms - mot_zero_ms[i] < (uint32_t)(pv(I.rev_delay) * 1000.f))
      want = 0;   // still in the pause before reversing
  }
  float nxt = cur + clampf(want - cur, -step, step);
  if (cur != 0 && (nxt == 0 || cur * nxt < 0)) {
    nxt = 0;
    mot_zero_ms[i] = now_ms;
  }
  if (nxt > 0) mot_dir[i] = 1;
  else if (nxt < 0) mot_dir[i] = -1;
  mot_now[i] = nxt;
  return nxt;
}

void mix_and_output() {
  bool rev = reversible();
  float cap = clampf(pv(I.mot_thr_max), 0, 100) / 100.f;
  float thr = clampf(thr_cmd, rev ? -1 : 0, 1);
  float steer = clampf(steer_cmd, -1, 1);
  float mix = clampf(pv((mode == MANUAL || mode == STEERING) ? I.man_diff : I.diff_mix), 0, 1);
  float l, r;
  if (rev) {
    // Steering = the motors' DIFFERENCE (yaw), on top of the thrust (surge), like a
    // drone's yaw mix. The same steering turns the boat the same way forwards and
    // backwards. Near zero thrust the motors spin opposite ways: a turn on the spot.
    float d = mix * steer;
    l = thr + d;
    r = thr - d;
    if (fabsf(thr) > 0.1f) {
      // Driving: the slower motor never reverses (it would rob the fin of air).
      if (thr > 0) { l = fmaxf(l, 0); r = fmaxf(r, 0); }
      else { l = fminf(l, 0); r = fminf(r, 0); }
    }
    // Keep the difference (the heading) when a side saturates: shift both.
    float hi = fmaxf(l, r), lo = fminf(l, r);
    if (hi > 1) { l -= hi - 1; r -= hi - 1; }
    if (lo < -1) { l += -1 - lo; r += -1 - lo; }
    l = clampf(l, -1, 1) * cap;
    r = clampf(r, -1, 1) * cap;
  } else {
    // Forward-only ESCs: no thrust = both stopped; the outer motor runs faster in a turn.
    float t = thr * cap;
    l = t * (1 + mix * steer);
    r = t * (1 - mix * steer);
    if (l > 1) { r -= l - 1; l = 1; }
    if (r > 1) { l -= r - 1; r = 1; }
    l = clampf(l, 0, 1);
    r = clampf(r, 0, 1);
  }
  bool on = armed && (st.link_ok || (st.radio_ok && (mode == MANUAL || mode == ACRO || mode == STEERING)));
  l = motor_slew(0, l, on);
  r = motor_slew(1, r, on);
  // The fin: full steering while the air blows backwards over it (forward thrust,
  // or a turn on the spot); when both motors blow forwards (reversing) the air
  // over the fin comes the other way - AB_REV_FIN sets what it does then (0 = centred).
  float fin = steer;
  if (armed && l + r < -0.05f) fin = steer * clampf(pv(I.rev_fin), -1, 1);
  st.thr_left = l;
  st.thr_right = r;
  st.steer = fin;
  uint16_t out[8];
  for (int s = 0; s < 8; s++) {
    int fn = (int)pv(I.sv_fn[s]);
    uint16_t us = 0;
    switch (fn) {
      case 26:  // GroundSteering: the fin servo (it works disarmed too, so you can see it)
        us = scale_out(s, fin);
        break;
      case 70:  // Throttle (both)
        us = motor_us(s, (l + r) / 2);
        break;
      case 73:
        us = motor_us(s, l);
        break;
      case 74:
        us = motor_us(s, r);
        break;
      case 0:   // DO_SET_SERVO (the gate output: collect_outputs())
        if (s == gate_index()) us = gate_us;
        else us = servo_set[s] ? servo_set[s] : (uint16_t)pv(I.sv_trim[s]);
        break;
      default:
        if (fn >= 51 && fn <= 58) {   // RCIN1..8 passthrough
          uint16_t v = chan_us((uint8_t)(fn - 51));
          us = v ? v : (uint16_t)pv(I.sv_trim[s]);
        }
        break;
    }
    // Motor test (disarmed only): one motor at a fixed pulse, or at a thrust
    // (percent, -100..100: negative = reverse on bidirectional ESCs).
    if (motor_test_until && (int32_t)(now_ms - motor_test_until) < 0) {
      bool hit = (motor_test_seq == 1 && (fn == 70 || fn == 73 || fn == 74)) ||
                 (motor_test_seq == 3 && fn == 73) || (motor_test_seq == 4 && fn == 74) ||
                 (motor_test_seq == 2 && fn == 26);
      if (hit) {
        if (motor_test_pwm && fn != 26 && reversible()) us = motor_test_us_fwd(s, motor_test_val);
        else if (motor_test_pwm) us = (uint16_t)clampf(motor_test_val, 900, 2100);
        else if (fn == 26) us = scale_out(s, motor_test_val / 100.f);
        else us = motor_us(s, motor_test_val / 100.f);
      }
    }
    out[s] = us;
    st.out[s] = us;
  }
  if (motor_test_until && (int32_t)(now_ms - motor_test_until) >= 0) motor_test_until = 0;
  hal_outputs(out);
}

// ------------------------------------------------------------------ control loop (50 Hz)
void control() {
  update_heading();
  st.gps_ok = gps_ok();
  st.heading_ok = heading_ok();
  check_failsafes();
  steer_cmd = 0;
  thr_cmd = 0;
  nav_dist = -1;
  rate_want = 0;
  bool hold_ok = armed && heading_ok() && pv(I.man_hold) > 0.5f;
  switch (mode) {
    case MANUAL:
    case STEERING: {
      // Sticks straight to the fin and motors. Steering stick centred while driving
      // (AB_MAN_HOLD): the compass + gyro keep the bow where it points, so the boat
      // runs dead straight - forwards and backwards.
      float s = stick_steer();
      thr_cmd = stick_throttle();
      if (fabsf(s) > 0.05f || fabsf(thr_cmd) < 0.05f || !hold_ok) {
        steer_cmd = s;
        man_hold = -1;
        rate_int = 0;
      } else {
        if (man_hold < 0) man_hold = wrap360(heading + hdg_rate * 0.3f);   // where it stops turning
        heading_control(man_hold);
      }
      break;
    }
    case ACRO: {
      // Like a drone's acro: the stick asks for a turn RATE (AB_ACRO_RATE at full
      // stick) and the gyro loop makes it; stick centred = hold that heading.
      float s = stick_steer();
      thr_cmd = stick_throttle();
      if (!heading_ok()) {
        steer_cmd = s;
        acro_hold = -1;
      } else if (fabsf(s) > 0.05f) {
        rate_control(s * pv(I.acro_rate));
        acro_hold = -1;
      } else {
        if (acro_hold < 0) acro_hold = wrap360(heading + hdg_rate * 0.3f);
        heading_control(acro_hold);
      }
      break;
    }
    case HOLD:
      break;
    case LOITER:
    case GUIDED:
      if (!gps_ok()) break;
      if (mode == GUIDED && tgt.valid && tgt.radius >= 0 && tgt.have_origin) {
        float d = nav_to(tgt, wanted_speed());
        if (d <= tgt.radius) {
          tgt.have_origin = false;          // there: keep it here now
          tgt.radius = pv(I.loit_radius);
          text(6, "Reached destination");
          reset_control();
        }
      } else {
        keep_position(tgt);
      }
      break;
    case RTL:
    case SMART_RTL:
      if (!gps_ok()) break;
      if (tgt.have_origin) {
        float d = nav_to(tgt, wanted_speed());
        if (d <= tgt.radius) {
          tgt.have_origin = false;
          tgt.radius = pv(I.loit_radius);
          text(6, "Reached home");
          reset_control();
        }
      } else {
        keep_position(tgt);
      }
      break;
    case AUTO:
      if (gps_ok()) mission_update();
      break;
  }
  if (!armed) {
    // Disarmed: fins still follow the stick (so they can be checked), no thrust.
    thr_cmd = 0;
    rate_int = 0;
    if (mode != MANUAL && mode != ACRO && mode != STEERING) steer_cmd = 0;
  }
  st.target_dist_m = nav_dist;
  collect_outputs();
  mix_and_output();
}

// ------------------------------------------------------------------ radio: mode switch + stick arming
void radio_logic() {
  // Mode switch (only on a change, like ArduPilot - the laptop can still set modes).
  uint8_t mc = (uint8_t)clampf(pv(I.mode_ch), 0, 8);
  if (pv(I.mode_sw) > 0.5f && rc_has(mc)) {
    // SwD: up = MANUAL, the transmitter drives; down = auto: the mission if one is
    // loaded, else HOLD - the laptop then picks AUTO / GUIDED / RTL.
    int8_t side = sw_high(mc) ? 1 : 0;
    if (side != rc_side) {
      rc_side = side;
      if (side == 0) set_mode(MANUAL, "SwD manual");
      else if (mode == MANUAL || mode == ACRO || mode == STEERING) {
        if (mis_count < 2 || set_mode(AUTO, "SwD auto") != ACCEPTED) set_mode(HOLD, "SwD auto - laptop in control");
      }
    }
  } else if (mc >= 1 && st.radio_ok && mc <= radio_count) {
    uint16_t us = radio_us[mc - 1];
    int pos = us < 1231 ? 0 : us < 1361 ? 1 : us < 1491 ? 2 : us < 1621 ? 3 : us < 1750 ? 4 : 5;
    if (pos != last_mode_pos) {
      if (last_mode_pos >= 0) set_mode((uint8_t)pv(I.mode[pos]), "mode switch");
      last_mode_pos = (int8_t)pos;
    }
  }
  // Stick arming: throttle low, steer hard right 2 s = arm; hard left 2 s = disarm.
  if (pv(I.arming_rudder) > 0.5f && st.radio_ok) {
    uint8_t c = (uint8_t)clampf(pv(I.rcmap_roll), 1, 8) - 1;
    float s = chan_norm(c, radio_us[c]);
    uint8_t tc = (uint8_t)clampf(pv(I.rcmap_throttle), 1, 8) - 1;
    bool low = radio_us[tc] < pv(I.rc_trim[tc]) + pv(I.rc_dz[tc]);
    if (low && s > 0.9f && !armed) {
      if (!stick_arm_since) stick_arm_since = now_ms;
      if (now_ms - stick_arm_since > 2000) {
        try_arm(false);
        stick_arm_since = 0;
      }
    } else stick_arm_since = 0;
    if (low && s < -0.9f && armed && pv(I.arming_rudder) > 1.5f) {
      if (!stick_disarm_since) stick_disarm_since = now_ms;
      if (now_ms - stick_disarm_since > 2000) {
        do_arm(false, "stick");
        stick_disarm_since = 0;
      }
    } else stick_disarm_since = 0;
  }
}

// ------------------------------------------------------------------ telemetry
uint8_t base_mode() {
  uint8_t b = 1;  // CUSTOM_MODE_ENABLED
  if (armed) b |= 128;
  if (mode == MANUAL || mode == ACRO || mode == STEERING) b |= 64;
  if (mode == AUTO) b |= 4;
  if (mode == GUIDED || mode == AUTO || mode == RTL || mode == LOITER) b |= 8;
  return b;
}

void send_heartbeat() {
  mav_heartbeat_t m;
  memset(&m, 0, sizeof m);
  m.type = MAV_TYPE_SURFACE_BOAT;
  m.autopilot = MAV_AUTOPILOT_ARDUPILOTMEGA;
  m.base_mode = base_mode();
  m.custom_mode = mode;
  m.system_status = st.failsafe ? 5 : (armed ? 4 : 3);  // CRITICAL / ACTIVE / STANDBY
  m.mavlink_version = 3;
  SEND(HEARTBEAT, m, true);
}

void send_position() {
  mav_global_position_int_t m;
  memset(&m, 0, sizeof m);
  m.time_boot_ms = now_ms - boot_ms;
  if (gps.have) {
    m.lat = gps.lat;
    m.lon = gps.lon;
    m.alt = (int32_t)(gps.alt * 1000.f);
    m.relative_alt = (int32_t)((gps.alt - (home_set ? home_alt : gps.alt)) * 1000.f);
    m.vx = (int16_t)(gps.vn * 100.f);
    m.vy = (int16_t)(gps.ve * 100.f);
  }
  m.hdg = heading_ok() ? (uint16_t)(heading * 100.f) : 65535;
  SEND(GLOBAL_POSITION_INT, m, false);
}

void send_attitude() {
  mav_attitude_t m;
  memset(&m, 0, sizeof m);
  m.time_boot_ms = now_ms - boot_ms;
  float h = heading_ok() ? heading : 0;
  m.yaw = wrap180(h) * DEG;
  m.yawspeed = heading_ok() ? hdg_rate * DEG : 0;
  SEND(ATTITUDE, m, false);
}

void send_vfr() {
  mav_vfr_hud_t m;
  memset(&m, 0, sizeof m);
  m.groundspeed = gps.vel_ok ? gps.speed : 0;
  m.airspeed = m.groundspeed;
  m.heading = heading_ok() ? (int16_t)heading : 0;
  m.throttle = (uint16_t)((fabsf(st.thr_left) + fabsf(st.thr_right)) * 50.f);
  m.alt = gps.alt;
  SEND(VFR_HUD, m, false);
}

void send_gps_raw() {
  mav_gps_raw_int_t m;
  memset(&m, 0, sizeof m);
  m.time_usec = (uint64_t)(now_ms - boot_ms) * 1000ull;
  bool fresh = gps.have && now_ms - gps.t_ms <= (uint32_t)(pv(I.gps_timeout) * 1000.f);
  m.fix_type = fresh ? gps.fix : 1;
  m.lat = gps.lat;
  m.lon = gps.lon;
  m.alt = (int32_t)(gps.alt * 1000.f);
  m.eph = (uint16_t)clampf(gps.hdop * 100.f, 0, 65535);
  m.epv = 65535;
  m.vel = (uint16_t)(gps.speed * 100.f);
  m.cog = cog_deg >= 0 ? (uint16_t)(cog_deg * 100.f) : 65535;
  m.satellites_visible = fresh ? gps.sats : 0;
  m.h_acc = (uint32_t)(gps.hacc * 1000.f);
  SEND(GPS_RAW_INT, m, false);
}

void send_sys_status() {
  mav_sys_status_t m;
  memset(&m, 0, sizeof m);
  const uint32_t GPS = 0x20, MAG = 0x04, RC = 0x10000, MOTORS = 0x8000;
  m.onboard_control_sensors_present = GPS | MAG | RC | MOTORS;
  m.onboard_control_sensors_enabled = GPS | MAG | MOTORS | (radio_seen ? RC : 0);
  m.onboard_control_sensors_health = (gps_ok() ? GPS : 0) | (gps.yaw_ok ? MAG : 0) | MOTORS | (st.radio_ok ? RC : 0);
  float v = pv(I.batt_monitor) > 0.5f ? hal_battery_v() : -1;
  m.voltage_battery = v > 0 ? (uint16_t)(v * 1000.f) : 65535;
  m.current_battery = -1;
  m.battery_remaining = -1;
  m.load = 100;
  SEND(SYS_STATUS, m, false);
}

void send_servo_out() {
  mav_servo_output_raw_t m;
  memset(&m, 0, sizeof m);
  m.time_usec = (now_ms - boot_ms) * 1000u;
  m.servo1_raw = st.out[0];
  m.servo2_raw = st.out[1];
  m.servo3_raw = st.out[2];
  m.servo4_raw = st.out[3];
  m.servo5_raw = st.out[4];
  m.servo6_raw = st.out[5];
  m.servo7_raw = st.out[6];
  m.servo8_raw = st.out[7];
  SEND(SERVO_OUTPUT_RAW, m, false);
}

void send_rc() {
  mav_rc_channels_t m;
  memset(&m, 0, sizeof m);
  m.time_boot_ms = now_ms - boot_ms;
  m.chancount = st.radio_ok ? radio_count : 0;
  uint16_t* ch[18] = {&m.chan1_raw, &m.chan2_raw, &m.chan3_raw, &m.chan4_raw, &m.chan5_raw, &m.chan6_raw,
                      &m.chan7_raw, &m.chan8_raw, &m.chan9_raw, &m.chan10_raw, &m.chan11_raw, &m.chan12_raw,
                      &m.chan13_raw, &m.chan14_raw, &m.chan15_raw, &m.chan16_raw, &m.chan17_raw, &m.chan18_raw};
  for (int c = 0; c < 18; c++) *ch[c] = (c < 8 && st.radio_ok && c < radio_count) ? radio_us[c] : 65535;
  m.rssi = st.radio_ok ? 254 : 0;
  SEND(RC_CHANNELS, m, false);
}

void send_nav() {
  mav_nav_controller_output_t m;
  memset(&m, 0, sizeof m);
  m.nav_bearing = (int16_t)nav_bearing;
  m.target_bearing = (int16_t)nav_bearing;
  m.wp_dist = nav_dist >= 0 ? (uint16_t)nav_dist : 0;
  m.xtrack_error = nav_xtrack;
  SEND(NAV_CONTROLLER_OUTPUT, m, false);
}

void send_home() {
  if (!home_set) return;
  mav_home_position_t m;
  memset(&m, 0, sizeof m);
  m.latitude = home_lat;
  m.longitude = home_lon;
  m.altitude = (int32_t)(home_alt * 1000.f);
  m.q[0] = 1;
  SEND(HOME_POSITION, m, true);
}

void send_power() {
  mav_power_status_t m;
  memset(&m, 0, sizeof m);
  m.Vcc = 5000;
  float v = hal_battery_v();
  m.Vservo = v > 0 ? (uint16_t)(v * 1000.f) : 0;
  SEND(POWER_STATUS, m, false);
}

void send_param(uint16_t i) {
  mav_param_value_t m;
  memset(&m, 0, sizeof m);
  memcpy(m.param_id, P[i].name, strlen(P[i].name) < 16 ? strlen(P[i].name) : 16);
  m.param_value = P[i].v;
  m.param_type = MAV_PARAM_TYPE_REAL32;
  m.param_count = NP;
  m.param_index = i;
  SEND(PARAM_VALUE, m, true);
}

// param list is sent a few per update so the link is never flooded
int32_t plist_next = -1;

// ------------------------------------------------------------------ incoming messages
void on_command(uint16_t cmd, const float p[7], int32_t x, int32_t y, bool is_int, uint8_t from_sys,
                uint8_t from_comp) {
  uint8_t r = ACCEPTED;
  switch (cmd) {
    case 400: {  // COMPONENT_ARM_DISARM
      bool force = fabsf(p[1] - 21196.f) < 0.5f;
      if (p[0] > 0.5f) r = armed ? ACCEPTED : try_arm(force);
      else do_arm(false, force ? "forced" : nullptr);
      break;
    }
    case 176:  // DO_SET_MODE: p1 base mode flags, p2 custom mode
      r = set_mode((uint8_t)p[1], nullptr);
      break;
    case 183:  // DO_SET_SERVO
      if (p[0] < 1 || p[0] > 8) r = DENIED;
      else if ((int)pv(I.sv_fn[(int)p[0] - 1]) != 0) {
        text(4, "Output %d is in use (SERVO%d_FUNCTION)", (int)p[0], (int)p[0]);
        r = DENIED;
      } else do_set_servo((int)p[0], (int)p[1]);
      break;
    case 181:  // DO_SET_RELAY
      if (p[0] < 0 || p[0] > 3) r = DENIED;
      else do_set_relay((int)p[0], p[1] > 0.5f);
      break;
    case 178:  // DO_CHANGE_SPEED: p2 m/s
      if (p[1] > 0) target_speed = p[1];
      break;
    case 410:  // GET_HOME_POSITION
      if (!home_set) r = FAILED;
      else send_home();
      break;
    case 179:  // DO_SET_HOME
      if (p[0] > 0.5f) {
        if (!gps_ok()) r = FAILED;
        else set_home_here(false);
      } else {
        int32_t la = is_int ? x : (int32_t)(p[4] * 1e7f), lo = is_int ? y : (int32_t)(p[5] * 1e7f);
        if (!la && !lo) r = DENIED;
        else {
          home_lat = la;
          home_lon = lo;
          home_set = true;
        }
      }
      break;
    case 511:  // SET_MESSAGE_INTERVAL
      if ((int)p[0] == 125) want_power = p[1] > 0;
      break;
    case 512:  // REQUEST_MESSAGE
      switch ((int)p[0]) {
        case 242: send_home(); break;
        case 33: send_position(); break;
        case 0: send_heartbeat(); break;
        case 1: send_sys_status(); break;
        case 24: send_gps_raw(); break;
        case 36: send_servo_out(); break;
        case 125: send_power(); break;
        default: r = UNSUPPORTED;
      }
      break;
    case 246:  // PREFLIGHT_REBOOT_SHUTDOWN
      if ((int)p[0] == 1) {
        if (armed) r = DENIED;
        else reboot_at = now_ms + 400;
      } else r = UNSUPPORTED;
      break;
    case 209:  // DO_MOTOR_TEST: p1 seq, p2 type (1 = PWM), p3 value, p4 timeout s
      if (armed) r = DENIED;
      else {
        motor_test_seq = (uint8_t)p[0];
        motor_test_pwm = (int)p[1] == 1;
        motor_test_val = motor_test_pwm ? clampf(p[2], 900, 2100) : clampf(p[2], -100, 100);
        motor_test_until = now_ms + (uint32_t)(clampf(p[3], 0.1f, 30) * 1000.f);
      }
      break;
    case 300:  // MISSION_START
      r = set_mode(AUTO, nullptr);
      break;
    case 20:   // NAV_RETURN_TO_LAUNCH
      r = set_mode(RTL, nullptr);
      break;
    case 192: {  // DO_REPOSITION: p5/p6 (or x/y) = point
      int32_t la = is_int ? x : (int32_t)(p[4] * 1e7f), lo = is_int ? y : (int32_t)(p[5] * 1e7f);
      if (!gps_ok()) r = FAILED;
      else if (!la && !lo) r = DENIED;
      else {
        if (mode != GUIDED) set_mode(GUIDED, nullptr);
        tgt.valid = true;
        tgt.lat = la;
        tgt.lon = lo;
        tgt.have_origin = true;
        tgt.olat = gps.lat;
        tgt.olon = gps.lon;
        tgt.radius = pv(I.wp_radius);
      }
      break;
    }
    case 520:  // REQUEST_AUTOPILOT_CAPABILITIES
    default:
      r = UNSUPPORTED;
  }
  ack(cmd, r, from_sys, from_comp);
}

void on_gps_input(const mav_gps_input_t& g) {
  const uint16_t IGN_VEL_H = 8, IGN_HACC = 64;
  gps.msg_count++;
  // The phone compass comes in the yaw field, also before the first GPS fix.
  if (g.yaw) {  // 0 = no compass; 36000 = north
    gps.yaw_ok = true;
    gps.yaw = (g.yaw % 36000) / 100.f;
    gps.yaw_t_ms = now_ms;
  }
  if (g.fix_type < 2 || (!g.lat && !g.lon)) {
    gps.fix = g.fix_type;
    return;
  }
  gps.have = true;
  gps.t_ms = now_ms;
  gps.lat = g.lat;
  gps.lon = g.lon;
  gps.alt = g.alt;
  gps.fix = g.fix_type;
  gps.sats = g.satellites_visible;
  gps.hdop = g.hdop;
  gps.hacc = (g.ignore_flags & IGN_HACC) ? g.hdop * 5.f : g.horiz_accuracy;
  gps.vel_ok = !(g.ignore_flags & IGN_VEL_H);
  if (gps.vel_ok) {
    gps.vn = g.vn;
    gps.ve = g.ve;
    gps.speed = sqrtf(g.vn * g.vn + g.ve * g.ve);
  }
  if (!home_set && gps_ok()) set_home_here(false);
}

void mission_request(uint16_t seq) {
  mav_mission_request_int_t m;
  memset(&m, 0, sizeof m);
  m.target_system = up_sys;
  m.target_component = up_comp;
  m.seq = seq;
  SEND(MISSION_REQUEST_INT, m, true);
  up_t_ms = now_ms;
}

void mission_ack(uint8_t to_sys, uint8_t to_comp, uint8_t type) {
  mav_mission_ack_t m;
  memset(&m, 0, sizeof m);
  m.target_system = to_sys;
  m.target_component = to_comp;
  m.type = type;
  SEND(MISSION_ACK, m, true);
}

void store_upload_item(uint16_t seq, uint16_t cmd, uint8_t frame, const float p[4], int32_t x, int32_t y, float z) {
  if (!up_active || seq != up_next) {
    if (up_active && seq < up_next) mission_request(up_next);  // a repeat: ask again for the one we want
    return;
  }
  Item& it = up_buf[seq];
  it.cmd = cmd;
  it.frame = frame;
  it.p1 = p[0];
  it.p2 = p[1];
  it.p3 = p[2];
  it.p4 = p[3];
  it.x = x;
  it.y = y;
  it.z = z;
  up_next++;
  up_tries = 0;
  if (up_next < up_count) {
    mission_request(up_next);
    return;
  }
  // All there: take it.
  memcpy(mission, up_buf, sizeof(Item) * up_count);
  mis_count = up_count;
  up_active = false;
  mis_start = 0;
  if (mis_cur >= mis_count) mis_cur = mis_count > 1 ? 1 : 0;
  if (mode == AUTO) {
    mis_cur = 1;
    mis_done = false;
    start_mission_item();
  }
  mission_ack(up_sys, up_comp, 0);
  text(6, "Mission: %u items", (unsigned)(mis_count - 1));
}

void send_mission_item(uint16_t seq, bool as_int, uint8_t to_sys, uint8_t to_comp) {
  Item it;
  if (seq == 0) {  // item 0 is the home slot
    memset(&it, 0, sizeof it);
    it.cmd = 16;
    it.x = home_lat;
    it.y = home_lon;
    it.z = home_alt;
  } else it = mission[seq];
  if (as_int) {
    mav_mission_item_int_t m;
    memset(&m, 0, sizeof m);
    m.target_system = to_sys;
    m.target_component = to_comp;
    m.seq = seq;
    m.frame = seq == 0 ? 0 : it.frame;
    m.command = it.cmd;
    m.current = (seq == mis_cur) ? 1 : 0;
    m.autocontinue = 1;
    m.param1 = it.p1;
    m.param2 = it.p2;
    m.param3 = it.p3;
    m.param4 = it.p4;
    m.x = it.x;
    m.y = it.y;
    m.z = it.z;
    SEND(MISSION_ITEM_INT, m, true);
  } else {
    mav_mission_item_t m;
    memset(&m, 0, sizeof m);
    m.target_system = to_sys;
    m.target_component = to_comp;
    m.seq = seq;
    m.frame = seq == 0 ? 0 : it.frame;
    m.command = it.cmd;
    m.current = (seq == mis_cur) ? 1 : 0;
    m.autocontinue = 1;
    m.param1 = it.p1;
    m.param2 = it.p2;
    m.param3 = it.p3;
    m.param4 = it.p4;
    m.x = it.x * 1e-7f;
    m.y = it.y * 1e-7f;
    m.z = it.z;
    SEND(MISSION_ITEM, m, true);
  }
}

void on_message(uint32_t id, uint8_t sys, uint8_t comp, const uint8_t* p, uint8_t len) {
  msgs_rx++;
  switch (id) {
    case MAV_ID_HEARTBEAT: {
      mav_heartbeat_t m;
      mav_unpack_heartbeat(p, len, &m);
      if (m.type == 6) {  // a ground station (the laptop's boat program, Mission Planner)
        last_gcs_hb_ms = now_ms;
        gcs_seen = true;
        gcs_sys = sys;
        gcs_comp = comp;
      }
      break;
    }
    case MAV_ID_ATTITUDE: {
      // The phone's fused compass heading + gyro yaw rate, 50 times a second
      // (VARUNA Boat Link 2.1+, its GPS component). Nobody else sends us ATTITUDE.
      if (comp != 220 && sys != 254) break;
      mav_attitude_t m;
      mav_unpack_attitude(p, len, &m);
      if (!(m.yaw == m.yaw) || !(m.yawspeed == m.yawspeed)) break;   // NaN
      att.yaw = wrap360(m.yaw / DEG);
      att.rate = clampf(m.yawspeed / DEG, -360, 360);
      att.t_ms = now_ms;
      att.n++;
      break;
    }
    case MAV_ID_GPS_INPUT: {
      mav_gps_input_t m;
      mav_unpack_gps_input(p, len, &m);
      on_gps_input(m);
      break;
    }
    case MAV_ID_COMMAND_LONG: {
      mav_command_long_t m;
      mav_unpack_command_long(p, len, &m);
      if (m.target_system && m.target_system != SYS_ID) break;
      float q[7] = {m.param1, m.param2, m.param3, m.param4, m.param5, m.param6, m.param7};
      on_command(m.command, q, 0, 0, false, sys, comp);
      break;
    }
    case MAV_ID_COMMAND_INT: {
      mav_command_int_t m;
      mav_unpack_command_int(p, len, &m);
      if (m.target_system && m.target_system != SYS_ID) break;
      float q[7] = {m.param1, m.param2, m.param3, m.param4, m.x * 1e-7f, m.y * 1e-7f, m.z};
      on_command(m.command, q, m.x, m.y, true, sys, comp);
      break;
    }
    case MAV_ID_SET_MODE: {
      mav_set_mode_t m;
      mav_unpack_set_mode(p, len, &m);
      if (m.target_system && m.target_system != SYS_ID) break;
      set_mode((uint8_t)m.custom_mode, nullptr);
      break;
    }
    case MAV_ID_RC_CHANNELS_OVERRIDE: {
      mav_rc_channels_override_t m;
      mav_unpack_rc_channels_override(p, len, &m);
      if (m.target_system && m.target_system != SYS_ID) break;
      uint16_t v[8] = {m.chan1_raw, m.chan2_raw, m.chan3_raw, m.chan4_raw,
                       m.chan5_raw, m.chan6_raw, m.chan7_raw, m.chan8_raw};
      if (v[2] != 65535 && v[2] != 0) gamepad_thr = v[0] != 65535 && v[0] != 0;
      for (int c = 0; c < 8; c++) {
        if (v[c] == 65535) continue;           // "ignore": leave as it is
        if (v[c] == 0) {                        // back to the receiver
          ovr_us[c] = 0;
          continue;
        }
        ovr_us[c] = v[c];
        ovr_t_ms[c] = now_ms;
      }
      break;
    }
    case MAV_ID_PARAM_REQUEST_READ: {
      mav_param_request_read_t m;
      mav_unpack_param_request_read(p, len, &m);
      int i = -1;
      if (m.param_index >= 0 && m.param_index < NP) i = m.param_index;
      else {
        char n[17];
        memcpy(n, m.param_id, 16);
        n[16] = 0;
        i = findp(n);
      }
      if (i >= 0) send_param((uint16_t)i);
      break;
    }
    case MAV_ID_PARAM_REQUEST_LIST:
      plist_next = 0;
      break;
    case MAV_ID_PARAM_SET: {
      mav_param_set_t m;
      mav_unpack_param_set(p, len, &m);
      char n[17];
      memcpy(n, m.param_id, 16);
      n[16] = 0;
      int i = findp(n);
      if (i < 0) {
        text(4, "Unknown parameter %s", n);
        break;
      }
      float v = m.param_value;
      if (v == v) {
        P[i].v = v;
        save_mask[i] = true;
        save_due_ms = now_ms + 300;
      }
      send_param((uint16_t)i);
      break;
    }
    case MAV_ID_MISSION_COUNT: {
      mav_mission_count_t m;
      mav_unpack_mission_count(p, len, &m);
      if (m.mission_type != 0) {
        mission_ack(sys, comp, 1);              // only the main mission
        break;
      }
      if (m.count > MAX_ITEMS) {
        mission_ack(sys, comp, 4);              // NO_SPACE
        text(4, "Mission too long (max %u)", MAX_ITEMS - 1);
        break;
      }
      if (m.count == 0) {
        mis_count = 0;
        mission_ack(sys, comp, 0);
        break;
      }
      up_active = true;
      up_count = m.count;
      up_next = 0;
      up_tries = 0;
      up_sys = sys;
      up_comp = comp;
      mission_request(0);
      break;
    }
    case MAV_ID_MISSION_ITEM_INT: {
      mav_mission_item_int_t m;
      mav_unpack_mission_item_int(p, len, &m);
      if (m.mission_type != 0) break;
      if (m.current == 2) {                     // guided "fly to here" (Mission Planner)
        uint8_t ok = gps_ok() ? ACCEPTED : FAILED;
        if (ok == ACCEPTED) {
          if (mode != GUIDED) set_mode(GUIDED, nullptr);
          tgt.valid = true;
          tgt.lat = m.x;
          tgt.lon = m.y;
          tgt.have_origin = true;
          tgt.olat = gps.lat;
          tgt.olon = gps.lon;
          tgt.radius = pv(I.wp_radius);
        }
        mission_ack(sys, comp, ok == ACCEPTED ? 0 : 1);
        break;
      }
      float q[4] = {m.param1, m.param2, m.param3, m.param4};
      store_upload_item(m.seq, m.command, m.frame, q, m.x, m.y, m.z);
      break;
    }
    case MAV_ID_MISSION_ITEM: {
      mav_mission_item_t m;
      mav_unpack_mission_item(p, len, &m);
      if (m.mission_type != 0) break;
      float q[4] = {m.param1, m.param2, m.param3, m.param4};
      store_upload_item(m.seq, m.command, m.frame, q, (int32_t)lround(m.x * 1e7), (int32_t)lround(m.y * 1e7), m.z);
      break;
    }
    case MAV_ID_MISSION_REQUEST_LIST: {
      mav_mission_request_list_t m;
      mav_unpack_mission_request_list(p, len, &m);
      if (m.mission_type != 0) {
        mav_mission_count_t c;
        memset(&c, 0, sizeof c);
        c.target_system = sys;
        c.target_component = comp;
        c.mission_type = m.mission_type;
        SEND(MISSION_COUNT, c, true);
        break;
      }
      dl_sys = sys;
      dl_comp = comp;
      mav_mission_count_t c;
      memset(&c, 0, sizeof c);
      c.target_system = sys;
      c.target_component = comp;
      c.count = mis_count;
      SEND(MISSION_COUNT, c, true);
      break;
    }
    case MAV_ID_MISSION_REQUEST_INT:
    case MAV_ID_MISSION_REQUEST: {
      uint16_t seq;
      uint8_t mt;
      if (id == MAV_ID_MISSION_REQUEST_INT) {
        mav_mission_request_int_t m;
        mav_unpack_mission_request_int(p, len, &m);
        seq = m.seq;
        mt = m.mission_type;
      } else {
        mav_mission_request_t m;
        mav_unpack_mission_request(p, len, &m);
        seq = m.seq;
        mt = m.mission_type;
      }
      if (mt != 0) break;
      if (seq >= mis_count) {
        mission_ack(sys, comp, 13);             // INVALID_SEQUENCE
        break;
      }
      send_mission_item(seq, id == MAV_ID_MISSION_REQUEST_INT, sys, comp);
      break;
    }
    case MAV_ID_MISSION_ACK:
      break;                                    // end of a download: nothing to do
    case MAV_ID_MISSION_SET_CURRENT: {
      mav_mission_set_current_t m;
      mav_unpack_mission_set_current(p, len, &m);
      if (m.seq < mis_count) {
        mis_cur = m.seq ? m.seq : 1;
        mis_done = false;
        mis_delay_until = 0;
        if (mode == AUTO) start_mission_item();
        else {
          // Report the first NAV item from here, as ArduPilot does, but run the
          // DO items before it (a speed change) when AUTO starts.
          mis_start = mis_cur;
          uint16_t s = mis_cur;
          while (s < mis_count && !is_nav(mission[s].cmd)) s++;
          if (s < mis_count) mis_cur = s;
        }
        send_mission_current();
      }
      break;
    }
    case MAV_ID_MISSION_CLEAR_ALL: {
      mav_mission_clear_all_t m;
      mav_unpack_mission_clear_all(p, len, &m);
      if (m.mission_type == 0) {
        mis_count = 0;
        mis_cur = 0;
        mis_start = 0;
        if (mode == AUTO) set_mode(HOLD, "mission cleared");
      }
      mission_ack(sys, comp, 0);
      break;
    }
    case MAV_ID_SET_POSITION_TARGET_GLOBAL_INT: {
      mav_set_position_target_global_int_t m;
      mav_unpack_set_position_target_global_int(p, len, &m);
      if (m.target_system && m.target_system != SYS_ID) break;
      if (mode != GUIDED || (m.type_mask & 0x7) == 0x7) break;  // position ignored
      if (!m.lat_int && !m.lon_int) break;
      bool same = tgt.valid && tgt.lat == m.lat_int && tgt.lon == m.lon_int;
      if (same && !tgt.have_origin) break;      // already there and holding it
      // The camera refines the plastic's position a few times a second while the
      // boat homes in: a nudge of the same target (< 5 m) keeps the controllers and
      // the line it is on, so the approach stays smooth.
      bool nudge = tgt.valid && tgt.have_origin && dist_m(tgt.lat, tgt.lon, m.lat_int, m.lon_int) < 5.f;
      if (!same && !nudge) {
        tgt.olat = gps.lat;
        tgt.olon = gps.lon;
        reset_control();
      }
      tgt.valid = true;
      tgt.lat = m.lat_int;
      tgt.lon = m.lon_int;
      tgt.have_origin = true;
      tgt.radius = fmaxf(0.3f, pv(I.guided_rad));
      break;
    }
    case MAV_ID_REQUEST_DATA_STREAM:
      break;                                    // fixed rates (see update())
    default:
      break;
  }
}

// ------------------------------------------------------------------ MAVLink parser
struct {
  uint8_t buf[12 + 255 + 13];
  uint16_t n = 0, need = 0;
} rx;

bool rx_rescanning = false;

void parse_byte(uint8_t b) {
  if (rx.n == 0) {
    if (b != 0xFD && b != 0xFE) return;
    rx.buf[rx.n++] = b;
    rx.need = 0;
    return;
  }
  rx.buf[rx.n++] = b;
  bool v2 = rx.buf[0] == 0xFD;
  if (rx.n == 3 && v2) {
    rx.need = 12 + rx.buf[1] + ((rx.buf[2] & 1) ? 13 : 0);
  } else if (rx.n == 2 && !v2) {
    rx.need = 8 + rx.buf[1];
  }
  if (!rx.need || rx.n < rx.need) {
    if (rx.n >= sizeof rx.buf) rx.n = 0;
    return;
  }
  // a whole frame
  uint8_t len = rx.buf[1];
  uint32_t id;
  uint8_t sys, comp;
  const uint8_t* payload;
  uint16_t crc_pos;
  if (v2) {
    sys = rx.buf[5];
    comp = rx.buf[6];
    id = rx.buf[7] | ((uint32_t)rx.buf[8] << 8) | ((uint32_t)rx.buf[9] << 16);
    payload = rx.buf + 10;
    crc_pos = 10 + len;
  } else {
    sys = rx.buf[3];
    comp = rx.buf[4];
    id = rx.buf[5];
    payload = rx.buf + 6;
    crc_pos = 6 + len;
  }
  int extra = mav_crc_extra(id);
  bool ok = false;
  if (extra >= 0) {
    uint16_t crc = 0xffff;
    for (uint16_t i = 1; i < crc_pos; i++) crc = crc_acc(rx.buf[i], crc);
    crc = crc_acc((uint8_t)extra, crc);
    ok = (rx.buf[crc_pos] == (crc & 0xff)) && (rx.buf[crc_pos + 1] == (crc >> 8));
  }
  uint16_t total = rx.n;
  rx.n = 0;
  if (ok && !(sys == SYS_ID && comp == COMP_ID)) {
    on_message(id, sys, comp, payload, len);
  } else if (!ok && extra >= 0 && !rx_rescanning) {
    // Bad CRC: maybe it locked onto a stray magic byte - look for a frame in the rest.
    static uint8_t tmp[sizeof rx.buf];
    memcpy(tmp, rx.buf, total);
    rx_rescanning = true;
    for (uint16_t i = 1; i < total; i++) parse_byte(tmp[i]);
    rx_rescanning = false;
  }
}

}  // namespace

// ------------------------------------------------------------------ public
const char* mode_name(uint8_t m) {
  switch (m) {
    case MANUAL: return "MANUAL";
    case ACRO: return "ACRO";
    case STEERING: return "STEERING";
    case HOLD: return "HOLD";
    case LOITER: return "LOITER";
    case AUTO: return "AUTO";
    case RTL: return "RTL";
    case SMART_RTL: return "SMART_RTL";
    case GUIDED: return "GUIDED";
    default: return "?";
  }
}

void begin(uint32_t t) {
  now_ms = boot_ms = t;
  define_params();
  load_params();
  memset(&st, 0, sizeof st);
  st.heading_deg = -1;
  st.target_dist_m = -1;
  mode = MANUAL;
  armed = false;
  for (int s = 0; s < 8; s++) servo_set[s] = 0;
  int g = gate_index();
  if (g >= 0) {                                               // gate closed (no glide at power-up)
    gate_pos = gate_goal = pv(pv(I.sv_rev[g]) > 0.5f ? I.sv_max[g] : I.sv_min[g]);
    gate_us = (uint16_t)gate_pos;
  }
  for (int k = 0; k < 4; k++) {
    relay_cmd[k] = false;
    set_relay_pin(k, false);                                  // relays off (AB_RELAY_LOW sets the level)
  }
  mix_and_output();
  text(6, "VARUNA air-boat brain ready");
}

void feed(const uint8_t* data, uint16_t n, uint32_t t) {
  now_ms = t;
  if (n) last_rx_ms = t;
  for (uint16_t i = 0; i < n; i++) {
    if (rx.n == 0 && data[i] != 0xFD && data[i] != 0xFE) continue;
    // parse_byte may rescan from rx.buf; copy-safe because it only reads rx.buf before resetting.
    parse_byte(data[i]);
  }
}

void rc_input(const uint16_t* us, uint8_t count, uint32_t t) {
  now_ms = t;
  if (!count) return;
  radio_count = count > 8 ? 8 : count;
  for (uint8_t c = 0; c < radio_count; c++) radio_us[c] = us[c];
  radio_t_ms = t;
  rc_fresh = true;
  if (!radio_seen) {
    radio_seen = true;
    text(6, "Receiver found (%u channels)", radio_count);
  }
}

static uint32_t t_ctrl = 0;

void update(uint32_t t) {
  now_ms = t;
  // Control runs the moment a receiver frame arrives (no waiting for the next 50 Hz
  // tick: stick -> servo / ESC as fast as the receiver itself), else every 20 ms.
  uint32_t el = t - t_ctrl;
  if (el >= 20 || (rc_fresh && el >= 4)) {
    rc_fresh = false;
    DT = clampf(el / 1000.f, 0.004f, 0.05f);
    t_ctrl = t;
    if (st.radio_ok) radio_logic();
    control();
    st.mode = mode;
    st.armed = armed;
    st.heading_deg = heading_ok() ? heading : -1;
    for (int k = 0; k < 4; k++) st.relay[k] = relay_on[k];
  }
  // Telemetry: what ArduRover sends at the laptop's requested rates.
  if (t - t_hb >= 1000) {
    t_hb = t;
    send_heartbeat();
    send_sys_status();
    send_gps_raw();
    send_mission_current();
  }
  if (t - t_pos >= 200) {
    t_pos = t;
    send_position();
  }
  if (t - t_att >= 250) {
    t_att = t;
    send_attitude();
    send_vfr();
  }
  // The outputs and the sticks fast (AB_LOG_HZ): the phone logs them with its own
  // compass, gyro and GPS - what the boat did for each command (its model).
  float lhz = clampf(pv(I.log_hz), 0, 50);
  uint32_t log_ms = lhz >= 1.f ? (uint32_t)(1000.f / lhz) : 0;
  if (t - t_servo >= (log_ms ? log_ms : 250)) {
    t_servo = t;
    send_servo_out();
    if (log_ms && radio_seen) send_rc();
  }
  if (t - t_rc >= 500) {
    t_rc = t;
    if (radio_seen && !log_ms) send_rc();
    send_nav();
  }
  if (want_power && t - t_power >= 200) {
    t_power = t;
    send_power();
  }
  // Parameter list: a few each pass.
  for (int k = 0; k < 3 && plist_next >= 0; k++) {
    if (hal_write_room() < 40) break;
    send_param((uint16_t)plist_next);
    if (++plist_next >= NP) plist_next = -1;
  }
  // Mission upload: ask again if an item does not come.
  if (up_active && t - up_t_ms > 1500) {
    if (++up_tries > 6) {
      up_active = false;
      mission_ack(up_sys, up_comp, 1);
      text(4, "Mission upload timed out");
    } else mission_request(up_next);
  }
  // Save changed parameters (batched).
  if (save_due_ms && (int32_t)(t - save_due_ms) >= 0) {
    save_due_ms = 0;
    for (uint16_t i = 0; i < NP; i++)
      if (save_mask[i]) {
        save_mask[i] = false;
        hal_store_write(STORE_HDR + 4 * i, (const uint8_t*)&P[i].v, 4);
      }
  }
  if (reboot_at && (int32_t)(t - reboot_at) >= 0) hal_reboot();
}

const Status& status() { return st; }

}  // namespace brain
