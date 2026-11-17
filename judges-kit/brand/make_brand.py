# Varuna x Nirmal Dhara master logo.
# The mark: the V of VARUNA drawn as a water drop opened at the top. The drone
# hovers in the opening and watches the river held in the drop, where Nirmal
# Dhara Jalyan sails over a saffron-white-green stream toward a spotted bottle.
#   python make_brand.py   -> SVGs + _render_*.html wrappers (render.sh makes PNG/PDF)
import pathlib

HERE = pathlib.Path(__file__).parent
SAFFRON, GREEN, WHITE = "#ff9933", "#1a9a2a", "#ffffff"
NAVY, NAVY2 = "#061428", "#0b2a55"
FONTS = "https://fonts.googleapis.com/css2?family=Syncopate:wght@700&family=Rajdhani:wght@600;700&display=swap"
WORD = "Syncopate, 'Segoe UI', Arial, sans-serif"
SUB = "Rajdhani, 'Nirmala UI', 'Segoe UI', Arial, sans-serif"

# bounding box of the mark in its own 512 space
BX0, BY0, BX1, BY1 = 52, 48, 460, 498


def mark(p, theme="dark"):
    craft = WHITE if theme == "dark" else NAVY2
    return f'''
<defs>
  <linearGradient id="{p}-ring" x1="0" y1="0" x2="1" y2="0">
    <stop offset="0" stop-color="#3fdcff"/><stop offset="0.5" stop-color="#1670d8"/><stop offset="1" stop-color="#14d1a6"/>
  </linearGradient>
  <linearGradient id="{p}-sky" x1="0" y1="0" x2="0" y2="1">
    <stop offset="0" stop-color="#0f3a72"/><stop offset="1" stop-color="#0a2550"/>
  </linearGradient>
  <linearGradient id="{p}-water" x1="0" y1="0" x2="0" y2="1">
    <stop offset="0" stop-color="#1690e6"/><stop offset="1" stop-color="#0b4592"/>
  </linearGradient>
  <linearGradient id="{p}-beam" x1="0" y1="0" x2="0" y2="1">
    <stop offset="0" stop-color="#8be9ff" stop-opacity="0.55"/><stop offset="1" stop-color="#8be9ff" stop-opacity="0.08"/>
  </linearGradient>
  <radialGradient id="{p}-shine" cx="0.32" cy="0.25" r="0.75">
    <stop offset="0" stop-color="#ffffff" stop-opacity="0.18"/><stop offset="1" stop-color="#ffffff" stop-opacity="0"/>
  </radialGradient>
  <clipPath id="{p}-in"><circle cx="256" cy="330" r="124"/></clipPath>
  <clipPath id="{p}-hull"><path d="M196 318 L284 318 L284 334 Q284 342 276 342 L204 342 Q196 342 196 334 Z"/></clipPath>
</defs>
<g clip-path="url(#{p}-in)">
  <rect x="120" y="190" width="280" height="280" fill="url(#{p}-sky)"/>
  <circle cx="186" cy="246" r="2" fill="#ffffff" opacity="0.7"/>
  <circle cx="214" cy="226" r="1.5" fill="#ffffff" opacity="0.5"/>
  <circle cx="330" cy="236" r="1.8" fill="#ffffff" opacity="0.6"/>
  <path d="M120 338 Q150 328 180 338 T240 338 T300 338 T360 338 T420 338 V470 H120 Z" fill="url(#{p}-water)"/>
  <path d="M112 392 C 190 352, 290 432, 404 372" fill="none" stroke="{SAFFRON}" stroke-width="9" stroke-linecap="round"/>
  <path d="M112 410 C 190 370, 290 450, 404 390" fill="none" stroke="#ffffff" stroke-width="9" stroke-linecap="round"/>
  <path d="M112 428 C 190 388, 290 468, 404 408" fill="none" stroke="{GREEN}" stroke-width="9" stroke-linecap="round"/>
</g>
<polygon points="256,166 316,340 364,340" fill="url(#{p}-beam)"/>
<g clip-path="url(#{p}-in)">
  <!-- Nirmal Dhara Jalyan -->
  <path d="M196 318 L284 318 L284 334 Q284 342 276 342 L204 342 Q196 342 196 334 Z" fill="#ffffff"/>
  <g clip-path="url(#{p}-hull)">
    <rect x="196" y="318" width="88" height="6" fill="{SAFFRON}"/>
    <rect x="196" y="336" width="88" height="6" fill="{GREEN}"/>
  </g>
  <rect x="206" y="304" width="36" height="14" rx="4" fill="#d6e6f5"/>
  <line x1="232" y1="304" x2="232" y2="286" stroke="#ffffff" stroke-width="3" stroke-linecap="round"/>
  <ellipse cx="232" cy="284" rx="8" ry="3" fill="#ffffff"/>
  <line x1="285" y1="321" x2="306" y2="343" stroke="#ffffff" stroke-width="6" stroke-linecap="round"/>
  <!-- the bottle the drone found, in its AI box -->
  <g transform="translate(340 339) rotate(-15)">
    <rect x="-10" y="-5" width="17" height="10" rx="4" fill="#a8f0ff"/>
    <rect x="6" y="-3" width="6" height="6" rx="1.5" fill="#a8f0ff"/>
  </g>
  <path d="M322 322 v-6 h8 M350 316 h8 v6 M358 352 v6 h-8 M330 358 h-8 v-6" fill="none" stroke="{SAFFRON}" stroke-width="3.2" stroke-linecap="round" stroke-linejoin="round"/>
</g>
<!-- the V-drop -->
<path fill="url(#{p}-ring)" d="M52 48 C82 150 88 250 88 330 A168 168 0 0 0 424 330 C424 250 430 150 460 48
   C418 150 388 250 388 330 A132 132 0 0 1 124 330 C124 250 94 150 52 48 Z"/>
<path fill="url(#{p}-shine)" d="M52 48 C82 150 88 250 88 330 A168 168 0 0 0 424 330 C424 250 430 150 460 48
   C418 150 388 250 388 330 A132 132 0 0 1 124 330 C124 250 94 150 52 48 Z"/>
<!-- the drone, hovering in the opening -->
<g fill="{craft}">
  <rect x="196" y="147" width="120" height="6" rx="3"/>
  <rect x="236" y="140" width="40" height="19" rx="8"/>
  <rect x="200" y="134" width="6" height="15" rx="2"/>
  <rect x="306" y="134" width="6" height="15" rx="2"/>
  <ellipse cx="203" cy="132" rx="27" ry="4.5"/>
  <ellipse cx="309" cy="132" rx="27" ry="4.5"/>
</g>
<circle cx="256" cy="163" r="5.5" fill="{SAFFRON}"/>'''


