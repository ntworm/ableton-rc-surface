# Install and first-run guide

This document walks you through installing **Ableton RC Bridge** on
Windows or macOS, scanning the QR code from your phone, and getting
your first pad-to-Live mapping working.

If you only want the short version: see the [Quick start](../README.md#quick-start)
in the README.

## 1. Prerequisites

You need:

- **Ableton Live 12 or newer** with the Extensions SDK host enabled
  (this is the default in recent Live versions).
- A computer and a phone on the **same WiFi network**.
- A modern browser on the phone: Chrome 90+, Safari 15.4+, Edge 90+,
  or any Chromium-based Android browser.
- Optional, for advanced features: a phone with a working gyroscope
  and accelerometer (almost all modern phones).

The extension itself is built on the
[Ableton Extensions SDK](https://github.com/ableton-extensions/sdk)
1.0.0-beta. No additional runtime is required on the host computer.

## 2. Download and install

### From a release (recommended)

1. Download `Ableton-RC-Bridge-0.3.1.1.ablx` from the
   [Releases page](https://github.com/<owner>/<repo>/releases).
2. Double-click the file. Live's extension installer opens.
3. Click *Install*. Live places the file under
   `User Library / Extensions`.
4. Restart Live if it was already running.

### From source

If you cloned the repository and ran `npm run package`, you'll have
the same `.ablx` file in the project root. Install it the same way
(double-click).

## 3. Start the bridge

1. In Live, open the **Extensions** menu (or `Cmd-Shift-A` / `Ctrl-Shift-A`).
2. Look for **Ableton RC Bridge** and click *Show panel* (or *Open*,
   depending on your Live version).
3. A modal window appears with **two QR codes** side by side: one
   for the Performance client (the existing pads/knobs/sensors
   controller at `/`) and one for the Mix client (v0.3.1+, the
   structure-aware mobile mixer at `/mix/`). The two URLs share the
   same origin, port, and HTTPS certificate. An admin URL is also
   shown as a small `admin ↗` link under the Performance QR; the
   admin dashboard at `/static/admin/` is the same as in v0.3.0.

The server picks a random free port and binds to `0.0.0.0`, so any
device on the same LAN can reach it.

## 4. Connect your phone

Pick one:

- **Scan the QR code** with the phone's camera app. It will open in
  your default browser.
- Or **type the phone URL manually** in the phone's browser address
  bar.

The URL looks like `https://192.168.x.y:12345/`.

### The "Your connection is not private" warning

Because the bridge uses a self-signed certificate unique to your
install, the phone's browser will warn you the first time. This is
expected. To proceed:

- **Chrome on Android**: tap *Advanced* → *Proceed anyway*.
- **Safari on iOS**: tap *Show details* → *visit this website* → *Visit*.
  iOS only shows the bypass on iOS 15.4+; older versions block the
  connection entirely and you will not be able to use the camera or
  microphone.

Your browser will remember the decision for the lifetime of the cert
(about a year, see [Certificate lifecycle](#certificate-lifecycle)
below).

### What you see

A landscape-only controller. The phone is best held with both thumbs
on the screen in landscape orientation; a portrait overlay will show
otherwise.

The first time you open the app, your browser will ask for permission
to access sensors (motion, orientation). Tap *Allow* — these are
required for the sensor panel and the level bubble.

## 5. Sanity check: hello, Live

With the phone connected:

1. In Live, add a new MIDI track and arm it.
2. On the phone, tap **pad 1** (top-left of the 4x3 grid).
3. The pad lights up blue. In Live, you should see a momentary note
   appear in the armed clip slot.

If you see the note, the bridge is working. From here:

- Open the **admin dashboard** by clicking the second URL the panel
  showed (or navigating to `/static/admin/` on the same host).
- In the admin dashboard, click *Mappings* to wire pads / knobs /
  faders / ribbons to Live parameters.

## 6. OS-specific notes

### Windows

- Live's persistent storage is under
  `%USERPROFILE%\Documents\Ableton\User Library\`.
- The bridge's generated certs live under
  `…\User Library\Preferences\Extensions\<extension-id>\certs\`.
- Windows Defender SmartScreen might block the `.ablx` install the
  first time. Click *More info* → *Run anyway*.

### macOS

- Live's persistent storage is under
  `~/Music/Ableton/User Library/`.
- The certs live under
  `~/Music/Ableton/User Library/Preferences/Extensions/<id>/certs/`.
- The first time you double-click the `.ablx`, macOS may show a
  *cannot be opened because the developer cannot be verified* dialog.
  Right-click the file, choose *Open*, then *Open* again in the
  confirmation prompt.

## 7. Tunneling (optional)

The bridge binds to your local network only. To use the phone over the
internet (different WiFi, 4G/5G, etc.) you need a tunnel. The bridge
speaks plain HTTPS, so any TCP tunnel works.

### Cloudflared (free, recommended)

```bash
# install once: https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/
cloudflared tunnel --url http://localhost:<port>
```

Cloudflared prints a `https://*.trycloudflare.com` URL. Open that URL
on your phone. Camera and microphone work because the cert is publicly
trusted.

### ngrok

```bash
ngrok http <port>
```

`ngrok http` gives a `https://*.ngrok.io` URL with a trusted cert.
Free tier is fine for personal use.

### Self-hosted reverse proxy

If you have a VPS and a domain, point a subdomain at it and reverse
proxy to the bridge's port. Add `proxy_set_header Upgrade $http_upgrade;`
and `proxy_set_header Connection "upgrade";` for the WebSocket
upgrade to work.

## 8. Certificate lifecycle

The bridge generates a fresh self-signed cert on first run, using
the `selfsigned` npm package. The cert:

- Is RSA 2048-bit, signed with SHA-256.
- Has a one-year validity (`notAfterDate` defaults to one year from
  generation).
- Includes `subjectAltName` entries for `localhost` and `127.0.0.1`.
  Your LAN IP is *not* in the SAN, but most browsers will accept
  the cert anyway when the cert is otherwise trusted (i.e. you
  accepted the warning).
- Is stored with `0600` permissions in the Live storage directory.

To force a new cert, stop Live, delete the `certs/` folder under
`Preferences/Extensions/<id>/`, and restart.

## 9. Troubleshooting

### Phone shows "ERR_CONNECTION_REFUSED"

- The phone and the computer are on different WiFi networks. Connect
  both to the same one.
- Some routers (especially guest networks) isolate clients. Use the
  main SSID, not a guest one.

### Phone shows "Your connection is not private" and there's no bypass

- iOS 14.5 and below cannot accept self-signed certs for HTTPS
  websites. Use a tunnel (see [Tunneling](#tunneling-optional)) or
  upgrade your phone.
- Some corporate-managed phones have admin policies that block
  certificate bypass. Use a personal phone.

### Camera and microphone don't work

- Make sure the phone URL is **HTTPS**, not HTTP. The camera and
  microphone APIs are gated on Secure Context.
- The phone must be able to reach `cdn.jsdelivr.net` to load the
  MediaPipe runtime. On offline-only networks, the camera panel
  will show an error. (An offline-bundled MediaPipe is on the
  v0.5 roadmap.)

### Latency is bad

- Both devices should be on 5 GHz WiFi, not 2.4 GHz.
- The bridge sends 30 Hz snapshots; on a slow LAN this can drop
  to 15-20 Hz. The admin dashboard shows the actual snapshot rate.
- Some phones throttle background WebSocket connections; keep the
  phone unlocked and the browser in the foreground during performance.

### Live crashes when the extension loads

- Check the Live log: `Help` → *Show Log*.
- Most common cause: a stale cert in the storage directory with the
  wrong format. Delete `certs/` and let the extension regenerate.

## 10. Uninstall

In Live: *Extensions* menu → *Manage Extensions* → remove the entry.
Then delete the cert folder under
`Preferences/Extensions/<extension-id>/` if you want a clean slate.
