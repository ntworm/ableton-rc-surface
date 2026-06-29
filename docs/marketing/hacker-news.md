# Hacker News — Show HN Post

> Rascunho. Adaptar antes de postar. Nunca postar antes do release
> oficial no GitHub. HN exige URL pública do projeto.

## título

```
Show HN: Ableton RC Bridge – phone-as-MIDI-controller, browser-based, sensor-aware
```

alternativas:

- `Show HN: Ableton RC Bridge – browser-based MIDI controller with sensor fusion`
- `Show HN: A free, open-source MIDI controller that runs in your phone's browser`

## corpo

```markdown
Hi HN,

I built a free, open-source Ableton Live extension that turns a
phone into a motion-sensing MIDI controller. Install the .ablx,
scan a QR code from the Live panel, and the phone opens a web app
that maps touch, motion, and audio to MIDI.

A few things that took effort:

**1. Per-install self-signed HTTPS cert.**

The phone client uses `getUserMedia` for camera and microphone
(hand-tracking + audio analysis). Browsers require a Secure Context,
which on a phone means HTTPS. But shipping a shared private key
inside an .ablx is a bad idea — anyone could MITM any user.

So the extension generates a **unique self-signed cert on first
launch** using the `selfsigned` npm package. The cert is stored
under Ableton's `storageDirectory/certs/` and reused on every
subsequent launch. Private keys never enter the published package.

**2. WebSocket at 30 Hz with sub-50 ms latency.**

The phone client is plain ES5/ES6 — no bundler, no framework — so
the cold-start path is short. The extension runs an HTTP + WS server
bound to `0.0.0.0` on a random free port. No OSC bridge required,
because the new Ableton Extensions SDK talks MIDI natively.

**3. Sensor fusion in the browser.**

On the phone (in the tab, nothing leaves the device):

- Gyroscope + accelerometer → Madgwick fusion → quaternions
- Audio: YIN pitch detection, RMS envelope, onset detection via
  AudioWorklet
- Camera: MediaPipe Hands runtime (loaded from jsdelivr, offline
  bundle is on the roadmap)

All sensor data is consumed locally and forwarded to Live as control
values.

**Why browser, not a native app?**

Two reasons:
1. Friction — install the `.ablx`, scan QR, done. No App Store,
   no per-platform builds, no per-version updates.
2. Updates — I can ship new sensor features without an app review
   cycle.

The trade-off: no haptics on iOS Safari (no `navigator.vibrate`).
Android gets full haptics.

**Why MIDI and not OSC?**

The Extensions SDK gives you Live's control surface directly.
OSC would need a bridge patch (LiveOSC2 etc.). MIDI native is the
simpler integration.

**Stack**

- TypeScript + esbuild on the extension side (~3500 lines in
  `src/extension.ts`, being refactored into modules)
- Plain ES5/ES6 on the phone, no bundler (~6500 lines total)
- `ws` + `selfsigned` as runtime deps
- Built on Ableton Extensions SDK 1.0.0-beta

**License**

MIT. Free forever. Donations via Gumroad are welcome but never
required. No telemetry, no analytics.

**Repo**

https://github.com/worm/ableton-rc-bridge

Happy to answer questions about the Extensions SDK, the cert
design, or anything else.
```

## regras do HN

- [ ] **postar só com URL pública** do repo (GitHub)
- [ ] **não** mencionar concorrentes negativativamente
- [ ] **responder** todos os comentários (HN penaliza falta de resposta)
- [ ] **não** fazer upvote em alternativas suas
- [ ] **não** usar linguagem marketing ("revolutionary", "game-changing")
- [ ] **tom técnico e honesto**, HN gosta disso

## comentários esperados (preparar respostas)

**"Why not WebMIDI?"**
> WebMIDI is great but only gives you MIDI messages. I need a custom
> protocol for snapshots, sensor config, admin operations, and
> bidirectional Live state. WebSocket + a JSON-ish protocol is the
> simpler choice for this scope. WebMIDI would be a great addition
> for a different use case (multi-DAW).

**"How do you handle cert expiry?"**
> ~365 days. After that the phone shows the cert warning again. The
> user re-accepts, and the cert is regenerated only if the storage
> directory is wiped. For a studio tool this is fine; I'd think
> about it more for a long-running deployment.

**"What's the attack surface?"**
> The WebSocket server binds to `0.0.0.0:<random port>` and has no
> authentication. The threat model is "trusted local network". If
> you need remote access, tunnel through Tailscale or Cloudflare
> Tunnel with an Access policy — never expose the port directly. This
> is documented in the repo's SECURITY.md.

**"Why no OSC support?"**
> The Extensions SDK gives me direct control over Live's surface,
> including MIDI routing. OSC would add a bridge and lose some of
> that. If someone wants OSC, they could write a small bridge on
> top of this — the WebSocket protocol is documented.

**"Can this work with other DAWs?"**
> Not without a different host. The extension is Live-specific
> because of the Extensions SDK. The phone client could be reused
> for a different host, but you'd need to implement the server
> side for that DAW.

**"Self-signed certs are bad UX"**
> Agreed for general-purpose use. For a studio tool with a QR code
> for pairing, the warning is acceptable and the user has to opt in
> once. If you need public trust, tunnel with a real cert on the
> tunnel endpoint.

## timing

HN é menos sensível a timing, mas terça/quarta 13-16h ET costuma
ter mais atividade técnica.

## métricas

- upvotes: 50+ em 24h = tração boa
- comments: 20+ = engajamento real
- top 5 do dia = viral (improvável mas possível)

se < 10 upvotes em 24h, não deletar — HN tem tráfego demorado. às
vezes posts sobem pro top em 2-3 dias.