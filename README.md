# Rabbit Adventure (web edition)

A six-level woodland puzzle game that runs in any modern browser: laptops, phones and tablets.
Play with the keyboard, the on-screen pad / swipe on touch devices, or by pointing one finger at
your webcam (hand tracking runs fully on the player's device; video is never uploaded).

It is a plain static site (no build step, no server code): HTML + JS modules + images.

## Run locally
Camera access needs `http://localhost` or HTTPS, so do not just double-click `index.html`.

    python3 -m http.server 8000      # then open http://localhost:8000

## Deploy for free (all give HTTPS, which the camera requires)

**GitHub Pages**
1. Create a repo and push the *contents* of this folder (so `index.html` is at the repo root).
2. Settings -> Pages -> Deploy from a branch -> `main` / `(root)` -> Save.
3. Your game is live at `https://<user>.github.io/<repo>/` in about a minute.

**Cloudflare Pages / Netlify**: connect the repo (or drag-and-drop this folder), leave the build
command empty and set the publish/output directory to `/` (the folder containing `index.html`).

## Controls
- Move: WASD / arrows, on-screen pad, swipe on the board, or point one index finger.
- Stop (hand): open palm or fist.  P pause, R retry, M sound, F fullscreen.

## Files
- `game.js` game loop, rendering, input, screens   - `logic.js` rules (ported 1:1 from the Python code)
- `hands.js` gesture logic + MediaPipe camera       - `art.js` procedural puzzle tiles
- `levels.js` level maps                            - `assets/` optimised images + `hand_landmarker.task`
- `vendor/` MediaPipe Tasks Vision 0.10.21 (Apache-2.0), self-hosted so the game needs no CDN
