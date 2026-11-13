# Earlier theme — backup

A copy of the colour and theme files exactly as they were **before** the
navy / teal / violet theme was added (5 Nov 2026). Keep this folder.

What the earlier look was:

- **Default dark theme:** gold and black (`#D4A017` gold accent on `#000000`).
- **Home tab:** soft purple and white ("neumorphism lite", `screens/homeNew.css`).
- **Boat Vision and Water Lab:** the same purple/white floating panels (`screens/boatLab.css`).
- **Top bar and side rail:** white, with a purple active tab.

The app still contains this look: the **New / Classic** slider beside the theme
button in the top bar switches back to it at any time (saved as
`varuna.look = classic` in the browser's storage). This folder is the
untouched file-level copy, in case it is ever needed.

## Files

Same paths as in the project, relative to the project root:

| File | What it holds |
| --- | --- |
| `src/index.css` | Theme colours for Dark (gold & black), Light and Green |
| `tailwind.config.js` | The gold `glow` / `elev` shadows |
| `src/screens/homeNew.css` | Home tab purple/white look |
| `src/screens/boatLab.css` | Boat Vision + Water Lab purple/white look |
| `src/components/Rail.jsx` | Side rail with its white/purple colours |
| `src/components/TopBar.jsx` | Top bar (white background) |
| `src/components/WebcamDetect.jsx` | Live camera area (light background) |
| `src/components/RadialLaunch.jsx` | Launch status chip (white) |
| `src/components/OfflineMapsPanel.jsx` | Offline maps progress bar |

## Restoring by hand

Copy a file from here over the one in the project, for example:

```bash
cp theme-backup/earlier/src/index.css src/index.css
```

Restoring whole files also removes the newer theme from them, so prefer the
slider unless the newer theme has to go entirely.
