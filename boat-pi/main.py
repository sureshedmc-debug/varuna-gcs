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
import json
import logging
import os
import platform
import socket
import time
from contextlib import asynccontextmanager
from typing import Optional, Union

import psutil
from fastapi import FastAPI, Query, Request, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse, Response, StreamingResponse
from pydantic import BaseModel, Field

from camera import CameraManager
from collector import Collector
from config import DATA_DIR, TUNABLE, load_config, save_settings, tune
from drive import DriveManager
from live_collect import LiveCollect
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
                       sim_rate=float(os.environ.get("BOAT_SIM_RATE", "1")),
                       no_transmitter=cfg["rc_source"] == "gamepad")
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
live = LiveCollect(link, missions, cfg, DATA_DIR)
vision.live, live.vision = live, vision
collector = Collector(link, cfg)
collector.missions, collector.vision, collector.live = missions, vision, live
live.collector = collector
if sim_world:
    live.on_targets_added = sim_world.add_objects_near   # the simulated river gets the plastic
drive = DriveManager(link, cfg, vision)
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
        "live": live.summary(),
        "collector": collector.summary(),
        "water": turbidity.summary(),
        "drive": drive.status(),
        "camera": {"connected": bool(camera.connected), "fps": camera.measured_fps(),
                   "stream_mbps": camera.data_rate()[2] if hasattr(camera, "data_rate") else None},
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
        await asyncio.sleep(1.0 / cfg["telemetry_hz"])   # 4 Hz; 2 Hz on a Pi Zero


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
        live_on = live.state in ("running", "returning")
        if (missions.status()["state"] in ("running",) or live_on) and link.snapshot()["armed"]:
            operator["acted"] = True
            if live_on:
                live.operator("no contact from the VARUNA app")
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
    live.start_thread()
    collector.start()
    drive.start()
    tasks = [asyncio.create_task(broadcast_loop()), asyncio.create_task(operator_watchdog())]
    log.info("VARUNA boat backend %s ready on port %s (Pixhawk: %s)", VERSION, cfg["http_port"], cfg["mav_connection"])
    if drive.enabled:
        log.info("Driving by hand: game controller via the app (no RC transmitter); max throttle %d%%",
                 round(cfg["gamepad_max_throttle"] * 100))
    if cfg["lite"]:
        log.info("Pi Zero lite mode: camera %s fps, quality %s, telemetry %g/s",
                 cfg["camera_fps"], cfg["camera_quality"], cfg["telemetry_hz"])
    yield
    for t in tasks:
        t.cancel()
    drive.stop()
    collector.stop()
    live.stop_thread()
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
        # Non-blocking: CPU use since the previous call (the app polls this every few seconds).
        "cpu_per_core": [{"percent": p} for p in psutil.cpu_percent(percpu=True, interval=None)],
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


# ---------------------------------------------------------------------------- game controller
@app.websocket("/api/drive")
async def drive_endpoint(ws: WebSocket):
    """The app's game controller: {"s": steering -1..1, "t": throttle -1..1, "pad": name}
    about 20 times a second, or {"brake": true} (L1 + R1). Closing the socket
    centres the sticks at once."""
    await ws.accept()
    drive.connected(True)
    try:
        while True:
            try:
                msg = json.loads(await ws.receive_text())
            except ValueError:
                continue
            if isinstance(msg, dict) and msg.get("brake"):
                asyncio.get_running_loop().run_in_executor(None, brake)
            elif isinstance(msg, dict):
                drive.input(msg.get("s"), msg.get("t"), msg.get("pad"))
    except WebSocketDisconnect:
        pass
    except Exception as exc:
        log.debug("Drive socket closed: %s", exc)
    finally:
        drive.connected(False)


FAILSAFE_PARAMS = ("FS_THR_ENABLE", "FS_ACTION", "FS_TIMEOUT", "RC_OVERRIDE_TIME", "FS_GCS_ENABLE")
FS_ACTIONS = {0: "do nothing", 1: "return home", 2: "hold (stop)", 3: "smart return home, else return home",
              4: "smart return home, else hold"}


