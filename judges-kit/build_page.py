import pathlib, re
H = pathlib.Path(__file__).parent
b = (H / "nirmal-dhara-jalyan-badge.svg").read_text(encoding="utf-8")
b = re.sub(r"<style>.*?</style>", "", b, flags=re.S)
b = b.replace('width="1000" height="1000"', 'class="badge" role="img" aria-label="Nirmal Dhara Jalyan logo: a boat on a river collecting a bottle that a drone has spotted"')
t = (H / "how_it_works_template.html").read_text(encoding="utf-8")
t = t.replace(".ic-s {", ".badge .n { font-family: var(--f-head); font-weight: 700; }\n.ic-s {")
(H / "how-varuna-works.html").write_text(t.replace("{{BADGE}}", b), encoding="utf-8")
print("ok")
