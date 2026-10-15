"""Build the VARUNA thermocol boat designs.

One source of truth for every measurement. Running this script writes:
  templates/<design>_A4.pdf           full-size cutting templates, tiled on A4
  templates/<design>_large-format.pdf the big parts on single sheets for a print shop
  designs.json                        the 3D model, specs and parts list
  boat-3d.html                        the 3D viewer with designs.json inlined

Coordinates are millimetres. x runs from the stern (0) to the bow (600),
y is across the boat (+y = left/port, -y = right/starboard, 0 = centreline),
z is up from the hull bottom (0). The thermocol layers are 25 mm thick.

Run: python3 boat-design/build.py
"""

import json
import math
import os

from reportlab.lib.pagesizes import A4, landscape
from reportlab.lib.units import mm
from reportlab.pdfgen import canvas

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "templates")

L, W = 600, 300          # overall hull size
T = 25                   # thermocol sheet thickness (1 inch)
DECK = 5                 # 5 mm sunboard deck
SB3 = 3                  # 3 mm sunboard for basket / bin / ramp
TOP = 3 * T              # top of the foam (z = 75)
BOW_END = [540, 570, 600]   # bow end of layer 1, 2, 3 (stepped rake)
TAPER = 120              # length of the bow taper
PONT_W = 80              # pontoon / arm width
INNER = 70               # channel half-width (channel = 140 mm)

EPS = 0.015e-3           # thermocol density, g/mm3 (15 kg/m3)
SB_AREAL = {5: 2.5e-3, 3: 1.5e-3}   # sunboard g/mm2
WATER = 1.0e-3           # g/mm3

# ---------------------------------------------------------------- geometry


def circle_pts(cx, cy, r, n=40):
    return [(cx + r * math.cos(2 * math.pi * i / n), cy + r * math.sin(2 * math.pi * i / n)) for i in range(n)]


def rect(x0, y0, x1, y1):
    return [(x0, y0), (x1, y0), (x1, y1), (x0, y1)]


def taper(xb, y_inner, y_outer, n=14):
    """Outer side curves in to meet the straight inner wall at the bow."""
    pts = []
    for i in range(n + 1):
        t = i / n
        frac = max(1 - t * t, 0.1)    # leaves an 8 mm blunt tip
        pts.append((xb + TAPER * t, y_inner + (y_outer - y_inner) * frac))
    return pts


def pontoon(xe, side):
    """One pontoon outline, side = +1 (left) or -1 (right). Inner wall straight."""
    yi, yo = side * INNER, side * W / 2
    xb = xe - TAPER
    pts = [(0, yi), (0, yo)] + [p for p in taper(xb, yi, yo)] + [(xe, yi)]
    return ccw(pts)


def uhull(xe, slot_x):
    """One-piece U hull: solid stern block with a 140 mm slot open at the bow."""
    xb = xe - TAPER
    left = taper(xb, INNER, W / 2)      # outer edge curve, y from 150 to ~78
    right = taper(xb, -INNER, -W / 2)
    pts = [(0, -W / 2)]
    pts += right                         # outer right edge, curving in to the tip
    pts += [(xe, -INNER), (slot_x, -INNER), (slot_x, INNER), (xe, INNER)]
    pts += left[::-1]                    # tip back along the left outer edge
    pts += [(0, W / 2)]
    return ccw(pts)


def signed_area(p):
    return 0.5 * sum(p[i][0] * p[(i + 1) % len(p)][1] - p[(i + 1) % len(p)][0] * p[i][1] for i in range(len(p)))


def ccw(p):
    return p if signed_area(p) > 0 else p[::-1]


def poly_props(p):
    """area, centroid, integral x^2 dA, integral y^2 dA (about origin), for a CCW polygon."""
    a = cx = cy = ixx = iyy = 0.0
    n = len(p)
    for i in range(n):
        x0, y0 = p[i]
        x1, y1 = p[(i + 1) % n]
        c = x0 * y1 - x1 * y0
        a += c
        cx += (x0 + x1) * c
        cy += (y0 + y1) * c
        iyy += (x0 * x0 + x0 * x1 + x1 * x1) * c
        ixx += (y0 * y0 + y0 * y1 + y1 * y1) * c
    a *= 0.5
    return a, cx / (6 * a), cy / (6 * a), iyy / 12, ixx / 12


def region_props(outers, holes=()):
    """Combine several outer polygons minus holes: area, cx, cy, Ix2, Iy2."""
    A = Sx = Sy = X2 = Y2 = 0.0
    for sign, group in ((1, outers), (-1, holes)):
        for p in group:
            a, cx, cy, x2, y2 = poly_props(ccw(p))
            A += sign * a
            Sx += sign * a * cx
            Sy += sign * a * cy
            X2 += sign * x2
            Y2 += sign * y2
    return A, Sx / A, Sy / A, X2, Y2


# ------------------------------------------------------- shared components

C = {  # colours used by the viewer
    "foam": "#f1efe8", "sunboard": "#dfe6ec", "ply": "#c9a676", "pcb": "#2f7d4f",
    "pix": "#30343b", "batt": "#2f6fb5", "esc": "#5b6370", "motor": "#9aa3ad",
    "mast": "#e9edf1", "cam": "#20232a", "gps": "#2c3036", "mesh": "#3d8fa3",
    "probe": "#d9dde2", "box": "#bcd7e6", "wood": "#b58a57", "belt": "#2f6f7e",
}

SHOP = [  # item, size, qty, approx price note
    ("Thermocol (EPS) sheet, 1 inch", "1000 x 500 x 25 mm", None),
    ("Sunboard (PVC foam board) 5 mm", "A3 or larger", None),
    ("Sunboard 3 mm", "A3 or larger", None),
    ("Plastic mesh (kitchen sink / gutter mesh)", "300 x 300 mm", 1),
    ("Wooden strip (or bamboo)", "300 x 20 x 10 mm", 2),
    ("PVC electrical conduit 20 mm + end cap", "350 mm", 1),
    ("Bamboo skewers (alignment pins)", "3-4 mm", 10),
    ("Fevicol SH (PVA) and low-temp hot glue", "", 1),
    ("Water-based acrylic paint / packing tape", "", 1),
]

ELECTRONICS = [  # name, size text, mass g
    ("Pixhawk 2.4.8 (ArduRover)", "82 x 50 x 16", 38),
    ("Raspberry Pi Zero W / 2 W", "65 x 30 x 5", 10),
    ("Pi Camera Module 3 Wide + Zero ribbon 300 mm", "25 x 24 x 12", 5),
    ("ADS1115 ADC module", "28 x 18 x 3", 3),
    ("Turbidity sensor (probe + board)", "probe 30 dia x 70, board 38 x 28", 33),
    ("GPS + compass (M8N puck)", "50 dia x 15", 30),
    ("LiPo 3S 2200 mAh", "105 x 34 x 24", 185),
    ("Power module (for Pixhawk)", "25 x 21 x 9", 15),
    ("5 V 3 A UBEC (for the Pi)", "40 x 18 x 8", 12),
    ("2205 2300KV brushless motor", "28 dia x 30", 30),
    ("20 A BLHeli ESC (3D / reversible mode)", "45 x 25 x 8", 20),
    ("5045 props, one CW + one CCW", "127 dia", 4),
    ("Waterproof box (lunch box)", "115 x 175 x 65 outside", 90),
]


def comp(out, name, x0, yc, z0, sx, sy, sz, mass, color, group, info="", pitch=0, opacity=1):
    out.append({"kind": "box", "name": name, "c": [x0 + sx / 2, yc, z0 + sz / 2], "s": [sx, sy, sz],
                "mass": mass, "color": color, "group": group, "info": info, "pitch": pitch, "opacity": opacity})


def cyl(out, name, c, r, h, axis, mass, color, group, info="", opacity=1):
    out.append({"kind": "cyl", "name": name, "c": c, "r": r, "h": h, "axis": axis, "mass": mass,
                "color": color, "group": group, "info": info, "opacity": opacity})


def propulsion(out, deck_z):
    """Two pusher air props on towers at the stern (airboat: nothing in the water to snag plastic)."""
    hub = deck_z + 90
    for side, label in ((1, "left"), (-1, "right")):
        y = side * 75
        comp(out, f"Motor tower ({label})", 52, y, deck_z, 6, 50, 125, 14, C["ply"], "mech",
             "6 mm plywood, motor centre 90 mm above the deck")
        cyl(out, f"Motor 2205 ({label})", [37, y, hub], 14, 30, "x", 30, C["motor"], "mech", "pusher, faces the stern")
        cyl(out, f"Prop 5045 ({label})", [18, y, hub], 63.5, 2, "x", 4, "#c3ccd6", "mech",
            "127 mm prop, " + ("CCW" if side > 0 else "CW"), opacity=0.45)
        out.append({"kind": "torus", "name": f"Prop guard ({label})", "c": [15, y, hub], "r": 70, "tube": 3,
                    "mass": 8, "color": C["sunboard"], "group": "mech", "info": "5 mm sunboard ring, OD 146 / ID 134"})
        comp(out, f"ESC 20 A ({label})", 65, side * 115, deck_z, 25, 45, 8, 20, C["esc"], "elec", "on the deck beside the tower")


def electronics(out, x0, z0, inner=(111, 171), box=True, box_z=None):
    """Electronics box (or foam pocket) and its interior, x0 = rear inner wall."""
    if box:
        comp(out, "Waterproof electronics box", x0 - 2, 0, box_z, 115, 175, 65, 90, C["box"], "elec",
             "lunch box 115 x 175 x 65, cable holes sealed with hot glue", opacity=0.28)
    items = [  # name, rx0, ry_c, sx, sy, sz, rz0, mass, colour, info
        ("LiPo 3S 2200 mAh", 5, 62, 105, 34, 24, 0, 185, C["batt"], "Velcro strap; slide it to trim the boat level"),
        ("Pixhawk 2.4.8", 7, 10, 82, 50, 16, 2, 38, C["pix"], "arrow pointing to the bow, on foam tape"),
        ("Power module", 90, 10, 20, 25, 9, 0, 15, "#8a6d3b", "between battery and Pixhawk POWER port"),
        ("5 V 3 A UBEC", 7, -30, 40, 18, 8, 0, 12, "#46505c", "powers the Pi Zero"),
        ("Turbidity sensor board", 52, -30, 38, 28, 10, 0, 8, C["pcb"], "analog out to ADS1115 A0 (10k/20k divider)"),
        ("Raspberry Pi Zero", 5, -62, 65, 30, 5, 4, 10, C["pcb"], "camera ribbon up to the mast, MAVLink to TELEM2"),
        ("ADS1115 ADC", 75, -62, 28, 18, 3, 4, 3, "#1f4f8a", "I2C 0x48 on Pi pins 1, 3, 5, 6"),
    ]
    for n, rx, ry, sx, sy, sz, rz, m, col, info in items:
        comp(out, n, x0 + rx, ry, z0 + rz, sx, sy, sz, m, col, "elec", info)
    out.append({"kind": "mass", "name": "Wiring and connectors", "c": [x0 + 55, 0, z0 + 20], "mass": 60})


def mast(out, x, base_z, height, flange=True):
    if flange:
        comp(out, "Mast socket (2 x 5 mm sunboard)", x - 25, 0, base_z, 50, 50, 10, 10, C["sunboard"], "mech",
             "glued to the deck, 21 mm hole")
    cyl(out, "Camera mast (20 mm PVC conduit)", [x, 0, base_z + height / 2], 10, height, "z", 40, C["mast"], "mech",
        f"{height} mm tall, cable-tied to the box")
    cam_z = base_z + height - 30
    comp(out, "Pi Camera 3 Wide (tilted 35 deg down)", x + 10, 0, cam_z - 12, 12, 25, 24, 10, C["cam"], "elec",
         "on the 35 deg wedge, lens on the centreline", pitch=-35)
    cyl(out, "GPS + compass", [x, 0, base_z + height + 8], 25, 15, "z", 30, C["gps"], "elec", "arrow to the bow")
    cyl(out, "GPS disc (5 mm sunboard)", [x, 0, base_z + height + 2], 35, 4, "z", 5, C["sunboard"], "mech", "70 mm disc")
    return cam_z


def probe(out, x, y, top_z):
    cyl(out, "Turbidity probe", [x, y, (top_z - 15) / 2], 15, top_z + 15, "z", 25, C["probe"], "elec",
        "through a 32 mm hole, tip 15 mm below the hull, sealed with hot glue")


def basket(out, x0, x1):
    comp(out, "Collection basket (3 mm sunboard + mesh)", x0, 0, 0, x1 - x0, 134, 75, 55, C["mesh"], "collect",
         f"{x1 - x0} x 134 x 75, lifts out to empty, lips rest on the pontoons", opacity=0.35)
    comp(out, "One-way flap (PET sheet)", x1 - 2, 0, 6, 1, 110, 52, 3, "#cfe8ee", "collect",
         "taped at the top, swings into the basket only", opacity=0.6)


