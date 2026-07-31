// Copyright © 2026 Gabriel Worm
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
import test from "node:test";
import assert from "node:assert/strict";

import {
  applyMapping,
  controlMappings,
  handleClientDisconnect,
  reconcileMappedHostValues,
  safeInputRegistry,
  lastMappedInputAt,
} from "../src/live/mappings.ts";
import { clearExtensionContext, setExtensionContext } from "../src/context.ts";

function installParameter(hostValue = 0.8) {
  const applied = [];
  const param = {
    min: 0,
    max: 1,
    name: "Cutoff",
    isQuantized: false,
    valueItems: [],
    getValue: async () => hostValue,
    setValue: async (value) => applied.push(value),
  };
  setExtensionContext({
    application: {
      song: {
        tempo: 120,
        tracks: [{ name: "Synth", devices: [{ name: "Filter", parameters: [param] }] }],
        returnTracks: [],
        mainTrack: { name: "Main", devices: [] },
      },
    },
  });
  return applied;
}

function reset() {
  controlMappings.clear();
  safeInputRegistry.clear();
  lastMappedInputAt.clear();
  clearExtensionContext();
}

test("continuous mappings default to soft takeover using the real host value", async () => {
  const applied = installParameter(0.8);
  controlMappings.set("knob-1", [{
    type: "device_param",
    trackIndex: 0,
    deviceIndex: 0,
    paramIndex: 0,
  }]);
  try {
    await applyMapping("client", "knob-1", 0.2);
    assert.deepEqual(applied, [0.8]);

    await applyMapping("client", "knob-1", 0.3);
    assert.ok(applied[1] > 0.8 && applied[1] <= 1);
  } finally {
    reset();
  }
});

test("jump mapping option preserves the advanced immediate behavior", async () => {
  const applied = installParameter(0.8);
  controlMappings.set("knob-1", [{
    type: "device_param",
    trackIndex: 0,
    deviceIndex: 0,
    paramIndex: 0,
    takeoverMode: "jump",
  }]);
  try {
    await applyMapping("client", "knob-1", 0.2);
    assert.deepEqual(applied, [0.2]);
  } finally {
    reset();
  }
});

test("editing takeover mode reinitializes against the current Live value", async () => {
  const applied = installParameter(0.8);
  const target = { type: "device_param", trackIndex: 0, deviceIndex: 0, paramIndex: 0, takeoverMode: "scale" };
  controlMappings.set("knob-1", [target]);
  try {
    await applyMapping("client", "knob-1", 0.2);
    applied.length = 0;
    target.takeoverMode = "pickup";
    await applyMapping("client", "knob-1", 0.3);
    assert.deepEqual(applied, [0.8]);

    applied.length = 0;
    target.takeoverMode = "jump";
    await applyMapping("client", "knob-1", 0.4);
    assert.deepEqual(applied, [0.4]);
  } finally {
    reset();
  }
});

test("momentary pads bypass takeover and release immediately", async () => {
  const applied = installParameter(0.8);
  controlMappings.set("pad-1", [{
    type: "device_param",
    trackIndex: 0,
    deviceIndex: 0,
    paramIndex: 0,
  }]);
  try {
    await applyMapping("client", "pad-1", 1);
    await applyMapping("client", "pad-1", 0, true);
    assert.deepEqual(applied, [1, 0]);
  } finally {
    reset();
  }
});

test("built-in and learned gesture pulses bypass takeover", async () => {
  for (const control of ["sensor.vision.pinch", "sensor.vision.gesture.swipe-up"]) {
    const applied = installParameter(0.8);
    controlMappings.set(control, [{
      type: "device_param", trackIndex: 0, deviceIndex: 0, paramIndex: 0,
    }]);
    try {
      await applyMapping("client", control, 1);
      await applyMapping("client", control, 0, true);
      assert.deepEqual(applied, [1, 0], control);
    } finally {
      reset();
    }
  }
});

