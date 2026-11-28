// VARUNA boat link: Pixhawk TELEM2 <-> ESP32 (D19 / D21) <-> Wi-Fi (TCP port 5760) <-> laptop
// Board: "ESP32 Dev Module". Serial Monitor: 115200 (status line every 5 s).
//
// Wiring (telemetry cable, pin 1 = red wire):
//   Pixhawk pin 2 (TX)  -> ESP32 D19   (ESP32 receives here)
//   Pixhawk pin 3 (RX)  -> ESP32 D21   (ESP32 sends here)
//   Pixhawk pin 6 (GND) -> ESP32 GND
//   Pixhawk pin 1 (red, 5 V) -> never to D19 / D21
//
// Built not to get stuck:
//   * watchdog: if the program ever hangs for 8 s the ESP32 restarts by itself
//   * never waits on a slow or dead laptop connection (data is dropped, not queued)
//   * dead laptop connections are detected (TCP keep-alive) and freed
//   * Pixhawk data goes out in batches (~60 Wi-Fi packets a second, not ~1000
//     tiny ones that overflow the Wi-Fi queue), at most 15 ms later
//   * no Wi-Fi for 60 s -> the ESP32 restarts and joins again
//
// LED: slow blink = joining Wi-Fi | on = Wi-Fi OK, no Pixhawk data |
//      on with a short blink every second = Pixhawk data flowing (all good)

#include <WiFi.h>
#include <WebServer.h>
#include <ESPmDNS.h>
#include <lwip/sockets.h>
#include <esp_task_wdt.h>
#include "driver/gpio.h"

// ======== EDIT THESE TWO LINES ========
const char *WIFI_SSID = "1234";
const char *WIFI_PASS = "YOUR_WIFI_PASSWORD";
// ======================================

const int PIX_RX = 19;            // D19: ESP32 receives here (Pixhawk TX, pin 2)
const int PIX_TX = 21;            // D21: ESP32 sends here (Pixhawk RX, pin 3)
const long PIX_BAUD = 57600;      // must match SERIAL2_BAUD 57 on the Pixhawk
const int LED = 2;
const int RELAY_PIN = 23;         // D23: 5V Relay Signal (IN)
const bool RELAY_ACTIVE_LOW = true;
const uint16_t TCP_PORT = 5760;   // the laptop launcher looks for this port
const int MAX_CLIENTS = 3;
const uint32_t WDT_TIMEOUT_S = 8;
const unsigned long WIFI_RESTART_MS = 60000;   // offline this long -> restart the ESP32
const unsigned long SEND_STALL_MS = 10000;     // laptop not taking data this long -> drop it

WiFiServer server(TCP_PORT);
WebServer relayHttp(80);
WiFiClient clients[MAX_CLIENTS];

bool relayAlerting = false;
unsigned long alertUntil = 0;
unsigned long nextPulseTime = 0;
int pulseStep = 0;
const int CADENCE_STEPS = 16;
const int CADENCE_DURS[CADENCE_STEPS] = {250, 200, 250, 200, 250, 200, 250, 200, 250, 200, 250, 200, 250, 200, 250, 200};
const bool CADENCE_STATES[CADENCE_STEPS] = {true, false, true, false, true, false, true, false, true, false, true, false, true, false, true, false};

void setRelay(bool on) {
  if (on) {
    pinMode(RELAY_PIN, OUTPUT);
    digitalWrite(RELAY_PIN, RELAY_ACTIVE_LOW ? LOW : HIGH);
  } else {
    // Open-drain trick: when OFF on Active-LOW relay, set pin to INPUT (floating).
    // Green LED is 100% OFF guaranteed!
    if (RELAY_ACTIVE_LOW) pinMode(RELAY_PIN, INPUT);
    else { pinMode(RELAY_PIN, OUTPUT); digitalWrite(RELAY_PIN, LOW); }
  }
}
unsigned long lastSendOk[MAX_CLIENTS];
unsigned long lastRecv[MAX_CLIENTS];
uint8_t buf[1024];                 // laptop -> Pixhawk
uint8_t pixBuf[1460];              // Pixhawk -> laptop, sent in batches (one Wi-Fi packet)
int pixLen = 0;
unsigned long pixFirst = 0;        // when the oldest unsent byte arrived
const int BATCH_BYTES = 512;       // send when this much is waiting...
const unsigned long BATCH_MS = 15; // ...or the oldest byte has waited this long

