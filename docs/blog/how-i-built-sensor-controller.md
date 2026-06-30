# How I built a sensor-aware MIDI controller with the new Ableton Extensions SDK

> Rascunho de blog post técnico. Adaptar antes de publicar no dev.to /
> Hashnode / Hacker News. Última atualização: junho de 2026.

---

I wanted to use my phone's gyroscope as a synth parameter. That sounded
simple and turned out to be the start of a six-month project.

This post is about the engineering decisions behind
**Ableton RC Bridge** — an open-source Live extension that turns your
phone into a multi-touch, motion-sensing MIDI controller. Browser-based,
MIT licensed, no app install required. I'll focus on the parts that were
actually hard.

---

## The problem

There are mobile controllers for DAWs. They cost $10–15, they need an
install from the App Store, and they treat the phone as a touchscreen.
Which it is. But it's also a sensor platform — gyroscope, accelerometer,
ambient light sensor, microphone, camera. None of the existing solutions
treat those as first-class control inputs.

The old Liine Lemur was the closest thing. It was great until it wasn't
— discontinued in 2024. The gap it left is the reason I started building.

The new Ableton Extensions SDK landed in Live 12.4.5. It's an open
JavaScript SDK for building extensions that integrate directly into
Live. That changed the calculus: instead of running an OSC bridge, I
could talk to Live natively, from JavaScript, with a real API.

---

## The stack

```
┌─────────────────────────┐         ┌──────────────────────────┐
│  Ableton Live           │         │  Phone (any browser)     │
│  ┌────────────────────┐ │  HTTPS   │  ┌─────────────────────┐ │
│  │ Ableton RC Bridge  │◀┼─────────┼▶│  phone-v3 (web app)  │ │
│  │  + ws + http       │ │  + WSS   │  │  touch / sensor /   │ │
│  │  + command handler │ │          │  │  audio / camera     │ │
│  └────────────────────┘ │          │  └─────────────────────┘ │
│  + admin dashboard  ────┼─ HTTPS   │                          │
│  (also on 0.0.0.0:port) │ + WSS    │                          │
└─────────────────────────┘         └──────────────────────────┘
```

The extension runs an HTTP + WebSocket server bound to `0.0.0.0` on a
random free port. The phone connects over WebSocket and exchanges MIDI
control data at 30 Hz.

**Why browser instead of a native app?** Two reasons. Friction — install
the `.ablx`, scan a QR, done. No App Store, no per-platform builds, no
per-version updates. Updates — I can ship a new sensor feature without
an app review cycle.

The trade-off: no haptics on iOS Safari (`navigator.vibrate` isn't
implemented there). Android gets full haptics.

---

## The hard part: per-install HTTPS

The phone client uses `getUserMedia` for camera and microphone. Browsers
require a Secure Context, which on a phone means HTTPS. So I need an
HTTPS server running inside the extension.

Shipping a shared private key inside the `.ablx` is a bad idea — anyone
could MITM any user. So the extension generates a **unique self-signed
certificate on first launch** using the `selfsigned` npm package.

The flow looks like this:

1. User installs the `.ablx` and clicks "Show panel" in Live.
2. The extension checks `storageDirectory/certs/` for an existing cert.
3. If missing, it generates a new one and stores it.
4. The extension starts an HTTPS server on a random free port.
5. The Live panel renders a QR code encoding `https://<lan-ip>:<port>/`.
6. The user scans with their phone.
7. The browser shows "Your connection is not private" — expected.
8. User accepts once. The phone remembers for the cert's lifetime (~365
   days).

The private key never enters the published artifact. The `npm run
package` script intentionally excludes the `.certs/` folder. If you
download the `.ablx` and unzip it, there are no `.key` or `.pem` files
inside — only the compiled extension code and the static phone client
assets.

This was the part I spent the most time on, because every alternative I
considered had a worse trade-off:

- **HTTP plain** — breaks `getUserMedia` entirely. Camera and mic stop
  working.
- **Ship a shared private key** — MITM risk for every user.
- **Prompt the user to install a cert** — terrible UX, won't work on
  locked-down phones.
