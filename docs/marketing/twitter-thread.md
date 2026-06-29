# Twitter/X Thread — Ableton RC Bridge

> Rascunho da thread. Adaptar antes de postar. Nunca postar antes do
> release oficial.

## thread (8 tweets)

```
1/ Built a free, open-source MIDI controller for Ableton Live that
runs in your phone's browser.

No app install. No payment. Just scan a QR code from inside Live and
start playing. 🎛️📱

[attached: 60s demo video]


2/ It's called Ableton RC Bridge, built on the new Extensions SDK
(still in beta).

Why I built it:
- existing native controller apps cost $10-15 and need an app install
- the most established native controller was discontinued in 2024
- I wanted my phone's sensors (gyro, accel, audio, camera) to be
  first-class controller inputs


3/ What you get:

- 12 pads (4 modes), 8 knobs, 12 faders, 4 ribbons, 2 XY pads
- Sensor panel: gyro, accel, light, audio RMS+pitch/onset, camera
  hand-tracking
- 8 snapshots with a 2D morph pad
- Admin dashboard + performance client, simultaneously
- 30 Hz WebSocket, sub-50ms latency


4/ The hard part was HTTPS.

The phone needs camera + mic, which means a Secure Context, which
means HTTPS. But shipping a shared private key inside the extension
package is a bad idea.

So the extension generates a unique self-signed cert on first launch
and stores it in Ableton's app data directory.


5/ The phone side is plain ES5/ES6.

No bundler. No framework. Just an HTML file and a few JS files.

Why? Fast cold start, no build step, anyone can read the source.

The extension side is TypeScript with esbuild.


6/ Roadmap:

- v0.5: WebRTC multi-phone jam mode
- v0.5: offline MediaPipe bundle (no jsdelivr dep)
- v0.4.x: MIDI track + clip creation from the phone
- v0.4: full-body multi-touch + sensor fusion

PRs welcome.


7/ It's MIT licensed, free forever.

If it saves you money on hardware controllers or makes your live set
more expressive, donations are welcome but never required.

Source: github.com/worm/ableton-rc-bridge
Donate: gumroad.com/worm/ableton-rc-bridge


8/ Built solo. ~6500 lines of code.

Big thanks to the Ableton Extensions SDK team for the platform, and
to the Ableton community for years of controller-tinkering lore.

Happy to answer questions. 🧵
```

## variações

### versão curta (4 tweets)

```
1/ I built a free MIDI controller for Ableton Live that runs in
your phone's browser. No app install. Scan a QR. Play.

[video]

2/ 12 pads, 8 knobs, 12 faders, 4 ribbons, 2 XY pads.
Gyro + accel + audio + camera as inputs.
Sub-50ms latency. MIT licensed.

3/ Built on the new Ableton Extensions SDK.
Per-install HTTPS cert so camera/mic work.
Plain JS on the phone, TypeScript on the extension side.

4/ github.com/worm/ableton-rc-bridge
Donations welcome: gumroad.com/worm/ableton-rc-bridge
```

### single tweet teaser

```
Built a free Ableton Live controller that turns your phone into a
sensor-aware MIDI device. Browser-based, MIT, donations welcome.

🎛️ → 📱 → 🎵

Demo + source: [link]
```

### versão pra fazer hype pré-release

```
Shipping a free Ableton Live controller tomorrow. Browser-based,
sensor-aware, MIT. Been building this for months, can't wait to
share.

Quick demo teaser:

[gif 15s]

Subscribe to get notified.
```

## tags / mentions

sugestões (não mencionar concorrentes negativativamente):

- `@Ableton` — talvez veja, talvez não
- `#Ableton` hashtag
- `#Live12` hashtag
- `#MIDIcontroller` hashtag
- `#opensource` hashtag
- `#WebAudio` hashtag (pra puxar dev audience)
- `#sensorfusion` hashtag

**não mencionar** outras ferramentas por nome — deixa a comparação
orgânica nos replies.

## timing

- melhor hora pra postar thread: **terça/quarta 14-16h UTC** (BR+US+EUA peak)
- evitar: sexta à noite, domingo cedo, feriados US
- ideal: postar thread, depois tweetar GIFs individuais como replies
  nas próximas 24h

## imagens/vídeos anexar

- tweet 1: **60s demo video** (mp4 ou link YouTube)
- tweet 2-3: 1-2 GIFs curtos (pads + XY pad)
- tweet 5: 1 screenshot do código
- tweet 8: GIF final (snaps morph)

## métrica de sucesso

- impressions: 5k+ em 24h
- likes: 100+ em 24h
- retweets: 30+ em 24h
- link clicks pro GitHub: 200+ em 7 dias
- replies com dúvidas técnicas: 10+ (engajamento real)