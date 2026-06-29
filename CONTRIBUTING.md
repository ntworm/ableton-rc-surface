# Contributing to Ableton RC Bridge

Thanks for considering contributing! This project is MIT-licensed and
welcomes issues, bug reports, feature requests, and pull requests.

## Getting started

```bash
git clone <this-repo>
cd ableton-rc-bridge
npm install
npm run ci          # lint + typecheck + test + build
```

Requires **Node.js ≥ 24.14.1** (see `.nvmrc`).

## Code structure

The extension source lives in `src/` and is modular:

```
src/
├── extension.ts         # Entrypoint: activate(), panel dialog, commands
├── context.ts           # Shared Ableton SDK context & helpers
├── util/
│   └── helpers.ts       # Math clamps, LAN IP resolution, timeout wrappers
├── server/
│   ├── cert.ts          # Self-signed certificate generation & persistence
│   ├── state.ts         # HTTP/HTTPS server lifecycle (start/stop)
│   ├── http.ts          # Static file server & route handler
│   └── ws.ts            # WebSocket servers, client tracking, command dispatch
└── live/
    ├── state.ts         # Playhead & song state broadcasting
    ├── mappings.ts      # Control→parameter mapping engine & presets
    └── snapshots.ts     # Mix View tiered snapshot loop
```

The phone clients (`static/phone-v3/`, `static/mix/`, `static/admin/`,
`static/panel/`) are plain ES5/ES6 JavaScript with no build step.

## Before submitting a PR

1. **Run the full CI pipeline locally:**
   ```bash
   npm run ci
   ```
   This runs ESLint, TypeScript type-checking, all 113+ tests, and
   the esbuild bundle. All must pass.

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
