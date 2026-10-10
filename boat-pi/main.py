"""
VARUNA boat backend — runs on the boat's Raspberry Pi.

The VARUNA app (on the laptop, over NetBird) sends it the plastic locations to
collect; this service turns them into an ArduRover mission, uploads it to the
boat's Pixhawk with pymavlink, starts it, and streams the boat's telemetry and
collection progress back to the app.

Endpoints mirror the drone Pi backend where they overlap (/api/ping, /api/health,
/api/telemetry, /api/ws, /api/mavlink/*, /api/mission/*), so the app talks to
both vehicles the same way. Every mutating call answers HTTP 200 with
{"success": bool, "message": str}.

Boat camera features (see vision.py): the Pi streams its camera (/video_feed,
each frame stamped with its capture time); the app runs the AI and posts what
it saw to /api/vision/observe; the Pi decides homing, wildlife pauses and water
measurements, logs the catch (/api/catch) and reads the turbidity sensor
(/api/water/*).

Run on the Pi:      python main.py
Test on a laptop:   python main.py --sim --port 8001   (simulated Pixhawk)
"""

import argparse
import asyncio
import inspect
import logging
import os
import platform
import time
from contextlib import asynccontextmanager
from typing import Optional, Union

import psutil
from fastapi import FastAPI, Query, Request, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse, Response, StreamingResponse
from pydantic import BaseModel, Field

from camera import CameraManager
from config import DATA_DIR, TUNABLE, load_config, save_settings, tune
from mav_link import BoatLink, LinkError
from mission import ACTIVE_STATES, MissionManager
from turbidity import Turbidity
from vision import VisionManager

log = logging.getLogger("boat")
VERSION = "1.0.0"
STARTED = time.time()

cfg = load_config()
SIM = os.environ.get("BOAT_SIM") == "1"
# Command-line overrides (set by main() below) win over the config file.
if os.environ.get("BOAT_CLI_CONNECTION"):
    cfg["mav_connection"] = os.environ["BOAT_CLI_CONNECTION"]
if os.environ.get("BOAT_CLI_BAUD"):
    cfg["mav_baud"] = int(os.environ["BOAT_CLI_BAUD"])
if os.environ.get("BOAT_CLI_PORT"):
    cfg["http_port"] = int(os.environ["BOAT_CLI_PORT"])
if SIM:
    cfg["mav_connection"] = "tcp:127.0.0.1:" + os.environ.get("BOAT_SIM_TCP_PORT", "5762")



def remember_link(device, baud):
    """The Pixhawk answered on a different port/baud than configured: save it,
    so the next start connects straight away. (Not for command-line or simulator links.)"""
    cfg["mav_connection"], cfg["mav_baud"] = device, baud
    if not SIM and not os.environ.get("BOAT_CLI_CONNECTION"):
        save_settings({"mav_connection": device, "mav_baud": baud})
        log.info("Saved the working Pixhawk link to boat_config.json: %s @ %s", device, baud)


link = BoatLink(cfg["mav_connection"], cfg["mav_baud"], on_link_found=remember_link)
missions = MissionManager(link, cfg, DATA_DIR)
sim_boat = None
sim_world = None
if SIM:
    # The simulated boat is created here (not in lifespan) so the simulated
    # camera can render from it; it starts listening in lifespan.
    from sim_vehicle import SimBoat
    sim_boat = SimBoat(cfg["sim_home_lat"], cfg["sim_home_lng"],
                       "tcpin:127.0.0.1:" + os.environ.get("BOAT_SIM_TCP_PORT", "5762"),
                       sim_rate=float(os.environ.get("BOAT_SIM_RATE", "1")))
    try:
        import PIL  # noqa: F401  (the simulated camera draws with Pillow)
        from sim_world import SimCamera, SimWorld
        sim_world = SimWorld(sim_boat, cfg)
        camera = SimCamera(sim_world, cfg)
    except ImportError:
        cfg["camera_source"] = "test"
        camera = CameraManager(cfg)
else:
    camera = CameraManager(cfg)
turbidity = Turbidity(cfg, DATA_DIR, link, sim=SIM, save_settings=save_settings)
vision = VisionManager(link, missions, cfg, DATA_DIR, turbidity)
operator = {"last": time.time(), "ws": 0, "acted": False}


# ---------------------------------------------------------------------------- models
class ArmRequest(BaseModel):
    arm: Optional[bool] = None


class ModeRequest(BaseModel):
    mode: str


