// Copyright © 2026 Gabriel Worm
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Source: https://github.com/ntworm/ableton-rc-surface
//
// Tests for Task 3.3 Write Scheduler: coalescing continuous controls per targetKey
// and preserving strict FIFO ordering for discrete/toggle/note events.

import test from "node:test";
import assert from "node:assert/strict";
import { WriteScheduler } from "../src/server/write-scheduler.ts";

test("WriteScheduler coalesces continuous updates for the same targetKey", async () => {
  const scheduler = new WriteScheduler();
  const executed = [];

  // Enqueue 5 continuous updates for target 'track0:mixer:volume'
  for (let i = 1; i <= 5; i++) {
    scheduler.enqueue({
      targetKey: "track0:mixer:volume",
      isDiscrete: false,
      value: i * 0.1,
      execute: async () => {
        executed.push(i * 0.1);
      },
    });
  }

  // Before flush, queue size should be 1 (coalesced)
  assert.equal(scheduler.pendingCount("track0:mixer:volume"), 1);

  await scheduler.flush();

  // Only the latest continuous value (0.5) should have executed
  assert.equal(executed.length, 1);
  assert.equal(executed[0], 0.5);
});

test("WriteScheduler preserves strict FIFO order for discrete events", async () => {
  const scheduler = new WriteScheduler();
  const executed = [];

  // Enqueue continuous, discrete toggle, continuous, discrete note
  scheduler.enqueue({
    targetKey: "track0:device0:param1",
    isDiscrete: false,
    value: 0.1,
    execute: async () => executed.push("cont-1"),
  });
  scheduler.enqueue({
    targetKey: "track0:device0:param1",
    isDiscrete: false,
    value: 0.2,
    execute: async () => executed.push("cont-2"),
  });
  scheduler.enqueue({
    targetKey: "track0:device0:param1",
    isDiscrete: true,
    value: 1.0,
    execute: async () => executed.push("toggle-on"),
  });
  scheduler.enqueue({
    targetKey: "track0:device0:param1",
    isDiscrete: false,
    value: 0.8,
    execute: async () => executed.push("cont-3"),
  });

  await scheduler.flush();

  // Continuous before toggle-on coalesces to cont-2, then toggle-on, then cont-3
  assert.deepEqual(executed, ["cont-2", "toggle-on", "cont-3"]);
});

test("WriteScheduler isolates queues per targetKey independently", async () => {
  const scheduler = new WriteScheduler();
  const executed = [];

  scheduler.enqueue({
    targetKey: "targetA",
    isDiscrete: false,
    value: 0.3,
    execute: async () => executed.push("A:0.3"),
  });
  scheduler.enqueue({
    targetKey: "targetB",
    isDiscrete: true,
    value: 1.0,
    execute: async () => executed.push("B:1.0"),
  });
  scheduler.enqueue({
    targetKey: "targetA",
    isDiscrete: false,
    value: 0.6,
    execute: async () => executed.push("A:0.6"),
  });

  await scheduler.flush();

  assert.ok(executed.includes("A:0.6"));
  assert.ok(executed.includes("B:1.0"));
  assert.ok(!executed.includes("A:0.3"), "stale targetA value 0.3 must be coalesced");
});
