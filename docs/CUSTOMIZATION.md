# Customization Guide

This guide explains where to change Ableton RC Surface without duplicating old code.
It is written for humans and AI agents.

Read first:

- `docs/AGENT_GUIDE.md`
- `CONTRIBUTING.md`
- `docs/README.md`

## Current Architecture

Backend:

- `src/extension.ts` - bootstrap only.
- `src/server/state.ts` - server lifecycle.
- `src/server/http.ts` - HTTP/static serving.
- `src/server/ws.ts` - WebSocket clients, dispatch, snapshot handling.
- `src/server/cert.ts` - self-signed cert generation and SAN checks.
- `src/live/mappings.ts` - command registry, mapping engine, curves, smoothing, and event modes.
- `src/live/state.ts` - playhead/live state loop.
- `src/ui/panel.ts` - Ableton panel dialogs.
- `src/runtime/safety.ts` - process safety handlers.

Frontend:

- `static/phone-v3/` - phone performance client.
- `static/panel/` - Ableton panel UI.
- `static/admin/` - admin dashboard.

All static clients are plain browser JS. No bundler. Tests live beside the static files.

## Development Loop

Install:

```powershell
npm install
```

Check:

```powershell
npm test
npx tsc --noEmit
```

Build:

```powershell
npm run build
npm run build:prod
npm run package
```

Hot reload:

- `static/**` change: refresh phone/panel browser.
- `src/**` change: rebuild, then disable/enable extension in Ableton Live.
- `npm run watch` can sync built files into Ableton AppData during development.

## Control Names

Control updates use:

```javascript
{ name: "pad-1", value: 1 }
```

Canonical groups:

- `pad-1` through `pad-12`
- `knob-1` through `knob-6`
- `fader-1` through `fader-6`
- `xy-1.x`, `xy-1.y`, `xy-2.x`, `xy-2.y`
- `toggle-1` through `toggle-4`
- `button-1` through `button-4`
- `sensor.motion.*`
- `sensor.orient.*`
- `sensor.audio.*`
- `sensor.vision.*`

Before adding a control:

1. Search current source.
2. Reuse existing owner.
3. Emit through existing snapshot/controls flow.
4. Add panel/admin target entry if user should map it.
5. Add tests.
6. Update this file if public.

## Phone Controls

Main files:

- `static/phone-v3/index.html` - DOM.
- `static/phone-v3/style.css` - layout and visuals.
- `static/phone-v3/app.js` - app state, WebSocket, sensors, snapshots.
- `static/phone-v3/controls.js` - touch controls.
- `static/phone-v3/mode-engine.js` - scalar mode behavior.
- `static/phone-v3/mapping-mode.js` - mobile MAP workflow and target editor.

Pad modes:

- A: momentary, releases to zero.
- B: hold/edit, keeps last value.
- C: toggle with editable max while held.
- D: burst, attack/release pulse.

If mode behavior changes, update:

- `static/phone-v3/mode-engine.js`
- `static/phone-v3/controls.js`
- `static/phone-v3/mode-engine.test.mjs`
- specific UI tests such as `static/phone-v3/stutter-mode.test.mjs`

## Mobile MAP Mode

The phone MAP workflow lets users create and edit mappings without
opening the Ableton panel. It uses the same backend command registry as
the panel/admin UI.

Main files:

- `static/phone-v3/index.html` - MAP button and overlay containers.
- `static/phone-v3/app.js` - `window.sendPhoneCommand`, command response
  callbacks, mapping-mode telemetry throttling, and WebSocket lifecycle
  events.
- `static/phone-v3/mapping-mode.js` - mobile mapping state, selection
  interception, target picker, presets, trigger-note flow, and rich editor.
- `static/phone-v3/style.css` - MAP highlighting, overlay, target tree,
  MIDI note controls, and curve editor visuals.
- `static/phone-v3/mapping-mode.test.mjs` and
  `static/phone-v3/mobile-ui.test.mjs` - static UI regressions.

Important behavior:

- MAP mode intercepts touch/click events during capture phase on
  `[data-name]` controls. Do not let normal performance gestures leak
  through while MAP is active.
- Visible performance controls are selected directly from the live UI.
  The fallback control list still includes sensors and all canonical
  controls.
- XY pads are mapped per axis: `xy-1.x`, `xy-1.y`, `xy-2.x`, `xy-2.y`.
- The target picker must preserve hierarchy: Song / Main / Master,
  Tracks, Return Tracks, devices, and parameters. Avoid flat lists for
  user-facing target selection.
