# Ableton RC Surface — User Guide

Everything a performer needs to operate the phone controller during setup,
soundcheck, and live performance. Read this once before playing a set.

> **Scope**: the phone client (`/phone-v3/`) is the main surface. The
> Ableton panel and admin dashboard are covered separately in
> `docs/CUSTOMIZATION.md`.

---

## 1. Phone layout at a glance

The phone UI is a single page with six tabs. Switch with the buttons on
the top strip:

| Tab    | What it does                                                 |
| ------ | ------------------------------------------------------------ |
| PERF   | Performance: pads, XY, LFOs, Stutters, UTIL shortcuts       |
| MIX    | Six knobs and six faders for mixer control                   |
| SNP    | Snapshots: 8 capture slots, morph between them               |
| SNS    | Sensors: live readouts for motion and orientation            |
| AUD    | Microphone and audio-analysis inputs                         |
| VID    | Camera, hand tracking, and learned static poses             |

The top strip also holds the **MAP** button near the BPM display plus
three global buttons: **SYNC**, **CALIBRATE**, and **STAGE**. See
[§ 7 Top-bar controls](#7-top-bar-controls) and
[§ 8 MAP mode](#8-map-mode---mobile-mapping).

---

## 2. Pad modes (A / B / C / D)

The pad mode selector sits in the middle column of the PERF tab:

```
┌───┬───┬───┬───┐
│ A │ B │ C │ D │
└───┴───┴───┴───┘
```

The selected mode applies to **all 12 pads** (`pad-1`..`pad-12`),
**all 4 LFOs** (`toggle-1`..`toggle-4`, now labeled `L1`..`L4`), and
**all 4 Stutters** (`button-1`..`button-4`, labeled `S1`..`S4`).
The mode is shared: pick once, every control plays by the same rule.

### Mode A — Momentary (default)

- Touch sends a non-zero value; release sends zero.
- Drag **vertically** to scale the value from `0` (release point) to `1`
  (150 px above the touch start). This is the same range used by
  knobs, faders, LFOs, and Stutters.
- Best for: drum hits, one-shot samples, momentary effects on a button
  press.

### Mode B — Hold

- Touch latches the control **on**; release without any drag sends it
  back off. Any movement (vertical or horizontal) keeps it held until
  you deliberately drag the value back to zero.
- For Stutters specifically (see [§ 4](#4-stutters-s1-s4)): a tap
  turns the stutter off; a pure-vertical drag down to zero also turns
  it off; **any horizontal motion keeps the stutter running even if
  the vertical rate drops to zero**.
- Best for: latched LFOs that keep modulating after release, sustained
  stutter sweeps, pads that you want to keep ringing.

### Mode C — Toggle

- Tap turns the control on; tap again turns it off.
- A small vertical drag while on lets you re-modulate the value
  without toggling off — drag is ignored by the toggle state.
- When turned on by tap, the value reverts to the last value you used
  in this mode. If you never set a value, it defaults to `1`.
- Best for: pads that should stay pressed (sustain pedal behavior),
  LFOs that need to keep their setting between toggles.

### Mode D — Burst

- Touch fires a one-shot envelope: 70 ms attack, 450 ms release,
  peaking at `1`.
- Drag **vertically while holding** modulates the peak between `0.15`
  and `1`.
- Best for: laser stabs, ghost notes, percussion that needs a tail,
  drum-roll risers.

---

## 3. LFOs (L1 / L2 / L3 / L4)

The four LFOs live on the right column of the PERF tab, under the
header `LFOS`. Each LFO is a continuous low-frequency oscillator that
emits values between `-depth` and `+depth`.

### Controls on each LFO

- **Vertical drag** → sets **depth** (modulation amount, `0..1`).
  Starts at `0.5`. Drag range is 150 px.
- **Horizontal drag** → sets **rate** (modulation speed).
- The LFO keeps emitting its phase continuously while the button is
  **active**. The way it goes active and inactive follows the
  selected pad mode (A/B/C/D) — see [§ 2](#2-pad-modes-a--b--c--d).
- Visual feedback: the bar inside the LFO lights up when the LFO is
  active. A glow on the bottom edge reflects the current depth; a
  glow on the right edge reflects the current rate.

### Typical use

- Map an LFO to a filter cutoff, a delay feedback, or a wavetable
  position. Tap **MAP** on the phone or use the panel mapping editor
  to wire any Live parameter to a `toggle-N` control.

---

## 4. Stutters (S1 / S2 / S3 / S4)

The four Stutters sit next to the LFOs in the PERF tab. Each Stutter
repeats a slice of the input at a chosen **rate** (frequency) with a
chosen **ratchet count**.

### Two axes, one button

- **Vertical drag** → sets **rate** (repetition frequency). Range is
  `1 Hz` to `15 Hz`. Initial value is `0.1` (≈ 2.4 Hz — slow and
  musical on first touch).
- **Horizontal drag** → sets **count** (number of repeats per beat).
  Snaps to discrete ratchet levels: `[1, 2, 3, 4]`. Initial value is
  `0.25` (count `1`).
- Drag range on both axes is 150 px.
- The button follows the selected pad mode (A/B/C/D) for activation,
  with one important exception — see below.

### Mode B behaviour for Stutters

Because Stutters are typically **performance gestures**, mode B has
an extra rule: horizontal motion locks the button on even if the
vertical value drops to zero. Concretely:

- **Tap (no movement)** → stutter turns off.
- **Pure vertical drag down to zero (no horizontal)** → stutter
  turns off.
- **Any horizontal motion** (count > 0) → stutter stays running
  even if rate drops to zero.

The visual reflects this: a horizontal-only drag keeps the button
lit; a pure vertical release lets the button return to off.

### Zebra visual feedback

When a Stutter is active, horizontal yellow stripes appear on the
button. Each ratchet level reveals an additional stripe, growing from
the center outward:

```
count = 1  →  empty
count = 2  →  1 stripe at center
count = 3  →  3 stripes (center + sides)
count = 4  →  5 stripes (full coverage)
```

Stripes only show while the Stutter is held. Releasing the button
fades them out over 180 ms.

---

## 5. PERF UTIL shortcuts

The PERF tab has a compact `UTIL` block for actions you need during a
set without leaving the performance surface.

- **CAP** arms snapshot capture from the PERF page.
- **1-4** recall snapshot slots 1 through 4.
- **CAP + 1-4** saves the current performance state into that slot.
- **OFF** cancels active snapshot morphing, turns off pads, LFOs, and
  Stutters, and returns XY pads to center. It does not reset MIX
  knobs, faders, sensors, audio, vision, or transport.

---

## 6. XY pads

Two pads in the middle column of the PERF tab.

### XY 1 — direct control

Touch anywhere on the pad. The dot snaps to your finger position.
Values:

- `xy-1.x` — horizontal position, `0..1` (left → right)
- `xy-1.y` — vertical position, `0..1` (top → bottom)

Use for crossfades, stereo field, dual-parameter control.

### XY 2 — physics joystick

The dot has momentum. Flick it and it slides. Pull it back with
spring force when you release near the edge.

- `xy-2.x` and `xy-2.y` follow the same axes as XY 1.
- Tuning lives in the panel (physics constants). Best for expressive
  performance with gesture character.

---

## 7. Top-bar controls

Three buttons on the top strip of every page.

### SYNC

Toggles the BPM clock between **SYNC** (locked to Live) and **FREE**
(internal).

- **SYNC** (cyan): LFO and Stutter rates are quantized to Live's BPM.
  The header shows the current BPM (`120.0 BPM` etc).
- **FREE** (amber): the phone runs its own clock. Use this when Live
  isn't running, or when you want internal tempo regardless of Live.

Pressing SYNC restores the session BPM as reported by the last Live
broadcast.

### CALIBRATE

Zeroes the orientation sensor offsets so the phone's "natural" pose
becomes `(0, 0, 0)` on yaw / pitch / roll.

1. Place the phone in your performance pose (most often: lying flat
   on a table, screen up, in the orientation you'll be reading from).
2. Press **CALIBRATE**.
3. The button turns amber with the label `CALIBRATING…` while the
   sensor denoiser collects samples, then green with `CALIBRATED`.

Calibration persists in `localStorage` as
`ableton-rc:sensor_offsets`. Press again to re-zero. Delete that key
to fully reset.

### STAGE

Toggles **Stage Mode**:

- Hides the top bar, tabs, and labels (everything except the
  performance controls themselves).
- Requests browser fullscreen so the phone UI fills the screen and
  nothing else can steal focus mid-set.
- Press again — or exit fullscreen by any system gesture — to leave
  Stage Mode.

Use Stage Mode when performing: it removes the chrome and gives you
the largest possible surface for the controls.

> **Known limitation — 2026-07-12:** enabling the audio sensor or camera
> while Stage Mode is fullscreen can make Chrome exit fullscreen. On the
> tested Samsung S25F, fullscreen may not become available again until the
> controller tab is closed and reopened. Enable audio/camera before entering
> Stage Mode when possible.

---

## 8. MAP mode - mobile mapping

Tap **MAP** near the BPM display to enter mapping mode from the phone.
This does not open a separate mobile page in the browser; it overlays a
mapping workflow on top of the real controller so you can pick the
control you are already using.

### Selecting a control

While MAP mode is active, mappable controls on the visible performance
page become selectable with a blue MAP outline/label. This includes:

- PERF controls: pads, XY pads, LFOs, Stutters.
- MIX controls: knobs and faders.
- Sensor controls from the fallback list in the MAP panel.

Tap a highlighted control to select it. For XY pads, the editor exposes
the axes separately:

- `xy-1.x` / `xy-2.x` - horizontal axis.
- `xy-1.y` / `xy-2.y` - vertical axis.

### Bind to parameter

Use **Bind** when you want a phone control to move an Ableton parameter.
The target picker is hierarchical:

- **Song / Main / Master**: song tempo and main/master track targets.
- **Tracks**: normal Live tracks, mixer targets, devices, and parameters.
- **Return Tracks**: return-track mixer targets, devices, and parameters.

Open a track, then a device, then choose the parameter. Search filters
the tree while keeping the track/device context visible, so you can tell
which parameter belongs to which track.

### Trigger note to MIDI track

Use **Trigger Note** when a phone control should send a MIDI note instead
of continuously moving a parameter.

1. Select a pad, LFO, Stutter, XY axis, knob, or fader in MAP mode.
2. Tap **Trigger Note**.
3. Pick a MIDI track.
4. The extension checks for `RC-Midi-Receiver.amxd` on that track. If it
   already exists, it reuses it. If it can insert it automatically, it
   does so. If insertion fails, place `RC-Midi-Receiver.amxd` on that
   MIDI track manually in Live and try again.
5. Choose the note with the **Pitch** and **Octave** controls and set
   **Velocity**.

Multiple controls can trigger notes on the same MIDI track. Different
notes are treated as different trigger targets.

### Mapping editor fields

Each mapped target can be adjusted from the phone:

| Field | Meaning |
| ----- | ------- |
| Mode | `continuous`, `toggle`, or `trigger_note`. |
| Curve | `linear`, `exponential`, `logarithmic`, or `s-curve`. |
| In Min / In Max | The input range read from the phone control. |
| Out Min / Out Max | The output range sent to the Live target. |
| Drive | Pushes the response curve up or down. |
| Comp | Compresses or expands the middle of the response curve. |
| Smooth | Adds smoothing to reduce abrupt value jumps. |
| Threshold | Threshold for non-continuous modes. |
| MIDI Note | Pitch and octave for trigger-note mappings. |
| Velocity | MIDI velocity for trigger-note mappings. |

The curve canvas shows the current response shape and a moving dot for
the selected control's live input/output. Use it to verify that the
range, curve, drive, and compression settings match what you expect.

### Presets, refresh, and unbind

The MAP panel can save, load, and delete local mapping presets. Presets
are stored in Ableton extension storage on the host computer.

Use **Refresh** if Live tracks/devices changed while MAP mode was open.
Use **Unbind Target** to remove one target from the selected control, or
**Clear All** to remove every mapping from that control.

When you leave MAP mode, the phone returns to the previous performance
page and normal touch behavior resumes.

---

## 9. MIX tab — Knobs and Faders

The MIX tab has six knobs (`knob-1`..`knob-6`) and six faders
(`fader-1`..`fader-6`).

### Knobs

- **Drag vertically** to set the value (`0..1`).
- 150 px drag range (same as everything else).

### Faders

- **Drag vertically** to set the value (`0..1`).
- Visual: a thumb on a track, with the track filled from the bottom
  up to the current value.
- 150 px drag range.

The MIX tab is where most people wire Live's volume, pan, sends, EQ,
and macro controls. Tap **MAP**, then tap a knob or fader to bind it
directly from the phone.

---

## 10. SNP tab — Snapshots and morph

The SNP tab captures the **state of all performance controls** at a
moment in time and lets you interpolate between captured snapshots.

### Slots

Eight slots, numbered `1`..`8`. Empty slots show `Vazio`; filled
slots show their slot number.

### Capture

1. Set the controls (pads, XY, LFOs, Stutters, knobs, faders) to a
   state you want to remember.
2. Press **CAPTURAR** (red record button).
3. Tap an empty slot. The slot now stores the current state.

### Clear

**Zerar Slots** wipes all eight slots.

### Morph time

The slider at the right of the controls sets the morph duration
between `0.1 s` and `5.0 s`. Default is `1.0 s`.

### Morph modes

- **Grid (1-8)** — tap any slot to morph from the current state to
  the slot's state over the morph time. Tap another slot to morph
  again.
- **Vector XY (1-4)** — a 2D vector pad appears. The pad has four
  corners, each tied to a snapshot. Drag the dot inside the pad to
  blend the four snapshots continuously. Useful for live
  interpolation between four macro configurations.

Mapped Live parameters follow the morph while the transition is running.
For example, if an LFO, Stutter, knob, or fader is mapped to Live, the
mapped value should move through the transition instead of waiting until
the morph ends.

---

## 11. SNS tab — Sensors

Live readouts of the phone sensors. No controls here — these are
the values being broadcast to Live so you can verify they work and
map them elsewhere.

### MOTION

Six axes from the accelerometer and gyroscope:

- `GX`, `GY`, `GZ` — gyroscope angular velocity (rad/s)
- `AX`, `AY`, `AZ` — linear acceleration (m/s²)

The values reach the live mappings as:

- `sensor.motion.ax`, `sensor.motion.ay`, `sensor.motion.az`
- `sensor.motion.gx`, `sensor.motion.gy`, `sensor.motion.gz`

### ORIENTATION

Three angles from the device orientation sensor:

- `YAW` (alpha) — compass heading
- `PITCH` (beta) — tilt forward / back
- `ROLL` (gamma) — tilt left / right

The values reach the mappings under `sensor.orient.*`. Yaw is shown
with a compass-style orbit; pitch and roll with level-style orbits.

### LOCAL VIEW

Two switches: visibility toggles for the MOTION and ORIENTATION
panels in this tab. They only affect what's shown here — they do
**not** mute the sensor broadcast.

---

## 12. AUD and VID tabs — Audio and Vision

Inputs from the phone's microphone and camera. These require the
browser to ask permission the first time you enable them.

### Audio input

Toggle **Audio input** to grant microphone access. Once enabled:

- `sensor.audio.rms` — output loudness, `0..1`
- `sensor.audio.pitch` — detected pitch in Hz (auto updates)
- `sensor.audio.bpm` — tempo estimate from the input signal
- `sensor.audio.note` — nearest MIDI note to the detected pitch
- `sensor.audio.clarity` — confidence of the pitch detection
- `sensor.audio.whistle.active` — `1` when a whistle is detected
- `sensor.audio.whistle.bend` — bend amount while whistling
- `sensor.audio.envelope` — short-term amplitude envelope
- `sensor.audio.transient` — onset detector
- `sensor.audio.gate` — `1` while the envelope exceeds a threshold

The bar at the bottom of the AUDIO card shows the live RMS.

### VID performance console

Open **VID** with the phone in landscape. The camera preview stays on the
left, the three learned-pose cards stay side by side, and the direct signal
strip stays at the bottom. Tap **Camera** to grant access. The vision system
is **single-hand** by design: it tracks one hand in front of the phone.

If camera access fails, the error stays inside the preview. Fix the reported
permission or camera-busy condition and tap **Camera** again; a page reload
is not required.

Camera hand tracking loads the MediaPipe Hands runtime/model files bundled
with the extension. It works on a fully offline local network after the
extension is installed.

Output values:

- `sensor.vision.active` - `1` while a hand is detected
- `sensor.vision.x`, `sensor.vision.y` - horizontal and vertical palm
  position in normalized image coordinates
- `sensor.vision.z` - normalized palm-size depth: it rises as the hand gets
  closer to the camera. It is a direct performance signal, not calibrated
  or simulated 3D space.
- `sensor.vision.fist`, `sensor.vision.pinch`, `sensor.vision.victory`,
  `sensor.vision.open` - gesture channels
- `sensor.vision.fingers` - normalized number of extended fingers
- `sensor.vision.gesture.1`, `.2`, `.3` - learned static-pose channels
- `sensor.vision.color.r`, `sensor.vision.color.g`, `sensor.vision.color.b`
  - average camera color channels

Each tracked feature can be mapped to a Live parameter just like faders or
knobs. **Active**, **X**, **Y**, and **Z** are also selectable directly from
the bottom VID signal strip while MAP mode is active.

### Learned static poses

Each of the three learned slots stores one static hand shape:

1. Hold the desired hand shape and tap **CAPTURE POSE** three times, changing
   position or distance slightly between examples.
2. Keep the hand still during each short automatic capture.
3. Tap **TEST**, then show the pose again. Recognition tolerates normal
   changes in screen position, hand distance, depth landmarks, and a small
   wrist angle.
4. Use **REMOVE LAST** to replace only the newest example, or **CLEAR ALL**
   to retrain the slot from scratch.

The **Balanced** recognition preset is the normal performance setting.
**Precision** rejects more variation; **Flexible** accepts more. A learned
slot is momentary (`0` or `1`), persists across page reloads, and rearms only
after the pose is released. Poses saved by the retired spatial format show
**RECAPTURE REQUIRED** instead of being treated as usable.

---

## 13. Quick reference

### Per-control vertical range

Every vertical control in the app uses a **150 px** drag range from
`0` to `1`. This is intentional: mixing all the controls at the same
physical scale keeps your muscle memory honest across the surface.

### Mode summary

| Mode | Activation       | Drag vertical          | Drag horizontal      |
| ---- | ---------------- | ---------------------- | -------------------- |
| A    | while touching   | scales value 0..1      | no horizontal effect |
| B    | touch latches    | scales, zero = off     | keeps latched        |
| C    | tap toggles      | re-modulate value      | no horizontal effect |
| D    | burst on touch   | peak (0.15..1)         | no horizontal effect |

### Control names (for mapping)

```
pad-1 .. pad-12
knob-1 .. knob-6
fader-1 .. fader-6
xy-1.x, xy-1.y, xy-2.x, xy-2.y
toggle-1 .. toggle-4    (LFOs)
button-1 .. button-4    (Stutters)
sensor.motion.{ax,ay,az,gx,gy,gz}
sensor.orient.{alpha,beta,gamma}
sensor.audio.{rms,pitch,bpm,note,clarity,
              whistle.active,whistle.bend,
              envelope,transient,gate}
sensor.vision.{active,x,y,z,fist,pinch,victory,open,fingers,
               color.r,color.g,color.b,gesture.1,gesture.2,gesture.3}
```

---

## 14. Common gestures cheat sheet

- **Tap** — momentary press (mode A default).
- **Long press** — same as tap; it has no separate action.
- **Drag up** — increase value (depth, rate, count, etc).
- **Drag down** — decrease value. Reaching the bottom of the range
  sends `0`.
- **Drag horizontally on a Stutter** — change ratchet count.
- **Drag horizontally on an LFO** — change modulation rate.

---

## 15. Troubleshooting

| Symptom                          | Fix                                                                 |
| -------------------------------- | ------------------------------------------------------------------- |
| Phone won't connect              | See `docs/INSTALL.md` — check Wi-Fi, IP, certificate warning.       |
| Sensor values stuck / wrong      | Press **CALIBRATE** on a stable surface.                            |
| LFOs desynced from Live          | Press **SYNC** to re-lock to Live's BPM.                            |
| MAP target list looks stale      | Press **Refresh** in MAP mode after adding/removing Live devices.    |
| Trigger Note cannot add device   | Place `RC-Midi-Receiver.amxd` manually on the MIDI track and retry. |
| Touch response feels slow        | Use a wired network or sit closer to the Wi-Fi access point.        |
| Phone status indicators look odd | Refresh the phone browser; session resets cleanly.                  |

For deeper setup issues (certificates, network, installation) see
`docs/INSTALL.md` and `docs/FAQ.md`.