class CollectPoint(BaseModel):
    id: Optional[Union[str, int]] = None
    lat: float
    lng: float
    hold_s: Optional[float] = Field(default=None, ge=0, le=120)


class MissionUploadRequest(BaseModel):
    name: str = "Plastic collection"
    waypoints: list[CollectPoint]
    hold_s: Optional[float] = Field(default=None, ge=0, le=120)
    speed_mps: Optional[float] = Field(default=None, ge=0, le=5)
    rtl: bool = True
    homing: bool = True                 # camera homing onto each item
    measure_at_first: bool = False      # turbidity reading at the first item


class CatchItem(BaseModel):
    label: str = "item"
    score: Optional[float] = None
    frame_time: Optional[float] = None
    photo: Optional[str] = None         # small JPEG, base64


class WildlifeAction(BaseModel):
    action: str


class CalibrateRequest(BaseModel):
    action: str                         # clear | reference | reset
    ntu: Optional[float] = None


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
    return {
        "vehicle": "boat",
        "lat": s["lat"],
        "lng": s["lng"],
        "altitude": 0.0,
        "relative_alt": s["relative_alt"],
        "speed": round(s["groundspeed"] or 0.0, 2),
        "groundspeed": round(s["groundspeed"] or 0.0, 2),
        "heading": None if s["heading"] is None else round(s["heading"], 1),
        "flight_mode": s["flight_mode"],
        "armed": s["armed"],
        "battery_voltage": None if s["battery_voltage"] is None else round(s["battery_voltage"], 2),
        "battery_percent": s["battery_percent"],
        "satellites": s["satellites"],
        "gps_fix": s["gps_fix"],
        "throttle": s["throttle"],
        "roll": s["roll"],
        "pitch": s["pitch"],
        "yaw": s["yaw"],
        "home": None if s["home_lat"] is None else {"lat": s["home_lat"], "lng": s["home_lng"]},
        "fc_connected": s["fc_connected"],
        "link_error": s["link_error"],
        "messages": s["messages"],
        "mission": m,
        "vision": vision.summary(),
        "water": turbidity.summary(),
        "camera": {"connected": bool(camera.connected), "fps": camera.measured_fps()},
        "simulated": SIM,
        "t": round(time.time(), 2),
    }


# ---------------------------------------------------------------------------- lifecycle
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
        await asyncio.sleep(0.25)


async def operator_watchdog():
    """Optional failsafe for a lost NetBird link (cfg operator_lost_action)."""
    action = cfg["operator_lost_action"]
    while True:
        await asyncio.sleep(2)
        if action == "none" or operator["ws"] > 0:
            operator["acted"] = False
            continue
        quiet = time.time() - operator["last"]
        if quiet < cfg["operator_lost_s"] or operator["acted"]:
            continue
        if missions.status()["state"] in ("running",) and link.snapshot()["armed"]:
            operator["acted"] = True
            mode = "RTL" if action == "rtl" else "HOLD"
            log.warning("No contact from the VARUNA app for %.0f s — switching to %s", quiet, mode)
            try:
                await asyncio.to_thread(link.set_mode, mode)
            except LinkError as exc:
                log.error("Operator-lost failsafe failed: %s", exc)


@asynccontextmanager
async def lifespan(app):
    if sim_boat:
        sim_boat.start()
        log.info("Simulated Pixhawk listening on %s", sim_boat.address)
    link.start()
    camera.start()
    turbidity.start()
    vision.start()
    tasks = [asyncio.create_task(broadcast_loop()), asyncio.create_task(operator_watchdog())]
    log.info("VARUNA boat backend %s ready on port %s (Pixhawk: %s)", VERSION, cfg["http_port"], cfg["mav_connection"])
    yield
    for t in tasks:
        t.cancel()
    vision.stop()
    turbidity.stop()
    camera.stop()
    if sim_boat:
        sim_boat.stop()
    link.stop()


if "lifespan" in inspect.signature(FastAPI.__init__).parameters:
    app = FastAPI(title="VARUNA Boat Backend", version=VERSION, lifespan=lifespan)
else:
    # FastAPI older than 0.93 (the OS package on 32-bit Raspberry Pi OS 12):
    # no lifespan= yet, so run the same start-up / shut-down from events.
    app = FastAPI(title="VARUNA Boat Backend", version=VERSION)
    _life = {}

    @app.on_event("startup")
    async def _startup():
        _life["cm"] = lifespan(app)
        await _life["cm"].__aenter__()

    @app.on_event("shutdown")
    async def _shutdown():
        if "cm" in _life:
            await _life["cm"].__aexit__(None, None, None)
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])
ws_clients = set()


