// Copyright © 2026 Gabriel Worm
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Source: https://github.com/ntworm/ableton-rc-surface
//
// This file is part of Ableton RC Surface, distributed under the
// PolyForm Noncommercial License 1.0.0. You may obtain a copy of
// the License at https://polyformproject.org/licenses/noncommercial/1.0.0
import test from "node:test";
import assert from "node:assert/strict";

// Verify payload includes the 4 raw Live scale props from song so downstream
// clients receive the complete Live state contract.

const mod = await import("../src/live/state.ts");

test("computeLiveStatePayload: includes scaleMode, scaleName, rootNote, scaleIntervals from song", () => {
  const { computeLiveStatePayload } = mod;
  const payload = computeLiveStatePayload({
    tempo: 120,
    scenes: [{ signatureNumerator: 4, signatureDenominator: 4 }],
    scaleMode: true,
    scaleName: "Minor",
    rootNote: 2,
    scaleIntervals: [0, 2, 3, 5, 7, 8, 10],
  });
  assert.equal(payload.type, "live_state");
  assert.equal(payload.tempo, 120);
  assert.equal(payload.signature, "4/4");
  assert.equal(payload.scale, "D Minor");          // existing derived label
  // NEW: raw scale props for V1B knob overlay rendering
  assert.equal(payload.scaleMode, true);
  assert.equal(payload.scaleName, "Minor");
  assert.equal(payload.rootNote, 2);
  assert.deepEqual(payload.scaleIntervals, [0, 2, 3, 5, 7, 8, 10]);
});

test("computeLiveStatePayload: scale OFF yields scaleMode=false but still emits the rest", () => {
  const { computeLiveStatePayload } = mod;
  const payload = computeLiveStatePayload({
    tempo: 90,
    scenes: [{ signatureNumerator: 3, signatureDenominator: 4 }],
    scaleMode: false,
    scaleName: "Major",
    rootNote: 0,
    scaleIntervals: [0, 2, 4, 5, 7, 9, 11],
  });
  assert.equal(payload.scaleMode, false);
  assert.equal(payload.scaleName, "Major");
  assert.equal(payload.rootNote, 0);
  assert.deepEqual(payload.scaleIntervals, [0, 2, 4, 5, 7, 9, 11]);
  assert.equal(payload.signature, "3/4");
});

test("computeLiveStatePayload: handles missing scenes gracefully (defaults to 4/4)", () => {
  const { computeLiveStatePayload } = mod;
  const payload = computeLiveStatePayload({
    tempo: 100,
    scenes: [],
    scaleMode: false,
    scaleName: "Major",
    rootNote: 0,
    scaleIntervals: [0, 2, 4, 5, 7, 9, 11],
  });
  assert.equal(payload.signature, "4/4");
});
