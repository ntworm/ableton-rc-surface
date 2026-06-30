/**
 * ableton-rc-bridge — bootstrap.
 *
 * v0.5.0: this file is the orchestrator only. Every state machine,
 * protocol handler, snapshot loop, cert loader, mapping engine, and
 * HTTP test page lives in a dedicated module under src/{server,live,
 * ui,runtime,util,context}. The bootstrap wires those modules up at
 * `activate()` and tears them down at `deactivate()`.
 *
 * Modularity checklist (the modules owners do the actual work):
 *   - src/server/state.ts    startServer / stopServer
 *   - src/server/ws.ts       WebSocket handlers, dispatch, mix protocol
 *   - src/server/http.ts     handleHttp (incl. /health, /commands, /test,
 *                            /static/*)
 *   - src/server/cert.ts     loadCerts (TLS self-signed)
 *   - src/server/mix-protocol.ts  mixParseId / mixWriteQueueKeyFor
 *   - src/live/state.ts      playhead + live-state broadcast loop
 *   - src/live/mappings.ts   commands registry + mapping engine +
 *                            configureMappingStorage
 *   - src/live/snapshots.ts  tiered mix snapshot loop
 *   - src/runtime/safety.ts  uncaughtException / unhandledRejection
 *   - src/ui/panel.ts        panel modal + registerPanelCommand
 *   - src/context.ts         extensionContext global
 */

import {
  initialize,
  type ActivationContext,
} from "@ableton-extensions/sdk";

import { setExtensionContext, clearExtensionContext } from "./context.js";
import { installRuntimeSafety } from "./runtime/safety.js";
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
import {
  startMixSnapshotLoop,
  stopMixSnapshotLoop,
} from "./live/snapshots.js";
import { startServer, stopServer } from "./server/state.js";

let activated = false;

/**
 * Idempotent: repeated calls only re-run `startServer()`. Each
 * downstream start helper is itself idempotent (guarded by module-local
 * flags), so the second activate does not stack listeners.
 */
function activate(activation: ActivationContext): void {
  if (activated) {
    console.log("[ableton-rc-bridge] activate() called while already active; restarting server only");
    startServer().catch((err) => {
      console.error(`[ableton-rc-bridge] restart startServer failed: ${err instanceof Error ? err.message : String(err)}`);
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
    console.error(`[ableton-rc-bridge] configureMappingStorage/loadMappings failed: ${err instanceof Error ? err.message : String(err)}`);
  });

  // 5. Start the HTTP+WS server. Has its own idempotency guard.
  startServer().catch((err) => {
    console.error(`[ableton-rc-bridge] initial startServer failed: ${err instanceof Error ? err.message : String(err)}`);
  });

  // 6. Three background loops: live-state broadcast, smooth-timer
  // interpolation, tiered mix snapshots. All are idempotent.
  startLiveStateBroadcastLoop();
  startSmoothTimer();
  startMixSnapshotLoop();

  console.log("[ableton-rc-bridge] activate() done; awaiting requests");
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
  try { stopMixSnapshotLoop(); } catch (err) { console.error(`[ableton-rc-bridge] stopMixSnapshotLoop failed: ${err instanceof Error ? err.message : String(err)}`); }
  try { stopSmoothTimer(); } catch (err) { console.error(`[ableton-rc-bridge] stopSmoothTimer failed: ${err instanceof Error ? err.message : String(err)}`); }
  try { stopLiveStateBroadcastLoop(); } catch (err) { console.error(`[ableton-rc-bridge] stopLiveStateBroadcastLoop failed: ${err instanceof Error ? err.message : String(err)}`); }

  stopServer().catch((err) => {
    console.error(`[ableton-rc-bridge] stopServer failed: ${err instanceof Error ? err.message : String(err)}`);
  });

  // Drop the context last so any in-flight tick during shutdown can
  // still read Live state through getExtensionContext() before it
  // returns null.
  clearExtensionContext();

  console.log("[ableton-rc-bridge] deactivate() done; awaiting next activate");
}

export { activate, deactivate };
