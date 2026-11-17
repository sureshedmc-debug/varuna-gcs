# Builds the Nirmal Dhara Jalyan logo files (SVG + print HTML wrappers).
# Run:  python make_logo.py   then render PNG/PDF with render.bat
import pathlib

HERE = pathlib.Path(__file__).parent
NAVY = "#081f3b"
SAFFRON = "#ff9933"
GREEN = "#138808"
RIVER = "#1f7fc4"
FONT_CSS = "@import url('https://fonts.googleapis.com/css2?family=Rajdhani:wght@600;700&amp;display=swap');"
FONT = "Rajdhani, 'Nirmala UI', 'Segoe UI', Arial, sans-serif"


def scene(p):
    """The round picture: drone spots a bottle, the boat comes to collect it. 1000x1000 space, circle r=330 at 500,500."""
    slats = ""
    for t in (0.2, 0.4, 0.6, 0.8):
        x, y = 642 + 93 * t, 548 + 92 * t
        slats += f'<line x1="{x - 5.6:.1f}" y1="{y + 5.7:.1f}" x2="{x + 5.6:.1f}" y2="{y - 5.7:.1f}" stroke="{NAVY}" stroke-width="4" stroke-linecap="round"/>'
    return f'''
  <defs>
    <clipPath id="{p}-in"><circle cx="500" cy="500" r="330"/></clipPath>
    <clipPath id="{p}-hull"><path d="M300 540 L640 540 L640 600 Q640 622 618 622 L322 622 Q300 622 300 600 Z"/></clipPath>
    <linearGradient id="{p}-sky" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#174d85"/><stop offset="1" stop-color="#0b2c55"/>
    </linearGradient>
  </defs>
  <g clip-path="url(#{p}-in)">
    <rect x="160" y="160" width="680" height="680" fill="url(#{p}-sky)"/>
    <!-- drone and its camera beam onto the bottle -->
    <polygon points="500,318 718,614 790,614" fill="#ffffff" opacity="0.13"/>
    <g fill="#ffffff">
      <rect x="470" y="292" width="60" height="22" rx="10"/>
      <rect x="428" y="294" width="144" height="7" rx="3.5"/>
      <rect x="436" y="278" width="10" height="20" rx="3"/>
      <rect x="554" y="278" width="10" height="20" rx="3"/>
      <ellipse cx="441" cy="276" rx="38" ry="6"/>
      <ellipse cx="559" cy="276" rx="38" ry="6"/>
      <circle cx="500" cy="320" r="7" fill="{SAFFRON}"/>
    </g>
    <g transform="translate(-50 0)">
    <!-- boat: white hull with saffron and green bands, like the real one -->
    <path d="M300 540 L640 540 L640 600 Q640 622 618 622 L322 622 Q300 622 300 600 Z" fill="#ffffff"/>
    <g clip-path="url(#{p}-hull)">
      <rect x="300" y="540" width="340" height="18" fill="{SAFFRON}"/>
      <rect x="300" y="604" width="340" height="18" fill="{GREEN}"/>
    </g>
    <rect x="330" y="500" width="130" height="40" rx="9" fill="#d9e6f2"/>
    <rect x="346" y="510" width="26" height="14" rx="3" fill="{NAVY}"/>
    <rect x="380" y="510" width="26" height="14" rx="3" fill="{NAVY}"/>
    <line x1="430" y1="500" x2="430" y2="430" stroke="#ffffff" stroke-width="7" stroke-linecap="round"/>
    <ellipse cx="430" cy="424" rx="24" ry="9" fill="#ffffff"/>
    <line x1="480" y1="540" x2="490" y2="452" stroke="#ffffff" stroke-width="4" stroke-linecap="round"/>
    <circle cx="490" cy="450" r="6" fill="{SAFFRON}"/>
    <!-- conveyor ramp at the bow -->
    <line x1="642" y1="548" x2="735" y2="640" stroke="#ffffff" stroke-width="22" stroke-linecap="round"/>
    {slats}
    </g>
    <!-- river -->
    <path d="M150 622 Q205 602 260 622 T370 622 T480 622 T590 622 T700 622 T810 622 T920 622 L920 900 L150 900 Z" fill="{RIVER}"/>
    <path d="M150 680 Q205 662 260 680 T370 680 T480 680 T590 680 T700 680 T810 680 T920 680" fill="none" stroke="#6cc3f0" stroke-width="10" stroke-linecap="round" opacity="0.8"/>
    <path d="M150 736 Q205 718 260 736 T370 736 T480 736 T590 736 T700 736 T810 736 T920 736" fill="none" stroke="#6cc3f0" stroke-width="10" stroke-linecap="round" opacity="0.5"/>
    <!-- the plastic bottle it is going for -->
    <g transform="translate(752 620) rotate(-18)">
      <rect x="-24" y="-11" width="44" height="22" rx="8" fill="#9be7ff"/>
      <rect x="18" y="-6" width="14" height="12" rx="3" fill="#9be7ff"/>
      <rect x="31" y="-7" width="6" height="14" rx="2" fill="{SAFFRON}"/>
    </g>
  </g>'''


