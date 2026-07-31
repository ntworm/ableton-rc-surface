# Privacy Policy

Ableton RC Surface is a local-network extension.
It does not collect, transmit, or store personal data beyond the user's own machine and LAN.

## Data Stored Locally

| Data | Where | Lifetime |
|------|-------|----------|
| Self-signed TLS certificate + private key | Ableton `storageDirectory/certs/` | Until user deletes storage or cert expires/regenerates |
| Control mappings | Ableton storage | Persistent across sessions |
| Mapping presets | Ableton storage | Until deleted |
| Phone preferences | Phone browser storage | Until browser data is cleared |

## Network Data

- Bridge traffic stays on the user's LAN unless the user sets up a tunnel.
- No telemetry.
- No analytics.
- No crash reporting.
- No cloud control path.
- QR codes are generated locally in the panel UI.
- MediaPipe Hands runtime/model files are served locally by the extension.

## Phone Browser Data

The phone client runs in the browser. It does not install a native app.

Permissions are requested only for active features:

- motion/orientation sensors;
- microphone for audio RMS/pitch/BPM;
- camera for MediaPipe hand tracking.

Sensor data is processed in the phone browser and sent as numeric control values over WebSocket.
Raw audio and raw video frames are not sent to Ableton RC Surface.

## Third-Party Runtime

MediaPipe Hands is bundled with the extension and served over the local
connection. The hand-tracking model runs in the phone browser. Camera frames
are not sent to Google by this project.

On a fully offline network, core touch, motion, audio, mapping, and mixer
controls continue to work, but camera hand tracking is unavailable unless
the MediaPipe files are already cached by the phone browser.

Offline-bundled MediaPipe remains future work.
