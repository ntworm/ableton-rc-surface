// Copyright © 2026 Gabriel Worm
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Source: https://github.com/ntworm/ableton-rc-surface
//
// The host motor ticks at 250 Hz because a 20 Hz LFO needs that resolution to
// stay smooth — that is correct and must not regress. What was wrong is that
// every tick wrote to Live regardless of what the value was doing: a stutter
// gate holding 1 across its whole open phase was written 250 times a second to
// say "still 1", and a slow LFO moving ~0.0001 per tick was written just as
// often.
//
// Writes below the perceptual floor are now skipped. That is lossless by
// construction, and these tests pin both halves of it: the fast LFO still
// writes on every tick, the redundant cases collapse.
import test from "node:test";
import assert from "node:assert/strict";

import { clearExtensionContext, setExtensionContext } from "../src/context.ts";
import { adminSockets, trackedClients } from "../src/server/ws.ts";
import { oscTransport } from "../src/live/osc-transport.ts";
import {
  activeSmooths,
  controlMappings,
  eventModesState,
  hostModulators,
  lastMappedValues,
  stopHostModulatorLoop,
  tickHostModulators,
  updateHostModulator,
} from "../src/live/mappings.ts";

const TICK_MS = 4; // production HOST_MODULATOR_INTERVAL_MS
const TICKS_PER_SECOND = 1000 / TICK_MS; // 250

function resetState() {
  stopHostModulatorLoop();
  controlMappings.clear();
  lastMappedValues.clear();
  activeSmooths.clear();
  eventModesState.clear();
  hostModulators.clear();
  trackedClients.clear();
  adminSockets.clear();
  oscTransport.state.available = false;
  oscTransport.state.connected = false;
  oscTransport.state.isPlaying = false;
  clearExtensionContext();
}

function setupParam(controlName) {
  const applied = [];
  const param = {
    min: 0,
    max: 1,
    setValue(value) {
      applied.push(value);
    },
  };
  setExtensionContext({
    application: {
      song: { tempo: 120, tracks: [{ devices: [{ parameters: [param] }] }] },
    },
  });
  controlMappings.set(controlName, [
    { type: "device_param", trackIndex: 0, deviceIndex: 0, paramIndex: 0 },
  ]);
  return applied;
}

async function runForOneSecond() {
  for (let i = 1; i <= TICKS_PER_SECOND; i++) {
    await tickHostModulators(i * TICK_MS);
  }
}

test("a 20 Hz LFO at full depth still writes on every tick", async () => {
  resetState();
  const applied = setupParam("toggle-1");
  try {
    updateHostModulator("client-1", {
      kind: "lfo",
      name: "toggle-1",
      active: true,
      rate: 1, // free mode max = 20 Hz
      depth: 1,
      syncMode: "free",
      shape: "sine",
    });

    await runForOneSecond();

    assert.ok(
      applied.length >= TICKS_PER_SECOND * 0.9,
      `the fast case must not be thinned out: got ${applied.length} of ${TICKS_PER_SECOND}`,
    );
  } finally {
    resetState();
  }
});

test("a stutter gate writes on its edges, not on every tick", async () => {
  resetState();
  const applied = setupParam("button-1");
  try {
    updateHostModulator("client-1", {
      kind: "stutter",
      name: "button-1",
      active: true,
      rate: 0, // free mode floor = 1 Hz base
      count: 0, // ratchet 1
      syncMode: "free",
    });

    await runForOneSecond();

    // 1 Hz gate over one second is a handful of transitions, not 250 writes.
    assert.ok(
      applied.length <= 12,
      `a held gate must not be rewritten every tick: got ${applied.length}`,
    );
    assert.ok(applied.length >= 1, "the gate must still reach Live");
    // Every write is an actual change of state.
    for (let i = 1; i < applied.length; i++) {
      assert.notEqual(applied[i], applied[i - 1], "consecutive writes must differ");
    }
    assert.deepEqual([...new Set(applied)].sort(), [0, 1].slice(0, new Set(applied).size));
  } finally {
    resetState();
  }
});

test("a barely-moving LFO collapses to a fraction of the tick rate", async () => {
  resetState();
  const applied = setupParam("toggle-1");
  try {
    updateHostModulator("client-1", {
      kind: "lfo",
      name: "toggle-1",
      active: true,
      rate: 0, // free mode floor = 0.1 Hz
      depth: 0.02, // and almost no swing to write about
      syncMode: "free",
      shape: "sine",
    });

    await runForOneSecond();

    assert.ok(
      applied.length < TICKS_PER_SECOND / 2,
      `a near-static value must not be written 250x/s: got ${applied.length}`,
    );
  } finally {
    resetState();
  }
});

test("the first value after activation always reaches Live", async () => {
  resetState();
  const applied = setupParam("toggle-1");
  try {
    updateHostModulator("client-1", {
      kind: "lfo",
      name: "toggle-1",
      active: true,
      rate: 0,
      depth: 0, // value pinned at 0.5 forever — nothing ever changes
      syncMode: "free",
    });

    await tickHostModulators(TICK_MS);
    assert.equal(applied.length, 1, "a motionless modulator must still set its value once");
    assert.equal(applied[0], 0.5);

    for (let i = 2; i <= 50; i++) await tickHostModulators(i * TICK_MS);
    assert.equal(applied.length, 1, "and then say nothing further");
  } finally {
    resetState();
  }
});

test("deactivation is written even though it repeats the resting value", async () => {
  resetState();
  const applied = setupParam("button-1");
  try {
    updateHostModulator("client-1", {
      kind: "stutter",
      name: "button-1",
      active: true,
      rate: 0,
      count: 0,
      syncMode: "free",
    });
    await tickHostModulators(TICK_MS);
    applied.length = 0;

    updateHostModulator("client-1", { kind: "stutter", name: "button-1", active: false });
    await new Promise((resolve) => setTimeout(resolve, 20));

    assert.ok(applied.includes(0), "turning a modulator off must always reach Live");
  } finally {
    resetState();
  }
});
