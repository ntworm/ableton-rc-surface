# Product Hunt — Copy da página

> Rascunho. Adaptar antes de submeter no Product Hunt. Nunca postar
> antes do release oficial.

## tagline (60 chars max)

```
Turn your phone into a sensor-aware MIDI controller for Ableton Live
```

alternativas:

- `Free, open-source MIDI controller for Ableton Live — runs in your phone's browser`
- `Browser-based MIDI controller with sensor fusion for Ableton Live 12.4.5+`

## descrição curta (260 chars max)

```
Ableton RC Bridge is a free, MIT-licensed Live 12.4.5+ extension
that turns your phone into a multi-touch, motion-sensing MIDI
controller via your phone's browser. No app install. Per-install
HTTPS cert for camera/mic. 12 pads, 8 knobs, sensor fusion.
Donations welcome.
```

## descrição longa

```markdown
## What is it?

Ableton RC Bridge is a free, open-source Live extension (Live 12.4.5+
Suite) that turns your phone into an expressive, motion-sensing MIDI
controller. Install the .ablx, click "Show panel", scan the QR code
with your phone, and a web app opens with a full performance controller.

## What you get

- **12 performance pads** with 4 modes (release, hold, toggle, burst)
- **8 knobs, 12 faders, 4 expression ribbons**
- **2 physics XY pads** for continuous two-axis control
- **Sensor panel**: gyroscope, accelerometer, ambient light, audio
  (RMS, pitch, onset/BPM), camera hand-tracking via MediaPipe, ambient
  color
- **8 snapshots** with a 2D vector morph pad
- **30 Hz bidirectional WebSocket**, sub-50 ms latency end-to-end
- **Two simultaneous clients** (performance + admin dashboard)

## How it's different

| Existing native mobile controller apps | Ableton RC Bridge |
|---|---|
| Native iOS/Android app | Browser-based, no install |
| $10-15 paid | Free, MIT, donations welcome |
| OSC protocol | MIDI native via Extensions SDK |
| Cross-DAW | Live 12.4.5+ Suite only |
| Basic gyro | Sensor fusion as first-class input |
| 1 client at a time | Performance + admin simultaneously |

## Tech highlights

- Built on the official Ableton Extensions SDK (1.0.0-beta)
- HTTPS with per-install self-signed certificate (so camera/mic work
  without shared private keys)
- Plain ES5/ES6 on the phone, no bundler, no framework
- TypeScript + esbuild on the extension side
- MIT licensed, ~6500 lines of code

## Who is it for?

- Electronic music producers who want expressive control without
  buying dedicated hardware
- Live performers looking for motion-sensing inputs
- Audio engineers curious about the new Ableton Extensions SDK
- Studios that want a free, customizable controller surface

## Roadmap

- v0.5: WebRTC multi-phone jam mode
- v0.5: Offline MediaPipe bundle
- v0.4.x: MIDI track and clip creation from the phone
- v0.4: Full-body multi-touch + sensor fusion

## Links

- **Source + releases**: https://github.com/worm/ableton-rc-bridge
- **Demo video (60s)**: [YouTube]
- **Donations**: https://worm.gumroad.com/l/ableton-rc-bridge
- **Documentation**: https://github.com/worm/ableton-rc-bridge#readme
```

## assets pra página

| asset | spec |
|---|---|
| icon | 240×240 PNG, fundo transparente, símbolo RC ou ondas |
| screenshots | 5-8 PNGs 1270×760, mostrando UI do phone + Live |
| gallery order | hero (panel QR) → phone UI → sensor panel → admin → morph |
| thumbnail | 240×240 (preview em listas) |
| promo video | opcional, embed YouTube |

## categoria

- **Developer Tools** (cabe pela stack/SDK)
- **Music & Audio** (mais óbvio)
- **Productivity** (long shot)

recomendação: **Music & Audio** é onde o público mora.

## maker

preencher:

- nome: worm
- bio: "open-source developer building MIDI tools"
- link: github.com/worm
- foto/avatar: consistente com GitHub

## topics / tags

sugestões:

- `midi`
- `ableton`
- `music-production`
- `open-source`
- `web-midi`
- `sensor-fusion`
- `web-audio`

## timing

PH funciona melhor terça/quarta (depende do calendário). agendar
pra coincidir com:

- GitHub Release público já feito
- Demo video no YouTube (link público)
- 1-2 dias depois do post no Reddit r/ableton (tração cruzada)

## primeira semana de monitoramento

- [ ] responder 100% dos comentários em 24h
- [ ] agradecer upvotes, marcar commentators úteis
- [ ] se subir pra top 10 do dia, postar updates
- [ ] se ficar fora do top 5, não panic — PH tem long tail

## follow-up (30 dias)

postar update no PH:

```
[30-day update] Ableton RC Bridge

- v0.4.X released with [list]
- [N] GitHub stars, [N] downloads
- [N] contributors onboarded
- Top requests: [list of features from feedback]

Next milestone: v0.5 (WebRTC)
```