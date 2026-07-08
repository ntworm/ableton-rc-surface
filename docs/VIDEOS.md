# Project Videos

Project videos for the Ableton RC Surface launch. Mark as **Final** only when
the edit is locked and the audio + subtitles check out.

| ID  | Title              | File / Source                                  | Status         | Final on    |
| --- | ------------------ | ---------------------------------------------- | -------------- | ----------- |
| V1  | Install tutorial   | `recordings/01_install_open_narrated.mp4`     | ✅ Final       | 2026-07-06  |
| V2  | Open + connect     | _(pending)_                                    | ⏳ Not started | —           |
| V3  | Performance demo   | _(pending)_                                    | ⏳ Not started | —           |

## V1 — Install tutorial (`01_install_open_narrated.mp4`)

Source recording: `recordings/01_install_open.mp4` (screen capture).

Voice: `en-US-AndrewNeural` (Edge-TTS). Ambient track mixed under the voice
at -18 dB with a 1 s fade-in.

Narration blocks:

| Block | Window   | Topic                       |
| ----- | -------- | --------------------------- |
| 00    | 00:02–00:08 | Intro                     |
| 00b   | 00:09–00:14 | Live Suite Beta requirement |
| 01    | 00:18–00:34 | Drop the `.ablx` into the User Library |
| 02    | 00:36–00:45 | Open the set and find RC Surface in Extensions |
| 02b   | 00:45–00:50 | "Go to Extensions and select Ableton RC Surface Panel" |
| 03    | 00:50–01:03 | Scan the QR code from the phone |

Render pipeline: `recordings/render-install-narrated.ps1` re-renders the MP4
from the source capture + Edge-TTS blocks. Re-run the script after copy or
wording changes — it is idempotent and rebuilds everything under
`recordings/_build_narrated/`.

## V2 / V3

Not started. Once these land, add a row above and link the source MP4.
