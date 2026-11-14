/*
  VARUNA ESP32 USB bridge: Pixhawk TELEM2 <-> ESP32 <-> phone, over a USB-C cable.

    Pixhawk TELEM2 --TX/RX/GND wires--> ESP32 UART --USB--> phone (Termux: relay.py --usb)

  The ESP32 copies bytes both ways and does nothing else: the MAVLink is not
  changed, so the Pixhawk, the phone relay and the VARUNA backend see exactly
  what the Pixhawk sends. Wi-Fi and Bluetooth stay off. The phone powers the
  ESP32 through the USB cable; do NOT also connect the Pixhawk's 5 V.

  Board: any ESP32 with a USB port (ESP32 DevKit with CH340 / CP2102 / CH9102,
  ESP32-S3, ESP32-C3). Arduino IDE with the "esp32" boards package by Espressif.
  On ESP32-S3 / C3 boards that have only the native USB port, set
  Tools > USB CDC On Boot > Enabled.

  Wiring (3.3 V logic on both sides, no level shifter):
    Pixhawk TELEM2 TX  ->  ESP32 FC_RX_PIN
    Pixhawk TELEM2 RX  <-  ESP32 FC_TX_PIN
    Pixhawk TELEM2 GND --  ESP32 GND
    Pixhawk TELEM2 5V      not connected

  The Pixhawk side stays as it was for the Pi: SERIAL2_PROTOCOL = 2 (MAVLink2),
  SERIAL2_BAUD = 57 (57600).
*/

// ---- Settings ---------------------------------------------------------------

// Must match the Pixhawk's SERIAL2_BAUD (57 = 57600).
static const uint32_t FC_BAUD = 57600;

// USB serial speed towards the phone. The phone relay opens the port at this
// speed; it only matters for CH340 / CP2102 boards. Keep it above FC_BAUD.
static const uint32_t USB_BAUD = 115200;

// UART pins wired to the Pixhawk. Change them here if you wire other pins.
#if defined(CONFIG_IDF_TARGET_ESP32)
static const int FC_RX_PIN = 16;   // marked RX2 on most ESP32 DevKits
static const int FC_TX_PIN = 17;   // marked TX2
static const int LED_PIN = 2;      // blue on-board LED of most ESP32 DevKits
#elif defined(CONFIG_IDF_TARGET_ESP32S3) || defined(CONFIG_IDF_TARGET_ESP32S2)
static const int FC_RX_PIN = 18;
static const int FC_TX_PIN = 17;
static const int LED_PIN = -1;     // -1 = no activity LED
#elif defined(CONFIG_IDF_TARGET_ESP32C3) || defined(CONFIG_IDF_TARGET_ESP32C6)
static const int FC_RX_PIN = 4;
static const int FC_TX_PIN = 5;
static const int LED_PIN = -1;
#else
static const int FC_RX_PIN = 16;
static const int FC_TX_PIN = 17;
static const int LED_PIN = -1;
#endif

// ---- Bridge -----------------------------------------------------------------

// UART1 exists on every ESP32 chip (the ESP32-C3 has no UART2).
HardwareSerial FcSerial(1);

static uint8_t toPhone[512];
static uint8_t toDrone[512];
static uint32_t lastActivityMs = 0;

void setup() {
  // Buffers must be sized before begin(). 4 KB from the Pixhawk is about
  // 0.7 s of telemetry at 57600, enough to ride out a busy phone.
  FcSerial.setRxBufferSize(4096);
  FcSerial.begin(FC_BAUD, SERIAL_8N1, FC_RX_PIN, FC_TX_PIN);

  Serial.setRxBufferSize(1024);
  Serial.begin(USB_BAUD);

  if (LED_PIN >= 0) {
    pinMode(LED_PIN, OUTPUT);
    digitalWrite(LED_PIN, LOW);
  }
}

void loop() {
  bool moved = false;

  // Pixhawk -> phone
  int n = FcSerial.available();
  if (n > 0) {
    if (n > (int)sizeof(toPhone)) {
      n = sizeof(toPhone);
    }
    size_t got = FcSerial.readBytes(toPhone, (size_t)n);
    if (got > 0) {
      Serial.write(toPhone, got);
      moved = true;
    }
  }

  // Phone -> Pixhawk
  n = Serial.available();
  if (n > 0) {
    if (n > (int)sizeof(toDrone)) {
      n = sizeof(toDrone);
    }
    size_t got = Serial.readBytes(toDrone, (size_t)n);
    if (got > 0) {
      FcSerial.write(toDrone, got);
      moved = true;
    }
  }

  // Activity LED: on while data flows, off after 200 ms of silence.
  if (LED_PIN >= 0) {
    uint32_t now = millis();
    if (moved) {
      lastActivityMs = now;
      digitalWrite(LED_PIN, HIGH);
    } else if (now - lastActivityMs > 200) {
      digitalWrite(LED_PIN, LOW);
    }
  }

  if (!moved) {
    delay(1);   // nothing waiting: let the idle task run
  }
}
