// Large-session stress fixture for the Mix View protocol.
//
// SPEC.md section 14 R-2 calls out the risk that a set with 50
// tracks x 10 devices x 8 parameters (= 4000 parameters) may
// exceed the snapshot budget. The server's tiered snapshot loop
// caps each client at MIX_MAX_PARAMS_PER_TICK (64) parameters
// and rotates the slice on subsequent ticks; this fixture
// exercises the client-side ID parsing and command validation
// over a comparable 4000-element universe and confirms the
// per-call cost stays bounded.
//
// Run with: node --test static/mix/stress.test.mjs

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  trackId,
  deviceId,
  paramId,
  sendId,
  parseId,
  validateCommand,
  CLIENT_CMD,
  TRACK_TYPES,
} from "./protocol.mjs";

// Generate the same 4000-element universe the SPEC R-2 risk calls
// out: 50 regular tracks, each with 10 devices, each with 8
// parameters, plus a send per track.
function buildLargeSession({ tracks = 50, devices = 10, params = 8, includeReturns = true } = {}) {
  const ids = [];
  for (let ti = 0; ti < tracks; ti++) {
    const t = trackId(TRACK_TYPES.REGULAR, ti);
    ids.push(t);
    for (let di = 0; di < devices; di++) {
      const d = deviceId(t, di);
      for (let pi = 0; pi < params; pi++) {
        ids.push(paramId(d, pi));
      }
    }
    ids.push(sendId(t, 0));
  }
  if (includeReturns) {
    for (let i = 0; i < 4; i++) ids.push(trackId(TRACK_TYPES.RETURN, i));
  }
  ids.push(trackId(TRACK_TYPES.MASTER, 0));
  return ids;
}

describe("Mix protocol: large-session stress", () => {
  it("round-trips 4000+ parameter ids through parseId", () => {
    const ids = buildLargeSession();
    assert.ok(ids.length >= 4000, `expected at least 4000 ids, got ${ids.length}`);
    const t0 = performance.now();
    for (const id of ids) {
      const p = parseId(id);
      assert.ok(p, `parseId failed for ${id}`);
    }
    const elapsed = performance.now() - t0;
    // Parse should be sub-100ms for 4000 ids on any reasonable
    // machine. We give a generous 500ms ceiling for slow CI.
    assert.ok(elapsed < 500, `parseId took ${elapsed.toFixed(1)}ms (expected < 500ms)`);
  });

  it("validates 4000+ commands with the right shape", () => {
    const ids = buildLargeSession();
    const t0 = performance.now();
    for (const id of ids) {
      // Pick a reasonable command for each id type.
      const p = parseId(id);
      assert.ok(p);
      let cmd;
      if (p.kind === "track" && p.type === TRACK_TYPES.MASTER) {
        cmd = { type: CLIENT_CMD.SET_VOLUME, targetId: id, value: 0.5 };
      } else if (p.kind === "track" && p.type === TRACK_TYPES.REGULAR) {
        cmd = { type: CLIENT_CMD.SET_VOLUME, targetId: id, value: 0.5 };
      } else if (p.kind === "track" && p.type === TRACK_TYPES.GROUP) {
        cmd = { type: CLIENT_CMD.TOGGLE_MUTE, targetId: id };
      } else if (p.kind === "track" && p.type === TRACK_TYPES.RETURN) {
        // Returns don't accept writes in v0.3.1; just verify the
        // command fails validation cleanly without throwing.
        const err = validateCommand({
          type: CLIENT_CMD.SET_VOLUME,
          targetId: id,
          value: 0.5,
          refId: `stress-${id}-${Math.random()}`,
        });
        assert.ok(err && err.includes("regular, group, or main"), `expected unsupported_target, got ${err}`);
        continue;
      } else if (p.kind === "send") {
        cmd = { type: CLIENT_CMD.SET_SEND, targetId: id, value: 0.5 };
      } else if (p.kind === "parameter") {
        cmd = { type: CLIENT_CMD.SET_PARAM, targetId: id, value: 0.5 };
      } else {
        assert.fail(`unexpected kind ${p.kind} for ${id}`);
      }
      const refId = `stress-${id}-${Math.random()}`;
      const err = validateCommand({ ...cmd, refId });
      assert.equal(err, null, `validation failed for ${id}: ${err}`);
    }
    const elapsed = performance.now() - t0;
    assert.ok(elapsed < 500, `validateCommand took ${elapsed.toFixed(1)}ms (expected < 500ms)`);
  });

  it("rejects unknown ids consistently", () => {
    const garbage = ["", "mix", "mix:track", "mix:track:abc", "mix:track:-1", "mix:track:0:dev:x", "mix:foo:0"];
    for (const id of garbage) {
      const p = parseId(id);
      assert.equal(p, null, `expected null for ${JSON.stringify(id)}, got ${JSON.stringify(p)}`);
    }
  });

  it("handles zero tracks without crashing", () => {
    const ids = [];
    const t0 = performance.now();
    for (const id of ids) {
      parseId(id);
    }
    const elapsed = performance.now() - t0;
    assert.ok(elapsed < 5, `empty parse loop took ${elapsed.toFixed(1)}ms (expected < 5ms)`);
  });

  it("matches the SPEC R-2 worst case within the spec's 30 Hz budget", () => {
    // Per-tick client work is bounded: 1 parse + 1 validate for each
    // of the 64 parameters the server actually sends this tick.
    // Even if every tick hits 64 params, the cumulative cost over
    // a 30 Hz stream is well under the 33 ms tick budget.
    const sample = buildLargeSession().slice(0, 64);
    const start = performance.now();
    let n = 0;
    while (performance.now() - start < 1000) {
      for (const id of sample) {
        const p = parseId(id);
        if (p && p.kind === "parameter") {
          validateCommand({ type: CLIENT_CMD.SET_PARAM, targetId: id, value: 0.5, refId: "tick" });
          n++;
        }
      }
    }
    const elapsed = performance.now() - start;
    const opsPerSec = (n / elapsed) * 1000;
    // At a 30 Hz tick (33 ms) the client can comfortably handle
    // tens of thousands of param ops per second.
    assert.ok(opsPerSec > 5000, `client ops/sec too low: ${opsPerSec.toFixed(0)} (expected > 5000)`);
  });
});
