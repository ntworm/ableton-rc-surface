# ableton-rc: Performance Instrument Research Plan

> Status: research (not implementation). This file lists what we will investigate, the tools we will use, the data we want to extract, and the open questions that need answers before we pick what to ship in v0.3.

## 1. Context & Pivot

The original framing of ableton-rc was "phone as remote control for production". The reframing for v0.3 is:

- Phone is a **performance instrument**, not a producer's mixer.
- It lives in your pocket, on your hand, on a friend's hand during a show.
- It can be expressive (multi-touch, motion, vision) **and** responsive (haptic feedback from Live).
- The benchmark is "gesture feels like an instrument" with sub-50ms perceived latency.

The current code already does the minimum: WebSocket bridge, mapping engine, motion + multi-touch in. v0.3 deepens the input side and adds the first feedback side.

## 2. Scope of this Milestone

- **Single musician** on a single phone. Peer network and multi-user are deferred.
- Performance use cases:
  - A second person joins to modulate a parameter while the main performer plays an instrument.
  - The phone controls pedal-style effects (wah, filter sweep) during a set.
  - The phone itself becomes a standalone expressive controller (theremin mode, body conducting).
- Launch target: v0.3.0 within ~7 days.

## 3. Out of Scope (Deferred to v0.4+)

- Peer-to-peer network between phones (WebRTC + WebSocket).
- Multi-user coordination, session merge, role-based routing.
- AI / LLM layer (AbletonBridge territory).
- AbletonOSC protocol compatibility (we are WebSocket-native; this is a strength).
- M4L bridge (Extensions SDK already replaces it for the use cases we need).
- Recording, MIDI generation, generative music.

## 4. Research Topics

Topics are ordered by priority for v0.3. Each topic has the same shape: goal, tools, data we want, performance use case, open questions, validation plan.

### P0 - Sensor fusion for motion (replaces raw gyro)

**Goal:** replace the current raw `accel/gyro/orient` with a fused quaternion. The current input is noisy and drifts.