def ramp(out, x_back, x_front, z_back):
    run = x_front - x_back
    ang = math.degrees(math.atan2(z_back, run))
    length = math.hypot(run, z_back)
    comp(out, "Intake ramp (mesh on 3 mm sunboard frame)", (x_back + x_front) / 2 - length / 2, 0, z_back / 2 - 1.5,
         length, 128, 3, 20, C["mesh"], "collect", f"{length:.0f} x 128, front lip under water, {ang:.1f} deg",
         pitch=-ang, opacity=0.8)


def crossbar(out, x0, z0, name):
    comp(out, name, x0, 0, z0, 20, 300, 10, 25, C["wood"], "mech", "300 x 20 x 10 wooden strip, glued + screwed")


# ---------------------------------------------------------- templates (2D)
# element: ("poly", pts, style) ("circle", (x, y), r, style) ("text", (x, y), s, size, anchor)
#          ("skewer", (x, y)) ("line", p0, p1, style)


def tpart(name, material, els, note="", copies=1):
    xs, ys = [], []
    for e in els:
        if e[0] == "poly":
            xs += [p[0] for p in e[1]]
            ys += [p[1] for p in e[1]]
        elif e[0] in ("circle",):
            xs += [e[1][0] - e[2], e[1][0] + e[2]]
            ys += [e[1][1] - e[2], e[1][1] + e[2]]
        elif e[0] in ("line", "dim"):
            xs += [e[1][0], e[2][0]]
            ys += [e[1][1], e[2][1]]
    return {"name": name, "material": material, "els": els, "note": note, "copies": copies,
            "bbox": [min(xs), min(ys), max(xs), max(ys)]}


def framed_panel(name, material, w, h, border=12, window=True, extra=(), note=""):
    els = [("poly", rect(0, 0, w, h), "cut")]
    if window and w > 2 * border + 10 and h > 2 * border + 10:
        els.append(("poly", rect(border, border, w - border, h - border), "pocket"))
        els.append(("text", (w / 2, h / 2), "cut out, cover with mesh", 2.6, "c"))
    els += list(extra)
    els.append(("text", (w / 2, h - 5 if not window else border / 2 - 1), f"{w} x {h}", 2.6, "c"))
    return tpart(name, material, els, note)


def tower_plate(label):
    els = [("poly", rect(0, 0, 50, 125), "cut"),
           ("circle", (25, 90), 5, "cut"),
           ("line", (0, 0), (50, 0), "fold")]
    for dx, dy in ((8, 0), (-8, 0), (0, 9.5), (0, -9.5)):
        els.append(("circle", (25 + dx, 90 + dy), 1.6, "cut"))
    els += [("text", (25, 70), "motor centre", 2.4, "c"), ("text", (25, 8), "deck edge (bottom)", 2.4, "c"),
            ("text", (25, 112), "6 mm ply", 2.4, "c")]
    return tpart(f"Motor tower plate ({label})", "6 mm plywood (or 2 x 5 mm sunboard)", els,
                 "Motor on the stern side. Holes fit the 16 / 19 mm cross mount.")


def gusset():
    return tpart("Tower gusset", "5 mm sunboard", [("poly", [(0, 0), (40, 0), (0, 60)], "cut"),
                                                   ("text", (12, 12), "deck", 2.4, "c")],
                 "Glue on the bow side of each tower, 2 per tower")


def guard_ring(label):
    els = [("circle", (75, 95), 73, "cut"), ("circle", (75, 95), 67, "pocket"),
           ("poly", rect(65, 0, 85, 24), "cut"),
           ("text", (75, 95), "prop guard, cut out the centre", 2.6, "c"),
           ("text", (75, 6), "foot", 2.4, "c")]
    return tpart(f"Prop guard ring ({label})", "5 mm sunboard", els,
                 "Foot glues to the deck. Ring centre = motor centre, 90 mm above the deck.")


def mast_socket(hole=21):
    els = [("poly", rect(0, 0, 50, 50), "cut"), ("circle", (25, 25), hole / 2, "cut"),
           ("text", (25, 6), "front (bow)", 2.4, "c")]
    return tpart("Mast socket layer", "5 mm sunboard (cut 2, top one with hole)", els)


def mast_ring():
    els = [("circle", (20, 20), 20, "cut"), ("circle", (20, 20), 10.5, "cut")]
    return tpart("Mast foot ring", "5 mm sunboard (cut 2, stack)", els, "Mast clamps to the box front with 2 cable ties")


def camera_parts(angle=35):
    h = round(30 * math.tan(math.radians(angle)), 1)
    wedge = tpart(f"Camera wedge side ({angle} deg)", "3 mm sunboard", [
        ("poly", [(0, 0), (30, 0), (0, max(h, 6))], "cut"), ("text", (9, 2), f"{angle} deg", 1.8, "l")],
        "Camera plate glues on the sloping edge, lens looking forward and down")
    plate = tpart("Camera plate", "3 mm sunboard", [
        ("poly", rect(0, 0, 32, 32), "cut"), ("circle", (16, 18), 4.5, "cut"),
        ("poly", rect(6, 2, 26, 5), "cut"), ("text", (16, 28), "lens up", 2.2, "c")],
        "Ribbon through the slot")
    return wedge, plate


def gps_disc():
    return tpart("GPS disc", "5 mm sunboard", [("circle", (35, 35), 35, "cut"), ("circle", (35, 35), 10.5, "mark"),
                                              ("line", (35, 55), (35, 68), "mark"),
                                              ("text", (35, 22), "arrow to bow", 2.4, "c")],
                 "Glue on the mast end cap")


def tray_guide(name, w, h):
    """Paper guide pasted inside the box / pocket floor showing where each part sits."""
    els = [("poly", rect(0, 0, w, h), "mark")]
    # same layout as electronics(): rx along w (x), ry across (y) with centre at h/2
    items = [("LiPo 3S", 5, 62, 105, 34), ("Pixhawk (arrow to bow)", 7, 10, 82, 50), ("PM", 90, 10, 20, 25),
             ("UBEC 5V", 7, -30, 40, 18), ("Turbidity board", 52, -30, 38, 28), ("Pi Zero", 5, -62, 65, 30),
             ("ADS1115", 75, -62, 28, 18)]
    for n, rx, ry, sx, sy in items:
        y0 = h / 2 + ry - sy / 2
        els.append(("poly", rect(rx, y0, rx + sx, y0 + sy), "mark"))
        els.append(("text", (rx + sx / 2, y0 + sy / 2), n, 2.2, "c"))
    els.append(("text", (w - 4, h / 2), "BOW >", 2.6, "r"))
    return tpart(name, "paper guide, glue inside the floor", els, "Do not cut. Shows where each part goes.")


def basket_panels(length):
    win_front = ("poly", rect(12, 3, 116, 53), "pocket")
    return [
        framed_panel("Basket bottom", "3 mm sunboard", length, 128),
        framed_panel("Basket side (left)", "3 mm sunboard", length, 75),
        framed_panel("Basket side (right)", "3 mm sunboard", length, 75),
        framed_panel("Basket back end", "3 mm sunboard", 128, 72),
        tpart("Basket front end (entrance)", "3 mm sunboard", [
            ("poly", rect(0, 0, 128, 72), "cut"), win_front,
            ("text", (64, 30), "entrance: cut out, flap hangs inside", 2.4, "c"),
            ("text", (64, 64), "128 x 72", 2.4, "c")], "Bottom edge sits on the basket bottom"),
        tpart("Basket lip (left)", "3 mm sunboard", [("poly", rect(0, 0, length, 28), "cut"),
                                                     ("line", (0, 3), (length, 3), "fold"),
                                                     ("text", (length / 2, 15), "glue 3 mm on side top, 25 mm rests on pontoon", 2.4, "c")]),
        tpart("Basket lip (right)", "3 mm sunboard", [("poly", rect(0, 0, length, 28), "cut"),
                                                      ("line", (0, 3), (length, 3), "fold"),
                                                      ("text", (length / 2, 15), "glue 3 mm on side top, 25 mm rests on pontoon", 2.4, "c")]),
        tpart("One-way flap", "PET sheet from a bottle / transparency", [
            ("poly", rect(0, 0, 110, 56), "cut"), ("line", (0, 50), (110, 50), "fold"),
            ("text", (55, 25), "tape the top strip inside, above the entrance", 2.4, "c")]),
    ]


def ramp_parts(run, rise):
    length = round(math.hypot(run, rise))
    frame = framed_panel("Intake ramp frame", "3 mm sunboard", length, 128, border=14,
                         note=f"Cover the window with mesh. Front lip at the hull bottom, back edge {rise} mm up.")
    wedge = tpart("Ramp support wedge", "5 mm sunboard (cut 2)", [
        ("poly", [(0, 0), (run, 0), (run, rise + 8), (0, 8)], "cut"),
        ("text", (run / 2, 3), "bottom edge level with the hull bottom", 2.2, "c"),
        ("text", (6, 12), "BOW", 2.2, "c")], "Glue to each channel wall; the ramp rests on the top edge")
    return [frame, wedge, wedge]


def layer_marks(xe, side, layer, ramp_x=None, basket_x=None, crossbars=()):
    els = []
    yi = side * INNER
    s = -side  # towards the inside of the pontoon from the inner wall
    if layer == 0 and ramp_x:
        for x in ramp_x:
            els.append(("line", (x, yi), (x, yi + s * 12), "mark"))
        els.append(("text", ((ramp_x[0] + ramp_x[1]) / 2, yi + s * 8), "ramp wedge", 2.2, "c"))
    if layer == 2:
        if basket_x:
            for x in basket_x:
                els.append(("line", (x, yi), (x, yi + s * 12), "mark"))
            els.append(("text", ((basket_x[0] + basket_x[1]) / 2, yi + s * 8), "basket lip rests here", 2.2, "c"))
        for x in crossbars:
            els.append(("poly", rect(x, side * 75, x + 20, side * 145), "mark"))
    return els


# ------------------------------------------------------------- the designs


