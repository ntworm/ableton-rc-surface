# Implementation Plan: ableton-rc v0.3 Performance Instrument Features

This document serves as the comprehensive master plan for implementing the performance instrument capabilities of the `ableton-rc` extension (v0.3). It records the architecture of completed phases and details the technical designs for upcoming ones.

---

## 1. Architectural Overview & Design System

The phone-v3 application is designed around a zero-latency feedback loop (<50ms perceived latency) transforming the mobile device into an expressive controller.

```mermaid
graph TD
    subgraph Mobile Client (Browser)
        UI[PWA UI: static/phone-v3/]
        Sensors[Device Motion & Orientation]
        Touch[Pointer Events & Touch Force]
        Audio[Mic Pitch & Beat Detection]
        Vision[MediaPipe Hand Tracking]
        WS_Client[WebSocket Client]
        
        Sensors -->|Raw data| Fusion[Madgwick AHRS Filter]
        Fusion -->|Fused Euler Angles| State[Client State]
        Touch -->|Pressure & Coordinates| State
        Audio -->|BPM & Pitch MIDI| State
        Vision -->|Hand XY coordinates| State
        State -->|30Hz Snapshot| WS_Client
    end

    subgraph Ableton Host (Desktop)
        WS_Server[WebSocket Server: src/extension.ts]
        CommandReg[Command Registry]
        AbletonSDK[@ableton-extensions/sdk]
        LiveApp[Ableton Live application]

        WS_Client <-->|Bidirectional WS| WS_Server
        WS_Server -->|Apply Mappings| LiveApp
        LiveApp -->|Live State Events| WS_Server
        WS_Server -->|/haptic/vibrate| WS_Client
    end
```

---

## 2. Completed Phases (Technical Design & Verification)

### Phase 1: Wake Lock & Haptic Feedback (Bidirectional)
* **Goal:** Keep the screen active during performance and send tactile vibrations from Ableton Live to the phone.
* **Client Implementation (`app.js`):**
  * Screen Wake Lock is requested via `navigator.wakeLock.request('screen')` on the first user interaction (`touchstart` or `mousedown`).
  * Re-request logic is registered on `visibilitychange` to acquire the lock again when returning to the tab.
  * Added `triggerHaptic(patternType)` which maps predefined haptic cues (`gentle`, `heavy`, `metronome`, `error`) and scales vibration lengths according to the user-selected profile in the UI (`gentle` = 50% length, `heavy` = 200% length).
  * WebSocket listener routes `msg.type === 'haptic_vibrate'` to the haptics utility.
* **Server Implementation (`extension.ts`):**
  * Exposed `triggerHaptic` command in the extension command registry to allow triggering vibrations remotely.
  * Wired haptic vibrations to playhead toggle events (gentle vibrate on start, heavy vibrate on stop).
* **Verification:** Unit tests in `haptics-wakelock.test.mjs` verify the structure, profile settings, and event routing.

### Phase 2: Sensor Fusion for Motion (Madgwick AHRS)
* **Goal:** Eliminate gimbal lock and orientation drift from raw gyroscopes.
* **Client Implementation (`vendor/madgwick.js` & `app.js`):**
  * Integrated a lightweight JS port of Sebastian Madgwick's orientation filter.
  * Added protection against division by zero in the step-normalization phase when the IMU error gradient is zero (filter perfectly aligned with gravity).
  * Converts raw gyroscope degrees-per-second (`DeviceMotionEvent.rotationRate`) into radians-per-second (`rotationRate * Math.PI / 180`) before updates.
  * Updates `state.orient` and `state.sensors.orientation_reading` with fused Euler angles.
  * Bypasses noisy raw browser `deviceorientation` events when the Madgwick filter is active.
* **Verification:** Unit tests in `sensor-fusion.test.mjs` mock the IMU data stream and assert quatérnion normalization.

---

## 3. Upcoming Implementation Phases

### Phase 3: Advanced Touch & Gestures (P1)
Introduce pressure/force tracking and multi-finger compound gestures to drive modulation.

