"""
VARUNA phone relay: passes the drone's MAVLink between the ESP32 and the VARUNA
backend on the laptop (same Wi-Fi, or NetBird). The ESP32 is either plugged into the phone's USB-C
port (esp32_usb_bridge sketch) or on the phone's hotspot (DroneBridge).

    USB:   Pixhawk TELEM2 --UART--> ESP32 --USB-C cable--> phone (relay.py --usb-fd, via termux-usb)
    Wi-Fi: Pixhawk TELEM2 --UART--> ESP32 (DroneBridge) --hotspot Wi-Fi, UDP--> phone:14550
    then:  phone:14551 <--Wi-Fi (or NetBird), UDP-- laptop backend (--connection udpout:<phone IP>:14551)

USB mode is started by relay.sh, through termux-usb, which opens the USB device
and passes its file descriptor:  termux-usb -r -e "python relay.py --usb-fd" <device>
The USB serial chips of ESP32 boards are driven here directly (CDC-ACM for
ESP32-S3/C3 native USB and CH9102, CH340/CH341, CP210x), with no extra packages.

Why it is needed: the ESP32 hangs off the phone (USB, or the phone's hotspot,
which Android does not route onward), so the laptop can't reach it directly.
This script, running on the phone (Termux), is the bridge.

Plain Python 3 standard library, nothing to install:

    python relay.py                      # finds the ESP32 on the hotspot by itself
    python relay.py --esp 192.168.43.50  # or: the ESP32 has this fixed address

DroneBridge in Wi-Fi client mode sends nothing until a ground station sends it
a packet first; it then answers to where that packet came from. So the relay
"pokes" it with a GCS heartbeat: at --esp, or, without --esp, at every address
of the phone's hotspot network (read from its network interfaces) until the ESP32 answers.
The ESP32 side is then learned from the MAVLink arriving on --fc-port, the
backend side from the first packet on --gcs-port (the backend sends a heartbeat
every second, so it shows up at once). Any number of ground stations may connect
to --gcs-port (the VARUNA backend, Mission Planner, QGroundControl); each gets
everything the drone sends, and everything they send goes to the drone.
"""

import argparse
import ctypes
import errno
import ipaddress
import os
import select
import socket
import struct
import subprocess
import sys
import threading
import time

PEER_TIMEOUT_S = 15     # a ground station silent this long is dropped
STATUS_S = 10           # print a status line this often
POKE_S = 2              # poke the ESP32 this often until it answers
# Interfaces that are never the hotspot: loopback, mobile data, VPNs (NetBird is wt0).
NOT_HOTSPOT = ("lo", "rmnet", "ccmni", "clat", "v4-", "tun", "wt", "dummy", "ip6", "sit", "radio", "p2p")


def interfaces_ioctl():
    """(name, "address/24") of every IPv4 interface, read with the SIOCGIFCONF
    ioctl. It works where "ip addr" is refused: Termux from Google Play on
    recent Android may not open netlink sockets."""
    try:
        import array
        import fcntl                                     # not on Windows
    except ImportError:
        return []
    ifreq = 40 if struct.calcsize("P") == 8 else 32      # struct ifreq size
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        buf = array.array("B", bytes(ifreq * 64))
        req = struct.pack("iL", len(buf), buf.buffer_info()[0])
        n = struct.unpack("iL", fcntl.ioctl(s.fileno(), 0x8912, req))[0]   # SIOCGIFCONF
        raw = buf.tobytes()[:n]
    except Exception:
        return []
    finally:
        s.close()
    out = []
    for i in range(0, len(raw) - ifreq + 1, ifreq):
        name = raw[i:i + 16].split(b"\0", 1)[0].decode("ascii", "replace")
        out.append((name, socket.inet_ntoa(raw[i + 20:i + 24]) + "/24"))
    return out


