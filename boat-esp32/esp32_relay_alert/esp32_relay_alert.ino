// VARUNA Boat - Standalone ESP32 5V Relay Alert Controller
// Connects to the same hotspot as the boat / phone / laptop.
// Controls 5V Relay on D23 (or any GPIO) with zero-glitch open-drain logic.
//
// Wiring:
//   ESP32 D23  -> Relay [ IN ]
//   ESP32 5V (or VIN) -> Relay [ VCC ]
//   ESP32 GND  -> Relay [ GND ]
//
// HTTP Endpoints:
//   http://<esp32-ip>/alert?duration=8   -> pulses alert rhythm for 8s
//   http://<esp32-ip>/stop               -> stops alert immediately
//   http://<esp32-ip>/on                 -> turns relay ON
//   http://<esp32-ip>/off                -> turns relay OFF
//   http://<esp32-ip>/status             -> returns JSON status

#include <WiFi.h>
#include <WebServer.h>
#include <ESPmDNS.h>

// ======== EDIT THESE FOR YOUR HOTSPOT ========
const char *WIFI_SSID = "1234";
const char *WIFI_PASS = "YOUR_WIFI_PASSWORD";
// ==============================================

const int RELAY_PIN = 23;           // D23 connects to Relay IN
const bool RELAY_ACTIVE_LOW = true; // true for standard Arduino 5V relay modules
const int ONBOARD_LED = 2;          // ESP32 onboard blue LED

WebServer server(80);

bool relayAlerting = false;
unsigned long alertUntil = 0;
unsigned long nextPulseTime = 0;
int pulseStep = 0;

// Alert rhythm: exactly 8 beeps/flashes (250ms ON, 200ms OFF x 8 times)
const int CADENCE_STEPS = 16;
const int CADENCE_DURS[CADENCE_STEPS] = {250, 200, 250, 200, 250, 200, 250, 200, 250, 200, 250, 200, 250, 200, 250, 200};
const bool CADENCE_STATES[CADENCE_STEPS] = {true, false, true, false, true, false, true, false, true, false, true, false, true, false, true, false};

void setRelay(bool on) {
  if (on) {
    pinMode(RELAY_PIN, OUTPUT);
    digitalWrite(RELAY_PIN, RELAY_ACTIVE_LOW ? LOW : HIGH);
    digitalWrite(ONBOARD_LED, HIGH);
  } else {
    // Open-drain trick: when OFF on Active-LOW relay, set pin to INPUT (floating).
    // The relay's internal pull-up holds it high with 0V drop, so GREEN LED is 100% OFF!
    if (RELAY_ACTIVE_LOW) {
      pinMode(RELAY_PIN, INPUT);
    } else {
      pinMode(RELAY_PIN, OUTPUT);
      digitalWrite(RELAY_PIN, LOW);
    }
    digitalWrite(ONBOARD_LED, LOW);
  }
}

void handleAlert() {
  int duration = 8;
  if (server.hasArg("duration")) {
    duration = server.arg("duration").toInt();
    if (duration <= 0) duration = 8;
  }
  relayAlerting = true;
  alertUntil = millis() + (unsigned long)duration * 1000;
  pulseStep = 0;
  nextPulseTime = millis();
  server.sendHeader("Access-Control-Allow-Origin", "*");
  server.send(200, "application/json", "{\"success\":true,\"alert\":true,\"duration\":" + String(duration) + "}");
}

void handleStop() {
  relayAlerting = false;
  setRelay(false);
  server.sendHeader("Access-Control-Allow-Origin", "*");
  server.send(200, "application/json", "{\"success\":true,\"alert\":false}");
}

void handleOn() {
  relayAlerting = false;
  setRelay(true);
  server.sendHeader("Access-Control-Allow-Origin", "*");
  server.send(200, "application/json", "{\"success\":true,\"state\":1}");
}

void handleOff() {
  relayAlerting = false;
  setRelay(false);
  server.sendHeader("Access-Control-Allow-Origin", "*");
  server.send(200, "application/json", "{\"success\":true,\"state\":0}");
}

void handleStatus() {
  server.sendHeader("Access-Control-Allow-Origin", "*");
  String json = "{\"success\":true,\"alerting\":" + String(relayAlerting ? "true" : "false")
                + ",\"ip\":\"" + WiFi.localIP().toString() + "\"}";
  server.send(200, "application/json", json);
}

void setup() {
  Serial.begin(115200);
  pinMode(ONBOARD_LED, OUTPUT);
  digitalWrite(ONBOARD_LED, LOW);

  // Initialize Relay to OFF (Green LED will be completely OFF)
  setRelay(false);

  Serial.println("\nVARUNA ESP32 Relay Controller Starting...");
  WiFi.mode(WIFI_STA);
  WiFi.setHostname("varuna-relay");
  WiFi.begin(WIFI_SSID, WIFI_PASS);

  while (WiFi.status() != WL_CONNECTED) {
    delay(300);
    digitalWrite(ONBOARD_LED, !digitalRead(ONBOARD_LED));
    Serial.print(".");
  }

  digitalWrite(ONBOARD_LED, LOW);
  Serial.println("\nWi-Fi Connected!");
  Serial.print("ESP32 Relay IP: ");
  Serial.println(WiFi.localIP());

  if (MDNS.begin("varuna-relay")) {
    Serial.println("MDNS responder started: http://varuna-relay.local");
  }

  server.on("/alert", handleAlert);
  server.on("/stop", handleStop);
  server.on("/on", handleOn);
  server.on("/off", handleOff);
  server.on("/status", handleStatus);
  server.begin();
  Serial.println("HTTP Server listening on port 80.");
}

void loop() {
  server.handleClient();

  if (relayAlerting) {
    if (pulseStep >= CADENCE_STEPS || millis() >= alertUntil) {
      relayAlerting = false;
      setRelay(false);
    } else if (millis() >= nextPulseTime) {
      bool state = CADENCE_STATES[pulseStep];
      setRelay(state);
      nextPulseTime = millis() + CADENCE_DURS[pulseStep];
      pulseStep++;
    }
  }
}