- Targets can include `trackKind: "track" | "return" | "main"`. Preserve
  this field when adding mapping targets; backend routing depends on it.
- Trigger-note targets use `mode: "trigger_note"` with
  `type: "device_param"` for compatibility with the mapping engine.
  Identity is track + MIDI note, not device/parameter slot.
- Mobile mapping keys can be scoped by phone client ID
  (`client-id::control`). Always use the local `mappingKey()` helper
  before reading or writing `state.currentMappings`.

Editor fields currently exposed on mobile:

- `mode`: `continuous`, `toggle`, `trigger_note`
- `curve`: `linear`, `exponential`, `logarithmic`, `s-curve`
- `inMin`, `inMax`, `outMin`, `outMax`
- `drive`, `compressor`, `smooth`, `threshold`
- `midiNote` via Pitch/Octave selectors
- `midiVelocity`

The curve canvas is a local visual preview of the mapping response. If
the backend curve implementation changes, update both the backend tests
and the mobile preview math.

## Vision

Vision is single-hand by design.

Files:

- `static/phone-v3/vision-processor.js`
- `static/phone-v3/vision-processor.test.mjs`
- `static/phone-v3/app.js`
- `static/panel/app.js`

Canonical controls:

- `sensor.vision.active`
- `sensor.vision.x`
- `sensor.vision.y`
- `sensor.vision.z`
- `sensor.vision.fist`
- `sensor.vision.pinch`
- `sensor.vision.victory`
- `sensor.vision.open`
- `sensor.vision.thumb`
- `sensor.vision.index`
- `sensor.vision.middle`
- `sensor.vision.ring`
- `sensor.vision.pinky`
- `sensor.vision.fingers`
- `sensor.vision.color.r`
- `sensor.vision.color.g`
- `sensor.vision.color.b`

Do not reintroduce two-hand names from old plans unless the user asks for a new migration.

## Audio

Files:

- `static/phone-v3/audio-processor.js`
- `static/phone-v3/audio-processor.test.mjs`
- `static/phone-v3/app.js`
- `static/panel/app.js`

Canonical controls:

- `sensor.audio.rms`
- `sensor.audio.pitch`
- `sensor.audio.bpm`
- `sensor.audio.note`
- `sensor.audio.clarity`
- `sensor.audio.whistle.active`
- `sensor.audio.whistle.bend`
- `sensor.audio.envelope`
- `sensor.audio.transient`
- `sensor.audio.gate`

Prefer extending `sensor.audio.*` over creating new audio namespaces.

## Mapping UI

Files:

- `static/panel/index.html`
- `static/panel/app.js`
- `static/panel/mappings.js`
- `static/panel/mappings.test.mjs`
- `static/phone-v3/mapping-mode.js`
- `static/phone-v3/mapping-mode.test.mjs`

Mapping UI must support:

- multiple targets per control;
- inline curve/range editing per target;
- conflict warnings without blocking `alert()`;
- replace flow that removes old mapping before setting new one;
- live graph update while dragging sliders.
- mobile-first binding through the phone MAP mode;
- trigger-note mappings with `RC-Midi-Receiver.amxd` reuse/manual fallback;
- normal tracks, return tracks, and main/master targets.

Do not add another modal if inline editing can solve it.

## Backend Commands

Command registry lives in `src/live/mappings.ts`.

Mobile MAP mode currently depends on these commands:

- `getTargets`
- `getMappings`
- `setMapping`
- `removeMapping`
- `getClients`
- `listPresets`
- `savePreset`
- `loadPreset`
- `deletePreset`
- `addUdpReceiverToTrack`

When adding a command:

1. Add handler in current command registry.
2. Keep args JSON-serializable.
3. Return diagnostic data, not only boolean success.
4. Add source-side test in `tests/*.test.mjs`.
5. Wire UI only after handler test passes.

## WebSocket Protocol

Typed phone messages such as `snapshot`, `ping`, and display-name updates are not Live commands.
Command envelopes are separate.

When adding a message type:

- update dispatch filtering in `src/server/ws.ts` if needed;
- preserve snapshot `controls[]` shape;
- add tests to avoid "foreign msg" log spam.

## Docs Checklist

Update docs when public behavior changes:

- Install/certs/network: `docs/INSTALL.md`, `docs/SECURITY.md`.
- Data flow/privacy: `docs/PRIVACY.md`.
- New controls/sensors: `docs/CUSTOMIZATION.md`, `README.md`.
- Agent workflow: `docs/AGENT_GUIDE.md`.

Do not edit archived docs except to move or label them.
