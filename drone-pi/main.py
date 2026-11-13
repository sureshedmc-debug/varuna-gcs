"""
VARUNA drone backend — runs on the drone's Raspberry Pi.

Serves everything the VARUNA app expects from the drone:
  * live telemetry (/api/telemetry, WebSocket /api/ws) from the Pixhawk (ArduCopter)
  * flight commands: arm/disarm, take-off, RTL, land, mode, emergency stop
  * missions from the Missions tab, uploaded to the Pixhawk and flown in AUTO
  * the camera at 1280x720 as H.264 (/api/camera/h264, camera module) and
    MJPEG (/video_feed), plus snapshots
  * keyboard flight from the app's Control tab (WebSocket /api/control, see control.py)
  * Pi health, live tuning, MAVLink link preference (USB / TELEM2), PIN check
  * optionally the built VARUNA web app itself (web_root)

Every mutating call answers HTTP 200 with {"success": bool, "message": str}.

Run on the Pi:      python main.py
Test on a laptop:   python main.py --connection tcp:127.0.0.1:5760 --camera test
On the laptop, with the phone on the drone (phone-link/README.md):
                    python main.py --connection udpout:<phone NetBird IP>:14551 \
                                   --camera-url http://<phone NetBird IP>:8080/video
"""

import argparse
import asyncio
import json
import logging
import os
import socket
import struct
import time
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Optional, Union

from fastapi import FastAPI, Query, Request, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse, Response, StreamingResponse
from pydantic import BaseModel, Field

from camera import CameraManager
from config import DATA_DIR, HERE, ConfigStore
from control import KeyboardControl
from mav_link import DroneLink, LinkError
from mission import ACTIVE, MissionManager
from system_info import pi_metrics

log = logging.getLogger("drone")
VERSION = "1.0.0"
STARTED = time.time()

cfg = ConfigStore()
# Command-line overrides (set by main() below) win over the config file.
for _key, _env in (("mav_connection", "DRONE_CLI_CONNECTION"), ("camera_source", "DRONE_CLI_CAMERA"),
                   ("camera_url", "DRONE_CLI_CAMERA_URL"), ("http_port", "DRONE_CLI_PORT")):
    if os.environ.get(_env):
        cfg.set_runtime(_key, os.environ[_env])

link = DroneLink(cfg)
camera = CameraManager(cfg)
missions = MissionManager(link, cfg, DATA_DIR)
keyboard = KeyboardControl(link, cfg)
operator = {"last": time.time(), "ws": 0, "acted": False}
ai_state = {"ai_enabled": False, "detections": []}


# ---------------------------------------------------------------------------- models
class ArmRequest(BaseModel):
    arm: Optional[bool] = None


class ModeRequest(BaseModel):
    mode: str


class TakeoffRequest(BaseModel):
    altitude: Optional[float] = None


class Waypoint(BaseModel):
    id: Optional[Union[int, str]] = None
    lat: float
    lng: float
    alt: Optional[float] = None
    speed: Optional[float] = Field(default=None, ge=0, le=100)   # km/h, as the app sends it
    action: Optional[str] = "waypoint"


class MissionUploadRequest(BaseModel):
    name: str = "Mission"
    waypoints: list[Waypoint]


class PreferRequest(BaseModel):
    mode: str


class AIToggleRequest(BaseModel):
    enabled: bool


class AIReportRequest(BaseModel):
    debrisType: str = "trash"
    lat: Optional[float] = None
    lng: Optional[float] = None
    confidence: Optional[float] = None


class PinRequest(BaseModel):
    password: str = ""


# ---------------------------------------------------------------------------- helpers
def ok(message, **extra):
    return {"success": True, "message": message, **extra}


def fail(message, **extra):
    return {"success": False, "message": message, **extra}


def run(fn, success_message=None):
    """Run a link/mission action and turn a LinkError into {success: false}."""
    try:
        result = fn()
        return ok(success_message or (result if isinstance(result, str) else "Done."))
    except LinkError as exc:
        return fail(str(exc))
    except Exception as exc:  # never let a 500 reach the operator
        log.exception("Command failed")
        return fail(f"Unexpected error: {exc}")


