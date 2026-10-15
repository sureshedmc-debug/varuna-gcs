# VARUNA thermocol boat designs

Four 600 x 300 mm boat designs for the VARUNA collection boat, built from 25 mm
thermocol (EPS) sheets and sunboard, with full-size cutting templates.

| Design | Best for | Thermocol (25 mm) |
| --- | --- | --- |
| VARUNA AI Pod | enclosed solar boat: drawer, 2 cameras, water sensors, spray | 8 sheets 1000 x 500, or 3 sheets 2 x 3 ft |
| Twin-Hull Skimmer | everyday collecting, lightest | 1 sheet 1000 x 500 |
| U-Hull Block | first build, most stable | 3 sheets 1000 x 500 |
| Conveyor Cat | belt lifts plastic into a deck bin | 1 sheet 1000 x 500 |

The AI Pod's big layers (570 x 270 mm) each fit one A2 sheet: the large-format
PDF is the easiest way to print it.

- `boat-3d.html` is the interactive 3D model with every part's size and position.
- `templates/<design>_A4.pdf` prints at home on A4. Print at 100% (Actual size),
  check the 50 mm bar, then join the tiles on the grey 50 mm grid.
- `templates/<design>_large-format.pdf` has each big part on one sheet for a print shop.

Every number comes from `build.py`. To change a measurement, edit it there and run:

```
python3 boat-design/build.py
```

That rewrites the templates, `designs.json` and `boat-3d.html`. It needs `reportlab`.
