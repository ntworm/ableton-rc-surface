# Mix View — Implementation Plan (v0.3.1)

Status: IMPLEMENTED. All phases shipped on 2026-06-12.

This plan was adjusted before implementation to address the
concerns from `REVIEW_FINAL.md` (verdict: CONCERNS). The
adjustments are listed inline at the relevant phase.

## Phase 0 — Spec sign-off (gate)

- Deliverable: `docs/mix-view/SPEC.md`,
  `docs/mix-view/PLAN.md`, `docs/mix-view/REVIEW_PROMPT.md`,
  `docs/mix-view/REVIEW_FINAL.md` all exist on disk and are
  uncommitted.
- Action: independent reviewer runs the review prompt; verdict
  was `CONCERNS` with 10 concerns + 6 missing failure modes + 5
  open questions answered. All addressed in SPEC.md revisions
  and the per-phase adjustments below.
- Exit criterion: all CONCERNS resolved.
- Status: DONE.

## Phase 1 — Server: routing and mode flag

ORIGINAL DRAFT: add `/mix/` and `/mix/static/*` HTTP routes; add
a mode-aware WebSocket upgrade; extend the (non-existent) token
record with a `mode` field.

REVIEW ADJUSTMENT: there is no token system in v0.3.0. The phase
became (a) add the HTTP redirect `/mix/` -> `/static/mix/`; (b)
add a new `WebSocketServer` bound to `/mix/ws` with no auth;
(c) extend `TrackedClient` with a `mode: "performance" | "admin"
| "mix"` field (legacy `isAdmin` retained as a back-compat
alias). `/ws` and `/admin/ws` are byte-for-byte unchanged.

- Exit criterion: a `/mix/ws` connection is accepted and
  receives the `mix.hello` payload; `/ws` and `/admin/ws` still
  work and dispatch the existing commands.
- Commit: `feat(mix): add /mix/ HTTP route and /mix/ws WebSocket
  skeleton` (7dea5bb).

## Phase 2 — Server: tiered snapshot loop

ORIGINAL DRAFT: split `toPerformanceSnapshot` into two adapters
on a 30 Hz loop.

REVIEW ADJUSTMENT: the 30 Hz loop is the phone -> server snapshot
flow. There is no server-side Live polling loop yet. The phase
became (a) add a brand-new server-side tiered loop that READS
the Live song at three cadences (structure 0.5 Hz, mixer 5 Hz,
params 2 Hz); (b) cap the params tier at
`MIX_MAX_PARAMS_PER_TICK` (64) per client with rotation; (c)
delta-diff per client per tier; (d) self-gate on
`mixClientsActive` so zero clients = zero CPU.

- Exit criterion: structure + mixer + params tiers arrive on a
  connected Mix client; the loop sleeps when no Mix client is
  connected; `/ws` and `/admin/ws` behaviour unchanged.
- Commit: `feat(mix): add tiered server-side snapshot loop
  (structure/mixer/params)` (5cb2f47).

## Phase 3 — Server: command handlers with per-target queue

ORIGINAL DRAFT: extend `commands` registry with the six Mix
commands and route them via the existing dispatcher.

REVIEW ADJUSTMENT: the existing dispatcher pattern is for the
`{id, cmd, args}` shape. The Mix View uses a `{refId, type,
targetId, value}` shape; the right path is a separate
`mixDispatch` function in `setupMixWssHandlers`, NOT the
existing `dispatch` (which is shared with legacy clients). The
phase also added a per-target-key serialisation queue
(`mixWriteQueues`) so two concurrent commands on the same
handle cannot interleave their `setValue()` calls, and a 1s
per-write timeout so a stuck SDK call cannot block subsequent
commands.

- Exit criterion: each of the six command types round-trips
  with `mix.ack` within 50 ms p95; unknown commands return
  `mix.error`; stale handle IDs return `mix.error reason =
  "not_found"`.
- Commit: `feat(mix): add command handlers with per-target write
  queue` (6373445).

## Phase 4 — Panel: dual QR code