def design_twin(conveyor=False):
    """Design 1 (Twin-Hull Skimmer) and Design 3 (Conveyor Cat) share the pontoons."""
    d = {"id": "conveyor-cat" if conveyor else "twin-hull",
         "name": "Conveyor Cat" if conveyor else "Twin-Hull Skimmer",
         "tag": "Advanced" if conveyor else "Recommended",
         "summary": ("The twin-hull boat with a motor-driven mesh belt that lifts plastic out of the water into a "
                     "deck bin. Items ride up the belt in clear view of the camera, which suits the catch counter best."
                     if conveyor else
                     "Two pontoons with an open water channel between them. Plastic floats in over a submerged ramp "
                     "into a lift-out mesh basket with a one-way flap. Light, low drag and easy to empty."),
         }
    probe_x = 150 if conveyor else 230
    deck_x1 = 365 if conveyor else 300
    layers = []
    for i, xe in enumerate(BOW_END):
        for side in (1, -1):
            holes = [circle_pts(probe_x, -110, 16)] if side == -1 else []
            layers.append({"pts": pontoon(xe, side), "holes": holes, "z0": i * T, "h": T, "layer": i + 1,
                           "name": f"{'Left' if side > 0 else 'Right'} pontoon, layer {i + 1}"})
    slabs = [{"name": "Deck (5 mm sunboard)", "pts": ccw(rect(0, -150, deck_x1, 150)),
              "holes": [circle_pts(probe_x, -110, 16)], "z0": TOP, "h": DECK}]
    parts = []
    deck_z = TOP + DECK
    propulsion(parts, deck_z)
    if conveyor:
        electronics(parts, 97, deck_z + 2, box_z=deck_z)
        cam_z = mast(parts, 222, deck_z, 330, flange=False)
        comp(parts, "Deck bin (3 mm sunboard, drain holes)", 236, 0, deck_z, 110, 220, 45, 45, C["mesh"], "collect",
             "110 x 220 x 45, lifts off to empty", opacity=0.4)
        # conveyor: bottom roller (530, 12) to top roller (350, 145)
        b, t = (530, 12), (350, 145)
        run, rise = b[0] - t[0], t[1] - b[1]
        ang = math.degrees(math.atan2(rise, run))
        length = math.hypot(run, rise)
        mid = ((b[0] + t[0]) / 2, (b[1] + t[1]) / 2)
        for side in (1, -1):
            comp(parts, f"Conveyor side plate ({'left' if side > 0 else 'right'})", mid[0] - (length + 50) / 2,
                 side * 67.5, mid[1] - 25, length + 50, 5, 50, 34, C["sunboard"], "collect",
                 f"{length + 50:.0f} x 50, 5 mm sunboard, {ang:.0f} deg", pitch=ang)
        comp(parts, "Mesh belt with cleats", mid[0] - length / 2, 0, mid[1] - 1, length, 120, 2, 30, C["belt"],
             "collect", f"loop {2 * length + math.pi * 25:.0f} mm, 120 wide, cleat every 35 mm", pitch=ang, opacity=0.85)
        for nm, p in (("Bottom roller", b), ("Top roller (driven)", t)):
            cyl(parts, f"{nm} (25 mm PVC on 6 mm rod)", [p[0], 0, p[1]], 12.5, 125, "y", 48, "#e7ebef", "collect",
                "125 mm long, rod 150 mm through both side plates")
        cyl(parts, "Conveyor gear motor 25GA 12 V 100 rpm", [t[0], 100, t[1]], 12.5, 60, "y", 100, C["motor"], "collect",
            "on the left plate, outside; switched by a MOSFET module from the Pi")
        crossbar(parts, 545, TOP, "Bow crossbar")
        d["conveyor"] = {"angle": round(ang, 1), "length": round(length), "loop": round(2 * length + math.pi * 25)}
        bin_vol = 110 * 220 * 45 / 1e6
    else:
        electronics(parts, 177, deck_z + 2, box_z=deck_z)
        cam_z = mast(parts, 150, deck_z, 300)
        basket(parts, 300, 440)
        ramp(parts, 440, 540, 15)
        crossbar(parts, 445, TOP, "Basket crossbar")
        crossbar(parts, 560, TOP, "Bow crossbar")
        bin_vol = 140 * 128 * 75 / 1e6
    probe(parts, probe_x, -110, deck_z)

    # templates ------------------------------------------------------------
    sheets = []
    names = ["bottom", "middle", "top"]
    for i, xe in enumerate(BOW_END):
        els = []
        for side, off in ((1, -63), (-1, 63)):
            pts = [(x, y + off) for x, y in pontoon(xe, side)]
            els.append(("poly", pts, "cut"))
            yc = side * 110 + off
            for sx in (40, 140, 300, 400):
                els.append(("skewer", (sx, yc)))
            if side == -1:
                els.append(("circle", (probe_x, -110 + off), 16, "cut"))
                els.append(("text", (probe_x, yc + 22), "probe hole 32 mm", 2.4, "c"))
            label = f"{'LEFT' if side > 0 else 'RIGHT'} pontoon - layer {i + 1} ({names[i]})"
            els.append(("text", (230, yc), label, 3.4, "c"))
            els.append(("text", (xe - TAPER - 30, yc), "BOW >", 3.0, "c"))
            mk = layer_marks(xe, side, i, ramp_x=None if conveyor else (440, 540),
                             basket_x=None if conveyor else (300, 440),
                             crossbars=(545,) if conveyor else (445, 560))
            for e in mk:
                if e[0] == "line":
                    els.append(("line", (e[1][0], e[1][1] + off), (e[2][0], e[2][1] + off), e[3]))
                elif e[0] == "text":
                    els.append(("text", (e[1][0], e[1][1] + off), e[2], e[3], e[4]))
                else:
                    els.append(("poly", [(x, y + off) for x, y in e[1]], e[2]))
        sheets.append(tpart(f"Pontoons layer {i + 1} ({names[i]}), left + right", "25 mm thermocol", els,
                            "Cut both. Push skewers through the dots to line up the layers."))
    deck_els = [("poly", rect(0, 0, deck_x1, 300), "cut"), ("circle", (probe_x, 40), 16, "cut"),
                ("text", (probe_x, 62), "probe hole", 2.4, "c")]
    yoff = 150
    for p in parts:  # placement marks from the 3D layout
        if p["kind"] == "box" and p["group"] in ("elec", "mech") and abs(p["c"][2] - p["s"][2] / 2 - deck_z) < 3 \
                and not p["pitch"]:
            if p["name"].startswith(("LiPo", "Pixhawk", "Power", "5 V", "Turbidity", "Raspberry", "ADS")):
                continue
            x0, y0 = p["c"][0] - p["s"][0] / 2, p["c"][1] - p["s"][1] / 2 + yoff
            deck_els.append(("poly", rect(x0, y0, x0 + p["s"][0], y0 + p["s"][1]), "mark"))
            deck_els.append(("text", (p["c"][0], p["c"][1] + yoff), p["name"].split(" (")[0], 2.2, "c"))
    if conveyor:
        deck_els += [("poly", rect(236, 40, 346, 260), "mark"), ("text", (291, 150), "deck bin", 2.6, "c"),
                     ("circle", (222, 150), 20, "mark"), ("text", (222, 176), "mast foot", 2.2, "c")]
    deck_els.append(("text", (deck_x1 - 6, 150), "BOW >", 3, "r"))
    deck_els.append(("text", (8, 150), "STERN", 3, "l"))
    sheets.append(tpart("Deck", "5 mm sunboard", deck_els, "Dashed boxes show where each part is glued."))

    small = [tower_plate("left"), tower_plate("right"), gusset(), gusset(), gusset(), gusset(),
             guard_ring("left"), guard_ring("right"), *camera_parts(), camera_parts()[0], gps_disc(),
             tray_guide("Electronics box floor guide", 111, 171)]
    if conveyor:
        cl = d["conveyor"]["length"]
        plate = tpart("Conveyor side plate", "5 mm sunboard (cut 2)", [
            ("poly", rect(0, 0, cl + 50, 50), "cut"), ("circle", (25, 25), 3.3, "cut"),
            ("circle", (cl + 25, 25), 3.3, "cut"),
            ("text", ((cl + 50) / 2, 25), f"axle holes {cl} mm apart, 6.5 mm", 2.6, "c"),
            ("text", (25, 40), "bottom", 2.2, "c"), ("text", (cl + 25, 40), "top", 2.2, "c")],
            f"Glue to the channel wall at {d['conveyor']['angle']} deg using the angle guide")
        guide = tpart("Conveyor angle guide", "paper or card", [
            ("poly", [(0, 0), (180, 0), (0, 133)], "mark"),
            ("text", (40, 20), f"{d['conveyor']['angle']} deg", 3, "c"),
            ("text", (90, 4), "hull bottom line", 2.2, "c")], "Hold against the channel wall while gluing the plates")
        bracket = tpart("Gear motor bracket", "5 mm sunboard", [
            ("poly", rect(0, 0, 50, 50), "cut"), ("circle", (25, 25), 4, "cut"),
            ("circle", (16.5, 25), 1.6, "cut"), ("circle", (33.5, 25), 1.6, "cut")], "25GA face: 2 x M3, 17 mm apart")
        plug = tpart("Roller end plug", "5 mm sunboard (cut 8, stack 2 per end)", [
            ("circle", (11, 11), 10.5, "cut"), ("circle", (11, 11), 3.1, "cut")])
        cleat = tpart("Belt cleat", "3 mm sunboard (cut 10)", [("poly", rect(0, 0, 120, 10), "cut")])
        small += [plate, plate, guide, bracket] + [plug] * 4 + [cleat] * 5 + [mast_ring(), mast_ring()]
        small += [framed_panel("Bin bottom (drain holes)", "3 mm sunboard", 110, 220, border=10, window=True),
                  framed_panel("Bin wall front", "3 mm sunboard", 220, 45, window=False),
                  framed_panel("Bin wall back", "3 mm sunboard", 220, 45, window=False),
                  framed_panel("Bin wall side", "3 mm sunboard", 104, 42, window=False),
                  framed_panel("Bin wall side", "3 mm sunboard", 104, 42, window=False)]
    else:
        small += basket_panels(140) + ramp_parts(100, 15) + [mast_socket(), mast_socket()]
    d.update(layers=layers, slabs=slabs, parts=parts, sheets=sheets, small=small, deck_z=deck_z,
             cam_z=cam_z, bin_vol=bin_vol, foam_sheets=1)
    return d


def design_block():
    d = {"id": "u-hull", "name": "U-Hull Block", "tag": "Easiest to build",
         "summary": ("One solid piece of stacked thermocol with a 140 mm slot open at the bow. The electronics sit in "
                     "a pocket cut inside the foam under a hatch, so there is no deck to build. The stiffest, most "
                     "stable and most forgiving hull for a first build.")}
    slot_x = 270
    pocket = rect(100, -90, 215, 90)
    probe_c = (170, -125)
    groove = rect(163, -109, 177, -90)
    layers = []
    for i, xe in enumerate(BOW_END):
        holes = [circle_pts(*probe_c, 16)]
        if i >= 1:
            holes.append(pocket)
        layers.append({"pts": uhull(xe, slot_x), "holes": holes, "z0": i * T, "h": T, "layer": i + 1,
                       "name": f"Hull layer {i + 1}"})
    slabs = [{"name": "Hatch lid (5 mm sunboard, foam-tape seal)", "pts": ccw(rect(85, -105, 230, 105)), "holes": [],
              "z0": TOP, "h": DECK},
             {"name": "Stern plate (5 mm sunboard)", "pts": ccw(rect(0, -138, 95, 138)), "holes": [], "z0": TOP, "h": DECK}]
    parts = []
    deck_z = TOP + DECK
    propulsion(parts, deck_z)
    electronics(parts, 100, T, inner=(115, 180), box=False)
    cam_z = mast(parts, 245, TOP, 305)
    basket(parts, 270, 430)
    ramp(parts, 430, 540, 15)
    crossbar(parts, 435, TOP, "Basket crossbar")
    crossbar(parts, 560, TOP, "Bow crossbar")
    probe(parts, probe_c[0], probe_c[1], TOP)

    sheets = []
    names = ["bottom", "middle", "top"]
    for i, xe in enumerate(BOW_END):
        els = [("poly", [(x, y + 150) for x, y in uhull(xe, slot_x)], "cut"),
               ("circle", (probe_c[0], probe_c[1] + 150), 16, "cut"),
               ("text", (probe_c[0], probe_c[1] + 150 + 22), "probe hole 32 mm", 2.4, "c")]
        for sx, sy in ((30, 0), (30, 110), (30, -110), (250, 110), (250, -110), (400, 110), (400, -110)):
            els.append(("skewer", (sx, sy + 150)))
        if i >= 1:
            els.append(("poly", [(x, y + 150) for x, y in pocket], "pocket"))
            els.append(("text", (157, 150), "electronics pocket: cut out", 2.8, "c"))
        if i == 2:
            els.append(("poly", [(x, y + 150) for x, y in groove], "pocket"))
            els.append(("text", (200, 150 - 100), "cable slot", 2.2, "c"))
            for x0, x1, t in ((270, 430, "basket lip rests here"),):
                for x in (x0, x1):
                    els.append(("line", (x, 150 - INNER), (x, 150 - INNER - 12), "mark"))
                    els.append(("line", (x, 150 + INNER), (x, 150 + INNER + 12), "mark"))
                els.append(("text", ((x0 + x1) / 2, 150 + INNER + 8), t, 2.2, "c"))
            for x in (435, 560):
                els.append(("poly", rect(x, 150 + 75, x + 20, 150 + 145), "mark"))
                els.append(("poly", rect(x, 150 - 145, x + 20, 150 - 75), "mark"))
        if i == 0:
            for x in (430, 540):
                els.append(("line", (x, 150 - INNER), (x, 150 - INNER - 12), "mark"))
                els.append(("line", (x, 150 + INNER), (x, 150 + INNER + 12), "mark"))
            els.append(("text", (485, 150 + INNER + 8), "ramp wedge", 2.2, "c"))
        els.append(("text", (60, 150), f"HULL layer {i + 1} ({names[i]})", 3.6, "l"))
        els.append(("text", (360, 150), "SLOT (cut away) - BOW >", 3.0, "c"))
        sheets.append(tpart(f"Hull layer {i + 1} ({names[i]})", "25 mm thermocol", els,
                            "Push skewers through the dots to line up the layers."))
    hatch = tpart("Hatch lid", "5 mm sunboard", [
        ("poly", rect(0, 0, 145, 210), "cut"), ("poly", rect(15, 15, 130, 195), "mark"),
        ("text", (72, 105), "foam tape on the dashed line", 2.6, "c"), ("text", (72, 200), "BOW", 2.6, "c")],
        "Held down with 2 rubber bands or Velcro")
    stern = tpart("Stern plate", "5 mm sunboard", [
        ("poly", rect(0, 0, 95, 276), "cut"),
        ("poly", rect(52, 138 + 75 - 25, 58, 138 + 75 + 25), "mark"),
        ("poly", rect(52, 138 - 75 - 25, 58, 138 - 75 + 25), "mark"),
        ("poly", rect(65, 138 + 115 - 22.5, 90, 138 + 115 + 22.5), "mark"),
        ("poly", rect(65, 138 - 115 - 22.5, 90, 138 - 115 + 22.5), "mark"),
        ("text", (45, 138), "towers + ESCs", 2.4, "c"), ("text", (88, 120), "BOW >", 2.4, "r")],
        "Spreads the motor load on the foam")
    small = [hatch, stern, tower_plate("left"), tower_plate("right"), gusset(), gusset(), gusset(), gusset(),
             guard_ring("left"), guard_ring("right"), *camera_parts(), camera_parts()[0], gps_disc(),
             mast_socket(), mast_socket(), tray_guide("Pocket floor guide", 115, 180)]
    small += basket_panels(160) + ramp_parts(110, 15)
    d.update(layers=layers, slabs=slabs, parts=parts, sheets=sheets, small=small, deck_z=deck_z,
             cam_z=cam_z, bin_vol=160 * 128 * 75 / 1e6, foam_sheets=3)
    return d