def place(p, theme, x0, y0, s):
    return f'<g transform="translate({x0 - BX0 * s:.2f} {y0 - BY0 * s:.2f}) scale({s})">{mark(p, theme)}</g>'


def style(theme):
    ink = "#ffffff" if theme == "dark" else NAVY
    sub = "#4fd6f5" if theme == "dark" else "#0d6cc2"
    mute = "#9fb4d4" if theme == "dark" else "#4a5d7a"
    return ink, sub, mute


def tricolour(x, y, w, h, theme):
    seg = (w - 8) / 3
    mid = f'fill="#ffffff"' + ('' if theme == "dark" else f' stroke="{NAVY}" stroke-width="2"')
    return (f'<rect x="{x}" y="{y}" width="{seg:.1f}" height="{h}" rx="{h/2}" fill="{SAFFRON}"/>'
            f'<rect x="{x + seg + 4:.1f}" y="{y}" width="{seg:.1f}" height="{h}" rx="{h/2}" {mid}/>'
            f'<rect x="{x + 2 * seg + 8:.1f}" y="{y}" width="{seg:.1f}" height="{h}" rx="{h/2}" fill="{GREEN}"/>')


def svg_open(w, h, title):
    return (f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {w} {h}" width="{w}" height="{h}">'
            f'<title>{title}</title><style>@import url(\'{FONTS.replace("&", "&amp;")}\');'
            f'.w{{font-family:{WORD};font-weight:700}}.s{{font-family:{SUB};font-weight:700}}.d{{font-family:{SUB};font-weight:600}}</style>')


