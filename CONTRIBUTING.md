# Contributing to Ableton RC Surface

Thanks for considering contributing. This project is released under the
PolyForm Noncommercial 1.0.0 license and welcomes issues, bug reports, and
feature requests. New contributions are accepted only by direct invitation
from the maintainer; please open an issue to discuss any changes before
sending a pull request, and do not assume unsolicited PRs will be merged.

## Getting started

```bash
git clone <this-repo>
cd ableton-rc-surface
npm ci
npm test           # test:static + test:src
npm run build      # tsc check + esbuild bundle to dist/
npm run ci         # test + lint + typecheck + production build + UI tests
```

Requires **Node.js 24.16.0** (see `.nvmrc` and `.node-version`).

## Code structure

The extension source lives in `src/` and is modular. `src/extension.ts`
is a thin bootstrap that wires the modules below; it contains no inline
state machines, shadow copies, or protocol handlers.

```text
src/
  extension.ts        bootstrap: activate() + deactivate()
  context.ts          SDK context access
  runtime/safety.ts   uncaught exception safety hooks
  ui/panel.ts         Ableton panel and mapping dialogs
  util/               helpers and CPU sampling
  server/state.ts     HTTP/HTTPS lifecycle
  server/cert.ts      self-signed TLS certificates
  server/http.ts      static files and health/test routes
  server/ws.ts        WebSocket clients, typed messages, command dispatch
  server/client-id.ts client id generation
  live/state.ts       playhead and live-state broadcast loop
  live/mappings.ts    commands, mapping engine, curves, presets
```

Static clients are plain browser JavaScript with no build step:

```text
static/
  phone-v3/  phone performance client with built-in MIX tab
  panel/     Ableton panel UI
  admin/     admin dashboard
```

There is no standalone MIX client, no standalone MIX protocol, and no Mix
QR in the current architecture. The MIX tab is integrated into the phone
client.

## Tests

`npm test` runs two suites:

```bash
npm run test:static   # static/{admin,panel,phone-v3}/*.test.mjs plus scripts/*.test.mjs
npm run test:src      # tests/*.test.mjs with tsx
```

The release gate is:

```bash
npm test
npx tsc --noEmit
npm run build:prod
```

Use `npm run build:prod-ablx` to generate the versioned `.ablx` and `npm run
package:tester` to generate the tester kit.

## Before submitting a PR

1. Run the full release gate locally.
2. Add or update tests for behavior changes.
3. Keep commits focused: one logical change per commit.
4. Do not commit build artifacts (`dist/`, `.ablx`, `release-kits/`) unless a maintainer explicitly asks.
5. Keep public docs aligned with behavior when changing install flow, controls, network behavior, or compatibility.

## Style guide

- TypeScript for `src/`, plain JavaScript for `static/`.
- 2-space indentation, LF line endings.
- Avoid `any` except at Ableton SDK boundaries that are untyped.
- Prefer existing helpers and local patterns over new abstractions.

## Reporting bugs

Please include:

- Ableton Live version and edition
- OS
- Phone model and browser
- Extension version
- Steps to reproduce
- Expected and actual behavior
- Ableton Extensions log output
- Browser console output if the phone UI is involved

## Feature requests

Open an issue with the `enhancement` label once the repository is public.
Describe the use case, not just the proposed implementation.
