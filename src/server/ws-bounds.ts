// Copyright © 2026 Gabriel Worm
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Source: https://github.com/ntworm/ableton-rc-surface
//
// This file is part of Ableton RC Surface, distributed under the
// PolyForm Noncommercial License 1.0.0. You may obtain a copy of
// the License at https://polyformproject.org/licenses/noncommercial/1.0.0

/**
 * ws-bounds.ts — WebSocket protocol bounds and input validation (ADR-004).
 *
 * All numeric limits are centralised here so they can be referenced by both
 * the runtime guards and the test suite.
 */

// ── WebSocket transport limits ──────────────────────────────────────────────

/** Disable per-message deflate — CPU cost outweighs bandwidth on LAN. */
export const PER_MESSAGE_DEFLATE = false;

/** Maximum payload size in bytes (100 KiB). Oversized frames are rejected by ws. */
export const MAX_PAYLOAD_BYTES = 102_400;

// ── Schema limits ───────────────────────────────────────────────────────────

/** Maximum Unicode code-points in a client display name. */
export const MAX_CLIENT_NAME_LENGTH = 64;

/** Maximum characters in a single control `name` field. */
export const MAX_CONTROL_NAME_LENGTH = 128;

/** Maximum controls accepted in a single snapshot message. */
export const MAX_CONTROLS_PER_SNAPSHOT = 128;

/** History ring-buffer depth per control key. */
export const HISTORY_RING_SIZE = 120;

// ── Rate-limiting ───────────────────────────────────────────────────────────

/** Burst bucket size (messages). */
export const RATE_BURST = 60;

/** Sustained rate (messages per second). */
export const RATE_SUSTAINED_PER_SEC = 30;

/** Window for rate limiter token replenishment (ms). */
export const RATE_WINDOW_MS = 1_000;

// ── Cache limits ────────────────────────────────────────────────────────────

/** Hard cap on cache entries (e.g. mapping cache, control-value cache). */
export const CACHE_MAX_ENTRIES = 2_048;

// ── Backpressure thresholds ─────────────────────────────────────────────────

/** Above this bufferedAmount we drop non-critical telemetry (bytes). */
export const BACKPRESSURE_DROP_THRESHOLD = 512 * 1024; // 512 KiB

/** Above this bufferedAmount we disconnect the slow client (bytes). */
export const BACKPRESSURE_DISCONNECT_THRESHOLD = 2 * 1024 * 1024; // 2 MiB

// ── Validation helpers ──────────────────────────────────────────────────────

/**
 * Sanitise a numeric value: NaN and ±Infinity become 0.
 */
export function sanitizeNumber(v: unknown): number {
  if (typeof v !== "number" || !Number.isFinite(v)) return 0;
  return v;
}

/**
 * Validate + truncate a client display name.
 * Returns the (possibly truncated) name, or empty string if invalid.
 */
export function sanitizeClientName(raw: unknown): string {
  if (typeof raw !== "string") return "";
  // Use Array.from to correctly count Unicode code-points (surrogates).
  const codePoints = Array.from(raw);
  if (codePoints.length > MAX_CLIENT_NAME_LENGTH) {
    return codePoints.slice(0, MAX_CLIENT_NAME_LENGTH).join("");
  }
  return raw;
}

/**
 * Validate a control name — must be a non-empty string
 * within MAX_CONTROL_NAME_LENGTH characters.
 */
export function isValidControlName(name: unknown): name is string {
  return typeof name === "string" && name.length > 0 && name.length <= MAX_CONTROL_NAME_LENGTH;
}

/**
 * Validate a snapshot data object. Returns the controls array trimmed
 * to MAX_CONTROLS_PER_SNAPSHOT, or null if the data is fundamentally invalid.
 */
export function boundSnapshotControls(controls: unknown[]): unknown[] | null {
  if (!Array.isArray(controls)) return null;
  if (controls.length > MAX_CONTROLS_PER_SNAPSHOT) {
    return null; // reject entirely — client is misbehaving
  }
  return controls;
}

// ── Per-connection rate limiter ──────────────────────────────────────────────

export interface RateLimiterState {
  tokens: number;
  lastRefill: number;
  violations: number;
}

export function createRateLimiter(): RateLimiterState {
  return { tokens: RATE_BURST, lastRefill: Date.now(), violations: 0 };
}

/**
 * Consume one token. Returns true if the message is allowed, false if
 * rate-limited.
 */
export function consumeToken(state: RateLimiterState): boolean {
  const now = Date.now();
  const elapsed = now - state.lastRefill;
  if (elapsed >= RATE_WINDOW_MS) {
    // Refill: add sustained tokens per elapsed windows, cap at burst.
    const windows = Math.floor(elapsed / RATE_WINDOW_MS);
    state.tokens = Math.min(RATE_BURST, state.tokens + windows * RATE_SUSTAINED_PER_SEC);
    state.lastRefill += windows * RATE_WINDOW_MS;
  }
  if (state.tokens > 0) {
    state.tokens--;
    return true;
  }
  state.violations++;
  return false;
}
