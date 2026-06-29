# Reddit r/ableton — Show & Tell Post

> Rascunho. Adaptar antes de postar. Nunca postar antes do freeze do
> código e do release oficial no GitHub.

## título

```
[Show & Tell] Ableton RC Bridge — turn your phone into a sensor-aware MIDI controller (free, MIT)
```

alternativas:

- `[Release] Ableton RC Bridge v0.4.17 — phone as a MIDI controller, browser-based, sensor-aware`
- `[Free] I built a phone-as-MIDI-controller for Live 12.4.5+ — sensor fusion, MIT, donations welcome`

## corpo

```markdown
Hey r/ableton,

I've been building this for a few months and it's finally ready to share.

**What it does**

Ableton RC Bridge is a free, open-source Live 12.4.5+ extension that turns
your phone into an expressive, multi-touch, motion-sensing MIDI controller.
You install the .ablx, click "Show panel", scan the QR code, and your
phone opens a web app with:

- **12 performance pads** with 4 modes (release / hold / toggle / burst)
- **8 knobs, 12 faders, 4 expression ribbons**
- **2 physics XY pads** for continuous two-axis control
- **Sensor panel**: gyroscope, accelerometer, ambient light, audio
  RMS+pitch+onset detection, camera hand-tracking (MediaPipe), ambient
  color
- **8 snapshots** with a 2D vector morph pad
- **30 Hz bidirectional WebSocket**, sub-50ms latency end-to-end
- **Two simultaneous clients** (performance + admin dashboard)

**Why I built it**

existing native controller apps cost $9.99-14.99 and require installing
an app. The most established native controller was discontinued in 2024. I wanted something open, browser-based, and able
to use the phone's sensors as first-class inputs — not as a hack.

**Tech highlights**

- Built on the official Ableton Extensions SDK (1.0.0-beta)
- HTTPS with per-install self-signed certificate (so camera/mic work
  without shared private keys)
- Plain ES5/ES6 on the phone, no bundler, no framework
- MIT licensed

**It's free, donations welcome**

- Source + releases: https://github.com/worm/ableton-rc-bridge
- Donations: https://worm.gumroad.com/l/ableton-rc-bridge

**Demo (60s)**: [YouTube link]

**Requirements**

- Ableton Live 12.4.5 or newer (Suite edition, Extensions SDK enabled)
- Phone on the same Wi-Fi: Android 10+ or iOS 15.4+
- Browser: Chrome / Edge / Brave on Android, Safari on iOS

Would love feedback, bug reports, feature requests. The Extensions SDK
is in beta so expect rough edges — happy to iterate and report upstream.
```

## regras pra respeitar

- [ ] **não** violar regra 1 (sem pirataria de packs/cracks)
- [ ] **não** spam: postar uma vez em r/ableton, esperar moderação
- [ ] **não** cross-post em vários subs no mesmo dia (deixa 1-2 dias entre)
- [ ] **responder** todos os comentários nas primeiras 24h (community health)
- [ ] se mods pedirem flair **Show & Tell**, aplicar

## cross-posts planejados

| subreddit | quando | adaptar pra quê |
|---|---|---|
| r/ableton | dia 1 | foco em workflow + comparação com a categoria |
| r/WeAreTheMusicMakers | dia 2 | foco em "free tool for producers" |
| r/audioengineering | dia 3 | foco técnico: cert design, sensor fusion |
| r/Beatmakers | dia 4 | foco em hip-hop/trap workflow |
| r/Live_12 | dia 5 | novidade direta pro ecossistema Live 12 |

**não** postar em todos no mesmo dia — Reddit penaliza.

## primeiro comentário (auto-resposta)

pra fixar no topo do thread e dar contexto extra:

```markdown
Author here. A few things people usually ask:

**Q: Is this just a native mobile controller in a browser?**
A: Different stack. Existing mobile controllers typically use OSC and
a native app. RC Bridge uses
MIDI directly through the new Extensions SDK, runs in any browser, and
has sensor fusion as first-class input (gyro/accel/audio/camera).

**Q: Does it work on iPhone?**
A: Yes (iOS 15.4+, Safari). Haptics (`navigator.vibrate`) only work on
Android though.

**Q: Will it work with Live 11?**
A: No. Live 12.4.5+ Suite only, because the Extensions SDK is new.

**Q: Why no App Store version?**
A: Browser-only was the goal. No install on the phone. Less friction,
faster updates, free forever.

**Q: Can I run it offline?**
A: Mostly yes. The only external dep is the MediaPipe runtime fetched
from jsdelivr when you enable camera hand-tracking. Bundling it offline
is on the roadmap (v0.5).

More questions → I'll keep updating this comment.
```

## variações de tom

| tom | uso |
|---|---|
| casual (default) | r/ableton, r/Beatmakers |
| técnico | r/audioengineering, r/WeAreTheMusicMakers |
| hype | r/Live_12 (release announcement) |

## métricas-alvo

- upvotes: 200+ em 24h, 500+ em 7 dias
- comments: 30+ (engajamento real, não só "cool")
- awards: 1-5 (qualquer um vale)
- cross-link clicks: 100+ pro GitHub

se ficar < 50 upvotes em 24h, **não deletar**, mas ajustar copy pra
segunda tentativa em 30 dias.