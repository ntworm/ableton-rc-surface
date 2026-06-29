// Tests for the Mix View protocol helpers.
// Run with: node --test static/mix/protocol.test.mjs

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  MIX_PROTOCOL_VERSION,
  TRACK_TYPES,
  SERVER_MSG,
  CLIENT_CMD,
  trackId,
  deviceId,
  paramId,
  sendId,
  parseId,
  writeQueueKey,
  validateCommand,
  wireToRange,
  rangeToWire,
  paramKindFromDescriptor,
  PARAM_KIND,
  isTrackSnapshot,
} from "./protocol.mjs";

describe("Mix protocol constants", () => {
  it("exposes a single protocol version", () => {
    assert.equal(MIX_PROTOCOL_VERSION, 1);
  });

  it("exposes all four track types", () => {
    assert.equal(TRACK_TYPES.REGULAR, "regular");
    assert.equal(TRACK_TYPES.GROUP, "group");
    assert.equal(TRACK_TYPES.RETURN, "return");
    assert.equal(TRACK_TYPES.MASTER, "master");
  });

  it("exposes client and server message constants", () => {
    assert.equal(SERVER_MSG.SNAPSHOT, "mix.snapshot");
    assert.equal(CLIENT_CMD.SET_VOLUME, "mix.setVolume");
    assert.equal(CLIENT_CMD.SET_PARAM, "mix.setParam");
    assert.equal(CLIENT_CMD.RESCAN, "mix.rescan");
  });
});

describe("trackId / deviceId / paramId / sendId", () => {
  it("encodes the master track as mix:main", () => {
    assert.equal(trackId(TRACK_TYPES.MASTER, 0), "mix:main");
  });

  it("encodes regular and group tracks with the same shape", () => {
    assert.equal(trackId(TRACK_TYPES.REGULAR, 3), "mix:track:3");
    assert.equal(trackId(TRACK_TYPES.GROUP, 1), "mix:track:1");
  });

  it("encodes return tracks as mix:return:<n>", () => {
    assert.equal(trackId(TRACK_TYPES.RETURN, 2), "mix:return:2");
  });

  it("throws on unknown track type", () => {
    assert.throws(() => trackId("bogus", 0), /invalid track type/);
  });

  it("encodes device, parameter, and send ids", () => {
    const t = trackId(TRACK_TYPES.REGULAR, 0);
    const d = deviceId(t, 2);
    assert.equal(d, "mix:track:0:dev:2");
    const p = paramId(d, 5);
    assert.equal(p, "mix:track:0:dev:2:par:5");
    const s = sendId(t, 1);
    assert.equal(s, "mix:track:0:send:1");
  });
});

describe("parseId round-trips", () => {
  it("round-trips a regular track", () => {
    const id = trackId(TRACK_TYPES.REGULAR, 4);
    const p = parseId(id);
    assert.deepEqual(p, { kind: "track", type: "regular", trackIndex: 4, deviceIndex: null, paramIndex: null, sendIndex: null });
  });

  it("round-trips a return track", () => {
    const p = parseId(trackId(TRACK_TYPES.RETURN, 2));
    assert.equal(p.kind, "track");
    assert.equal(p.type, "return");
    assert.equal(p.trackIndex, 2);
  });

  it("round-trips a main track", () => {
    const p = parseId(trackId(TRACK_TYPES.MASTER, 0));
    assert.equal(p.kind, "track");
    assert.equal(p.type, "master");
    assert.equal(p.trackIndex, 0);
  });

  it("round-trips a device id", () => {
    const p = parseId(deviceId(trackId(TRACK_TYPES.REGULAR, 0), 1));
    assert.equal(p.kind, "device");
    assert.equal(p.type, "regular");
    assert.equal(p.trackIndex, 0);
    assert.equal(p.deviceIndex, 1);
  });

  it("round-trips a parameter id", () => {
    const p = parseId(paramId(deviceId(trackId(TRACK_TYPES.REGULAR, 0), 1), 3));
    assert.equal(p.kind, "parameter");
    assert.equal(p.deviceIndex, 1);
    assert.equal(p.paramIndex, 3);
  });

  it("round-trips a send id", () => {
    const p = parseId(sendId(trackId(TRACK_TYPES.REGULAR, 0), 2));
    assert.equal(p.kind, "send");
    assert.equal(p.sendIndex, 2);
  });

  it("rejects malformed ids", () => {
    assert.equal(parseId(""), null);
    assert.equal(parseId(null), null);
    assert.equal(parseId("not:an:id"), null);
    assert.equal(parseId("mix:track"), null); // missing index
    assert.equal(parseId("mix:track:abc"), null); // non-numeric
    assert.equal(parseId("mix:track:0:bogus:1"), null); // unknown segment
  });
});