# ------------------------------------------------------- design: AI Pod


def rrect(x0, y0, x1, y1, r, n=10):
    """Rounded rectangle, CCW, starting at the bottom edge going towards the bow."""
    pts = []
    for cx, cy, a0 in ((x1 - r, y0 + r, -90), (x1 - r, y1 - r, 0), (x0 + r, y1 - r, 90), (x0 + r, y0 + r, 180)):
        for i in range(n + 1):
            a = math.radians(a0 + 90 * i / n)
            pts.append((cx + r * math.cos(a), cy + r * math.sin(a)))
    return pts


def clip_rect(poly, x0, y0, x1, y1):
    """Sutherland-Hodgman clip of a polygon to an axis-aligned rectangle."""
    def clip(pts, inside, cut):
        out = []
        for i, p in enumerate(pts):
            q = pts[i - 1]
            if inside(p):
                if not inside(q):
                    out.append(cut(q, p))
                out.append(p)
            elif inside(q):
                out.append(cut(q, p))
        return out

    def cx(v):
        return lambda a, b: (v, a[1] + (b[1] - a[1]) * (v - a[0]) / (b[0] - a[0]))

    def cy(v):
        return lambda a, b: (a[0] + (b[0] - a[0]) * (v - a[1]) / (b[1] - a[1]), v)
    p = clip(poly, lambda q: q[0] >= x0, cx(x0))
    p = clip(p, lambda q: q[0] <= x1, cx(x1))
    p = clip(p, lambda q: q[1] >= y0, cy(y0))
    return clip(p, lambda q: q[1] <= y1, cy(y1))


POD = {"x0": 15, "x1": 585, "half": 135, "r": 90, "wall": 35, "ledge": 45,
       "tunnel_x": 395, "tunnel_half": 75}


def pod_outline(notch):
    P = POD
    pts = rrect(P["x0"], -P["half"], P["x1"], P["half"], P["r"])
    if not notch:
        return pts
    th = P["tunnel_half"]
    xa = P["x1"] - P["r"] + math.sqrt(P["r"] ** 2 - (th - (P["half"] - P["r"])) ** 2)
    out, done = [], False
    for p in pts:
        if p[0] > P["tunnel_x"] and abs(p[1]) < th:
            if not done:
                out += [(xa, -th), (P["tunnel_x"], -th), (P["tunnel_x"], th), (xa, th)]
                done = True
            continue
        out.append(p)
    return out


def pod_inner(off):
    P = POD
    return rrect(P["x0"] + off, -P["half"] + off, P["x1"] - off, P["half"] - off, P["r"] - off)


POD_WELLS = [("Turbidity probe", 140, 85, 16), ("pH probe", 140, -85, 8), ("TDS probe", 190, 85, 8),
             ("Temperature probe", 190, -85, 5)]
POD_SKEWERS = [(32, 0), (300, 117), (300, -117), (450, 117), (450, -117)]

POD_LOWER = [  # name, x0, yc, z0, sx, sy, sz, mass, colour, info
    ("ESC 30 A bidirectional (left)", 65, 50, 75, 50, 25, 10, 25, "#5b6370", "left thruster, reversible for turning on the spot"),
    ("ESC 30 A bidirectional (right)", 65, -50, 75, 50, 25, 10, 25, "#5b6370", "right thruster"),
    ("12 V to 5 V 5 A buck converter", 120, -50, 75, 60, 35, 20, 30, "#46505c", "powers the Pi, servo and LEDs"),
    ("2-channel relay module", 120, 50, 75, 50, 38, 19, 30, "#1f4f8a", "switches the spray pump and the UV LED"),
    ("Li-ion 3S6P 20 Ah battery (18 x 18650 + BMS)", 100, 0, 75, 115, 60, 70, 960, "#2f6fb5",
     "lowest and heaviest part: keeps the boat stable. Velcro strap, slide to trim"),
    ("CN3791 solar charge module", 340, -75, 75, 50, 30, 15, 15, "#2f7d4f", "between the panel and the battery"),
    ("Spray pump 12 V (385 diaphragm)", 240, -40, 75, 90, 40, 35, 110, "#7a828c", "feeds 4 nozzles through 4 mm tube"),
    ("Ultrasonic board (front)", 430, -40, 80, 41, 28, 10, 10, "#2f7d4f", "JSN-SR04T, echo to Pixhawk"),
    ("Ultrasonic board (left)", 480, -40, 80, 41, 28, 10, 10, "#2f7d4f", "JSN-SR04T"),
    ("Ultrasonic board (right)", 430, -78, 80, 41, 28, 10, 10, "#2f7d4f", "JSN-SR04T"),
]
POD_UPPER = [
    ("Power module", 180, 0, 153, 21, 25, 9, 15, "#8a6d3b", "battery to Pixhawk POWER"),
    ("Pixhawk 2.4.8", 210, 0, 153, 82, 50, 16, 38, "#30343b", "arrow to the bow, on foam tape"),
    ("Raspberry Pi Zero 2 W", 310, -50, 157, 65, 30, 5, 10, "#2f7d4f", "Pi camera + USB webcam, MAVLink to TELEM2"),
    ("ADS1115 ADC", 385, -50, 157, 28, 18, 3, 3, "#1f4f8a", "A0 turbidity, A1 pH, A2 TDS (I2C 0x48)"),
    ("pH sensor board", 310, 45, 153, 42, 32, 10, 15, "#2f7d4f", "calibrate with pH 4 and 7 buffer"),
    ("TDS sensor board", 360, 45, 153, 42, 32, 10, 10, "#2f7d4f", ""),
    ("Turbidity sensor board", 410, 45, 153, 38, 28, 10, 8, "#2f7d4f", "10k/20k divider to ADS1115"),
]

POD_ELECTRONICS = [
    ("Pixhawk 2.4.8 (ArduRover)", "82 x 50 x 16", 38),
    ("Raspberry Pi Zero 2 W", "65 x 30 x 5", 10),
    ("Pi Camera Module 3 Wide (front camera)", "25 x 24 x 12", 5),
    ("USB webcam on MG90S servo (360 deg camera)", "webcam about 60 x 30 x 30", 75),
    ("GPS + compass (M8N)", "50 dia x 15", 30),
    ("Li-ion 3S6P 20 Ah pack + 3S BMS (18 x 18650)", "115 x 60 x 70", 960),
    ("2 x 12 V brushless underwater thruster, 2 kg class", "45 dia x 95 each", 360),
    ("2 x 30 A bidirectional ESC", "50 x 25 x 10 each", 50),
    ("10 W flexible solar panel", "340 x 230 x 3", 220),
    ("CN3791 3S solar charge module", "50 x 30 x 15", 15),
    ("Power module + 12 V to 5 V 5 A buck", "25 x 21 / 60 x 35", 45),
    ("2-channel relay module", "50 x 38 x 19", 30),
    ("ADS1115 ADC", "28 x 18 x 3", 3),
    ("pH probe + board", "12 dia x 150 / 42 x 32", 60),
    ("TDS probe + board", "42 x 32", 25),
    ("Turbidity probe + board", "30 dia x 70 / 38 x 28", 33),
    ("DS18B20 waterproof temperature probe", "6 dia x 50", 15),
    ("3 x JSN-SR04T waterproof ultrasonic sensor", "23 dia, board 41 x 28", 90),
    ("12 V diaphragm pump + 4 nozzles + tube", "90 x 40 x 35", 150),
    ("365 nm UV LEDs, front LED strip, status RGB LED", "", 35),
]


