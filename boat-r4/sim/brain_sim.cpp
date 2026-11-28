// PC / emulator test harness for the UNO R4 boat brain.
//
// Runs the SAME brain.cpp as the board, with:
//   * a simulated air boat: two air motors on BIDIRECTIONAL ESCs (1500 us
//     stopped, reverse thrust 60 % of forward) blowing over one fin linkage,
//     drag, yaw damping, a side current - driven by the brain's output pulses;
//   * a simulated phone (VARUNA Boat Link 2.1): GPS_INPUT at 5 Hz, and the fused
//     compass + gyro as ATTITUDE at 50 Hz (30 ms old, with noise, a gyro bias and
//     a compass mounting error the brain must learn);
//   * a TCP server (default port 5760) that stands in for the phone's link:
//     the laptop's boat program connects to it exactly as to the real phone.
//
//   brain_sim [port] [--bias DEG] [--current MPS] [--no-compass] [--no-att] [--bidir] [--state FILE]
//   (--no-att: an older phone app - heading only in GPS_INPUT's yaw field)
//
// Built with the Android NDK (no PC compiler needed) and run in the emulator:
//   boat-r4/sim/run_sim.ps1
#include <arpa/inet.h>
#include <fcntl.h>
#include <math.h>
#include <netinet/in.h>
#include <netinet/tcp.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/select.h>
#include <sys/socket.h>
#include <time.h>
#include <unistd.h>

#include <string>
#include <vector>

#include "../varuna_boat_brain/brain.h"
#include "../varuna_boat_brain/mav_msgs.h"

static uint32_t ms_now() {
  timespec ts;
  clock_gettime(CLOCK_MONOTONIC, &ts);
  return (uint32_t)(ts.tv_sec * 1000ull + ts.tv_nsec / 1000000ull);
}

// ------------------------------------------------------------------ HAL
static std::vector<int> clients;
static uint16_t outputs[8];
static bool relays[4];
static uint8_t store[4096];
static const char* state_file = "/data/local/tmp/brain_eeprom.bin";
static bool reboot_now = false;

void hal_write(const uint8_t* d, uint16_t n) {
  for (size_t i = 0; i < clients.size(); i++) {
    if (clients[i] < 0) continue;
    ssize_t off = 0;
    while (off < n) {
      ssize_t w = send(clients[i], d + off, n - off, MSG_NOSIGNAL);
      if (w <= 0) {
        close(clients[i]);
        clients[i] = -1;
        break;
      }
      off += w;
    }
  }
}
uint16_t hal_write_room() { return 4096; }
void hal_outputs(const uint16_t us[8]) { memcpy(outputs, us, sizeof outputs); }
void hal_relay(uint8_t i, bool on) {
  if (i < 4) {
    if (relays[i] != on) printf("RELAY%d %s\n", i + 1, on ? "ON" : "off");
    relays[i] = on;
  }
}
static void save_store() {
  FILE* f = fopen(state_file, "wb");
  if (f) {
    fwrite(store, 1, sizeof store, f);
    fclose(f);
  }
}
void hal_store_read(uint16_t a, uint8_t* d, uint16_t n) {
  for (uint16_t i = 0; i < n; i++) d[i] = (a + i < sizeof store) ? store[a + i] : 0xFF;
}
void hal_store_write(uint16_t a, const uint8_t* d, uint16_t n) {
  for (uint16_t i = 0; i < n; i++)
    if (a + i < sizeof store) store[a + i] = d[i];
  save_store();
}
void hal_reboot() { reboot_now = true; }
float hal_battery_v() { return 11.8f; }

// ------------------------------------------------------------------ the air boat
struct Boat {
  double n = 0, e = 0;      // m from the origin
  double psi = 30;          // heading, deg clockwise from north
  double u = 0, v = 0, r = 0;  // forward / side m/s, yaw rate deg/s
} boat;
static const double LAT0 = 28.5618900, LON0 = 77.1580100;
static double current_n = 0.0, current_e = 0.12;  // a slow side current (m/s)
static double compass_bias = 8.0;                 // how wrong the phone compass is (deg)
static bool compass_on = true;
static bool att_on = true;                        // phone sends ATTITUDE (compass + gyro) at 50 Hz
static bool rc_on = false;                        // a FlySky receiver on PPM (ctl "rc ...")
static uint16_t rc_ch[8];
static double psi_hist[8];                        // heading history at 100 Hz (sensor delay)
static int psi_i = 0;

