CONCERNS

CONCERN: SPEC.md section 7.1, section 7.2 and PLAN.md Phase 1 describe existing performance routes as `/phone-v3/` and `/phone-v3/ws`, but the current project serves the performance client from `/static/phone-v3/` via root redirect and the phone connects to `/ws`. Adding `/mix/ws` is fine, but the spec's mode model is anchored to routes that do not exist. Resolve this by either keeping `/ws` as legacy performance mode and adding only `/mix/ws`, or explicitly adding `/phone-v3/ws` as a compatibility alias while leaving `/ws` untouched.

CONCERN: SPEC.md section 7.3 and PLAN.md Phase 1 assume an existing per-QR token generation and token-validation path. The current panel builds a plain QR URL and there is no token/auth mechanism in `src/extension.ts` or the clients. This is not a minimal extension; it is a new auth subsystem and likely requires client URL/query handling, in-memory token state, expiry policy, and a legacy no-token compatibility decision. Either remove token binding from v0.3.1 or add a separate early phase for token design and migration.

CONCERN: SPEC.md section 7.4 and PLAN.md Phase 2 assume an existing server-side 30 Hz snapshot loop plus `toPerformanceSnapshot`. The current 30 Hz loop lives in `static/phone-v3/app.js`: the phone sends snapshots to the server/admin. The server only pushes hello, haptics, playhead state, and a 1 Hz `live_state` check. Mix View needs a new server-side Live polling/snapshot loop, not a split of an existing adapter. Define the source, cadence, backpressure, and SDK read strategy before implementation.

CONCERN: SPEC.md section 2 and section 9 require Live-to-phone reflection within 30 Hz for tracks, sends, devices, and parameters, but the SDK surface in use is getter-based and many values are async (`DeviceParameter.getValue()`). Polling every parameter every 33 ms will probably not scale and could stress the Extension Host. The spec needs a tiered snapshot model, for example track mixer state at a faster cadence, selected/expanded device parameters at a slower cadence, and structural rescans on a lower-frequency interval or explicit refresh.

CONCERN: SPEC.md section 9 promises stable string `id` fields for tracks/devices/parameters, but the plan does not define the ID source or lifecycle. The SDK exposes opaque `handle.id` values, while the current implementation mostly addresses targets by indexes. The Mix command channel cannot be robust across rename, delete, reorder, return/master inclusion, or reload until the spec says whether IDs are `handle.id` strings, composite paths, or server-issued session IDs, and how stale IDs are invalidated.

CONCERN: SPEC.md section 2 and section 9 say every regular, group, return, and master track is shown, but the current code only uses `song.tracks`, and the SDK documents that `song.tracks` excludes return tracks and the main track. The spec should explicitly require `song.tracks`, `song.returnTracks`, and `song.mainTrack`, plus a grouping algorithm based on `track.groupTrack`. Also remove or gate `color`, because the SDK track type does not expose a track color in the visible type surface.

CONCERN: SPEC.md section 8 and section 9 require device `class`, `displayValue`, units, and `readOnly`. The current SDK-visible `Device` exposes `name` and `parameters`; `DeviceParameter` exposes `name`, `min`, `max`, `defaultValue`, `isQuantized`, `valueItems`, `getValue`, and `setValue`. I do not see a display-value/unit/read-only getter or a concrete Ableton class name like `Eq8`/`Compressor2`. The Generic template should be specified against the actual data available now, or Phase 2 must include an SDK capability spike before committing to this wire shape.

CONCERN: SPEC.md section 8.2 says specialised templates map device class names to modules, but the class-name source is not established. If only device `name` is available, templates will be fragile because users can rename devices. Treat specialised templates as blocked until the implementation proves a stable class identifier exists.

CONCERN: SPEC.md section 14 R-4 says writes are serialised, but PLAN.md Phase 3 does not add a write queue. The current mapping path has per-target apply locks and smoothing, not a global ordered command pipeline for Mix View. Define an explicit per-target or global write queue, ack timing, and stale-command behavior before claiming the snapshot is the write truth.