def interfaces_ip(ip_output=None):
    """(name, "address/prefix") from "ip -4 -o addr" output (run it if not given)."""
    if ip_output is None:
        try:
            ip_output = subprocess.run(["ip", "-4", "-o", "addr"], capture_output=True, text=True,
                                       timeout=3).stdout
        except Exception:
            return []
    out = []
    for line in ip_output.splitlines():
        parts = line.split()
        if "inet" in parts and len(parts) >= 4:
            out.append((parts[1].rstrip(":"), parts[parts.index("inet") + 1]))
    return out


def hotspot_hosts(ip_output=None):
    """Every other address of the phone's own Wi-Fi/hotspot networks (/24 around
    the phone's address). Empty if the interfaces can't be read."""
    pairs = interfaces_ip(ip_output) if ip_output is not None else (interfaces_ioctl() or interfaces_ip())
    hosts = []
    for name, cidr in pairs:
        if name.startswith(NOT_HOTSPOT):
            continue
        try:
            iface = ipaddress.ip_interface(cidr)
        except ValueError:
            continue
        if not iface.ip.is_private or iface.ip in ipaddress.ip_network("100.64.0.0/10"):
            continue
        net = ipaddress.ip_network(f"{iface.ip}/{max(iface.network.prefixlen, 24)}", strict=False)
        hosts += [str(h) for h in net.hosts() if h != iface.ip and str(h) not in hosts]
    return hosts


def mavlink1_heartbeat(seq):
    """A MAVLink 1 GCS heartbeat (system 250, component 190), used only to make
    DroneBridge register this phone as a UDP client when --esp is given."""
    payload = struct.pack("<IBBBBB", 0, 6, 8, 0, 4, 3)  # custom_mode, GCS, INVALID, 0, ACTIVE, version 3
    head = bytes([len(payload), seq & 0xFF, 250, 190, 0])
    crc = 0xFFFF
    for b in head + payload + bytes([50]):              # 50 = HEARTBEAT crc_extra
        tmp = b ^ (crc & 0xFF)
        tmp = (tmp ^ (tmp << 4)) & 0xFF
        crc = ((crc >> 8) ^ (tmp << 8) ^ (tmp << 3) ^ (tmp >> 4)) & 0xFFFF
    return b"\xfe" + head + payload + struct.pack("<H", crc)


def is_mavlink(data):
    return bool(data) and data[0] in (0xFE, 0xFD)


# ---- USB: the ESP32 plugged into the phone ----------------------------------

USB_BAUD = 115200       # must match USB_BAUD in esp32_usb_bridge.ino


class _CtrlTransfer(ctypes.Structure):      # struct usbdevfs_ctrltransfer
    _fields_ = [("bRequestType", ctypes.c_uint8), ("bRequest", ctypes.c_uint8),
                ("wValue", ctypes.c_uint16), ("wIndex", ctypes.c_uint16), ("wLength", ctypes.c_uint16),
                ("timeout", ctypes.c_uint32), ("data", ctypes.c_void_p)]


class _BulkTransfer(ctypes.Structure):      # struct usbdevfs_bulktransfer
    _fields_ = [("ep", ctypes.c_uint), ("len", ctypes.c_uint), ("timeout", ctypes.c_uint),
                ("data", ctypes.c_void_p)]


class _UsbIoctl(ctypes.Structure):          # struct usbdevfs_ioctl
    _fields_ = [("ifno", ctypes.c_int), ("ioctl_code", ctypes.c_int), ("data", ctypes.c_void_p)]


def _ioc(direction, nr, size):              # Linux _IOC('U', nr, size); write = 1, read = 2
    return (direction << 30) | (size << 16) | (ord("U") << 8) | nr


USBDEVFS_CONTROL = _ioc(3, 0, ctypes.sizeof(_CtrlTransfer))
USBDEVFS_BULK = _ioc(3, 2, ctypes.sizeof(_BulkTransfer))
USBDEVFS_CLAIMINTERFACE = _ioc(2, 15, ctypes.sizeof(ctypes.c_uint))
USBDEVFS_IOCTL = _ioc(3, 18, ctypes.sizeof(_UsbIoctl))
USBDEVFS_DISCONNECT = _ioc(0, 22, 0)