def design_pod():
    P = POD
    d = {"id": "ai-pod", "name": "VARUNA AI Pod", "tag": "Your design, upgraded",
         "summary": ("The boat from your picture at 60 x 30 cm: a rounded, enclosed thermocol pod with a pull-out "
                     "collection drawer at the front, solar panel on the lid, a front camera and a 360 degree camera, "
                     "water-quality sensors, obstacle sensors and a 4-way spray. Two shelves inside keep the heavy "
                     "battery at the bottom for stability.")}
    outer_n, outer = pod_outline(True), pod_outline(False)
    inner, ledge = pod_inner(P["wall"]), pod_inner(P["ledge"])
    wells = [circle_pts(x, y, r, 28) for _, x, y, r in POD_WELLS]
    beam_slot = rect(60, -115, 100, 115)
    layers = [{"pts": outer_n, "holes": wells + [beam_slot], "z0": 0, "h": T, "layer": 1, "name": "Base layer 1"},
              {"pts": outer_n, "holes": wells, "z0": T, "h": T, "layer": 2, "name": "Base layer 2"},
              {"pts": outer_n, "holes": wells, "z0": 2 * T, "h": T, "layer": 3, "name": "Base layer 3 (lower-bay floor)"}]
    for i in range(4, 9):
        hole = ledge if i == 6 else inner
        nm = {6: "Ledge ring (shelf rests on it)", 8: "Lid rim ring"}.get(i, "Wall ring")
        layers.append({"pts": outer, "holes": [hole], "z0": (i - 1) * T, "h": T, "layer": i, "name": f"{nm}, layer {i}"})
    roof = clip_rect(inner, P["tunnel_x"] - 10, -90, 600, 90)
    shelf = pod_inner(P["wall"] + 1)
    slots = [rect(160, 60, 190, 85), rect(160, -85, 190, -60)]
    lid_holes = [circle_pts(90, 0, 10.5, 24), circle_pts(530, 0, 10, 24), circle_pts(320, 0, 4, 16),
                 circle_pts(120, 80, 2.5, 12)] + [circle_pts(x, y, 3, 12) for x in (60, 540) for y in (105, -105)]
    slabs = [{"name": "Drawer tunnel roof (5 mm sunboard, sealed)", "pts": ccw(roof), "holes": [], "z0": 3 * T, "h": 5},
             {"name": "Shelf (3 mm sunboard)", "pts": ccw(shelf), "holes": slots, "z0": 150, "h": 3},
             {"name": "Lid top (3 mm sunboard)", "pts": ccw(outer), "holes": lid_holes, "z0": 200, "h": 3}]

    parts = []
    # propulsion: underwater thrusters on a beam set into layer 1
    comp(parts, "Thruster beam (wood 230 x 40 x 20)", 60, 0, 0, 40, 230, 20, 115, C["wood"], "mech",
         "glued into the slot in base layer 1, thrusters bolt underneath")
    for side, lab in ((1, "left"), (-1, "right")):
        comp(parts, f"Thruster bracket ({lab})", 70, side * 80, -10, 20, 12, 10, 10, "#7a828c", "mech", "")
        cyl(parts, f"Underwater thruster ({lab})", [80, side * 80, -32], 22, 95, "x", 180, "#3b4148", "mech",
            "12 V brushless, 2 kg class, prop in its own guard duct")
    for n, x0, yc, z0, sx, sy, sz, m, col, info in POD_LOWER + POD_UPPER:
        comp(parts, n, x0, yc, z0, sx, sy, sz, m, col, "elec", info)
    cyl(parts, "Spray tank (500 ml bottle)", [340, 60, 112.5], 32.5, 200, "x", 525, "#cfe3ea", "spray",
        "PAC solution, refill through the lid; full = 500 g", opacity=0.7)
    for n, x, y, r in POD_WELLS:
        hgt = {"pH probe": 160, "Turbidity probe": 105, "TDS probe": 110, "Temperature probe": 80}[n]
        cyl(parts, n, [x, y, -15 + hgt / 2], max(r - 1, 3), hgt, "z", {"pH probe": 45, "Turbidity probe": 25}.get(n, 15),
            C["probe"], "sensor", "through its well in the base, tip 15 mm below the hull, sealed with hot glue")
    out_ = parts
    # collection drawer in the bow tunnel
    comp(out_, "Collection drawer (mesh basket, pulls out forward)", 397, 0, 0, 203, 140, 70, 90, C["mesh"], "collect",
         "203 x 140 x 70, slides on two rails, front handle; empty it from the front", opacity=0.4)
    comp(out_, "One-way flap (PET sheet)", 590, 0, 8, 1, 112, 55, 3, "#cfe8ee", "collect",
         "hangs inside the drawer entrance, swings in only", opacity=0.6)
    for side in (1, -1):
        comp(out_, f"Drawer rail ({'left' if side > 0 else 'right'})", 395, side * 70, 60, 190, 10, 10, 10, C["wood"],
             "collect", "10 x 10 wooden strip glued to the tunnel wall")
    # sensors and lights at the bow
    comp(out_, "Pi Camera 3 Wide (front, 10 deg down)", 571, 0, 128, 12, 25, 24, 10, C["cam"], "elec",
         "behind a clear window in the ledge ring; marine life and plastic ahead", pitch=-10)
    for nm, x, y in (("Ultrasonic sensor (front)", 578, 0), ("Ultrasonic sensor (left)", 570, 80),
                     ("Ultrasonic sensor (right)", 570, -80)):
        cyl(out_, nm, [x, y, 112], 11.5, 15, "x", 20, "#30343b", "sensor", "JSN-SR04T in a 23 mm hole in layer 5")
    for side in (1, -1):
        comp(out_, f"UV LED ({'left' if side > 0 else 'right'})", 575, side * 45, 82, 10, 16, 10, 4, "#7b4fd6", "sensor",
             "365 nm, lights the water in front of the drawer")
    comp(out_, "Front LED strip", 582, 0, 160, 4, 100, 6, 10, "#f4e7b0", "elec", "white, on the bow wall (layer 7)")
    # lid
    comp(out_, "Solar panel 10 W (flexible)", 150, 0, 203, 340, 230, 3, 220, "#1d2b4a", "power",
         "340 x 230, glued on the lid, cable through the 8 mm hole")
    comp(out_, "Mast socket (2 x 5 mm sunboard)", 65, 0, 203, 50, 50, 10, 10, C["sunboard"], "mech", "")
    cyl(out_, "GPS mast (20 mm PVC conduit)", [90, 0, 273], 10, 120, "z", 18, C["mast"], "mech", "120 mm tall")
    cyl(out_, "GPS + compass", [90, 0, 341], 25, 15, "z", 30, C["gps"], "elec", "arrow to the bow")
    cyl(out_, "GPS disc (5 mm sunboard)", [90, 0, 335], 35, 4, "z", 5, C["sunboard"], "mech", "")
    comp(out_, "Pan servo MG90S (360 deg camera)", 510, 0, 203, 40, 22, 30, 14, "#2c3036", "elec", "on the servo plate")
    out_.append({"kind": "sphere", "name": "360 deg camera dome (USB webcam inside)", "c": [530, 0, 258], "r": 25,
                 "mass": 80, "color": "#20232a", "group": "elec", "opacity": 0.92,
                 "info": "webcam in a clear plastic ball half, turns with the servo"})
    cyl(out_, "Status LED (RGB)", [120, 80, 207], 5, 8, "z", 3, "#59d18a", "elec", "green = auto, blue = manual, red = fault")
    for x in (60, 540):
        for y in (105, -105):
            cyl(out_, "Spray nozzle", [x, y, 210], 4, 14, "z", 5, "#9aa3ad", "spray", "one of 4, aimed outwards")
    # bumper: half pipe-insulation round the waterline, open at the drawer mouth
    path = outer_n[outer_n.index(next(p for p in outer_n if p[0] == P["tunnel_x"] and p[1] > 0)) + 1:] + \
        outer_n[:outer_n.index(next(p for p in outer_n if p[0] == P["tunnel_x"] and p[1] < 0))]
    out_.append({"kind": "tube", "name": "Bumper (black pipe insulation, split)", "pts": path, "z": 40, "r": 16,
                 "c": [300, 0, 40], "mass": 60, "color": "#1c2126", "group": "mech",
                 "info": "32 mm foam pipe insulation cut in half, glued round the waterline"})
    out_.append({"kind": "mass", "name": "Wiring, tube and connectors", "c": [300, 0, 110], "mass": 120})

    # templates ------------------------------------------------------------
    def base_sheet(i, marks):
        els = [("poly", outer_n, "cut")]
        for n, x, y, r in POD_WELLS:
            els.append(("circle", (x, y), r, "cut"))
            els.append(("text", (x, y + r + 4 if y > 0 else y - r - 4), n.replace(" probe", ""), 2.2, "c"))
        if i == 1:
            els.append(("poly", beam_slot, "pocket"))
            els.append(("text", (80, 0), "beam slot", 2.4, "c"))
        for x, y in POD_SKEWERS + [(250, 0), (370, 0)]:
            els.append(("skewer", (x, y)))
        els.append(("text", (490, 0), "DRAWER TUNNEL (cut away)", 3, "c"))
        els.append(("text", (300, -125), f"BASE layer {i}" + (" - top face is the lower-bay floor" if marks else ""), 3.4, "c"))
        if marks:
            for n, x0, yc, z0, sx, sy, sz, *_ in POD_LOWER:
                if x0 < P["tunnel_x"]:
                    els.append(("poly", rect(x0, yc - sy / 2, x0 + sx, yc + sy / 2), "mark"))
                    els.append(("text", (x0 + sx / 2, yc), n.split(" (")[0][:22], 1.9, "c"))
        return tpart(f"Base layer {i}", "25 mm thermocol", els, "Bow (drawer tunnel) on the right.")

    def ring_sheet(name, hole, extra=(), copies=1, note=""):
        els = [("poly", outer, "cut"), ("poly", hole, "pocket")] + list(extra)
        for x, y in POD_SKEWERS:
            els.append(("skewer", (x, y)))
        els.append(("text", (300, 0), name + " - cut out the centre", 3.4, "c"))
        els.append(("text", (300, -12), "BOW >", 3, "c"))
        return tpart(name, "25 mm thermocol", els, note, copies=copies)

    us = [("line", (560, -25), (590, 25), "mark"), ("text", (520, 30), "layer 5 only: 3 ultrasonic holes", 2.2, "c"),
          ("circle", (578, 0), 4, "mark"), ("circle", (570, 80), 4, "mark"), ("circle", (570, -80), 4, "mark")]
    cam = [("poly", rect(574, -14, 590, 14), "mark"), ("text", (530, 0), "camera window", 2.2, "c")]
    lid_els = [("poly", outer, "cut")] + [("poly", h, "cut") for h in lid_holes] + [
        ("poly", rect(150, -115, 490, 115), "mark"), ("text", (320, 20), "solar panel 340 x 230", 3, "c"),
        ("poly", rect(510, -11, 550, 11), "mark"), ("text", (530, -20), "servo plate", 2.2, "c"),
        ("poly", rect(65, -25, 115, 25), "mark"), ("text", (90, 32), "GPS mast", 2.2, "c"),
        ("text", (120, 90), "status LED", 2.2, "c"), ("text", (60, 95), "nozzle", 2, "c"),
        ("text", (540, 95), "nozzle", 2, "c"), ("text", (575, 0), "BOW >", 3, "r")]
    shelf_els = [("poly", shelf, "cut")] + [("poly", s, "pocket") for s in slots]
    for n, x0, yc, z0, sx, sy, sz, *_ in POD_UPPER:
        shelf_els += [("poly", rect(x0, yc - sy / 2, x0 + sx, yc + sy / 2), "mark"),
                      ("text", (x0 + sx / 2, yc), n.split(" (")[0][:18], 1.9, "c")]
    shelf_els += [("text", (175, 92), "cable slot", 2, "c"), ("text", (540, 0), "BOW >", 3, "r")]
    sheets = [base_sheet(1, False), base_sheet(2, False), base_sheet(3, True),
              ring_sheet("Wall ring (layers 4, 5, 7 and lid rim 8)", inner, us, copies=4,
                         note="Print 4 copies. Layer 5 also gets the 3 ultrasonic holes."),
              ring_sheet("Ledge ring (layer 6)", ledge, cam, note="10 mm narrower inside: the shelf rests on it."),
              tpart("Lid top", "3 mm sunboard", lid_els, "Dashed boxes show where the lid parts go."),
              tpart("Shelf", "3 mm sunboard", shelf_els, "Rests on the ledge ring. Dashed boxes: upper-bay parts.")]
    roof_els = [("poly", roof, "cut")]
    for n, x0, yc, z0, sx, sy, sz, *_ in POD_LOWER:
        if x0 + sx > P["tunnel_x"]:
            roof_els += [("poly", rect(max(x0, P["tunnel_x"] - 10), yc - sy / 2, x0 + sx, yc + sy / 2), "mark"),
                         ("text", (max(x0, P["tunnel_x"]) + 20, yc), n.split(" (")[0][:16], 1.8, "c")]
    roof_els += [("poly", rect(385, 27.5, 440, 92.5), "mark"), ("text", (412, 60), "tank end", 2, "c")]
    cw, cp = camera_parts(10)
    small = [tpart("Drawer tunnel roof", "5 mm sunboard", roof_els, "Seal all round with hot glue"),
             framed_panel("Drawer bottom", "3 mm sunboard", 203, 134),
             framed_panel("Drawer side (left)", "3 mm sunboard", 203, 70),
             framed_panel("Drawer side (right)", "3 mm sunboard", 203, 70),
             framed_panel("Drawer back", "3 mm sunboard", 134, 67),
             tpart("Drawer front (entrance + handle)", "3 mm sunboard", [
                 ("poly", [(0, 0), (134, 0), (134, 67), (87, 67), (87, 85), (47, 85), (47, 67), (0, 67)], "cut"),
                 ("poly", rect(11, 5, 123, 60), "pocket"), ("text", (67, 76), "handle", 2.4, "c"),
                 ("text", (67, 32), "entrance: cut out", 2.4, "c")], "Flap tapes inside, above the entrance"),
             tpart("One-way flap", "PET sheet", [("poly", rect(0, 0, 115, 62), "cut"),
                                                 ("line", (0, 55), (115, 55), "fold")]),
             tpart("Servo plate", "3 mm sunboard", [("poly", rect(0, 0, 50, 50), "cut"),
                                                    ("poly", rect(13.5, 19, 36.5, 31.5), "cut"),
                                                    ("text", (25, 8), "MG90S cut-out", 2.2, "c")]),
             mast_socket(), mast_socket(), gps_disc(), cw, cw, cp]
    d.update(layers=layers, slabs=slabs, parts=parts, sheets=sheets, small=small, deck_z=200,
             cam_z=140, cam_tilt=10, bin_vol=203 * 134 * 70 / 1e6, foam_sheets=4, glue=300, hull_h=8 * T,
             power=(222, 40, 10), battery="Li-ion 3S6P 20 Ah (222 Wh)", electronics=POD_ELECTRONICS)
    return d


# ------------------------------------------------------------ measurements


