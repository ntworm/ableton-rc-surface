# Security Policy

## Supported Versions

| Version | Supported |
|---------|-----------|
| 0.6.x   | yes |

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

The current design assumes a trusted studio/home LAN. HTTPS protects the
browser transport and enables camera/microphone APIs. Controller and admin
actions also require cryptographically random session tokens that are
regenerated whenever the extension starts. Requests are classified as viewer,
controller, or admin and commands are authorized by role.

The controller token is delivered by the generated QR URL and then moved into
an HttpOnly, SameSite session cookie. Treat QR images, controller URLs, admin
URLs, and active browser sessions as credentials. A party that obtains one of
those tokens receives its associated role until the extension restarts.

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
- Do not publish or forward QR, controller, or admin URLs.
- Treat tunnel URLs as temporary secrets.
- Close Cloudflare/ngrok/reverse-proxy tunnels when the session ends.
- Restart the extension to invalidate all issued session tokens.

## Command Safety

Commands are JSON messages handled by project code. Read operations are
available to viewers; Live and mapping writes require a controller or admin;
whole-project configuration and server administration require an admin. They
must not call shell commands or write outside Ableton extension storage. New
commands must be classified, return diagnostics, and have tests.
