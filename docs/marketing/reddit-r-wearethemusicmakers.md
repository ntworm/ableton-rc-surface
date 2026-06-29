# Reddit r/WeAreTheMusicMakers — Post

> Rascunho. Adaptar antes de postar. Nunca postar antes do release
> oficial no GitHub.

## título

```
[Free Tool] I built a phone-as-MIDI-controller for Ableton Live — sensor-aware, browser-based, MIT, donations welcome
```

alternativas:

- `[Tool] Ableton RC Bridge — turn your phone into a MIDI controller with motion sensing (free, MIT)`
- `[Release] Free Ableton Live controller that uses your phone's gyroscope + camera as inputs`

## corpo

```markdown
Hey folks,

Sharing a tool I've been working on: **Ableton RC Bridge**.

It's a free, open-source Ableton Live extension (12.4.5+ Suite) that
turns your phone into a multi-touch, sensor-aware MIDI controller.
You install it, click "Show panel", scan a QR code with your phone,
and a web app opens — no install on the phone needed.

**What's in it**

- 12 performance pads (release / hold / toggle / burst modes)
- 8 knobs, 12 faders, 4 expression ribbons
- 2 physics XY pads
- Sensor panel: gyroscope, accelerometer, ambient light, audio
  (RMS + pitch + onset detection), camera hand-tracking
- 8 snapshots with a 2D morph pad
- 30 Hz, sub-50 ms latency
- Admin dashboard + performance client, simultaneously

**Why it's free**

The whole thing is MIT licensed. Free forever. If you like it,
donations are welcome but never required. There is no paid tier, no
telemetry, no tracking.

**Why browser instead of an app**

Existing native mobile controller apps are great, but they need a
paid app install on
the phone. With RC Bridge the phone just opens a URL — no friction,
faster updates, and you can use the phone's sensors (gyroscope,
accelerometer, camera, microphone) as first-class controller inputs,
not as a hack.

**Built for Live 12.4.5+ Suite specifically**

It uses the new Ableton Extensions SDK, which gives you MIDI-native
control over Live. No OSC bridge needed.

**What it doesn't do**

- Doesn't work with Live 11 or earlier (the Extensions SDK is new)
- Haptics only on Android (iOS Safari doesn't implement
  navigator.vibrate)
- Camera hand-tracking needs jsdelivr (offline bundle is on the
  roadmap)
- Not for sale, no premium tier

**Where to get it**

- Source + releases: https://github.com/worm/ableton-rc-bridge
- Pre-built `.ablx` from the Releases page
- Optional donation: https://worm.gumroad.com/l/ableton-rc-bridge

**Demo (60s)**: [YouTube link]

Happy to answer questions. PRs and bug reports welcome on GitHub.
```

## tom do WATMM

- comunidade amigável, foco em "fazer música"
- não técnico demais — comparar com a categoria se perguntado
- mencionar limitações abertamente

## cross-posts planejados

| subreddit | quando |
|---|---|
| r/WeAreTheMusicMakers | dia 2 (depois do r/ableton) |
| r/Beatmakers | dia 4 |
| r/Live_12 | dia 5 |
| r/audioengineering | dia 3 (versão técnica separada) |
| r/IndieMusicFeedback | NÃO — fórum pra feedback de música, não ferramenta |

## regras

- [ ] não violar regra "no self-promotion" sem disclosure
- [ ] disclosure clara: **"I made this"** no início do post
- [ ] não pedir upvotes
- [ ] responder todos em 24h

## comentários esperados

**"Cool, but native mobile controllers already exist"**
> Existing native mobile controller apps are great. This is a
> different approach — browser-based, sensor-aware, MIDI native. If
> you need cross-DAW or a touch-only controller, those are the more
> mature option. RC Bridge is for people who want the phone's sensors
> as first-class inputs.

**"Why not just use a native mobile controller?"**
> The most established native mobile controller was discontinued in
> 2024, and the developer's other products don't have the same scope.
> RC Bridge is open-source and MIT, so it won't get discontinued by a
> company changing direction.

**"Is this malware? Why does it need camera?"**
> The camera is opt-in and used only for MediaPipe hand-tracking
> (frame data stays in your browser tab, nothing is uploaded). The
> microphone is opt-in too, used for audio pitch/RMS/onset detection.
> If you don't enable those features, they're never requested. Source
> is open, you can audit it.

**"Will this work with FL Studio / Logic / Bitwig?"**
> Not without a different host. The Extensions SDK is Live-specific.
> The phone client could in theory be reused if someone writes a
> different host.

**"Do I need to know how to code to use it?"**
> No. Install the .ablx, click "Show panel", scan the QR. The phone
> opens a browser, you start playing. Coding is only needed if you
> want to customize the phone UI.

## métricas

- upvotes: 100+ em 24h
- comments: 20+
- link clicks pro GitHub: 50+