def failsafe_report():
    """The Pixhawk's failsafe, read back.

    Game controller (no transmitter): there is no radio, so the radio failsafe
    stays off (FS_THR_ENABLE 0) and the Pi's heartbeat is the failsafe instead
    (FS_GCS_ENABLE): if the boat Pi dies, the Pixhawk acts after FS_GCS_TIMEOUT.
    The Pi itself centres the sticks when the PC's controller goes quiet.
    Transmitter: the radio failsafe (FS_THR_ENABLE) stops the boat if the
    transmitter is lost."""
    values = {name: link.get_param(name) for name in FAILSAFE_PARAMS}
    problems = []
    if cfg["rc_source"] == "gamepad":
        needed = ("FS_GCS_ENABLE", "FS_ACTION")
        if values["FS_GCS_ENABLE"] == 0:
            problems.append("FS_GCS_ENABLE is 0: if the boat Pi stopped, the Pixhawk would carry on with the last command.")
    else:
        needed = ("FS_THR_ENABLE", "FS_ACTION")
        if values["FS_THR_ENABLE"] == 0:
            problems.append("FS_THR_ENABLE is 0: if the transmitter was lost, the Pixhawk would carry on with the last command.")
    if values["FS_ACTION"] == 0:
        problems.append("FS_ACTION is 0 (do nothing): the failsafe would not stop the boat.")
    return {"values": values, "action": FS_ACTIONS.get(int(values["FS_ACTION"] or 0)) if values["FS_ACTION"] is not None else None,
            "ok": not problems and None not in (values[n] for n in needed), "problems": problems,
            "rc_source": cfg["rc_source"]}


@app.get("/api/pixhawk/failsafe")
def pixhawk_failsafe():
    try:
        return failsafe_report()
    except LinkError as exc:
        return fail(str(exc))


class ParamsRequest(BaseModel):
    values: dict[str, float]


_PARAM_NAME = __import__("re").compile(r"^[A-Z0-9_]{1,16}$")


@app.get("/api/pixhawk/params")
def pixhawk_params_get(names: str = Query(..., description="Comma-separated parameter names")):
    """Read Pixhawk parameters. A name the Pixhawk doesn't have reads as null."""
    wanted = [n.strip().upper() for n in names.split(",") if n.strip()]
    bad = [n for n in wanted if not _PARAM_NAME.match(n)]
    if bad or not wanted or len(wanted) > 60:
        return fail("Give 1–60 parameter names (letters, digits, _), e.g. ?names=FRAME_CLASS,WP_SPEED")
    try:
        return {"values": {n: link.get_param(n) for n in wanted}}
    except LinkError as exc:
        return fail(str(exc))


@app.post("/api/pixhawk/params")
def pixhawk_params_set(body: ParamsRequest):
    """Set Pixhawk parameters (only while disarmed). Each one is confirmed by the
    Pixhawk echoing the stored value; reports what changed and what didn't."""
    bad = [n for n in body.values if not _PARAM_NAME.match(n)]
    if bad or not body.values or len(body.values) > 60:
        return fail("Give 1–60 parameters by their exact names.")
    try:
        if link.snapshot()["armed"]:
            return fail("Disarm the boat before changing Pixhawk parameters.")
        changed, same, failed = {}, {}, {}
        for name, value in body.values.items():
            before = link.get_param(name)
            if before is None:
                failed[name] = "the Pixhawk has no such parameter"
                continue
            if abs(before - value) < 1e-4:
                same[name] = before
                continue
            try:
                link.set_param(name, value)
                changed[name] = {"from": before, "to": value}
                log.info("Pixhawk parameter %s: %g → %g", name, before, value)
            except LinkError as exc:
                failed[name] = str(exc)
        msg = f"{len(changed)} changed, {len(same)} already set" + (f", {len(failed)} failed" if failed else "")
        return (ok if not failed else fail)(msg, changed=changed, same=same, failed=failed)
    except LinkError as exc:
        return fail(str(exc))


@app.post("/api/pixhawk/reboot")
def pixhawk_reboot():
    """Restart the Pixhawk (needed after FRAME_CLASS or SERIAL changes). Disarmed only."""
    try:
        if link.snapshot()["armed"]:
            return fail("Disarm the boat before restarting the Pixhawk.")
        link.command_long(246, [1, 0, 0, 0, 0, 0, 0])      # MAV_CMD_PREFLIGHT_REBOOT_SHUTDOWN
        return ok("Pixhawk restarting; it reconnects in about 10 s.")
    except LinkError as exc:
        return fail(str(exc))