static double frand() { return (double)rand() / RAND_MAX * 2 - 1; }
static double gauss() {
  double s = 0;
  for (int i = 0; i < 6; i++) s += frand();
  return s / 2.45;
}

// thrust (N) of one air motor for an ESC pulse. A normal forward-only ESC (the
// default): stopped up to 1060 us, full at 2000. --bidir: a bidirectional ESC,
// stopped at 1500 +-20 us; its propeller pushes ~60 % backwards.
static bool esc_bidir = false;
static double thrust(uint16_t us) {
  if (!esc_bidir) return us <= 1060 ? 0 : 6.0 * fmin(1.0, (us - 1060) / 940.0);
  if (us == 0 || (us > 1480 && us < 1520)) return 0;
  if (us >= 1520) return 6.0 * fmin(1.0, (us - 1520) / 480.0);
  return -3.6 * fmin(1.0, (1480 - us) / 480.0);
}

static void physics(double dt) {
  const double M = 2.2, IZ = 0.09, ARM_FIN = 0.30, HALF_W = 0.13;
  // fins: SERVO1 (and SERVO5): 1100..1900 = -30..+30 deg
  double fin = 0;
  if (outputs[0]) fin = (outputs[0] - 1500) / 400.0 * 30.0;
  double fr = fin * M_PI / 180;
  double tl = thrust(outputs[2]), tr = thrust(outputs[3]);
  double T = tl + tr;
  // Air over the fin: a motor pushing forward blows it backwards over the fin
  // (full effect); one pushing backwards sucks it the other way (weak, opposite).
  double flow = (tl > 0 ? tl : 0.3 * tl) + (tr > 0 ? tr : 0.3 * tr);
  double fx = T - fabs(flow) * (1 - cos(fr)) - 0.9 * boat.u * fabs(boat.u) - 0.6 * boat.u;
  double side = -flow * sin(fr) * 0.3;
  double mz = flow * sin(fr) * ARM_FIN + (tl - tr) * HALF_W;       // + = turn right
  double rr = boat.r * M_PI / 180;
  mz -= 0.25 * rr + 0.15 * rr * fabs(rr);
  boat.u += fx / M * dt;
  boat.v += (side / M - 1.2 * boat.v) * dt;
  rr += mz / IZ * dt;
  boat.r = rr * 180 / M_PI;
  boat.psi = fmod(boat.psi + boat.r * dt + 360, 360);
  psi_hist[psi_i++ % 8] = boat.psi;
  double p = boat.psi * M_PI / 180;
  boat.n += (boat.u * cos(p) - boat.v * sin(p) + current_n) * dt;
  boat.e += (boat.u * sin(p) + boat.v * cos(p) + current_e) * dt;
}