@app.middleware("http")
async def note_operator(request: Request, call_next):
    if request.url.path.startswith("/api/"):
        operator["last"] = time.time()
    return await call_next(request)


# ---------------------------------------------------------------------------- health
@app.get("/api/ping")
def ping():
    return {"status": "ok", "vehicle": "boat"}


@app.get("/api/health")
def health():
    s = link.snapshot()
    return {
        "status": "ok",
        "vehicle": "boat",
        "version": VERSION,
        "pixhawk_connected": s["fc_connected"],
        "camera_connected": bool(camera.connected),
        "turbidity_connected": turbidity.fresh(),
        "link_error": s["link_error"],
        "gps_fix": s["gps_fix"],
        "satellites": s["satellites"],
        "mav_connection": link.connection,
        "mav_baud": link.baud,
        "simulated": SIM,
        "uptime_s": round(time.time() - STARTED),
    }


@app.get("/api/system/status")
def system_status():
    return {"status": "ok", "vehicle": "boat"}


@app.get("/api/system/pi")
def system_pi(processes: bool = Query(default=False)):
    temp = 0.0
    read_temps = getattr(psutil, "sensors_temperatures", None)
    if read_temps:
        try:
            temps = read_temps() or {}
            for key in ("cpu_thermal", "coretemp", "soc_thermal"):
                if temps.get(key):
                    temp = temps[key][0].current
                    break
        except Exception:
            pass
    ram = psutil.virtual_memory()
    disk = psutil.disk_usage("/")
    return {
        "cpu_per_core": [{"percent": p} for p in psutil.cpu_percent(percpu=True, interval=0.2)],
        "ram_percent": ram.percent,
        "disk_percent": disk.percent,
        "temperature": round(temp, 1),
        "cpu_count": psutil.cpu_count(logical=True),
        "platform": platform.platform(),
    }


# ---------------------------------------------------------------------------- telemetry
@app.get("/api/telemetry")
def get_telemetry():
    return telemetry()


@app.get("/api/telemetry/history")
def telemetry_history(limit: int = Query(default=300, ge=1, le=600)):
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


# ---------------------------------------------------------------------------- boat control
@app.post("/api/mavlink/arm")
def mavlink_arm(body: ArmRequest):
    want = (not link.snapshot()["armed"]) if body.arm is None else body.arm
    vision.operator("arm" if want else "disarm")
    return run(lambda: link.arm(want))


@app.post("/api/mavlink/mode")
def mavlink_mode(body: ModeRequest):
    vision.operator(f"mode {body.mode.upper()}")
    return run(lambda: link.set_mode(body.mode))


@app.post("/api/mavlink/hold")
def mavlink_hold():
    vision.operator("hold")
    return run(lambda: link.set_mode("HOLD"), "Holding position.")


@app.post("/api/mavlink/rtl")
def mavlink_rtl():
    vision.operator("return home")
    return run(lambda: link.set_mode("RTL"), "Returning to launch.")


@app.post("/api/mavlink/stop")
def mavlink_stop():
    """Emergency stop: HOLD (motors stop) and disarm. Tries both even if one fails."""
    vision.operator("emergency stop")
    notes, okay = [], True
    try:
        notes.append(link.set_mode("HOLD"))
    except LinkError as exc:
        okay = False
        notes.append(str(exc))
    try:
        notes.append(link.arm(False))
    except LinkError:
        try:
            notes.append(link.arm(False, force=True) + " (forced)")
        except LinkError as exc:
            okay = False
            notes.append(str(exc))
    return (ok if okay else fail)("Emergency stop: " + " ".join(notes))


@app.get("/api/mavlink/status")
def mavlink_status():
    s = link.snapshot()
    return {"mode": s["flight_mode"], "armed": s["armed"], "fc_connected": s["fc_connected"]}


# ---------------------------------------------------------------------------- missions
@app.post("/api/mission/upload")
def mission_upload(body: MissionUploadRequest):
    # .model_dump() is pydantic 2; .dict() pydantic 1 (older OS packages on 32-bit Pis).
    wps = [w.model_dump() if hasattr(w, "model_dump") else w.dict() for w in body.waypoints]
    try:
        plan = missions.upload(body.name, wps, body.hold_s, body.speed_mps, body.rtl,
                               homing=body.homing, measure_at_first=body.measure_at_first)
        vision.new_plan()
        if sim_world:
            sim_world.seed_for_mission(plan["waypoints"])
    except LinkError as exc:
        return fail(str(exc))
    except Exception as exc:
        log.exception("Upload failed")
        return fail(f"Unexpected error: {exc}")
    return ok(f"Mission '{plan['name']}' uploaded to the Pixhawk — {len(plan['waypoints'])} items to collect.",
              mission=missions.status())


