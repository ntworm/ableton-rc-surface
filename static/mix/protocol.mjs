// Mix View protocol helpers (pure, no SDK, no DOM).
//
// These helpers are shared by the server (extension.ts) and the client
// (static/mix/app.js) to keep the wire shape and ID scheme in sync.
// Anything that touches the live SDK lives in extension.ts; anything
// here is testable with `node --test` and runs in the browser too.
//
// IDs are stable for the lifetime of a Live session. They are NOT
// `handle.id` values (we don't rely on the SDK exposing those); they
// are composite strings built from song-level indexes:
//
//   track (regular):  mix:track:<index>
//   track (return):   mix:return:<index>
//   track (main):     mix:main
//   device:           <trackId>:dev:<index>
//   parameter:        <deviceId>:par:<index>
//   send:             <trackId>:send:<index>
//
// The server resolves an ID back to a Live handle by parsing it. If
// the indexes no longer resolve (track deleted, device reordered)
// the server returns mix.error with reason="not_found".

export const MIX_PROTOCOL_VERSION = 1;

export const TRACK_TYPES = Object.freeze({
  REGULAR: "regular",
  GROUP: "group",
  RETURN: "return",
  MASTER: "master",
});

// Server -> client snapshot messages.
export const SERVER_MSG = Object.freeze({
  HELLO: "mix.hello",
  SNAPSHOT: "mix.snapshot",
  TRACKS_CHANGED: "mix.tracks_changed",
  ERROR: "mix.error",
  ACK: "mix.ack",
  CLOSE: "mix.close",
});

// Client -> server command messages.
export const CLIENT_CMD = Object.freeze({
  SET_VOLUME: "mix.setVolume",
  SET_PAN: "mix.setPan",
  TOGGLE_MUTE: "mix.toggleMute",
  TOGGLE_SOLO: "mix.toggleSolo",
  SET_SEND: "mix.setSend",
  SET_PARAM: "mix.setParam",
  RESCAN: "mix.rescan",
  SET_SELECTION: "mix.setSelection",
});

const ALL_CMDS = new Set(Object.values(CLIENT_CMD));
const NUM_0_1 = (v) => typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 1;
const NUM_NEG1_1 = (v) => typeof v === "number" && Number.isFinite(v) && v >= -1 && v <= 1;
const STR = (v) => typeof v === "string" && v.length > 0;

// ---------------- ID helpers ----------------

export function trackId(type, index) {
  if (type === TRACK_TYPES.MASTER) return "mix:main";
  if (type === TRACK_TYPES.RETURN) return `mix:return:${index}`;
  if (type === TRACK_TYPES.REGULAR || type === TRACK_TYPES.GROUP) return `mix:track:${index}`;
  throw new Error(`invalid track type: ${String(type)}`);
}

export function deviceId(trackIdentifier, deviceIndex) {
  return `${trackIdentifier}:dev:${deviceIndex}`;
}

export function paramId(deviceIdentifier, paramIndex) {
  return `${deviceIdentifier}:par:${paramIndex}`;
}

export function sendId(trackIdentifier, sendIndex) {
  return `${trackIdentifier}:send:${sendIndex}`;
}

// Internal: walk the segments after the track root, looking for
// :dev:N, :par:N, :send:N. Mutates `out` in place. Returns true if
// every consumed segment was valid.
function applySubSegments(parts, start, out) {
  let i = start;
  while (i < parts.length) {
    const seg = parts[i];
    const val = Number(parts[i + 1]);
    if (!Number.isInteger(val) || val < 0) return false;
    if (seg === "dev") {
      if (out.deviceIndex !== null) return false;
      out.kind = "device";
      out.deviceIndex = val;
      i += 2;
    } else if (seg === "par") {
      if (out.paramIndex !== null) return false;
      out.kind = "parameter";
      out.paramIndex = val;
      i += 2;
    } else if (seg === "send") {
      if (out.sendIndex !== null) return false;
      out.kind = "send";
      out.sendIndex = val;
      i += 2;
    } else {
      return false;
    }
  }
  return true;
}

export function parseId(id) {
  if (typeof id !== "string" || !id) return null;
  const parts = id.split(":");
  // shape: <root>[:dev:<n>][:par:<n>] | <root>:send:<n>
  // root: "mix:track:n" | "mix:return:n" | "mix:main"
  if (parts[0] !== "mix" || parts.length < 2) return null;
  const out = { kind: "track", type: null, trackIndex: null, deviceIndex: null, paramIndex: null, sendIndex: null };
  if (parts[1] === "main") {
    out.type = TRACK_TYPES.MASTER;
    out.trackIndex = 0;
    if (parts.length === 2) return out;
    if (!applySubSegments(parts, 2, out)) return null;
    return out;
  }
  if (parts[1] === "track" || parts[1] === "return") {
    out.type = parts[1] === "return" ? TRACK_TYPES.RETURN : TRACK_TYPES.REGULAR;
    const idx = Number(parts[2]);
    if (!Number.isInteger(idx) || idx < 0) return null;
    out.trackIndex = idx;
    if (parts.length === 3) return out;
    if (!applySubSegments(parts, 3, out)) return null;
    return out;
  }
  return null;
}