// ------------------------------------------------------------------ the phone: GPS_INPUT
static uint8_t gps_seq = 0;
static uint16_t crc_acc(uint8_t b, uint16_t crc) {
  uint8_t t = b ^ (uint8_t)(crc & 0xff);
  t ^= (uint8_t)(t << 4);
  return (crc >> 8) ^ ((uint16_t)t << 8) ^ ((uint16_t)t << 3) ^ (t >> 4);
}
static void phone_gps(uint32_t now) {
  static double nn = 0, ne = 0;  // slowly wandering GPS error
  nn = nn * 0.95 + gauss() * 0.08;
  ne = ne * 0.95 + gauss() * 0.08;
  double lat = LAT0 + (boat.n + nn) / 6378137.0 * 180 / M_PI;
  double lon = LON0 + (boat.e + ne) / (6378137.0 * cos(LAT0 * M_PI / 180)) * 180 / M_PI;
  double p = boat.psi * M_PI / 180;
  double vn = boat.u * cos(p) - boat.v * sin(p) + current_n, ve = boat.u * sin(p) + boat.v * cos(p) + current_e;
  mav_gps_input_t g;
  memset(&g, 0, sizeof g);
  g.time_usec = (uint64_t)now * 1000;
  g.ignore_flags = 16 | 128;  // no vertical speed / accuracy
  g.fix_type = 3;
  g.lat = (int32_t)llround(lat * 1e7);
  g.lon = (int32_t)llround(lon * 1e7);
  g.alt = 210;
  g.hdop = 0.8f;
  g.vdop = 1.2f;
  g.vn = (float)(vn + gauss() * 0.05);
  g.ve = (float)(ve + gauss() * 0.05);
  g.speed_accuracy = 0.2f;
  g.horiz_accuracy = 2.0f;
  g.satellites_visible = 14;
  if (compass_on) {
    double y = fmod(boat.psi + compass_bias + gauss() * 2.0 + 720, 360);
    uint16_t cd = (uint16_t)llround(y * 100);
    g.yaw = cd == 0 ? 36000 : cd;
  }
  uint8_t pl[MAV_LEN_GPS_INPUT];
  uint8_t len = mav_pack_gps_input(pl, &g);
  while (len > 1 && pl[len - 1] == 0) len--;
  uint8_t f[12 + 80];
  f[0] = 0xFD; f[1] = len; f[2] = 0; f[3] = 0; f[4] = gps_seq++; f[5] = 254; f[6] = 220;
  f[7] = MAV_ID_GPS_INPUT; f[8] = 0; f[9] = 0;
  memcpy(f + 10, pl, len);
  uint16_t crc = 0xffff;
  for (int i = 1; i < 10 + len; i++) crc = crc_acc(f[i], crc);
  crc = crc_acc(MAV_CRC_GPS_INPUT, crc);
  f[10 + len] = crc & 0xff;
  f[11 + len] = crc >> 8;
  brain::feed(f, 12 + len, now);
}

// ------------------------------------------------------------------ the phone: ATTITUDE (compass + gyro)
static void phone_frame(uint32_t id, uint8_t crc_extra, const uint8_t* pl, uint8_t len, uint32_t now) {
  while (len > 1 && pl[len - 1] == 0) len--;
  uint8_t f[12 + 80];
  f[0] = 0xFD; f[1] = len; f[2] = 0; f[3] = 0; f[4] = gps_seq++; f[5] = 254; f[6] = 220;
  f[7] = id & 0xff; f[8] = 0; f[9] = 0;
  memcpy(f + 10, pl, len);
  uint16_t crc = 0xffff;
  for (int i = 1; i < 10 + len; i++) crc = crc_acc(f[i], crc);
  crc = crc_acc(crc_extra, crc);
  f[10 + len] = crc & 0xff;
  f[11 + len] = crc >> 8;
  brain::feed(f, 12 + len, now);
}
static void phone_att(uint32_t now) {
  // What the phone measured 30 ms ago (sensor fusion + USB), with noise.
  double psi = psi_hist[(psi_i + 8 - 3) % 8];
  double y = fmod(psi + compass_bias + gauss() * 0.4 + 720, 360);
  if (y > 180) y -= 360;
  mav_attitude_t a;
  memset(&a, 0, sizeof a);
  a.time_boot_ms = now;
  a.yaw = (float)(y * M_PI / 180);
  a.yawspeed = (float)((boat.r + 0.3 + gauss() * 0.6) * M_PI / 180);   // gyro: bias + noise
  uint8_t pl[MAV_LEN_ATTITUDE];
  uint8_t len = mav_pack_attitude(pl, &a);
  phone_frame(MAV_ID_ATTITUDE, MAV_CRC_ATTITUDE, pl, len, now);
}