def parse_usb_descriptors(raw):
    """(vendor id, product id, interfaces) from the descriptors read from a usbfs
    device file. Each interface: {"num", "cls", "eps": [(address, attributes, max packet)]};
    only the first configuration and alternate setting 0."""
    if len(raw) < 18 or raw[1] != 1:
        raise ValueError("not a USB device descriptor")
    vid, pid = struct.unpack_from("<HH", raw, 8)
    interfaces, cur, configs, i = [], None, 0, raw[0]
    while i + 2 <= len(raw):
        length, kind = raw[i], raw[i + 1]
        if length < 2 or i + length > len(raw):
            break
        if kind == 2:                                        # configuration
            configs += 1
            if configs > 1:
                break
        elif kind == 4 and length >= 9:                      # interface
            cur = {"num": raw[i + 2], "cls": raw[i + 5], "eps": []} if raw[i + 3] == 0 else None
            if cur is not None:
                interfaces.append(cur)
        elif kind == 5 and length >= 7 and cur is not None:  # endpoint
            cur["eps"].append((raw[i + 2], raw[i + 3], struct.unpack_from("<H", raw, i + 4)[0] & 0x7FF))
        i += length
    return vid, pid, interfaces


def ch341_divisor(baud):
    """CH340/CH341 divisor register value for a baud rate (as Linux's ch341.c)."""
    clk = 48000000

    def clk_div(ps, fact):
        return 1 << (12 - 3 * ps - fact)

    baud = max(46, min(baud, 2000000))
    ps = 0
    for ps in (3, 2, 1, 0):
        if baud > clk // (clk_div(ps, 1) * 512):
            break
    fact = 1
    cd = clk_div(ps, fact)
    div = clk // (cd * baud)
    if div < 9 or div > 255:
        div //= 2
        cd *= 2
        fact = 0
    if 16 * clk // (cd * div) - 16 * baud >= 16 * baud - 16 * clk // (cd * (div + 1)):
        div += 1
    if fact == 1 and div % 2 == 0:
        div //= 2
        fact = 0
    return (0x100 - div) << 8 | fact << 2 | ps


