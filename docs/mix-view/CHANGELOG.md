# Changelog — Mix View

All notable changes to the Mix View, newest first. Versions refer
to the Ableton RC Bridge release that contains the change; the
Mix View is part of the bundled extension, not a separate
package.

## v0.3.1.1 — hotfix (2026-06-12)

User-reported bugs after testing the v0.3.1 release.

### Fixed
- **Flicker in the expanded-track device list.** The params
  tick populated the per-device cache, but `onParams` only
  re-rendered when the active view was the device detail.
  The mixer tick (5 Hz) re-rendered the track view and
  showed the now-populated list; the next params tick
  re-rendered the same list. The visible effect was the
  device list appearing and disappearing in sync with the
  mixer tick. `onParams` now re-renders whenever the active
  view is `device` or `track` and the snapshot's trackId
  matches `state.selection.trackId`.
- **Stale param values on the phone.** `mixParamsTick` was
  rotating through a 64-param slice every tick. On a
  device with 80 params, the first 64 were sent on ticks
  N, N+2, N+4... and the second 64 on ticks N+1, N+3...
  so a change to param 0 was only reflected every 2
  ticks, and simultaneous changes to params 0..63 were
  invisible until the rotation wrapped. `readSelectedParams`
  now reads every param (up to `MIX_MAX_PARAMS_PER_CLIENT`
  = 256) on every tick. The `PARAMS_ROTATION` Map and the
  rotation cursor are removed. The per-client delta-diff
  key (`c.lastMixParamsKey`) prevents duplicate work: an
  unchanged 256-param snapshot is skipped at the wire level.

### Changed
- `MIX_MAX_PARAMS_PER_TICK` renamed to `MIX_MAX_PARAMS_PER_CLIENT`
  to reflect the new "all params per client" semantics.

## v0.3.1 — initial release (2026-06-12)

First public release of the Mix View. Adds a second, optional
web client that reads the structure of the open Live set
(tracks, devices, parameters, sends) and renders a mobile-
first mixing UI. No mapping required: scan the Mix QR, mix
from the phone. Lives at `/mix/` next to the performance
client at `/`.

### Highlights
- **Dual QR code** in the Live panel: "Performance" (the
  existing pads/knobs/sensors controller) and "Mix" (the
  new structure-aware mobile mixer). Both share origin,
  port, and HTTPS certificate.
- **Tiered server-side snapshot loop** (structure 0.5 Hz,
  mixer 5 Hz, params 2 Hz) that READS the Live song
  self-gated on the number of mix clients connected.
- **Per-target serialised write queue** for the six
  command types (setVolume, setPan, toggleMute, toggleSolo,
  setSend, setParam). Two concurrent commands that target
  the same SDK handle cannot interleave their `setValue()`
  calls.
- **Generic device template** that renders any parameter
  whose descriptor exposes `name`, `min`, `max`,
  `defaultValue`, `isQuantized`, `valueItems`, `getValue`,
  and `setValue`. Continuous / enum / toggle / disabled
  branches are picked on the client.
- **Stable ID scheme** (mix:track:N, mix:return:N, mix:main,
  plus :dev:N and :par:N and :send:N) for the lifetime of
  a Live session. Server resolves IDs back to handles on
  the fly; a stale ID returns `mix.error reason="not_found"`.

### Compatibility
- v0.3.0 behaviour (phone WS on `/ws`, admin WS on
  `/admin/ws`, performance PWA at `/static/phone-v3/`,
  admin dashboard at `/static/admin/`) is byte-for-byte
  unchanged. v0.3.1 is a strict superset on disk and on
  the wire; downgrade is not supported.

### Limitations (acknowledged)
- VST/AU parameter discovery beyond what the SDK exposes
  under the documented fields; Generic template degrades
  gracefully.
- No per-target per-QR auth tokens. The Mix View uses the
  same open model as the v0.3.0 performance and admin
  WebSockets. A follow-up spec will add token binding.
- No specialised templates per device. The Generic
  template with smart control selection (knob / fader /
  stepper / toggle / static) covers the common case; the
  user can extend the template registry in v0.3.2+ once
  the device-class detection research is complete.