def horizontal(theme, bg):
    ink, sub, mute = style(theme)
    W, H = 1780, 520
    s = svg_open(W, H, "Varuna · Nirmal Dhara")
    if bg:
        s += f'<rect width="{W}" height="{H}" rx="36" fill="{NAVY}"/>'
    s += place(f"h{theme[0]}", theme, 50, 35, 1.0)
    s += f'<text class="w" x="512" y="205" font-size="150" letter-spacing="18" fill="{ink}">VARUNA</text>'
    s += tricolour(518, 236, 1194, 12, theme)
    s += f'<text class="s" x="516" y="345" font-size="104" letter-spacing="16" fill="{sub}">NIRMAL DHARA</text>'
    s += f'<text class="d" x="1712" y="345" font-size="76" fill="{mute}" text-anchor="end">निर्मल धारा</text>'
    s += f'<text class="d" x="518" y="420" font-size="34" letter-spacing="10" fill="{mute}">AI DRONE · AUTONOMOUS BOAT · CLEANER RIVERS</text>'
    return s + "</svg>"


def stacked(theme, bg):
    ink, sub, mute = style(theme)
    W, H = 1100, 1180
    s = svg_open(W, H, "Varuna · Nirmal Dhara")
    if bg:
        s += f'<rect width="{W}" height="{H}" rx="48" fill="{NAVY}"/>'
    sc = 1.12
    s += place(f"s{theme[0]}", theme, (W - (BX1 - BX0) * sc) / 2, 60, sc)
    s += f'<text class="w" x="{W/2}" y="712" font-size="142" letter-spacing="16" fill="{ink}" text-anchor="middle">VARUNA</text>'
    s += f'<text class="s" x="{W/2}" y="830" font-size="92" letter-spacing="14" fill="{sub}" text-anchor="middle">NIRMAL DHARA</text>'
    s += f'<text class="d" x="{W/2}" y="910" font-size="62" fill="{mute}" text-anchor="middle">वरुण · निर्मल धारा</text>'
    s += tricolour(170, 958, 760, 12, theme)
    s += f'<text class="d" x="{W/2}" y="1050" font-size="31" letter-spacing="9" fill="{mute}" text-anchor="middle">AI DRONE · AUTONOMOUS BOAT · CLEANER RIVERS</text>'
    return s + "</svg>"


def icon():
    W = 1024
    s = svg_open(W, W, "Varuna icon")
    s += ('<defs><linearGradient id="ic-bg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#0d2c5a"/>'
          '<stop offset="1" stop-color="#040d1d"/></linearGradient></defs>')
    s += f'<rect x="32" y="32" width="960" height="960" rx="220" fill="url(#ic-bg)"/>'
    sc = 1.72
    s += place("ic", "dark", (W - (BX1 - BX0) * sc) / 2, (W - (BY1 - BY0) * sc) / 2, sc)
    return s + "</svg>"


def mark_only(theme):
    W, H = 472, 520
    s = svg_open(W, H, "Varuna mark")
    s += place(f"m{theme[0]}", theme, 32, 35, 1.0)
    return s + "</svg>"