def telemetry():
    s = link.snapshot()
    m = missions.status()
    home = None if s["home_lat"] is None else {"lat": s["home_lat"], "lng": s["home_lng"]}
    return {
        "vehicle": "drone",
        "lat": s["lat"],
        "lng": s["lng"],
        "altitude": round(s["relative_alt"] or 0.0, 2),
        "relative_alt": round(s["relative_alt"] or 0.0, 2),
        "alt_msl": None if s["alt_msl"] is None else round(s["alt_msl"], 1),
        "speed": round(s["groundspeed"] or 0.0, 2),
        "groundspeed": round(s["groundspeed"] or 0.0, 2),
        "climb": round(s["climb"] or 0.0, 2),
        "heading": None if s["heading"] is None else round(s["heading"], 1),
        "flight_mode": s["flight_mode"],
        "mode": s["flight_mode"],
        "armed": s["armed"],
        "landed_state": s["landed_state"],
        "battery_voltage": None if s["battery_voltage"] is None else round(s["battery_voltage"], 2),
        "battery_current": s["battery_current"],
        "battery_remaining": s["battery_percent"],
        "battery_percent": s["battery_percent"],
        "satellites": s["satellites"],
        "gps_fix": s["gps_fix"],
        "hdop": s["hdop"],
        "throttle": s["throttle"],
        "roll": s["roll"],
        "pitch": s["pitch"],
        "yaw": s["yaw"],
        "home_lat": s["home_lat"],
        "home_lng": s["home_lng"],
        "home": home,
        "fc_connected": s["fc_connected"],
        "link": s["link"],
        "link_error": s["link_error"],
        "messages": s["messages"],
        "mission": m,
        "camera": {"connected": bool(camera.connected), "fps": camera.measured_fps()},
        "keyboard": keyboard.status(),
        "t": round(time.time(), 2),
    }


def web_root():
    configured = (cfg["web_root"] or "").strip()
    root = Path(configured) if configured else HERE / "web"
    return root if (root / "index.html").is_file() else None


# ---------------------------------------------------------------------------- lifecycle
ws_clients = set()


async def broadcast_loop():
    while True:
        if ws_clients:
            data = telemetry()
            dead = []
            for ws in list(ws_clients):
                try:
                    await ws.send_json(data)
                except Exception:
                    dead.append(ws)
            for ws in dead:
                ws_clients.discard(ws)
        await asyncio.sleep(0.2)


async def operator_watchdog():
    """If the app goes silent during a mission (link lost), optionally RTL or land."""
    while True:
        await asyncio.sleep(2)
        action = cfg["operator_lost_action"]
        if action == "none" or operator["ws"] > 0:
            operator["acted"] = False
            continue
        quiet = time.time() - operator["last"]
        if quiet < cfg["operator_lost_s"] or operator["acted"]:
            continue
        snap = link.snapshot()
        if missions.status()["state"] in ACTIVE and snap["armed"]:
            operator["acted"] = True
            mode = "RTL" if action == "rtl" else "LAND"
            log.warning("No contact from the VARUNA app for %.0f s — switching to %s", quiet, mode)
            try:
                await asyncio.to_thread(link.set_mode, mode)
            except LinkError as exc:
                log.error("Operator-lost failsafe failed: %s", exc)


@asynccontextmanager
async def lifespan(app):
    link.start()
    camera.start()
    keyboard.start()
    tasks = [asyncio.create_task(broadcast_loop()), asyncio.create_task(operator_watchdog())]
    log.info("VARUNA drone backend %s ready on port %s", VERSION, cfg["http_port"])
    yield
    for t in tasks:
        t.cancel()
    keyboard.stop()
    camera.stop()
    link.stop()


app = FastAPI(title="VARUNA Drone Backend", version=VERSION, lifespan=lifespan)
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])


@app.middleware("http")
async def note_operator(request: Request, call_next):
    if request.url.path.startswith("/api/"):
        operator["last"] = time.time()
    return await call_next(request)


# ---------------------------------------------------------------------------- health
@app.get("/api/ping")
def ping():
    return {"status": "ok", "vehicle": "drone"}


@app.get("/api/health")
def health():
    s = link.snapshot()
    return {
        "status": "ok", "vehicle": "drone", "version": VERSION,
        "pixhawk_connected": s["fc_connected"], "camera_connected": bool(camera.connected),
        "link": s["link"], "link_error": s["link_error"],
        "gps_fix": s["gps_fix"], "satellites": s["satellites"],
        "uptime_s": round(time.time() - STARTED),
    }


