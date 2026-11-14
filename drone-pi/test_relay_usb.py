"""
Tests the phone relay's USB mode (ESP32 plugged into the phone) without a phone:

- the USB serial drivers (CH340, CP2102, ESP32-S3 native USB / CDC) against fake
  usbfs devices: the right setup requests, endpoints and bulk transfers;
- the CH340 baud divisor against known values;
- MAVLink framing of a stream cut at random places, with junk before it;
- the whole relay in USB mode: drone telemetry reaches a ground station over UDP
  and a command from it reaches the USB side.

Run:  python test_relay_usb.py
"""

import ctypes
import errno
import importlib.util
import os
import random
import socket
import struct
import sys
import tempfile
import threading
import time

HERE = os.path.dirname(os.path.abspath(__file__))


def _load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    mod = importlib.util.module_from_spec(spec)
    sys.modules[name] = mod
    spec.loader.exec_module(mod)
    return mod


relay = _load("phone_relay", os.path.join(HERE, "phone-link", "relay.py"))


def check(cond, what):
    print(("  PASS  " if cond else "  FAIL  ") + what, flush=True)
    if not cond:
        raise SystemExit(1)


# ---- fake USB devices -------------------------------------------------------

def descriptors(vid, pid, interfaces):
    """Device + one configuration descriptor. interfaces: [(num, class, [(ep, attrs, maxp)])]."""
    body = b""
    for num, cls, eps in interfaces:
        body += bytes([9, 4, num, 0, len(eps), cls, 0, 0, 0])
        for ep, attrs, maxp in eps:
            body += bytes([7, 5, ep, attrs]) + struct.pack("<H", maxp) + bytes([0])
    config = bytes([9, 2]) + struct.pack("<H", 9 + len(body)) + bytes([len(interfaces), 1, 0, 0x80, 50])
    device = bytes([18, 1, 0, 2, 0, 0, 0, 64]) + struct.pack("<HHH", vid, pid, 0x100) + bytes([1, 2, 0, 1])
    return device + config + body


CH340 = descriptors(0x1A86, 0x7523, [(0, 0xFF, [(0x82, 2, 32), (0x02, 2, 32), (0x81, 3, 8)])])
CP2102 = descriptors(0x10C4, 0xEA60, [(0, 0xFF, [(0x81, 2, 64), (0x01, 2, 64)])])
ESP32S3 = descriptors(0x303A, 0x1001, [(0, 0x02, [(0x82, 3, 64)]),
                                       (1, 0x0A, [(0x01, 2, 64), (0x81, 2, 64)]),
                                       (2, 0xFF, [(0x02, 2, 64), (0x83, 2, 64)])])


class FakeUsbfs:
    """Stands in for libc.ioctl on a usbfs device file."""

    def __init__(self, ch340_version=0x31, busy_ifaces=()):
        self.controls, self.claimed, self.written, self.detached = [], [], [], []
        self.incoming = []              # packets the device will send
        self.version = ch340_version
        self.busy = set(busy_ifaces)    # interfaces a kernel driver holds

    def ioctl(self, fd, request, arg):
        if request == relay.USBDEVFS_CLAIMINTERFACE:
            num = ctypes.c_uint.from_address(arg).value
            if num in self.busy:
                ctypes.set_errno(errno.EBUSY)
                return -1
            self.claimed.append(num)
            return 0
        if request == relay.USBDEVFS_IOCTL:
            req = relay._UsbIoctl.from_address(arg)
            if req.ioctl_code == relay.USBDEVFS_DISCONNECT:
                self.busy.discard(req.ifno)
                self.detached.append(req.ifno)
            return 0
        if request == relay.USBDEVFS_CONTROL:
            x = relay._CtrlTransfer.from_address(arg)
            out = ctypes.string_at(x.data, x.wLength) if x.wLength and not x.bRequestType & 0x80 else b""
            self.controls.append((x.bRequestType, x.bRequest, x.wValue, x.wIndex, x.wLength, out))
            if x.bRequestType & 0x80:
                reply = bytes([self.version, 0])[:x.wLength]
                ctypes.memmove(x.data, reply, len(reply))
                return len(reply)
            return x.wLength
        if request == relay.USBDEVFS_BULK:
            x = relay._BulkTransfer.from_address(arg)
            if x.ep & 0x80:
                if not self.incoming:
                    time.sleep(0.01)
                    ctypes.set_errno(errno.ETIMEDOUT)
                    return -1
                pkt = self.incoming.pop(0)[:x.len]
                ctypes.memmove(x.data, pkt, len(pkt))
                return len(pkt)
            self.written.append((x.ep, ctypes.string_at(x.data, x.len)))
            return x.len
        ctypes.set_errno(errno.EINVAL)
        return -1


