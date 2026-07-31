// Copyright © 2026 Gabriel Worm
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Source: https://github.com/ntworm/ableton-rc-surface
//
// This file is part of Ableton RC Surface, distributed under the
// PolyForm Noncommercial License 1.0.0. You may obtain a copy of
// the License at https://polyformproject.org/licenses/noncommercial/1.0.0

/**
 * backpressure.ts — Per-connection backpressure monitor (ADR-004).
 *
 * Watches `ws.bufferedAmount` and takes progressive action:
 *   1. Above BACKPRESSURE_DROP_THRESHOLD  → skip non-critical outbound messages.
 *   2. Above BACKPRESSURE_DISCONNECT_THRESHOLD → close the socket.
 *
 * Identity model: clients are keyed by `client_id` + session (WebSocket
 * instance), not by IP. Two phones behind the same NAT each keep their
 * own session. A reconnecting phone only replaces its *own* prior
 * session (matched by client_id).
 */

import { WebSocket } from "ws";
import {
  BACKPRESSURE_DROP_THRESHOLD,
  BACKPRESSURE_DISCONNECT_THRESHOLD,
} from "./ws-bounds.js";

export type MessagePriority = "critical" | "telemetry";

/**
 * Returns true if the outbound message should be sent, false if it
 * should be silently dropped due to backpressure.
 *
 * Side-effect: if bufferedAmount exceeds the disconnect threshold the
 * socket is closed with code 4008.
 */
export function checkBackpressure(
  ws: WebSocket,
  priority: MessagePriority,
): boolean {
  const buffered = ws.bufferedAmount ?? 0;

  if (buffered > BACKPRESSURE_DISCONNECT_THRESHOLD) {
    try {
      ws.close(4008, "slow client: backpressure exceeded");
    } catch {
      // already closing
    }
    return false;
  }

  if (buffered > BACKPRESSURE_DROP_THRESHOLD && priority === "telemetry") {
    // Drop non-critical telemetry to let the buffer drain.
    return false;
  }

  return true;
}

/**
 * Wrap `ws.send()` with backpressure awareness.
 * Returns true if the message was actually enqueued, false if dropped.
 */
export function sendWithBackpressure(
  ws: WebSocket,
  data: string,
  priority: MessagePriority = "telemetry",
): boolean {
  if (ws.readyState !== WebSocket.OPEN) return false;
  if (!checkBackpressure(ws, priority)) return false;
  try {
    ws.send(data);
    return true;
  } catch {
    return false;
  }
}
