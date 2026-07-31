# Ableton RC Surface v0.5.9 — Release Notes

This release makes the **learned static-gesture recognizer** noticeably more reliable. Trained poses now trigger across a wider range of camera distances, hand rotations, and small viewpoint changes without retraining. The Vision card layout has been restructured so the camera preview and its controls stay together, and a few low-risk build / config glitches have been cleaned up.

## Highlights

- **Learned-gesture matcher rewritten** — `safe-input-layer.js` no longer brute-forces 7 discrete rotation angles. Each captured frame is canonicalised analytically: wrist-centred, scaled by the mean of the four wrist→MCP distances, then rotated so the wrist→middle-MCP vector lies on the +X axis. The match runs a per-landmark weighted RMS (MCPs 1.0, intermediate joints 0.7, fingertips 0.4, wrist excluded). One pinch-OK, one hang-loose, one open-palm — each now survives the same gesture in three different camera positions and three different hand rotations.
- **Vision card reorganised** — the camera stage and the Vision command bar (CAMERA toggle + CONF selector) now live inside a dedicated right-column sidebar wrapper. The camera preview is anchored to the Vision grid column 1 at every supported viewport height, including the ≤430px media query.
- **Tuned defaults** — `threshold` 0.13 → 0.18, `minimumConfidence` 0.55 → 0.45, `holdMs` 220 → 160. Each change is well within the safety bounds the previous version was operating at, and the new defaults are what the matcher was actually calibrated against during smoke tests.

## Recogniser Algorithm (v0.5.9)

For each captured frame, the matcher produces a 40-coordinate descriptor (the wrist is excluded because it is always zero after translation):

1. Subtract the wrist from every landmark (translation invariance).
2. Compute the mean of the four wrist→MCP distances and divide by it (scale invariance).
3. Compute `atan2(L9.y, L9.x)` and rotate all landmarks by `-θ` so the wrist→middle-MCP vector lies on +X (rotation invariance — continuous, not discrete).
4. Compare two poses with a per-landmark weighted Euclidean distance. Wrist = 0, MCPs = 1.0, intermediate joints = 0.7, fingertips = 0.4. The result is the square root of the weighted mean squared difference.

This is mathematically equivalent to a Procrustes alignment restricted to the palm's principal axis — a deliberately small change that captures the practical invariances performers care about (distance, yaw, small pitch) without giving up the existing capture stability check.

## Vision Card Layout

```
┌─── VISION ───────────────────────────────┐
│                                         │
│  [ signal strips / gesture list / etc ] │
│                                         │
│  ┌─ camera-sidebar ────────────────────┐ │
│  │ ┌─ camera-stage ────────────────┐   │ │
│  │ │   CAMERA  LIVE CHECK          │   │ │
│  │ └───────────────────────────────┘   │ │
│  │  [ CAMERA toggle  ] [ CONF low/med ] │ │
│  └─────────────────────────────────────┘ │
└─────────────────────────────────────────┘
```

The `.vision-camera-sidebar` wrapper holds the grid position. The camera stage and command bar are flex-column children of the sidebar so they remain visually adjacent regardless of how much vertical space the rest of the card consumes.

## Build / Config Cleanups

- `build.ts` `copyDir` now throws an actionable error when its source path is missing, instead of returning silently. If you run a build before `npm install`, the message tells you exactly that.
- `app.js` now translates the backend's numeric confidence values (`0.2 / 0.5 / 0.7`) to the UI's `low / medium / high` strings before applying the stored value, so a saved config that uses one convention does not silently fall back to `medium` on reload.
- The `<430px` media query in `style.css` no longer needs to override the command bar's grid template — the bar is now a flex column inside its sidebar wrapper.

## Tests

- 104/104 tests passing on `npm run ci` (tests + `tsc --noEmit` + `build:prod`).
- `mobile-ui.test.mjs` updated to assert the new `.vision-camera-sidebar` wrapper holds `grid-column: 1` (the stage element is now a child of the sidebar, not the grid cell).

## Install / Verify

1. Quit Ableton Live if it is running.
2. Double-click `Ableton-RC-Surface-0.5.9.ablx` to install in Live.
3. Open Ableton RC Surface from the Extensions menu.
4. On the phone UI, enable the camera and try **Learn** on a fresh gesture (e.g. hang-loose) from three different camera positions. **Test** the same gesture in three different hand rotations — it should trigger reliably. The previous version required nearly identical capture and test conditions; v0.5.9 is more forgiving by construction.

Tester checklist: `docs/TESTER-GUIDE.md`.

## Backwards Compatibility

- `safe-input-layer.js` public surface is unchanged. Callers that pass a custom `threshold` / `minimumConfidence` / `holdMs` keep their values.
- The learned-gesture JSON format (`gestures.templates[]`) is unchanged. Previously-saved gestures load and remain testable, with the new default tolerances applying.
- `manifest.json` and `package.json` version bumped to `0.5.9`. The protocol layer is unaffected.