**Tools / libraries:**
- `Madgwick.js` (open source, JS port of Sebastian Madgwick's filter)
- `MahonyAHRS` (alternative)
- `sensor-fusion` npm packages (smaller wrappers)
- Could also use the browser's own `DeviceMotion` rotation matrix where supported

**Data to extract:**
- Orientation as a quaternion (no gimbal lock, no drift over short windows)
- Gravity vector in world frame (for "which way is up" gestures)
- Linear acceleration in world frame (gravity removed)
- Tilt angle, heading

**Performance use cases:**
- Tilt = filter cutoff (continuous, smooth)
- "Look at me" gesture = parameter jump
- "Tilt + tap" = compound macro
- World-relative motion (tilt your phone forward, regardless of starting orientation) is more intuitive than device-relative

**Open questions:**
- Drift over 30 minutes of continuous use?
- Jitter when the phone is shaken?
- Computational cost on low-end phones? (probably negligible, these filters are ~1k floating point ops per sample)
- How to handle the initial "I don't know which way is up" before enough motion has happened?

**Validation:**
- Run a 30-minute session with a phone in a fixed position. Log orientation. Check that drift is bounded.
- Shake the phone violently for 10 seconds. Check that orientation recovers within 200ms.
- Battery drain: comparable to current raw consumer? (should be the same or less)

### P0 - Haptic feedback (bidirectional)

**Goal:** invert the data flow. Today the phone sends to Live. v0.3 sends back: Live can vibrate the phone on key events.

**Tools / APIs:**
- `navigator.vibrate(pattern)` - Android Chrome, Firefox, Edge. **Not supported on iOS Safari.**
- iOS fallback: none in pure web. Would require a native wrapper or a workaround (audio cue through the speaker).

**Data to extract (incoming to phone):**
- Clip fired (scene start)
- Marker hit (locator)
- Take started / stopped
- Error conditions
- Beat ticks (could feel like a metronome in the pocket)

**Performance use cases:**
- Phone vibrates on the downbeat - feels like a metronome in the pocket.
- Phone vibrates on scene change - useful when the screen is dim.
- Phone vibrates on error - fail-safe feedback.
- Phone vibrates when MIDI notes hit a threshold - "tap-along" feel.

**Open questions:**
- Perceived latency on Android (should be under 30ms)?
- Battery cost of continuous vibration patterns?
- iOS users: do we hide this feature, or surface a clear "Android only" note?
- Can we do more sophisticated haptics (different patterns for different events)?

**Validation:**
- Test on Android Chrome with various events. Measure latency from Live action to phone vibration.
- Test on iOS Safari. Confirm silent failure or error.
- Measure battery drain over a 30-min performance with vibration on every beat.

### P1 - Beat detection from mic

**Goal:** the phone "hears" the room and detects the beat. Auto-tap-tempo without a human pressing a button.

**Tools / libraries:**
- `web-audio-beat-detector` (npm, BPM from audio buffer)
- `Meyda` (audio feature extraction: onset strength, spectral flux)
- `essentia.js` (heavier, more accurate, WASM)
- Custom onset detection via `AnalyserNode` + thresholding

**Pipeline:** mic -> `AudioContext` -> `AnalyserNode` -> onset detection -> BPM estimation -> beat times

**Data to extract:**
- Estimated BPM
- Beat times (timestamps of detected onsets)
- Onset strength (loudness of each beat)
- Confidence (how stable is the BPM estimate)

**Performance use cases:**
- Auto-tap-tempo by pointing the phone at the speaker.
- Effect intensity follows the beat (LFO synced to detected pulse).
- "Follow the drummer" mode: phone stays locked to whatever is playing.

**Open questions:**
- Accuracy across genres (techno vs jazz vs classical)?
- Latency between actual beat and detection?
- Feedback risk if the mic is too close to the speaker?
- How does it handle tempo changes mid-set?

**Validation:**
- Play a metronome at 120 BPM. Measure detected BPM (should be 120 +/- 2).
- Play music at various tempos. Measure detection latency.
- Walk around with the phone pointed at different sources. Check stability.

### P1 - MediaPipe Hands (vision-based expressive control)

**Goal:** the phone's camera becomes a gesture surface. Theremin mode without touching the screen.

**Tools / libraries:**
- `@mediapipe/tasks-vision` (the modern Tasks API, lighter than the legacy `@mediapipe/hands`)
- `HandLandmarker` in lite mode (~3MB) or full mode (~6MB)
- WASM-based, runs in browser

**Data to extract:**
- 21 hand landmarks per hand (x, y, z, visibility)
- Handedness (left/right)
- Gesture classification (built-in: fist, open palm, pointing, etc.)
- Pinch detection (distance between thumb tip and index tip)

**Performance use cases:**
- Theremin mode: hand Y position = pitch, hand Z distance = volume.
- Fist = stop, open hand = go.
- Pinch = filter cutoff.
- Two hands: one for parameter, one for value.
- Body pose conducting (separate topic, P3) - pointing at the camera to navigate.

**Open questions:**
- Frame rate on low-end phones (Moto G, iPhone SE)? Target: 15 fps minimum.
- Battery drain with camera + model running?
- Lite vs full model: which trade-off wins?
- How does it perform in low light, with backlighting, or with multiple people in frame?
- Does it work in landscape orientation as well as portrait?

**Validation:**
- Benchmark on a low-end Android (Moto G class) and a mid-range iPhone (iPhone SE 2020 or newer).
- Log fps over 5 minutes continuous. Should stay above 15 fps.
- Test with various lighting conditions.
- Test with hand entering / leaving the frame.
- Battery: 30-minute session should leave the phone with >40% battery.

### P1 - Mic pitch detection

**Goal:** sung notes control Live. Whistle a note, the synth plays it.

**Tools / libraries:**
- `pitchy` (YIN algorithm, lightweight, JS-only)
- `CREPE` (ML model, more accurate, heavier)
- `ml5.pitch` (high-level wrapper around CREPE)
- Custom autocorrelation on `AnalyserNode` data

**Pipeline:** mic -> `AudioContext` -> `AnalyserNode` -> time-domain -> autocorrelation / YIN / ML -> frequency -> MIDI note

**Data to extract:**
- Fundamental frequency in Hz
- Converted MIDI note number
- Note name (C, C#, D, ...)
- Amplitude
- Voiced vs unvoiced

**Performance use cases:**
- Vocal puppet: sing into the phone, filter cutoff follows the note.
- Whistled synth: whistle a melody, the synth plays it.
- Hum a chord, the phone detects the harmonic.
- Mouth-controlled effects (singing into the mic to open a wah, silence to close it).

**Open questions:**
- Latency vs accuracy trade-off? (YIN is fast; ML is more accurate but slower.)
- How does it handle polyphonic input (chords)? (probably badly, pitch detection usually assumes one fundamental.)
- Background noise? (probably needs a noise gate.)
- Microphone position relative to the mouth?

**Validation:**
- Sing sustained notes. Measure detected frequency vs actual.
- Whistle, hum, sing. Check which works.
- Play a single sustained note on a synth through speakers. Check detection.
- Try chords. Confirm mono behavior.

### P1 - Advanced touch (pressure, radius, gesture library)

**Goal:** multi-touch is already there. v0.3 deepens it.

**Tools / APIs:**
- `PointerEvent.pressure` (0-1, where supported)
- `Touch.force` (iOS Safari)
- `Hammer.js` (gesture library)
- Custom gesture recognition for compound gestures
- `ZingTouch` (alternative)

**Data to extract:**
- Pressure (0-1)
- Touch radius
- Force (iOS specific)
- Gesture types: tap, double-tap, long-press, swipe, pinch, rotate
- Multi-finger compound gestures

**Performance use cases:**
- Aftertouch: press harder = more modulation depth.
- Soft/hard press: 0.3 = light effect, 0.8 = intense.
- Pinch = filter cutoff.
- Two-finger rotate = parameter morph.
- Distinguish tap from hold from drag with debounce.

**Open questions:**
- Which phones actually expose `pressure` and `force`?
- What's the resolution and range?
- Browser support matrix?
- Performance of `Hammer.js` vs custom?

**Validation:**
- Build a device inventory. Test on the actual phones the user has.
- Benchmark Hammer.js startup time and memory.
- Test gesture recognition accuracy with various users.

### P2 - Loudness / RMS (with care)

**Goal:** continuous loudness as an envelope follower.

**Tools / APIs:**
- Web Audio `AnalyserNode` + `getByteTimeDomainData` -> RMS
- `vol-meter` npm
- `Meyda` (RMS feature)

**Data to extract:**
- Continuous RMS amplitude
- Peak hold
- Dynamic range

**Performance use cases:**
- Effect intensity follows loudness.
- Dynamics-controlled filter (louder = more open).
- Envelope follower on guitar via mic.

**Risks:**
- Feedback loop if the mic is near the speaker.
- Battery drain from continuous audio processing.

**Open questions:**
- How to detect and avoid feedback?
- What's a sane default smoothing time?
- iOS vs Android audio pipeline behavior?

**Validation:**
- Test with mic close to speaker. Confirm no runaway.
- Test with mic far from speaker. Confirm clean envelope.

### P2 - Wake lock

**Goal:** screen doesn't dim mid-performance.

**Tools / APIs:**
- `navigator.wakeLock.request('screen')`

**Notes:**
- Requires a user gesture to activate.
- OS can revoke under memory pressure.
- Document the failure mode clearly.

### P2 - QR code detection (camera)

**Goal:** point phone at a stage poster, load a setlist.

**Tools / libraries:**
- `jsQR` (lightweight, ~50KB)
- `qr-scanner` (more featureful, slightly heavier)

**Data to extract:**
- Decoded QR string
- Probably a URL or JSON describing a setlist

**Coexistence with MediaPipe:** can run in parallel by running both on the same camera feed. Need to test for fps impact.

### P2 - Color detection (camera)

**Goal:** ambient light color controls a parameter. Stage lighting becomes a control source.

**Tools:** Canvas `getImageData` on a 1fps frame is enough.

**Data:**
- Average RGB of a downscaled frame

**Performance use cases:**
- Blue stage light = filter sweep
- Red light = delay
- Bright light = volume swell

### P3 - NFC tap

**Goal:** tap phone to NFC tag, trigger scene.

**Tools / APIs:** `NDEFReader` (Web NFC, Android Chrome only).

**Caveats:** iOS Safari does not support Web NFC. Defer or document.

### P3 - Battery status

**Goal:** warn user before the phone dies.

**Tools / APIs:** `navigator.getBattery()` (Promise).

**Caveats:** Firefox has dropped support. Chrome supports.

### P3 - Web MIDI API

**Goal:** phone as a host for external MIDI hardware (e.g., a breath controller).

**Tools / APIs:** `navigator.requestMIDIAccess()`.

**Caveats:** iOS Safari does not support. Android Chrome supports.

## 5. Risks

| Risk | Severity | Mitigation |
|---|---|---|
| iOS Safari gaps (no vibrate, no NFC, no MIDI) | High | Document clearly. Build Android-first for v0.3. iOS users get a degraded experience. |
| MediaPipe battery / fps on low-end phones | Medium | Use lite model. Benchmark before shipping. Provide a "lite mode" toggle. |
| Mic feedback (beat detection + live monitoring) | Medium | Noise gate by default. Manual threshold UI. |
| Sensor fusion drift over long sessions | Low | Re-calibration gesture. Baseline reset button. |
| Wake lock revocation by OS | Low | Show a clear "screen may dim" warning. |
| Permission UX (mic, camera) | Medium | Single onboarding flow at first launch. Clear explanation. |

## 6. 7-Day Research Timeline

| Day | Focus | Deliverable |
|---|---|---|
| D1 | Inventory + sensor fusion | Browser API support matrix (iOS vs Android). Madgwick prototype with current motion code. |
| D2 | Haptic + wake lock | Android vibrate on Live event. Wake lock wired. |
| D3 | MediaPipe Hands | Lite model prototype. FPS benchmark. |
| D4 | Web Audio (beat + pitch) | Beat detector prototype. Pitch detector prototype. |
| D5 | Gesture library + pressure | Hammer.js integrated. Pressure exposed where supported. |
| D6 | Integration into phone-v3 UI | A "performance mode" UI with at least 2 new inputs. |
| D7 | README + GIF + tag | README with the new performance use cases. 30s GIF demo. Tag v0.3.0. |

## 7. Success Metrics

- **Theremin mode** works (MediaPipe hand pose controls pitch + volume without touch).
- **Beat detection** locks BPM in 3+ scenarios (techno, ambient, live drums).
- **Haptic feedback** fires on Live events on Android (<30ms perceived latency).
- **No crashes** in a 30-minute continuous session with at least 2 new inputs active.
- **README + GIF** that demonstrate the "phone as performance instrument" framing.

## 8. Open Decisions

- iOS-first or Android-first for v0.3? (Recommendation: Android first, since iOS loses 4 features out of the box.)
- Lite or full MediaPipe model? (Test, then decide.)
- Beat detection in main thread or Web Worker? (Worker if it doesn't add latency.)
- Should the phone mic use the same mic as the user's "voice" on a call, or a different one? (Mostly the same; nothing to configure.)