# ---------------------------------------------------------------------------- motor matching
# Forward-only ESCs don't start turning at their lowest signal: each has a dead
# band, and two ESCs rarely start at the same point. That dead band is the jerk
# when the throttle comes in (nothing… then a surge), and different start points
# pull the boat sideways. The Pixhawk's motor test spins one motor at an exact
# signal and stops it itself after a few seconds; the operator finds where each
# motor just starts, and that output's stopped point (SERVOn_TRIM/MIN) is set
# just below it, so both motors start together from the first bit of throttle.
MOTOR_TEST_SEQ = {"left": 3, "right": 4}                   # ArduRover: throttle left / right
MOTOR_FUNCTION = {"left": 73, "right": 74}
MOTOR_TEST_MAX_PWM = 1500                                  # finding the start point needs no more
START_MARGIN_US = 15                                       # stopped point this far below the start


class MotorTestRequest(BaseModel):
    motor: str = Field(..., description="left | right")
    pwm: int = Field(..., ge=900, le=MOTOR_TEST_MAX_PWM)
    seconds: float = Field(2.0, ge=0.5, le=3.0)


class MotorStartRequest(BaseModel):
    motor: str = Field(..., description="left | right")
    pwm: int = Field(..., ge=900, le=MOTOR_TEST_MAX_PWM, description="Signal where the motor just starts turning")


def _motor_output(motor):
    """Which output (1–8) drives this thruster, from SERVOn_FUNCTION."""
    want = MOTOR_FUNCTION[motor]
    for n in range(1, 9):
        if link.get_param(f"SERVO{n}_FUNCTION") == want:
            return n
    raise LinkError(f"No output is set as the {motor} thruster (SERVOn_FUNCTION {want}).")


@app.post("/api/pixhawk/motor_test")
def pixhawk_motor_test(body: MotorTestRequest):
    """Spin one thruster at an exact signal; the Pixhawk stops it after `seconds`. Disarmed only."""
    motor = body.motor.lower()
    if motor not in MOTOR_TEST_SEQ:
        return fail("motor must be left or right.")
    try:
        if link.snapshot()["armed"]:
            return fail("Disarm the boat before a motor test.")
        if _esc["active"]:
            return fail("An ESC calibration is running.")
        # MAV_CMD_DO_MOTOR_TEST: motor, throttle type 1 = PWM, value, timeout s
        result = link.command_long(209, [MOTOR_TEST_SEQ[motor], 1, body.pwm, body.seconds, 0, 0])
        if result != 0:
            return fail(f"The Pixhawk refused the motor test (result {result}).")
        log.info("Motor test: %s at %d µs for %.1f s", motor, body.pwm, body.seconds)
        return ok(f"{motor.capitalize()} motor at {body.pwm} µs for {body.seconds:g} s.")
    except LinkError as exc:
        return fail(str(exc))


@app.post("/api/pixhawk/motor_start")
def pixhawk_motor_start(body: MotorStartRequest):
    """Save where this thruster starts turning: its stopped point goes just below it."""
    motor = body.motor.lower()
    if motor not in MOTOR_FUNCTION:
        return fail("motor must be left or right.")
    try:
        if link.snapshot()["armed"]:
            return fail("Disarm the boat first.")
        n = _motor_output(motor)
        stop = body.pwm - START_MARGIN_US
        link.set_param(f"SERVO{n}_MIN", stop)
        link.set_param(f"SERVO{n}_TRIM", stop)
        link.set_param(f"SERVO{n}_MAX", 2000)
        log.info("Motor matching: %s motor (output %d) starts at %d µs → stopped at %d µs", motor, n, body.pwm, stop)
        return ok(f"{motor.capitalize()} motor (output {n}): stopped at {stop} µs, starts at {body.pwm} µs, full at 2000 µs.",
                  output=n, stop=stop)
    except LinkError as exc:
        return fail(str(exc))


@app.get("/api/pixhawk/motors")
def pixhawk_motors():
    """Each thruster's output and its stopped / full signal."""
    try:
        out = {}
        for motor in MOTOR_FUNCTION:
            try:
                n = _motor_output(motor)
            except LinkError:
                out[motor] = None
                continue
            out[motor] = {"output": n, "stop": link.get_param(f"SERVO{n}_TRIM"), "max": link.get_param(f"SERVO{n}_MAX")}
        return {"motors": out}
    except LinkError as exc:
        return fail(str(exc))


