# Security Policy

## Supported Versions

| Version | Supported |
|---------|-----------|
| 0.5.x   | yes |
| 0.4.x   | best-effort |
| 0.3.x   | best-effort |
| < 0.3   | no |

## Reporting a Vulnerability

Do not report security problems in a public channel.
For pre-public tester builds, contact the maintainer directly. Once the
repository is public, use the private security disclosure channel.

We aim to acknowledge reports within 48 hours and release critical patches within 7 days.

## Scope

The extension runs an HTTP/HTTPS and WebSocket server on a random LAN-reachable port.

Attack surface:

- Self-signed TLS certificates generated per install and stored in Ableton `storageDirectory/certs/`.
- WebSocket command handler inside the Ableton Extensions SDK runtime.
- Static file server serving only `dist/static/` with path traversal protection.
- Phone browser APIs: camera, microphone, and motion/orientation sensors.

The current 0.5.x design assumes a trusted studio/home LAN. HTTPS protects
the browser transport and enables camera/microphone APIs, but it is not a
pairing or authorization layer. Any browser client that can reach the
bridge URL can connect to the WebSocket surface and send supported bridge
commands.

## HTTPS And Certificates

- Phone, panel, and admin browser clients should use HTTPS/WSS.
- Camera and microphone require a Secure Context on the phone.
- QR URLs use a LAN address so phones can reach the host.
- The certificate includes localhost, `127.0.0.1`, and current LAN IP SANs.
- If LAN IP coverage is stale, the extension can regenerate the certificate.
- Browsers still warn because the certificate is self-signed. The user must accept the warning once, or use a tunnel/reverse proxy with a public certificate.

Private keys are never bundled in `.ablx` packages.

## Network Exposure

- Do not run the bridge on public, guest, or untrusted WiFi.
- Prefer same-room/studio LAN use.
- Treat tunnel URLs as temporary secrets.
- Close Cloudflare/ngrok/reverse-proxy tunnels when the session ends.
- A future release may add an explicit pairing token or PIN; it is not
  present in 0.5.x.

## Command Safety

Commands are JSON messages handled by project code. They include mapping
operations used by the phone MAP mode, panel/admin mapping tools, and MIDI
trigger-note setup. They must not call shell commands or write outside
Ableton extension storage. New commands must return diagnostics and have
tests.

## Future Security Plans (Pairing & PIN)

The current 0.5.x version is designed for single-user home/studio LAN networks. To support shared studio environments or public spaces safely, a future release may implement:
- **WebSocket Pairing PIN**: The Ableton panel will display a temporary 4-digit PIN code upon connection.
- **Client Authentication**: Browser clients must submit the correct PIN to upgrade the WebSocket connection, preventing unauthorized local devices from sending MIDI or parameter commands.
