import pathlib, re, sys
H = pathlib.Path(__file__).parent
sys.path.insert(0, str(H))
import make_brand  # also refreshes the SVG files

def clean(svg, label):
    svg = re.sub(r"<style>.*?</style>", "", svg, flags=re.S)
    svg = re.sub(r"<title>.*?</title>", "", svg, flags=re.S)
    svg = re.sub(r' width="\d+" height="\d+"', "", svg, count=1)
    return svg.replace("<svg ", f'<svg role="img" aria-label="{label}" ', 1)

def f(name): return (H / name).read_text(encoding="utf-8")
t = f("sheet_template.html").replace("svg .d {", "svg .n { font-family: var(--f-sub); font-weight: 700; }\nsvg .d {")
subs = {
  "HERO": clean(f("varuna-logo-horizontal-dark.svg"), "Varuna Nirmal Dhara logo"),
  "MARK_DARK": clean(make_brand.mark_only("dark"), "The Varuna mark"),
  "H_LIGHT": clean(f("varuna-logo-horizontal-light.svg"), "Horizontal logo on light"),
  "S_DARK": clean(f("varuna-logo-stacked-dark.svg"), "Stacked logo on dark"),
  "S_LIGHT": clean(f("varuna-logo-stacked-light.svg"), "Stacked logo on light"),
  "CIRCLE": clean(f("varuna-logo-circle.svg"), "Round Varuna Nirmal Dhara emblem"),
  "ICON": clean(f("varuna-app-icon.svg"), "App icon"),
  "MARK_LIGHT": clean(f("varuna-mark.svg"), "Mark on light"),
  "BADGE": clean((H.parent / "nirmal-dhara-jalyan-badge.svg").read_text(encoding="utf-8"), "Nirmal Dhara Jalyan boat badge"),
}
for k, v in subs.items():
    t = t.replace("{{" + k + "}}", v)
assert "{{" not in t
ids = re.findall(r'id="([^"]+)"', t)
dup = {i for i in ids if ids.count(i) > 1}
print("duplicate ids:", dup or "none")
(H / "varuna-brand-sheet.html").write_text(t, encoding="utf-8")