@app.get("/api/system/status")
def system_status():
    return {"status": "ok", "vehicle": "drone", "version": VERSION, "uptime_s": round(time.time() - STARTED)}


@app.get("/api/system/pi")
def system_pi(processes: bool = Query(default=False)):
    return pi_metrics(processes)


# ---------------------------------------------------------------------------- camera
@app.get("/api/camera/status")
def camera_status():
    return camera.get_status()


@app.get("/api/camera/snapshot")
def camera_snapshot():
    jpeg = camera.snapshot()
    if jpeg is None:
        return Response(content=b"", media_type="image/jpeg", status_code=503,
                        headers={"Cache-Control": "no-store"})
    return Response(content=jpeg, media_type="image/jpeg", headers={"Cache-Control": "no-store"})


def mjpeg_frames():
    """Multipart MJPEG for <img src="/video_feed">, at up to stream_fps."""
    # With H.264 the JPEGs are decoded from it while someone watches; the one
    # left from earlier would be old.
    seq = camera.frame_seq if camera.codec == "h264" else 0
    last_sent = 0.0
    last_frame = time.time()
    while True:
        camera.touch()
        camera.want_jpeg()
        seq, jpeg = camera.wait_frame(seq, timeout=2.0)
        if jpeg is None:
            # No pictures (camera unplugged / missing): end the stream so the app
            # retries. Without this the loop never yields, never notices that the
            # viewer left, and keeps a server worker thread forever. After enough
            # retries every worker is stuck and even flight commands stop answering.
            if time.time() - last_frame > 15:
                return
            continue
        last_frame = time.time()
        min_gap = 1.0 / max(1, int(cfg["stream_fps"]))
        now = time.time()
        if now - last_sent < min_gap * 0.9:
            continue
        last_sent = now
        yield (b"--frame\r\nContent-Type: image/jpeg\r\nContent-Length: " + str(len(jpeg)).encode()
               + b"\r\n\r\n" + jpeg + b"\r\n")


@app.get("/video_feed")
def video_feed():
    camera.touch()
    return StreamingResponse(mjpeg_frames(), media_type="multipart/x-mixed-replace; boundary=frame",
                             headers={"Cache-Control": "no-cache, no-store", "X-Accel-Buffering": "no"})


# One record per frame: payload length (u32), flags (u8: 1 = keyframe, 2 = pose
# included), capture time (u64, µs since 1970), then the payload: with a pose, its
# JSON length (u16) and the JSON first; then the frame as Annex-B H.264 (SPS/PPS
# before each keyframe).
H264_RECORD = struct.Struct(">IBQ")
POSE_LEN = struct.Struct(">H")


def _frame_pose(ts_us):
    """The drone's pose when a frame was taken, as JSON, if the Pixhawk is there."""
    if not link.fc_connected:
        return b""
    pose = link.pose_at(ts_us / 1e6)
    if pose["lat"] is None and pose["hdg"] is None:
        return b""
    return json.dumps(pose, separators=(",", ":")).encode()


