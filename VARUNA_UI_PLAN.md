# VARUNA app: Assistant robot + simple tabs (plan, 28 Nov 2026)

Asked by the user. Work starts 01:07 (after the usage reset). Quality bar: a polished, professional app — never fake or cheap-looking.

## Goals
1. **VARUNA Assistant robot**: a floating, futuristic 3D robot with lifelike reactions (blinks, looks at you, nods, shakes its head, waves, leans in to listen, lights up when it talks, happy bounce on success, alert shake on danger). It answers questions and does tasks.
2. **Everywhere**: say "Varuna" (wake word), click the robot dock, or press a key on any tab: the robot floats in, talks, does the job, then docks in a corner.
3. **Boat Vision tab, rebuilt and extremely simple**: full-screen live boat feed + the robot + a stream of messages (pop-ups and voice) + one mic button. The robot relays everything the boat and its AI captain do ("Plastic 12 m ahead, going for it", "Got it, tipping into the bin", "Weed ahead, raising the ramp", "Bin 80% full, heading home", "Radio lost, stopping") and takes commands ("go collect", "stop", "come home", "lower the ramp", "battery?").
4. **All other tabs simpler** (NOT Home, NOT Intro): same app, same features, much less clutter. One clear job per tab, plain words a complete beginner understands, light colours with strong contrast.

## Rules
- Nothing is deleted: advanced controls move behind a "More options" fold.
- Safety unchanged: "Stop" always works instantly; anything that moves the boat asks first; the assistant can never arm the boat; the FS-i6 radio overrides everything.
- Tests and previews use the scratch backend on port 8091, never the live boat backend on 8001.
- No commit, push, deploy or `npm run desktop:update` unless the user asks.
- The website (`src/site`) is not touched.

## Steps
| # | Step | Done when |
|---|---|---|
| 0 | **Survey**: read every tab; screenshot each at desktop and phone width; list each tab's features as main / secondary / advanced; read the theme tokens (light theme, LIGHT_THEME_GUIDE.md) | Feature map and before-screenshots |
| 1 | **Design system pass**: light palette with WCAG AA contrast, type scale, spacing, one card style, one primary-button style, a "More options" fold, a plain-language tab header ("What this tab does" plus a one-line hint) | Shared components in place |
| 2 | **Robot** (`VarunaBot`, three.js): the body and face, plus the expressive states idle / listening / thinking / speaking / happy / alert / wave / nod / shake; mouth and lights follow the voice level; eyes follow the pointer; respects reduced motion; light on the GPU | Robot demo page shows every state |
| 3 | **Global assistant**: replace the orb in `VoiceAssistant` with the robot; floating overlay on every tab; summon by wake word, dock click or key; chat answers and tools reuse `lib/assistant` (LLM + `runTool`); robot reactions tied to what it is doing | Works on every tab |
| 4 | **Boat event bus**: telemetry + camera AI + AI captain → short messages with priority, cooldown and dedupe; voice + pop-ups; mute switch; message history | Demo-mode events arrive as speech + pop-ups |
| 5 | **New Boat Vision tab**: live feed, robot, messages, mic; voice and typed commands mapped to safe boat commands with confirmation; demo mode without the boat; old tools behind "Advanced" | Full flow works in demo mode |
| 6 | **Simplify tabs one by one**, most cluttered first: Boat (Ops) → Mission → Detections → System → Live → Replay → Data. Each gets the plain header, one "start here" main action, big clear cards, plain words, advanced items in the fold | Each tab checked at desktop and phone, light and dark |
| 7 | **QA**: every tab at desktop and phone width; console clean; keyboard use; assistant on every tab; `vite build` passes; desktop/Android build unaffected | All green |
| 8 | **Report**: before/after screenshots, what moved where, anything left to decide | Sent to the user |

Each step leaves the app working, so if the usage limit stops the work midway, nothing is half-broken.