def open_device(raw, fake):
    path = os.path.join(tempfile.mkdtemp(), "usbdev")
    with open(path, "wb") as f:
        f.write(raw)
    fd = os.open(path, os.O_RDONLY | getattr(os, "O_BINARY", 0))
    return relay.UsbSerial(fd, 115200, libc=fake)


# ---- MAVLink test data ------------------------------------------------------

def mav():
    from pymavlink.dialects.v20 import ardupilotmega as m
    link = m.MAVLink(None, srcSystem=1, srcComponent=1)
    return m, link


def main():
    print("Drivers")
    fake = FakeUsbfs(ch340_version=0x31)
    dev = open_device(CH340, fake)
    check(dev.kind == "ch34x" and (dev.ep_in, dev.ep_out, dev.in_size) == (0x82, 0x02, 32),
          f"CH340 found: {dev.describe()}, bulk in 0x82 / out 0x02")
    want = [(0xC0, 0x5F, 0, 0, 2, b""), (0x40, 0xA1, 0, 0, 0, b""), (0x40, 0x9A, 0x1312, 0xCC83, 0, b""),
            (0x40, 0x9A, 0x2518, 0xC3, 0, b""), (0x40, 0xA4, 0xFFFF, 0, 0, b"")]
    check(fake.controls == want, "CH340 setup: version, init, 115200 (no-buffering bit), 8N1, DTR/RTS off")
    old = FakeUsbfs(ch340_version=0x27)
    open_device(CH340, old)
    check([c[:4] for c in old.controls] == [(0xC0, 0x5F, 0, 0), (0x40, 0xA1, 0, 0), (0x40, 0x9A, 0x1312, 0xCC03),
                                           (0x40, 0xA4, 0xFFFF, 0)],
          "older CH340 (version 0x27): no LCR write, no no-buffering bit")

    fake = FakeUsbfs()
    dev = open_device(CP2102, fake)
    check(dev.kind == "cp210x" and fake.controls == [
        (0x41, 0x00, 0x0001, 0, 0, b""), (0x41, 0x1E, 0, 0, 4, struct.pack("<I", 115200)),
        (0x41, 0x03, 0x0800, 0, 0, b"")], "CP2102 setup: enable, 115200, 8N1")

    fake = FakeUsbfs(busy_ifaces={0, 1})
    dev = open_device(ESP32S3, fake)
    check(dev.kind == "cdc" and dev.iface == 1 and (dev.ep_in, dev.ep_out) == (0x81, 0x01)
          and sorted(fake.claimed) == [0, 1] and sorted(fake.detached) == [0, 1],
          "ESP32-S3 native USB: CDC data interface 1 (not the JTAG one), kernel driver detached")
    check(fake.controls == [(0x21, 0x20, 0, 0, 7, struct.pack("<IBBB", 115200, 0, 0, 8)),
                            (0x21, 0x22, 0x0003, 0, 0, b"")], "CDC setup: line coding 115200 8N1, DTR+RTS on")

    bad = descriptors(0x0403, 0x6001, [(0, 0xFF, [(0x81, 2, 64), (0x02, 2, 64)])])
    try:
        open_device(bad, FakeUsbfs())
        check(False, "unsupported chip refused")
    except OSError as exc:
        check("not a supported serial chip" in str(exc), f"unsupported chip refused: {exc}")

    dev = open_device(CP2102, FakeUsbfs())
    dev.libc.incoming.append(b"abc")
    check(dev.read() == b"abc" and dev.read(timeout_ms=10) == b"", "bulk read: data, then empty on timeout")
    dev.write(b"x" * 5000)
    check([len(d) for _, d in dev.libc.written] == [4096, 904] and dev.libc.written[0][0] == 0x01,
          "bulk write: split into 4 KB transfers to the OUT endpoint")

    print("Baud divisor")
    # usb-serial-for-android's table of CH340 register values
    known = {2400: 0xD901, 4800: 0x6402, 9600: 0xB202, 19200: 0xD902, 38400: 0x6403, 115200: 0xCC03}
    got = {b: relay.ch341_divisor(b) for b in known}
    check(got == known, "CH340 divisors match Linux/usb-serial-for-android: "
          + ", ".join(f"{b}={v:#06x}" for b, v in got.items()))

    print("Framing")
    m, link = mav()
    msgs = [link.heartbeat_encode(2, 3, 0, 0, 4), link.attitude_encode(1000, 0.1, 0.2, 0.3, 0, 0, 0),
            link.gps_raw_int_encode(1, 3, 174239000, 784738000, 500000, 100, 100, 50, 0, 10)]
    frames = [msg.pack(link) for msg in msgs * 20]
    v1 = m.MAVLink(None)
    v1.WIRE_PROTOCOL_VERSION = "1.0"
    stream = b"ets Jun  8 2016 boot:0x13 (SPI_FAST_FLASH_BOOT)\r\n" + b"".join(frames)
    rng = random.Random(1)
    framer, out, i = relay.MavlinkFramer(), [], 0
    while i < len(stream):
        n = rng.randint(1, 64)
        out += framer.feed(stream[i:i + n])
        i += n
    check(out == frames, f"{len(frames)} messages cut back out of a stream split at random, boot text dropped")
    signed = bytearray(frames[0])
    signed[2] |= 0x01
    signed = bytes(signed) + bytes(13)
    check(relay.MavlinkFramer().feed(signed + frames[1]) == [signed, frames[1]], "signed MAVLink2 length")
    hb1 = bytes([0xFE, 9]) + bytes(4 + 9 + 2)
    check(relay.MavlinkFramer().feed(hb1 + frames[1]) == [hb1, frames[1]], "MAVLink1 length")

    print("Relay in USB mode")
    usb_side = FakeUsbfs()
    fake_dev = open_device(CP2102, usb_side)
    relay.UsbSerial = lambda fd, baud: fake_dev
    gcs_port = 14751
    old_argv, old_stdout = sys.argv, sys.stdout
    sys.argv = ["relay.py", "--usb-fd", "99", "--gcs-port", str(gcs_port), "--quiet"]
    threading.Thread(target=relay.main, daemon=True).start()
    time.sleep(0.5)
    sys.argv, sys.stdout = old_argv, old_stdout

    gcs = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    gcs.settimeout(0.2)
    gcs_link = m.MAVLink(None, srcSystem=255, srcComponent=190)
    gcs.sendto(gcs_link.heartbeat_encode(6, 8, 0, 0, 4).pack(gcs_link), ("127.0.0.1", gcs_port))
    time.sleep(0.3)
    drone = b"".join(frames[:6])
    for k in range(0, len(drone), 64):              # the device sends 64-byte USB packets
        usb_side.incoming.append(drone[k:k + 64])
    got, t0 = [], time.time()
    while len(got) < 6 and time.time() - t0 < 5:
        try:
            got.append(gcs.recvfrom(65535)[0])
        except socket.timeout:
            pass
    parser = m.MAVLink(None)
    types = [parser.decode(bytearray(p)).get_type() for p in got]
    check(got == frames[:6], f"drone -> ground station: 6 whole messages, one per UDP packet ({', '.join(types[:3])} ...)")

    cmd = gcs_link.command_long_encode(1, 1, 176, 0, 1, 5, 0, 0, 0, 0, 0).pack(gcs_link)   # DO_SET_MODE LOITER
    gcs.sendto(cmd, ("127.0.0.1", gcs_port))
    t0 = time.time()
    while not any(d == cmd for _, d in usb_side.written) and time.time() - t0 < 3:
        time.sleep(0.05)
    check(any(ep == 0x01 and d == cmd for ep, d in usb_side.written),
          "ground station -> drone: the command is written to the USB OUT endpoint")
    print("\nRELAY USB TESTS PASSED")


if __name__ == "__main__":
    main()
