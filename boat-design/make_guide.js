const fs = require("fs");
const path = require("path");
const {
  Document, Packer, Paragraph, TextRun, HeadingLevel, Table, TableRow, TableCell, WidthType, ShadingType,
  AlignmentType, LevelFormat, BorderStyle, ImageRun, PageBreak, Footer, PageNumber, TableOfContents,
} = require("docx");

const S = process.env.GUIDE_IMAGES || path.dirname(__filename);
const REPO = "/home/user/varuna-gcs/boat-design";
const data = JSON.parse(fs.readFileSync(path.join(REPO, "designs.json"), "utf8"));
const pod = data.designs.find((d) => d.id === "ai-pod");
const sp = pod.specs;

const FONT = "Arial";
const W = 9638; // content width in DXA (A4, 2 cm margins)
const ACCENT = "D9530B";
const INK = "15222B";
const SOFT = "EEF2F1";

const t = (text, o = {}) => new TextRun({ text, font: FONT, ...o });
const p = (text, o = {}) => new Paragraph({ children: Array.isArray(text) ? text : [t(text)], spacing: { after: 120 }, ...o });
const h1 = (text) => new Paragraph({ heading: HeadingLevel.HEADING_1, children: [t(text)], pageBreakBefore: true });
const h2 = (text) => new Paragraph({ heading: HeadingLevel.HEADING_2, children: [t(text)] });
const bullet = (text) => new Paragraph({ numbering: { reference: "bul", level: 0 },
  children: Array.isArray(text) ? text : [t(text)], spacing: { after: 60 } });
let inst = 0;
const steps = (items) => { inst += 1; return items.map((s) => new Paragraph({
  numbering: { reference: "num", level: 0, instance: inst },
  children: Array.isArray(s) ? s : [t(s)], spacing: { after: 90 } })); };
const callout = (label, text, color = "2F7D4F") => new Paragraph({
  children: [t(label + "  ", { bold: true, color }), t(text)],
  shading: { type: ShadingType.CLEAR, fill: SOFT, color: "auto" },
  border: { left: { style: BorderStyle.SINGLE, size: 18, color, space: 6 } },
  spacing: { before: 120, after: 200 }, indent: { left: 120 } });
const check = (text) => callout("CHECK", text);
const warn = (text) => callout("CAREFUL", text, ACCENT);

function table(headers, rows, widths) {
  const sum = widths.reduce((a, b) => a + b, 0);
  const cols = widths.map((w) => Math.round((w / sum) * W));
  cols[cols.length - 1] += W - cols.reduce((a, b) => a + b, 0);
  const border = { style: BorderStyle.SINGLE, size: 4, color: "C9D1D3" };
  const borders = { top: border, bottom: border, left: border, right: border };
  const cell = (txt, i, head) => new TableCell({
    width: { size: cols[i], type: WidthType.DXA }, borders,
    shading: head ? { type: ShadingType.CLEAR, fill: "1F3A4A", color: "auto" } : undefined,
    margins: { top: 60, bottom: 60, left: 100, right: 100 },
    children: [new Paragraph({ children: [t(String(txt), head ? { bold: true, color: "FFFFFF", size: 19 } : { size: 19 })] })],
  });
  return new Table({
    width: { size: W, type: WidthType.DXA }, columnWidths: cols,
    rows: [new TableRow({ tableHeader: true, children: headers.map((h, i) => cell(h, i, true)) }),
      ...rows.map((r) => new TableRow({ children: r.map((c, i) => cell(c, i, false)) }))],
  });
}
const gap = () => new Paragraph({ children: [], spacing: { after: 120 } });
function image(file, wPx, hPx, caption) {
  const w = 600, h = Math.round((hPx / wPx) * w);
  return [new Paragraph({ alignment: AlignmentType.CENTER, spacing: { after: 60 },
    children: [new ImageRun({ type: "png", data: fs.readFileSync(path.join(S, file)), transformation: { width: w, height: h } })] }),
  new Paragraph({ alignment: AlignmentType.CENTER, spacing: { after: 200 },
    children: [t(caption, { italics: true, size: 18, color: "5A6972" })] })];
}

