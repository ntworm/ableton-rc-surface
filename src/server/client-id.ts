/**
 * Server-generated client IDs for WebSocket connections.
 *
 * Public API:
 *   createClientId(queryId?): string  // RFC 4122 v4 UUID if no queryId,
 *                                    // echoes the queryId otherwise so a
 *                                    // reconnecting phone keeps its id.
 *
 * Implementation: uses node:crypto.randomUUID() (Node >= 24 guaranteed by
 * engines.node in package.json). No Math.random() fallback — previously
 * existed in extension.ts inline and later in server/ws.ts shadow copies;
 * that was both redundant and a collision vector. Removed entirely per
 * the v0.5.0 architecture plan.
 */
import { randomUUID } from "node:crypto";

export function createClientId(queryId: string | null = null): string {
  if (typeof queryId === "string" && queryId.length > 0) {
    return queryId;
  }
  return randomUUID();
}
