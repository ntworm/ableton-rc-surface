# Frequently Asked Questions

> Answers to the most common questions about **Ableton RC Surface**.
> Last updated: July 2026.

## Contents

- [Compatibility](#compatibility)
- [Install and first use](#install-and-first-use)
- [Features and functionality](#features-and-functionality)
- [Privacy and security](#privacy-and-security)
- [Community and contribution](#community-and-contribution)

---

## Compatibility

### Does it work with Live 11?

No. The documented release target is Ableton Live 12.4.5+ Suite (Beta)
because the project uses the Ableton Extensions SDK host.

### Does it work with FL Studio / Logic / Bitwig / Reaper?

No. The extension code is Live-specific. The phone UI could be reused by
someone who writes a different host, but this project does not provide that
host.

### Which Ableton Live versions are supported?

The documented release target is **Ableton Live 12.4.5+ Suite (Beta)** with
Extensions SDK support.

### Does it work on Windows and Mac?

Target support is Windows 10/11 and macOS on Intel or Apple Silicon.
Linux is not supported because Ableton Live does not run on Linux.

### Does it work on iPhone and Android?

Target support is iOS 15.4+ Safari and modern Chromium-based Android
browsers. Touch, sensors, microphone, and camera require browser
permissions. iOS 14.5 or below cannot accept the self-signed HTTPS
certificate, so the connection will fail.

Run the tester checklist on real iOS and Android devices before treating a
build as public-release validated.

### What is the latency? Is it usable for live performance?

The phone client targets a 30 Hz control stream and is designed for
low-latency local Wi-Fi. Actual latency depends on the host, phone,
browser, router, and network congestion. Use 5 GHz Wi-Fi for the most
consistent results, and test the exact setup before a show.

---

## Install and first use

### How do I get started?

1. Install Ableton Live 12.4.5+ Suite/Beta with Extensions SDK support.
2. Use the `.ablx` from the tester kit or release package you received.
3. Double-click the `.ablx`; Live offers to install it.
4. Open Ableton RC Surface from Live's Extensions menu.
5. Scan the QR code with your phone.
6. Accept the self-signed certificate warning once.

### Do I need an internet connection?

For core controls, no. The bridge runs on your local network, and the phone
and computer running Live only need to be on the same Wi-Fi. No telemetry or
project data is sent to a cloud service.

Camera hand tracking also works offline. The build bundles the MediaPipe Hands
runtime and model files with the extension, and processing stays in the phone
browser.

### Do I need to know how to code to use it?

No. Install the extension, scan the QR, and play. Coding is only needed if
you want to customize the phone UI or contribute code.

### My antivirus is flagging the `.ablx`. Is it malware?

No. Local WebSocket, HTTPS, and generated certificates can look unusual to
security software. The project is source-available and the `.ablx` contains the
extension code plus static browser assets, not bundled private keys or
certificates.

---

## Features and functionality

### Do the pads/knobs work with any MIDI device in Live?

They work with Live targets exposed to the extension: mixer values, track
state, device parameters, and supported note/clip actions. For device
control, tap **MAP** on the phone and use **Bind** to choose a Live
parameter. The older panel/admin mapping editors are still useful for
inspection and troubleshooting.

### Can I create mappings from the phone?

Yes. Tap **MAP** near the BPM display, select a highlighted control, then
choose one of the two main actions:

- **Bind** maps the selected phone control to song tempo, main/master,
  normal track, return track, mixer, device, or parameter targets.
- **Trigger Note** maps the selected phone control to a MIDI note on a
  chosen MIDI track through `RC-Midi-Receiver.amxd`.

If Trigger Note cannot add the receiver automatically, place
`RC-Midi-Receiver.amxd` on the MIDI track manually and retry.

### How many phones can connect at the same time?

Multiple browser clients can connect on the same LAN and are isolated by
client ID. There is no fixed server-side phone limit, but practical limits
depend on CPU, browser load, and Wi-Fi quality. Reference testing has not
validated a public maximum, so do not advertise a specific phone count
until real multi-device tests are complete.

### Does the phone vibrate when I hit a pad?

No. Haptics/vibration are retired in the current test series to keep the UI
predictable across iOS and Android.

### Can I customize the phone controller UI?

Yes. The phone code is plain HTML/CSS/JavaScript under `static/phone-v3/`.
See `docs/CUSTOMIZATION.md`.

### Can I save and share mappings?

Save and load local mapping presets, yes. Export/import of shareable
mapping bundles is not implemented yet.

### How do I update to a new version?

For tester builds, use the newest kit shared by the maintainer. Download
the new `.ablx`, double-click it, and let Live replace the old version.
Public release/update instructions will be finalized when the repository is
published.

---

## Privacy and security

### Does the data go to the cloud?

No telemetry, analytics, or project data is sent to a cloud service. The
bridge traffic stays between the host and browser clients on your network
unless you intentionally set up a tunnel. Camera and microphone streams are
processed in the browser and are not sent as raw media to the extension.
MediaPipe runtime/model files are served by the extension over the same local
connection; camera hand tracking does not require a public CDN.

### Is there a privacy policy?

Yes: `docs/PRIVACY.md`.

### Are there any security risks in leaving this running?

Yes, in the same way any local control surface has risk. The bridge opens a
LAN-reachable port and accepts supported WebSocket commands from browser
clients that can reach the bridge URL. Run it only on trusted home/studio
Wi-Fi, and close it when you are done. Do not expose it to public networks
or tunnels unless you understand the risk. The full threat model is in
`docs/SECURITY.md`.

### Do I have to pay? Is there a Pro version?

No. The project is source-available under the PolyForm Noncommercial 1.0.0
license, and has no Pro version or
locked features. The Gumroad page is **pay what you want** (suggested R$25,
minimum R$0). R$0 is the default so cost is never a barrier. See
[`FUNDING.md`](../FUNDING.md) for details. Only trust links published in
this repository's README and release notes.

---

## Community and contribution

### Is there a Discord or community to talk about it?

No dedicated community exists yet. Once public, use the official Ableton
Discord `#extensions` channel only if its current rules allow sharing the
project there.

### How do I contribute?

For pre-public builds, send bugs and patches directly to the maintainer who
shared the kit. Once the repository is public, contributions should move to
issues and pull requests.

## See also

- [`INSTALL.md`](./INSTALL.md) - detailed install guide
- [`PRIVACY.md`](./PRIVACY.md) - full privacy policy
- [`SECURITY.md`](./SECURITY.md) - threat model and security design
- [README](../README.md) - project overview