// parts placement from the 3D model (hull back edge is x = 15)
const fromStern = (x) => Math.round(x - 15);
const side = (y) => (Math.abs(y) < 1 ? "centre" : `${Math.round(Math.abs(y))} mm ${y > 0 ? "left" : "right"}`);
const pick = ["Li-ion", "ESC 30 A bidirectional (left)", "ESC 30 A bidirectional (right)", "12 V to 5 V", "2-channel relay",
  "CN3791", "Spray pump", "Spray tank", "Pixhawk", "Power module", "Raspberry Pi Zero", "ADS1115", "pH sensor board",
  "TDS sensor board", "Turbidity sensor board", "Pi Camera 3 Wide", "Solar panel", "GPS mast", "Pan servo", "Collection drawer",
  "Thruster beam", "Underwater thruster (left)", "Underwater thruster (right)"];
const placeRows = [];
for (const key of pick) {
  const q = pod.parts.find((x) => x.name.startsWith(key));
  if (!q) continue;
  let size, x0, z0;
  if (q.kind === "box") { size = q.s.map(Math.round).join(" x "); x0 = q.c[0] - q.s[0] / 2; z0 = q.c[2] - q.s[2] / 2; }
  else { size = q.axis === "z" ? `${q.r * 2} dia x ${q.h}` : `${q.r * 2} dia x ${q.h} long`;
    x0 = q.axis === "x" ? q.c[0] - q.h / 2 : q.c[0] - q.r; z0 = q.axis === "z" ? q.c[2] - q.h / 2 : q.c[2] - q.r; }
  placeRows.push([q.name.replace(/ \(.*?\)$/, (m) => m), size, `${fromStern(x0)} mm`, side(q.c[1]), `${Math.round(z0)} mm`]);
}

const children = [];
// ---------------------------------------------------------------- cover
children.push(
  new Paragraph({ spacing: { before: 1200, after: 120 }, children: [t("VARUNA AI POD", { bold: true, size: 64, color: INK })] }),
  new Paragraph({ spacing: { after: 360 }, children: [t("Step-by-step build guide", { size: 34, color: ACCENT })] }),
  p([t("An enclosed, solar-powered river and pond cleanup boat made from thermocol, 600 x 300 x 200 mm. "
    + "It collects floating plastic in a pull-out drawer, watches the water with two cameras, measures water quality, "
    + "avoids obstacles and can spray a water treatment.", { size: 22 })]),
  ...image("view3d.png", 845, 533, "The finished VARUNA AI Pod (3D model). The drawer opening is at the front."),
  table(["Size", "Weight", "Floats", "Run time", "Collects"],
    [[`${sp.length} x ${sp.width} x ${sp.hull_height} mm (${sp.overall_height} mm to GPS)`,
      `${(sp.empty.mass_g / 1000).toFixed(1)} kg empty`, `${Math.round(sp.empty.draft_mm)} mm deep`,
      `about ${sp.runtime_h} h (${sp.runtime_sun_h} h in sun)`, `${sp.bin_l} L drawer`]], [3, 2, 2, 2.4, 1.6]),
  gap(),
  p([t("Companion files: ", { bold: true }), t("ai-pod_A3.pdf (real-size cutting templates, 7 pages) and boat-3d.html (3D model). "
    + "Both are in the boat-design folder of the varuna-gcs repository.")]),
);

// ---------------------------------------------------------------- contents
children.push(new Paragraph({ heading: HeadingLevel.HEADING_1, pageBreakBefore: true, children: [t("Contents")] }),
  ...["1. Before you start: 6 golden rules", "2. What you need", "3. How the boat is built",
    "4. Build steps (Steps 1 to 12)", "5. Where every part goes", "6. Wiring", "7. Float test and balance",
    "8. Software setup", "9. First run checklist", "10. Fixing common problems"].map((x) => p(x, { spacing: { after: 100 } })));