bool serverStarted = false;
bool wasOnline = false;
unsigned long offlineSince = 0;
unsigned long lastWifiTry = 0;
unsigned long lastPixData = 0;
unsigned long lastReport = 0;
unsigned long bytesFromPix = 0;
unsigned long bytesToPix = 0;
unsigned long zeroBytes = 0;
unsigned long droppedBytes = 0;

const char *resetReason() {
  switch (esp_reset_reason()) {
    case ESP_RST_POWERON: return "power on";
    case ESP_RST_SW: return "software restart (Wi-Fi was lost too long)";
    case ESP_RST_PANIC: return "crash";
    case ESP_RST_INT_WDT:
    case ESP_RST_TASK_WDT:
    case ESP_RST_WDT: return "watchdog (program had hung)";
    case ESP_RST_BROWNOUT: return "brownout (power supply dipped)";
    default: return "other";
  }
}

void setupWatchdog() {
#if ESP_ARDUINO_VERSION_MAJOR >= 3
  esp_task_wdt_config_t cfg = {};
  cfg.timeout_ms = WDT_TIMEOUT_S * 1000;
  cfg.idle_core_mask = 0;
  cfg.trigger_panic = true;
  if (esp_task_wdt_reconfigure(&cfg) != ESP_OK) esp_task_wdt_init(&cfg);
#else
  esp_task_wdt_init(WDT_TIMEOUT_S, true);
#endif
  esp_task_wdt_add(NULL);         // watch this (the loop) task
}

void dropClient(int i) {
  clients[i].stop();
}

void keepAlive(WiFiClient &c) {
  int fd = c.fd();
  if (fd < 0) return;
  int one = 1;
  setsockopt(fd, SOL_SOCKET, SO_KEEPALIVE, &one, sizeof(one));
#ifdef TCP_KEEPIDLE
  int idle = 5, intvl = 2, cnt = 3;  // a vanished laptop is noticed in about 11 s
  setsockopt(fd, IPPROTO_TCP, TCP_KEEPIDLE, &idle, sizeof(idle));
  setsockopt(fd, IPPROTO_TCP, TCP_KEEPINTVL, &intvl, sizeof(intvl));
  setsockopt(fd, IPPROTO_TCP, TCP_KEEPCNT, &cnt, sizeof(cnt));
#endif
}

// Send without ever waiting: if the laptop can't take it right now, drop it
// (MAVLink is built for lost packets); if it can't take anything for 10 s, drop the laptop.
void sendTo(int i, const uint8_t *data, int n, unsigned long now) {
  int fd = clients[i].fd();
  if (fd < 0) return;
  int r = send(fd, data, n, MSG_DONTWAIT);
  if (r == n) {
    lastSendOk[i] = now;
  } else if (r >= 0) {
    lastSendOk[i] = now;
    droppedBytes += (n - r);
  } else if (errno == EAGAIN || errno == EWOULDBLOCK) {
    droppedBytes += n;
    if (now - lastSendOk[i] > SEND_STALL_MS) dropClient(i);
  } else {
    dropClient(i);                // connection broken
  }
}

