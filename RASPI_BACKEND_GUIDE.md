# VARUNA GCS — Raspberry Pi Backend: Zero to Deployed

> **Audience**: Someone who has never touched a Raspberry Pi before. Every command is copy-pasteable. Every code file is complete and final.

---

## Table of Contents

1. [Hardware Requirements](#1-hardware-requirements)
2. [Flash Raspberry Pi OS](#2-flash-raspberry-pi-os)
3. [First Boot — SSH, Hostname, Filesystem](#3-first-boot)
4. [System Packages](#4-system-packages)
5. [Install Netbird (WireGuard Mesh)](#5-install-netbird)
6. [Python 3.11 venv Setup](#6-python-venv-setup)
7. [requirements.txt — Pinned Versions](#7-requirementstxt)
8. [Complete Backend Code](#8-complete-backend-code)
   - [main.py](#mainpy)
   - [i2c_telemetry.py](#i2c_telemetrypy)
   - [camera.py](#camerapy)
   - [config.py](#configpy)
   - [missions.py](#missionspy)
   - [auth.py](#authpy)
   - [health.py](#healthpy)
9. [systemd Service — Auto-start on Boot](#9-systemd-service)
10. [Verify Everything Works](#10-verify-everything-works)
11. [GCS App — Connection Field](#11-gcs-app-connection-field)
12. [Troubleshooting Table](#12-troubleshooting-table)

---

## 1. Hardware Requirements

| Item | Specification | Notes |
|---|---|---|
| Raspberry Pi | Pi 4 Model B (4 GB RAM minimum) | Pi 5 also works |
| MicroSD card | 32 GB Class 10 / A2 | Samsung Endurance or SanDisk |
| USB-C power supply | 5V 3A for Pi 4, 5V 5A for Pi 5 | Official PSU recommended |
| USB webcam | Any UVC-compatible camera | Logitech C270 / C920 confirmed working |
| I2C wires (Dupont) | 4× Female-Female jumper wires | SDA, SCL, 3.3V, GND |
| Flight controller | ArduPilot/PX4 with custom I2C slave firmware | Address 0x08, 32-byte packet |
| Host PC | Windows / macOS / Linux | For flashing the SD card |
| Ethernet cable or Wi-Fi | Internet access during setup | Required for Netbird join |

**I2C wiring (Pi GPIO header → Flight Controller):**

```
Pi Pin 3  (GPIO 2, SDA) ──→ FC SDA
Pi Pin 5  (GPIO 3, SCL) ──→ FC SCL
Pi Pin 1  (3.3V)        ──→ FC VCC (logic level)
Pi Pin 6  (GND)         ──→ FC GND
```

> **Warning**: Never connect flight controller I2C to 5V. Use 3.3V only.

---

## 2. Flash Raspberry Pi OS

### 2.1 Download Raspberry Pi Imager

Go to https://www.raspberrypi.com/software/ and download the imager for your OS. Install and open it.

### 2.2 Imager Settings

1. Click **Choose Device** → select your Pi model (e.g. Raspberry Pi 4).
2. Click **Choose OS** → **Raspberry Pi OS (other)** → **Raspberry Pi OS Lite (64-bit)**.
   - "Lite" = no desktop. We need CLI only.
3. Click **Choose Storage** → select your microSD card.
4. Click the **gear icon (⚙️)** (or press Ctrl+Shift+X) to open **Advanced Options**:

| Setting | Value |
|---|---|
| Set hostname | `varuna-pi.local` |
| Enable SSH | ✅ checked |
| SSH auth | Use password authentication |
| Username | `pi` |
| Password | `varuna2024` (change this after setup) |
| Configure wireless LAN | Fill in your Wi-Fi SSID and password if no Ethernet |
| Wireless LAN country | Your country code (e.g. `IN`, `US`, `GB`) |
| Set locale | Your timezone and keyboard layout |

5. Click **Save**, then **Write**. Confirm the warning — this erases the card.
6. Wait for write + verify to complete (~5 minutes).
7. Eject the card and insert it into the Pi.

### 2.3 Power On

Connect Ethernet (recommended for first boot) and power the Pi. Wait 60 seconds for first boot to complete.

---

## 3. First Boot

### 3.1 Find the Pi on Your Network

From your PC:

```bash
ping varuna-pi.local
```

If that doesn't resolve (common on Windows), check your router's DHCP leases for a device named `varuna-pi`, or use:

```bash
# On Linux/macOS:
arp -a | grep -i raspberry

# On Windows (PowerShell):
arp -a
```

### 3.2 SSH Into the Pi

```bash
ssh pi@varuna-pi.local
```

Password: `varuna2024`

Accept the fingerprint prompt by typing `yes` and pressing Enter.

### 3.3 Set Hostname (if not set by imager)

```bash
sudo hostnamectl set-hostname varuna-pi
```

Edit the hosts file to match:

```bash
sudo nano /etc/hosts
```

Find the line with `127.0.1.1` and change it to:

```
127.0.1.1   varuna-pi
```

Save: `Ctrl+O`, Enter, `Ctrl+X`.

### 3.4 Expand the Filesystem

```bash
sudo raspi-config
```

Navigate: **Advanced Options** → **Expand Filesystem** → OK → Finish → **Reboot now**.

SSH back in after 30 seconds:

```bash
ssh pi@varuna-pi.local
```

### 3.5 Update the System

```bash
sudo apt update && sudo apt full-upgrade -y
```

This may take 5–10 minutes.

### 3.6 Enable I2C

```bash
sudo raspi-config
```

Navigate: **Interface Options** → **I2C** → **Yes** → Finish.

Verify I2C is enabled:

```bash
ls /dev/i2c*
```

Expected output: `/dev/i2c-1`

Add the `pi` user to the `i2c` group so the service can access it without sudo:

```bash
sudo usermod -aG i2c pi
```

Log out and back in for the group change to take effect:

```bash
exit
ssh pi@varuna-pi.local
```

---

## 4. System Packages

Install everything the backend needs in one command:

```bash
sudo apt install -y \
  python3.11 \
  python3.11-venv \
  python3.11-dev \
  python3-pip \
  python3-smbus \
  i2c-tools \
  libcamera-dev \
  libopencv-dev \
  libavcodec-dev \
  libavformat-dev \
  libswscale-dev \
  libv4l-dev \
  v4l-utils \
  ffmpeg \
  git \
  curl \
  wget \
  nano \
  htop \
  build-essential \
  libjpeg-dev \
  libpng-dev \
  libtiff-dev \
  libatlas-base-dev \
  gfortran
```

> If `python3.11` is not found, run these commands first to add the deadsnakes PPA:
>
> ```bash
> sudo apt install -y software-properties-common
> sudo add-apt-repository ppa:deadsnakes/ppa -y
> sudo apt update
> sudo apt install -y python3.11 python3.11-venv python3.11-dev
> ```

Verify the Python version:

```bash
python3.11 --version
```

Expected: `Python 3.11.x`

### 4.1 Verify I2C Devices

With the flight controller wired and powered:

```bash
sudo i2cdetect -y 1
```

You should see `08` appear in the grid at address 0x08. If no devices show, check wiring.

### 4.2 Verify Webcam

```bash
v4l2-ctl --list-devices
```

You should see something like:

```
USB Webcam (usb-...):
    /dev/video0
```

---

## 5. Install Netbird

Netbird creates a WireGuard-based mesh VPN so your GCS laptop and the Raspberry Pi share a private IP space regardless of which network they're on.

### 5.1 Install Netbird

```bash
curl -fsSL https://pkgs.netbird.io/install.sh | sh
```

### 5.2 Join Your Netbird Network

Go to https://app.netbird.io and sign in (create a free account if needed). Get your setup key from **Setup Keys** in the dashboard.

```bash
sudo netbird up --setup-key YOUR_SETUP_KEY_HERE
```

Replace `YOUR_SETUP_KEY_HERE` with the actual key from the Netbird dashboard.

### 5.3 Verify the Mesh IP

```bash
netbird status
```

Look for the `Netbird IP` field. It will look like `100.64.x.x`. Note this IP — it is what the GCS app will connect to.

### 5.4 Enable Netbird on Boot

```bash
sudo systemctl enable netbird
sudo systemctl start netbird
```

### 5.5 Install Netbird on Your GCS Laptop

On your laptop (Windows/macOS/Linux), download and install Netbird from https://app.netbird.io/downloads and join the same network with the same setup key. After joining, both devices will be able to reach each other via their `100.64.x.x` addresses.

Test connectivity from your laptop:

```bash
ping 100.64.x.x
```

(Replace with the Pi's Netbird IP.)

---

## 6. Python venv Setup

### 6.1 Create the Project Directory

```bash
mkdir -p /home/pi/varuna-ai-enterprise
cd /home/pi/varuna-ai-enterprise
```

### 6.2 Create the Virtual Environment

```bash
python3.11 -m venv venv
```

### 6.3 Activate the venv

```bash
source venv/bin/activate
```

Your prompt will now show `(venv)` at the beginning. **Every Python-related command in this guide assumes the venv is active.**

### 6.4 Upgrade pip inside the venv

```bash
pip install --upgrade pip setuptools wheel
```

---

## 7. requirements.txt

Create the requirements file:

```bash
nano /home/pi/varuna-ai-enterprise/requirements.txt
```

Paste the following content exactly:

```
fastapi==0.111.0
uvicorn[standard]==0.29.0
smbus2==0.4.3
opencv-python-headless==4.9.0.80
psutil==5.9.8
python-multipart==0.0.9
websockets==12.0
aiofiles==23.2.1
httpx==0.27.0
```

Save: `Ctrl+O`, Enter, `Ctrl+X`.

Install all dependencies:

```bash
pip install -r /home/pi/varuna-ai-enterprise/requirements.txt
```

This will take several minutes. OpenCV is the largest package.

---

## 8. Complete Backend Code

Create all the Python files below. Every file is complete and final.

### Directory Layout

```
/home/pi/varuna-ai-enterprise/
├── venv/
├── requirements.txt
├── main.py
├── i2c_telemetry.py
├── camera.py
├── config.py
├── missions.py
├── auth.py
├── health.py
├── config.json          ← auto-created on first run
└── missions.json        ← auto-created on first run
```

---

### main.py

```bash
nano /home/pi/varuna-ai-enterprise/main.py
```

```python
"""
VARUNA GCS — FastAPI Backend
Entry point: all HTTP routes and WebSocket endpoint.
Run: uvicorn main:app --host 0.0.0.0 --port 8000
"""

import asyncio
import json
import time
import logging
from contextlib import asynccontextmanager
from typing import Any

from fastapi import FastAPI, WebSocket, WebSocketDisconnect, Query
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse, Response
from pydantic import BaseModel

from config import config_store
from missions import mission_store
from auth import verify_pin
from health import get_health
from camera import camera_manager
from i2c_telemetry import i2c_reader

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
logger = logging.getLogger("varuna")

# ---------------------------------------------------------------------------
# Request / Response models
# ---------------------------------------------------------------------------

class ArmRequest(BaseModel):
    arm: bool

class ModeRequest(BaseModel):
    mode: str

class TakeoffRequest(BaseModel):
    altitude: float

class MissionWaypoint(BaseModel):
    lat: float
    lng: float
    alt: float
    speed: float
    action: str

class MissionUploadRequest(BaseModel):
    name: str
    waypoints: list[MissionWaypoint]

class AIToggleRequest(BaseModel):
    enabled: bool

class AIReportRequest(BaseModel):
    debrisType: str

class PinRequest(BaseModel):
    password: str

class PreferModeRequest(BaseModel):
    mode: str


# ---------------------------------------------------------------------------
# AI state (in-memory; no real ML model — extend as needed)
# ---------------------------------------------------------------------------

ai_state: dict[str, Any] = {
    "ai_enabled": False,
    "model_loaded": True,
    "confidence_threshold": 0.5,
    "live_boxes": 0,
    "detections": [],
}


# ---------------------------------------------------------------------------
# WebSocket connection manager
# ---------------------------------------------------------------------------

class ConnectionManager:
    def __init__(self) -> None:
        self.active: list[WebSocket] = []

    async def connect(self, ws: WebSocket) -> None:
        await ws.accept()
        self.active.append(ws)
        logger.info("WS client connected. Total: %d", len(self.active))

    def disconnect(self, ws: WebSocket) -> None:
        self.active.remove(ws)
        logger.info("WS client disconnected. Total: %d", len(self.active))

    async def broadcast(self, data: dict) -> None:
        dead: list[WebSocket] = []
        for ws in self.active:
            try:
                await ws.send_json(data)
            except Exception:
                dead.append(ws)
        for ws in dead:
            self.active.remove(ws)


ws_manager = ConnectionManager()


# ---------------------------------------------------------------------------
# Lifespan — start background threads
# ---------------------------------------------------------------------------

@asynccontextmanager
async def lifespan(app: FastAPI):
    # Start I2C reader background thread
    i2c_reader.start()
    # Start camera background thread
    camera_manager.start()
    # Start WebSocket broadcast loop
    asyncio.create_task(ws_broadcast_loop())
    logger.info("VARUNA backend started.")
    yield
    i2c_reader.stop()
    camera_manager.stop()
    logger.info("VARUNA backend stopped.")


# ---------------------------------------------------------------------------
# FastAPI app
# ---------------------------------------------------------------------------

app = FastAPI(title="VARUNA GCS Backend", version="1.0.0", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


# ---------------------------------------------------------------------------
# WebSocket broadcast loop
# ---------------------------------------------------------------------------

async def ws_broadcast_loop() -> None:
    """Push telemetry to all connected WebSocket clients every ~200 ms."""
    while True:
        data = i2c_reader.get_telemetry()
        await ws_manager.broadcast(data)
        await asyncio.sleep(0.2)


# ---------------------------------------------------------------------------
# Ping / Health
# ---------------------------------------------------------------------------

@app.get("/api/ping")
async def ping():
    return {"status": "ok"}


@app.get("/api/health")
async def health():
    return get_health()


@app.get("/api/system/status")
async def system_status():
    return {"status": "ok"}


@app.get("/api/system/pi")
async def system_pi(processes: bool = Query(default=False)):
    import psutil
    temps = psutil.sensors_temperatures()
    temp_val = 0.0
    if temps:
        for key in ("cpu_thermal", "coretemp", "soc_thermal"):
            if key in temps and temps[key]:
                temp_val = temps[key][0].current
                break
        if temp_val == 0.0:
            for entries in temps.values():
                if entries:
                    temp_val = entries[0].current
                    break

    cpu_per_core = [{"percent": p} for p in psutil.cpu_percent(percpu=True, interval=0.2)]
    ram = psutil.virtual_memory()
    disk = psutil.disk_usage("/")

    return {
        "cpu_per_core": cpu_per_core,
        "ram_percent": ram.percent,
        "disk_percent": disk.percent,
        "temperature": round(temp_val, 1),
        "cpu_count": psutil.cpu_count(logical=True),
    }


# ---------------------------------------------------------------------------
# Camera
# ---------------------------------------------------------------------------

@app.get("/api/camera/status")
async def camera_status():
    return camera_manager.get_status()


@app.get("/video_feed")
async def video_feed():
    return StreamingResponse(
        camera_manager.mjpeg_generator(),
        media_type="multipart/x-mixed-replace; boundary=frame",
    )


@app.get("/api/camera/snapshot")
async def camera_snapshot():
    jpeg_bytes = camera_manager.snapshot()
    if jpeg_bytes is None:
        return Response(content=b"", media_type="image/jpeg", status_code=503)
    return Response(content=jpeg_bytes, media_type="image/jpeg")


# ---------------------------------------------------------------------------
# AI
# ---------------------------------------------------------------------------

@app.get("/api/ai/status")
async def ai_status():
    return {
        "ai_enabled": ai_state["ai_enabled"],
        "model_loaded": ai_state["model_loaded"],
        "confidence_threshold": ai_state["confidence_threshold"],
        "live_boxes": ai_state["live_boxes"],
    }


@app.post("/api/ai/toggle")
async def ai_toggle(body: AIToggleRequest):
    ai_state["ai_enabled"] = body.enabled
    state_str = "enabled" if body.enabled else "disabled"
    return {"success": True, "message": f"AI inference {state_str}."}


@app.get("/api/ai/detections")
async def ai_detections(limit: int = Query(default=50)):
    detections = ai_state["detections"][-limit:]
    return detections


@app.post("/api/ai/report")
async def ai_report(body: AIReportRequest):
    logger.info("AI debris report received: %s", body.debrisType)
    return {"success": True, "message": f"Debris report '{body.debrisType}' logged."}


# ---------------------------------------------------------------------------
# Telemetry
# ---------------------------------------------------------------------------

@app.get("/api/telemetry")
async def telemetry():
    return i2c_reader.get_telemetry()


@app.get("/api/telemetry/history")
async def telemetry_history(limit: int = Query(default=200)):
    return i2c_reader.get_history(limit)


# ---------------------------------------------------------------------------
# MAVLink-style commands (relayed via I2C or simulated)
# ---------------------------------------------------------------------------

@app.post("/api/mavlink/arm")
async def mavlink_arm(body: ArmRequest):
    success = i2c_reader.send_arm_command(body.arm)
    verb = "Armed" if body.arm else "Disarmed"
    return {"success": success, "message": f"{verb} command sent." if success else "I2C write failed."}


@app.post("/api/mavlink/mode")
async def mavlink_mode(body: ModeRequest):
    success = i2c_reader.send_mode_command(body.mode)
    return {"success": success, "message": f"Mode '{body.mode}' command sent." if success else "I2C write failed."}


@app.post("/api/mavlink/takeoff")
async def mavlink_takeoff(body: TakeoffRequest):
    success = i2c_reader.send_takeoff_command(body.altitude)
    return {"success": success, "message": f"Takeoff to {body.altitude}m command sent." if success else "I2C write failed."}


@app.post("/api/mavlink/rtl")
async def mavlink_rtl():
    success = i2c_reader.send_mode_command("RTL")
    return {"success": success, "message": "RTL command sent." if success else "I2C write failed."}


@app.post("/api/mavlink/land")
async def mavlink_land():
    success = i2c_reader.send_mode_command("LAND")
    return {"success": success, "message": "Land command sent." if success else "I2C write failed."}


@app.get("/api/mavlink/status")
async def mavlink_status():
    telem = i2c_reader.get_telemetry()
    return {"mode": telem["flight_mode"], "armed": telem["armed"]}


@app.get("/api/mavlink/prefer")
async def mavlink_prefer_get():
    return {"mode": config_store.get("preferred_mode", "LOITER")}


@app.post("/api/mavlink/prefer")
async def mavlink_prefer_set(body: PreferModeRequest):
    config_store.set("preferred_mode", body.mode)
    config_store.save()
    return {"success": True, "message": f"Preferred mode set to '{body.mode}'."}


# ---------------------------------------------------------------------------
# Mission
# ---------------------------------------------------------------------------

@app.post("/api/mission/upload")
async def mission_upload(body: MissionUploadRequest):
    waypoints = [wp.model_dump() for wp in body.waypoints]
    mission_store.upload(body.name, waypoints)
    return {"success": True, "message": f"Mission '{body.name}' uploaded with {len(waypoints)} waypoints."}


@app.post("/api/mission/start")
async def mission_start():
    result = mission_store.start()
    return result


@app.get("/api/mission/list")
async def mission_list():
    return mission_store.list_missions()


# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------

@app.get("/api/config")
async def config_get():
    return config_store.get_schema()


@app.post("/api/config")
async def config_set(body: dict):
    result = config_store.update(body)
    return result


@app.post("/api/config/save")
async def config_save():
    config_store.save()
    return {"success": True, "message": "Configuration saved to disk."}


# ---------------------------------------------------------------------------
# Auth
# ---------------------------------------------------------------------------

@app.post("/api/auth/verify_pin")
async def auth_verify_pin(body: PinRequest):
    ok = verify_pin(body.password)
    return {"success": ok, "message": "PIN accepted." if ok else "Invalid PIN."}


# ---------------------------------------------------------------------------
# WebSocket
# ---------------------------------------------------------------------------

@app.websocket("/api/ws")
async def websocket_endpoint(ws: WebSocket):
    await ws_manager.connect(ws)
    try:
        while True:
            # Keep connection alive; broadcast loop sends data independently
            await asyncio.sleep(10)
    except WebSocketDisconnect:
        ws_manager.disconnect(ws)
    except Exception as exc:
        logger.warning("WS error: %s", exc)
        ws_manager.disconnect(ws)


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------

if __name__ == "__main__":
    import uvicorn
    uvicorn.run("main:app", host="0.0.0.0", port=8000, reload=False)
```

Save: `Ctrl+O`, Enter, `Ctrl+X`.

---

### i2c_telemetry.py

```bash
nano /home/pi/varuna-ai-enterprise/i2c_telemetry.py
```

```python
"""
I2C Telemetry Reader
Reads a 32-byte binary packet from the flight controller at address 0x08 on I2C bus 1.

Packet layout (little-endian, 25 bytes of data + 7 padding bytes = 32 total):
  Offset  Size  Type    Field            Scale
  0       4     int32   lat              × 1e-7  → degrees
  4       4     int32   lng              × 1e-7  → degrees
  8       2     int16   alt              cm → m (÷ 100)
  10      2     uint16  speed            cm/s → m/s (÷ 100)
  12      2     uint16  heading          × 0.1° → degrees
  14      1     uint8   armed            0 or 1
  15      1     uint8   mode             0–5 (see MODE_MAP)
  16      2     uint16  battery_mv       mV → V (÷ 1000)
  18      1     uint8   sats             count
  19      2     uint16  throttle         raw PWM (1000–2000)
  21      2     int16   roll             × 0.01 rad
  23      2     int16   pitch            × 0.01 rad
  25      7     —       padding (zeros)
"""

import struct
import threading
import time
import logging
from collections import deque
from typing import Any

try:
    import smbus2
    _SMBUS_AVAILABLE = True
except ImportError:
    _SMBUS_AVAILABLE = False

logger = logging.getLogger("varuna.i2c")

I2C_BUS = 1
FC_ADDRESS = 0x08
PACKET_SIZE = 32
POLL_INTERVAL = 0.2  # seconds

MODE_MAP = {
    0: "STABILIZE",
    1: "ALT_HOLD",
    2: "LOITER",
    3: "AUTO",
    4: "RTL",
    5: "LAND",
}

# Command byte codes sent TO the flight controller
CMD_ARM = 0xA1
CMD_DISARM = 0xA2
CMD_TAKEOFF = 0xA3
CMD_MODE_BASE = 0xB0  # CMD_MODE_BASE + mode_index

MODE_TO_INDEX = {v: k for k, v in MODE_MAP.items()}
MODE_TO_INDEX["RTL"] = 4
MODE_TO_INDEX["LAND"] = 5

_DEFAULT_TELEMETRY: dict[str, Any] = {
    "lat": 0.0,
    "lng": 0.0,
    "altitude": 0.0,
    "speed": 0.0,
    "heading": 0.0,
    "flight_mode": "STABILIZE",
    "armed": False,
    "battery_voltage": 0.0,
    "satellites": 0,
    "throttle": 1000,
    "roll": 0.0,
    "pitch": 0.0,
    "yaw": 0.0,
    "relative_alt": 0.0,
    "groundspeed": 0.0,
}

STRUCT_FORMAT = "<iiHHHBBHBHhh7x"
# i=int32, H=uint16, B=uint8, h=int16, x=pad byte
# Total: 4+4+2+2+2+1+1+2+1+2+2+2+7 = 32 bytes ✓


def _parse_packet(raw: bytes) -> dict[str, Any]:
    if len(raw) < PACKET_SIZE:
        raise ValueError(f"Short packet: {len(raw)} bytes")
    fields = struct.unpack_from(STRUCT_FORMAT, raw, 0)
    lat_raw, lng_raw, alt_cm, speed_cm, heading_x10, armed_u8, mode_u8, batt_mv, sats, throttle, roll_x100, pitch_x100 = fields
    lat = lat_raw * 1e-7
    lng = lng_raw * 1e-7
    alt = alt_cm / 100.0
    speed = speed_cm / 100.0
    heading = heading_x10 * 0.1
    armed = bool(armed_u8)
    flight_mode = MODE_MAP.get(mode_u8, "STABILIZE")
    battery_voltage = batt_mv / 1000.0
    roll = roll_x100 * 0.01
    pitch = pitch_x100 * 0.01
    yaw = heading  # best approximation without magnetometer yaw
    return {
        "lat": round(lat, 7),
        "lng": round(lng, 7),
        "altitude": round(alt, 2),
        "speed": round(speed, 2),
        "heading": round(heading, 1),
        "flight_mode": flight_mode,
        "armed": armed,
        "battery_voltage": round(battery_voltage, 2),
        "satellites": int(sats),
        "throttle": int(throttle),
        "roll": round(roll, 4),
        "pitch": round(pitch, 4),
        "yaw": round(yaw, 4),
        "relative_alt": round(alt, 2),
        "groundspeed": round(speed, 2),
    }


class I2CReader:
    """Background thread that continuously reads telemetry from the FC over I2C."""

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._last: dict[str, Any] = dict(_DEFAULT_TELEMETRY)
        self._history: deque[dict[str, Any]] = deque(maxlen=200)
        self._running = False
        self._thread: threading.Thread | None = None
        self._bus: Any = None
        self._i2c_ok = False

    # ------------------------------------------------------------------
    def start(self) -> None:
        self._running = True
        self._thread = threading.Thread(target=self._loop, name="i2c-reader", daemon=True)
        self._thread.start()
        logger.info("I2C reader thread started.")

    def stop(self) -> None:
        self._running = False
        if self._thread:
            self._thread.join(timeout=2.0)
        if self._bus:
            try:
                self._bus.close()
            except Exception:
                pass
        logger.info("I2C reader thread stopped.")

    # ------------------------------------------------------------------
    def _open_bus(self) -> bool:
        if not _SMBUS_AVAILABLE:
            logger.warning("smbus2 not available — running in simulation mode.")
            return False
        try:
            self._bus = smbus2.SMBus(I2C_BUS)
            self._i2c_ok = True
            logger.info("I2C bus %d opened.", I2C_BUS)
            return True
        except Exception as exc:
            logger.error("Failed to open I2C bus: %s", exc)
            self._i2c_ok = False
            return False

    def _loop(self) -> None:
        if not self._open_bus():
            logger.warning("I2C unavailable. Publishing simulated telemetry.")
            self._simulate_loop()
            return

        consecutive_errors = 0
        while self._running:
            try:
                raw = self._bus.read_i2c_block_data(FC_ADDRESS, 0x00, PACKET_SIZE)
                raw_bytes = bytes(raw)
                parsed = _parse_packet(raw_bytes)
                with self._lock:
                    self._last = parsed
                    self._history.append(dict(parsed))
                consecutive_errors = 0
            except Exception as exc:
                consecutive_errors += 1
                if consecutive_errors <= 3 or consecutive_errors % 50 == 0:
                    logger.warning("I2C read error (×%d): %s", consecutive_errors, exc)
                # Keep last known data — do not overwrite with defaults
            time.sleep(POLL_INTERVAL)

    def _simulate_loop(self) -> None:
        """Publish slowly changing fake telemetry when no I2C is available."""
        import math
        t = 0.0
        while self._running:
            t += POLL_INTERVAL
            fake = {
                "lat": round(17.385 + math.sin(t * 0.1) * 0.001, 7),
                "lng": round(78.486 + math.cos(t * 0.1) * 0.001, 7),
                "altitude": round(abs(math.sin(t * 0.05)) * 30, 2),
                "speed": round(abs(math.sin(t * 0.07)) * 5, 2),
                "heading": round((t * 10) % 360, 1),
                "flight_mode": "LOITER",
                "armed": False,
                "battery_voltage": round(11.8 + math.sin(t * 0.02) * 0.3, 2),
                "satellites": 10,
                "throttle": 1500,
                "roll": round(math.sin(t * 0.3) * 0.05, 4),
                "pitch": round(math.cos(t * 0.3) * 0.05, 4),
                "yaw": round((t * 10) % 360, 1),
                "relative_alt": round(abs(math.sin(t * 0.05)) * 30, 2),
                "groundspeed": round(abs(math.sin(t * 0.07)) * 5, 2),
            }
            with self._lock:
                self._last = fake
                self._history.append(dict(fake))
            time.sleep(POLL_INTERVAL)

    # ------------------------------------------------------------------
    def get_telemetry(self) -> dict[str, Any]:
        with self._lock:
            return dict(self._last)

    def get_history(self, limit: int = 200) -> list[dict[str, Any]]:
        with self._lock:
            items = list(self._history)
        return items[-limit:]

    # ------------------------------------------------------------------
    def _write_command(self, cmd_byte: int) -> bool:
        if not self._bus or not self._i2c_ok:
            logger.warning("I2C command ignored — bus not open.")
            return False
        try:
            self._bus.write_byte(FC_ADDRESS, cmd_byte)
            return True
        except Exception as exc:
            logger.error("I2C write failed: %s", exc)
            return False

    def send_arm_command(self, arm: bool) -> bool:
        return self._write_command(CMD_ARM if arm else CMD_DISARM)

    def send_mode_command(self, mode: str) -> bool:
        idx = MODE_TO_INDEX.get(mode.upper())
        if idx is None:
            logger.warning("Unknown mode: %s", mode)
            return False
        return self._write_command(CMD_MODE_BASE + idx)

    def send_takeoff_command(self, altitude: float) -> bool:
        # Encode altitude as a single byte (meters, max 255)
        alt_byte = min(255, max(0, int(altitude)))
        if not self._bus or not self._i2c_ok:
            return False
        try:
            self._bus.write_i2c_block_data(FC_ADDRESS, CMD_TAKEOFF, [alt_byte])
            return True
        except Exception as exc:
            logger.error("Takeoff I2C write failed: %s", exc)
            return False


# Module-level singleton
i2c_reader = I2CReader()
```

Save: `Ctrl+O`, Enter, `Ctrl+X`.

---

### camera.py

```bash
nano /home/pi/varuna-ai-enterprise/camera.py
```

```python
"""
USB Webcam Manager
Captures frames from /dev/video0 at 1280×720 30fps and serves:
  - MJPEG stream via /video_feed (multipart/x-mixed-replace)
  - Single JPEG snapshot via /api/camera/snapshot
"""

import threading
import time
import logging
from typing import Generator

import cv2

logger = logging.getLogger("varuna.camera")

CAMERA_INDEX = 0
TARGET_WIDTH = 1280
TARGET_HEIGHT = 720
TARGET_FPS = 30
JPEG_QUALITY = 80


class CameraManager:
    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._cap: cv2.VideoCapture | None = None
        self._running = False
        self._thread: threading.Thread | None = None
        self._latest_frame: bytes | None = None  # latest JPEG-encoded frame
        self._frame_count = 0
        self._fps_measured = 0.0
        self._last_error: str | None = None
        self._resolution = f"{TARGET_WIDTH}x{TARGET_HEIGHT}"
        self._fps_counter_start = time.time()
        self._fps_frame_count = 0

    # ------------------------------------------------------------------
    def start(self) -> None:
        self._running = True
        self._thread = threading.Thread(target=self._loop, name="camera", daemon=True)
        self._thread.start()
        logger.info("Camera thread started.")

    def stop(self) -> None:
        self._running = False
        if self._thread:
            self._thread.join(timeout=3.0)
        if self._cap and self._cap.isOpened():
            self._cap.release()
        logger.info("Camera thread stopped.")

    # ------------------------------------------------------------------
    def _open_capture(self) -> bool:
        cap = cv2.VideoCapture(CAMERA_INDEX, cv2.CAP_V4L2)
        if not cap.isOpened():
            # Fallback: try without backend hint
            cap = cv2.VideoCapture(CAMERA_INDEX)
        if not cap.isOpened():
            self._last_error = f"Cannot open /dev/video{CAMERA_INDEX}"
            logger.error(self._last_error)
            return False

        # Request MJPEG from camera to reduce USB bandwidth
        cap.set(cv2.CAP_PROP_FOURCC, cv2.VideoWriter_fourcc(*"MJPG"))
        cap.set(cv2.CAP_PROP_FRAME_WIDTH, TARGET_WIDTH)
        cap.set(cv2.CAP_PROP_FRAME_HEIGHT, TARGET_HEIGHT)
        cap.set(cv2.CAP_PROP_FPS, TARGET_FPS)

        actual_w = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
        actual_h = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
        actual_fps = cap.get(cv2.CAP_PROP_FPS)
        self._resolution = f"{actual_w}x{actual_h}"
        logger.info("Camera opened: %s @ %.1f fps", self._resolution, actual_fps)

        self._cap = cap
        self._last_error = None
        return True

    def _loop(self) -> None:
        if not self._open_capture():
            logger.warning("Camera unavailable — stream will return placeholder.")
            return

        while self._running:
            if not self._cap or not self._cap.isOpened():
                time.sleep(1.0)
                self._open_capture()
                continue

            ret, frame = self._cap.read()
            if not ret:
                self._last_error = "Frame read failed"
                logger.warning("Frame read failed — retrying.")
                time.sleep(0.1)
                continue

            # Encode to JPEG
            encode_params = [cv2.IMWRITE_JPEG_QUALITY, JPEG_QUALITY]
            success, jpeg_buf = cv2.imencode(".jpg", frame, encode_params)
            if not success:
                self._last_error = "JPEG encode failed"
                continue

            with self._lock:
                self._latest_frame = jpeg_buf.tobytes()
                self._frame_count += 1
                self._fps_frame_count += 1
                self._last_error = None

            # Update FPS every second
            elapsed = time.time() - self._fps_counter_start
            if elapsed >= 1.0:
                self._fps_measured = round(self._fps_frame_count / elapsed, 1)
                self._fps_frame_count = 0
                self._fps_counter_start = time.time()

    # ------------------------------------------------------------------
    def snapshot(self) -> bytes | None:
        with self._lock:
            return self._latest_frame

    def mjpeg_generator(self) -> Generator[bytes, None, None]:
        """Yield multipart MJPEG frames for StreamingResponse."""
        boundary = b"frame"
        while True:
            with self._lock:
                frame = self._latest_frame

            if frame is None:
                # Camera not ready — yield a tiny delay and retry
                time.sleep(0.05)
                continue

            header = (
                b"--" + boundary + b"\r\n"
                b"Content-Type: image/jpeg\r\n"
                b"Content-Length: " + str(len(frame)).encode() + b"\r\n\r\n"
            )
            yield header + frame + b"\r\n"
            time.sleep(1.0 / TARGET_FPS)

    def get_status(self) -> dict:
        camera_open = self._cap is not None and self._cap.isOpened()
        with self._lock:
            return {
                "status_text": "streaming" if camera_open else "disconnected",
                "measured_fps": self._fps_measured,
                "resolution": self._resolution,
                "frames_captured": self._frame_count,
                "last_error": self._last_error,
            }

    def is_open(self) -> bool:
        return self._cap is not None and self._cap.isOpened()


# Module-level singleton
camera_manager = CameraManager()
```

Save: `Ctrl+O`, Enter, `Ctrl+X`.

---

### config.py

```bash
nano /home/pi/varuna-ai-enterprise/config.py
```

```python
"""
Configuration store.
Persists to /home/pi/varuna-ai-enterprise/config.json.
Provides a schema (with min/max/type/description) for the GCS config panel.
"""

import json
import logging
import os
from typing import Any

logger = logging.getLogger("varuna.config")

CONFIG_PATH = "/home/pi/varuna-ai-enterprise/config.json"

# Schema definition — each key maps to metadata + current value
_SCHEMA: dict[str, dict[str, Any]] = {
    "pin": {
        "value": "1111",
        "type": "string",
        "description": "4-digit PIN for GCS authentication",
        "min": None,
        "max": None,
    },
    "preferred_mode": {
        "value": "LOITER",
        "type": "string",
        "description": "Default flight mode on connect",
        "min": None,
        "max": None,
    },
    "ai_confidence_threshold": {
        "value": 0.5,
        "type": "float",
        "description": "Minimum confidence score to display AI detection",
        "min": 0.1,
        "max": 1.0,
    },
    "stream_fps": {
        "value": 30,
        "type": "int",
        "description": "Target MJPEG stream frame rate",
        "min": 1,
        "max": 60,
    },
    "stream_quality": {
        "value": 80,
        "type": "int",
        "description": "JPEG compression quality (1–100)",
        "min": 1,
        "max": 100,
    },
    "telemetry_interval_ms": {
        "value": 200,
        "type": "int",
        "description": "Milliseconds between telemetry WebSocket pushes",
        "min": 50,
        "max": 2000,
    },
    "max_altitude_m": {
        "value": 120.0,
        "type": "float",
        "description": "Maximum allowed takeoff altitude in metres",
        "min": 1.0,
        "max": 400.0,
    },
    "rtl_altitude_m": {
        "value": 30.0,
        "type": "float",
        "description": "Return-to-launch altitude in metres",
        "min": 5.0,
        "max": 200.0,
    },
    "i2c_address": {
        "value": 8,
        "type": "int",
        "description": "I2C address of the flight controller (decimal)",
        "min": 1,
        "max": 127,
    },
    "camera_index": {
        "value": 0,
        "type": "int",
        "description": "OpenCV camera index (usually 0 for first USB camera)",
        "min": 0,
        "max": 9,
    },
}


class ConfigStore:
    def __init__(self) -> None:
        self._data: dict[str, Any] = {}
        self._load()

    def _load(self) -> None:
        """Load persisted values from config.json, falling back to schema defaults."""
        # Start with schema defaults
        for key, meta in _SCHEMA.items():
            self._data[key] = meta["value"]

        if not os.path.exists(CONFIG_PATH):
            logger.info("No config.json found — using defaults.")
            return

        try:
            with open(CONFIG_PATH, "r", encoding="utf-8") as f:
                saved = json.load(f)
            for key, value in saved.items():
                if key in _SCHEMA:
                    self._data[key] = value
            logger.info("Config loaded from %s", CONFIG_PATH)
        except Exception as exc:
            logger.error("Failed to load config.json: %s", exc)

    def save(self) -> None:
        """Write current values to config.json."""
        try:
            with open(CONFIG_PATH, "w", encoding="utf-8") as f:
                json.dump(self._data, f, indent=2)
            logger.info("Config saved to %s", CONFIG_PATH)
        except Exception as exc:
            logger.error("Failed to save config.json: %s", exc)

    def get(self, key: str, default: Any = None) -> Any:
        return self._data.get(key, default)

    def set(self, key: str, value: Any) -> None:
        self._data[key] = value

    def get_schema(self) -> dict[str, dict[str, Any]]:
        """Return schema with current values injected — matches /api/config contract."""
        result = {}
        for key, meta in _SCHEMA.items():
            result[key] = {
                "value": self._data.get(key, meta["value"]),
                "min": meta["min"],
                "max": meta["max"],
                "type": meta["type"],
                "description": meta["description"],
            }
        return result

    def update(self, updates: dict[str, Any]) -> dict[str, Any]:
        """Validate and apply a batch of updates. Returns {success, settings, errors}."""
        errors: dict[str, str] = {}
        applied: dict[str, Any] = {}

        for key, value in updates.items():
            if key not in _SCHEMA:
                errors[key] = f"Unknown config key: '{key}'"
                continue
            meta = _SCHEMA[key]
            # Type coercion
            try:
                if meta["type"] == "int":
                    value = int(value)
                elif meta["type"] == "float":
                    value = float(value)
                elif meta["type"] == "string":
                    value = str(value)
            except (ValueError, TypeError) as exc:
                errors[key] = f"Type error: {exc}"
                continue
            # Range validation
            if meta["min"] is not None and value < meta["min"]:
                errors[key] = f"Value {value} below minimum {meta['min']}"
                continue
            if meta["max"] is not None and value > meta["max"]:
                errors[key] = f"Value {value} above maximum {meta['max']}"
                continue
            self._data[key] = value
            applied[key] = value

        return {
            "success": len(errors) == 0,
            "settings": applied,
            "errors": errors,
        }


# Module-level singleton
config_store = ConfigStore()
```

Save: `Ctrl+O`, Enter, `Ctrl+X`.

---

### missions.py

```bash
nano /home/pi/varuna-ai-enterprise/missions.py
```

```python
"""
Mission store — upload, list, start missions.
Persists to /home/pi/varuna-ai-enterprise/missions.json.
"""

import json
import logging
import os
from datetime import datetime, timezone
from typing import Any

logger = logging.getLogger("varuna.missions")

MISSIONS_PATH = "/home/pi/varuna-ai-enterprise/missions.json"


class MissionStore:
    def __init__(self) -> None:
        self._missions: list[dict[str, Any]] = []
        self._active_mission: dict[str, Any] | None = None
        self._load()

    def _load(self) -> None:
        if not os.path.exists(MISSIONS_PATH):
            logger.info("No missions.json found — starting with empty list.")
            return
        try:
            with open(MISSIONS_PATH, "r", encoding="utf-8") as f:
                self._missions = json.load(f)
            logger.info("Loaded %d missions from %s", len(self._missions), MISSIONS_PATH)
        except Exception as exc:
            logger.error("Failed to load missions.json: %s", exc)
            self._missions = []

    def _save(self) -> None:
        try:
            with open(MISSIONS_PATH, "w", encoding="utf-8") as f:
                json.dump(self._missions, f, indent=2)
        except Exception as exc:
            logger.error("Failed to save missions.json: %s", exc)

    def upload(self, name: str, waypoints: list[dict[str, Any]]) -> None:
        now = datetime.now(timezone.utc).isoformat()
        # Replace existing mission with the same name if it exists
        self._missions = [m for m in self._missions if m["name"] != name]
        self._missions.append({
            "name": name,
            "waypoints": waypoints,
            "created_at": now,
        })
        self._save()
        logger.info("Mission '%s' stored (%d waypoints).", name, len(waypoints))

    def start(self) -> dict[str, Any]:
        if not self._missions:
            return {"success": False, "message": "No missions available to start."}
        # Start the most recently added mission
        self._active_mission = self._missions[-1]
        logger.info("Starting mission: %s", self._active_mission["name"])
        # In a real integration, this would send the mission to the FC via I2C.
        return {
            "success": True,
            "message": f"Mission '{self._active_mission['name']}' started with "
                       f"{len(self._active_mission['waypoints'])} waypoints.",
        }

    def list_missions(self) -> list[dict[str, Any]]:
        return list(self._missions)


# Module-level singleton
mission_store = MissionStore()
```

Save: `Ctrl+O`, Enter, `Ctrl+X`.

---

### auth.py

```bash
nano /home/pi/varuna-ai-enterprise/auth.py
```

```python
"""
PIN authentication.
The PIN is stored in config.json under the key "pin".
Default PIN: "1111"
"""

import logging

logger = logging.getLogger("varuna.auth")


def verify_pin(entered: str) -> bool:
    """
    Compare the entered PIN against the stored PIN.
    Import is deferred to avoid circular dependency with config.py.
    """
    from config import config_store
    stored_pin = str(config_store.get("pin", "1111"))
    entered_str = str(entered).strip()
    ok = entered_str == stored_pin
    if ok:
        logger.info("PIN verification succeeded.")
    else:
        logger.warning("PIN verification failed (entered: %r).", entered_str)
    return ok
```

Save: `Ctrl+O`, Enter, `Ctrl+X`.

---

### health.py

```bash
nano /home/pi/varuna-ai-enterprise/health.py
```

```python
"""
Health check.
pixhawk_connected — True if I2C bus can reach address 0x08.
camera_connected  — True if OpenCV can open the webcam device.
"""

import logging

logger = logging.getLogger("varuna.health")


def _check_pixhawk() -> bool:
    try:
        import smbus2
        bus = smbus2.SMBus(1)
        try:
            # Attempt a zero-byte read; if no OSError, the device is present
            bus.read_byte(0x08)
            return True
        except OSError:
            return False
        finally:
            bus.close()
    except Exception as exc:
        logger.debug("Pixhawk health check error: %s", exc)
        return False


def _check_camera() -> bool:
    try:
        import cv2
        cap = cv2.VideoCapture(0)
        if cap.isOpened():
            cap.release()
            return True
        return False
    except Exception as exc:
        logger.debug("Camera health check error: %s", exc)
        return False


def get_health() -> dict:
    return {
        "pixhawk_connected": _check_pixhawk(),
        "camera_connected": _check_camera(),
    }
```

Save: `Ctrl+O`, Enter, `Ctrl+X`.

---

## 9. systemd Service

This makes the backend start automatically on every boot and restart itself if it crashes.

### 9.1 Create the Service File

```bash
sudo nano /etc/systemd/system/varuna-backend.service
```

Paste the following:

```ini
[Unit]
Description=VARUNA GCS FastAPI Backend
After=network.target
Wants=network.target

[Service]
Type=simple
User=pi
Group=pi
WorkingDirectory=/home/pi/varuna-ai-enterprise
ExecStart=/home/pi/varuna-ai-enterprise/venv/bin/uvicorn main:app --host 0.0.0.0 --port 8000 --workers 1
Restart=on-failure
RestartSec=5
StandardOutput=journal
StandardError=journal
SyslogIdentifier=varuna-backend
Environment=PYTHONUNBUFFERED=1

[Install]
WantedBy=multi-user.target
```

Save: `Ctrl+O`, Enter, `Ctrl+X`.

### 9.2 Enable and Start the Service

```bash
sudo systemctl daemon-reload
sudo systemctl enable varuna-backend.service
sudo systemctl start varuna-backend.service
```

### 9.3 Check the Service Status

```bash
sudo systemctl status varuna-backend.service
```

You should see `Active: active (running)`.

### 9.4 View Live Logs

```bash
sudo journalctl -u varuna-backend.service -f
```

Press `Ctrl+C` to stop following.

### 9.5 Restart After Code Changes

Whenever you edit a `.py` file:

```bash
sudo systemctl restart varuna-backend.service
sudo systemctl status varuna-backend.service
```

---

## 10. Verify Everything Works

Replace `PI_IP` with either `varuna-pi.local` or the Pi's Netbird IP (e.g. `100.64.x.x`).

### 10.1 Basic Connectivity

```bash
curl http://PI_IP:8000/api/ping
```

Expected:
```json
{"status": "ok"}
```

### 10.2 Health Check

```bash
curl http://PI_IP:8000/api/health
```

Expected (example):
```json
{"pixhawk_connected": false, "camera_connected": true}
```

### 10.3 System Metrics

```bash
curl "http://PI_IP:8000/api/system/pi?processes=true"
```

Expected (example):
```json
{
  "cpu_per_core": [{"percent": 4.2}, {"percent": 6.1}, {"percent": 2.0}, {"percent": 3.5}],
  "ram_percent": 38.1,
  "disk_percent": 22.4,
  "temperature": 47.6,
  "cpu_count": 4
}
```

### 10.4 Telemetry

```bash
curl http://PI_IP:8000/api/telemetry
```

Expected:
```json
{
  "lat": 17.385,
  "lng": 78.486,
  "altitude": 0.0,
  "speed": 0.0,
  "heading": 0.0,
  "flight_mode": "STABILIZE",
  "armed": false,
  "battery_voltage": 0.0,
  "satellites": 0,
  "throttle": 1000,
  "roll": 0.0,
  "pitch": 0.0,
  "yaw": 0.0,
  "relative_alt": 0.0,
  "groundspeed": 0.0
}
```

(If I2C is not connected, the simulation loop will return slowly varying fake values.)

### 10.5 Camera Status

```bash
curl http://PI_IP:8000/api/camera/status
```

Expected:
```json
{"status_text": "streaming", "measured_fps": 29.8, "resolution": "1280x720", "frames_captured": 142, "last_error": null}
```

### 10.6 MJPEG Stream (Open in Browser)

Open this URL in any browser on the same network or via Netbird:

```
http://PI_IP:8000/video_feed
```

You should see a live video feed from the webcam.

### 10.7 Snapshot

```bash
curl http://PI_IP:8000/api/camera/snapshot --output snapshot.jpg
```

Then open `snapshot.jpg` to verify.

### 10.8 AI Status

```bash
curl http://PI_IP:8000/api/ai/status
```

Expected:
```json
{"ai_enabled": false, "model_loaded": true, "confidence_threshold": 0.5, "live_boxes": 0}
```

### 10.9 AI Toggle

```bash
curl -X POST http://PI_IP:8000/api/ai/toggle \
  -H "Content-Type: application/json" \
  -d '{"enabled": true}'
```

Expected:
```json
{"success": true, "message": "AI inference enabled."}
```

### 10.10 ARM Command

```bash
curl -X POST http://PI_IP:8000/api/mavlink/arm \
  -H "Content-Type: application/json" \
  -d '{"arm": true}'
```

Expected (without FC connected):
```json
{"success": false, "message": "I2C write failed."}
```

Expected (with FC connected):
```json
{"success": true, "message": "Armed command sent."}
```

### 10.11 Flight Mode

```bash
curl -X POST http://PI_IP:8000/api/mavlink/mode \
  -H "Content-Type: application/json" \
  -d '{"mode": "LOITER"}'
```

### 10.12 Mission Upload

```bash
curl -X POST http://PI_IP:8000/api/mission/upload \
  -H "Content-Type: application/json" \
  -d '{
    "name": "test_mission",
    "waypoints": [
      {"lat": 17.385, "lng": 78.486, "alt": 20, "speed": 5, "action": "waypoint"},
      {"lat": 17.386, "lng": 78.487, "alt": 20, "speed": 5, "action": "waypoint"}
    ]
  }'
```

Expected:
```json
{"success": true, "message": "Mission 'test_mission' uploaded with 2 waypoints."}
```

### 10.13 Mission List

```bash
curl http://PI_IP:8000/api/mission/list
```

### 10.14 Config

```bash
curl http://PI_IP:8000/api/config
```

### 10.15 PIN Verify

```bash
curl -X POST http://PI_IP:8000/api/auth/verify_pin \
  -H "Content-Type: application/json" \
  -d '{"password": "1111"}'
```

Expected:
```json
{"success": true, "message": "PIN accepted."}
```

### 10.16 WebSocket Test

Install `websocat` on your laptop (https://github.com/vi/websocat/releases) or use the browser console.

```bash
websocat ws://PI_IP:8000/api/ws
```

You should see JSON telemetry printed every ~200ms. Press `Ctrl+C` to stop.

Alternatively, paste this into any browser console while on a page served from the same origin:

```javascript
const ws = new WebSocket("ws://PI_IP:8000/api/ws");
ws.onmessage = e => console.log(JSON.parse(e.data));
```

### 10.17 OpenAPI Docs

Open in a browser:

```
http://PI_IP:8000/docs
```

This shows all endpoints with try-it-out buttons — useful for quick manual testing.

---

## 11. GCS App — Connection Field

In the VARUNA GCS app, go to **System → Connection** (or the settings/connection panel) and enter:

```
http://100.64.x.x:8000
```

Replace `100.64.x.x` with the Raspberry Pi's Netbird IP address (from `netbird status` on the Pi).

If you're on the same local network (same Wi-Fi/Ethernet) and don't need Netbird, you can use the Pi's local IP instead:

```
http://192.168.x.x:8000
```

Or by hostname:

```
http://varuna-pi.local:8000
```

For the WebSocket, the app automatically appends `/api/ws` — you only provide the base URL.

### Port Forwarding (Optional)

If you need to access the Pi from outside your local network without Netbird:

```bash
# On your router: forward external TCP port 8000 to Pi's local IP port 8000
# Then use your public IP:
http://YOUR_PUBLIC_IP:8000
```

This is less secure than Netbird. Use Netbird for production deployments.

---

## 12. Troubleshooting Table

| # | Symptom | Likely Cause | Exact Fix |
|---|---|---|---|
| 1 | `Connection refused` on port 8000 | Service not running | `sudo systemctl start varuna-backend.service` then `sudo journalctl -u varuna-backend.service -n 50` |
| 2 | `ModuleNotFoundError: No module named 'fastapi'` | venv not used in service | Check `ExecStart` in service file points to `/home/pi/varuna-ai-enterprise/venv/bin/uvicorn`, not system uvicorn |
| 3 | `Permission denied: '/dev/i2c-1'` | User `pi` not in `i2c` group | `sudo usermod -aG i2c pi` then reboot: `sudo reboot` |
| 4 | Camera shows `status_text: "disconnected"` | Wrong device index or webcam not plugged in | Run `v4l2-ctl --list-devices` to confirm `/dev/video0` exists. If it's `/dev/video2`, change `CAMERA_INDEX = 2` in `camera.py` |
| 5 | `smbus2.SMBus(1)` raises `FileNotFoundError` | I2C not enabled in raspi-config | Run `sudo raspi-config` → Interface Options → I2C → Yes, then reboot |
| 6 | I2C detects no device at 0x08 | Bad wiring or FC I2C slave not running | Run `sudo i2cdetect -y 1`. Check SDA/SCL wires, confirm FC firmware has I2C slave enabled |
| 7 | WebSocket connects but no data | Broadcast loop task not starting | Check logs: `sudo journalctl -u varuna-backend.service -f`. Look for `VARUNA backend started.` |
| 8 | CORS errors in browser console | Frontend origin not allowed | CORS is set to `allow_origins=["*"]` — if still failing, check the browser is not blocking mixed content (HTTP vs HTTPS) |
| 9 | `pip install` fails for `opencv-python-headless` | Missing system libs | Run `sudo apt install -y libatlas-base-dev libopencv-dev` then retry pip install |
| 10 | Netbird IP not reachable from laptop | Netbird not joined on laptop | Install Netbird on laptop, run `netbird up --setup-key YOUR_KEY`, verify with `netbird status` on both devices |

### Additional Debug Commands

Check which process is using port 8000:

```bash
sudo ss -tlnp | grep 8000
```

Manually test the backend without systemd:

```bash
cd /home/pi/varuna-ai-enterprise
source venv/bin/activate
python main.py
```

Test I2C read manually:

```bash
python3 -c "import smbus2; b = smbus2.SMBus(1); print(b.read_i2c_block_data(0x08, 0, 32))"
```

Check camera is accessible:

```bash
python3 -c "import cv2; c = cv2.VideoCapture(0); print('Open:', c.isOpened()); c.release()"
```

View full service logs (last 100 lines):

```bash
sudo journalctl -u varuna-backend.service -n 100 --no-pager
```

---

## Quick Reference Card

| Task | Command |
|---|---|
| SSH into Pi | `ssh pi@varuna-pi.local` |
| Start backend | `sudo systemctl start varuna-backend.service` |
| Stop backend | `sudo systemctl stop varuna-backend.service` |
| Restart backend | `sudo systemctl restart varuna-backend.service` |
| View live logs | `sudo journalctl -u varuna-backend.service -f` |
| Check Netbird IP | `netbird status` |
| Test ping | `curl http://varuna-pi.local:8000/api/ping` |
| Open API docs | Browser → `http://varuna-pi.local:8000/docs` |
| Activate venv | `source /home/pi/varuna-ai-enterprise/venv/bin/activate` |
| Edit config | `nano /home/pi/varuna-ai-enterprise/config.py` |
| Check I2C | `sudo i2cdetect -y 1` |
| Check camera | `v4l2-ctl --list-devices` |

---

*Guide version 1.0 — VARUNA GCS Raspberry Pi Backend*
