# Privacy Policy

**Ableton RC Bridge** is a local-network extension. It does not collect,
transmit, or store any personal data beyond your own LAN.

## What data stays on your machine

| Data | Where | Lifetime |
|------|-------|----------|
| Self-signed TLS certificate + private key | `storageDirectory/certs/` | Until you uninstall or wipe the storage dir |
| Control mappings (JSON) | `storageDirectory/mappings.json` | Persistent across sessions |
| Mapping presets | `storageDirectory/presets/*.json` | Until you delete them |

## What data is sent over the network

- **LAN only**: The extension binds `0.0.0.0` on a random port. All
  HTTP/WebSocket traffic stays on your local network unless you
  explicitly set up a tunnel.
- **No telemetry**: No analytics, no crash reporters, no phone-home.
- **No cloud**: No data is sent to any external server. The QR code
  API (`api.qrserver.com`) is used only for generating QR code images
  in the panel UI; no user data is included beyond the local URL.

## Phone browser data

The phone client runs entirely in the browser. It does not install
anything on the phone, does not use localStorage (except for the
client ID cookie), and does not request any permissions beyond those
needed for sensors (camera, microphone, motion).

All sensor data (gyroscope, accelerometer, camera frames, audio
buffers) is processed locally in the phone's browser and sent as
numeric snapshots over WebSocket to the extension on your LAN. No
raw audio or video frames leave the phone.

## Third-party dependencies

- **MediaPipe Hands** (loaded from `cdn.jsdelivr.net` at runtime):
  Google's hand-tracking model runs entirely in the phone's browser.
  No data is sent to Google. A future version will bundle the model
  for fully offline use.