def emblem():
    # Round version: the mark in the middle, VARUNA over the top, NIRMAL DHARA under it.
    W, C = 1200, 600
    s = svg_open(W, W, "Varuna · Nirmal Dhara emblem")
    s += ('<defs>'
          '<radialGradient id="eo-bg" cx="0.38" cy="0.3" r="0.8"><stop offset="0" stop-color="#11407c"/>'
          '<stop offset="0.6" stop-color="#081d3c"/><stop offset="1" stop-color="#050f22"/></radialGradient>'
          '<linearGradient id="eo-ring" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#3fdcff"/>'
          '<stop offset="0.5" stop-color="#1670d8"/><stop offset="1" stop-color="#14d1a6"/></linearGradient>'
          f'<path id="em-top" d="M {C-468} {C} A 468 468 0 0 1 {C+468} {C}"/>'
          f'<path id="em-bot" d="M {C-522} {C} A 522 522 0 0 0 {C+522} {C}"/>'
          '</defs>')
    s += f'<circle cx="{C}" cy="{C}" r="596" fill="url(#eo-bg)"/>'
    s += f'<circle cx="{C}" cy="{C}" r="572" fill="none" stroke="url(#eo-ring)" stroke-width="12"/>'
    s += f'<circle cx="{C}" cy="{C}" r="548" fill="none" stroke="#ffffff" stroke-opacity="0.18" stroke-width="2"/>'
    # tricolour inner ring: saffron over the top, green under the bottom, white drops between
    import math
    def arc(r, a0, a1):
        x0, y0 = C + r * math.cos(math.radians(a0)), C + r * math.sin(math.radians(a0))
        x1, y1 = C + r * math.cos(math.radians(a1)), C + r * math.sin(math.radians(a1))
        return f"M {x0:.1f} {y0:.1f} A {r} {r} 0 0 1 {x1:.1f} {y1:.1f}"
    s += f'<path d="{arc(426, 192, 348)}" fill="none" stroke="{SAFFRON}" stroke-width="9" stroke-linecap="round"/>'
    s += f'<path d="{arc(426, 12, 168)}" fill="none" stroke="{GREEN}" stroke-width="9" stroke-linecap="round"/>'
    for x in (C - 426, C + 426):
        s += (f'<path transform="translate({x} {C + 4}) scale(1.25)" fill="#ffffff" '
              'd="M0,-22 C9,-9 15,-1 15,7 A15,15 0 1 1 -15,7 C-15,-1 -9,-9 0,-22Z"/>')
    s += (f'<text class="w" font-size="118" letter-spacing="34" fill="#ffffff">'
          f'<textPath href="#em-top" startOffset="50%" text-anchor="middle">VARUNA</textPath></text>')
    s += (f'<text class="s" font-size="84" letter-spacing="12" fill="#4fd6f5">'
          f'<textPath href="#em-bot" startOffset="50%" text-anchor="middle">NIRMAL DHARA'
          f'<tspan class="d" fill="#c9d8ee" font-size="76" letter-spacing="0">  ·  निर्मल धारा</tspan></textPath></text>')
    sc = 1.3
    s += place("em", "dark", C - (BX1 - BX0) * sc / 2, C - (BY1 - BY0) * sc / 2 + 6, sc)
    return s + "</svg>"

files = {
    "varuna-logo-horizontal-dark.svg": (horizontal("dark", True), 1780, 520),
    "varuna-logo-horizontal-light.svg": (horizontal("light", False), 1780, 520),
    "varuna-logo-stacked-dark.svg": (stacked("dark", True), 1100, 1180),
    "varuna-logo-stacked-light.svg": (stacked("light", False), 1100, 1180),
    "varuna-app-icon.svg": (icon(), 1024, 1024),
    "varuna-logo-circle.svg": (emblem(), 1200, 1200),
    "varuna-mark.svg": (mark_only("light"), 472, 520),
}
for name, (svg, w, h) in files.items():
    (HERE / name).write_text(svg, encoding="utf-8")
    wrap = (f'<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="{FONTS}">'
            f'<style>@page{{size:{w}px {h}px;margin:0}}html,body{{margin:0;background:transparent}}svg{{display:block}}</style>'
            f'</head><body>{svg}</body></html>')
    (HERE / f"_render_{name[:-4]}.html").write_text(wrap, encoding="utf-8")
print("\n".join(files))
