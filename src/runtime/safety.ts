/**
 * Runtime safety net for the extension host.
 *
 * Ableton's Extension Host runs the extension's `activate()` in a single Node
 * process. An uncaught exception or an unhandled promise rejection tears down
 * the entire host, which surfaces to the user as "Extension Host Has Stopped
 * Running" — far more disruptive than the actual error warrants.
 *
 * Centralising the listeners here lets `activate()` install them with one
 * idempotent call, and lets Bloco E drop them from `extension.ts` in favour
 * of the tested helper.
 */

let installed = false;

/**
 * Install process-level handlers for uncaught exceptions and unhandled
 * promise rejections. Idempotent: a second call after the first is a no-op,
 * so `activate()` can call it without coordinating with deactivation.
 */
export function installRuntimeSafety(): void {
  if (installed) return;
  installed = true;

  process.on("uncaughtException", (err) => {
    console.error(
      `[ableton-rc-bridge] uncaughtException: ${err && err.stack ? err.stack : String(err)}`,
    );
  });

  process.on("unhandledRejection", (reason) => {
    const detail = reason instanceof Error ? reason.stack : String(reason);
    console.error(`[ableton-rc-bridge] unhandledRejection: ${detail}`);
  });
}

/**
 * Test-only helper: forget that safety handlers were installed so the next
 * call to {@link installRuntimeSafety} registers fresh listeners. Production
 * code never needs this.
 */
export function resetRuntimeSafetyForTest(): void {
  installed = false;
}