#### Proposed Changes
##### [MODIFY] [controls.js](file:///C:/Users/Usuario/repos/ableton-extensions/source-repos/ableton-rc-extension/static/phone-v3/controls.js)
* **Pointer Pressure:** Extract `PointerEvent.pressure` (supported on modern Android & Windows touchscreens) and fallback to iOS Safari-specific `Touch.force`. Mapped as continuous aftertouch parameter.
* **Pinch/Rotate Gestures:** Integrate a custom mini-gesture recognizer or import `Hammer.js` (lite variant) to capture two-finger rotate/pinch actions.
* **Mapping Engine:** Map the extracted touch variables (e.g. `touch.pressure`, `gesture.pinch`) to continuous controller output slots in `state.touches`.

#### Verification Plan
* **Automated:** Write unit tests simulating Multi-touch events with differing pressure levels and assert correct calculation of delta values.
* **Manual:** Verify on device that pressing harder on a performance pad increases the mapped device parameter.

---

### Phase 4: Audio Inputs - Pitch & Beat Detection (P1)
Allow the room's sound or vocal triggers to sync and control Ableton parameters.

#### Proposed Changes
##### [NEW] [audio-processor.js](file:///C:/Users/Usuario/repos/ableton-extensions/source-repos/ableton-rc-extension/static/phone-v3/audio-processor.js)
* **Audio Context:** Initialize `AudioContext` only after user interaction. Setup `AnalyserNode` to capture microphone stream.
* **Pitch Detection (YIN):** Implement the YIN pitch detection algorithm in pure JS (low latency, Mono). Convert the frequency to MIDI note numbers.
* **RMS / Envelope Follower:** Compute the root-mean-square (RMS) value of the audio buffer to generate a volume envelope follower.
* **Onset Detection (Beat tracker):** Implement spectral flux thresholding to detect beat transients. Mapped to tap-tempo commands.

##### [MODIFY] [app.js](file:///C:/Users/Usuario/repos/ableton-extensions/source-repos/ableton-rc-extension/static/phone-v3/app.js)
* Allow toggling microphone input in the UI.
* Stream detected BPM, pitch, and amplitude into the WebSocket send loop.

#### Verification Plan
* **Automated:** Mock the audio buffer stream with a constant sine wave frequency (e.g., 440Hz) and verify the YIN detector outputs A4 (MIDI note 69).
* **Manual:** Hum/whistle into the phone microphone and verify that the virtual instrument pitch follows the note.

---

### Phase 5: Vision Inputs - MediaPipe Hands (P1)
Vision-based expressive control (Theremin Mode) using the front-facing camera.

#### Proposed Changes
##### [MODIFY] [index.html](file:///C:/Users/Usuario/repos/ableton-extensions/source-repos/ableton-rc-extension/static/phone-v3/index.html)
* Add a camera preview layer (`<video>` hidden or semi-transparent overlay) and a visual "Vision Active" HUD.

##### [NEW] [vision-processor.js](file:///C:/Users/Usuario/repos/ableton-extensions/source-repos/ableton-rc-extension/static/phone-v3/vision-processor.js)
* **Dynamic Import:** Load MediaPipe `@mediapipe/tasks-vision` packages asynchronously from CDN when Theremin Mode is toggled to conserve start-up bandwidth.
* **Detection Loop:** Initialize `HandLandmarker` model in lite mode. Process frames at 15-20fps to prevent battery drain.
* **Gesture Mapping:**
  * Hand Y-axis coordinate mapped to Pitch/Filter.
  * Z-axis (hand distance, estimated by landmark boundaries) mapped to Volume/Modulation depth.
  * Open hand vs Fist mapped to Play/Stop.

#### Verification Plan
* **Automated:** Write stub tests validating the task loader and hand coordinate transformation logic.
* **Manual:** Toggle Vision Mode, hold hand in front of the camera, and confirm that moving the hand modulates the target device parameters.