# ---------------------------------------------------------------------------- ESC calibration
# Teaches an ESC the Pixhawk's throttle range (1000–2000 µs), the classic way:
# full signal when the ESC gets power, then minimum. Forward-only ESCs give a
# short window for that: after power-up they beep twice (top learned) and want
# the minimum within ~5 s — later, they go into their programming menu (endless
# beeping). Far too quick to do by hand over chat, so the Pi times it:
#
#   1. Refused unless the battery is unplugged: the Pixhawk runs off the
#      battery, so its 5 V rail (POWER_STATUS Vcc) reads ~4.2 V on the Pi's USB
#      alone and ~5 V with the battery in. Full signal to a powered ESC would
#      just run the motor flat out.
#   2. The chosen outputs are taken off their thruster functions (DO_SET_SERVO
#      only drives a free output) and set to full signal.
#   3. The operator plugs the battery in; the Pi sees the rail jump, waits
#      ESC_TOP_WAIT_S (the ESC's start-up tune + "beep-beep"), sets minimum,
#      waits for the confirmation beeps, and puts the thrusters back with the
#      range 1000–2000 saved.
#
# The outputs always go back: at the end, on cancel, if no battery is seen in
# ESC_WAIT_BATTERY_S, by a timeout, and — if the Pi restarted in the middle —
# when the backend next sees the Pixhawk.
ESC_CAL_FILE = DATA_DIR / "esc_calibration.json"
ESC_CAL_TIMEOUT_S = 180
ESC_WAIT_BATTERY_S = 120
ESC_TOP_WAIT_S = 4.0                  # battery in → minimum (after the "beep-beep", before the menu)
ESC_CONFIRM_S = 5.0                   # minimum → done (the ESC's confirmation beeps)
BOARD_V_UNPLUGGED_MAX = 4.6           # Pixhawk 5 V rail at or below this: running off the Pi's USB
BOARD_V_BATTERY_IN = 4.7              # …at or above this: the battery is in
ESC_PWM_LOW, ESC_PWM_HIGH = 1000, 2000
_esc = {"active": False, "outputs": [], "functions": {}, "phase": None, "message": None, "t": 0.0, "cancel": False}
_esc_lock = __import__("threading").Lock()


class EscCalRequest(BaseModel):
    step: str = Field(..., description="auto | cancel")
    outputs: list[int] = [1, 3]
    trim: int = Field(ESC_PWM_LOW, description="Stopped: 1000 for forward-only ESCs, 1500 for forward/reverse")


def _set_output(n, pwm):
    result = link.command_long(183, [n, pwm])             # MAV_CMD_DO_SET_SERVO
    if result != 0:
        raise LinkError(f"The Pixhawk refused to set output {n} to {pwm} µs (result {result}).")


def _board_v():
    """The Pixhawk's 5 V rail (volts), or None if no fresh POWER_STATUS."""
    s = link.snapshot()
    return s.get("board_v") if s.get("board_v") and time.time() - (s.get("board_v_t") or 0) < 5 else None


def _esc_restore(trim=ESC_PWM_LOW, why="finished"):
    """Outputs to minimum, thruster functions back (and, finished, the range saved). Lock held."""
    for n in _esc["outputs"]:
        try:
            _set_output(n, ESC_PWM_LOW)
        except LinkError:
            pass
    for n, fn in _esc["functions"].items():
        link.set_param(f"SERVO{n}_FUNCTION", fn)
    if why == "finished":
        for n in _esc["outputs"]:
            link.set_param(f"SERVO{n}_MIN", ESC_PWM_LOW)
            link.set_param(f"SERVO{n}_MAX", ESC_PWM_HIGH)
            link.set_param(f"SERVO{n}_TRIM", trim)
    log.info("ESC calibration %s: outputs %s restored to functions %s", why, _esc["outputs"], _esc["functions"])
    _esc.update(active=False, outputs=[], functions={})
    try:
        ESC_CAL_FILE.unlink()
    except OSError:
        pass


def _esc_phase(phase, message):
    _esc.update(phase=phase, message=message, t=time.time())
    log.info("ESC calibration: %s", message)