@app.post("/api/mission/start")
def mission_start():
    vision.operator_start()
    res = run(missions.start)
    if res["success"]:
        vision.after_start()            # ArduRover resets the speed on entering AUTO
    return res


@app.post("/api/mission/pause")
def mission_pause():
    vision.operator("pause")
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


@app.get("/api/boat/info")
def boat_info():
    return {
        "vehicle": "boat",
        "version": VERSION,
        "default_hold_s": cfg["default_hold_s"],
        "default_speed_mps": cfg["default_speed_mps"],
        "max_waypoints": cfg["max_waypoints"],
        "max_distance_m": cfg["max_distance_m"],
        "collector_servo": cfg["collector_servo"],
        "operator_lost_action": cfg["operator_lost_action"],
        "simulated": SIM,
        "active_states": list(ACTIVE_STATES),
        "camera": camera.get_status()["source"],
        "turbidity": turbidity.summary()["connected"],
    }


# ---------------------------------------------------------------------------- camera
@app.get("/api/camera/status")
def camera_status():
    return camera.get_status()


@app.get("/api/camera/snapshot")
def camera_snapshot():
    jpeg = camera.snapshot()
    if jpeg is None:
        return Response(content=b"", media_type="image/jpeg", status_code=503, headers={"Cache-Control": "no-store"})
    return Response(content=jpeg, media_type="image/jpeg", headers={"Cache-Control": "no-store"})


def mjpeg_frames():
    """Multipart MJPEG. Each part carries X-Frame-Time (when the frame was
    captured, Pi clock) and X-Frame-Seq: the app sends the time back with its
    detections so the Pi can match them to where the boat was."""
    seq, last_sent, last_frame = 0, 0.0, time.time()
    while True:
        seq, jpeg, t = camera.wait_frame(seq, timeout=2.0)
        if jpeg is None:
            if time.time() - last_frame > 15:
                return                       # camera gone: end the stream, the app retries
            continue
        last_frame = time.time()
        min_gap = 1.0 / max(1, int(cfg["stream_fps"]))
        if last_frame - last_sent < min_gap * 0.9:
            continue
        last_sent = last_frame
        yield (b"--frame\r\nContent-Type: image/jpeg\r\nContent-Length: " + str(len(jpeg)).encode()
               + b"\r\nX-Frame-Time: " + f"{t:.3f}".encode() + b"\r\nX-Frame-Seq: " + str(seq).encode()
               + b"\r\n\r\n" + jpeg + b"\r\n")


@app.get("/video_feed")
def video_feed():
    return StreamingResponse(mjpeg_frames(), media_type="multipart/x-mixed-replace; boundary=frame",
                             headers={"Cache-Control": "no-cache, no-store", "X-Accel-Buffering": "no"})


# ---------------------------------------------------------------------------- vision (AI runs in the app)
@app.post("/api/vision/observe")
def vision_observe(body: dict):
    return {"success": True, **vision.observe(body)}


@app.get("/api/vision/status")
def vision_status():
    return vision.summary()


def vision_config_view():
    out = {k: cfg[k] for k in TUNABLE}
    out["camera_width"], out["camera_height"] = cfg["camera_width"], cfg["camera_height"]
    out["limits"] = {k: list(v) for k, v in TUNABLE.items()}
    return out


@app.get("/api/vision/config")
def vision_config_get():
    return vision_config_view()


@app.post("/api/vision/config")
def vision_config_set(body: dict):
    applied, errors = tune(cfg, body)
    if applied and not SIM:
        try:
            save_settings(applied)
        except OSError as exc:
            return fail(f"Applied, but could not save on the boat: {exc}", config=vision_config_view())
    if errors:
        return fail("Some settings were rejected: " + "; ".join(f"{k}: {v}" for k, v in errors.items()),
                    config=vision_config_view(), errors=errors)
    return ok(f"Saved {len(applied)} setting(s)." if applied else "Nothing changed.", config=vision_config_view())


