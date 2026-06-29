# Phone Mixer Redesign Spec (MIX Page v0.4)

This document outlines the visual and architectural details of the phone-v3 Mixer (MIX) tab redesign.

## 1. Layout Structure (2 Colunas)

The old 5-column layout has been refactored into a high-density, touch-friendly 2-column structure:

```
+-------------------------------------------------+
|                  TOPBAR / TABS                  |
+------------------------+------------------------+
|       KNOBS (6)        |       FADERS (6)       |
|    Grid Layout (3x2)   |     Grid Layout (1x6)  |
|                        |                        |
|   (O)    (O)    (O)    |    [---]  [---]  [---] |
|  knob-1 knob-2 knob-3  |      |      |      |   |
|                        |      |      |      |   |
|   (O)    (O)    (O)    |      |      |      |   |
|  knob-4 knob-5 knob-6  |    [---]  [---]  [---] |
|                        |   fader-1 fader-2 fader-3|
|                        |   (Vertical Tracks: 260px)
+------------------------+------------------------+
|       MODE TOGGLE: [ PERFORMANCE / DEBUG ]      |
+-------------------------------------------------+
```

## 2. Design Tokens & Palettes
- **Backgrounds**:
  - Mixer page wrapper: `rgba(28, 28, 30, 0.45)` (hierarchically lighter than performance tab's `#121214`).
  - Active borders/glows: `var(--blue)` for knobs, `var(--accent)` for faders.
- **Accents**:
  - Knobs visual dial/active state: `#0a84ff` (Blue).
  - Faders fill / active state: `#ff9f0a` (Orange/Yellow).

## 3. Dimension Specifications
- **Knob**:
  - Visual circle: `70px` diameter.
  - Active interaction zone (hitbox): `90px` square.
  - Pointer value indicator length: `12px` (rotated dynamically from -135deg to +135deg).
- **Fader**:
  - Vertical track: `16px` width, `260px` height (touch-hitbox width `56px`).
  - Touch-friendly thumb: `48px` width, `40px` height (min height target for fingers).
  - Fader spacing: `12px` horizontal gap.

## 4. Performance vs Debug Modes
A togglable switch `[ PERFORMANCE / DEBUG ]` was added inside the Mixer tab:
- **PERFORMANCE (Default)**: Optimized for live gigging. Minimal overlays, clean controls, larger knobs/faders, hides extra debug metadata.
- **DEBUG**: Displays layout grid borders, precise numerical overlays underneath each knob/fader, and real-time raw values (0.00 to 1.00).

## 5. Custom Sensor List (Visible to Mappings)
Here are the 25+ names of sensor controls emitted by `emitSensorControls()` in `app.js` and visible as mapping targets:
1. `sensor.orient.alpha`
2. `sensor.orient.beta`
3. `sensor.orient.gamma`
4. `sensor.orient.fused.roll`
5. `sensor.orient.fused.pitch`
6. `sensor.orient.fused.yaw`
7. `sensor.motion.ax`
8. `sensor.motion.ay`
9. `sensor.motion.az`
10. `sensor.motion.gx`
11. `sensor.motion.gy`
12. `sensor.motion.gz`
13. `sensor.motion.aig.ax`
14. `sensor.motion.aig.ay`
15. `sensor.motion.aig.az`
16. `sensor.vision.hand.active`
17. `sensor.vision.hand.x`
18. `sensor.vision.hand.y`
19. `sensor.vision.hand.z`
20. `sensor.vision.hand.fist`
21. `sensor.vision.color.r`
22. `sensor.vision.color.g`
23. `sensor.vision.color.b`
24. `sensor.audio.rms`
25. `sensor.audio.pitch`
26. `sensor.audio.bpm`
27. `gesture.pinch`
28. `gesture.rotate`
