// Copyright © 2026 Gabriel Worm
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
//
// Field report: with Takeover = pickup the Live parameter freezes and never
// moves again, while the phone keeps showing the control moving. Takeover =
// jump works. Pickup is supposed to latch only until the incoming value
// crosses the parameter's current position, then follow it.

import test from "node:test";
import assert from "node:assert/strict";
import {
  activeSmooths,
  applyMapping,
  controlMappings,
  eventModesState,
  lastMappedValues,
  safeInputRegistry,
  stopSmoothTimer,
} from "../src/live/mappings.ts";
import { clearExtensionContext, setExtensionContext } from "../src/context.ts";

function setup(target, startValue) {
  // getValue() is required: readTargetNormalizedValue() returns null without
  // it, and then takeover initialises believing the host sits wherever the
  // input already is — which silently disables pickup entirely.
  const param = {
    name: "Dry/Wet", min: 0, max: 1, value: startValue,
    getValue: async () => param.value,
    setValue: async (v) => { param.value = v; },
  };
  controlMappings.clear();
  lastMappedValues.clear();
  activeSmooths.clear();
  eventModesState.clear();
  safeInputRegistry.clear();
  setExtensionContext({
    application: { song: { tempo: 120, tracks: [{ devices: [{ parameters: [param] }] }] } },
  });
  controlMappings.set("sensor.vision.x", [target]); controlMappings.set("sensor.vision.z", [target]);
  return param;
}

/** Sweep the control across its whole range, as a hand crossing the frame. */
async function sweep(from, to, steps = 40, control = "sensor.vision.x") {
  for (let i = 0; i <= steps; i++) {
    await applyMapping("client-1", control, from + ((to - from) * i) / steps);
  }
}

test("pickup: the parameter follows once the input sweeps across its position", async (t) => {
  const param = setup(
    { type: "device_param", trackIndex: 0, deviceIndex: 0, paramIndex: 0, takeoverMode: "pickup" },
    0.5,
  );
  t.after(() => { stopSmoothTimer(); clearExtensionContext(); });

  // Start well below the parameter, then sweep up through and past it.
  await applyMapping("client-1", "sensor.vision.x", 0.05);
  await sweep(0.05, 0.95);

  assert.ok(
    Math.abs(param.value - 0.95) < 0.05,
    `BUG CONFIRMED: pickup never caught the parameter — it is stuck at ${param.value} ` +
      `after the input swept from 0.05 to 0.95 straight through it.`,
  );
});

test("pickup: keeps following on a second sweep back down", async (t) => {
  const param = setup(
    { type: "device_param", trackIndex: 0, deviceIndex: 0, paramIndex: 0, takeoverMode: "pickup" },
    0.5,
  );
  t.after(() => { stopSmoothTimer(); clearExtensionContext(); });

  await applyMapping("client-1", "sensor.vision.x", 0.05);
  await sweep(0.05, 0.95);
  await sweep(0.95, 0.2);

  assert.ok(
    Math.abs(param.value - 0.2) < 0.05,
    `pickup stopped following after capture, stuck at ${param.value}`,
  );
});

test("pickup: holds still until the input actually reaches the parameter", async (t) => {
  const param = setup(
    { type: "device_param", trackIndex: 0, deviceIndex: 0, paramIndex: 0, takeoverMode: "pickup" },
    0.8,
  );
  t.after(() => { stopSmoothTimer(); clearExtensionContext(); });

  // Move only in the lower half — never reaching 0.8 — so it must not jump.
  await applyMapping("client-1", "sensor.vision.x", 0.1);
  await sweep(0.1, 0.4);

  assert.ok(
    Math.abs(param.value - 0.8) < 0.01,
    `pickup must not move before the input reaches it, moved to ${param.value}`,
  );
});

test("jump: follows immediately, no catching required", async (t) => {
  const param = setup(
    { type: "device_param", trackIndex: 0, deviceIndex: 0, paramIndex: 0, takeoverMode: "jump" },
    0.5,
  );
  t.after(() => { stopSmoothTimer(); clearExtensionContext(); });

  await applyMapping("client-1", "sensor.vision.x", 0.9);
  assert.ok(Math.abs(param.value - 0.9) < 0.02, `jump should follow at once, got ${param.value}`);
});

test("pickup: a parameter parked where the sensor never reaches freezes forever", async (t) => {
  // The field case: vision Z mapped to Song Tempo sitting at ~0.89 of its
  // range. A hand's Z barely leaves the middle of the frame, so the input
  // never crosses the parameter and pickup latches for good.
  const param = setup(
    { type: "device_param", trackIndex: 0, deviceIndex: 0, paramIndex: 0, takeoverMode: "pickup" },
    0.89,
  );
  t.after(() => { stopSmoothTimer(); clearExtensionContext(); });

  await applyMapping("client-1", "sensor.vision.z", 0.3);
  for (let round = 0; round < 5; round++) {
    await sweep(0.25, 0.6, 20, "sensor.vision.z");
    await sweep(0.6, 0.25, 20, "sensor.vision.z");
  }

  assert.equal(
    param.value,
    0.89,
    `expected the documented pickup latch; parameter is at ${param.value}`,
  );
});