def h264_frames(with_pose=False):
    """The camera module's H.264 frames for the app's WebCodecs player, from the
    latest keyframe on. A viewer that falls behind (slow link) or misses frames
    skips ahead to the newest keyframe instead of piling up delay. with_pose:
    each frame carries the drone's position and attitude when it was taken."""
    max_lag = max(2, int(cfg["stream_fps"]) // 2)
    seq, need_key = -1, True
    last_frame = time.time()
    while camera.codec == "h264":
        camera.touch()
        frames = camera.wait_h264(seq, timeout=2.0)
        if not frames:
            if time.time() - last_frame > 15:      # no pictures: end, the app retries
                return
            continue
        last_frame = time.time()
        if need_key or frames[0][0] != seq + 1 or len(frames) > max_lag:
            keys = [i for i, f in enumerate(frames) if f[1]]
            seq = frames[-1][0]
            if not keys:
                need_key = True                    # wait for the next keyframe
                continue
            frames, need_key = frames[keys[-1]:], False
        for fseq, key, ts_us, data in frames:
            flags = 1 if key else 0
            pose = _frame_pose(ts_us) if with_pose else b""
            if pose:
                flags |= 2
                data = POSE_LEN.pack(len(pose)) + pose + data
            yield H264_RECORD.pack(len(data), flags, ts_us) + data
            seq = fseq
    # The camera switched to MJPEG (USB webcam, or camera_codec changed): the app
    # reconnects, gets 409 and shows /video_feed.


@app.get("/api/camera/h264")
def camera_h264(pose: bool = Query(default=False)):
    camera.touch()
    if camera.codec != "h264":
        return JSONResponse({"success": False, "codec": camera.codec,
                             "message": "The camera is not sending H.264 now — use /video_feed."}, status_code=409)
    return StreamingResponse(h264_frames(pose), media_type="application/octet-stream",
                             headers={"Cache-Control": "no-cache, no-store", "X-Accel-Buffering": "no"})


# ---------------------------------------------------------------------------- AI (runs in the app)
@app.get("/api/ai/status")
def ai_status():
    # Plastic detection runs in the VARUNA app on the laptop (ONNX models),
    # on this camera's video. The Pi only streams.
    return {"ai_enabled": ai_state["ai_enabled"], "model_loaded": False, "runs_on": "app",
            "confidence_threshold": None, "live_boxes": 0}


@app.post("/api/ai/toggle")
def ai_toggle(body: AIToggleRequest):
    ai_state["ai_enabled"] = body.enabled
    return ok("Detection runs in the VARUNA app — use Start Detection on the Live tab.")


@app.get("/api/ai/detections")
def ai_detections(limit: int = Query(default=50, ge=1, le=500)):
    return {"detections": ai_state["detections"][-limit:]}


@app.get("/api/ai/classes")
def ai_classes():
    return {"classes": ["plastic"], "runs_on": "app"}


@app.post("/api/ai/report")
def ai_report(body: AIReportRequest):
    s = link.snapshot()
    ai_state["detections"].append({
        "class": body.debrisType, "confidence": body.confidence, "t": round(time.time(), 1),
        "lat": body.lat if body.lat is not None else s["lat"],
        "lng": body.lng if body.lng is not None else s["lng"],
        "alt": s["relative_alt"],
    })
    ai_state["detections"] = ai_state["detections"][-500:]
    return ok(f"Debris report '{body.debrisType}' logged.")


# ---------------------------------------------------------------------------- telemetry
@app.get("/api/telemetry")
def get_telemetry():
    return telemetry()


@app.get("/api/telemetry/history")
def telemetry_history(limit: int = Query(default=200, ge=1, le=900)):
    return link.recent_track(limit)


@app.websocket("/api/ws")
async def ws_endpoint(ws: WebSocket):
    await ws.accept()
    ws_clients.add(ws)
    operator["ws"] += 1
    try:
        await ws.send_json(telemetry())
        while True:
            await ws.receive_text()  # we only push; this just notices the close
    except WebSocketDisconnect:
        pass
    except Exception as exc:
        log.debug("WS closed: %s", exc)
    finally:
        ws_clients.discard(ws)
        operator["ws"] = max(0, operator["ws"] - 1)
        operator["last"] = time.time()


# ---------------------------------------------------------------------------- keyboard flight
@app.websocket("/api/control")
async def control_endpoint(ws: WebSocket):
    """The Control tab's keys: {"x": fwd, "y": right, "z": up, "r": yaw-right}, each -1…1,
    about 20 times a second. Closing the socket releases every key at once (hover)."""
    await ws.accept()
    keyboard.connected(True)
    try:
        while True:
            try:
                msg = json.loads(await ws.receive_text())
            except ValueError:
                continue
            if isinstance(msg, dict):
                keyboard.input(msg)
    except WebSocketDisconnect:
        pass
    except Exception as exc:
        log.debug("Control socket closed: %s", exc)
    finally:
        await asyncio.to_thread(keyboard.connected, False)


@app.post("/api/control/take")
def control_take():
    """Keyboard flight on: GUIDED, holding position (only in the air)."""
    return run(keyboard.take)


@app.post("/api/control/release")
def control_release():
    """Keyboard flight off: stop and hover in BRAKE (ignores the transmitter's sticks)."""
    return run(keyboard.release)


SAFETY_PARAMS = ("FS_GCS_ENABLE", "FS_THR_ENABLE", "FENCE_ENABLE")


@app.get("/api/pixhawk/safety")
def pixhawk_safety():
    """The Pixhawk failsafes that matter for keyboard flight, read back."""
    try:
        v = {name: link.get_param(name) for name in SAFETY_PARAMS}
    except LinkError as exc:
        return fail(str(exc))
    notes = []
    if not v["FS_GCS_ENABLE"]:
        notes.append("FS_GCS_ENABLE is 0: if the drone's Pi stopped, the Pixhawk would just hover where it is "
                     "(ArduCopter stops 3 s after the last keyboard command). Set it to 1 (RTL) for an automatic return.")
    if not v["FS_THR_ENABLE"]:
        notes.append("FS_THR_ENABLE is 0: losing the RC transmitter would not trigger a failsafe.")
    if not v["FENCE_ENABLE"]:
        notes.append("FENCE_ENABLE is 0: no geofence. The Pi still limits keyboard flight to max_distance_m and "
                     "max_altitude_m, but a fence on the Pixhawk also covers every other mode.")
    return {"values": v, "ok": not notes, "notes": notes}


@app.post("/api/pixhawk/safety/fix")
def pixhawk_safety_fix():
    """GCS failsafe on (RTL), so the drone comes home if its Pi stops."""
    try:
        if not link.get_param("FS_GCS_ENABLE"):
            link.set_param("FS_GCS_ENABLE", 1)
            return ok("FS_GCS_ENABLE = 1: if the drone's Pi stops, the Pixhawk returns home.", report=pixhawk_safety())
        return ok("Nothing to change.", report=pixhawk_safety())
    except LinkError as exc:
        return fail(str(exc))


# ---------------------------------------------------------------------------- flight control
@app.post("/api/mavlink/arm")
def mavlink_arm(body: ArmRequest):
    want = (not link.snapshot()["armed"]) if body.arm is None else body.arm
    return run(link.arm_ready if want else (lambda: link.arm(False)))


@app.post("/api/mavlink/mode")
def mavlink_mode(body: ModeRequest):
    return run(lambda: link.set_mode(body.mode))


@app.post("/api/mavlink/takeoff")
def mavlink_takeoff(body: TakeoffRequest):
    alt = float(body.altitude) if body.altitude else float(cfg["takeoff_alt_m"])
    if alt < 1:
        return fail("Take-off height must be at least 1 m.")
    if alt > cfg["max_altitude_m"]:
        return fail(f"{alt:g} m is above the {cfg['max_altitude_m']:g} m limit (System → Live tuning).")
    return run(lambda: link.takeoff(alt))


@app.post("/api/mavlink/rtl")
def mavlink_rtl():
    return run(lambda: link.set_mode("RTL"), "Returning to launch.")


@app.post("/api/mavlink/land")
def mavlink_land():
    return run(lambda: link.set_mode("LAND"), "Landing at the current position.")


@app.post("/api/mavlink/stop")
def mavlink_stop():
    """Emergency stop: land right here (ArduCopter LAND overrides any mission)."""
    return run(lambda: link.set_mode("LAND"), "Emergency stop — landing at the current position.")


@app.get("/api/mavlink/status")
def mavlink_status():
    s = link.snapshot()
    return {"mode": s["flight_mode"], "armed": s["armed"], "fc_connected": s["fc_connected"], "link": s["link"]}


@app.get("/api/mavlink/prefer")
def mavlink_prefer_get():
    return {"mode": cfg["link_prefer"], "active": link.link_name}


@app.post("/api/mavlink/prefer")
def mavlink_prefer_set(body: PreferRequest):
    mode = body.mode.strip().lower()
    if mode not in ("auto", "usb", "telem2"):
        return fail("Choose auto, usb or telem2.")
    link.set_prefer(mode)
    try:
        cfg.save()
    except OSError as exc:
        log.warning("Could not save the link preference: %s", exc)
    return ok(f"Link preference set to {mode.upper()} — reconnecting.")


# ---------------------------------------------------------------------------- missions
@app.post("/api/mission/upload")
def mission_upload(body: MissionUploadRequest):
    try:
        plan = missions.upload(body.name, [w.model_dump() for w in body.waypoints])
    except LinkError as exc:
        return fail(str(exc))
    except Exception as exc:
        log.exception("Upload failed")
        return fail(f"Unexpected error: {exc}")
    return ok(f"Mission '{plan['name']}' uploaded to the Pixhawk ({len(plan['waypoints'])} waypoints).",
              mission=missions.status())


@app.post("/api/mission/start")
def mission_start():
    return run(missions.start)


@app.post("/api/mission/pause")
def mission_pause():
    return run(missions.pause)


@app.post("/api/mission/clear")
def mission_clear():
    return run(missions.clear)


@app.get("/api/mission/status")
def mission_status():
    return missions.status()


@app.get("/api/mission/list")
def mission_list():
    return missions.list_missions()


# ---------------------------------------------------------------------------- config / auth
@app.get("/api/config")
def config_get():
    return cfg.schema()


@app.post("/api/config")
def config_set(body: dict):
    return cfg.update(body)


@app.post("/api/config/save")
def config_save():
    try:
        cfg.save()
    except OSError as exc:
        return fail(f"Could not save: {exc}")
    return ok("Configuration saved on the drone.")


@app.post("/api/auth/verify_pin")
def auth_verify_pin(body: PinRequest):
    pin = str(cfg["operator_pin"] or "")
    if not pin:
        return ok("No PIN is set on the drone.")
    good = body.password == pin
    return {"success": good, "message": "PIN accepted." if good else "Invalid PIN."}


# ---------------------------------------------------------------------------- web app (optional)
@app.get("/{path:path}", include_in_schema=False)
def web_app(path: str):
    if path.startswith("api/"):
        return JSONResponse({"detail": "Not Found"}, status_code=404)
    root = web_root()
    if root is None:
        return JSONResponse({"status": "ok", "vehicle": "drone",
                             "message": "VARUNA drone backend. Open the VARUNA app and connect to this address."})
    target = (root / path).resolve()
    if path and target.is_file() and root.resolve() in target.parents:
        return FileResponse(target)
    if Path(path).suffix:
        return JSONResponse({"detail": "Not Found"}, status_code=404)
    return FileResponse(root / "index.html", headers={"Cache-Control": "no-cache"})


# ---------------------------------------------------------------------------- entry point
def main():
    ap = argparse.ArgumentParser(description="VARUNA drone backend")
    ap.add_argument("--port", type=int, default=None, help="HTTP port (default from config: 8000)")
    ap.add_argument("--host", default="0.0.0.0")
    ap.add_argument("--connection", default=None, help="force the Pixhawk link, e.g. tcp:127.0.0.1:5760 or /dev/ttyACM0")
    ap.add_argument("--camera", default=None, help="camera source: auto | usb | csi | url | test | off")
    ap.add_argument("--camera-url", default=None,
                    help="phone camera MJPEG stream, e.g. http://100.x.x.x:8080/video (IP Webcam)")
    args = ap.parse_args()
    if args.connection:
        os.environ["DRONE_CLI_CONNECTION"] = args.connection
    if args.camera:
        os.environ["DRONE_CLI_CAMERA"] = args.camera
    if args.camera_url:
        os.environ["DRONE_CLI_CAMERA_URL"] = args.camera_url
    port = args.port or cfg["http_port"]
    os.environ["DRONE_CLI_PORT"] = str(port)
    import uvicorn
    # An open /video_feed never ends by itself, so without a limit a restart
    # waits for every viewer to leave (systemd kills it only after 90 s).
    server = uvicorn.Server(uvicorn.Config("main:app", host=args.host, port=port, log_level="info",
                                           timeout_graceful_shutdown=3))
    server.run(sockets=[listen_socket(args.host, port)])


# Linux lets a connection queue up to 4 MB of unsent data. On the drone's Wi-Fi
# (a few Mbit/s) that is many seconds of old video waiting to go out: the live
# view falls further and further behind. A small send buffer keeps at most a
# couple of frames in flight, so the stream skips stale frames instead and stays
# live. Connections accepted from this socket inherit it. Small API replies
# don't notice.
SEND_BUFFER = 64 * 1024


def listen_socket(host, port):
    family = socket.AF_INET6 if ":" in host else socket.AF_INET
    sock = socket.socket(family, socket.SOCK_STREAM)
    sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    sock.setsockopt(socket.SOL_SOCKET, socket.SO_SNDBUF, SEND_BUFFER)
    sock.bind((host, port))
    sock.listen(128)
    return sock


logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")

if __name__ == "__main__":
    main()
