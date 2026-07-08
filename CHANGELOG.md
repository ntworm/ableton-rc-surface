# Changelog

All notable changes to Ableton RC Surface are documented here.
Format follows [Keep a Changelog](https://keepachangelog.com/).

## [0.5.7] — 2026-07-06

### Added
- **Performance UTIL column** — PERF now exposes `CAP`, direct snapshot slots `1`-`4`, and `OFF` for fast live-performance actions.
- **Mobile MAP mode** - phone users can select highlighted controls directly
  from the performance UI, bind them to Live parameters, edit mapping ranges
  and curves, manage local presets, and unbind targets without opening the
  Ableton panel.
- **Hierarchical mobile target picker** - mapping targets are grouped by
  Song / Main / Master, normal tracks, return tracks, devices, and
  parameters.
- **Mobile MIDI trigger notes** - phone controls can trigger MIDI notes on a
  selected MIDI track through `RC-Midi-Receiver.amxd`, with pitch/octave and
  velocity editing.
- **XY axis mapping** - XY pads expose separate X/Y mapping controls on the
  mobile editor.
- **Curve preview on mobile** - the mapping editor includes a 2D response
  canvas with a moving dot for live input/output feedback.

### Changed
- Removed the old PERF control pair from the phone UI, mapping catalogs, panel groups, and public docs.
- Snapshot recall now skips saved keys that no longer have live control setters.
- Snapshot morphing now drives mapped Ableton values during transitions
  instead of applying only the final state.
- `getTargets` exposes return tracks and the main/master track with
  `trackKind` routing.
- `addUdpReceiverToTrack` reuses an existing receiver instead of deleting and
  reinserting it.

### Fixed
- **Performance OFF** resets pads, LFOs, stutters, centered XY pads, and active morph state without touching mixer controls, sensors, audio, vision, or transport.
- High-rate LFO/Stutter mappings are stabilized through host-side mapping
  updates.
- Trigger-note mappings no longer collide with regular device-parameter
  mappings or with other pads using different notes on the same MIDI track.
- UDP MIDI note bytes were aligned with the Max for Live receiver.
- Mobile mapping reads/writes use scoped phone mapping keys consistently.

### Tests
- Static phone tests cover the PERF `UTIL` layout.
- PERF snapshot capture/recall and `OFF` behavior are covered.
- Mobile mapping tests cover command bridge behavior, MAP selection, binding,
  presets, trigger notes, target hierarchy, and scoped-key regressions.
- Source tests cover UDP MIDI receiver reuse and trigger-note identity.

## [0.5.5] — 2026-07-02

### Fixed
- **Legacy gesture mapping cleanup** — removed obsolete `gesture.pinch` from `gridSensors`, `allSensorMetadataList`, and `defaultRecentKeys` in the Ableton panel client, replacing it with `sensor.vision.pinch` in the `vision` group to align with what the phone client actually emits.
- **Admin dashboard cleanup** — removed dead `gesture` UI cards and category groupings in the standalone admin/mapping dashboard, as all gestures have been migrated to standard `sensor.vision.*` control channels.

## [0.5.4] — 2026-07-01

### Added
- **Stutter ratchet count axis** — horizontal drag now snaps the
  stutter to discrete ratchet levels `[1, 2, 3, 4]` while the vertical
  axis keeps driving rate (1–15 Hz).
- **Progressive zebra visual** — each ratchet step reveals an extra
  horizontal yellow stripe at the center, growing outward as count
  increases. 5 stripes controlled via `--s1..--s5` custom properties
  stacked in `::after`.
- **LFO mode B threshold fix** — tap (no movement) or pure-vertical
  drag down to zero now correctly deactivates. Any horizontal motion
  keeps the button held even when rate drops to 0.

### Changed
- Stutter rate initial value lowered (`0.5 → 0.1`) so the button
  starts quieter on first touch.
- Stutter visual flicker cap raised to 15 Hz to match the new range.
- Panel UI group "Toggles" renamed to "LFOs" (label-only; wire ids
  and CSS classes unchanged).

## [0.5.3] — 2026-06-30

### Fixed
- Panel metrics regression in the Connect strip.
- RTT ping-pong instrumentation causing unnecessary WS traffic.
- Camera frame processor optimization for low-end devices.
- Visual aliasing cap applied to the stutter blink animation.

## [0.5.2] — 2026-06-30

### Changed
- Removed stale client-facing musical-scale UI claims from release docs.

## [0.5.1] — 2026-06-30

### Added
- Test-build release prep for the post-`v0.5.0` controller changes.
- Panel CPU telemetry in the Connect strip.
- Expanded audio controls: `sensor.audio.note`, `sensor.audio.clarity`,
  `sensor.audio.whistle.active`, `sensor.audio.whistle.bend`,
  `sensor.audio.envelope`, `sensor.audio.transient`, and
  `sensor.audio.gate`.

### Changed
- Mapping response chips now support drive, compression, toggle mode, and
  updated curve previews.
- The Connect tab keeps a recent-controls grid for faster remapping.
- Haptics/vibration is retired for this test series; compatibility hooks
  remain as no-ops where needed.
- Canonical docs now use the real control names emitted by the phone app.

### Fixed
- CI now has an `npm run ci` script matching the GitHub workflow.
- The panel Mappings search layout is corrected.
- Public docs no longer mention old haptic controls or placeholder release URLs.

## [0.5.0] — 2026-06-30

### Changed
- **Modular architecture.** `src/extension.ts` is now a 132-LOC bootstrap
  (down from **3575 LOC**, -96%). All state machines, protocol handlers,
  snapshot loops, cert loading, panel wiring, and runtime safety nets
  live in dedicated modules:

  - `src/context.ts` — SDK context get/set/clear + `requireCtx` / `requireTrack`
  - `src/runtime/safety.ts` — `installRuntimeSafety()` (idempotent
    `uncaughtException` / `unhandledRejection` handler installer)
  - `src/ui/panel.ts` — `showPanelDialog` / `showMappingDialog` /
    `showInfoDialog` / `registerPanelCommand`
  - `src/util/cpu.ts` — `sampleCpuUsagePercent()`
  - `src/util/helpers.ts` — math clamps, LAN resolution, timeout wrapper
  - `src/server/state.ts` — `startServer` / `stopServer` (HTTP + HTTPS)
  - `src/server/cert.ts` — `loadCerts` (self-signed TLS)
  - `src/server/http.ts` — `handleHttp` (incl. `/health`, `/commands`,
    `/test`, `/static/*`) + `serveStaticFile`
  - `src/server/ws.ts` — `wssInit`, `handleUpgrade`, `setupWssHandlers`,
    command dispatch, and `closeDuplicateIpClients`
  - Legacy standalone MIX protocol helpers were part of this historical
    release path and were removed in the current architecture.
  - `src/server/client-id.ts` — `createClientId(queryId?)` (RFC 4122 v4)
  - `src/live/state.ts` — playhead + live-state broadcast loop
    (start/stop/isRunning)
  - `src/live/mappings.ts` — `commands` registry, mapping engine,
    smoothing, presets, `configureMappingStorage`
  - Legacy standalone MIX snapshot loop
    (structure / mixer / params), removed in the current architecture.

- **Real `deactivate()` lifecycle.** Activates the previously-stub
  `deactivate()` flow: stops snapshot loop, smooth timer, live-state
  broadcast, server (HTTP+WS), then clears the extension context.
  Idempotent — a double-deactivate from Live is safe.

- **AppData sync opt-in.** `build.ts` no longer copies built files
  into Ableton's persistent storage directory by default. Set
  `ABLETON_RC_DEV_SYNC=1` to enable the old auto-sync behaviour.
  Avoids surprise overwrites of installed extensions during normal
  builds.

- **Test split.** `npm test` is now the aggregator of `test:static`
  (existing node:test suite for `static/{admin,panel,phone-v3,mix}/*.test.mjs`)
  and `test:src` (new node:test suite in `tests/*.test.mjs` covering the
  source-side helpers added during this refactor).

### Tests
- Added source-side test harness under `tests/`. Covers `mixParseId`
  contract (valid + malformed inputs), `mixWriteQueueKeyFor`
  stability, `createClientId` UUID format, `sampleCpuUsagePercent`
  range, and the lifecycle helpers (`startLiveStateBroadcastLoop` /
  `stopSmoothTimer` idempotency).

## [0.4.28] — 2026-06-29

### Fixed
- **Linear screen-orientation-aware accelerometer mapping** for beta (pitch)
  and gamma (roll). The v0.4.27 raw-atan2 mapping assumed device-up
  orientation; this fix follows screen orientation so it works regardless
  of how the phone is held.

## [0.4.27] — 2026-06-29

### Changed
- **Derive pitch / roll from accelerometer** (gravity vector), scale emitted
  controls to fit the [−1, 1] MIDI range correctly, and remove redundant
  UI sections (Calibration modal vanished labels; Mapping detail panel
  no longer shows NULL bindings).

## [0.4.26] — 2026-06-29

### Changed
- **Drop sensor fusion entirely.** `sensor.orient.*` is now bound directly
  to `DeviceOrientationEvent.{alpha,beta,gamma}`. Removed Madgwick AHRS,
  adaptive denoise, smoothAngle, smoothLinear, and the accel-only atan2
  fallback. Drift and the runaway-gamma bug become structurally
  impossible: orientation is no longer computed, just forwarded.
- `Calibrar Sensores` button now clears stored offsets and resets
  `state.orient`; auto-calibrate-on-first-event is removed.
- Devicemotion handler emits raw motion values with no transform.

### Removed
- `vendor/madgwick.js`, `sensor-denoise.js` + test, `sensor-stability.js`
  + test, `sensor-accel.js` + test.
- `sensor-fusion.test.mjs` (replaced by `sensor-orientation.test.mjs`).

## [0.4.25] — 2026-06-29

### Changed
- Switch beta and gamma from Madgwick AHRS to raw accelerometer `atan2`
  (`accelToEuler`). Madgwick drifted on pitch/roll due to uncompensated
  gyro bias and produced the runaway-gamma bug. Accel-derived angles are
  drift-free because gravity is constant.
- Remove `smoothLinear` (EMA + jumpThreshold) and the `smoothedBeta` /
  `smoothedGamma` state — the accel signal is already band-limited.
- Alpha (yaw) still uses Madgwick because accel cannot derive heading.

### Added
- `static/phone-v3/sensor-accel.js` exposing `accelToEuler()`.

## [0.4.24] — 2026-06-29

### Fixed
- **Gyro-stability tracker regression.** `createGyroSettledTracker` reset
  the Madgwick quaternion every ~5 s of stillness; this triggered during
  normal use and produced alpha stuck at 180° and beta/gamma drifting
  across the ±180° boundary.
- Sensor denoise is now applied to alpha as well (was beta/gamma only).
- Smoothed-pipeline reset on calibration works correctly.

### Removed
- `createGyroSettledTracker` function.
- `#gyro-stability-status` UI element and its CSS (dead code).

## [0.4.23] — 2026-06-29

### Fixed
- Phone sensor orientation drift stabilization (denoise, low-pass EMA,
  gyro bias removal in Madgwick).

## [0.4.22] — 2026-06-29

### Fixed
- Connect tab QR codes no longer flip or vanish when the panel re-renders.
- Grouped control cells in the panel show the correct control count and
  filter.

## [0.4.21] — 2026-06-29

### Changed
- Removed the dedicated Server CPU usage bar added in v0.4.20. CPU
  saturation is now shown as a tooltip on the connection-strip VU meter
  (`lastCpuUsage` from `getServerInfo.cpuUsage`). Same 50% / 80% color
  thresholds.

## [0.4.20] — 2026-06-29

### Added
- **Server CPU usage bar** in Connect tab (above the connection strip).
  Reads `getServerInfo.cpuUsage` populated by `sampleCpuUsagePercent()`
  (process CPU delta normalized against logical core count). Bar shifts
  accent → orange → red at 50/80% thresholds. Label reads "Server CPU
  usage (saturation = latency risk)".
- **Grouped control categories** below the live sensor grid: SENSORS,
  PADS, XY, TOGGLES, STUTTERS, KNOBS, FADERS. Each block shows name +
  item count; click expands the list; click on an item jumps to
  Mappings tab with that control selected.

### Changed
- **QR codes stay fixed and visible** for the phone camera. The
  Copy buttons on the QR cards were replaced with Open links:
  PERFORMANCE → `/`, MIX → `/mix/`. Admin link retained.

## [0.4.19] — 2026-06-29

### Fixed
- Sensor gyro alignment, removed denoiser from euler, disabled battery
  flashing red, added camera start permissions alert.
- Audio loop, duplicate-trigger prevention, resize behavior, calibration
  flow, control naming (v0.4.18).

### Added
- Mix view refactor + adaptive sensor denoising (v0.4.17).

## [0.4.16] — 2026-06-29

### Fixed
- QR code phone URL now uses HTTP instead of HTTPS. Self-signed certs
  blocked mobile browsers from loading the phone client. Admin stays
  HTTPS (localhost trusts the cert); phone/mix use HTTP.

### Changed
- **Modularized `src/extension.ts`** (~3500 lines → 9 focused modules):
  - `src/context.ts` — SDK context & safety wrappers
  - `src/util/helpers.ts` — math clamps, LAN IPs, timeout, dialogs
  - `src/server/cert.ts` — self-signed cert generation & persistence
  - `src/server/state.ts` — HTTP/HTTPS server lifecycle
  - `src/server/http.ts` — static file server & routing
  - `src/server/ws.ts` — WebSocket servers, client tracking, dispatch
  - `src/live/state.ts` — playhead & song state broadcast
  - `src/live/mappings.ts` — mapping engine, smoothing, presets
  - Legacy standalone MIX snapshot loop, removed in the current architecture.

### Added
- `npm run lint` (ESLint), `npm run typecheck`, `npm run ci` scripts
- `.editorconfig`, `.nvmrc`, `.eslintrc.cjs`, `.eslintignore`
- `.github/workflows/ci.yml` (multi-platform CI)
- `.github/workflows/release.yml` (draft release with platform `.ablx`)
- `docs/SECURITY.md`, `docs/PRIVACY.md`, `CONTRIBUTING.md`

## [0.4.15] — 2026-06-29

### Fixed
- Mappings tab live updates and control value synchronization
- Build and test pipeline

## [0.4.14] — 2026-06-28

### Added
- Customizable dashboard with accelerometer fix and pad mode colors

## [0.4.0] — 2026-06-27

### Added
- Full mapping system with custom curves, range scaling, BPM sync
- SVG preview for control assignments
- Starter templates for common workflows
- Auto-discovery of track devices and parameters

## [0.3.3] — 2026-06-26

### Fixed
- Sensor init emits and motion rotation source

## [0.3.2] — 2026-06-26

### Fixed
- Sensor mapping corrections

## [0.3.1.1] — 2026-06-25

### Fixed
- Mix View flicker and stale params
- Smart control selection in Generic template

## [0.3.1] — 2026-06-25

### Added
- **Mix View**: structure-aware mobile mixer with real-time volume,
  pan, mute, solo, sends, and device parameter control
- Tiered snapshot loop (structure 0.5Hz, mixer 5Hz, params 2Hz)
- Per-target write queue serialization for concurrent clients
- Dual QR code in the Live panel (Performance + Mix)

## [0.3.0] — 2026-06-24

### Added
- Per-install self-signed HTTPS certificates
- Audio pipeline: YIN pitch detection, RMS, onset/BPM
- Camera pipeline: MediaPipe Hands hand-tracking, ambient color
- Performance-grade admin UI (no more 30 Hz DOM thrash)
- 12 pads (4 modes), 2 XY pads, 8 knobs, 12 faders, performance utilities
- 8 snapshot morph slots + 2D vector morph pad