// ---------------------------------------------------------------- golden rules
children.push(h1("1. Before you start: 6 golden rules"),
  ...steps([
    [t("Print the templates at 100% (Actual size). ", { bold: true }), t("Always print the test page first and check the 100 mm square.")],
    [t("Use only Fevicol SH (white PVA) or low-temperature hot glue on thermocol. ", { bold: true }), t("Fevikwik, rubber glue (SR 998), spray paint and petrol-based paint melt thermocol.")],
    [t("Use sunboard (PVC foam board), not cardboard, ", { bold: true }), t("for anything that can get wet. Cardboard goes soft in water.")],
    [t("Heavy things go low. ", { bold: true }), t("The battery sits on the floor of the boat. This is what stops the boat from rolling over.")],
    [t("Never charge or store the battery unattended, ", { bold: true }), t("and always fit the fuse and main switch.")],
    [t("Test in a tub before a pond. ", { bold: true }), t("Check that it floats level and does not leak before fitting any electronics.")],
  ]),
  warn("The 4-way spray is for a water treatment such as PAC (poly aluminium chloride). Use it only in tanks and pools you look after, at the dose written on the pack. Do not spray rivers or ponds with fish. A camera with UV light cannot detect bacteria: use the pH, TDS, turbidity and temperature readings, and send water samples to a lab for bacteria tests."));

// ---------------------------------------------------------------- shopping
children.push(h1("2. What you need"),
  h2("Hull materials"),
  table(["Item", "Size", "Qty"], [
    ["Thermocol (EPS) sheet, 25 mm (1 inch) thick", "1000 x 500 mm, or 2 x 3 ft (610 x 915 mm)", "8 sheets, or 3 sheets of 2 x 3 ft"],
    ["Sunboard (PVC foam board) 3 mm", "A2 or larger", "2 sheets (lid, shelf, drawer)"],
    ["Sunboard 5 mm", "A3", "1 sheet (tunnel roof, small parts)"],
    ["Wooden strip (pine)", "230 x 40 x 20 mm", "1 (thruster beam)"],
    ["Wooden strip", "190 x 10 x 10 mm", "2 (drawer rails)"],
    ["Plastic mesh (kitchen sink or gutter mesh)", "300 x 500 mm", "1"],
    ["Clear PET sheet (bottle or transparency)", "120 x 70 mm", "1 (drawer flap) + 1 small (camera window)"],
    ["Black foam pipe insulation, 32 mm", "1.6 m", "1 (bumper)"],
    ["PVC electrical conduit 20 mm + end cap", "150 mm", "1 (GPS mast)"],
    ["Bamboo skewers", "3 to 4 mm", "1 pack"],
    ["Fevicol SH, low-temp hot glue sticks, glue stick (paper)", "", "1 each"],
    ["Brown packing tape or tissue paper", "", "for waterproofing"],
    ["Water-based acrylic or emulsion paint", "white + black", "small tins"],
    ["Foam tape (weather strip) + 4 rubber bands or Velcro", "", "for the lid seal"],
  ], [5, 4, 3]),
  h2("Electronics"),
  table(["Part", "Size (mm)", "Weight"], pod.electronics.map(([n, s, m]) => [n, s, `${m} g`]).concat([
    ["XT60 connectors, 20 A blade fuse + holder, 20 A on/off switch", "", "30 g"],
    ["Silicone wire 14 AWG (power) and 22 AWG (signals), cable glands", "", "120 g"],
    ["Resistors: 10k, 20k (x2 each), 1k, 2k (x3 each), 4.7k, 220 ohm (x3)", "", ""],
  ]), [6, 3.5, 1.5]),
  h2("Tools"),
  bullet("Hot-wire foam cutter (best) or a snap-off cutter with new blades"),
  bullet("Steel ruler (at least 300 mm), measuring tape, set square, marker pen"),
  bullet("Hot glue gun (low temperature), soldering iron, multimeter, small screwdrivers"),
  bullet("A3 printer (or a print shop), scissors, sandpaper 120 grit"),
  bullet("A laptop with Mission Planner and the VARUNA app"),
);

