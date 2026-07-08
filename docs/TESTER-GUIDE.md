# Tester Guide

Thank you for testing Ableton RC Surface v0.5.7.

This kit contains the production-equivalent `.ablx` and the docs you need
to install it, open the panel, connect your phone, and report any issues
you find.

## What's in the kit

| File | Purpose |
|---|---|
| `Ableton-RC-Surface-0.5.7.ablx` | The extension to install in Live |
| `RC-Midi-Receiver.amxd` | Max for Live receiver device for MIDI trigger notes |
| `README.md` | Quick start and architecture summary |
| `LICENSE` | MIT license text |
| `CHANGELOG.md` | Version history |
| `CONTRIBUTING.md` | Development workflow and contribution notes |
| `docs/README.md` | Canonical docs index |
| `docs/INSTALL.md` | Step-by-step install and phone connection |
| `docs/USER-GUIDE.md` | Phone controller usage guide |
| `docs/FAQ.md` | Common questions and answers |
| `docs/PRIVACY.md` | Local data flow and third-party runtime notes |
| `docs/SECURITY.md` | Threat model, certificate policy, network behavior |
| `docs/CUSTOMIZATION.md` | Controls, sensors, mappings, extension points |
| `docs/TESTER-GUIDE.md` | This file |
| `docs/AGENT_GUIDE.md` | Maintainer/agent workflow rules |
| `SHA256SUMS.txt` | File hashes for integrity checks |

No source maps, no test files, no certs, and no keys are included. You can
inspect the zip before installing.

## Manual validation status

Automated tests can verify build, packaging, protocol helpers, and static
client logic. They do not prove that a release works in Ableton Live with
real phones. Treat a build as release-ready only after this checklist has
been completed on the target Ableton, OS, browser, and phone matrix.

## Install the `.ablx`

1. **Quit Ableton Live** if it is running.
2. **Double-click** `Ableton-RC-Surface-0.5.7.ablx`.
3. Live's extension installer opens. Click **Install**.
4. Live places the file under your **User Library / Extensions**.
5. **Restart Live** if it was already running.

## Install Optional Dependencies