def add_dims(d):
    """Measurement lines, coordinates and a mm ruler on every big template."""
    def move(els, old, new_xy):
        return [("text", new_xy, e[2], e[3], e[4]) if e[0] == "text" and e[2].startswith(old) else e for e in els]

    out = []
    for sh in d["sheets"]:
        n, els = sh["name"], list(sh["els"])
        if d["id"] == "ai-pod":
            if n.startswith("Base layer"):
                els = move(els, "DRAWER TUNNEL", (450, 30))
                els += [("dim", (15, -112), (585, -112), "570 overall length"),
                        ("dim", (40, -135), (40, 135), "270 overall width"),
                        ("dim", (500, -75), (500, 75), "150 tunnel width"),
                        ("dim", (395, -55), (585, -55), "190 tunnel, from bow edge"),
                        ("ruler", 15, 585, 0, 15)]
                for nm, x, y, r in POD_WELLS:
                    els.append(("text", (x, y + r + 8 if y > 0 else y - r - 8),
                                f"{2 * r} dia: {x - 15} from stern, {abs(y)} {'left' if y > 0 else 'right'}", 1.9, "c"))
                if n.endswith("1"):
                    els = [e for e in els if not (e[0] == "text" and e[2] == "beam slot")]
                    els += [("dim", (108, -115), (108, 115), "230 beam slot"),
                            ("dim", (60, -40), (100, -40), "40"), ("text", (80, 50), "slot starts 45 from stern", 1.9, "c")]
            elif n.startswith(("Wall ring", "Ledge ring")):
                ledge = n.startswith("Ledge")
                w_ = POD["ledge"] if ledge else POD["wall"]
                els = [("text", (470, 50) if e[2].startswith(("Wall", "Ledge")) else (470, 38), e[2], e[3], e[4])
                       if e[0] == "text" and (e[2].startswith(("Wall", "Ledge")) or e[2] == "BOW >") else e for e in els]
                els += [("dim", (15, -117), (585, -117), "570 overall length"),
                        ("dim", (200, -135), (200, 135), "270 overall width"),
                        ("dim", (15, 20), (15 + w_, 20), f"{w_} wall"), ("dim", (585 - w_, 20), (585, 20), f"{w_}"),
                        ("dim", (15 + w_, -30), (585 - w_, -30), f"{570 - 2 * w_} inside"),
                        ("dim", (360, -135 + w_), (360, 135 - w_), f"{270 - 2 * w_} inside"),
                        ("text", (85, 115), "R90 outside", 2, "c"), ("text", (90, 70), f"R{90 - w_} inside", 2, "c"),
                        ("ruler", 15, 585, 0, 15)]
            elif n == "Lid top":
                els += [("dim", (15, -125), (585, -125), "570 overall length"),
                        ("dim", (30, -135), (30, 135), "270 overall width"),
                        ("text", (90, -32), "mast hole 21 dia, 75 from stern", 1.9, "c"),
                        ("text", (530, 18), "camera cable hole 20 dia, 515 from stern", 1.9, "c"),
                        ("text", (320, -9), "panel cable 8 dia, 305 from stern", 1.9, "c"),
                        ("text", (120, 70), "5 dia, 105 from stern, 80 left", 1.8, "c"),
                        ("text", (300, 128), "nozzle holes 6 dia: 45 and 525 from stern, 105 each side", 1.9, "c"),
                        ("ruler", 15, 585, -60, 15)]
            elif n == "Shelf":
                els += [("dim", (51, -92), (549, -92), "498 long"), ("dim", (300, -99), (300, 99), "198 wide"),
                        ("text", (175, -94 + 190), "slots 30 x 25, 145 from stern", 1.8, "c")]
        elif n.startswith("Pontoons layer"):
            xe = BOW_END[int(n.split()[2]) - 1]
            els += [("dim", (0, 20), (xe, 20), f"{xe} long (to bow tip)"), ("dim", (20, 7), (20, 87), "80"),
                    ("dim", (0, -20), (xe, -20), f"{xe} long (to bow tip)"), ("dim", (20, -87), (20, -7), "80"),
                    ("ruler", 0, xe - 40, 60, 0), ("ruler", 0, xe - 40, -80, 0)]
        elif n == "Deck":
            xs = [p[0] for e in els if e[0] == "poly" and e[2] == "cut" for p in e[1]]
            els += [("dim", (0, 285), (max(xs), 285), f"{max(xs):.0f} long"), ("dim", (285 if max(xs) > 300 else 260, 0),
                    (285 if max(xs) > 300 else 260, 300), "300 wide"), ("ruler", 0, max(xs), 120, 0)]
        elif n.startswith("Hull layer"):
            els = move(els, "SLOT", (430, 175))
            els = move(els, "HULL", (60, 175))
            els += [("dim", (0, 288), (600, 288), "600 overall (to bow tips)"), ("dim", (12, 0), (12, 300), "300 wide"),
                    ("dim", (560, 80), (560, 220), "140 slot"), ("dim", (270, 135), (600, 135), "330 slot depth"),
                    ("ruler", 0, 270, 150, 0)]
        out.append(tpart(sh["name"], sh["material"], els, sh["note"], sh.get("copies", 1)))
    d["sheets"] = out


# ------------------------------------------------------------ hydrostatics


def hydro(d):
    items = []
    foam_v = 0
    for ly in d["layers"]:
        A, cx, cy, _, _ = region_props([ly["pts"]], ly["holes"])
        v = A * ly["h"]
        foam_v += v
        items.append((v * EPS, cx, ly["z0"] + ly["h"] / 2))
    for s in d["slabs"]:
        A, cx, cy, _, _ = region_props([s["pts"]], s["holes"])
        items.append((A * SB_AREAL.get(s["h"], 2.5e-3), cx, s["z0"] + s["h"] / 2))
    for p in d["parts"]:
        items.append((p["mass"], p["c"][0], p["c"][2]))
    fx = sum(m * x for m, x, _ in items[:len(d["layers"])]) / max(sum(m for m, _, _ in items[:len(d["layers"])]), 1)
    items.append((d.get("glue", 150), fx, 40))   # glue, paint, tape
    payload = round(d["bin_vol"] * 200)          # about 0.2 kg of wet plastic per litre
    bin_c = next(p["c"] for p in d["parts"] if p["name"].startswith(("Collection", "Deck bin")))

    levels = {}
    for ly in d["layers"]:
        levels.setdefault((ly["z0"], ly["h"]), []).append(ly)
    levels = [(z0, h, region_props([ly["pts"] for ly in lys], [x for ly in lys for x in ly["holes"]]))
              for (z0, h), lys in sorted(levels.items())]

    def state(extra):
        its = items + extra
        m = sum(i[0] for i in its)
        cg = sum(i[0] * i[1] for i in its) / m
        kg = sum(i[0] * i[2] for i in its) / m
        v = left = m / WATER
        for z0, h, wp in levels:                # fill the hull layer by layer
            if left <= wp[0] * h:
                draft = z0 + left / wp[0]
                break
            left -= wp[0] * h
        A, cbx, _, X2, Y2 = wp
        gmt = Y2 / v + draft / 2 - kg
        gml = (X2 - A * cbx ** 2) / v
        trim = (cbx - cg) / gml * L                # + = bow higher than stern
        return {"mass_g": round(m), "draft_mm": round(draft, 1), "cg_x": round(cg), "cb_x": round(cbx),
                "kg_mm": round(kg), "gm_t_mm": round(gmt), "bow_up_mm": round(trim, 1)}

    empty = state([])
    full = state([(payload, bin_c[0], bin_c[2])])
    reserve = foam_v * WATER / 1000 - full["mass_g"] / 1000

    def top(p):
        if p["kind"] == "box":
            return p["c"][2] + p["s"][2] / 2
        if p["kind"] == "cyl":
            return p["c"][2] + (p["h"] / 2 if p["axis"] == "z" else p["r"])
        if p["kind"] == "sphere":
            return p["c"][2] + p["r"]
        return 0
    wh, load, solar = d.get("power", (24.4, 25, 0))
    d["specs"] = {"length": L, "width": W, "hull_height": d.get("hull_h", TOP),
                  "overall_height": round(max(top(p) for p in d["parts"])),
                  "empty": empty, "full": full, "payload_g": payload, "bin_l": round(d["bin_vol"], 2),
                  "reserve_kg": round(reserve, 1), "foam_l": round(foam_v / 1e6, 1),
                  "cam_height_mm": round(d["cam_z"] - empty["draft_mm"]), "cam_tilt": d.get("cam_tilt", 35),
                  "foam_sheets": d["foam_sheets"], "foam_text": d.get("foam_text", "1 sheet 1000 x 500 x 25 mm"), "battery": d.get("battery", "LiPo 3S 2200 mAh (24 Wh)"),
                  "runtime_h": round(wh * 0.8 / load, 1),
                  "runtime_sun_h": round(wh * 0.8 / max(load - solar * 0.6, 1), 1) if solar else None}


# ------------------------------------------------------------------- PDF

PAPERS = {"A4": (297, 210, 7, 9, 5), "A3": (420, 297, 7, 4, 3)}   # width, height, margin, header, padding


def set_paper(name):
    global PAGE_W, PAGE_H, MARGIN, HEAD, PAD, USE_W, USE_H, PAPER
    PAGE_W, PAGE_H, MARGIN, HEAD, PAD = PAPERS[name]
    PAPER = name
    USE_W = PAGE_W - 2 * MARGIN
    USE_H = PAGE_H - 2 * MARGIN - HEAD


set_paper("A4")
OVERLAP = 10

STYLE = {"cut": ((0, 0, 0), 0.35, None), "pocket": ((0.8, 0.1, 0.1), 0.35, None),
         "fold": ((0.1, 0.3, 0.8), 0.3, (2, 1.5)), "mark": ((0.45, 0.45, 0.5), 0.22, (1.5, 1.2)),
         "dim": ((0.05, 0.45, 0.55), 0.2, None)}


def set_style(c, style):
    col, lw, dash = STYLE[style]
    c.setStrokeColorRGB(*col)
    c.setLineWidth(lw)
    c.setDash(dash or [])


def draw_els(c, els, ox, oy):
    """Draw elements in mm with the canvas already scaled to mm."""
    for e in els:
        k = e[0]
        if k == "poly":
            set_style(c, e[2])
            p = c.beginPath()
            p.moveTo(e[1][0][0] + ox, e[1][0][1] + oy)
            for x, y in e[1][1:]:
                p.lineTo(x + ox, y + oy)
            p.close()
            c.drawPath(p, stroke=1, fill=0)
        elif k == "circle":
            set_style(c, e[3])
            c.circle(e[1][0] + ox, e[1][1] + oy, e[2], stroke=1, fill=0)
        elif k == "line":
            set_style(c, e[3])
            c.line(e[1][0] + ox, e[1][1] + oy, e[2][0] + ox, e[2][1] + oy)
        elif k == "dim":
            (x0, y0), (x1, y1), txt = e[1], e[2], e[3]
            x0, y0, x1, y1 = x0 + ox, y0 + oy, x1 + ox, y1 + oy
            set_style(c, "dim")
            c.line(x0, y0, x1, y1)
            a = math.atan2(y1 - y0, x1 - x0)
            for (px, py), s_ in (((x0, y0), 1), ((x1, y1), -1)):
                for da in (0.4, -0.4):
                    c.line(px, py, px + s_ * 2.2 * math.cos(a + da), py + s_ * 2.2 * math.sin(a + da))
                c.line(px - 1.8 * math.sin(a), py + 1.8 * math.cos(a), px + 1.8 * math.sin(a), py - 1.8 * math.cos(a))
            deg = math.degrees(a)
            if deg > 90 or deg <= -90:
                deg += 180
            c.saveState()
            c.translate((x0 + x1) / 2, (y0 + y1) / 2)
            c.rotate(deg)
            c.setFillColorRGB(0.05, 0.4, 0.5)
            c.setFont("Helvetica-Bold", 2.8)
            c.drawCentredString(0, 1.1, txt)
            c.restoreState()
        elif k == "ruler":
            x0, x1, y, zero = e[1] + ox, e[2] + ox, e[3] + oy, e[4]
            set_style(c, "dim")
            c.line(x0, y, x1, y)
            c.setFillColorRGB(0.05, 0.4, 0.5)
            c.setFont("Helvetica", 2)
            i = math.ceil(e[1] - zero)
            while zero + i <= e[2]:
                t = 3 if i % 50 == 0 else (2 if i % 10 == 0 else 0)
                if t:
                    c.line(zero + i + ox, y, zero + i + ox, y + t)
                if i % 50 == 0:
                    c.drawCentredString(zero + i + ox, y + 3.6, f"{i}")
                i += 1
        elif k == "skewer":
            set_style(c, "cut")
            x, y = e[1][0] + ox, e[1][1] + oy
            c.circle(x, y, 2, stroke=1, fill=0)
            c.line(x - 3.5, y, x + 3.5, y)
            c.line(x, y - 3.5, x, y + 3.5)
    c.setDash([])
    c.setFillColorRGB(0.1, 0.1, 0.15)
    for e in els:
        if e[0] == "text":
            (x, y), s, size, anchor = e[1], e[2], e[3], e[4]
            c.setFont("Helvetica", size)
            fn = {"c": c.drawCentredString, "l": c.drawString, "r": c.drawRightString}[anchor]
            fn(x + ox, y + oy - size * 0.35, s)


def rotate_part(p):
    """Turn a part 90 degrees so it fits the page; the bow then points up."""
    def r(pt):
        return (-pt[1], pt[0])
    els = []
    for e in p["els"]:
        if e[0] == "poly":
            els.append(("poly", [r(q) for q in e[1]], e[2]))
        elif e[0] == "circle":
            els.append(("circle", r(e[1]), e[2], e[3]))
        elif e[0] == "line":
            els.append(("line", r(e[1]), r(e[2]), e[3]))
        elif e[0] == "skewer":
            els.append(("skewer", r(e[1])))
        elif e[0] == "dim":
            els.append(("dim", r(e[1]), r(e[2]), e[3]))
        elif e[0] == "ruler":
            continue
        else:
            els.append(("text", r(e[1]), e[2].replace("BOW >", "BOW ^"), e[3], "c"))
    return tpart(p["name"], p["material"], els, p["note"], p.get("copies", 1))


def full_name(d):
    return d["name"] if d["name"].startswith("VARUNA") else f"VARUNA {d['name']}"


def page_header(c, design, title, page_no):
    c.setFillColorRGB(0.1, 0.1, 0.15)
    band = MARGIN + USE_H
    ty = band + HEAD - 3.5 if HEAD > 5 else band + 0.9
    c.setFont("Helvetica-Bold", 3.6 if HEAD > 5 else 3.2)
    c.drawString(MARGIN, ty, f"{full_name(design)}  |  {title}")
    c.setFont("Helvetica", 2.6)
    c.drawRightString(PAGE_W - MARGIN, ty, f"{PAPER} landscape, print at 100% (Actual size)  |  page {page_no}")
    # scale check: 50 mm bar
    x0, y0 = (PAGE_W - MARGIN - 110, PAGE_H - MARGIN - 7.5) if HEAD > 5 else (PAGE_W - 175, band + 0.6)
    c.setStrokeColorRGB(0, 0, 0)
    c.setLineWidth(0.3)
    c.rect(x0, y0, 50, 3 if HEAD > 5 else 2.4, stroke=1, fill=0)
    c.setFont("Helvetica", 2.2)
    c.drawString(x0 + 52, y0 + 0.6, "<- must measure 50 mm")