// ---------------------------------------------------------------- how it fits together
children.push(h1("3. How the boat is built"),
  p("The hull is 8 layers of 25 mm thermocol stacked and glued on skewers, like a layer cake. The first three are solid (the floor and buoyancy). The next four are rings, which leave a hollow dry bay in the middle. The eighth ring is glued under the lid so the whole top lifts off."),
  ...image("exploded.png", 845, 533, "Exploded view: base layers at the bottom, then the wall rings, the shelf and the lid."),
  table(["Layer", "Height (mm from bottom)", "Template", "What it is"], [
    ["1", "0 to 25", "Base half template", "Floor, with drawer tunnel, sensor wells and thruster beam slot"],
    ["2", "25 to 50", "Base half template", "Floor, with drawer tunnel and sensor wells"],
    ["3", "50 to 75", "Base half template", "Floor of the dry bay, with drawer tunnel and wells"],
    ["4", "75 to 100", "Ring half template, red line", "Wall ring"],
    ["5", "100 to 125", "Ring half template, red line", "Wall ring + 3 ultrasonic sensor holes"],
    ["6", "125 to 150", "Ring half template, blue line", "Ledge ring: the shelf rests on it; camera window"],
    ["7", "150 to 175", "Ring half template, red line", "Wall ring"],
    ["8", "175 to 200", "Ring half template, red line", "Lid rim: glued under the lid, lifts off with it"],
  ], [1, 2.2, 2.8, 5]),
  gap(),
  p([t("Inside, the ", {}), t("lower bay", { bold: true }), t(" (on layer 3) holds the battery, thruster speed controllers, power converter, relays, spray pump and tank. The "),
    t("shelf", { bold: true }), t(" holds the Pixhawk, Raspberry Pi and sensor boards. The "), t("drawer", { bold: true }),
    t(" slides into a tunnel under the front of the boat.")]),
);

