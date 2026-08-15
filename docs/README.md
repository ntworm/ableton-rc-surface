# Ableton RC Surface Docs

This folder contains the current public documentation. Obsolete release notes,
retired plans and internal workflow material are intentionally excluded.

## Canonical Docs

Read these first:

- `docs/USER-GUIDE.md` - how to operate the phone controller (every mode, gesture, mobile MAP workflow, and surface).
- `CONTRIBUTING.md` - source tree, tests, and contribution gates.
- `docs/INSTALL.md` - install, phone connection, certificates, troubleshooting.
- `docs/FAQ.md` - user-facing answers.
- `docs/CUSTOMIZATION.md` - how to change controls, sensors, mappings, UI.
- `docs/TESTER-GUIDE.md` - manual validation checklist for release candidates.
- `docs/PRIVACY.md` - data flow and third-party runtime notes.
- `docs/SECURITY.md` - threat model and certificate policy.
- `docs/PESQUISA_CELULAR_GESTUAL.md` - evidence and roadmap for expressive gestural control.
- `CHANGELOG.md` - consolidated release notes.

Do not casually rewrite canonical docs. Update them only when behavior, workflow, or architecture changes.

## Current Architecture Snapshot

- Backend entry: `src/extension.ts`, thin bootstrap only.
- Backend owners: `src/server/`, `src/live/`, `src/util/`, `src/ui/`, `src/runtime/`, `src/context.ts`.
- Phone app: `static/phone-v3/`, plain browser JS, no bundler.
- Mobile mapping: `static/phone-v3/mapping-mode.js`, using the same
  backend commands as the panel/admin mapping tools.
- Panel app: `static/panel/`, plain browser JS, no bundler.
- Admin app: `static/admin/`, plain browser JS.
- Tests: `static/**/*.test.mjs`, `scripts/*.test.mjs`, and `tests/*.test.mjs`.

## Current Sensor Names

Canonical control namespaces:

- `pad-1` through `pad-12`
- `knob-1` through `knob-6`
- `fader-1` through `fader-6`
- `xy-1.x`, `xy-1.y`, `xy-2.x`, `xy-2.y`
- `toggle-1` through `toggle-4`
- `button-1` through `button-4`
- `sensor.motion.*`
- `sensor.orient.*`
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
- `sensor.vision.*`

Vision is single-hand by design. Do not reintroduce left/right or two-hand control names unless the user explicitly asks for a new feature and tests cover the migration.
