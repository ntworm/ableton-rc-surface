// Copyright © 2026 Gabriel Worm
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Source: https://github.com/ntworm/ableton-rc-surface
//
// Re-entrancy guard for the WriteScheduler.
//
// applyMappedValue() enqueues and then immediately awaits flush(). While a
// flush is in flight (awaiting a Live setValue) every other flush() call
// returns straight away because of the isFlushing latch. Anything enqueued in
// that window therefore depends on the in-flight flush to drain it — if the
// in-flight flush only walks the key snapshot it took when it started, the
// newest write is stranded until some unrelated control moves again.
//
// The stranded write is the LAST one of a gesture (fader released, hand left
// the frame), i.e. exactly the value the performer expects to hear.
import test from "node:test";
import assert from "node:assert/strict";
import { WriteScheduler } from "../src/server/write-scheduler.ts";

test("flush drains keys enqueued while it was already running", async () => {
  const scheduler = new WriteScheduler();
  const executed = [];
  const released = [];
  let releaseFirst;
  const firstInFlight = new Promise((resolve) => {
    releaseFirst = resolve;
  });

  scheduler.enqueue({
    targetKey: "targetA",
    isDiscrete: false,
    value: 0.1,
    execute: async () => {
      executed.push("A");
      await firstInFlight;
      released.push("A-done");
    },
  });

  const inFlight = scheduler.flush();
  // Yield so the flush reaches the awaited execute() before we enqueue.
  await Promise.resolve();

  scheduler.enqueue({
    targetKey: "targetB",
    isDiscrete: false,
    value: 0.9,
    execute: async () => {
      executed.push("B");
    },
  });
  // The second flush is a no-op: a flush is already in flight.
  await scheduler.flush();

  releaseFirst();
  await inFlight;

  assert.deepEqual(executed, ["A", "B"], "targetB must not be stranded in the queue");
  assert.equal(scheduler.pendingCount(), 0, "no task may survive a completed flush");
});

test("a value enqueued mid-flush for a key already drained is not lost", async () => {
  const scheduler = new WriteScheduler();
  const applied = [];
  let releaseFirst;
  const firstInFlight = new Promise((resolve) => {
    releaseFirst = resolve;
  });

  scheduler.enqueue({
    targetKey: "fader",
    isDiscrete: false,
    value: 0.4,
    execute: async () => {
      applied.push(0.4);
      await firstInFlight;
    },
  });

  const inFlight = scheduler.flush();
  await Promise.resolve();

  // The final value of the gesture, arriving while the previous write is
  // still in flight.
  scheduler.enqueue({
    targetKey: "fader",
    isDiscrete: false,
    value: 1,
    execute: async () => {
      applied.push(1);
    },
  });
  await scheduler.flush();

  releaseFirst();
  await inFlight;

  assert.deepEqual(applied, [0.4, 1], "the last value of the gesture must reach Live");
});