// ------------------------------------------------------------------ main
// A reboot command restarts the whole process (all of the brain's memory is
// fresh, as after a real reset); the sockets and the boat's state carry over.
static std::vector<std::string> base_args;
static void restart(int srv, const char* self) {
  std::vector<std::string> a = base_args;
  char buf[160];
  snprintf(buf, sizeof buf, "%d", srv);
  a.push_back("--fd-srv");
  a.push_back(buf);
  std::string cl;
  for (int c : clients)
    if (c >= 0) cl += (cl.empty() ? "" : ",") + std::to_string(c);
  if (!cl.empty()) {
    a.push_back("--fd-cli");
    a.push_back(cl);
  }
  snprintf(buf, sizeof buf, "%.4f,%.4f,%.3f,%.4f,%.4f,%.4f", boat.n, boat.e, boat.psi, boat.u, boat.v, boat.r);
  a.push_back("--boat");
  a.push_back(buf);
  std::vector<char*> av;
  for (auto& x : a) av.push_back((char*)x.c_str());
  av.push_back(nullptr);
  fflush(stdout);
  execv(self, av.data());
  perror("execv");
  exit(1);
}

int main(int argc, char** argv) {
  int port = 5760;
  bool gps_on = true;
  int inherit_srv = -1;
  base_args.push_back(argv[0]);
  for (int i = 1; i < argc; i++) {
    std::string a = argv[i];
    if (a == "--fd-srv" && i + 1 < argc) {
      inherit_srv = atoi(argv[++i]);
      continue;
    }
    if (a == "--fd-cli" && i + 1 < argc) {
      for (char* t = strtok(argv[++i], ","); t; t = strtok(nullptr, ",")) clients.push_back(atoi(t));
      continue;
    }
    if (a == "--boat" && i + 1 < argc) {
      sscanf(argv[++i], "%lf,%lf,%lf,%lf,%lf,%lf", &boat.n, &boat.e, &boat.psi, &boat.u, &boat.v, &boat.r);
      continue;
    }
    base_args.push_back(a);
    if ((a == "--bias" || a == "--current" || a == "--state") && i + 1 < argc) base_args.push_back(argv[i + 1]);
    if (a == "--bias" && i + 1 < argc) compass_bias = atof(argv[++i]);
    else if (a == "--current" && i + 1 < argc) current_e = atof(argv[++i]);
    else if (a == "--no-compass") compass_on = false;
    else if (a == "--no-att") att_on = false;
    else if (a == "--bidir") esc_bidir = true;
    else if (a == "--state" && i + 1 < argc) state_file = argv[++i];
    else port = atoi(a.c_str());
  }
  signal(SIGPIPE, SIG_IGN);
  srand(7);
  memset(store, 0xFF, sizeof store);
  FILE* f = fopen(state_file, "rb");
  if (f) {
    fread(store, 1, sizeof store, f);
    fclose(f);
  }
  int one = 1;
  int srv = inherit_srv;
  if (srv < 0) {
    srv = socket(AF_INET, SOCK_STREAM, 0);
    setsockopt(srv, SOL_SOCKET, SO_REUSEADDR, &one, sizeof one);
    sockaddr_in a;
    memset(&a, 0, sizeof a);
    a.sin_family = AF_INET;
    a.sin_port = htons(port);
    a.sin_addr.s_addr = INADDR_ANY;
    if (bind(srv, (sockaddr*)&a, sizeof a) < 0 || listen(srv, 4) < 0) {
      perror("bind");
      return 1;
    }
  }
  printf("brain_sim: listening on %d (compass bias %.1f deg, current %.2f m/s)\n", port, compass_bias, current_e);
  fflush(stdout);
  brain::begin(ms_now());
  uint32_t t_phys = ms_now(), t_gps = 0, t_log = 0, t_att = 0, t_rc = 0;
  for (double& h : psi_hist) h = boat.psi;
  // Control commands on stdin-less runs come from a side channel: a file the test writes.
  const char* ctl = "/data/local/tmp/brain_sim.ctl";
  uint32_t t_ctl = 0;
  for (;;) {
    fd_set rd;
    FD_ZERO(&rd);
    FD_SET(srv, &rd);
    int mx = srv;
    for (int c : clients)
      if (c >= 0) {
        FD_SET(c, &rd);
        if (c > mx) mx = c;
      }
    timeval tv = {0, 2000};
    select(mx + 1, &rd, nullptr, nullptr, &tv);
    uint32_t now = ms_now();
    if (FD_ISSET(srv, &rd)) {
      int c = accept(srv, nullptr, nullptr);
      if (c >= 0) {
        setsockopt(c, IPPROTO_TCP, TCP_NODELAY, &one, sizeof one);
        clients.push_back(c);
        printf("laptop connected (%zu)\n", clients.size());
        fflush(stdout);
      }
    }
    for (int& c : clients) {
      if (c >= 0 && FD_ISSET(c, &rd)) {
        uint8_t buf[2048];
        ssize_t n = recv(c, buf, sizeof buf, 0);
        if (n <= 0) {
          close(c);
          c = -1;
        } else {
          brain::feed(buf, (uint16_t)n, now);
        }
      }
    }
    // physics at 100 Hz
    while ((int32_t)(now - t_phys) >= 10) {
      physics(0.01);
      t_phys += 10;
    }
    if (gps_on && now - t_gps >= 200) {
      t_gps = now;
      phone_gps(now);
    }
    if (att_on && compass_on && now - t_att >= 20) {
      t_att = now;
      phone_att(now);
    }
    if (rc_on && now - t_rc >= 20) {              // PPM frames, ~50 per second
      t_rc = now;
      brain::rc_input(rc_ch, 8, now);
    }
    // side channel: "gps off", "gps on", "teleport N E", "heading DEG", "kick DEG_S" (a gust
    // spins the boat), "att off" / "att on" (the phone's 50 Hz compass + gyro),
    // "rc C1 .. C8" (an FS-i6 on PPM sends these us from now on), "rc off" (transmitter gone)
    if (now - t_ctl >= 100) {
      t_ctl = now;
      FILE* cf = fopen(ctl, "r");
      if (cf) {
        char line[128];
        while (fgets(line, sizeof line, cf)) {
          double x, y;
          if (!strncmp(line, "gps off", 7)) gps_on = false;
          else if (!strncmp(line, "gps on", 6)) gps_on = true;
          else if (sscanf(line, "teleport %lf %lf", &x, &y) == 2) {
            boat.n = x;
            boat.e = y;
            boat.u = boat.v = boat.r = 0;
          } else if (sscanf(line, "heading %lf", &x) == 1) boat.psi = x;
          else if (sscanf(line, "kick %lf", &x) == 1) boat.r += x;
          else if (!strncmp(line, "att off", 7)) att_on = false;
          else if (!strncmp(line, "att on", 6)) att_on = true;
          else if (!strncmp(line, "rc off", 6)) rc_on = false;
          else {
            unsigned v[8];
            if (sscanf(line, "rc %u %u %u %u %u %u %u %u", &v[0], &v[1], &v[2], &v[3], &v[4], &v[5], &v[6], &v[7]) == 8) {
              for (int k = 0; k < 8; k++) rc_ch[k] = (uint16_t)v[k];
              rc_on = true;
            }
          }
          printf("ctl: %s", line);
        }
        fclose(cf);
        remove(ctl);
        fflush(stdout);
      }
    }
    brain::update(now);
    if (reboot_now) {
      printf("REBOOT (process restarts)\n");
      restart(srv, "/proc/self/exe");
    }
    if (now - t_log >= 2000) {
      t_log = now;
      const brain::Status& s = brain::status();
      printf("t=%6.1f %-7s %s pos N%6.1f E%6.1f hdg %5.1f (brain %5.1f) u %+.2f r %+5.1f  out L%u R%u fin%u scoop%u  dist %.1f%s\n",
             now / 1000.0, brain::mode_name(s.mode), s.armed ? "ARMED" : "disarm", boat.n, boat.e, boat.psi,
             s.heading_deg, boat.u, boat.r, outputs[2], outputs[3], outputs[0], outputs[1], s.target_dist_m,
             s.failsafe ? " FAILSAFE" : "");
      fflush(stdout);
    }
    // forget closed sockets
    for (size_t i = 0; i < clients.size();)
      if (clients[i] < 0) clients.erase(clients.begin() + i);
      else i++;
  }
}