// ---------------------------------------------------------------- build phases
const phases = [
  ["Step 1: Print the templates", [
    "Open ai-pod_A3.pdf. Print page 2 only, on A3, landscape, with scaling set to Actual size or 100%. Turn off Fit to page.",
    "Measure the square on page 2 with a steel ruler. Both sides must be 100 mm. If not, fix the printer setting and print page 2 again.",
    "Print the rest of the pages with the same settings.",
    "Pages 3 and 4 make one long sheet: overlap page 4 on the grey strip of page 3, line up the grey 50 mm grid, and tape. Do the same with pages 5 and 6.",
    "Check the joined sheet: the blue 570 mm measurement must measure 570 mm with a tape.",
  ], "every measurement line on the paper matches your ruler."],
  ["Step 2: Cut the thermocol layers", [
    "Draw a straight centreline along the middle of each thermocol sheet with a ruler.",
    "Cut the base half template out of the paper along its black line.",
    "Lay the template's CENTRELINE edge on the line on the thermocol. Trace round it with a marker. Flip the paper over and trace the other half. Do this on 3 sheets (layers 1, 2, 3).",
    "Cut the ring half template out on its outer black line. Trace and flip on 5 sheets (layers 4 to 8).",
    "Cut the paper along the blue dashed line. Trace this inner line on ONE ring sheet: that is layer 6.",
    "Cut the paper along the red line. Trace this inner line on the other 4 ring sheets.",
    "Mark the sensor holes and skewer points by pushing a pencil through the template. The left and right sides have different holes; both are labelled.",
    "Cut every layer with the hot-wire cutter, keeping it upright. Cut the drawer tunnel out of layers 1 to 3 and the beam slot out of layer 1 only.",
  ], "each layer is 570 x 270 mm. The rings' walls are 35 mm thick, the ledge ring's 45 mm."],
  ["Step 3: Build the base", [
    "Push skewers through all the + marks of layer 1 so they stand up.",
    "Spread Fevicol SH thinly on layer 1, press layer 2 down over the skewers, then layer 3 the same way.",
    "Glue the 230 x 40 x 20 mm wooden thruster beam into the slot in layer 1, flush with the bottom.",
    "Put weights (books) on top and leave it overnight.",
  ], "the drawer tunnel is 150 mm wide and 190 mm deep, and the 4 sensor wells go right through."],
  ["Step 4: Roof the tunnel and fit the drawer rails", [
    "Cut the tunnel roof from 5 mm sunboard (small-parts template).",
    "Glue it on top of layer 3 over the tunnel, and run hot glue round every edge. This plate is the floor of the dry bay at the front, so it must not leak.",
    "Glue the two 10 x 10 mm wooden rails along the tunnel walls, 60 mm up from the bottom, so the drawer can hang from them.",
  ], "pour a cup of water into the tunnel from below; nothing should come through the roof."],
  ["Step 5: Build the walls", [
    "Before gluing layer 5, make the 3 ultrasonic holes (23 mm) through its bow wall: one straight ahead, one each side at the front corners.",
    "Before gluing layer 6, cut a 28 x 16 mm camera window in the centre of its bow wall and glue clear PET over it from inside.",
    "Glue layers 4, 5, 6 and 7 onto the base in that order, lining them up on the skewers and the outside edge.",
    "Keep layer 8 separate: it is the lid rim.",
  ], "the shelf (Step 9) sits flat on the ledge of layer 6 all the way round."],
  ["Step 6: Shape and waterproof the hull", [
    "Sand the outside lightly so the layers blend.",
    "Brush on Fevicol SH mixed 1:1 with water and lay tissue paper on it; do two coats. Or wrap the whole hull tightly in brown packing tape.",
    "Paint with water-based acrylic or emulsion paint: white body, black base band.",
    "Glue the black pipe insulation (split in half) round the hull at the waterline, about 25 to 55 mm up. Leave the drawer opening clear.",
  ], "no bare thermocol is visible anywhere, inside or out."],
  ["Step 7: Make the drawer", [
    "Cut the drawer bottom, two sides, back and front from 3 mm sunboard using the small-parts templates. Cut out the red windows.",
    "Hot-glue plastic mesh over every window.",
    "Glue the box together: 203 long, 140 wide, 70 tall. The front panel with the handle goes at the bow.",
    "Tape the PET flap inside the front, hanging over the entrance, so it swings inward only.",
    "Slide the drawer into the tunnel on its rails.",
  ], "the drawer slides in and out easily and the flap swings only inwards."],
  ["Step 8: Make the lid", [
    "Cut the lid top from 3 mm sunboard with the lid half template (trace and flip). Cut the holes.",
    "Glue the lid top onto layer 8 (the lid rim ring).",
    "Stick foam tape on top of layer 7 all round; the lid presses on it to seal.",
    "Glue the solar panel in its dashed box, the mast socket and the 120 mm GPS mast at the back, the servo plate at the front, the status LED and the 4 spray nozzles.",
    "Fit 4 hooks on the hull sides for the rubber bands that hold the lid down.",
  ], "with the bands on, the lid does not move when you tilt the boat."],
  ["Step 9: Fit the thrusters", [
    "Bolt the two underwater thrusters under the wooden beam, 80 mm each side of the centre, pointing straight forward.",
    "Run their wires up through a hole sealed with a cable gland or hot glue into the dry bay.",
  ], "both propellers turn freely and sit fully under the hull."],
  ["Step 10: Electronics in the lower bay", [
    "Glue the paper placement guide on the floor of the bay (it is printed on base layer 3's template), or measure positions from the table in section 5.",
    "Fix the battery with a Velcro strap, 85 to 200 mm from the back edge. Fix the two ESCs, the 5 V converter, the relay module, spray pump, spray tank and solar charger on their outlines.",
    "Fit the fuse and main switch between the battery and everything else.",
  ], "nothing heavy is loose; tilt the boat 45 degrees and nothing slides."],
  ["Step 11: Fit the shelf and upper bay", [
    "Cut the shelf from 3 mm sunboard with its half template, and its two cable slots.",
    "Fix the Pixhawk (arrow towards the bow) on the centreline, the Pi Zero, ADS1115 and the three sensor boards on their outlines.",
    "Lay the shelf on the ledge with the cables running through the slots.",
  ], "the Pixhawk arrow points to the bow."],
  ["Step 12: Sensors, cameras and lights", [
    "Push the turbidity, pH, TDS and temperature probes through their wells so the tips stick out 15 mm under the hull. Seal round each with hot glue.",
    "Fit the 3 ultrasonic sensors in their holes in layer 5 and seal with hot glue.",
    "Fix the Pi Camera 3 Wide behind the window in layer 6, tilted 10 degrees down (use the camera wedges).",
    "Put the USB webcam in its dome on the servo on the lid. Fit the UV LEDs and the LED strip at the bow.",
  ], "every probe tip is under water when the boat floats; every hole is sealed."],
];
children.push(h1("4. Build steps"));
phases.forEach(([title, items, ok], i) => {
  if (i === 4 || i === 8) children.push(new Paragraph({ children: [new PageBreak()] }));
  children.push(h2(title), ...steps(items), check(ok));
  if (i === 1) children.push(...image(fs.readdirSync(S).find((f) => f.startsWith("tpl")), 1158, 819,
    "Template page 3: base half template (top) and ring half template (bottom). The CENTRELINE edge is where you flip."));
});

