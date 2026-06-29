# Mix View — Specification (Ableton RC Bridge v0.3.1)

Status: IMPLEMENTED. See `REVIEW_FINAL.md` for the independent
review that approved the concept (verdict: CONCERNS, all concerns
resolved before implementation). See `PLAN.md` for the phased
implementation plan and the per-phase commit log.

This document is the v0.3.1 source of truth for what was actually
shipped. It is a tightened version of the original DRAFT and
reflects the review-driven adjustments below.

Author: ARGOS (acting on behalf of worm / ntworm).
Date: 2026-06-12.

## 1. Summary

A second, optional web client served by the Ableton RC Bridge Live
extension, alongside the existing performance client (`/phone-v3/`).
The Mix View reads the structure of the currently open Live set
(tracks, devices, parameters, sends) and renders a mobile-first UI
that mirrors that structure on the phone. The user can mix the set
from the phone without manually mapping controls.

## 2. Goals (v0.3.1)

- Show every track in the open set: regular, group, return, master.
- For each track, expose: volume, pan, mute, solo, sends, devices.
- For each device, expose a templated view of its observable
  parameters.
- Read AND write: changes from the phone affect Live; changes in
  Live reflect on the phone within the existing 30 Hz snapshot loop.
- Coexist with the existing performance client (`/phone-v3/`)
  without modifying it.
- Coexist with the existing admin dashboard (`/static/admin/`)
  without modifying it.

## 3. Non-goals (v0.3.1)

- Clips, session view, arrangement view, timeline.
- Drag-and-drop reordering of devices, tracks, or sends.
- VST/AU parameter discovery beyond what the SDK + `live.object`
  introspection expose.
- Persistence of UI state across phone reloads (track selection,
  expanded state).
- Push notifications, deep linking, install-as-PWA plumbing.
- Offline mode. (HTTPS on the LAN is required, as today.)

## 4. Naming

- URL path: `/mix/` (HTTP, redirects to `/static/mix/`) and
  `/mix/ws` (WebSocket).
- Client code location: `static/mix/`.
- Codename: **Mix View**.
- Version: 0.3.1 (additive patch on 0.3.0).

## 5. Personas and primary use case

Primary: a producer standing away from the laptop, holding the
phone, who needs to:

- See which tracks exist and which are soloed / muted.
- Adjust volume and pan of one or more tracks.
- Adjust send levels.
- Open a device and tweak one or two parameters (e.g. a compressor's
  threshold, an EQ band's gain).

Secondary: a producer exploring the project structure for
navigation/orientation, before deciding what to do on the laptop.

## 6. UX

Three views, navigated with the phone's back button (browser
history-driven, no router library).

- **Track List** (entry view): one row per track, ordered regulars
  then groups, then returns, then master, in the order the server
  reports them. Each row shows: name, type badge, coarse volume
  readout.
- **Expanded Track**: volume slider, pan slider, mute/solo
  toggles, sends list, device list. Returns and master render the
  layout with the appropriate controls disabled (returns do not
  accept writes in v0.3.1; master has no sends).
- **Device Detail**: parameters rendered by the Generic template
  (continuous slider, enum stepper, two-state toggle, disabled
  static value). Back button returns to the Expanded Track.

Visual style: shares the existing design language with `phone-v3`
(dark theme, square controls, monospaced labels, delta-diffed
updates to avoid DOM thrash).

## 7. Server changes (additive only)

### 7.1 New routes

- `GET /mix/`, `GET /mix/index.html` — 302 redirect to
  `/static/mix/`. The client lives at `/static/mix/index.html`,
  which is served by the existing static-file handler.
- `GET /mix/ws` — WebSocket upgrade, mode = `mix`. Bound to a
  dedicated `WebSocketServer` (no auth, no token).
- The existing `/ws` (performance), `/admin/ws` (admin), and
  `/static/phone-v3/`, `/static/admin/`, `/health`, `/commands`,
  `/test` routes remain untouched.

### 7.2 Mode flag

- The mode (`performance` | `admin` | `mix`) is bound to the
  WebSocket at upgrade time, derived from the URL path. It lives
  on `TrackedClient.mode` (new field; `isAdmin` is kept for
  back-compat and computed as `mode === "admin"`).