### 1. AbletonOSC (for Deep Sync features)
To test beat-accurate LFO/Stutter sync, metronome flash, and locator transport overlays:
- Download the repository: [AbletonOSC GitHub](https://github.com/ideoforms/AbletonOSC) (Download ZIP).
- Place the extracted `AbletonOSC` folder into your Live's `MIDI Remote Scripts` directory.
- In Live Preferences -> **Link/Tempo/MIDI**, select **AbletonOSC** as a Control Surface.

### 2. RC-Midi-Receiver.amxd (for MIDI Trigger Notes)
To test trigger note mapping functionality:
- Copy the `RC-Midi-Receiver.amxd` file (included in this ZIP kit) into your Ableton **User Library** (e.g., under `User Library/Presets/MIDI Effects/Max MIDI Effect/`).

### Windows

The extension is signed by the local developer cert Ableton generates
on first install. Windows Defender SmartScreen may block the install
the first time. Click **More info** → **Run anyway**.

### macOS

The first time you double-click the `.ablx`, macOS may show a
*cannot be opened because the developer cannot be verified* dialog.
Right-click the file, choose **Open**, then **Open** again in the
confirmation prompt.

## Open the bridge

1. In Live, open **Extensions** (or `Cmd-Shift-A` / `Ctrl-Shift-A`).
2. Look for **Ableton RC Surface** and click **Show panel**.
3. A window opens with a **Performance QR** for the phone client
   (controller with the MIX tab built in). An **admin** link sits
   under the Performance QR. No separate Mix QR is exposed in v1.
4. The server binds a random free port to `0.0.0.0`.

## Connect your phone

1. **Scan the Performance QR** with your phone's camera.
2. Your phone's browser opens `https://<your-lan-ip>:<port>/`.
3. The browser warns **Your connection is not private** because the
   bridge uses a self-signed certificate unique to your install. This
   is expected.
   - **Chrome on Android**: tap *Advanced* → *Proceed anyway*.
   - **Safari on iOS**: tap *Show details* → *visit this website* → *Visit*.
4. Once accepted, the controller loads. Hold your phone in landscape
   with both thumbs on the screen.

For full detail see `docs/INSTALL.md`.

## Test checklist

Walk through this list at least once per release. Mark any failure so
the report below is precise.

- [ ] **Install**: `.ablx` installs without errors.
- [ ] **Panel opens**: the QR + admin dialog renders the Performance QR.
- [ ] **Phone connects**: scanning the Performance QR lands on the
      controller page after accepting the cert.
- [ ] **Phone MIX tab works**: open the MIX tab inside the Performance
      client and verify the structure-aware mobile mixer responds to
      bindings.
- [ ] **Mobile MAP opens**: tap **MAP** near the BPM display. Verify the
      current performance page remains visible, mappable controls show
      the MAP highlight, and normal performance touches are intercepted.
- [ ] **Bind from phone**: select **knob-1** or **fader-1**, tap
      **Bind**, browse the hierarchical tree, and bind it to a device
      parameter. Leave MAP mode and verify the Live parameter follows.
- [ ] **Return/Main targets**: from the phone picker, verify **Song /
      Main / Master**, **Tracks**, and **Return Tracks** groups appear.
      Bind one return-track or main/master mixer target if the Live set
      contains one.
- [ ] **XY axis mapping**: select an XY pad in MAP mode, switch between
      X and Y axes, bind both axes, then move the XY pad and verify both
      mapped values move independently.
- [ ] **Curve editor**: on a continuous target, adjust **Curve**,
      **Drive**, **Comp**, **In/Out Min/Max**, and **Smooth**. Verify the
      canvas curve and moving dot update while the control moves.
- [ ] **Toggle/threshold mode**: change a target mode to **Toggle** and
      verify **Threshold** appears and the mapped output follows the
      threshold behavior.
- [ ] **Trigger Note**: select **pad 1**, tap **Trigger Note**, choose a
      MIDI track, set Pitch/Octave and Velocity, arm the track, and verify
      the note fires. If automatic receiver insertion fails, manually add
      `RC-Midi-Receiver.amxd` to the MIDI track and retry.
- [ ] **Mapping presets**: save a mobile mapping preset, load it, delete
      it, and verify mappings refresh without reconnecting the phone.
- [ ] **Snapshots morph mappings**: capture two different states for a
      mapped LFO, Stutter, knob, or fader. Recall a snapshot with a
      visible transition time and verify the mapped Ableton parameter
      moves during the transition instead of jumping only at the end.
- [ ] **Audio sensor**: in the phone app, enable the audio panel. Verify
      `sensor.audio.rms` and `sensor.audio.pitch` move when you whistle
      or play music.
- [ ] **Vision sensor**: with the phone able to reach `cdn.jsdelivr.net`,
      enable the camera panel. Show one hand. Verify `sensor.vision.fist`,
      `sensor.vision.open`, `sensor.vision.fingers` track correctly.
- [ ] **Reconnect**: kill the phone browser tab, reopen the QR link;
      verify the controller reconnects without restarting Live.
- [ ] **Self-test cert**: verify the connection survives a Live restart
      without re-prompting (cert is cached for the lifetime of the cert,
      about a year).
- [ ] **No haptics**: confirm no vibration prompts appear and no
      haptic settings UI is exposed. Haptics are retired in this test
      series.

## Report a bug

Send a direct report to the maintainer who shared this tester kit.
There is no public issue tracker for this pre-public test build.

Please include:

- **OS**: Windows 11 / macOS 14 / iOS 17 / Android 14 / etc.
- **Ableton Live version**: Help → About Live.
- **Extension version**: 0.5.7 (this kit).
- **Phone browser**: Chrome 124 / Safari 17 / Edge 124 / etc.
- **Phone model** (only if vision / sensor behavior is involved).
- **Steps**: the exact sequence you ran before the bug.
- **Expected**: what you expected to happen.
- **Actual**: what actually happened.
- **Screenshot or short screen recording** if the bug is visual.
- **Logs**: Live log (Help → Show Log) plus the browser console
  (Desktop: F12 → Console; phone: use a remote-debug session or
  a desktop browser with the same URL).

If a panel UI element does not behave as expected, mention the exact
button or control and the value you tried to set.

## Verifying the kit

If you received this kit over a chat or email, you can verify the
contents with:

```bash
sha256sum -c SHA256SUMS.txt
```

(or `shasum -a 256 -c SHA256SUMS.txt` on macOS). All listed files should
report OK.

## Uninstall

In Live: **Extensions** → **Manage Extensions** → remove the entry.
Then delete the cert folder under
`Preferences/Extensions/<extension-id>/` if you want a clean slate.

## License

MIT. See source repository for the full text.