- **Use a tunnel** — adds infrastructure, breaks the offline promise.

The self-signed per-install cert is the simplest thing that actually
works for the threat model — trusted local network, opt-in pairing via
QR code.

---

## Sensor pipeline

The phone web app reads six sensor streams. All processed locally, in
the browser tab, nothing leaves the device.

**Motion.** `DeviceOrientationEvent` + `DeviceMotionEvent` give you
accelerometer and gyroscope. They drift. The fix is sensor fusion — I
use a Madgwick filter (vendored as `vendor/madgwick.js`) to produce a
stable quaternion stream at 60 Hz. Denoising is still experimental, but
the basic pipeline works.

**Light.** `AmbientLightSensor` where supported. Most desktop browsers
don't expose it; on phones it works in Chrome and Edge.

**Audio.** This one was fun. `getUserMedia({audio: true})` →
`AudioWorklet` running YIN pitch detection, RMS envelope, and onset
detection. The pitch tracker gives you a continuous MIDI-like note
number; the onset detector gives you triggers. So you can beatbox into
your phone and use it as a MIDI input.

**Camera.** MediaPipe Hands runtime, loaded from `cdn.jsdelivr.net` on
first use. Frame data stays in the browser; only the 21 hand landmark
positions get forwarded to Live. You can map any of those to a CC, so
waving your hand in front of your phone literally modulates a synth
parameter.

All six streams forward to Live as control values over WebSocket. Live
sees them as standard MIDI CCs and treats them accordingly — mappable,
automatable, recordable.

---

## WebSocket at 30 Hz with sub-50 ms latency

The phone client is plain ES5/ES6. No bundler, no framework, no build
step. The cold-start path is short: download a few hundred KB of HTML
and JS, parse, paint.

I tested end-to-end latency on a typical home Wi-Fi: ~30–45 ms from
finger-on-screen to MIDI message-in-Live. On a crowded 2.4 GHz network
it can spike to 80 ms. On 5 GHz it's consistently under 50 ms.

For controller gestures (knobs, faders, XY pads, sensors), this is well
below human perception thresholds. For tight musical timing (drumming
on pads), 50–80 ms is fine for live performance but not for recorded
tracks where you'd want tighter timing. That's on the roadmap.

The WebSocket protocol is a simple JSON-ish message format:

```json
{ "type": "cc", "channel": 1, "number": 7, "value": 102 }
{ "type": "note", "channel": 1, "note": 60, "velocity": 100 }
{ "type": "snapshot", "id": "A" }
{ "type": "morph", "from": "A", "to": "B", "t": 0.5 }
```

The server translates these into the Extensions SDK API calls. The
phone doesn't need to know anything about Live's internal model — it
just sends MIDI.

---

## What's next

The roadmap is documented in the repo, but the headline items:

- **WebRTC multi-phone jam mode** — multiple phones on the same Live
  instance, peer-to-peer over WebRTC. The signaling server is already
  there.
- **Offline MediaPipe bundle** — drop the jsdelivr dependency. Important
  for users behind strict firewalls.
- **MIDI track and clip creation from the phone** — currently you map
  controls to existing parameters. Being able to spawn new tracks and
  clips from the phone unlocks new workflows.
- **Full-body multi-touch + sensor fusion** — combine camera, motion,
  audio into a single coherent input stream.

---

## Try it

If you're on Live 12.4.5+ Suite Beta:

1. Grab the latest `.ablx` from the Releases page on GitHub.
2. Double-click to install. Click "Show panel".
3. Scan the QR with your phone.
4. Accept the cert warning once.
5. Map a knob to a filter cutoff. Tilt your phone.

Everything is MIT licensed. PRs welcome. Issues welcome. Bug reports
welcome. If you build something with it, I'd love to hear about it.

Source: [github.com/worm/ableton-rc-bridge](https://github.com/worm/ableton-rc-bridge)

---

*Gabriel Worm is a producer and developer based in Palmas, Brazil. He
builds open-source music tooling and is unreasonably interested in
sensor-driven controllers.*