describe("writeQueueKey", () => {
  it("returns a stable per-target key for tracks", () => {
    const p = parseId(trackId(TRACK_TYPES.REGULAR, 0));
    assert.equal(writeQueueKey(p), "track:regular:0");
  });

  it("returns a different key for the master track", () => {
    const p = parseId(trackId(TRACK_TYPES.MASTER, 0));
    assert.equal(writeQueueKey(p), "mix:main:volume");
  });

  it("returns a unique key per parameter", () => {
    const a = parseId(paramId(deviceId(trackId(TRACK_TYPES.REGULAR, 0), 0), 0));
    const b = parseId(paramId(deviceId(trackId(TRACK_TYPES.REGULAR, 0), 0), 1));
    assert.notEqual(writeQueueKey(a), writeQueueKey(b));
  });

  it("returns null for unparseable ids", () => {
    assert.equal(writeQueueKey(null), null);
  });
});

describe("validateCommand", () => {
  it("rejects messages with no type", () => {
    assert.match(validateCommand({ refId: "r1", targetId: trackId(TRACK_TYPES.REGULAR, 0) }), /type/);
  });

  it("rejects unknown command types", () => {
    const r = validateCommand({ type: "mix.explode", refId: "r1", targetId: trackId(TRACK_TYPES.REGULAR, 0) });
    assert.match(r, /unknown command type/);
  });

  it("rejects empty refId", () => {
    const r = validateCommand({ type: CLIENT_CMD.TOGGLE_MUTE, refId: "", targetId: trackId(TRACK_TYPES.REGULAR, 0) });
    assert.match(r, /refId/);
  });

  it("accepts mix.setVolume on regular track with 0..1", () => {
    assert.equal(validateCommand({
      type: CLIENT_CMD.SET_VOLUME,
      refId: "r1",
      targetId: trackId(TRACK_TYPES.REGULAR, 0),
      value: 0.5,
    }), null);
  });

  it("rejects mix.setVolume with out-of-range value", () => {
    assert.match(validateCommand({
      type: CLIENT_CMD.SET_VOLUME,
      refId: "r1",
      targetId: trackId(TRACK_TYPES.REGULAR, 0),
      value: 1.5,
    }), /value/);
  });

  it("rejects mix.setVolume on a return track", () => {
    const r = validateCommand({
      type: CLIENT_CMD.SET_VOLUME,
      refId: "r1",
      targetId: trackId(TRACK_TYPES.RETURN, 0),
      value: 0.5,
    });
    assert.match(r, /regular, group, or main/);
  });

  it("accepts mix.setPan with -1..1", () => {
    assert.equal(validateCommand({
      type: CLIENT_CMD.SET_PAN,
      refId: "r1",
      targetId: trackId(TRACK_TYPES.REGULAR, 0),
      value: -1,
    }), null);
  });

  it("rejects mix.setPan on a master track (not yet supported)", () => {
    // master may not have panning in all Live versions; the server
    // answers for itself. For v0.3.1, accept master pan.
    assert.equal(validateCommand({
      type: CLIENT_CMD.SET_PAN,
      refId: "r1",
      targetId: trackId(TRACK_TYPES.MASTER, 0),
      value: 0,
    }), null);
  });

  it("accepts mix.toggleMute on regular, group, main", () => {
    for (const t of [TRACK_TYPES.REGULAR, TRACK_TYPES.GROUP, TRACK_TYPES.MASTER]) {
      assert.equal(validateCommand({
        type: CLIENT_CMD.TOGGLE_MUTE,
        refId: "r1",
        targetId: trackId(t, 0),
      }), null);
    }
  });

  it("rejects mix.toggleSolo on master", () => {
    const r = validateCommand({
      type: CLIENT_CMD.TOGGLE_SOLO,
      refId: "r1",
      targetId: trackId(TRACK_TYPES.MASTER, 0),
    });
    assert.match(r, /regular or group/);
  });

  it("accepts mix.setSend with 0..1 on a regular send id", () => {
    assert.equal(validateCommand({
      type: CLIENT_CMD.SET_SEND,
      refId: "r1",
      targetId: sendId(trackId(TRACK_TYPES.REGULAR, 0), 0),
      value: 0.75,
    }), null);
  });

  it("rejects mix.setSend with a track id (not a send id)", () => {
    const r = validateCommand({
      type: CLIENT_CMD.SET_SEND,
      refId: "r1",
      targetId: trackId(TRACK_TYPES.REGULAR, 0),
      value: 0.5,
    });
    assert.match(r, /must be a send/);
  });

  it("rejects mix.setSend on a master track (no sends)", () => {
    const r = validateCommand({
      type: CLIENT_CMD.SET_SEND,
      refId: "r1",
      targetId: sendId(trackId(TRACK_TYPES.MASTER, 0), 0),
      value: 0.5,
    });
    assert.match(r, /master has no sends/);
  });

  it("accepts mix.setParam on a parameter id with 0..1", () => {
    const p = paramId(deviceId(trackId(TRACK_TYPES.REGULAR, 0), 0), 0);
    assert.equal(validateCommand({
      type: CLIENT_CMD.SET_PARAM,
      refId: "r1",
      targetId: p,
      value: 0.25,
    }), null);
  });

  it("rejects mix.setParam on a non-parameter id", () => {
    const r = validateCommand({
      type: CLIENT_CMD.SET_PARAM,
      refId: "r1",
      targetId: trackId(TRACK_TYPES.REGULAR, 0),
      value: 0.5,
    });
    assert.match(r, /must be a parameter/);
  });

  it("accepts mix.rescan on any valid id", () => {
    assert.equal(validateCommand({
      type: CLIENT_CMD.RESCAN,
      refId: "r1",
      targetId: trackId(TRACK_TYPES.REGULAR, 0),
    }), null);
  });

  it("accepts mix.setSelection on a track id", () => {
    assert.equal(validateCommand({
      type: CLIENT_CMD.SET_SELECTION,
      refId: "r1",
      targetId: trackId(TRACK_TYPES.REGULAR, 0),
      selection: { trackId: trackId(TRACK_TYPES.REGULAR, 0), deviceId: null },
    }), null);
  });

  it("rejects mix.setSelection on a parameter id", () => {
    const r = validateCommand({
      type: CLIENT_CMD.SET_SELECTION,
      refId: "r1",
      targetId: paramId(deviceId(trackId(TRACK_TYPES.REGULAR, 0), 0), 0),
    });
    assert.match(r, /must be a track/);
  });
});