// ---------------------------------------------------------------- placement
children.push(h1("5. Where every part goes"),
  p("Distances are measured from the back edge of the hull. Left and right are as you look towards the bow. Height is from the bottom of the hull; a minus height means below the hull."),
  table(["Part", "Size (mm)", "From back edge", "Across", "Height"], placeRows, [4.4, 2.6, 1.6, 1.6, 1.2]));

// ---------------------------------------------------------------- wiring
children.push(h1("6. Wiring"),
  warn("Do all wiring with the battery unplugged. Check every connection with a multimeter before plugging in."),
  table(["From", "To", "Notes"], [
    ["Battery 3S", "Fuse, then main switch", "20 A blade fuse, XT60 connectors"],
    ["Main switch", "Power module, both ESCs, 5 V converter, solar charger, LED strip", "14 AWG wire"],
    ["Power module", "Pixhawk POWER", "powers and measures the battery"],
    ["Left ESC signal", "Pixhawk MAIN OUT 1", "left thruster"],
    ["Right ESC signal", "Pixhawk MAIN OUT 3", "right thruster"],
    ["GPS + compass", "Pixhawk GPS and I2C ports", "arrow to the bow"],
    ["5 V converter", "Pi Zero pin 2 (5 V) and pin 6 (GND), servo, relay module", "never power the servo from the Pi"],
    ["Pi Zero pin 8 (TX) / pin 10 (RX) / GND", "Pixhawk TELEM2 RX / TX / GND", "MAVLink link"],
    ["Pi Camera 3 Wide", "Pi Zero camera connector", "Zero ribbon cable, 300 mm"],
    ["USB webcam", "Pi Zero USB (OTG adapter)", "360 degree camera"],
    ["Pan servo signal", "Pi Zero pin 12 (GPIO18)", "power from the 5 V converter"],
    ["ADS1115 VDD / GND / SDA / SCL", "Pi pins 1 / 6 / 3 / 5", "I2C address 0x48"],
    ["Turbidity board out", "ADS1115 A0 through 10k (top) / 20k (to GND)", "keeps the signal under 3.3 V"],
    ["pH board out", "ADS1115 A1 through 10k / 20k", "calibrate with pH 4 and 7 buffer"],
    ["TDS board out", "ADS1115 A2", "direct"],
    ["Temperature probe data", "Pi pin 7 (GPIO4), 4.7k to 3.3 V", "DS18B20, one-wire"],
    ["Relay IN1 / IN2", "Pi pin 11 (GPIO17) / pin 13 (GPIO27)", "pump / UV LEDs; use a relay that triggers at 3.3 V"],
    ["Status RGB LED", "Pi pins 15, 16, 18 through 220 ohm each", "red, green, blue"],
    ["Ultrasonic Trig / Echo (x3)", "Pixhawk AUX pins; Echo through 1k / 2k divider", "Echo is 5 V; the divider protects the Pixhawk"],
    ["Solar panel", "CN3791 module, then battery charge lead", "set the module for 3S (12.6 V)"],
  ], [3.6, 4.2, 3.6]));

