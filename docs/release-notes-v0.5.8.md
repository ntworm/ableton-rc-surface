# Ableton RC Surface v0.5.8 — Release Notes

This release consolidates the v0.5.8.x bugfix series: stability, the LFO/stutter jitter fix that landed in v0.5.8.2/0.5.8.3, restored phone audio analysis, and the previous direct Stage fullscreen toggle in v0.5.8.4. No new features versus v0.5.7 — every change is a stability or correctness fix.

## Highlights

- **LFO / Stutter jitter fix (v0.5.8.2 → v0.5.8.3)** — high-frequency modulators no longer alias on the mapped parameter (e.g. pan at 20 Hz). Phase is now a deterministic function of absolute time (`phase = 2π · freq · (now − phaseZeroMs) + state.phase`), anchored to a per-state `phaseZeroMs` set on the first tick. A missed or delayed tick does not cause drift. Tick rate raised from 50 Hz to 250 Hz.
- **Stage mode fullscreen sticky (v0.5.8.3)** — Stage mode no longer falls back to the regular UI when the browser exits fullscreen involuntarily (iOS edge swipe, native confirm dialog, etc.). Extracted into `stage-mode-controller.js` with an explicit `userExited` flag so the re-arm path doesn't fight the explicit `exit()` call.
- **Audio + Stage rollback (v0.5.8.4)** — microphone analysis is back on the stable `AnalyserNode` pipeline, and the phone UI again uses the previous direct fullscreen toggle. Enabling audio/camera from inside fullscreen remains a documented Chrome Android limitation.
- **Cooperative UDP port 11001 socket sharing** — resolves conflicts when `ableton-setlist-bridge` is running in the same Live instance. `RC_SURFACE_PORT` env var now honored (bug #7).

## Stability Fixes (across v0.5.8, 0.5.8.1, 0.5.8.2, 0.5.8.3)

- `global` → `globalThis` for strict extension host env (Live 12.4.5b6).
- `transport-clock` divide-by-zero guard in `computeSyncedLfoValue`.
- `osc-transport` shared socket race fix (require both socket + listeners init), heartbeat false-disconnect fix (only after first message, 5s threshold), `dispose()` no longer closes socket owned by sibling extensions.
- `mappings` `clearMappings` / `loadPreset` now clear `lastMappedValues`, `eventModesState`, `activeSmooths`, `hostModulators` (no stale state leak).
- Hot-path `console.log` removed (`udp-midi`, `mappings` `trigger_note`).
- Finite-number checks in `setTempo` / `setDeviceParam`, NaN / edge guards in `applyCurve` / `inverse`.
- WebSocket typed message handler returns push-update flag explicitly; JSON parse errors now logged instead of swallowed.
- `uninstallRuntimeSafety` called from `deactivate()` so listeners don't accumulate across hot-reloads.
- `listenOnPreferredOrRandom` re-arms listeners after fallback so a second `EADDRINUSE` doesn't crash silently.
- Cert / mappings helpers extracted (`stripWslDrivePrefix`, `sanitizeFilenameComponent`) — removed 3× regex duplication.
- `panel.showInfoDialog` re-exported from `util/helpers` (removed duplicate).

## MIDI Receiver Fix

- `unpack` → `midiformat` rewired via pack list in `RC-Midi-Receiver.amxd`.

## Tests

- **58/58 tests passing** (53 pre-existing + 5 new for LFO / stutter phase-from-time).
- New test file: `tests/lfo-high-rate-jitter.test.mjs` (continuous LFO values, regular stutter pulses, phase-lock across dropped ticks, deterministic phase-from-time, beat-locked synced LFO).
- New LFO / stutter host motor stress harness: 60s @ 5 Hz, concurrent LFO + stutter, CPU budget, live config change, endurance.
- `npm run ci` clean (tests + `tsc --noEmit` + `build:prod`).

## Install / Verify

1. Double-click `Ableton-RC-Surface-0.5.8.4.ablx` to install in Live.
2. Open Ableton RC Surface from the Extensions menu.
3. *(Optional)* Copy `RC-Midi-Receiver.amxd` into your Ableton **User Library** (`User Library / Presets / MIDI Effects / Max MIDI Effect /`).
4. *(Optional)* Install [AbletonOSC](https://github.com/ideoforms/AbletonOSC) to activate Deep Sync features.

Tester checklist: `docs/TESTER-GUIDE.md`.