# ---------------------------------------------------------------------------- catch counter
@app.post("/api/catch/item")
def catch_item(body: CatchItem):
    item = vision.add_catch(body.label, body.score, body.frame_time, body.photo)
    return ok(f"Counted: {item['label']}", item=item, catch=vision.catch_summary())


@app.get("/api/catch")
def catch_get(limit: int = Query(default=40, ge=0, le=500)):
    return vision.catch_summary(limit)


@app.get("/api/catch/photo/{item_id}")
def catch_photo(item_id: str):
    p = vision.catch.photo_path(item_id)
    if not p:
        return JSONResponse({"success": False, "message": "No photo."}, status_code=404)
    return FileResponse(p, media_type="image/jpeg", headers={"Cache-Control": "max-age=86400"})


@app.post("/api/catch/empty")
def catch_empty():
    n = vision.empty_bin()
    return ok(f"Bin emptied — {n} item(s) cleared from the count.", catch=vision.catch_summary())


# ---------------------------------------------------------------------------- wildlife
@app.get("/api/wildlife")
def wildlife_get(limit: int = Query(default=30, ge=0, le=500)):
    return vision.wildlife_summary(limit)


@app.post("/api/wildlife/action")
def wildlife_action(body: WildlifeAction):
    return run(lambda: vision.wildlife_action(body.action.strip().lower()))


@app.get("/api/wildlife/photo/{item_id}")
def wildlife_photo(item_id: str):
    p = vision.sightings.photo_path(item_id)
    if not p:
        return JSONResponse({"success": False, "message": "No photo."}, status_code=404)
    return FileResponse(p, media_type="image/jpeg", headers={"Cache-Control": "max-age=86400"})


# ---------------------------------------------------------------------------- water (turbidity)
@app.get("/api/water/status")
def water_status():
    st = turbidity.status()
    st["measuring"] = vision.summary()["measure"]
    return st


@app.get("/api/water/track")
def water_track(limit: int = Query(default=2000, ge=1, le=20000), since: Optional[float] = None):
    return turbidity.track_points(limit, since)


@app.get("/api/water/readings")
def water_readings(limit: int = Query(default=100, ge=1, le=500)):
    return list(reversed(turbidity.readings[-limit:]))


@app.post("/api/water/measure")
def water_measure():
    return run(lambda: vision.request_measure("operator"))


@app.post("/api/water/calibrate")
def water_calibrate(body: CalibrateRequest):
    try:
        return ok(turbidity.calibrate(body.action.strip().lower(), body.ntu), status=turbidity.status())
    except ValueError as exc:
        return fail(str(exc))


# ---------------------------------------------------------------------------- simulator only
@app.get("/api/sim/detections")
def sim_detections(frame_time: float = Query(...)):
    """SIM only: where the simulated items and ducks are in a given frame (the
    app uses this instead of its AI models, which don't recognise drawings)."""
    if not sim_world:
        return JSONResponse({"success": False, "message": "Only available in the simulator."}, status_code=404)
    pose = camera.pose_for(frame_time)
    if pose is None:
        return {"targets": [], "hazards": [], "ramp": []}
    return sim_world.detections(pose, cfg["camera_width"], cfg["camera_height"])


@app.post("/api/sim/duck")
def sim_duck(ahead_m: float = Query(default=5.0, ge=1, le=20)):
    if not sim_world:
        return fail("Only available in the simulator.")
    sim_world.spawn_duck(ahead_m)
    return ok(f"A duck appeared {ahead_m:g} m ahead.")


# ---------------------------------------------------------------------------- entry point
def main():
    ap = argparse.ArgumentParser(description="VARUNA boat backend")
    ap.add_argument("--sim", action="store_true", help="run against a built-in simulated Pixhawk")
    ap.add_argument("--port", type=int, default=None, help="HTTP port (default from config: 8000)")
    ap.add_argument("--host", default="0.0.0.0")
    ap.add_argument("--connection", default=None, help="override the Pixhawk connection, e.g. /dev/ttyACM0")
    ap.add_argument("--baud", type=int, default=None)
    args = ap.parse_args()
    if args.sim:
        os.environ["BOAT_SIM"] = "1"
    if args.connection:
        os.environ["BOAT_CLI_CONNECTION"] = args.connection
    if args.baud:
        os.environ["BOAT_CLI_BAUD"] = str(args.baud)
    port = args.port or cfg["http_port"]
    os.environ["BOAT_CLI_PORT"] = str(port)
    import uvicorn
    uvicorn.run("main:app", host=args.host, port=port, log_level="info")


logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")

if __name__ == "__main__":
    main()