test("disconnect releases momentary controls without clearing toggle mappings", async () => {
  const applied = installParameter(0);
  controlMappings.set("button-1", [{
    type: "device_param", trackIndex: 0, deviceIndex: 0, paramIndex: 0,
  }]);
  try {
    await applyMapping("client", "button-1", 1);
    applied.length = 0;
    await handleClientDisconnect("client");
    assert.deepEqual(applied, [0]);
    assert.equal(controlMappings.has("button-1"), true);
  } finally {
    reset();
  }
});

test("disconnect releases a learned gesture pulse immediately", async () => {
  const applied = installParameter(0);
  const control = "sensor.vision.gesture.swipe-up";
  controlMappings.set(control, [{
    type: "device_param", trackIndex: 0, deviceIndex: 0, paramIndex: 0,
  }]);
  try {
    await applyMapping("client", control, 1);
    applied.length = 0;
    await handleClientDisconnect("client");
    assert.deepEqual(applied, [0]);
  } finally {
    reset();
  }
});

test("host changes while idle re-arm takeover before the next phone movement", async () => {
  let hostValue = 0.5;
  const applied = [];
  const param = {
    min: 0, max: 1, name: "Cutoff", isQuantized: false, valueItems: [],
    getValue: async () => hostValue,
    setValue: async (value) => { applied.push(value); hostValue = value; },
  };
  setExtensionContext({ application: { song: { tempo: 120, tracks: [{ devices: [{ parameters: [param] }] }], returnTracks: [], mainTrack: { devices: [] } } } });
  controlMappings.set("knob-1", [{ type: "device_param", trackIndex: 0, deviceIndex: 0, paramIndex: 0 }]);
  try {
    await applyMapping("client", "knob-1", 0.5);
    hostValue = 0.9;
    lastMappedInputAt.set("client::knob-1", 0);
    await reconcileMappedHostValues("client");
    applied.length = 0;
    await applyMapping("client", "knob-1", 0.6);
    assert.ok(applied[0] >= 0.9 && applied[0] < 1);
  } finally {
    reset();
  }
});

test("host reconciliation does not re-arm takeover while the phone control is moving", async () => {
  let hostValue = 0.5;
  const applied = [];
  const param = {
    min: 0, max: 1, name: "Cutoff", isQuantized: false, valueItems: [],
    getValue: async () => hostValue,
    setValue: async (value) => { applied.push(value); },
  };
  setExtensionContext({ application: { song: { tempo: 120, tracks: [{ devices: [{ parameters: [param] }] }], returnTracks: [], mainTrack: { devices: [] } } } });
  controlMappings.set("knob-1", [{ type: "device_param", trackIndex: 0, deviceIndex: 0, paramIndex: 0 }]);
  try {
    await applyMapping("client", "knob-1", 0.5);
    hostValue = 0.9; // stale/asynchronous host read during the same gesture
    await reconcileMappedHostValues("client");
    applied.length = 0;
    await applyMapping("client", "knob-1", 0.6);
    assert.ok(applied[0] < 0.8, `expected continuous movement, got ${applied[0]}`);
  } finally {
    reset();
  }
});

test("takeover converts nonlinear host values back into phone-control space", async () => {
  const applied = installParameter(0.25);
  controlMappings.set("knob-1", [{
    type: "device_param", trackIndex: 0, deviceIndex: 0, paramIndex: 0,
    curve: "exponential",
  }]);
  try {
    await applyMapping("client", "knob-1", 0.1);
    assert.equal(applied[0], 0.25);
    const diagnostic = safeInputRegistry.diagnostics()["client::knob-1::device_param::0::0::0"];
    assert.ok(Math.abs(diagnostic.hostValue - 0.5) < 0.001);
  } finally {
    reset();
  }
});

test("unconfirmed or missing relink targets never dispatch to Live", async () => {
  const applied = installParameter(0.5);
  controlMappings.set("knob-1", [{
    type: "device_param", trackIndex: 0, deviceIndex: 0, paramIndex: 0,
    relinkStatus: "review",
  }]);
  try {
    await applyMapping("client", "knob-1", 1);
    assert.deepEqual(applied, []);
    assert.equal(controlMappings.has("knob-1"), true);
  } finally {
    reset();
  }
});
