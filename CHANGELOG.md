# Changelog

Ableton RC Surface uses a consolidated release history. The complete source
state is represented by the current release; obsolete preview packages and
intermediate release records are intentionally not published.

## [0.6.0] — 2026-08-14

### Added

- Phone performance surface with pads, XY controls, knobs, faders, snapshots,
  transport, mix controls, audio analysis, motion sensors and single-hand vision.
- Mapping from phone controls to Ableton Live parameters, mixer targets and MIDI
  trigger notes, including curves, ranges, smoothing, pickup and scale takeover.
- Per-set `.rcsurface` profiles, mapping presets and project import/export.
- Multi-phone shared-surface sessions, controller/admin authorization and
  bounded WebSocket traffic.
- AbletonOSC transport/deep-sync support and the bundled Max for Live MIDI
  receiver.

### Improved

- Safe-input handling for unstable, lost and recovering continuous controls.
- Atomic mapping/profile persistence with rollback when either write fails.
- Serialized mapping mutations and coalesced high-frequency writes.
- Responsive phone navigation, Stage Mode, MAP Mode and Vision layouts.
- Documentation for installation, customization, key mapping, MIDI mapping,
  navigation, privacy, security and hardware testing.

### Fixed

- Failed project imports preserve both mappings and safe-input diagnostics.
- Parallel server tests use isolated port pairs and no longer collide.
- Package, manifest and lockfile versions are aligned at `0.6.0`.
- Dependency audit reports no known vulnerabilities at release time.

### Release hygiene

- Published history is consolidated into one source milestone.
- Obsolete `.ablx` candidates, internal workflow notes and superseded release
  documents are excluded from the public repository.
- The distributable is `Ableton-RC-Surface-0.6.0.ablx`.
