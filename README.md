# Ableton RC Surface

[![PolyForm Noncommercial](https://img.shields.io/badge/license-PolyForm--Noncommercial-blue.svg)](LICENSE)
[![v0.5.8.4](https://img.shields.io/badge/version-0.5.8.4-blue.svg)](https://github.com/ntworm/ableton-rc-surface/releases/tag/v0.5.8.4)
[![CI](https://github.com/ntworm/ableton-rc-surface/actions/workflows/ci.yml/badge.svg)](https://github.com/ntworm/ableton-rc-surface/actions/workflows/ci.yml)
[![stars](https://img.shields.io/github/stars/ntworm/ableton-rc-surface?style=social)](https://github.com/ntworm/ableton-rc-surface/stargazers)

[**:globe_with_meridians: Live landing page**](https://ntworm.github.io/ableton-rc-surface/) — visual overview, install walkthrough, and feature showcase in your browser.

Ableton RC Surface is a source-available Ableton Live extension that turns a phone browser into a performance, mix, mapping, and sensor controller.

> [!WARNING]
> **Security Notice**: This extension runs a WebSocket server on your local network. Anyone on the same Wi-Fi can connect and send commands to Ableton Live. Use only on trusted networks. See [SECURITY.md](docs/SECURITY.md) for the threat model.

Written by a human. Auditable line by line. Free for noncommercial use.

The host side is built on the Ableton Extensions SDK. The phone side is plain browser JavaScript: no native app, no bundler, no install on the phone.

## Highlights

- 12 performance pads with modes A/B/C/D.
- Two physics XY pads.
- Knobs, faders, toggles, LFO, stutter, and performance utility controls.
- Phone sensors: motion, orientation, audio, and optional camera hand tracking
  via MediaPipe CDN.
- Single-hand vision tracking by design.
- Phone **MAP** mode for binding controls to Live parameters without leaving
  the mobile interface.
- Mobile trigger-note mappings for sending MIDI notes to a selected MIDI track
  through the included Max for Live receiver.
- Panel UI with a local QR code, live controls, CPU telemetry, and mapping editor.
- Built-in phone **MIX** tab with six mappable knobs and six mappable faders.
- Bidirectional HTTPS/WSS transport on the local network.
- Modular TypeScript backend with `src/extension.ts` as bootstrap only.

## AbletonOSC Integration (Transport Lite & Deep Sync)

Ableton RC Surface includes built-in optional integration with **AbletonOSC** to enable advanced transport and beat synchronization directly from the mobile client:

- **Transport Lite**: Tap the `TRN` button in the header topbar to open a full-screen transport overlay. Control Play, Stop, Prev/Next locator, and trigger locator jumps. Includes a search input to filter locators list dynamically.
- **Visual Metronome**: The `TRN` button rhythmically flashes in sync with Ableton Live's playback beat (Beat 1 flashes green, other beats flash blue).
- **Deep Sync Settings**: Tap the gear icon (`⚙`) next to `SYNC` (or long-press `SYNC`) to open the Deep Sync Settings panel. Select Clock Source (AbletonOSC, SDK BPM Simulator, or Free/Internal), and configure subdivisions, phase offsets, swing, and shapes for LFOs and Stutters. Settings are persisted in local storage.
- **Selected Target Picker Helper**: Tap `Selected in Live` in the mobile parameter mapping view to automatically query the selected track and device from the host and pre-populate the search filter.

To use the AbletonOSC features, ensure the **AbletonOSC** extension is running in Ableton Live (outgoing port `11000`, incoming port `11001`). The extension automatically detects its presence and updates the status (`SYNCED` / `SDK` / `FREE`).

## Quick Start

1. Install Ableton Live 12.4.5+ Suite (Beta) with Extensions SDK support.
2. Download or build `Ableton-RC-Surface-0.5.8.4.ablx`.
3. Install the `.ablx` in Live.
4. Open Ableton RC Surface from the Extensions menu.
5. Scan the Performance QR code with the phone.
6. Accept the self-signed certificate warning once.
7. Use the phone controller to perform. The built-in **MIX** tab inside
   the phone client handles the six knob and six fader controls.
8. Tap **MAP** near the BPM display to bind phone controls to Live parameters
   or trigger MIDI notes from pads, LFOs, Stutters, XY axes, knobs, and faders.

Detailed setup lives in `docs/INSTALL.md`.

## Documentation

- `docs/README.md` - canonical docs index and archive map.
- `docs/USER-GUIDE.md` - how to use the phone controller (modes, gestures, mobile mapping, snapshots, calibration, Stage mode).
- `docs/AGENT_GUIDE.md` - rules for AI agents and maintainers.
- `docs/INSTALL.md` - install, certificates, phone connection, troubleshooting.
- `docs/CUSTOMIZATION.md` - controls, sensors, mappings, audio, vision, UI extension points.
- `docs/FAQ.md` - common user questions.
- `docs/PRIVACY.md` - local data flow.
- `docs/SECURITY.md` - threat model and certificate policy.
- `docs/TESTER-GUIDE.md` - tester checklist, bug-report template, install flow.
- `CONTRIBUTING.md` - development workflow and source map.

## Architecture

Backend:

```text
src/
  extension.ts          bootstrap: activate/deactivate
  context.ts            SDK context access
  runtime/safety.ts     runtime exception handlers
  ui/panel.ts           Ableton panel dialogs
  util/                 helpers and CPU sampling
  server/               HTTP, HTTPS, WebSocket, certs, client ids
  live/                 mappings, commands, Live state
```

Static clients:

```text
static/
  phone-v3/             phone performance client
  panel/                Ableton panel UI
  admin/                admin dashboard
```

Tests:

```text
static/**/*.test.mjs
scripts/*.test.mjs
tests/*.test.mjs
```

## Development

Requirements:

- Node.js 24.13.1 or newer.
- Ableton Live 12.4.5+ Suite (Beta) with Extensions SDK support.

Commands:

```powershell
npm install
npm test
npx tsc --noEmit
npm run build
npm run ci
npm run package
```

Hot reload:

- `static/**` changes: refresh the panel or phone browser.
- `src/**` changes: rebuild, then disable/enable the extension in Ableton Live.
- `npm run watch` can sync builds into Ableton AppData during development.

## Current Control Names

Common groups:

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

Vision is single-hand. Do not add left/right hand control names without an explicit migration plan.

## Security

Phone camera and microphone require HTTPS. The extension generates a per-install self-signed certificate and includes current LAN IPs in the certificate SAN list.

Traffic stays on the local network unless the user sets up a tunnel. Run
the bridge only on a trusted LAN: any browser client that can reach the
bridge URL can connect to its WebSocket surface and send supported control
commands.

Private keys are not bundled in `.ablx` packages.

Core controls run on the local network. Camera hand tracking is the one
internet-facing runtime dependency: the phone browser loads MediaPipe Hands
files from `cdn.jsdelivr.net` unless they are already cached. Raw camera
frames are processed in the phone browser and are not sent by this project.

## Release Validation

Automated tests, typecheck, production build, `.ablx` packaging, and tester
kit packaging are covered by repository scripts. Final publication still
requires manual validation in Ableton Live and on real iOS/Android devices;
see `docs/TESTER-GUIDE.md`.

## Roadmap

Potential future work:

- Export/import mapping bundles.
- Offline MediaPipe bundle.
- ESLint flat-config migration.

## License

PolyForm Noncommercial 1.0.0 — free for noncommercial use, redistribution,
and modification; commercial sale of this software or modified versions is
not permitted. See [LICENSE](LICENSE) for the full text and Required Notice.
© Gabriel Worm · <https://github.com/ntworm/ableton-rc-surface>.