def _esc_auto(trim):
    """The timed part, in its own thread (see above)."""
    def wait(secs):
        end = time.time() + secs
        while time.time() < end:
            if _esc["cancel"]:
                return False
            _esc["t"] = time.time()
            time.sleep(0.1)
        return True

    try:
        link.command_long(511, [125, 200000])         # SET_MESSAGE_INTERVAL: POWER_STATUS at 5 Hz
    except LinkError:
        pass
    end = time.time() + ESC_WAIT_BATTERY_S
    plugged = False
    while time.time() < end and not _esc["cancel"]:
        _esc["t"] = time.time()
        v = _board_v()
        if v is not None and v >= BOARD_V_BATTERY_IN:
            plugged = True
            break
        time.sleep(0.1)
    with _esc_lock:
        if not _esc["active"]:
            return
        if not plugged:
            why = "cancelled" if _esc["cancel"] else "no battery"
            try:
                _esc_restore(why=why)
            except LinkError as exc:
                log.warning("ESC calibration: could not restore the outputs yet: %s", exc)
            _esc_phase(why, "Cancelled — thrusters back on their outputs." if why == "cancelled" else
                       f"No battery seen in {ESC_WAIT_BATTERY_S} s — cancelled, thrusters back on their outputs.")
            return
        _esc_phase("top", f"Battery in (Pixhawk {_board_v():.2f} V). Holding full signal {ESC_TOP_WAIT_S:g} s for the ESC's beep-beep…")
    done_top = wait(ESC_TOP_WAIT_S)
    with _esc_lock:
        try:
            for n in _esc["outputs"]:
                _set_output(n, ESC_PWM_LOW)
        except LinkError as exc:
            log.warning("ESC calibration: could not set minimum: %s", exc)
        if not done_top:
            _esc_restore(why="cancelled")
            _esc_phase("cancelled", "Cancelled — minimum sent, thrusters back on their outputs.")
            return
        _esc_phase("low", f"Minimum signal sent. Waiting {ESC_CONFIRM_S:g} s for the ESC's confirmation beeps…")
    wait(ESC_CONFIRM_S)
    with _esc_lock:
        try:
            outs = list(_esc["outputs"])
            _esc_restore(trim, "finished")
            _esc_phase("done", f"Done: output{'s' if len(outs) > 1 else ''} {', '.join(map(str, outs))} calibrated "
                               f"to {ESC_PWM_LOW}–{ESC_PWM_HIGH} µs, stopped at {trim} µs, thruster back on.")
        except LinkError as exc:
            _esc_phase("failed", f"Calibrated, but the thruster settings could not be put back yet: {exc}")


def _esc_watchdog():
    """Put the outputs back if a calibration is left half done (timeout, or a Pi restart)."""
    while True:
        time.sleep(2)
        with _esc_lock:
            if not _esc["active"] and ESC_CAL_FILE.exists() and link.fc_connected:
                try:
                    saved = json.loads(ESC_CAL_FILE.read_text())
                    _esc.update(active=True, outputs=saved["outputs"], functions={int(k): v for k, v in saved["functions"].items()})
                    _esc_restore(why="restored after a restart")
                except (OSError, ValueError, KeyError, LinkError) as exc:
                    log.warning("Could not restore the motor outputs after an ESC calibration: %s", exc)
            elif _esc["active"] and time.time() - _esc["t"] > ESC_CAL_TIMEOUT_S:
                try:
                    _esc_restore(why="timed out")
                    _esc_phase("timed out", "Timed out — thrusters back on their outputs.")
                except LinkError as exc:
                    log.warning("ESC calibration timeout: could not restore the outputs yet: %s", exc)


__import__("threading").Thread(target=_esc_watchdog, name="esc-cal", daemon=True).start()


@app.get("/api/pixhawk/esc_calibration")
def esc_calibration_status():
    v = _board_v()
    return {"active": _esc["active"], "phase": _esc["phase"], "message": _esc["message"], "outputs": _esc["outputs"],
            "board_v": v, "battery_in": None if v is None else v >= BOARD_V_BATTERY_IN}


