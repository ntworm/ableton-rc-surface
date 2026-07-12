// Copyright © 2026 Gabriel Worm
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Source: https://github.com/ntworm/ableton-rc-surface
//
// This file is part of Ableton RC Surface, distributed under the
// PolyForm Noncommercial License 1.0.0. You may obtain a copy of
// the License at https://polyformproject.org/licenses/noncommercial/1.0.0
/**
 * ableton-rc-surface — bootstrap.
 *
 * v0.5.0: this file is the orchestrator only. Every state machine,
 * protocol handler, cert loader, mapping engine, and
 * HTTP test page lives in a dedicated module under src/{server,live,
 * ui,runtime,util,context}. The bootstrap wires those modules up at
 * `activate()` and tears them down at `deactivate()`.
 *
 * Modularity checklist (the modules owners do the actual work):
 *   - src/server/state.ts    startServer / stopServer
 *   - src/server/ws.ts       WebSocket handlers and dispatch
 *   - src/server/http.ts     handleHttp (incl. /health, /commands, /test,
 *                            /static/*)
 *   - src/server/cert.ts     loadCerts (TLS self-signed)
 *   - src/live/state.ts      playhead + live-state broadcast loop
 *   - src/live/mappings.ts   commands registry + mapping engine +
 *                            configureMappingStorage
 *   - src/runtime/safety.ts  uncaughtException / unhandledRejection
 *   - src/ui/panel.ts        panel modal + registerPanelCommand
 *   - src/context.ts         extensionContext global
 */

// Ableton Live extension host runs extensions in a strict VM where
// `global` is not defined as a free identifier. esbuild emits
// `typeof global !== "undefined"` guards around every `global`
// access in the bundled output, so most deps survive. A handful of
// vendored modules (notably selfsigned 5.x) probe `global` during the
// `__commonJS` wrapper evaluation and crash with
// "ReferenceError: global is not defined" before the guard can run.
// Polyfill `global` to globalThis at the very top of the bundle so
// the identifier is in scope before any deep import.
import "./runtime/global-polyfill.js";

import {
  initialize,
  type ActivationContext,
} from "@ableton-extensions/sdk";

import { setExtensionContext, clearExtensionContext } from "./context.js";
import { installRuntimeSafety, uninstallRuntimeSafety } from "./runtime/safety.js";
import { registerPanelCommand } from "./ui/panel.js";
import {
  startLiveStateBroadcastLoop,
  stopLiveStateBroadcastLoop,
} from "./live/state.js";
import {
  startSmoothTimer,
  stopSmoothTimer,
  loadMappings,
  configureMappingStorage,
} from "./live/mappings.js";
import { startServer, stopServer } from "./server/state.js";
import { closeUdpSocket } from "./live/udp-midi.js";
import { oscTransport } from "./live/osc-transport.js";

let activated = false;

/**
 * Idempotent: repeated calls only re-run `startServer()`. Each
 * downstream start helper is itself idempotent (guarded by module-local
 * flags), so the second activate does not stack listeners.
 */
function activate(activation: ActivationContext): void {
  if (activated) {
    console.log("[ableton-rc-surface] activate() called while already active; restarting server only");
    startServer().catch((err) => {
      console.error(`[ableton-rc-surface] restart startServer failed: ${err instanceof Error ? err.message : String(err)}`);
    });
    return;
  }
  activated = true;

  // 1. Top-level safety nets so a stray rejection / exception doesn't
  // tear down the entire Extension Host. Idempotent.
  installRuntimeSafety();

  // 2. Initialise the SDK context and register it as the module-global
  // so any module can reach the application + ui surface without a
  // long prop-drilling chain.
  const context = initialize(activation, "1.0.0");
  setExtensionContext(context);

  // 3. Wire the unified panel modal into Live's menu + scene context.
  registerPanelCommand(context);

  // 4. Configure mapping + preset storage paths and load any persisted
  // mappings. Best-effort: a missing storageDir just skips persistence.
  const storageDir = context.environment.storageDirectory;
  configureMappingStorage(storageDir).then(() => {
    return loadMappings();
  }).catch((err) => {
    console.error(`[ableton-rc-surface] configureMappingStorage/loadMappings failed: ${err instanceof Error ? err.message : String(err)}`);
  });

  // 5. Start the HTTP+WS server. Has its own idempotency guard.
  startServer().catch((err) => {
    console.error(`[ableton-rc-surface] initial startServer failed: ${err instanceof Error ? err.message : String(err)}`);
  });

  // 6. Background loops: live-state broadcast and smooth-timer
  // interpolation. Both are idempotent.
  startLiveStateBroadcastLoop();
  startSmoothTimer();

  // 7. Start OSC Transport
  try {
    oscTransport.start();
  } catch (err) {
    console.error(`[ableton-rc-surface] oscTransport.start failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  console.log("[ableton-rc-surface] activate() done; awaiting requests");
}

/**
 * Reverse of activate(). Idempotent; each `stop*` call is itself a
 * no-op when the matching subsystem is already shut down, so a
 * double-deactivate from Live is safe.
 */
function deactivate(): void {
  if (!activated) {
    return;
  }
  activated = false;

  // stopServer first closes HTTP + WS + tears down the snapshot loop;
  // doing it last would race with the other stops' cleanup hooks.
  try { stopSmoothTimer(); } catch (err) { console.error(`[ableton-rc-surface] stopSmoothTimer failed: ${err instanceof Error ? err.message : String(err)}`); }
  try { stopLiveStateBroadcastLoop(); } catch (err) { console.error(`[ableton-rc-surface] stopLiveStateBroadcastLoop failed: ${err instanceof Error ? err.message : String(err)}`); }

  stopServer().catch((err) => {
    console.error(`[ableton-rc-surface] stopServer failed: ${err instanceof Error ? err.message : String(err)}`);
  });

  // Drop the context last so any in-flight tick during shutdown can
  // still read Live state through getExtensionContext() before it
  // returns null.
  clearExtensionContext();

  try { closeUdpSocket(); } catch (err) { console.error(`[ableton-rc-surface] closeUdpSocket failed: ${err instanceof Error ? err.message : String(err)}`); }
  try { oscTransport.dispose(); } catch (err) { console.error(`[ableton-rc-surface] oscTransport.dispose failed: ${err instanceof Error ? err.message : String(err)}`); }

  // Drop the process-level safety listeners so a subsequent activate()
  // can re-install them cleanly. A no-op if installRuntimeSafety was
  // never called (e.g. activate() errored before reaching step 1).
  uninstallRuntimeSafety();

  console.log("[ableton-rc-surface] deactivate() done; awaiting next activate");
}

export { activate, deactivate };