void setup() {
  pinMode(LED, OUTPUT);
  digitalWrite(LED, LOW);

  // Initialize Relay to OFF (Green LED will be completely OFF)
  setRelay(false);

  Serial.begin(115200);           // USB: status messages only
  delay(200);
  Serial.println();
  Serial.print("VARUNA boat bridge starting. Last restart: ");
  Serial.println(resetReason());

  setupWatchdog();

  Serial2.setRxBufferSize(4096);  // must be set before begin()
  Serial2.setTxBufferSize(2048);  // laptop -> Pixhawk never waits on the UART
  Serial2.begin(PIX_BAUD, SERIAL_8N1, PIX_RX, PIX_TX);
  gpio_pullup_en((gpio_num_t)PIX_RX);   // a loose D19 wire reads idle (HIGH), not junk

  WiFi.setHostname("varuna-boat");
  WiFi.mode(WIFI_STA);
  WiFi.setSleep(false);           // no power saving: lower delay on the link
  WiFi.setAutoReconnect(true);
  WiFi.begin(WIFI_SSID, WIFI_PASS);
  lastWifiTry = millis();
  offlineSince = millis();
  Serial.print("Joining Wi-Fi: ");
  Serial.println(WIFI_SSID);

  // Relay HTTP endpoints
  relayHttp.on("/alert", []() {
    int duration = relayHttp.hasArg("duration") ? relayHttp.arg("duration").toInt() : 8;
    if (duration <= 0) duration = 8;
    relayAlerting = true;
    alertUntil = millis() + (unsigned long)duration * 1000;
    pulseStep = 0;
    nextPulseTime = millis();
    relayHttp.sendHeader("Access-Control-Allow-Origin", "*");
    relayHttp.send(200, "application/json", "{\"success\":true,\"alert\":true}");
  });
  relayHttp.on("/stop", []() {
    relayAlerting = false;
    setRelay(false);
    relayHttp.sendHeader("Access-Control-Allow-Origin", "*");
    relayHttp.send(200, "application/json", "{\"success\":true,\"alert\":false}");
  });
  relayHttp.on("/on", []() {
    relayAlerting = false;
    setRelay(true);
    relayHttp.sendHeader("Access-Control-Allow-Origin", "*");
    relayHttp.send(200, "application/json", "{\"success\":true,\"state\":1}");
  });
  relayHttp.on("/off", []() {
    relayAlerting = false;
    setRelay(false);
    relayHttp.sendHeader("Access-Control-Allow-Origin", "*");
    relayHttp.send(200, "application/json", "{\"success\":true,\"state\":0}");
  });
  relayHttp.on("/status", []() {
    relayHttp.sendHeader("Access-Control-Allow-Origin", "*");
    relayHttp.send(200, "application/json", "{\"alerting\":" + String(relayAlerting ? "true" : "false") + "}");
  });
}