@app.post("/api/pixhawk/esc_calibration")
def esc_calibration(body: EscCalRequest):
    """auto: with the battery UNPLUGGED, the outputs go to full signal; plug the
    battery in and the Pi does the rest (see above). cancel: stop, put back."""
    step = body.step.lower()
    if step == "cancel":
        if not _esc["active"]:
            return ok("No ESC calibration is running.")
        _esc["cancel"] = True
        return ok("Cancelling — the outputs go to minimum and the thrusters back on.")
    if step != "auto":
        return fail("step must be auto or cancel.")
    try:
        with _esc_lock:
            if link.snapshot()["armed"]:
                return fail("Disarm the boat first.")
            if _esc["active"]:
                return fail("A calibration is already running (cancel it first).")
            v = _board_v()
            if v is None:
                return fail("Can't read the Pixhawk's board voltage, so I can't check the battery is unplugged. Not starting.")
            if v > BOARD_V_UNPLUGGED_MAX:
                return fail(f"The battery looks connected (Pixhawk at {v:.2f} V). Unplug it first: full signal to a "
                            "powered ESC runs the motor flat out.")
            outputs = sorted({int(n) for n in body.outputs if 1 <= int(n) <= 8})
            if not outputs:
                return fail("Give the motor outputs, e.g. [1].")
            functions = {}
            for n in outputs:
                fn = link.get_param(f"SERVO{n}_FUNCTION")
                if fn is None:
                    return fail(f"Could not read SERVO{n}_FUNCTION.")
                functions[n] = fn
            ESC_CAL_FILE.write_text(json.dumps({"outputs": outputs, "functions": functions}))
            _esc.update(active=True, outputs=outputs, functions=functions, cancel=False)
            _esc_phase("waiting", f"Outputs {', '.join(map(str, outputs))} at full signal. Plug the battery in now "
                                  f"(within {ESC_WAIT_BATTERY_S} s).")
            for n in outputs:
                link.set_param(f"SERVO{n}_FUNCTION", 0)
            for n in outputs:
                _set_output(n, ESC_PWM_HIGH)
            trim = max(ESC_PWM_LOW, min(1500, int(body.trim)))
            __import__("threading").Thread(target=_esc_auto, args=(trim,), name="esc-auto", daemon=True).start()
            return ok(_esc["message"], board_v=v)
    except LinkError as exc:
        with _esc_lock:
            if _esc["active"]:
                try:
                    _esc_restore(why="failed to start")
                except LinkError:
                    pass
        return fail(str(exc))


@app.post("/api/pixhawk/failsafe/fix")
def pixhawk_failsafe_fix():
    """The failsafe on (game controller: the Pi's heartbeat; transmitter: the radio),
    and HOLD (stop) as its action if it was set to do nothing."""
    try:
        changed = []
        name = "FS_GCS_ENABLE" if cfg["rc_source"] == "gamepad" else "FS_THR_ENABLE"
        if link.get_param(name) == 0:
            link.set_param(name, 1)
            changed.append(f"{name} = 1")
        if link.get_param("FS_ACTION") == 0:
            link.set_param("FS_ACTION", 2)
            changed.append("FS_ACTION = 2 (hold)")
        return ok("Changed: " + ", ".join(changed) if changed else "Nothing to change.", report=failsafe_report())
    except LinkError as exc:
        return fail(str(exc))


# ---------------------------------------------------------------------------- boat control
@app.post("/api/mavlink/arm")
def mavlink_arm(body: ArmRequest):
    want = (not link.snapshot()["armed"]) if body.arm is None else body.arm
    if want and _esc["active"]:
        return fail("An ESC calibration is running: finish or cancel it first.")
    vision.operator("arm" if want else "disarm")
    live.operator("arm" if want else "disarm")
    return run(lambda: link.arm(want))


@app.post("/api/mavlink/mode")
def mavlink_mode(body: ModeRequest):
    vision.operator(f"mode {body.mode.upper()}")
    live.operator(f"mode {body.mode.upper()}")
    return run(lambda: link.set_mode(body.mode))


@app.post("/api/mavlink/hold")
def mavlink_hold():
    vision.operator("hold")
    live.operator("hold")
    return run(lambda: link.set_mode("HOLD"), "Holding position.")


@app.post("/api/mavlink/rtl")
def mavlink_rtl():
    vision.operator("return home")
    live.operator("return home")
    return run(lambda: link.set_mode("RTL"), "Returning to launch.")


@app.post("/api/mavlink/stop")
def mavlink_stop():
    """Emergency stop: HOLD (motors stop) and disarm. Tries both even if one fails."""
    vision.operator("emergency stop")
    live.operator("emergency stop")
    notes, okay = [], True
    try:
        collector.set(False, "safety")
    except LinkError:
        pass
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


