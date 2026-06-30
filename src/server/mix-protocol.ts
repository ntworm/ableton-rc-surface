/**
 * Mix protocol — pure parse + key helpers, no SDK or mutable state.
 *
 * Moved out of `server/ws.ts` so they can be unit-tested without spinning up
 * the WebSocket layer, and so `extension.ts` can import a single canonical
 * implementation in Bloco E.
 *
 * Anything that needs `trackedClients`, `adminSockets`, `mixWriteQueues`, or
 * `requireCtx()` does NOT belong here — keep it in `ws.ts` to avoid cycles.
 *
 * Protocol summary (matches `static/mix/protocol.mjs`):
 *   mix:track:<n>[:dev:<n>][:par:<n>][:send:<n>]
 *   mix:return:<n>[:dev:<n>][:par:<n>][:send:<n>]
 *   mix:main[:dev:<n>][:par:<n>][:send:<n>]
 *
 * Subsegment rules:
 *   - dev applies to a device on the parent track/return/main
 *   - par requires a dev already present
 *   - send belongs to the track/return/main (not inside a device)
 *   - any other segment, duplicate, or non-integer index → null
 *
 * Group tracks use `mix:track:<n>`; the old `mix:group:<n>` form is rejected.
 */

export interface MixParsedId {
  kind: "track" | "device" | "parameter" | "send";
  type: "regular" | "group" | "return" | "master";
  trackIndex: number;
  deviceIndex: number | null;
  paramIndex: number | null;
  sendIndex: number | null;
}

/**
 * Parse a mix-protocol id into its structured form.
 *
 * Always returns `null` on any malformed input — never throws, even for
 * non-string or non-finite values. This is the public contract callers
 * rely on for untrusted WS payloads.
 */
export function mixParseId(id: unknown): MixParsedId | null {
  if (typeof id !== "string" || id.length === 0) return null;
  const parts = id.split(":");
  if (parts[0] !== "mix" || parts.length < 2) return null;
  const out: MixParsedId = {
    kind: "track",
    type: "regular",
    trackIndex: 0,
    deviceIndex: null,
    paramIndex: null,
    sendIndex: null,
  };
  if (parts[1] === "main") {
    out.type = "master";
    out.trackIndex = 0;
    if (parts.length === 2) return out;
    return mixParseSubSegments(parts, 2, out);
  }
  if (parts[1] === "track" || parts[1] === "return") {
    out.type = parts[1] === "return" ? "return" : "regular";
    const idx = Number(parts[2]);
    if (!Number.isInteger(idx) || idx < 0) return null;
    out.trackIndex = idx;
    if (parts.length === 3) return out;
    return mixParseSubSegments(parts, 3, out);
  }
  // mix:group:<n> is intentionally rejected: groups are encoded as mix:track:<n>
  // with their Ableton trackKind, not a separate prefix.
  return null;
}

function mixParseSubSegments(
  parts: string[],
  start: number,
  out: MixParsedId,
): MixParsedId | null {
  let i = start;
  while (i < parts.length) {
    const seg = parts[i];
    const val = Number(parts[i + 1]);
    if (!Number.isInteger(val) || val < 0) return null;
    if (seg === "dev") {
      if (out.deviceIndex !== null) return null;
      out.kind = "device";
      out.deviceIndex = val;
      i += 2;
    } else if (seg === "par") {
      if (out.paramIndex !== null) return null;
      out.kind = "parameter";
      out.paramIndex = val;
      i += 2;
    } else if (seg === "send") {
      if (out.sendIndex !== null) return null;
      out.kind = "send";
      out.sendIndex = val;
      i += 2;
    } else {
      return null;
    }
  }
  return out;
}

/**
 * Stable write-queue key for a parsed mix id. Same `parsed` → same key, so
 * the per-target serialisation in `ws.ts` collapses writes correctly.
 */
export function mixWriteQueueKeyFor(parsed: MixParsedId): string {
  switch (parsed.kind) {
    case "track":
      if (parsed.type === "master") return "mix:main:volume";
      return `track:${parsed.type}:${parsed.trackIndex}`;
    case "send":
      return `send:${parsed.type}:${parsed.trackIndex}:${parsed.sendIndex ?? 0}`;
    case "parameter":
      return `param:${parsed.type}:${parsed.trackIndex}:${parsed.deviceIndex ?? 0}:${parsed.paramIndex ?? 0}`;
    case "device":
      return `device:${parsed.type}:${parsed.trackIndex}:${parsed.deviceIndex ?? 0}`;
    default:
      return `unknown:${Date.now()}:${Math.random()}`;
  }
}
