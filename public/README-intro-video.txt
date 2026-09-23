INTRO BACKGROUND VIDEO
======================

Drop a real drone-over-river cleanup clip here named exactly:

    intro-bg.mp4

...and it becomes the intro/activation screen background automatically —
no code changes. Use footage you own or that is licensed for this use
(e.g. your own drone recordings, or a licensed stock clip).

Recommended: H.264 .mp4, muted, short and loopable (8–20s), 1080p or less
so it loads fast over a phone connection to the Pi.

If this file is absent, the intro falls back to an original animated 3D
scene (a drone scanning debris over water), so the screen is never blank.

This whole `public/` folder is copied into `dist/` at build time and served
by the Pi at the site root, so `/intro-bg.mp4` resolves same-origin.
