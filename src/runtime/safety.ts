// Copyright © 2026 Gabriel Worm
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Source: https://github.com/ntworm/ableton-rc-surface
//
// This file is part of Ableton RC Surface, distributed under the
// PolyForm Noncommercial License 1.0.0. You may obtain a copy of
// the License at https://polyformproject.org/licenses/noncommercial/1.0.0
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
let exceptionListener: ((err: Error) => void) | null = null;
let rejectionListener: ((reason: unknown) => void) | null = null;

/**
 * Install process-level handlers for uncaught exceptions and unhandled
 * promise rejections. Idempotent: a second call after the first is a no-op,
 * so `activate()` can call it without coordinating with deactivation.
 */
export function installRuntimeSafety(): void {
  if (installed) return;
  installed = true;

  exceptionListener = (err) => {
    console.error(
      `[ableton-rc-surface] uncaughtException: ${err && err.stack ? err.stack : String(err)}`,
    );
  };
  rejectionListener = (reason) => {
    const detail = reason instanceof Error ? reason.stack : String(reason);
    console.error(`[ableton-rc-surface] unhandledRejection: ${detail}`);
  };

  process.on("uncaughtException", exceptionListener);
  process.on("unhandledRejection", rejectionListener);
}

/**
 * Remove the listeners installed by {@link installRuntimeSafety}. Called
 * from `deactivate()` so a Live hot-reload does not accumulate handlers
 * across reloads.
 */
export function uninstallRuntimeSafety(): void {
  if (!installed) return;
  if (exceptionListener) process.off("uncaughtException", exceptionListener);
  if (rejectionListener) process.off("unhandledRejection", rejectionListener);
  exceptionListener = null;
  rejectionListener = null;
  installed = false;
}

/**
 * Test-only helper: forget that safety handlers were installed so the next
 * call to {@link installRuntimeSafety} registers fresh listeners. Production
 * code never needs this.
 */
export function resetRuntimeSafetyForTest(): void {
  installed = false;
  exceptionListener = null;
  rejectionListener = null;
}
