# KVR Forum — Post

> Rascunho. Adaptar antes de postar no KVR. Nunca postar antes do
> release oficial.

## categoria

- **M4L/Ableton Extensions** (categoria específica, mais visível)
- ou **New Product** (geral)

## título

```
Ableton RC Bridge — free, open-source phone-as-MIDI-controller for Live 12.4.5+
```

alternativas:

- `Ableton RC Bridge v0.4.17 — browser-based sensor-aware MIDI controller (MIT)`
- `Free phone controller for Live 12.4.5+ — sensor fusion + admin dashboard`

## corpo

```markdown
Hi all,

I've been developing an open-source MIDI controller for Ableton Live
12.4.5 Suite and it's now ready for general use. Sharing it here in
case it's useful to anyone.

**Overview**

Ableton RC Bridge is a Live extension that turns your phone into a
multi-touch, sensor-aware MIDI controller. The phone opens a web app
(no install required) and communicates with Live over a WebSocket.

**Features**

- 12 performance pads with 4 modes (release, hold, toggle, burst)
- 8 knobs, 12 faders, 4 expression ribbons
- 2 physics XY pads
- Sensor panel: gyroscope, accelerometer, ambient light, audio
  (RMS, pitch, onset/BPM), camera hand-tracking, ambient color
- 8 snapshots with 2D morph
- Two simultaneous clients (performance + admin dashboard)
- 30 Hz update rate, end-to-end sub-50 ms latency
- Per-install HTTPS certificate (so camera and microphone work
  on the phone browser)

**Requirements**

- Ableton Live 12.4.5 or newer, Suite edition (Extensions SDK enabled)
- A phone on the same network: Android 10+ or iOS 15.4+
- Modern browser: Chrome/Edge/Brave on Android, Safari on iOS

**What's NOT in this release**

- Live 11 or earlier (the Extensions SDK is new in 12.4.5)
- OSC support (this is MIDI native, no OSC bridge needed)
- M4L device wrapper (it's a separate SDK)
- Cloud sync (everything stays on your LAN)

**License and pricing**

MIT licensed. Free to use, modify, redistribute. Donations are
welcome but never required — there's no paid tier and no telemetry.

**Where to get it**

- Source + releases: https://github.com/worm/ableton-rc-bridge
- Pre-built `.ablx` from the GitHub Releases page
- Optional donation: https://worm.gumroad.com/l/ableton-rc-bridge

**Demo**

[YouTube link — 60s]

**Feedback**

Bug reports, feature requests, and PRs are all welcome on GitHub.
The Extensions SDK is in beta so there are rough edges — happy to
iterate.

A few things on the near-term roadmap:
- WebRTC multi-phone jam mode (v0.5)
- Offline MediaPipe bundle, no jsdelivr dep (v0.5)
- MIDI track and clip creation from the phone (v0.4.x)

Thanks for reading.
```

## tom do KVR

KVR é um forum mais velho, com developer culture forte. Tom deve ser:

- respeitoso, sem hype
- foco em "what it does" antes de "why it's cool"
- mencionar limitações abertamente
- comparar honestamente com a categoria "native mobile controllers" se
  perguntado (mas não começar)

## regras do KVR

- [ ] **não** postar em categoria errada (M4L/Ableton é o lugar)
- [ ] **não** flood — 1 post, esperar
- [ ] **responder** todos em 48h
- [ ] **não** atualizar o post original com bump vazio (mods não gostam)
- [ ] se moderadores moverem, seguir

## perguntas prováveis (preparar respostas)

**"How is this different from existing native mobile controllers?"**
> Different stack and different scope. Existing mobile controllers are
> native apps with OSC support across many DAWs. RC Bridge is
> browser-based, MIDI native, Ableton-only via the new Extensions SDK,
> and treats the phone's sensors (gyro, accel, audio, camera) as
> first-class inputs. Existing tools have their own strengths — if you
> need cross-DAW or a touch-only controller, they are the more mature
> option.

**"Why not a M4L device instead of an Extension?"**
> M4L devices run inside Live's audio graph, which is great for audio
> processing but not ideal for running a WebSocket server with
> per-install HTTPS certs. The Extensions SDK is a better fit for
> the network and cert lifecycle parts.

**"Can I make my own custom controller UI?"**
> Yes — the phone client lives in `static/phone-v3/` and is plain
> JavaScript. You can fork it and rewrite the UI. The WebSocket
> protocol is documented in `docs/SECURITY.md` and `src/server/ws.ts`.

**"What's the latency like in practice?"**
> Sub-50ms end-to-end on a typical home Wi-Fi. I've tested up to
> ~80ms on a crowded 2.4GHz network. For controller gestures this
> is well below human perception thresholds (~10-20ms for tight
> musical timing is the gold standard, but 50ms is fine for CC
> and continuous controls).

**"Will you support other DAWs?"**
> Not me, but the phone client could in theory be reused. The
> extension side is Live-specific because of the Extensions SDK.
> If someone wants to write a Bitwig/Logic/Reaper host, they could
> reuse `static/phone-v3/`.

## timing

- melhor dia: terça ou quarta
- hora: qualquer (KVR é menos sensível a timezone que Reddit)
- acompanhar thread por 7 dias

## follow-up (depois de 14 dias)

se tiver tração (>10 replies, >50 views da post), criar update:

```
[UPDATE — 2 weeks in]

- v0.4.18 released with [list of bugfixes from feedback]
- Now supports [feature X from KVR feedback]
- 3 community contributors onboarded

Thanks for the feedback. Still tracking the v0.5 roadmap.
```