class UsbSerial:
    """A USB serial chip through an Android usbfs file descriptor (from termux-usb)."""

    def __init__(self, fd, baud=USB_BAUD, libc=None):
        self.fd = fd
        self.libc = libc or self._load_libc()
        os.lseek(fd, 0, os.SEEK_SET)
        self.vid, self.pid, interfaces = parse_usb_descriptors(os.read(fd, 4096))

        def bulk_pair(iface):
            ins = [e for e in iface["eps"] if e[1] & 3 == 2 and e[0] & 0x80]
            outs = [e for e in iface["eps"] if e[1] & 3 == 2 and not e[0] & 0x80]
            return (ins[0], outs[0]) if ins and outs else None

        cdc_data = [f for f in interfaces if f["cls"] == 0x0A and bulk_pair(f)]
        if cdc_data:
            self.kind, data = "cdc", cdc_data[0]
        elif self.vid == 0x1A86:
            self.kind = "ch34x"
        elif self.vid == 0x10C4:
            self.kind = "cp210x"
        else:
            raise OSError(f"USB device {self.vid:04x}:{self.pid:04x} is not a supported serial chip "
                          "(CDC, CH340/CH341, CP210x)")
        if self.kind != "cdc":
            usable = [f for f in interfaces if bulk_pair(f)]
            if not usable:
                raise OSError(f"USB device {self.vid:04x}:{self.pid:04x} has no bulk endpoints")
            data = usable[0]
        (self.ep_in, _, self.in_size), (self.ep_out, _, _) = bulk_pair(data)
        self.iface = data["num"]

        self._claim(self.iface)
        if self.kind == "cdc":
            comm = [f["num"] for f in interfaces if f["cls"] == 0x02]
            comm_if = comm[0] if comm else max(self.iface - 1, 0)
            if comm_if != self.iface:
                self._claim(comm_if)
            try:    # SET_LINE_CODING 8N1; native-USB ESP32s ignore the speed
                self._control(0x21, 0x20, 0, comm_if, struct.pack("<IBBB", baud, 0, 0, 8))
            except OSError:
                pass
            # SET_CONTROL_LINE_STATE: DTR and RTS both on. Some CDC stacks send only
            # while DTR is on; the ESP32 auto-reset circuit doesn't reset with both on.
            self._control(0x21, 0x22, 0x0003, comm_if)
        elif self.kind == "ch34x":
            version = self._control(0xC0, 0x5F, 0, 0, 2)[0]
            self._control(0x40, 0xA1, 0, 0)                       # serial init
            val = ch341_divisor(baud)
            if version > 0x27:
                val |= 0x80                                       # send short packets at once
            self._control(0x40, 0x9A, 0x1312, val)                # divisor, prescaler
            if version >= 0x30:
                self._control(0x40, 0x9A, 0x2518, 0xC3)           # 8N1, RX and TX on
            self._control(0x40, 0xA4, 0xFFFF, 0)                  # DTR, RTS off: no ESP32 reset
        else:   # cp210x
            self._control(0x41, 0x00, 0x0001, self.iface)         # IFC_ENABLE
            self._control(0x41, 0x1E, 0, self.iface, struct.pack("<I", baud))   # SET_BAUDRATE
            self._control(0x41, 0x03, 0x0800, self.iface)         # SET_LINE_CTL 8N1

    def describe(self):
        names = {"cdc": "USB CDC", "ch34x": "CH340/CH341", "cp210x": "CP210x"}
        return f"{names[self.kind]} {self.vid:04x}:{self.pid:04x}"

    @staticmethod
    def _load_libc():
        try:
            libc = ctypes.CDLL(None, use_errno=True)
            libc.ioctl  # noqa: B018 - raises if missing
        except (OSError, AttributeError):
            libc = ctypes.CDLL("libc.so", use_errno=True)
        libc.ioctl.argtypes = [ctypes.c_int, ctypes.c_ulong, ctypes.c_void_p]
        libc.ioctl.restype = ctypes.c_int
        return libc

    def _ioctl(self, request, arg):
        r = self.libc.ioctl(self.fd, request, arg)
        if r < 0:
            err = ctypes.get_errno()
            raise OSError(err, os.strerror(err))
        return r

    def _claim(self, iface):
        num = ctypes.c_uint(iface)
        try:
            self._ioctl(USBDEVFS_CLAIMINTERFACE, ctypes.addressof(num))
        except OSError as exc:
            if exc.errno != errno.EBUSY:
                raise
            # An Android kernel driver holds it: detach that driver, then claim.
            req = _UsbIoctl(iface, USBDEVFS_DISCONNECT, None)
            try:
                self._ioctl(USBDEVFS_IOCTL, ctypes.addressof(req))
            except OSError:
                pass
            self._ioctl(USBDEVFS_CLAIMINTERFACE, ctypes.addressof(num))

    def _control(self, request_type, request, value, index, data=None, timeout_ms=1000):
        """A control transfer. For an IN request, data is the length to read."""
        if request_type & 0x80:
            buf = ctypes.create_string_buffer(int(data or 0))
        else:
            buf = ctypes.create_string_buffer(bytes(data or b""), len(data or b""))
        length = len(buf)
        xfer = _CtrlTransfer(request_type, request, value & 0xFFFF, index, length, timeout_ms,
                             ctypes.addressof(buf) if length else None)
        n = self._ioctl(USBDEVFS_CONTROL, ctypes.addressof(xfer))
        return buf.raw[:n]

    def read(self, timeout_ms=500):
        """Up to one USB packet from the ESP32; b"" if nothing came in time."""
        buf = ctypes.create_string_buffer(self.in_size)
        xfer = _BulkTransfer(self.ep_in, self.in_size, timeout_ms, ctypes.addressof(buf))
        try:
            n = self._ioctl(USBDEVFS_BULK, ctypes.addressof(xfer))
        except OSError as exc:
            if exc.errno == errno.ETIMEDOUT:
                return b""
            raise
        return buf.raw[:n]

    def write(self, data, timeout_ms=1000):
        for off in range(0, len(data), 4096):
            chunk = bytes(data[off:off + 4096])
            buf = ctypes.create_string_buffer(chunk, len(chunk))
            xfer = _BulkTransfer(self.ep_out, len(chunk), timeout_ms, ctypes.addressof(buf))
            self._ioctl(USBDEVFS_BULK, ctypes.addressof(xfer))


