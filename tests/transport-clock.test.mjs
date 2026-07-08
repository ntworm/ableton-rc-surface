import assert from "node:assert/strict";
import test from "node:test";
import {
  computeBeatPosition,
  computeSyncedLfoValue,
  computeSyncedStutterValue
} from "../src/live/transport-clock.ts";

test("computeBeatPosition calculates beat, bar and phase correctly", () => {
  // At 0 beats in a 4/4 signature
  assert.deepEqual(computeBeatPosition(0, 4), { beat: 1, bar: 1, phase: 0 });

  // At 2.5 beats (3rd beat, half-phase)
  assert.deepEqual(computeBeatPosition(2.5, 4), { beat: 3, bar: 1, phase: 0.5 });

  // At 5.75 beats (2nd beat, 2nd bar)
  assert.deepEqual(computeBeatPosition(5.75, 4), { beat: 2, bar: 2, phase: 0.75 });

  // Fallback on invalid numerator (defaults to 4)
  assert.deepEqual(computeBeatPosition(2.5, 0), { beat: 3, bar: 1, phase: 0.5 });
  assert.deepEqual(computeBeatPosition(2.5, -1), { beat: 3, bar: 1, phase: 0.5 });
  assert.deepEqual(computeBeatPosition(2.5, NaN), { beat: 3, bar: 1, phase: 0.5 });
});

test("computeSyncedLfoValue handles shapes correctly", () => {
  // Sine shape
  assert.equal(computeSyncedLfoValue("sine", 0, 4, 0), 0);
  assert.ok(Math.abs(computeSyncedLfoValue("sine", 1, 4, 0) - 1) < 0.001); // 1/4 cycle (phase 0.25)
  assert.ok(Math.abs(computeSyncedLfoValue("sine", 2, 4, 0)) < 0.001); // 1/2 cycle (phase 0.5)

  // Triangle shape
  assert.equal(computeSyncedLfoValue("triangle", 0, 4, 0), -1);
  assert.equal(computeSyncedLfoValue("triangle", 1, 4, 0), 0);
  assert.equal(computeSyncedLfoValue("triangle", 2, 4, 0), 1);
  assert.equal(computeSyncedLfoValue("triangle", 3, 4, 0), 0);

  // Ramp up shape
  assert.equal(computeSyncedLfoValue("ramp_up", 0, 4, 0), -1);
  assert.equal(computeSyncedLfoValue("ramp_up", 2, 4, 0), 0);
  assert.ok(Math.abs(computeSyncedLfoValue("ramp_up", 3.99, 4, 0) - 1) < 0.01);

  // Ramp down shape
  assert.equal(computeSyncedLfoValue("ramp_down", 0, 4, 0), 1);
  assert.equal(computeSyncedLfoValue("ramp_down", 2, 4, 0), 0);

  // Square shape
  assert.equal(computeSyncedLfoValue("square", 0, 4, 0), 1);
  assert.equal(computeSyncedLfoValue("square", 2, 4, 0), -1);
});

test("computeSyncedStutterValue handles swing and ratchet correctly", () => {
  // No swing, ratchet 1
  assert.equal(computeSyncedStutterValue(0, 1, 0, 0, 1), true);
  assert.equal(computeSyncedStutterValue(0.25, 1, 0, 0, 1), true);
  assert.equal(computeSyncedStutterValue(0.5, 1, 0, 0, 1), false);
  assert.equal(computeSyncedStutterValue(0.75, 1, 0, 0, 1), false);

  // With swing = 0.5 (second step delayed)
  // Step 0 (first step) range is [0, 1.5), active window is [0, 0.75)
  assert.equal(computeSyncedStutterValue(0, 1, 0, 0.5, 1), true);
  assert.equal(computeSyncedStutterValue(0.7, 1, 0, 0.5, 1), true);
  assert.equal(computeSyncedStutterValue(0.8, 1, 0, 0.5, 1), false);

  // Step 1 (second step) range is [1.5, 2.0), active window is [1.5, 1.75)
  assert.equal(computeSyncedStutterValue(1.5, 1, 0, 0.5, 1), true);
  assert.equal(computeSyncedStutterValue(1.7, 1, 0, 0.5, 1), true);
  assert.equal(computeSyncedStutterValue(1.8, 1, 0, 0.5, 1), false);

  // Ratchet = 2 (splits step into 2 micro-steps, each 50% active)
  // Step is 1 beat. With ratchet 2, active windows are [0, 0.25) and [0.5, 0.75)
  assert.equal(computeSyncedStutterValue(0.1, 1, 0, 0, 2), true);
  assert.equal(computeSyncedStutterValue(0.3, 1, 0, 0, 2), false);
  assert.equal(computeSyncedStutterValue(0.6, 1, 0, 0, 2), true);
  assert.equal(computeSyncedStutterValue(0.8, 1, 0, 0, 2), false);
});