def new_page(c):
    c.showPage()
    c.scale(mm, mm)


def draw_legend(c, x, y):
    for i, (style, label) in enumerate((("cut", "cut line"), ("pocket", "cut out (window / pocket)"),
                                        ("fold", "fold / glue line"), ("mark", "placement guide, do not cut"))):
        set_style(c, style)
        c.line(x, y - i * 4.5, x + 10, y - i * 4.5)
        c.setDash([])
        c.setFillColorRGB(0.1, 0.1, 0.15)
        c.setFont("Helvetica", 2.8)
        c.drawString(x + 13, y - i * 4.5 - 1, label)
    set_style(c, "cut")
    c.circle(x + 5, y - 18, 2, stroke=1, fill=0)
    c.line(x + 1.5, y - 18, x + 8.5, y - 18)
    c.line(x + 5, y - 21.5, x + 5, y - 14.5)
    c.drawString(x + 13, y - 19, "skewer hole: lines up the layers")


def overview(c, d, x0, y0, s=0.2):
    """Plan and side view at 1:5 from the 3D data."""
    c.setFont("Helvetica-Bold", 3)
    c.setFillColorRGB(0.1, 0.1, 0.15)
    py = y0 + 30
    sy = y0 - 100
    c.drawString(x0, py + 34, "PLAN (from above), scale 1:5")
    c.drawString(x0 + 70, sy + 84, "SIDE, scale 1:5")
    for ly in d["layers"]:
        if ly["layer"] == max(l["layer"] for l in d["layers"]):
            draw_els(c, [("poly", [(x * s, y * s) for x, y in ly["pts"]], "cut")], x0, py)
        for h in ly["holes"]:
            if ly["layer"] == 2:
                draw_els(c, [("poly", [(x * s, y * s) for x, y in h], "mark")], x0, py)
    for sl in d["slabs"]:
        draw_els(c, [("poly", [(x * s, y * s) for x, y in sl["pts"]], "fold")], x0, py)
    for ly in d["layers"]:
        xs = [p[0] for p in ly["pts"]]
        draw_els(c, [("poly", rect(min(xs) * s, ly["z0"] * s, max(xs) * s, (ly["z0"] + ly["h"]) * s), "cut")], x0, sy)
    for p in d["parts"]:
        if p["kind"] == "box":
            sx, syy, sz = p["s"]
            cx, cy, cz = p["c"]
            draw_els(c, [("poly", rect((cx - sx / 2) * s, (cy - syy / 2) * s, (cx + sx / 2) * s, (cy + syy / 2) * s),
                          "mark")], x0, py)
            a = math.radians(p["pitch"])
            corners = [(-sx / 2, -sz / 2), (sx / 2, -sz / 2), (sx / 2, sz / 2), (-sx / 2, sz / 2)]
            pts = [((cx + u * math.cos(a) - v * math.sin(a)) * s, (cz + u * math.sin(a) + v * math.cos(a)) * s)
                   for u, v in corners]
            draw_els(c, [("poly", pts, "mark")], x0, sy)
        elif p["kind"] == "sphere":
            cx, cy, cz = p["c"]
            draw_els(c, [("circle", (cx * s, cy * s), p["r"] * s, "mark")], x0, py)
            draw_els(c, [("circle", (cx * s, cz * s), p["r"] * s, "mark")], x0, sy)
        elif p["kind"] == "cyl":
            cx, cy, cz = p["c"]
            r, h = p["r"], p["h"]
            if p["axis"] == "z":
                draw_els(c, [("circle", (cx * s, cy * s), r * s, "mark")], x0, py)
                draw_els(c, [("poly", rect((cx - r) * s, (cz - h / 2) * s, (cx + r) * s, (cz + h / 2) * s), "mark")],
                         x0, sy)
            elif p["axis"] == "x":
                draw_els(c, [("poly", rect((cx - h / 2) * s, (cz - r) * s, (cx + h / 2) * s, (cz + r) * s), "mark")], x0, sy)
                draw_els(c, [("poly", rect((cx - h / 2) * s, (cy - r) * s, (cx + h / 2) * s, (cy + r) * s), "mark")], x0, py)
            else:
                draw_els(c, [("circle", (cx * s, cz * s), r * s, "mark")], x0, sy)
                draw_els(c, [("poly", rect((cx - r) * s, (cy - h / 2) * s, (cx + r) * s, (cy + h / 2) * s), "mark")], x0, py)
    wl = d["specs"]["empty"]["draft_mm"]
    set_style(c, "fold")
    c.line(x0 - 4, sy + wl * s, x0 + L * s + 4, sy + wl * s)
    c.setDash([])
    c.setFont("Helvetica", 2.4)
    c.drawString(x0 + L * s + 5, sy + wl * s - 0.8, f"waterline {wl} mm")
    # key dimensions
    c.setFont("Helvetica", 2.6)
    c.drawCentredString(x0 + L * s / 2, py - W * s / 2 - 5, "600 mm")
    c.drawString(x0 + L * s + 3, py, "300 mm")


def print_test(c, d, head):
    head("PRINT THIS PAGE FIRST and check the size")
    x0, y0 = MARGIN + 10, MARGIN + 8
    set_style(c, "cut")
    c.rect(x0, y0, 100, 100, stroke=1, fill=0)
    c.setFillColorRGB(0.1, 0.1, 0.15)
    c.setFont("Helvetica-Bold", 4)
    c.drawCentredString(x0 + 50, y0 + 52, "100 mm x 100 mm")
    bar = 200 if PAGE_W > 300 else 150
    by = y0 + 112
    c.line(x0, by, x0 + bar, by)
    for i in range(bar + 1):
        t = 4 if i % 10 == 0 else (2.5 if i % 5 == 0 else 1.4)
        c.line(x0 + i, by, x0 + i, by + t)
        if i % 10 == 0:
            c.setFont("Helvetica", 2.4)
            c.drawCentredString(x0 + i, by + 5.2, str(i))
    c.setFont("Helvetica", 2.6)
    c.drawString(x0, by - 5, f"ruler in mm: the 0 to {bar} marks must be exactly {bar} mm apart")
    tx = x0 + 115
    lines = [f"How to print on {PAPER} so every part comes out real size",
             f"1. Paper: {PAPER}, landscape. Printer: '{PAPER}' selected as the paper size.",
             "2. Scaling: 'Actual size' or '100%'. Turn OFF 'Fit to page', 'Shrink oversized pages'",
             "   and 'Fit to printable area'. On a phone, choose 'Original size' / 'Do not scale'.",
             "3. Print this page only. Measure the square with a steel ruler: both sides must be",
             "   100 mm, and the ruler marks must match your ruler. 1 mm off is fine; more is not.",
             "4. If it is wrong, fix the printer setting and print this page again. Do not go on.",
             "5. When it is right, print all the other pages with the SAME settings.",
             "6. Big parts are split across pages (tiles A1, A2, B1...). Cut each tile on its border,",
             "   lay the next tile over the grey overlap strip, line up the grey 50 mm grid and the",
             "   measurement ruler, and tape it. Check the long measurement with a tape before cutting.",
             "7. Glue-stick the paper on the thermocol, cut along the solid black line,",
             "   cut out the red parts, and push a skewer through every + mark.",
             "Line types:"]
    y = y0 + 98
    for i, t in enumerate(lines):
        c.setFont("Helvetica-Bold" if i == 0 else "Helvetica", 3.4 if i == 0 else 2.9)
        c.drawString(tx, y, t)
        y -= 6 if i == 0 else 4.6
    draw_legend(c, tx, y - 4)
    set_style(c, "dim")
    c.line(tx + 120, y - 4, tx + 130, y - 4)
    c.setFont("Helvetica", 2.8)
    c.drawString(tx + 133, y - 5, "measurement (mm), do not cut")
    new_page(c)


