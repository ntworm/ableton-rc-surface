# Changelog

All notable changes to Ableton RC Surface are documented here.
Format follows [Keep a Changelog](https://keepachangelog.com/).

## [Unreleased]

### Added
- Global Safe Input Layer with soft takeover (`scale` default, `pickup`, advanced `jump`), host reconciliation, integrated ghost feedback, sensor filtering, explicit loss/recovery states, and disconnect-safe momentary release.
- Audio hold/release watchdog, single-hand 3D calibration, three vision smoothing presets, bounded inertial tracking, and trainable gesture Learn/Test flows that never learn or emit predicted gestures during performance.
- Locally bundled MediaPipe Hands and Camera Utilities for offline vision startup.
- Versioned per-set `.rcsurface` profiles with semantic target signatures, confidence-based relink, load reports, import/export, atomic backup, schema migration, and rollback.

### Changed
- Mapping editors now expose takeover mode and neutral loss policy/value per target.

## [0.5.9] — 2026-07-21

### Changed
- **Robust learned-gesture matching** — `safe-input-layer.js` learned static poses are now matched against a canonically-aligned descriptor instead of a 7-angle brute-force search. Each captured frame is wrist-centred, scaled by the mean of the four wrist→MCP distances, and rotated so the wrist→middle-MCP vector lies on the +X axis. The matcher then runs a per-landmark weighted RMS (MCPs 1.0, intermediate joints 0.7, fingertips 0.4, wrist excluded). The same gesture now triggers from a wider range of camera distances, hand rotations, and lighting conditions without retraining.
- **Vision card layout** — the camera stage and the Vision command bar (CAMERA toggle + CONF selector) now share a dedicated right-column sidebar wrapper (`.vision-camera-sidebar`) so the camera preview and controls stay co-located regardless of viewport height.
- **Confidence mapping** — `app.js` now translates the backend's numeric confidence values (0.2/0.5/0.7) to the UI's `low`/`medium`/`high` strings before applying the saved value, so a stored config that uses one convention does not silently fall back to `medium` on reload.

### Fixed
- **build.ts fail-loud on missing source** — `copyDir` now throws with an actionable hint ("Did you forget to run npm install?") instead of returning silently when the static source path is absent.
- **camera preview grid placement** — the camera preview now stays anchored to the Vision grid column 1 under all supported viewport heights, including the ≤430px media query.

### Tuned defaults (learned-gesture recognizer)
- `threshold`: 0.13 → 0.18
- `minimumConfidence`: 0.55 → 0.45
- `holdMs`: 220 → 160 (more responsive trigger)
- `releaseMs`: 180 (unchanged)

### Tests
- 104/104 tests passing on `npm run ci` (tests + `tsc --noEmit` + `build:prod`).
- Updated `mobile-ui.test.mjs` to assert the new `.vision-camera-sidebar` wrapper holds `grid-column: 1`.

## [0.5.8.4] — 2026-07-12

### Fixed
- **Phone audio analysis restored** — removed the AudioWorklet path and returned microphone analysis to the stable `AnalyserNode` pipeline, preserving the existing `sensor.audio.*` protocol.
- **Stage fullscreen entry restored** — returned the production phone UI to the previous direct `document.documentElement.requestFullscreen()` toggle and removed the experimental controller from the page load path.

### Known limitation — 2026-07-12
- Enabling the audio sensor or camera while Stage Mode is fullscreen can force Chrome Android out of fullscreen. On the tested Samsung S25F, fullscreen may remain unavailable until the controller tab is closed and reopened. Enable audio/camera before entering Stage Mode when possible.

### Tests
- Full test suite, TypeScript check, and production build pass before release.

## [0.5.8.3.post2] — 2026-07-11

Post-release hotfix. The "Stage mode fullscreen sticky" fix shipped in v0.5.8.3 was actually a no-op in production: `stage-mode-controller.js` was loaded via a classic `<script>` tag while the file used `export function`, so the browser threw `Unexpected token 'export'` and `globalThis.AbletonRcStageMode` was never defined. controls.js then fell through to a legacy inline fallback that had no re-arm logic — exactly what the user hit when the mic permission prompt consumed the first fullscreen user gesture.

### Fixed
- **Stage mode sticky-fullscreen now actually runs in production** — load `stage-mode-controller.js` as `<script type="module">` so the `export function createStageModeController` parses; wrap the setupXUI() calls in `bootstrapControls()` and dispatch on `DOMContentLoaded` so controls.js doesn't race the deferred module evaluation; rAF-poll (max ~2 s) for `AbletonRcStageMode` before installing the legacy fallback so the controller is always the primary code path.
- **Stage UI no longer lies after a rejected fullscreen request** — `enter()` now `await`s `requestRootFullscreen()` and rolls the `stage-mode` class + button text back if the browser rejects the request. Before, the class and "EXIT" button flipped synchronously while the URL bar stayed visible — the phantom state reported when the mic permission prompt ate the fullscreen gesture.
- **localStorage pad-mode restore** — moved before the bootstrap dispatch so cold reloads don't flash mode A before applying the saved mode; removed the duplicate restore block that survived an earlier refactor.

### Build
- **New `.ablx` build** — `releases/Ableton-RC-Surface-0.5.8.3.ablx`, SHA256 `10d4311e3afc4f3e1d69b278ddf81a5a6d5717bd9dc4ebeaf410fee68210bb73` (321 KB). Reinstall via Ableton Extensions Manager — the hotfix in this entry is not in the previously-released artifact.

## [0.5.8.3.post1] — 2026-07-10

Post-release consolidation for `v0.5.8.3`. No code changes since the tag — this entry moves CI/doc fixes that landed on `main` after the v0.5.8.3 release into versioned history. **No new `.ablx` build is published; GitHub and Gumroad continue to ship `v0.5.8.3`.**

### Fixed
- **CI broken since v0.5.4** — added `FUNDING.md` to `stageDocs` in `scripts/package-tester-kit.mjs` so the staged-docs link integrity test passes (`docs/FAQ.md` references `FUNDING.md`, which was outside the staged set, breaking every CI run for the last 4 days).
- **FUNDING.md / docs/FAQ.md** updated to reflect the live Gumroad pay-what-you-want page (R$25 suggested, R$0 minimum, R$0 default).
- **bug-report issue template** renamed `Ableton-RC-Bridge` to `Ableton-RC-Surface` (matches `manifest.json`) and removed the stale `/debug-overlay` path that no longer exists.
- **macOS CI failure since project start** — moved `@esbuild/linux-x64` from `dependencies` to `optionalDependencies`, and added `@esbuild/darwin-arm64` and `@esbuild/darwin-x64`. `dependencies` is mandatory, so the linux-x64 binary was being installed on macos-arm64 runners, hitting `EBADPLATFORM` (unsupported os:linux, cpu:x64 on a darwin/arm64 host), and `npm ci` exited 1 before any test ran. All `@esbuild/*` packages are now optional — esbuild has a pure-JS fallback if no native binary matches.
- **`release-cleanup` test** was reading a gitignored blog draft (private, not in the public repo), causing the `Run CI` step to fail with `ENOENT` on every runner. Removed that file from the test list; the regression guard now only asserts against files that ship with the public repo (`src/live/mappings.ts`).
- **`docs/SECURITY.md`** dropped the "Future Security Plans (Pairing & PIN)" section — pairing/PIN is not on the current roadmap and the section suggested it was.
- **`README.md`** added badges: PolyForm Noncommercial license (note: the badge label here reflects the entry's date; the project was relicensed to PolyForm Noncommercial 1.0.0 in commit `67e14e5`), current version (0.5.8.3), CI status, stars.
- **Landing page (`docs/index.html`)** version reference updated from "v0.5.8 pre-launch" to "v0.5.8.3" (matches `package.json` and the latest `git tag`).

### Tests
- 72/72 tests passing locally with `npm run ci` (matches the CI gate).

### Build
- No new `.ablx` package. Released artifact unchanged: `releases/Ableton-RC-Surface-0.5.8.3.ablx`.

## [0.5.8.3] — 2026-07-07

### Fixed
- **Stage mode fullscreen sticky** — re-arm on involuntary exit (iOS edge swipe, native confirm dialog). Extracted `stage-mode-controller.js` with explicit `userExited` flag and debounce. New ESM module is testable in isolation under `node --test`. 6 new tests for the controller.
- **LFO/stutter jitter** — host-side phase-from-time + 250Hz tick. Replaced phase accumulator (`state.phase += 2*PI*freq*dt`) with phase-as-function-of-time anchored to `phaseZeroMs`. Missed/delayed ticks no longer cause drift. 5 new tests.
- **Cooperative UDP port 11001** socket sharing — resolves conflicts with `ableton-setlist-bridge` running in the same Live instance.
- **`global` → `globalThis`** for compatibility in strict extension host env (Live 12.4.5b6).
- **`RC_SURFACE_PORT`** env var honored (bug #7).
- **MIDI receiver** rewired `unpack` → `midiformat` via pack list.
- **transport-clock** divide-by-zero guard in `computeSyncedLfoValue`.
- **osc-transport** shared socket race (require both socket+listeners init), heartbeat false-disconnect (only after first message, 5s threshold), `dispose()` no longer closes socket owned by sibling extensions.
- **mappings** `clearMappings`/`loadPreset` now clear `lastMappedValues`, `eventModesState`, `activeSmooths`, `hostModulators` (no stale state leak).
- **udp-midi** removed `console.log` on hot path; `mappings` removed `trigger_note` console.log spam; finite-number checks in `setTempo`/`setDeviceParam`; NaN/edge guards in `applyCurve`/`inverse`.
- **ws** typed message handler returns push-update flag explicitly; JSON parse errors now logged.
- **safety** `uninstallRuntimeSafety` called from `deactivate()` so listeners don't accumulate across hot-reloads.
- **state** `listenOnPreferredOrRandom` re-arms listeners after fallback so a second EADDRINUSE doesn't crash silently.
- **cert/mappings** extracted `stripWslDrivePrefix` + `sanitizeFilenameComponent` helpers (removed 3x regex duplication).
- **panel** re-exported `showInfoDialog` from `util/helpers` (removed duplicate).

### Tests
- 58/58 tests passing (53 pre-existing + 5 new for LFO/stutter phase-from-time).
- New: `tests/lfo-high-rate-jitter.test.mjs`.
- `npm run ci` clean (tests + tsc + build:prod).

### Build
- `releases/Ableton-RC-Surface-0.5.8.3.ablx` (310351 B).

## [0.5.8.2] — 2026-07-07

### Fixed
- LFO/stutter jitter at high frequencies (see 0.5.8.3 for the full fix). First pass of the phase-from-time refactor before the test harness landed.

## [0.5.8.1] — 2026-07-07

### Fixed
- Consolidated bugfixes batch (TDD-validated, 53/53 tests green). Includes transport-clock divide-by-zero guard, osc-transport shared socket race, mappings state leak fixes, console.log removal, finite-number checks, NaN/edge guards, websocket push-update flag, runtime safety hot-reload fix, listen re-arm, cert/mappings helpers, panel dialog re-export.

## [0.5.8] — 2026-07-07

### Changed
- Manifest bumped 0.5.7 → 0.5.8.

### Fixed
- Cooperative UDP port 11001 socket sharing (first version, refined in 0.5.8.3).
- `global`/`osc-min` compatibility for Live 12.4.5b6 host.
- `RC_SURFACE_PORT` env var honored (bug #7).
- MIDI receiver rewired `unpack` → `midiformat` via pack list.

### Tests
- New: `tests/server-state` listen port env var coverage.
- New: stress harness (`fake-phone`, `admin-observer`, `launch-clients`).

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