CONCERN: SPEC.md section 2 says the new client coexists with the admin dashboard "without modifying it", while SPEC.md section 13 and PLAN.md Phase 4 say the admin dashboard mirrors the dual QR layout. Pick one. If the admin dashboard must remain untouched for v0.3.1, remove the admin QR change from the release scope; if it is in scope, update the goal/non-goal language.

CONCERN: PLAN.md Phase 7 puts most automated tests after all server and client implementation. That weakens the phase gates: Phase 1 through Phase 6 can pass manually while breaking existing `/ws`, `/static/admin/`, or command dispatch behavior. Move phase-local tests into each phase's exit criteria, especially routing compatibility, snapshot shape, command validation, and client command building.

OPEN-Q-RESOLVED: SPEC.md section 15 OQ-1: ship one Generic parameter renderer that branches per parameter: quantized/valueItems as stepper, boolean-looking quantized two-state as toggle, continuous numeric as slider, and unknown/setValue-rejected parameters as disabled static rows.

OPEN-Q-RESOLVED: SPEC.md section 15 OQ-2: keep tempo, time signature, and metronome out of v0.3.1 Mix View. The feature is already large; session-level controls deserve a separate spec.

OPEN-Q-RESOLVED: SPEC.md section 15 OQ-3: group rows should show the group's own fader/mute/solo state, matching Live behavior, not an aggregate.

OPEN-Q-RESOLVED: SPEC.md section 15 OQ-4: order devices by chain position, matching Live.

OPEN-Q-RESOLVED: SPEC.md section 15 OQ-5: keep "go to performance" out of v0.3.1. A direct link is easy, but it creates mode/session/auth questions that are not needed for the first Mix View.

MISSING-FAILURE-MODE: SDK capability mismatch - if the SDK cannot provide display values, track color, device class names, return/master data, or read-only metadata, the server must omit those fields or mark them as unsupported; the client must render a degraded but working UI.

MISSING-FAILURE-MODE: SDK polling overload - if a set has too many parameters to poll within the budget, the server should reduce detail, throttle parameter polling, prioritise the selected/expanded track, and send a degraded-state flag rather than trying to maintain 30 Hz for everything.

MISSING-FAILURE-MODE: Track/device reorder - if a track or device is reordered while the phone has a detail view open, ID-based selection should remain if the handle still resolves; otherwise the client should return to the nearest parent view and show a short stale-selection message.

MISSING-FAILURE-MODE: Return/master no-op controls - if a return or master track does not support arm, sends, or some mixer fields, the snapshot should omit or disable those controls instead of emitting writable-looking controls that fail later.

MISSING-FAILURE-MODE: Token expiry or legacy no-token connection - if tokens are added, define what happens to an already-open page after panel refresh, server restart, or QR expiry. Existing v0.3.0 performance clients should either keep working on `/ws` without tokens or receive a documented migration error.

MISSING-FAILURE-MODE: Command in flight during disconnect/restart - if Live or the extension server stops before ack, the client should mark the command pending as failed after timeout and rely on the next snapshot after reconnect.

NIT: PLAN.md Cross-cutting says every public function touched has a unit or integration test, but `src/extension.ts` does not currently export public functions. Reword to "every new protocol helper or adapter" unless the implementation will split testable modules out of `extension.ts`.

NIT: PLAN.md Phase 0 says the reviewer prompt is read-only, but this workflow asks for a written review file in the same folder. That is fine operationally, but the prompt should say the reviewer may write `REVIEW_FINAL.md` if that is the intended process.

NIT: SPEC.md section 7.2 says "4xx close" for WebSocket rejection. Use either an HTTP 401/403 before upgrade or a WebSocket policy close such as 1008 after upgrade.

NIT: SPEC.md section 13 says both QRs share the same origin, port, and certificate. Today HTTP and HTTPS use different ports. Say the performance and mix QRs share the same HTTPS origin when HTTPS is available, and preserve the existing HTTP admin URL separately.

NIT: PLAN.md Phase 2's sample session of 4 tracks x 2 devices x 8 parameters is too small as the only exit scenario for the architectural risk. Keep it for a smoke test, but add at least one stress fixture or manual test that matches the large-session risk in SPEC.md section 14 R-2.