void loop() {
  esp_task_wdt_reset();
  unsigned long now = millis();
  bool online = (WiFi.status() == WL_CONNECTED);

  // ---- Wi-Fi: start the server once, retry if not joined, restart if gone too long
  if (online && !wasOnline) {
    Serial.print("Wi-Fi connected. ESP32 address: ");
    Serial.print(WiFi.localIP());
    Serial.print(":");
    Serial.println(TCP_PORT);
    if (!serverStarted) {
      server.begin();
      server.setNoDelay(true);
      relayHttp.begin();
      MDNS.begin("varuna-boat");
      serverStarted = true;
    }
  }
  if (serverStarted) {
    relayHttp.handleClient();
  }

  // Relay alert rhythm handler (exactly 8 beeps)
  if (relayAlerting) {
    if (pulseStep >= CADENCE_STEPS || now >= alertUntil) {
      relayAlerting = false;
      setRelay(false);
    } else if (now >= nextPulseTime) {
      bool state = CADENCE_STATES[pulseStep];
      setRelay(state);
      nextPulseTime = now + CADENCE_DURS[pulseStep];
      pulseStep++;
    }
  }

  if (!online && wasOnline) {
    Serial.println("Wi-Fi lost, reconnecting...");
    lastWifiTry = now;
    offlineSince = now;
  }
  wasOnline = online;
  if (!online) {
    if (now - offlineSince > WIFI_RESTART_MS) {
      Serial.println("No Wi-Fi for 60 s - restarting the ESP32.");
      delay(100);
      ESP.restart();
    }
    if (now - lastWifiTry > 15000) {
      lastWifiTry = now;
      Serial.println("Retrying Wi-Fi...");
      WiFi.disconnect();
      WiFi.begin(WIFI_SSID, WIFI_PASS);
    }
  }

  // ---- New laptop connection: free slot, else replace the quietest one
  if (serverStarted) {
    WiFiClient c = server.accept();
    if (c) {
      c.setNoDelay(true);
      keepAlive(c);
      int slot = -1;
      for (int i = 0; i < MAX_CLIENTS; i++) {
        if (!clients[i].connected()) {
          slot = i;
          break;
        }
      }
      if (slot < 0) {
        slot = 0;
        for (int i = 1; i < MAX_CLIENTS; i++) {
          if (lastRecv[i] < lastRecv[slot]) slot = i;
        }
      }
      clients[slot].stop();
      clients[slot] = c;
      lastSendOk[slot] = now;
      lastRecv[slot] = now;
      Serial.print("Laptop connected from ");
      Serial.println(c.remoteIP());
    }
  }

  // ---- Pixhawk -> laptop (batched)
  int room = (int)sizeof(pixBuf) - pixLen;
  int n = Serial2.available();
  if (n > 0 && room > 0) {
    if (n > room) n = room;
    n = Serial2.readBytes(pixBuf + pixLen, n);
    if (n > 0) {
      if (pixLen == 0) pixFirst = now;
      for (int i = pixLen; i < pixLen + n; i++) {
        if (pixBuf[i] == 0) zeroBytes++;
        else lastPixData = now;   // only real data counts as "flowing"
      }
      pixLen += n;
      bytesFromPix += n;
    }
  }
  if (pixLen > 0 && (pixLen >= BATCH_BYTES || now - pixFirst >= BATCH_MS)) {
    for (int i = 0; i < MAX_CLIENTS; i++) {
      if (clients[i].connected()) sendTo(i, pixBuf, pixLen, now);
    }
    pixLen = 0;
  }

  // ---- Laptop -> Pixhawk (at most one buffer per client per loop: nothing can hog it)
  for (int i = 0; i < MAX_CLIENTS; i++) {
    if (clients[i].connected() && clients[i].available() > 0) {
      int space = Serial2.availableForWrite();
      if (space <= 0) continue;
      int want = space < (int)sizeof(buf) ? space : (int)sizeof(buf);
      int r = clients[i].read(buf, want);
      if (r > 0) {
        Serial2.write(buf, r);
        bytesToPix += r;
        lastRecv[i] = now;
      }
    }
  }

  // ---- LED
  bool pixOk = (lastPixData != 0) && (now - lastPixData < 3000);
  if (!online) digitalWrite(LED, ((now / 500) % 2) ? HIGH : LOW);
  else if (pixOk) digitalWrite(LED, ((now % 1000) >= 100) ? HIGH : LOW);
  else digitalWrite(LED, HIGH);

  // ---- Status line every 5 s
  if (now - lastReport >= 5000) {
    lastReport = now;
    int nClients = 0;
    for (int i = 0; i < MAX_CLIENTS; i++) {
      if (clients[i].connected()) nClients++;
    }
    Serial.print("Wi-Fi: ");
    if (online) {
      Serial.print("connected ");
      Serial.print(WiFi.localIP());
      Serial.print(" (");
      Serial.print(WiFi.RSSI());
      Serial.print(" dBm)");
    } else {
      Serial.print("NOT connected");
    }
    Serial.print(" | Pixhawk data: ");
    Serial.print(pixOk ? "YES" : "NO");
    Serial.print(" | laptop connected: ");
    Serial.print(nClients);
    Serial.print(" | bytes from/to Pixhawk: ");
    Serial.print(bytesFromPix);
    Serial.print("/");
    Serial.print(bytesToPix);
    Serial.print(" | zero bytes: ");
    Serial.print(zeroBytes);
    Serial.print(" | dropped: ");
    Serial.print(droppedBytes);
    Serial.print(" | up ");
    Serial.print(now / 1000);
    Serial.print(" s | last restart: ");
    Serial.println(resetReason());
  }

  delay(1);
}