def brake():
    """Instant brake (L1 + R1 on the controller): sticks to neutral and force-disarm
    first, so the motors stop at once; then the roller off and HOLD."""
    notes, okay = [], True
    drive.brake()
    try:
        if link.brake_disarm():
            notes.append("Disarmed.")
        else:
            okay = False
            notes.append("The Pixhawk did not report disarmed.")
    except LinkError as exc:
        okay = False
        notes.append(str(exc))
    vision.operator("brake")
    live.operator("brake")
    try:
        collector.set(False, "safety")
    except LinkError:
        pass
    try:
        link.set_mode("HOLD")
    except LinkError:
        pass                                 # disarmed is what matters
    return (ok if okay else fail)("Brake: " + " ".join(notes))


@app.post("/api/mavlink/brake")
def mavlink_brake():
    return brake()


@app.get("/api/mavlink/status")
def mavlink_status():
    s = link.snapshot()
    return {"mode": s["flight_mode"], "armed": s["armed"], "fc_connected": s["fc_connected"]}


# ---------------------------------------------------------------------------- missions
# ---------------------------------------------------------------------------- live collect
class LiveTarget(BaseModel):
    id: str
    lat: float
    lng: float
    source: Optional[str] = None
    confidence: Optional[float] = None


class LiveTargetsRequest(BaseModel):
    targets: list[LiveTarget]


class LiveStartRequest(BaseModel):
    when_empty: str = "wait"            # wait (hold here for more) | return (home after live_return_after_s)
    speed_mps: Optional[float] = None


class LiveStopRequest(BaseModel):
    rtl: bool = False


class LiveSkipRequest(BaseModel):
    id: str


class CollectorRequest(BaseModel):
    on: Optional[bool] = None            # None: toggle (the controller's R1)


@app.post("/api/collector")
def collector_set(body: CollectorRequest):
    """Run / stop the intake roller (R1 on the game controller toggles it)."""
    return run(lambda: collector.toggle() if body.on is None else collector.set(body.on))


@app.get("/api/live/status")
def live_status():
    return live.summary(full=True)


@app.post("/api/live/targets")
def live_targets(body: LiveTargetsRequest):
    if len(body.targets) > 200:
        return fail("Send at most 200 items at a time.")
    items = [t.model_dump() if hasattr(t, "model_dump") else t.dict() for t in body.targets]
    res = live.add_targets(items)
    n = len(res["added"])
    return ok(f"{n} new item{'s' if n != 1 else ''}"
              + (f", {len(res['merged'])} merged" if res["merged"] else "")
              + (f", {len(res['rejected'])} refused" if res["rejected"] else ""), **res)


@app.post("/api/live/start")
def live_start(body: LiveStartRequest):
    return run(lambda: live.start(body.when_empty, body.speed_mps))


@app.post("/api/live/pause")
def live_pause():
    vision.operator("live collect paused")
    return run(live.pause)


@app.post("/api/live/stop")
def live_stop(body: LiveStopRequest):
    vision.operator("live collect stopped")
    return run(lambda: live.stop(body.rtl))


@app.post("/api/live/skip")
def live_skip(body: LiveSkipRequest):
    return run(lambda: live.skip(body.id))


@app.post("/api/live/clear")
def live_clear():
    return run(lambda: f"Cleared {live.clear()} items.")


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
    return ok(f"Mission '{plan['name']}' uploaded to the Pixhawk and checked — {len(plan['waypoints'])} items to collect.",
              mission=missions.status())


@app.post("/api/mission/start")
def mission_start():
    if live.state in ("running", "returning"):
        return fail("Live collect is running. Pause or stop it before starting a planned mission.")
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
        "rc_source": cfg["rc_source"],
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
@app.get("/api/sim/servo")
def sim_servo():
    """SIM only: the signal on each free output (set with DO_SET_SERVO), e.g. the roller."""
    if not sim_boat:
        return JSONResponse({"success": False, "message": "Only available in the simulator."}, status_code=404)
    return {"outputs": {str(k): v for k, v in sim_boat.servo_out.items()}}


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
    # No access log: the app makes several requests a second (vision, telemetry),
    # and logging each one costs a Pi Zero CPU time and wears its SD card.
    server = uvicorn.Server(uvicorn.Config("main:app", host=args.host, port=port, log_level="info",
                                           access_log=False, timeout_graceful_shutdown=3))
    server.run(sockets=[listen_socket(args.host, port)])


# Linux lets a connection queue up to 4 MB of unsent data. On the boat's Wi-Fi
# that is many seconds of old video waiting to go out, so the live view falls
# further and further behind. A small send buffer keeps at most a couple of
# frames in flight: the stream skips stale frames and stays live. Small API
# replies don't notice.
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