def build_pdf(d, path, large=False, paper="A4"):
    set_paper(paper)
    c = canvas.Canvas(path, pagesize=(PAGE_W * mm, PAGE_H * mm))
    c.setTitle(f"{full_name(d)} templates")
    c.scale(mm, mm)
    pno = [1]

    def head(title):
        page_header(c, d, title, pno[0])
        pno[0] += 1

    # cover
    head("overview, specs and shopping list")
    sp = d["specs"]
    c.setFont("Helvetica-Bold", 7)
    c.drawString(MARGIN, PAGE_H - 25, f"{full_name(d)}")
    c.setFont("Helvetica", 3.2)
    c.drawString(MARGIN, PAGE_H - 31, f"{L} x {W} mm thermocol boat  |  {d['tag']}")
    overview(c, d, MARGIN + 6, PAGE_H - 102)
    tx = 160
    rows = [("Size", f"{L} x {W} mm, hull {sp['hull_height']} mm tall, {sp['overall_height']} mm to GPS top"),
            ("Weight", f"{sp['empty']['mass_g']} g empty, {sp['full']['mass_g']} g with {sp['payload_g']} g of plastic"),
            ("Draft", f"{sp['empty']['draft_mm']} mm empty, {sp['full']['draft_mm']} mm full"),
            ("Reserve buoyancy", f"{sp['reserve_kg']} kg before the deck goes under"),
            ("Stability (GM)", f"{sp['empty']['gm_t_mm']} mm: very stable"),
            ("Trim", f"bow {sp['empty']['bow_up_mm']} mm higher than stern empty; slide the battery to level"),
            ("Collection", f"{sp['bin_l']} L {dict(zip(['conveyor-cat', 'ai-pod'], ['deck bin', 'pull-out drawer'])).get(d['id'], 'basket')}"),
            ("Camera", f"{sp['cam_height_mm']} mm above water, tilted {sp['cam_tilt']} deg down"),
            ("Battery", f"{sp['battery']}, about {sp['runtime_h']} h"),
            ("Thermocol", sp["foam_text"])]
    y = PAGE_H - 44
    for k, v in rows:
        c.setFont("Helvetica-Bold", 3)
        c.drawString(tx, y, k)
        c.setFont("Helvetica", 3)
        c.drawString(tx + 30, y, v)
        y -= 5.2
    y -= 3
    c.setFont("Helvetica-Bold", 3.4)
    c.drawString(tx, y, "How to use these templates")
    tips = ["1. Print at 100% / Actual size. Check the 50 mm bar with a ruler.",
            "2. Join tiles by matching the grey 50 mm grid and the tile letters.",
            "3. Stick the paper on thermocol with a glue stick.",
            "4. Cut with a hot-wire cutter or a new snap-off blade, held upright.",
            "5. Stack layers on skewers through the + holes. Glue with Fevicol SH.",
            "6. Never use Fevikwik, spray paint or solvent glue: they melt thermocol.",
            "7. Sand the bow steps smooth, coat with PVA + tissue or packing tape,",
            "   then water-based acrylic paint.",
            "8. Float-test in a tub before fitting the electronics."]
    c.setFont("Helvetica", 2.9)
    for t in tips:
        y -= 4.4
        c.drawString(tx, y, t)
    draw_legend(c, tx, 34)
    new_page(c)
    if not large:
        print_test(c, d, head)

    # tiled big sheets
    for sh in d["sheets"]:
        bx0, by0, bx1, by1 = sh["bbox"]
        sw, shh = bx1 - bx0 + 2 * PAD, by1 - by0 + 2 * PAD
        if large:
            pw, ph, pname = next((a, b, n) for a, b, n in ((420, 297, "A3"), (594, 420, "A2"), (841, 594, "A1"),
                                                         (1189, 841, "A0")) if sw + 12 <= a and shh + 30 <= b)
            c.setPageSize((pw * mm, ph * mm))
            c.setFont("Helvetica-Bold", 4)
            c.setFillColorRGB(0.1, 0.1, 0.15)
            cp = f" | PRINT {sh['copies']} COPIES" if sh.get("copies", 1) > 1 else ""
            c.drawString(8, ph - 10, f"{full_name(d)} | {sh['name']} | {sh['material']} | {pname}, print at 100%{cp}")
            c.setFont("Helvetica", 3)
            c.drawString(8, ph - 15, sh["note"])
            c.rect(8, 5, 100, 4, stroke=1, fill=0)
            c.drawString(110, 6, "<- must measure 100 mm")
            draw_els(c, sh["els"], (pw - (bx1 - bx0)) / 2 - bx0, (ph - 20 - (by1 - by0)) / 2 + 10 - by0)
            new_page(c)
            continue
        step_x, step_y = USE_W - OVERLAP, USE_H - OVERLAP
        cols = 1 if sw <= USE_W else 1 + math.ceil((sw - USE_W) / step_x)
        rows_n = 1 if shh <= USE_H else 1 + math.ceil((shh - USE_H) / step_y)
        for r in range(rows_n):
            for col in range(cols):
                tag = f"{chr(65 + r)}{col + 1}"
                cp = f"  PRINT {sh['copies']} COPIES" if sh.get("copies", 1) > 1 else ""
                head(f"{sh['name']} - tile {tag} of {chr(64 + rows_n)}{cols}  ({sh['material']}){cp}")
                wx0 = col * step_x - PAD + bx0
                wy1 = by1 + PAD - r * step_y
                wy0 = wy1 - USE_H
                ox, oy = MARGIN - wx0, MARGIN - wy0
                c.saveState()
                p = c.beginPath()
                p.rect(MARGIN, MARGIN, USE_W, USE_H)
                c.clipPath(p, stroke=0, fill=0)
                # 50 mm alignment grid in sheet coordinates
                c.setStrokeColorRGB(0.82, 0.84, 0.88)
                c.setLineWidth(0.15)
                gx = math.floor(wx0 / 50) * 50
                while gx < wx0 + USE_W + 50:
                    c.line(gx + ox, MARGIN, gx + ox, MARGIN + USE_H)
                    gx += 50
                gy = math.floor(wy0 / 50) * 50
                while gy < wy1 + 50:
                    c.line(MARGIN, gy + oy, MARGIN + USE_W, gy + oy)
                    gy += 50
                # overlap strips (glue the next tile over these)
                c.setFillColorRGB(0.93, 0.94, 0.97)
                if col < cols - 1:
                    c.rect(MARGIN + USE_W - OVERLAP, MARGIN, OVERLAP, USE_H, stroke=0, fill=1)
                if r < rows_n - 1:
                    c.rect(MARGIN, MARGIN, USE_W, OVERLAP, stroke=0, fill=1)
                draw_els(c, sh["els"], ox, oy)
                c.restoreState()
                c.setFont("Helvetica-Bold", 4)
                c.setFillColorRGB(0.55, 0.57, 0.62)
                c.drawString(MARGIN + 2, MARGIN + USE_H - 5, tag)
                c.setFont("Helvetica", 2.4)
                if col < cols - 1:
                    c.drawRightString(MARGIN + USE_W - 1, MARGIN + USE_H / 2, f"overlap: tile {chr(65 + r)}{col + 2} goes on top")
                if r < rows_n - 1:
                    c.drawString(MARGIN + 12, MARGIN + 3, f"overlap: tile {chr(66 + r)}{col + 1} goes on top")
                c.setStrokeColorRGB(0.5, 0.5, 0.55)
                c.setLineWidth(0.2)
                c.rect(MARGIN, MARGIN, USE_W, USE_H, stroke=1, fill=0)
                new_page(c)
    if large:
        c.setPageSize((PAGE_W * mm, PAGE_H * mm))

    # small parts, shelf-packed onto A4 pages
    pieces = [rotate_part(p) if p["bbox"][3] - p["bbox"][1] + 12 > USE_H else p for p in d["small"]]
    pieces = sorted(pieces, key=lambda p: -(p["bbox"][3] - p["bbox"][1]))
    pages, cur, x, y, shelf = [], [], 0, 0, 0
    for pc in pieces:
        w = pc["bbox"][2] - pc["bbox"][0] + 6
        h = pc["bbox"][3] - pc["bbox"][1] + 12
        if x + w > USE_W:
            x, y, shelf = 0, y + shelf, 0
        if y + h > USE_H:
            pages.append(cur)
            cur, x, y, shelf = [], 0, 0, 0
        cur.append((pc, x, y))
        x += w
        shelf = max(shelf, h)
    if cur:
        pages.append(cur)
    for i, pg in enumerate(pages):
        head(f"small parts {i + 1} of {len(pages)}")
        for pc, x, y in pg:
            bx0, by0, bx1, by1 = pc["bbox"]
            top = PAGE_H - MARGIN - HEAD - y
            ox, oy = MARGIN + x - bx0 + 1, top - (by1 - by0) - by0 - 8
            draw_els(c, pc["els"], ox, oy)
            c.setFillColorRGB(0.1, 0.1, 0.15)
            c.setFont("Helvetica-Bold", 2.6)
            c.drawString(MARGIN + x + 1, top - 3, pc["name"][:48])
            c.setFont("Helvetica", 2.2)
            c.drawString(MARGIN + x + 1, top - 6, f"{pc['material'][:40]}  |  {bx1 - bx0:.0f} x {by1 - by0:.0f} mm")
        new_page(c)
    c.save()


# ------------------------------------------------------------------ main

BUILD_STEPS = {
    "common_start": [
        ("Print and check", "Print the A4 pack at 100% (Actual size, not Fit to page). The 50 mm bar on every page must "
                            "measure 50 mm. A print shop can print the large-format file on one sheet instead."),
        ("Join the tiles", "Trim, then overlap each tile onto the grey strip of its neighbour, matching the 50 mm grid "
                           "and the letters (A1, A2, B1...). Tape on the back."),
        ("Cut the thermocol", "Stick each template on 25 mm thermocol with a glue stick. Cut with a hot-wire cutter "
                              "(cleanest) or a new snap-off blade held upright. Cut red windows and pockets too."),
        ("Stack and glue", "Push bamboo skewers through the + holes so the three layers line up. Spread Fevicol SH "
                           "thinly, press, and leave under weight overnight. Do not use Fevikwik or solvent glue."),
        ("Shape the bow", "The bottom layer is 60 mm shorter and the middle 30 mm shorter, so the bow rises in "
                          "steps. Sand the steps into a smooth curve with 120-grit paper."),
        ("Waterproof", "Two coats of PVA with tissue paper (or wrap in brown packing tape), then water-based acrylic "
                       "paint. Never spray paint: it melts thermocol."),
    ],
    "common_end": [
        ("Fit the motors", "Glue the towers and gussets, screw the 2205 motors on the stern side, fit one CW and one "
                           "CCW 5045 prop so both push air backwards. Glue the guard rings on."),
        ("Wire the electronics", "Lay the floor guide in the box and fix each part on its outline. ESCs to Pixhawk "
                                 "MAIN 1 (left) and MAIN 3 (right). Pi Zero to TELEM2. ADS1115 on I2C. Seal cable "
                                 "holes with hot glue."),
        ("Float test", "Put it in a tub with the battery in. The waterline should be close to the figure on the spec "
                       "card. Slide the battery on its Velcro until the boat sits level."),
        ("Set up ArduRover", "Skid steering: SERVO1_FUNCTION = 73 (throttle left), SERVO3_FUNCTION = 74 (throttle "
                             "right). Flash the ESCs to 3D mode so the boat can reverse and turn on the spot."),
        ("Set the camera in the app", "In Boat Vision settings, enter the camera height and tilt from the spec card."),
    ],
    "twin-hull": [
        ("Join the pontoons", "Glue the deck on both pontoons with the channel exactly 140 mm wide (use the deck as "
                              "the gauge). Glue and screw the two wooden crossbars on the marks."),
        ("Ramp and basket", "Glue the two ramp wedges to the channel walls on the bottom-layer marks, then the mesh "
                            "ramp on top. Build the basket, tape the PET flap inside the entrance, and hang it by its "
                            "lips on the pontoon tops."),
    ],
    "u-hull": [
        ("Pocket and hatch", "The electronics pocket is cut through layers 2 and 3. Paint the inside, stick foam tape "
                             "round the rim, and make the hatch lid hold down with two rubber bands."),
        ("Ramp and basket", "Glue the ramp wedges to the slot walls on the bottom-layer marks, then the mesh ramp. "
                            "Build the basket, tape the flap inside the entrance, hang it by its lips."),
    ],
    "ai-pod": [
        ("Build the base", "Base layers 1 to 3 are solid except the drawer tunnel at the bow, the 4 sensor wells and "
                           "the beam slot in layer 1. Glue them on skewers, then glue the wooden thruster beam into "
                           "the slot."),
        ("Roof the tunnel", "Glue the 5 mm tunnel roof over the tunnel on top of layer 3 and seal every edge with hot "
                            "glue: it is the floor of the dry bay. Glue the two drawer rails along the tunnel walls."),
        ("Build the walls", "Stack wall ring, wall ring (with the 3 ultrasonic holes), ledge ring, wall ring. Line them "
                            "up on the skewers. The fourth wall-ring copy is the lid rim: glue it under the lid top, not "
                            "to the hull."),
        ("Fit the lower bay", "Battery, ESCs, buck converter, relay, pump, spray tank and solar module go on the "
                              "dashed outlines on the floor. Heavy parts low keep the boat from rolling."),
        ("Fit the shelf", "Lay the shelf on the ledge, then the Pixhawk, Pi, ADS1115 and sensor boards on their "
                          "outlines. Cables pass through the two slots."),
        ("Sensors and lights", "Push the pH, TDS, turbidity and temperature probes through their wells so the tips "
                               "sit 15 mm below the hull, and seal with hot glue. Fit the 3 ultrasonic sensors, the "
                               "front camera behind a clear plastic window, the UV LEDs and the LED strip."),
        ("Lid and bumper", "Glue the solar panel, servo plate, GPS mast and nozzles on the lid. Seal the lid to the "
                           "top ring with foam tape and hold it with 4 rubber bands. Glue split black pipe insulation "
                           "round the waterline as the bumper."),
        ("Thrusters and drawer", "Bolt the two thrusters under the beam. Build the mesh drawer, tape the flap inside "
                                 "its entrance and slide it in on the rails."),
    ],
    "conveyor-cat": [
        ("Join the pontoons", "Glue the deck on both pontoons with the channel exactly 140 mm wide. Glue and screw "
                              "the bow crossbar."),
        ("Build the conveyor", "Glue the plugs into the PVC rollers, slide the 6 mm rods through. Stick the cleats on "
                               "the mesh belt every 35 mm and join it into a loop. Fit the rollers between the side "
                               "plates, then glue the plates to the channel walls at the angle on the guide."),
        ("Motor and bin", "Mount the 25GA gear motor on its bracket outside the left plate, coupled to the top roller. "
                          "Switch it from the Pi through a MOSFET module. Put the bin on its deck outline."),
    ],
}


def main():
    os.makedirs(OUT, exist_ok=True)
    designs = [design_pod(), design_twin(), design_block(), design_twin(conveyor=True)]
    designs[2]["foam_text"] = "3 sheets 1000 x 500, or 1 sheet 2 x 3 ft (610 x 915)"
    designs[0]["foam_text"] = "8 sheets 1000 x 500, or 3 sheets 2 x 3 ft (610 x 915)"
    for d in designs:
        hydro(d)
        add_dims(d)
        build_pdf(d, os.path.join(OUT, f"{d['id']}_A3.pdf"), paper="A3")
        build_pdf(d, os.path.join(OUT, f"{d['id']}_A4.pdf"))
        build_pdf(d, os.path.join(OUT, f"{d['id']}_large-format.pdf"), large=True)
    data = []
    for d in designs:
        steps = BUILD_STEPS["common_start"] + BUILD_STEPS[d["id"]] + BUILD_STEPS["common_end"]
        cut = [{"name": s["name"], "material": s["material"], "note": s["note"]} for s in d["sheets"]]
        seen = {}
        for s in d["small"]:
            key = (s["name"], s["material"])
            seen[key] = seen.get(key, 0) + 1
        cut += [{"name": f"{n} x{q}" if q > 1 else n, "material": m, "note": ""} for (n, m), q in seen.items()]
        data.append({
            "id": d["id"], "name": d["name"], "tag": d["tag"], "summary": d["summary"], "specs": d["specs"],
            "layers": [{k: v for k, v in ly.items()} for ly in d["layers"]],
            "slabs": d["slabs"], "parts": d["parts"], "steps": steps, "cut": cut,
            "conveyor": d.get("conveyor"), "electronics": d.get("electronics", ELECTRONICS),
        })
    payload = {"designs": data, "shop": SHOP, "colors": C,
               "bow_end": BOW_END, "T": T}
    with open(os.path.join(HERE, "designs.json"), "w") as f:
        json.dump(payload, f, separators=(",", ":"))
    tpl = open(os.path.join(HERE, "viewer_template.html")).read()
    with open(os.path.join(HERE, "boat-3d.html"), "w") as f:
        f.write(tpl.replace("/*DATA*/null", json.dumps(payload, separators=(",", ":"))))
    for d in designs:
        print(d["name"], json.dumps(d["specs"]))


if __name__ == "__main__":
    main()