- No token, no per-QR auth, no mode-binding at QR time. v0.3.1
  ships the same open model that v0.3.0 already uses for the
  performance and admin WebSockets.

### 7.3 Token strategy

DEFERRED. The original draft assumed a per-QR token system, but
the review confirmed none exists in v0.3.0. Adding one in the
Mix View would be a separate auth subsystem, not a Mix View
feature. v0.3.1 ships without token binding; a follow-up spec
can add it without breaking compatibility (a v0.3.1 Mix View
client is happy to send the token once the server starts
issuing one).

### 7.4 Tiered snapshot loop (NEW)

The server runs three self-gated intervals when at least one mix
client is connected:

  - **structure** (0.5 Hz): track list with type
    (regular/group/return/master) and parent group id. Rebuilt
    every 2s; only sent to a client when the list actually
    changed.
  - **mixer** (5 Hz): per-track volume, pan, mute, solo, and
    send list. Rebuilt every 200ms; only sent to a client when
    the JSON value differs from the last send.
  - **params** (2 Hz): parameter descriptors of the user's
    currently expanded track/device. Capped at
    `MIX_MAX_PARAMS_PER_TICK` (64) per client per tick; the
    remaining parameters rotate on the next tick so very large
    devices still converge within seconds.

The phone-v3 phone→server 30 Hz snapshot loop and the existing
1 Hz `live_state` check are untouched. The tiered loop is a
separate server-side Live read pipeline; it does not piggy-back
on anything v0.3.0 uses.

## 8. Device templates

### 8.1 Generic template (v0.3.1 only)

The Generic template is the contract for v0.3.1. It renders any
parameter whose descriptor exposes at least
`name`, `min`, `max`, `defaultValue`, `isQuantized`, `valueItems`,
`getValue`, and `setValue`. From those, the template branches:

  - `isQuantized === true` and `valueItems.length > 1` -> enum
    stepper (slider with `step = 1` and `max = N-1`).
  - `isQuantized === true` and `valueItems.length === 1` ->
    two-state toggle (checkbox).
  - `isQuantized === true` and `valueItems.length === 0` ->
    continuous slider with a default step (the SDK can be
    integer-quantised with no label; we treat it as continuous).
  - `isQuantized === false` -> continuous slider, step 0.001.
  - `setValue` missing or `isReadOnly === true` -> disabled row
    with a static value.

A field the SDK does not document (e.g. `displayValue`, `unit`,
Ableton `class` like `Eq8`, track `color`) is NOT included in
the wire shape. The client falls back gracefully when a value
field is missing or undefined.

### 8.2 Specialised templates (post-0.3.1)

Out of scope for v0.3.1. The Generic template is the only
template shipped. Specialised templates are blocked until the
implementation proves a stable class identifier exists; the
review flagged that the SDK's visible `Device.name` is the only
class-like field and that user-renamed devices make name-based
mapping fragile. A future v0.3.2+ can revisit this once
`live.object` exposes a stable Ableton class string.

## 9. Snapshot data shape (mix mode)

Per track:

```
{
  "id": <string>,
  "name": <string>,
  "type": "regular" | "group" | "return" | "master",
  "color": <number | null>,
  "volume": <number 0..1>,
  "pan": <number -1..1>,
  "mute": <boolean>,
  "solo": <boolean>,
  "sends": [
    { "id": <string>, "name": <string>, "level": <number 0..1> }
  ],
  "devices": [
    {
      "id": <string>,
      "name": <string>,
      "class": <string>,            // e.g. "Eq8", "Compressor2"
      "parameters": [
        {
          "id": <string>,
          "name": <string>,
          "value": <number 0..1>,
          "displayValue": <string>, // e.g. "-12.0 dB"
          "range": { "min": <number>, "max": <number> },
          "readOnly": <boolean>
        }
      ]
    }
  ]
}
```

## 10. Command channel (phone -> server)

JSON messages, each with a `refId` echoed back in the ack:

- `{type: "mix.setVolume", refId, trackId, value: 0..1}`
- `{type: "mix.setPan", refId, trackId, value: -1..1}`
- `{type: "mix.toggleMute", refId, trackId}`
- `{type: "mix.toggleSolo", refId, trackId}`
- `{type: "mix.setSend", refId, trackId, sendId, value: 0..1}`
- `{type: "mix.setParam", refId, deviceId, paramId, value: 0..1}`

