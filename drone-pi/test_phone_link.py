"""
End-to-end test of the phone link, all on this computer:

    simulated vehicle (stands in for the ESP32) <--UDP--> relay.py <--UDP--> backend (udpout)
    fake "IP Webcam" MJPEG server ------------HTTP-------------> backend (camera_url)

Checks that telemetry arrives through the relay, a command goes back to the
vehicle, the relay's DroneBridge poke is valid MAVLink, and the phone's video
reaches /video_feed and the snapshot. Run:  python test_phone_link.py
"""

import importlib.util
import json
import os
import socket
import subprocess
import sys
import threading
import time
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

HERE = os.path.dirname(os.path.abspath(__file__))
BOAT = os.path.join(HERE, "..", "boat-pi")
FC_PORT, GCS_PORT, CAM_PORT, API_PORT, ESP_PORT = 14650, 14651, 8091, 8011, 14652


def _load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    mod = importlib.util.module_from_spec(spec)
    sys.modules[name] = mod
    spec.loader.exec_module(mod)
    return mod


def check(cond, what):
    print(("  PASS  " if cond else "  FAIL  ") + what, flush=True)
    if not cond:
        raise SystemExit(1)


def make_jpegs():
    """A few 640x480 JPEGs from ffmpeg's test pattern."""
    out = subprocess.run(["ffmpeg", "-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i",
                          "testsrc2=size=640x480:rate=10", "-frames:v", "10", "-c:v", "mjpeg", "-f", "mjpeg",
                          "pipe:1"], capture_output=True, check=True).stdout
    frames, i = [], 0
    while True:
        s = out.find(b"\xff\xd8", i)
        e = out.find(b"\xff\xd9", s + 2)
        if s < 0 or e < 0:
            return frames
        frames.append(out[s:e + 2])
        i = e + 2


def camera_server(frames):
    class H(BaseHTTPRequestHandler):
        def log_message(self, *a):
            pass

        def do_GET(self):
            if self.path != "/video":
                self.send_response(404)
                self.end_headers()
                return
            self.send_response(200)
            self.send_header("Content-Type", "multipart/x-mixed-replace;boundary=Ba4oTvQMY8ew04N8dcnM")
            self.end_headers()
            try:
                n = 0
                while True:
                    f = frames[n % len(frames)]
                    self.wfile.write(b"--Ba4oTvQMY8ew04N8dcnM\r\nContent-Type: image/jpeg\r\n"
                                     + f"Content-Length: {len(f)}\r\n\r\n".encode() + f + b"\r\n")
                    n += 1
                    time.sleep(0.1)
            except OSError:
                pass

    srv = ThreadingHTTPServer(("127.0.0.1", CAM_PORT), H)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    return srv


def get(path, timeout=5):
    with urllib.request.urlopen(f"http://127.0.0.1:{API_PORT}{path}", timeout=timeout) as r:
        return r.read()


def post(path, body):
    req = urllib.request.Request(f"http://127.0.0.1:{API_PORT}{path}", data=json.dumps(body).encode(),
                                 headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=10) as r:
        return json.loads(r.read())


