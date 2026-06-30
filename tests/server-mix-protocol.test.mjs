import test from "node:test";
import assert from "node:assert/strict";

// GREEN once Task 6 (mix-protocol split) is in place.
// Contract: src/server/mix-protocol.ts owns the pure parser; ws.ts
// re-exports for legacy callers. mix:group:<n> is rejected because groups
// are encoded as mix:track:<n> with the Ableton trackKind.

test("mixParseId exists in mix-protocol module", async () => {
  const mod = await import("../src/server/mix-protocol.ts");
  assert.equal(typeof mod.mixParseId, "function",
    "mixParseId must be exported from mix-protocol.ts");
});

test("mixParseId accepts valid mix IDs (track, return, main)", async () => {
  const { mixParseId } = await import("../src/server/mix-protocol.ts");

  assert.ok(mixParseId("mix:track:0"), "track 0");
  assert.ok(mixParseId("mix:track:5"), "track 5");
  assert.ok(mixParseId("mix:return:0"), "return 0");
  assert.ok(mixParseId("mix:return:2"), "return 2");
  assert.ok(mixParseId("mix:main"), "main bare");
  assert.ok(mixParseId("mix:main:dev:0"), "main + device");
  assert.ok(mixParseId("mix:track:3:dev:1"), "track + device");
  assert.ok(mixParseId("mix:track:3:dev:1:par:2"), "track + device + param");
  assert.ok(mixParseId("mix:track:3:send:0"), "track + send");
});

test("mixParseId rejects malformed inputs (never throws, returns null)", async () => {
  const { mixParseId } = await import("../src/server/mix-protocol.ts");

  // Garbage / wrong prefix
  assert.equal(mixParseId("garbage"), null);
  assert.equal(mixParseId("track:0"), null);
  assert.equal(mixParseId("mix"), null);
  assert.equal(mixParseId("mix:track"), null);

  // Empty / non-string
  assert.equal(mixParseId(""), null);
  assert.equal(mixParseId(null), null);
  assert.equal(mixParseId(undefined), null);
  assert.equal(mixParseId(42), null);
  assert.equal(mixParseId({}), null);
  assert.equal(mixParseId([]), null);

  // Bad indices / wrong segment
  assert.equal(mixParseId("mix:track:abc"), null);
  assert.equal(mixParseId("mix:track:-1"), null);
  assert.equal(mixParseId("mix:return:abc"), null);
  assert.equal(mixParseId("mix:track:1:foo:0"), null, "unknown subsegment");
  assert.equal(mixParseId("mix:track:1:dev:0:dev:1"), null, "duplicate dev");

  // mix:group:<n> is deliberately rejected: groups use mix:track:<n>.
  assert.equal(mixParseId("mix:group:1"), null,
    "group is encoded as mix:track:<n>, not mix:group:<n>");
});

test("mixParseId parsed shape carries correct fields", async () => {
  const { mixParseId } = await import("../src/server/mix-protocol.ts");

  const t = mixParseId("mix:track:7");
  assert.ok(t);
  assert.equal(t.kind, "track");
  assert.equal(t.type, "regular");
  assert.equal(t.trackIndex, 7);
  assert.equal(t.deviceIndex, null);

  const dp = mixParseId("mix:track:3:dev:1:par:2");
  assert.ok(dp);
  assert.equal(dp.kind, "parameter");
  assert.equal(dp.trackIndex, 3);
  assert.equal(dp.deviceIndex, 1);
  assert.equal(dp.paramIndex, 2);

  const s = mixParseId("mix:return:1:send:0");
  assert.ok(s);
  assert.equal(s.kind, "send");
  assert.equal(s.type, "return");
  assert.equal(s.sendIndex, 0);

  const m = mixParseId("mix:main");
  assert.ok(m);
  assert.equal(m.type, "master");
});

test("mixWriteQueueKeyFor returns stable string per parsed id", async () => {
  const { mixParseId, mixWriteQueueKeyFor } = await import("../src/server/mix-protocol.ts");
  const parsed = mixParseId("mix:track:7");
  assert.ok(parsed);
  const k1 = mixWriteQueueKeyFor(parsed);
  const k2 = mixWriteQueueKeyFor(parsed);
  assert.equal(typeof k1, "string");
  assert.ok(k1.length > 0);
  assert.equal(k1, k2, "same parsed id should produce same queue key");
});