Server -> phone:

- `{type: "mix.ack", refId, ok: true}`
- `{type: "mix.error", refId, ok: false, reason: <string>}`

The server is the source of truth for authorisation. The phone
client trusts the server.

## 11. Security

- The HTTPS + self-signed cert model is unchanged.
- The mix client uses the same WSS upgrade as the performance
  client.
- A QR code's token is bound to a single mode at generation time;
  the server rejects cross-mode reuse with a 4xx close.
- The Mix View does not request any new host permission beyond
  what the SDK already grants to the Live extension.
- Camera and microphone are NOT used by the Mix View, so the
  secure-context requirement is satisfied trivially (HTTPS already
  provides it for the page itself).

## 12. Compatibility and migration

- v0.3.0 users: no change. The existing `.ablx`, the existing
  `/phone-v3/` client, the existing admin dashboard, and the
  existing single-QR panel continue to work exactly as before.
- v0.3.1 is a strict superset on disk and on the wire. Downgrading
  from v0.3.1 to v0.3.0 is not supported (a v0.3.0 Live has no
  knowledge of the `/mix/` route and will simply ignore it).
- Versioning: `manifest.json` and `package.json` both bump from
  `0.3.0` to `0.3.1`. README and INSTALL are amended (not rewritten).

## 13. Panel UI

- The Live extension panel renders two QR codes side by side.
- Left QR: "Performance" (existing flow, unchanged).
- Right QR: "Mix" (new flow, opens `/mix/`).
- Both QRs share the same origin, port, and certificate; only the
  path differs.
- The admin dashboard mirrors the same dual layout, with a label
  under each QR.

## 14. Risks and mitigations

| # | Risk | Mitigation |
|---|------|------------|
| R-1 | `live.object` may not expose parameters of third-party VST/AU devices. | Generic template renders what is exposed; the rest stays hidden. Documented limitation. |
| R-2 | Large sessions (50+ tracks, 10+ devices each) may exceed the 30 Hz budget. | Delta diffing per (client, mode); per-field throttling; client-side backpressure. |
| R-3 | Renaming a track mid-session could orphan the user's selection. | Server addresses everything by `id`, not `name`. Name is for display only. |
| R-4 | The Mix View and the Performance View could issue conflicting writes. | Server serialises writes; each command carries a `refId`; the snapshot is the truth. |
| R-5 | A user with a stale page could write to a device that was removed. | Server returns `mix.error` with `reason: "device_not_found"`; client surfaces a toast and refreshes. |
| R-6 | Two phones opening the Mix View could feel "weird" (who is in charge?). | Each phone gets an independent read; writes are serialised on the server. No additional UX for v0.3.1. |

## 15. Resolved open questions

All five open questions from the original DRAFT were resolved
in REVIEW_FINAL.md before implementation. The resolutions ship
in v0.3.1:

  - OQ-1: Generic template is one renderer that branches per
    parameter (continuous / enum / toggle / disabled). The
    branch is decided on the client from the descriptor's
    `isQuantized` and `valueItems.length`, so the wire shape
    never carries an explicit `kind`.
  - OQ-2: tempo / signature / metronome are NOT in v0.3.1.
    Session-level state deserves a separate spec.
  - OQ-3: group rows render the group's own fader/mute/solo,
    matching Live's behaviour, not an aggregate.
  - OQ-4: devices are ordered by chain position (numeric
    suffix of `:dev:N`), matching Live.
  - OQ-5: the "go to performance" link is out of scope. A
    direct link is easy but introduces mode/session/auth
    questions; v0.3.1 stays focused.

## 16. Out of scope, explicitly

- iPad-specific layout (still works in landscape, but no split
  view).
- Localisation / i18n.
- Theme switching (light mode).
- Saving the user's last track selection across reloads.
- PWA / installable web app.
- Clips, session view, arrangement view, timeline.
- Drag-and-drop reordering of devices, tracks, or sends.
- VST/AU parameter discovery beyond `name / min / max /
  defaultValue / isQuantized / valueItems / getValue / setValue`.
- Per-target per-QR auth tokens (see section 7.3).