def main():
    relay_mod = _load("phone_relay", os.path.join(HERE, "phone-link", "relay.py"))
    from pymavlink.dialects.v20 import ardupilotmega as mav
    parser = mav.MAVLink(None)
    parser.robust_parsing = True
    msgs = parser.parse_buffer(relay_mod.mavlink1_heartbeat(7)) or []
    check(len(msgs) == 1 and msgs[0].get_type() == "HEARTBEAT" and msgs[0].type == 6,
          "relay's DroneBridge poke is a valid MAVLink GCS heartbeat")

    sample = "\n".join([
        "1: lo    inet 127.0.0.1/8 scope host lo",
        "14: rmnet_data2    inet 10.45.12.7/30 scope global rmnet_data2",
        "40: wt0    inet 100.99.10.5/16 brd 100.99.255.255 scope global wt0",
        "33: swlan0    inet 192.168.43.1/24 brd 192.168.43.255 scope global swlan0",
    ])
    hosts = relay_mod.hotspot_hosts(sample)
    check(len(hosts) == 253 and "192.168.43.2" in hosts and "192.168.43.1" not in hosts
          and not any(h.startswith(("10.", "100.", "127.")) for h in hosts),
          "relay searches only the hotspot network (not mobile data, NetBird or itself)")

    cam = camera_server(make_jpegs())
    _load("mav_link", os.path.join(BOAT, "mav_link.py"))
    SimBoat = _load("sim_vehicle", os.path.join(BOAT, "sim_vehicle.py")).SimBoat
    procs = []
    sim = None
    try:
        env = dict(os.environ, DRONE_DATA_DIR=os.path.join(HERE, "data"))
        procs.append(subprocess.Popen([sys.executable, "main.py", "--port", str(API_PORT),
                                       "--connection", f"udpout:127.0.0.1:{GCS_PORT}",
                                       "--camera-url", f"http://127.0.0.1:{CAM_PORT}/video"],
                                      cwd=HERE, env=env))
        # The backend starts first and must pick the drone up once the phone side appears.
        time.sleep(4)
        procs.append(subprocess.Popen([sys.executable, os.path.join(HERE, "phone-link", "relay.py"),
                                       "--fc-port", str(FC_PORT), "--gcs-port", str(GCS_PORT),
                                       "--esp", "127.0.0.1", "--esp-port", str(ESP_PORT)]))
        time.sleep(1)
        # The "ESP32" waits at a fixed address until the relay pokes it (relay --esp).
        sim = SimBoat(17.4239, 78.4738, f"udpin:127.0.0.1:{ESP_PORT}")
        sim.start()
        t0, tel = time.time(), {}
        while time.time() - t0 < 40:
            try:
                tel = json.loads(get("/api/telemetry"))
                if tel.get("fc_connected") and tel.get("lat") is not None:
                    break
            except Exception:
                pass
            time.sleep(1)
        connected = tel.get("fc_connected") or tel.get("connected")
        check(bool(connected), f"telemetry through the relay after {time.time() - t0:.0f}s "
                               f"(lat {tel.get('lat')}, lng {tel.get('lng') or tel.get('lon')})")

        # LOITER is mode 5 for ArduCopter and for the simulated Rover alike.
        r = post("/api/mavlink/mode", {"mode": "LOITER"})
        time.sleep(3)
        tel = json.loads(get("/api/telemetry"))
        check(r.get("success") and "LOITER" in str(tel.get("mode")),
              f"command back to the vehicle through the relay: {r.get('message')!r}, mode now {tel.get('mode')}")

        body = b""
        with urllib.request.urlopen(f"http://127.0.0.1:{API_PORT}/video_feed", timeout=15) as r:
            t0 = time.time()
            while body.count(b"\xff\xd9") < 5 and time.time() - t0 < 15:
                body += r.read1(65536)
        check(body.count(b"\xff\xd9") >= 5, "phone video arrives on /video_feed")
        snap = get("/api/camera/snapshot", timeout=10)
        check(snap[:2] == b"\xff\xd8", f"snapshot is a JPEG ({len(snap)} bytes)")
        st = json.loads(get("/api/camera/status"))
        print("  camera:", {k: st.get(k) for k in ("status_text", "source", "pipeline", "resolution", "codec",
                                                  "measured_fps", "last_error")})
        check(st.get("source") == "url" and st.get("codec") == "mjpeg" and st.get("resolution") == "640x480",
              "camera status: phone source, MJPEG, 640x480")
    finally:
        if sim:
            sim.stop()
            sim = None
        for p in procs:
            p.terminate()
        for p in procs:
            try:
                p.wait(timeout=5)
            except Exception:
                p.kill()
        if sim:
            sim.stop()
        cam.shutdown()
    print("\nPHONE LINK TESTS PASSED")


if __name__ == "__main__":
    main()