// ---------------------------------------------------------------- float test + setup
children.push(h1("7. Float test and balance"),
  ...steps([
    "With everything fitted and the drawer empty, draw a line round the hull 38 mm up from the bottom. This is the expected waterline.",
    "Put the boat in a tub or bucket of water with the lid on.",
    `It should float with the water close to the line (calculated draft ${sp.empty.draft_mm} mm, about ${(sp.empty.mass_g / 1000).toFixed(1)} kg).`,
    "If the nose is low, slide the battery back on its Velcro. If the tail is low, slide it forward. Stop when it is level.",
    "Leave it floating for 30 minutes, then open the lid and check that the inside is completely dry.",
    "Push one side down gently and let go. It should roll back upright straight away.",
  ]),
  check(`with a full drawer the nose sits about 2 cm lower. That is normal. The boat can carry ${sp.reserve_kg} kg more before the deck goes under.`),
  h1("8. Software setup"),
  h2("Pixhawk (ArduRover) in Mission Planner"),
  table(["Parameter", "Value", "Why"], [
    ["FRAME_CLASS", "2", "boat"],
    ["SERVO1_FUNCTION", "73", "throttle left (left thruster on MAIN 1)"],
    ["SERVO3_FUNCTION", "74", "throttle right (right thruster on MAIN 3)"],
    ["SERVO1_TRIM, SERVO3_TRIM", "1500", "stop point for reversible ESCs"],
    ["SERVO1_MIN / MAX, SERVO3_MIN / MAX", "1000 / 2000", "full reverse / full forward"],
    ["SERIAL2_PROTOCOL", "2", "MAVLink 2 on TELEM2 for the Pi"],
    ["SERIAL2_BAUD", "115", "115200 baud"],
    ["RNGFND1_TYPE (and 2, 3)", "30", "HC-SR04 type ultrasonic sensors"],
    ["RNGFND1_ORIENT / 2 / 3", "0 / 7 / 1", "front / front-left / front-right"],
    ["PRX1_TYPE", "4", "use the ultrasonic sensors for obstacle avoidance"],
    ["AVOID_ENABLE", "2", "stop for obstacles"],
  ], [4, 2, 5]),
  p("Parameter names can change between firmware versions; search for each in Mission Planner's Full Parameter List. The ultrasonic sensors also need their Trig and Echo pins set (RNGFND1_STOP_PIN and RNGFND1_PIN) to the AUX pins you used, with those AUX outputs set to GPIO."),
  h2("VARUNA app"),
  bullet(`Boat Vision settings: camera height ${(sp.cam_height_mm / 1000).toFixed(2)} m, tilt ${sp.cam_tilt} degrees down.`),
  bullet("Calibrate turbidity in clear water and pH with the 4 and 7 buffer solutions before the first trip."),
  bullet("Test the pump and UV LED relays from the app on dry land first."),
  h1("9. First run checklist"),
  ...steps([
    "Battery charged, fuse fitted, main switch off until the boat is in the water.",
    "Drawer in and empty, flap swinging inwards.",
    "Lid sealed with all 4 rubber bands.",
    "GPS has a fix and the app shows the boat on the map.",
    "Thrusters spin the right way: both push water backwards when you give forward throttle.",
    "Start in manual mode close to the shore, then try a short automatic mission.",
    "After the run: empty the drawer, rinse the probes in clean water, dry the boat, charge the battery.",
  ]),
  h1("10. Fixing common problems"),
  table(["Problem", "Likely cause", "Fix"], [
    ["Thermocol melts or goes rough", "Wrong glue or paint", "Use only Fevicol SH, low-temp hot glue and water-based paint"],
    ["Boat leans to one side", "Battery or tank off-centre", "Move them back onto the centreline outlines"],
    ["Nose too low", "Weight too far forward", "Slide the battery towards the stern"],
    ["Water inside", "Unsealed hole or lid", "Re-seal probe wells, cable holes and the tunnel roof; renew the lid foam tape"],
    ["Boat turns instead of going straight", "A thruster is reversed or mounted crooked", "Swap two motor wires on that ESC, or re-align it"],
    ["Plastic escapes from the drawer", "Flap not swinging back", "Make the flap lighter or trim it so it hangs freely"],
    ["Pi resets when the servo moves", "Servo powered from the Pi", "Power the servo from the 5 V converter"],
    ["pH or turbidity readings jump", "Signal over 3.3 V or no calibration", "Check the 10k / 20k dividers and calibrate"],
  ], [3.2, 3.4, 4.6]),
);

