# Reddit r/audioengineering — Post técnico

> Rascunho técnico pra r/audioengineering. Foco em arquitetura, não em
> workflow musical. Adaptar antes de postar.

## título

```
[Open Source] Built a phone-as-MIDI-controller for Live 12.4.5+ using the new Extensions SDK — here's how the per-install HTTPS cert works
```

alternativa:

- `[Web Audio] Browser-based MIDI controller with sensor fusion — sharing the cert design`

## corpo

```markdown
Hey r/audioengineering,

I've been working on Ableton RC Bridge, an open-source Live 12.4.5+
extension that turns the phone into a MIDI controller via WebSocket.
Sharing some of the more interesting engineering decisions here.

**Architecture**

```
[Live]──HTTPS+WSS──[Phone browser]
  │                    ↑
  └────HTTPS+WSS────[Admin dashboard]
```

The extension runs an HTTP + WebSocket server bound to `0.0.0.0:<random
free port>` inside the Live process via the official Extensions SDK.
The phone connects over WebSocket and exchanges MIDI control data at
30 Hz with end-to-end sub-50ms latency.

**Per-install HTTPS certificate**

The phone client uses `getUserMedia` for camera and microphone. Browsers
require a Secure Context, which on a phone means HTTPS.

Shipping a shared private key inside the `.ablx` is a bad idea. So the
extension generates a **unique self-signed certificate on first launch**
using the `selfsigned` npm package. The cert is stored in Ableton's
`storageDirectory/certs/` and reused on subsequent launches.

This means:
- No private key in the published artifact
- No shared trust between users
- Cert fingerprint shown in Live panel for verification
- Browser shows "Your connection is not private" on first visit —
  expected. Accept once, the phone remembers.

**Sensor pipeline**

On the phone (in the browser tab, nothing leaves the device):

- `DeviceOrientationEvent` + `DeviceMotionEvent` → Madgwick fusion →
  quaternions (vendor/madgwick.js)
- `AmbientLightSensor` (where supported)
- Audio: `getUserMedia({audio: true})` → `AudioWorklet` running YIN
  pitch detection, RMS envelope, and onset detection
- Camera: `getUserMedia({video: true})` → MediaPipe Hands runtime
  (loaded from jsdelivr, bundling offline is on the roadmap)

All sensor data is consumed locally and forwarded to Live as control
values. **No data leaves the LAN.**

**Why MIDI and not OSC?**

The Extensions SDK gives you access to Live's control surface. Going
MIDI means no bridge patch (LiveOSC2 etc.), no OSC routing setup,
and direct integration with Live's MIDI learn.

**Why no native app?**

Two reasons:
1. Friction. Install the `.ablx`, scan QR, done. No App Store, no
   permissions on the host, no per-platform builds.
2. Updates. I can ship new sensor features without an app review cycle.

The trade-off is no haptics on iOS Safari (it doesn't implement
`navigator.vibrate`). Android gets full haptics.

**Codebase**

- TypeScript on the extension side (`src/extension.ts` ~3500 lines)
- Plain ES5/ES6 on the phone, no bundler
- `ws` + `selfsigned` as runtime deps
- ~6500 lines total
- MIT licensed

**Repo**

https://github.com/worm/ableton-rc-bridge

**Discussion**

I'd be curious to hear from anyone else building on the new Extensions
SDK. The 1.0.0-beta API is small but covers a lot. Happy to swap notes
about cert handling, WebSocket lifecycle in a Live extension, or sensor
fusion strategies.
```

## comentários esperados (preparar respostas)

**"Why not use WebRTC instead of WebSocket?"**
> WebRTC gives me peer-to-peer and lower latency, but adds signaling
> server complexity. WebSocket is fine for the LAN case — sub-50ms is
> already well below human perception for controller gestures. WebRTC
> is on the roadmap for v0.5 (multi-phone jam mode).

**"How do you handle clock drift between phone and Live?"**
> I don't. The phone is sending continuous control values (CC,
> pitchbend, note on/off) at 30 Hz. Live receives them as control
> change events with timestamps. For tight MIDI timing (drumming),
> you'd want Note Offset and a clock-synced approach — not in scope
> for this version.

**"Is the cert expiry handled?"**
> Cert lifetime is ~365 days. After that, the phone shows the cert
> warning again. The user re-accepts, and the cert is regenerated only
> if the storage directory is wiped. For a studio tool this is fine,
> but I'd think about it more carefully if this was a long-running
> production deployment.

**"Why not use WebMIDI instead of WebSocket?"**
> WebMIDI is great but only gives you MIDI messages. I need a custom
> protocol for snapshots, sensor config, admin operations, and
> bidirectional Live state. WebSocket + a JSON-ish protocol is the
> simpler choice.

**"Could this work with Bitwig/Logic/Reaper?"**
> Not without a different host. The Extensions SDK is Live-specific.
> For other DAWs you'd need a VST/AU or OSC bridge, which is a
> different project. The phone client could in theory be reused if
> you wrote a different server.

## regras pra respeitar

- [ ] postar **só** depois de ter o GitHub Release oficial pronto
- [ ] responder todos os comentários em 24h
- [ ] não brigar com quem comparar com a categoria
- [ ] se pedirem código de exemplo, linkar arquivo específico do repo