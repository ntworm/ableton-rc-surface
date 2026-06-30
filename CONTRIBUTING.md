# Contributing to Ableton RC Bridge

Thanks for considering contributing! This project is MIT-licensed and
welcomes issues, bug reports, feature requests, and pull requests.

## Getting started

```bash
git clone <this-repo>
cd ableton-rc-bridge
npm install
npm test           # test:static + test:src
npm run build      # tsc check + esbuild bundle to dist/
```

Requires **Node.js ≥ 24.14.1** (see `.nvmrc`).

## Code structure

The extension source lives in `src/` and is modular. **`src/extension.ts`
is a thin bootstrap** (~132 lines) that wires the modules below; it
contains no inline state machines, no shadow copies, and no protocol
handlers. Everything owns a dedicated file and is reachable via a typed
`import`.

```
src/
├── extension.ts         # Bootstrap: activate() + deactivate()
├── context.ts           # SDK context global + requireCtx/requireTrack
├── runtime/
│   └── safety.ts        # installRuntimeSafety() (uncaughtException handler)
├── ui/
│   └── panel.ts         # showPanelDialog / showMappingDialog / showInfoDialog
├── util/
│   ├── cpu.ts           # sampleCpuUsagePercent()
│   └── helpers.ts       # clamps, LAN IPs, timeout, dialogs
├── server/
│   ├── state.ts         # startServer / stopServer (HTTP + HTTPS)
│   ├── cert.ts          # loadCerts (self-signed TLS)
│   ├── http.ts          # handleHttp + serveStaticFile + MIME_TYPES
│   ├── ws.ts            # WebSocket handlers, dispatch, mix protocol glue
│   ├── mix-protocol.ts  # Pure parser: mixParseId / mixWriteQueueKeyFor
│   └── client-id.ts     # createClientId (RFC 4122 v4)
└── live/
    ├── state.ts         # Playhead + live-state broadcast loop (idempotent)
    ├── mappings.ts      # commands registry + mapping engine + presets
    └── snapshots.ts     # Tiered mix snapshot loop (structure / mixer / params)
```

The phone clients (`static/phone-v3/`, `static/mix/`, `static/admin/`,
`static/panel/`) are plain ES5/ES6 JavaScript with no build step.

## Tests

`npm test` runs the aggregator of two suites:

```bash
npm run test:static   # node:test on static/{admin,panel,phone-v3,mix}/*.test.mjs
npm run test:src       # node:test on tests/*.test.mjs (source-side modules)
```

The `--test-force-exit` flag is in effect, which interacts badly with the
spec reporter (total counts in `tests / pass` fluctuate run to run as
workers commit their pass counts at different points). TAP reporter via
`--test-reporter=tap` is stable. The **gate** that CI relies on is the
exit code plus `fail == 0`, not the `pass` count.

ESLint remains configured via the legacy `.eslintrc.cjs` and emits a
migration warning on ESLint v9. Treat ESLint output as **diagnostic** for
this release; the flat-config migration is tracked separately.

## Before submitting a PR

1. **Run the full CI pipeline locally:**
   ```bash
   npm test           # tests
   npx tsc --noEmit   # typecheck
   npm run build      # tsc check + esbuild bundle to dist/
   ```
   All must pass. ESLint is diagnostic; ignore its legacy-config warning.

2. **Don't break existing tests.** If your change modifies behavior,
   update or add tests.

3. **Keep commits focused.** One logical change per commit, with a
   clear commit message.

4. **Don't commit build artifacts** (`.ablx` files, `dist/`). The CI
   workflow builds these automatically on tagged releases.

## Style guide

- **TypeScript** for `src/`, **plain JS** for `static/`.
- 2-space indentation, LF line endings (see `.editorconfig`).
- No `any` unless interfacing with the Ableton SDK's untyped surfaces.
- Prefer `async/await` over raw `.then()` chains.

## Reporting bugs

Please include:
- Ableton Live version
- OS and browser (for the phone client)
- Steps to reproduce
- Console output from the Ableton Extensions log

## Feature requests

Open an issue with the `enhancement` label. Describe the use case,
not just the solution.