def drop(x, y, color, s=1.0):
    return (f'<path transform="translate({x} {y}) scale({s})" fill="{color}" '
            f'd="M0,-22 C9,-9 15,-1 15,7 A15,15 0 1 1 -15,7 C-15,-1 -9,-9 0,-22Z"/>')


def badge():
    return f'''<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1000 1000" width="1000" height="1000">
  <title>Nirmal Dhara Jalyan</title>
  <style>{FONT_CSS} .n {{ font-family: {FONT}; font-weight: 700; }}</style>
  <defs>
    <path id="bd-top" d="M 98 500 A 402 402 0 0 1 902 500"/>
    <path id="bd-bot" d="M 60 500 A 440 440 0 0 0 940 500"/>
  </defs>
  <circle cx="500" cy="500" r="496" fill="{NAVY}"/>
  <circle cx="500" cy="500" r="474" fill="none" stroke="#ffffff" stroke-width="5"/>
  <circle cx="500" cy="500" r="346" fill="none" stroke="#ffffff" stroke-width="6"/>
  {scene("bd")}
  <text class="n" font-size="78" letter-spacing="7" fill="#ffffff">
    <textPath href="#bd-top" startOffset="50%" text-anchor="middle">NIRMAL DHARA JALYAN</textPath>
  </text>
  <text class="n" font-size="68" fill="#ffffff">
    <textPath href="#bd-bot" startOffset="50%" text-anchor="middle">निर्मल धारा जलयान</textPath>
  </text>
  {drop(88, 508, SAFFRON, 1.1)}
  {drop(912, 508, GREEN, 1.1)}
</svg>'''


def decal():
    # Side-of-hull sticker, 4:1. The round picture on the left, the name on the right.
    return f'''<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 2400 600" width="2400" height="600">
  <title>Nirmal Dhara Jalyan - hull decal</title>
  <style>{FONT_CSS} .n {{ font-family: {FONT}; font-weight: 700; }} .m {{ font-family: {FONT}; font-weight: 600; }}</style>
  <rect x="6" y="6" width="2388" height="588" rx="64" fill="#ffffff" stroke="{NAVY}" stroke-width="8"/>
  <circle cx="300" cy="300" r="250" fill="{NAVY}"/>
  <svg x="60" y="60" width="480" height="480" viewBox="160 160 680 680">
    {scene("dc")}
    <circle cx="500" cy="500" r="331" fill="none" stroke="#ffffff" stroke-width="8"/>
  </svg>
  <text class="n" x="620" y="262" font-size="184" fill="{NAVY}" textLength="1700" lengthAdjust="spacing">NIRMAL DHARA JALYAN</text>
  <rect x="620" y="300" width="566" height="20" rx="10" fill="{SAFFRON}"/>
  <rect x="1187" y="300" width="566" height="20" rx="10" fill="#ffffff" stroke="{NAVY}" stroke-width="3"/>
  <rect x="1754" y="300" width="566" height="20" rx="10" fill="{GREEN}"/>
  <text class="n" x="620" y="450" font-size="118" fill="{NAVY}">निर्मल धारा जलयान</text>
  <text class="m" x="2320" y="530" font-size="58" letter-spacing="8" fill="{RIVER}" text-anchor="end">VARUNA AI · RIVER CLEANUP BOAT</text>
</svg>'''


def page(svg, w_mm, h_mm):
    # Print wrapper: exact physical size for PDF, fills the window for PNG.
    return f'''<!doctype html><html><head><meta charset="utf-8">
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Rajdhani:wght@600;700&display=swap">
<style>@page {{ size: {w_mm}mm {h_mm}mm; margin: 0 }} html,body {{ margin:0; padding:0; background:transparent }}
svg {{ display:block; width:100vw; height:auto }}
@media print {{ svg {{ width:{w_mm}mm; height:{h_mm}mm }} }}</style></head><body>{svg}</body></html>'''


b, d = badge(), decal()
(HERE / "nirmal-dhara-jalyan-badge.svg").write_text(b, encoding="utf-8")
(HERE / "nirmal-dhara-jalyan-hull-decal.svg").write_text(d, encoding="utf-8")
(HERE / "_badge.html").write_text(page(b, 100, 100), encoding="utf-8")
(HERE / "_decal.html").write_text(page(d, 240, 60), encoding="utf-8")
print("ok")