ORIGINAL DRAFT: extend the panel to show two QRs side by side,
both the Live panel and the admin dashboard. The review asked
us to pick one. We chose: only the Live panel shows the dual
QR; the admin dashboard is untouched (per the review's
"if the admin dashboard must remain untouched, remove the
admin QR change from the release scope" path).

- Exit criterion: the panel renders two scannable QRs;
  scanning either opens the corresponding client; both work
  simultaneously.
- Commit: `feat(mix): render dual QR code in the Live panel`
  (8cee96d).

## Phase 5 — Mix client: shell

ORIGINAL DRAFT: client with three views, no build step, vanilla
JS.

REVIEW ADJUSTMENT: minor. The three views are track list,
expanded track, device detail. The client is in `static/mix/`
as `index.html` + `style.css` + `app.js`, imported via ESM
modules (`./protocol.mjs`, `./generic-template.mjs`). No
build step. The protocol and template modules are PURE JS so
they are independently testable with `node --test`.

- Exit criterion: the shell loads in Chrome on Android over
  HTTPS, navigates between views, and survives a reload.
- Commit: `feat(mix): add Mix View client (HTML, CSS, JS)`
  (c5c1f60).

## Phase 6 — Generic template (lives in Phase 5)

Originally a separate phase; folded into Phase 5 because the
client and the template ship together. The renderer is
`static/mix/generic-template.mjs` with 31 unit tests
(`generic-template.test.mjs`).

## Phase 7 — Tests

The review asked for phase-local tests, not end-of-phase tests.
We added tests at every phase boundary:

  - protocol.test.mjs        (after Phase 0/1)
  - generic-template.test.mjs (after Phase 6)
  - stress.test.mjs          (after Phase 7)
  - npm test stays green through every commit

The stress fixture builds a 50-track x 10-device x 8-parameter
universe (SPEC R-2 worst case) and confirms parseId +
validateCommand stay sub-500ms over 4000 IDs. It also confirms
the client can sustain > 5k param ops per second, well within
the 30 Hz tick budget.

- Commit: `test(mix): add large-session stress fixture (SPEC
  R-2)` (7a4fb1b).

## Phase 8 — Package and version bump

- `manifest.json` and `package.json` both bumped to 0.3.1.
- `npm run build:prod` produces `dist/extension.js` (448 KB
  minified).
- `extensions-cli package -i dist/static` produces
  `Ableton-RC-Bridge-0.3.1.ablx` (191,821 bytes, up from
  172,248 bytes for v0.3.0; the +19 KB delta is the bundled
  mix/ PWA + the new server-side snapshot and command code).
- NO push. NO publish.
- Commits: `chore: bump version to 0.3.1` (44e3ef7),
  `chore: bump manifest.json version to 0.3.1` (7fd240b),
  `chore: ship Ableton-RC-Bridge-0.3.1.ablx` (2d52a76).

## Phase 9 — Documentation

- `README.md` updated to mention the Mix View in Highlights
  and the dual QR in Quick Start.
- `docs/INSTALL.md` updated to mention the second QR and
  the `/mix/` URL.
- `docs/mix-view/SPEC.md` and `docs/mix-view/PLAN.md` updated
  to reflect the review-driven adjustments and the
  as-implemented state.

## Cross-cutting

- All commits use the existing `feat:`, `fix:`, `chore:`,
  `test:`, `docs:` convention. The Mix work is a sequence of
  `feat(mix):` commits with phase-specific exit criteria.
- The README's "Adding a new feature" section can cite this
  plan as a worked example.
- No v0.3.0 client code path is touched. The phone-v3 snapshot
  flow, the admin dashboard, and the existing command
  registry are byte-for-byte the same shape as before.
- 0 push, 0 publish, 0 remote configured.

## Per-phase exit criteria check

  - Phase 1: routing works, legacy intact, mix hello arrives.
  - Phase 2: tiered loop runs, self-gates, mixes delta cache.
  - Phase 3: six commands round-trip, queue serialises, errors
    are descriptive.
  - Phase 4: panel shows two QRs, each opens the right client.
  - Phase 5: client navigates three views, sends commands.
  - Phase 6: generic template renders all 4 kinds.
  - Phase 7: tests stay green at every commit; stress fixture
    confirms the 30 Hz budget.
  - Phase 8: build:prod emits a valid .ablx.
  - Phase 9: docs reflect the as-implemented state.