describe("wireToRange / rangeToWire", () => {
  it("maps 0..1 to min..max", () => {
    assert.equal(wireToRange(0, 0, 100), 0);
    assert.equal(wireToRange(1, 0, 100), 100);
    assert.equal(wireToRange(0.5, -12, 12), 0);
  });

  it("clamps the inverse to 0..1", () => {
    assert.equal(rangeToWire(0, 0, 100), 0);
    assert.equal(rangeToWire(100, 0, 100), 1);
    assert.equal(rangeToWire(-1, 0, 100), 0);
    assert.equal(rangeToWire(101, 0, 100), 1);
  });

  it("returns 0 when max <= min", () => {
    assert.equal(rangeToWire(42, 10, 10), 0);
  });
});

describe("paramKindFromDescriptor", () => {
  it("detects enum when isQuantized and valueItems > 1", () => {
    const p = { isQuantized: true, valueItems: [{ name: "A" }, { name: "B" }] };
    assert.equal(paramKindFromDescriptor(p), PARAM_KIND.ENUM);
  });

  it("detects toggle when isQuantized and valueItems is 1", () => {
    const p = { isQuantized: true, valueItems: [{ name: "On" }] };
    assert.equal(paramKindFromDescriptor(p), PARAM_KIND.TOGGLE);
  });

  it("detects continuous when not quantized", () => {
    const p = { isQuantized: false, valueItems: [] };
    assert.equal(paramKindFromDescriptor(p), PARAM_KIND.CONTINUOUS);
  });

  it("returns disabled for null/undefined", () => {
    assert.equal(paramKindFromDescriptor(null), PARAM_KIND.DISABLED);
    assert.equal(paramKindFromDescriptor(undefined), PARAM_KIND.DISABLED);
  });

  it("returns disabled when isReadOnly is true", () => {
    const p = { isQuantized: false, valueItems: [], isReadOnly: true };
    assert.equal(paramKindFromDescriptor(p), PARAM_KIND.DISABLED);
  });
});

describe("isTrackSnapshot", () => {
  const valid = {
    id: trackId(TRACK_TYPES.REGULAR, 0),
    name: "Drums",
    type: TRACK_TYPES.REGULAR,
    volume: 0.8,
    pan: 0,
    mute: false,
    solo: false,
    sends: [],
    devices: [],
  };

  it("accepts a valid regular track", () => {
    assert.equal(isTrackSnapshot(valid), true);
  });

  it("rejects a track missing fields", () => {
    const bad = { ...valid };
    delete bad.volume;
    assert.equal(isTrackSnapshot(bad), false);
  });

  it("rejects a track with wrong type", () => {
    assert.equal(isTrackSnapshot({ ...valid, type: "bogus" }), false);
  });

  it("rejects non-objects", () => {
    assert.equal(isTrackSnapshot(null), false);
    assert.equal(isTrackSnapshot("x"), false);
  });
});