// Stable per-target queue key. Used by the server's per-target write
// queue to serialise commands that target the same Live handle.
export function writeQueueKey(parsedId) {
  if (!parsedId) return null;
  switch (parsedId.kind) {
    case "track":
      if (parsedId.type === TRACK_TYPES.MASTER) return "mix:main:volume";
      return `track:${parsedId.type}:${parsedId.trackIndex}`;
    case "send":
      return `send:${parsedId.type}:${parsedId.trackIndex}:${parsedId.sendIndex}`;
    case "parameter":
      return `param:${parsedId.type}:${parsedId.trackIndex}:${parsedId.deviceIndex}:${parsedId.paramIndex}`;
    default:
      return null;
  }
}

// ---------------- Command validation ----------------

export function validateCommand(msg) {
  if (!msg || typeof msg !== "object") return "msg must be an object";
  if (typeof msg.type !== "string") return "type must be a string";
  if (!ALL_CMDS.has(msg.type)) return `unknown command type: ${msg.type}`;
  if (typeof msg.refId !== "string" || !msg.refId) return "refId must be a non-empty string";
  const p = parseId(msg.targetId);
  if (!p) return `invalid targetId: ${String(msg.targetId)}`;

  switch (msg.type) {
    case CLIENT_CMD.SET_VOLUME:
      if (!NUM_0_1(msg.value)) return "value must be 0..1";
      if (p.kind !== "track" || p.type === TRACK_TYPES.RETURN) {
        return "setVolume target must be a regular, group, or main track";
      }
      return null;
    case CLIENT_CMD.SET_PAN:
      if (!NUM_NEG1_1(msg.value)) return "value must be -1..1";
      if (p.kind !== "track" || p.type === TRACK_TYPES.RETURN) {
        return "setPan target must be a regular, group, or main track";
      }
      return null;
    case CLIENT_CMD.TOGGLE_MUTE:
      if (p.kind !== "track" || p.type === TRACK_TYPES.RETURN) {
        return "toggleMute target must be a regular, group, or main track";
      }
      return null;
    case CLIENT_CMD.TOGGLE_SOLO:
      if (p.kind !== "track" || p.type === TRACK_TYPES.RETURN || p.type === TRACK_TYPES.MASTER) {
        return "toggleSolo target must be a regular or group track";
      }
      return null;
    case CLIENT_CMD.SET_SEND:
      if (!NUM_0_1(msg.value)) return "value must be 0..1";
      if (p.kind !== "send") return "setSend target must be a send";
      if (p.type === TRACK_TYPES.MASTER) return "master has no sends";
      return null;
    case CLIENT_CMD.SET_PARAM:
      if (!NUM_0_1(msg.value)) return "value must be 0..1";
      if (p.kind !== "parameter") return "setParam target must be a parameter";
      return null;
    case CLIENT_CMD.RESCAN:
      return null;
    case CLIENT_CMD.SET_SELECTION: {
      // The selection hint is metadata, not a value command. The
      // server still requires a syntactically valid targetId so it
      // can log/cross-reference; the value of the selection lives
      // in msg.selection.trackId / deviceId.
      if (p.kind !== "track") {
        return "setSelection targetId must be a track (regular, group, return, or master)";
      }
      return null;
    }
    default:
      return `unhandled command type: ${msg.type}`;
  }
}

// ---------------- Normalisation helpers (server-side use; client mirrors) ----------------

// The wire sends values in 0..1 (volume, send, parameter). The server
// scales them to the param's min..max before calling setValue.
export function wireToRange(normalised, min, max) {
  return min + normalised * (max - min);
}

// Reverse direction, used by the server when building snapshots.
export function rangeToWire(value, min, max) {
  if (max <= min) return 0;
  return Math.max(0, Math.min(1, (value - min) / (max - min)));
}

// ---------------- Generic template kind detection ----------------

// The server includes these fields per parameter in the snapshot:
//   { id, name, value (0..1), min, max, defaultValue, isQuantized,
//     valueItems: [{name, shortName}], kind, isReadOnly }
//
// `kind` is decided by the server from isQuantized + valueItems length.
// The client never has to call .getValue() itself.
export const PARAM_KIND = Object.freeze({
  CONTINUOUS: "continuous",
  ENUM: "enum",
  TOGGLE: "toggle",
  DISABLED: "disabled",
});

export function paramKindFromDescriptor(p) {
  if (!p) return PARAM_KIND.DISABLED;
  if (p.isReadOnly === true) return PARAM_KIND.DISABLED;
  if (p.isQuantized === true) {
    if (Array.isArray(p.valueItems) && p.valueItems.length > 1) {
      return PARAM_KIND.ENUM;
    }
    if (Array.isArray(p.valueItems) && p.valueItems.length === 1) {
      // Two-state quantised, but we cannot know the off-state name.
      return PARAM_KIND.TOGGLE;
    }
    // isQuantized with no valueItems: integer slider with steps; client
    // can still render as a slider; mark as continuous with steps.
    return PARAM_KIND.CONTINUOUS;
  }
  return PARAM_KIND.CONTINUOUS;
}

// ---------------- Snapshot shape validators (light) ----------------

export function isTrackSnapshot(t) {
  if (!t || typeof t !== "object") return false;
  if (typeof t.id !== "string") return false;
  if (typeof t.name !== "string") return false;
  if (![TRACK_TYPES.REGULAR, TRACK_TYPES.GROUP, TRACK_TYPES.RETURN, TRACK_TYPES.MASTER].includes(t.type)) return false;
  if (typeof t.volume !== "number") return false;
  if (typeof t.pan !== "number") return false;
  if (typeof t.mute !== "boolean") return false;
  if (typeof t.solo !== "boolean") return false;
  if (!Array.isArray(t.sends)) return false;
  if (!Array.isArray(t.devices)) return false;
  return true;
}
