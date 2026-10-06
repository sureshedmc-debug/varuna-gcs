# Varuna — daily idea log

A scheduled agent reads the detection pipeline in this repo, searches current
literature and tooling, and writes one dated file here per run. Each file is
**implementation-ready**: every idea names the file and line it touches, the
expected gain, the effort, and the risk — so an idea can go straight to a
branch without re-deriving the context.

Nothing in here changes the app. These are proposals; pick and implement.

| Date | Headline |
| --- | --- |
| [2026-10-06](./2026-10-06.md) | Domain gap is the bottleneck (mAP50 0.29): fine-tune on aerial-water data, aggregate confidence over tracks, turn on WASM threads |

## How to read an entry

Each idea carries a tag:

- **[ACCURACY]** — raises detection quality (recall, precision, mAP)
- **[SPEED]** — more frames per second, or the same FPS on weaker hardware
- **[CREDIBILITY]** — makes the numbers Varuna reports defensible to a third party
- **[WOW]** — a differentiator a judge, grant reviewer or municipality notices
- **[BUG]** — something that looks wrong today

Effort is in rough developer-hours by someone who already knows this codebase.
