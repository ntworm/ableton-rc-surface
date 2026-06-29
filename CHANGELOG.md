# Changelog

All notable changes to Ableton RC Bridge are documented here.
Format follows [Keep a Changelog](https://keepachangelog.com/).

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
  - `src/live/snapshots.ts` — Mix View tiered snapshot loop

### Added
- `npm run lint` (ESLint), `npm run typecheck`, `npm run ci` scripts
- `.editorconfig`, `.nvmrc`, `.eslintrc.cjs`, `.eslintignore`
- `.github/workflows/ci.yml` (multi-platform CI)
- `.github/workflows/release.yml` (draft release with platform `.ablx`)
- `docs/SECURITY.md`, `docs/PRIVACY.md`, `CONTRIBUTING.md`

## [0.4.15] — 2026-06-29

### Fixed
- Mappings tab live updates and control value synchronization
- Build and test pipeline (113 tests passing)

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
- 12 pads (4 modes), 2 XY pads, 8 knobs, 12 faders, 4 ribbons
- 8 snapshot morph slots + 2D vector morph pad