class MavlinkFramer:
    """Cuts a MAVLink byte stream into whole messages, one per UDP packet, so a
    lost 4G packet loses whole messages instead of corrupting their neighbours.
    Bytes before a start marker (e.g. the ESP32's boot text) are dropped."""

    def __init__(self):
        self.buf = bytearray()

    def feed(self, data):
        self.buf += data
        out = []
        while self.buf:
            starts = [i for i in (self.buf.find(b"\xfd"), self.buf.find(b"\xfe")) if i >= 0]
            if not starts:
                self.buf.clear()
                break
            del self.buf[:min(starts)]
            if len(self.buf) < 3:
                break
            if self.buf[0] == 0xFE:
                need = 8 + self.buf[1]
            else:
                need = 12 + self.buf[1] + (13 if self.buf[2] & 0x01 else 0)
            if len(self.buf) < need:
                break
            out.append(bytes(self.buf[:need]))
            del self.buf[:need]
        return out


class UsbBridge:
    """Joins the USB ESP32 to the relay as if it were a UDP sender: drone data goes
    from a local socket to the relay's drone-side socket, and what the relay sends
    back to that local socket is written to USB."""

    def __init__(self, usb, relay_addr):
        self.usb = usb
        self.relay_addr = relay_addr
        self.sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        self.sock.bind(("127.0.0.1", 0))
        self.addr = self.sock.getsockname()
        self.error = None
        for target in (self._from_usb, self._to_usb):
            threading.Thread(target=target, daemon=True).start()

    def _from_usb(self):
        framer = MavlinkFramer()
        try:
            while self.error is None:
                for msg in framer.feed(self.usb.read()):
                    self.sock.sendto(msg, self.relay_addr)
        except Exception as exc:
            self.error = self.error or exc

    def _to_usb(self):
        try:
            while self.error is None:
                data, _ = self.sock.recvfrom(65535)
                self.usb.write(data)
        except Exception as exc:
            self.error = self.error or exc