const doc = new Document({
  creator: "VARUNA", title: "VARUNA AI Pod build guide",
  styles: {
    default: { document: { run: { font: FONT, size: 21, color: INK } } },
    paragraphStyles: [
      { id: "Heading1", name: "Heading 1", basedOn: "Normal", next: "Normal", quickFormat: true,
        run: { size: 34, bold: true, font: FONT, color: INK }, paragraph: { spacing: { before: 120, after: 200 }, outlineLevel: 0,
          border: { bottom: { style: BorderStyle.SINGLE, size: 8, color: ACCENT, space: 4 } } } },
      { id: "Heading2", name: "Heading 2", basedOn: "Normal", next: "Normal", quickFormat: true,
        run: { size: 26, bold: true, font: FONT, color: "1F3A4A" }, paragraph: { spacing: { before: 280, after: 120 }, outlineLevel: 1 } },
    ],
  },
  numbering: { config: [
    { reference: "num", levels: [{ level: 0, format: LevelFormat.DECIMAL, text: "%1.", alignment: AlignmentType.LEFT,
      style: { paragraph: { indent: { left: 460, hanging: 360 } }, run: { bold: true, color: ACCENT } } }] },
    { reference: "bul", levels: [{ level: 0, format: LevelFormat.BULLET, text: "•", alignment: AlignmentType.LEFT,
      style: { paragraph: { indent: { left: 460, hanging: 300 } } } }] },
  ] },
  features: { updateFields: true },
  sections: [{
    properties: { page: { size: { width: 11906, height: 16838 }, margin: { top: 1134, bottom: 1134, left: 1134, right: 1134 } } },
    footers: { default: new Footer({ children: [new Paragraph({ alignment: AlignmentType.RIGHT,
      children: [t("VARUNA AI Pod build guide  |  page ", { size: 16, color: "5A6972" }),
        new TextRun({ children: [PageNumber.CURRENT], font: FONT, size: 16, color: "5A6972" })] })] }) },
    children,
  }],
});
Packer.toBuffer(doc).then((buf) => {
  const out = path.join(REPO, "VARUNA-AI-Pod-Build-Guide.docx");
  fs.writeFileSync(out, buf);
  console.log("wrote", out, buf.length);
});
