# Ableton RC Bridge

A free, open-source Ableton Live extension that turns any phone into an
expressive, multi-touch, motion-sensing performance instrument. Use it
like a MIDI controller — but the controller is a phone in your hand or on
your body, with the screen, gyroscope, accelerometer, camera, and
vibration motor all available as first-class inputs.

Built on the official
[Ableton Extensions SDK](https://github.com/ableton/ableton-extensions-sdk)
(1.0.0-beta). The phone side is a plain web app — no install, no
permissions to grant on the host, just open the URL it gives you and
start playing.

## Highlights

- **12 performance pads** with four modes (release / hold / toggle / burst)
- **Two physics XY pads** for continuous two-axis control
- **8 knobs, 12 faders (8 + 4 bipolar), 4 expression ribbons**
- **Live sensor panel** on the phone: motion, orientation, ambient light,
  audio RMS + pitch + onset/BPM, camera hand-tracking + ambient color
- **Snapshots** with 8 morph slots and a 2D vector morph pad
- **Bidirectional WebSocket**, 30 Hz snapshots, end-to-end sub-50 ms latency
- **HTTPS with on-the-fly per-install self-signed certificates** — no
  shared private keys between users, no developer paths baked in
- **Two clients supported out of the box** (the phone you control with,
  and the admin dashboard you monitor from)
- **Modular TypeScript backend** — bootstrap in `src/extension.ts`
  (~132 lines) wires dedicated modules in `src/server`, `src/live`,
  `src/util`, `src/ui`, and `src/runtime`

## Quick start

1. Install **Ableton Live 12** (or newer) with the Extensions SDK host
   enabled.
2. Download `Ableton-RC-Bridge-0.5.0.ablx` from the Releases page.
3. Double-click the file — Live will offer to install it under
   `User Library / Extensions`. Click *Install*.
4. In Live, find **Ableton RC Bridge** in the Extensions menu and click
   *Show panel*. **Two QR codes** are shown side by side: "Performance"
   (the existing pads/knobs/sensors controller) and "Mix" (v0.3.1+,
   the structure-aware mobile mixer).
5. Scan the Performance QR with your phone for the controller view, or
   the Mix QR for the structure-aware mixer. Both clients can be open
   at the same time, on the same or different phones. The phone's
   browser will warn that the certificate is not trusted — accept the
   warning once and you're in.

Detailed installation instructions for Windows and macOS, plus
troubleshooting for the certificate warning and LAN connectivity, are in
[`docs/INSTALL.md`](docs/INSTALL.md).

## Documentation

- [Install guide](docs/INSTALL.md) — first-time setup, OS-specific notes,
  LAN and remote access
- [Performance inputs research](docs/research/performance-inputs.md) —
  the v0.3 sensor and haptics roadmap

## Architecture

```
┌─────────────────────────┐         ┌──────────────────────────┐
│  Ableton Live           │         │  Phone (any browser)     │
│  ┌────────────────────┐ │  HTTPS   │  ┌─────────────────────┐ │
│  │ Ableton-RC-Bridge  │◀┼─────────┼▶│  phone-v3 (web app)  │ │
│  │  + ws + http       │ │  + WSS   │  │  touch / sensor /   │ │
│  │  + command handler │ │          │  │  audio / camera     │ │
│  └────────────────────┘ │          │  └─────────────────────┘ │
│  + admin dashboard  ────┼─ HTTPS   │                          │
│  (also on 0.0.0.0:port) │ + WSS    │                          │
└─────────────────────────┘         └──────────────────────────┘
```

The extension runs an HTTP+WebSocket server on a random free port,
binding `0.0.0.0` so any device on the same LAN can reach it. A
short-lived QR code in the panel encodes the URL.

The phone side is plain ES5/ES6 JavaScript — no bundler, no framework.
The admin dashboard (`/static/admin/`) is similar: a single HTML file
with a single JS file, no build step.

The backend (server, websocket protocol, mix protocol, mapping engine,
snapshot loop, panel dialog, runtime safety) lives in dedicated modules
under `src/server/`, `src/live/`, `src/util/`, `src/ui/`, and
`src/runtime/`. `src/extension.ts` is the entrypoint — a bootstrap that
calls into each module owner from `activate()` and reverses the calls
from `deactivate()`. See the
[Code structure](CONTRIBUTING.md#code-structure) section of
CONTRIBUTING.md for the full module map.

## Security and HTTPS

Camera (MediaPipe) and microphone access require a Secure Context, which
on a phone means HTTPS. To avoid shipping a shared private key inside
the `.ablx`, this extension generates a **unique self-signed
certificate per install** the first time it runs. The cert is stored
in Ableton's persistent storage directory under `certs/` and reused on
every subsequent launch.

- Private keys are **never** bundled with the published `.ablx`
  (the `package` script intentionally omits the `.certs/` folder).
- The cert is regenerated if the storage directory is wiped.
- On a phone, the browser will show "Your connection is not private"
  the first time — this is expected for self-signed certs. Accept it
  once; the browser will remember your decision until the cert expires
  (~365 days).

If you need a publicly-trusted connection (e.g. for remote use outside
your LAN), see the [Tunneling section](docs/INSTALL.md#tunneling-optional)
of the install guide.

## Browser and device requirements

The phone side is tested on:

- Chrome / Edge / Brave on Android 10+
- Safari on iOS 15.4+ (camera/mic permission API quirks apply)

The following features are **only available on Android**:

- `navigator.vibrate` (haptics) — iOS Safari does not implement it
- Wake Lock on background tabs

The following work everywhere:

- Multi-touch, accelerometer, gyroscope, orientation
- Microphone pitch / RMS / onset detection
- Camera hand-tracking via MediaPipe (requires the phone to be able to
  reach `cdn.jsdelivr.net` for the MediaPipe runtime; bundle to ship
  offline is on the roadmap)

## Building from source

Prerequisites: Node.js 24.14.1 or newer.

```bash
git clone <this-repo>
cd ableton-rc-bridge
npm install
npm run build      # tsc check + esbuild bundle to dist/
npm test           # node:test suite (test:static + test:src)
npm run package    # produces Ableton-RC-Bridge-0.5.0.ablx
```

The package script calls `extensions-cli package` (see
`vendor/ableton-extensions-cli-1.0.0-beta.0.tgz`) with `-i dist/static`
as the only include — no certs, no dev files. By default `build.ts`
does not copy built files into Ableton's persistent storage directory;
set `ABLETON_RC_DEV_SYNC=1` to opt in to the old auto-sync behaviour.

## Project layout

```
ableton-rc-bridge/
├── manifest.json               # Extensions SDK manifest (entry: dist/extension.js)
├── package.json                # build / test / package scripts
├── build.ts                    # esbuild config + static/ copier (opt-in
│                               #   AppData sync via ABLETON_RC_DEV_SYNC=1)
├── src/
│   └── extension.ts            # bootstrap (~132 lines); wires the modules
│                               #   listed in CONTRIBUTING.md
│   └── server/                 # state / cert / http / ws / mix-protocol / client-id
│   └── live/                   # state / mappings / snapshots
│   └── util/                   # cpu / helpers
│   └── ui/                     # panel
│   └── runtime/                # safety
│   └── context.ts              # SDK context global
├── static/
│   ├── phone-v3/               # phone client (HTML/JS/CSS, no build)
│   │   ├── index.html
│   │   ├── app.js              # 30Hz snapshot loop, sensors, lifecycle
│   │   ├── controls.js         # touch controls (pads, knobs, faders, XY, ribbons)
│   │   ├── mode-engine.js      # pad modes A/B/C/D
│   │   ├── audio-processor.js  # YIN pitch, RMS envelope, onset detection
│   │   ├── vision-processor.js # MediaPipe Hands wrapper
│   │   └── vendor/madgwick.js  # IMU sensor fusion
│   └── admin/                  # admin dashboard (clients, sensors, mappings)
├── docs/
│   ├── INSTALL.md
│   └── research/performance-inputs.md
└── vendor/
    ├── ableton-extensions-sdk-1.0.0-beta.0.tgz
    └── ableton-extensions-cli-1.0.0-beta.0.tgz
```

## Roadmap

Shipped in 0.5.0:

- Modular TypeScript backend (`src/extension.ts` now a ~132-line bootstrap)
- Real `deactivate()` lifecycle
- AppData sync opt-in via `ABLETON_RC_DEV_SYNC=1`
- `npm test` aggregator over `test:static` + `test:src` (Node 24+ harness)

Next:

- ESLint flat-config migration (currently diagnostic)
- v0.6: peer-to-peer multi-phone jam mode (WebRTC)
- v0.6: offline MediaPipe bundle (no jsdelivr dependency)

## Contributing

Issues and pull requests are welcome. Before sending a PR, please run:

```bash
npm run build
npm test
npx tsc --noEmit
```

See [CONTRIBUTING.md](CONTRIBUTING.md) for the full code structure map
and developer workflow.

## Acknowledgments

- The [Ableton Extensions SDK](https://github.com/ableton/ableton-extensions-sdk)
  team for the platform.
- The [MediaPipe](https://mediapipe.dev/) team for the hand-tracking
  runtime.
- The wider Ableton community, for years of controller-tinkering lore
  that shaped this project.