def main():
    ap = argparse.ArgumentParser(description="VARUNA phone relay: ESP32 MAVLink <-> laptop backend")
    ap.add_argument("--fc-port", type=int, default=14550, help="UDP port the ESP32 sends to (default 14550)")
    ap.add_argument("--gcs-port", type=int, default=14551, help="UDP port the backend connects to (default 14551)")
    ap.add_argument("--esp", default="", help="the ESP32's fixed address, e.g. 192.168.43.50 "
                                              "(default: search the hotspot network)")
    ap.add_argument("--esp-port", type=int, default=14550, help="the ESP32's UDP port (DroneBridge: 14550)")
    ap.add_argument("--quiet", action="store_true", help="no status lines")
    ap.add_argument("--usb-fd", type=int, default=None,
                    help="USB mode: the ESP32's USB device file descriptor (relay.sh passes it via termux-usb)")
    ap.add_argument("--usb-baud", type=int, default=USB_BAUD, help=f"USB serial speed (default {USB_BAUD})")
    args = ap.parse_args()
    usb_mode = args.usb_fd is not None
    if usb_mode:
        # termux-usb holds back the program's standard output until it ends; stderr shows at once.
        sys.stdout = sys.stderr

    fc = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    fc.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    fc.bind(("127.0.0.1", 0) if usb_mode else ("0.0.0.0", args.fc_port))
    gcs = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    gcs.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    gcs.bind(("0.0.0.0", args.gcs_port))

    bridge = None
    if usb_mode:
        try:
            usb = UsbSerial(args.usb_fd, args.usb_baud)
        except OSError as exc:
            print(f"Can't use the USB device: {exc}", flush=True)
            sys.exit(1)
        bridge = UsbBridge(usb, fc.getsockname())

    esp_addr = (args.esp, args.esp_port) if args.esp else None   # where drone-bound packets go
    esp_heard = 0.0             # last packet from the ESP32
    peers = {}                  # ground station address -> last heard
    counts = {"up": 0, "down": 0, "up_b": 0, "down_b": 0}
    last_status = last_poke = 0.0
    poke_seq = 0
    if usb_mode:
        where = f", ESP32 on USB ({usb.describe()}, {args.usb_baud} baud)"
    elif args.esp:
        where = f", ESP32 at {args.esp}:{args.esp_port}"
    else:
        where = ", searching the hotspot for the ESP32"
    print(f"VARUNA relay: ground stations -> UDP {args.gcs_port}"
          + ("" if usb_mode else f", ESP32 -> UDP {args.fc_port}") + where, flush=True)
    scan_warned = False

    while True:
        if bridge and bridge.error:
            print(f"USB link lost ({bridge.error}). Check the ESP32's cable, then run ./relay.sh again.",
                  flush=True)
            sys.exit(1)
        ready, _, _ = select.select([fc, gcs], [], [], 1.0)
        now = time.time()
        for sock in ready:
            try:
                data, addr = sock.recvfrom(65535)
            except OSError:
                continue                    # e.g. ICMP "port unreachable" bounced back
            if sock is fc:
                if not is_mavlink(data) or (bridge and addr != bridge.addr):
                    continue
                if esp_addr != addr:
                    print("  drone link over USB" if bridge else f"  drone link from {addr[0]}:{addr[1]}",
                          flush=True)
                esp_addr, esp_heard = addr, now
                counts["down"] += 1
                counts["down_b"] += len(data)
                for peer in list(peers):
                    try:
                        gcs.sendto(data, peer)
                    except OSError:
                        pass
            else:
                if addr not in peers:
                    print(f"  ground station {addr[0]}:{addr[1]} connected", flush=True)
                peers[addr] = now
                counts["up"] += 1
                counts["up_b"] += len(data)
                if esp_addr:
                    try:
                        fc.sendto(data, esp_addr)
                    except OSError:
                        pass

        # Nothing from the ESP32 yet (or for a while): poke it so DroneBridge
        # registers this phone as a client and starts sending.
        if not usb_mode and now - esp_heard > 3 and now - last_poke >= POKE_S:
            last_poke = now
            poke_seq += 1
            if args.esp:
                targets = [args.esp]
            elif esp_heard:
                targets = [esp_addr[0]] + hotspot_hosts()     # it was there: try it first
            else:
                targets = hotspot_hosts()
            if not targets and not scan_warned:
                scan_warned = True
                print("  can't read the hotspot network (ip addr): start with --esp <ESP32 IP>, or add this "
                      "phone as a UDP client in DroneBridge", flush=True)
            hb = mavlink1_heartbeat(poke_seq)
            for host in dict.fromkeys(targets):
                try:
                    fc.sendto(hb, (host, args.esp_port))
                except OSError:
                    pass

        for peer, seen in list(peers.items()):
            if now - seen > PEER_TIMEOUT_S:
                del peers[peer]
                print(f"  ground station {peer[0]}:{peer[1]} gone", flush=True)

        if not args.quiet and now - last_status >= STATUS_S:
            last_status = now
            drone = (f"drone {'USB' if bridge else esp_addr[0]} ({now - esp_heard:.0f}s ago)" if esp_heard
                     else "drone: nothing yet" + (" (Pixhawk on? TX/RX swapped?)" if bridge else ""))
            print(f"[{time.strftime('%H:%M:%S')}] {drone} | ground stations {len(peers)} | "
                  f"to app {counts['down']} pkts {counts['down_b'] // 1024} KB, "
                  f"to drone {counts['up']} pkts {counts['up_b'] // 1024} KB", flush=True)


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        sys.exit(0)
