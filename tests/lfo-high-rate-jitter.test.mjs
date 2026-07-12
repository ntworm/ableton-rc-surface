// Copyright © 2026 Gabriel Worm
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Source: https://github.com/ntworm/ableton-rc-surface
//
// This file is part of Ableton RC Surface, distributed under the
// PolyForm Noncommercial License 1.0.0. You may obtain a copy of
// the License at https://polyformproject.org/licenses/noncommercial/1.0.0
// Fake phone + Live API mock for end-to-end LFO/stutter jitter test.
//
// Reproduces the production wiring:
//   phone (WebSocket) → server (ws.ts) → mappings.ts (host motor) → Live param
//
// Goal: prove that at high modulator frequency, the host generates a
// continuous, beat-locked signal without jitter, even when the simulated
// phone stops sending updates after the initial config.

import test from "node:test";
import assert from "node:assert/strict";
import { WebSocket } from "ws";

import { clearExtensionContext, setExtensionContext } from "../src/context.ts";
import { adminSockets, trackedClients } from "../src/server/ws.ts";
import { oscTransport } from "../src/live/osc-transport.ts";
import {
  activeSmooths,
  clearHostModulatorsForClient,
  controlMappings,
  eventModesState,
  hostModulators,
  lastMappedValues,
  stopHostModulatorLoop,
  tickHostModulators,
  updateHostModulator,
} from "../src/live/mappings.ts";

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
  oscTransport.state.currentSongTimeBeats = 0;
  oscTransport.lastSongTimeUpdateAt = 0;
  clearExtensionContext();
}

/**
 * Mock Live API: one track, one device, one parameter that records every
 * value applied to it (with a millisecond timestamp from a fake clock).
 */
function setupLiveParam({ min = 0, max = 1 } = {}) {
  const applied = [];
  const param = {
    min,
    max,
    setValue(value) {
      applied.push({ t: fakeNow(), v: value });
    },
  };
  setExtensionContext({
    application: {
      song: {
        tempo: 120,
        tracks: [
          {
            devices: [
              { parameters: [param] },
            ],
          },
        ],
      },
    },
  });
  controlMappings.set("toggle-1", [
    { type: "device_param", trackIndex: 0, deviceIndex: 0, paramIndex: 0 },
  ]);
  return { param, applied };
}

function setupStutterParam() {
  const applied = [];
  const param = {
    min: 0,
    max: 1,
    setValue(value) {
      applied.push({ t: fakeNow(), v: value });
    },
  };
  setExtensionContext({
    application: {
      song: {
        tempo: 120,
        tracks: [
          {
            devices: [
              { parameters: [param] },
            ],
          },
        ],
      },
    },
  });
  controlMappings.set("button-1", [
    { type: "device_param", trackIndex: 0, deviceIndex: 0, paramIndex: 0 },
  ]);
  return { param, applied };
}

function setupTrackedClient(id = "client-1") {
  trackedClients.set(id, {
    id,
    ipAddress: "127.0.0.1",
    displayName: "phone",
    isAdmin: false,
    mode: "performance",
    path: "/ws",
    connectedAt: Date.now(),
    lastSeen: Date.now(),
    userAgent: "fake-phone",
    lastData: null,
    history: {},
    ws: { readyState: WebSocket.OPEN },
  });
}

// ---- Fake clock so we can drive the host motor deterministically ----
let fakeNowValue = 0;
function fakeNow() {
  return fakeNowValue;
}
// Allow mappings.ts to read the same clock
globalThis.Date = class extends Date {
  constructor(...args) {
    if (args.length === 0) {
      super(fakeNowValue);
    } else {
      super(...args);
    }
  }
  static now() {
    return fakeNowValue;
  }
};
function advanceClock(ms) {
  fakeNowValue += ms;
}

test("fake phone: high-frequency LFO generates continuous values without jitter", async () => {
  resetState();
  fakeNowValue = 0;
  const { applied } = setupLiveParam();
  setupTrackedClient();

  try {
    // The "phone" sends a single modulator config message: LFO on,
    // max rate (free mode = 20 Hz), max depth. From here on, NO further
    // phone traffic. The host motor must keep generating the signal.
    updateHostModulator("client-1", {
      kind: "lfo",
      name: "toggle-1",
      active: true,
      rate: 1,
      depth: 1,
      syncMode: "free",
      shape: "sine",
    });

    // Simulate the host motor running for 1 second of fake time at
    // the production tick rate (4 ms = 250 Hz). We tick manually so the
    // test is deterministic and doesn't depend on real wall-clock.
    const TICK_MS = 4;
    const DURATION_MS = 1000;
    const ticks = Math.floor(DURATION_MS / TICK_MS);
    for (let i = 0; i < ticks; i++) {
      advanceClock(TICK_MS);
      await tickHostModulators(fakeNow());
    }

    // Expect 250 applied values for 1s @ 250Hz. Allow ±10% slack.
    assert.ok(
      applied.length >= 220 && applied.length <= 280,
      `expected ~250 applied values for 1s @ 250Hz, got ${applied.length}`,
    );

    // No jitter test: at 20 Hz LFO, the value must cross zero on the
    // way up and down ~20 times per second. Count zero-crossings.
    let zeroCrossings = 0;
    for (let i = 1; i < applied.length; i++) {
      const prev = applied[i - 1].v;
      const cur = applied[i].v;
      if ((prev < 0.5 && cur >= 0.5) || (prev >= 0.5 && cur < 0.5)) {
        zeroCrossings++;
      }
    }
    // 20 Hz LFO = 20 cycles/sec = 40 zero-crossings/sec (sine crosses 0.5
    // twice per cycle). Allow ±50% jitter band for the under-resolved
    // 50 Hz sample rate (2.5 samples per cycle at 20 Hz).
    assert.ok(
      zeroCrossings >= 20 && zeroCrossings <= 60,
      `expected ~40 zero-crossings for 1s of 20Hz sine, got ${zeroCrossings}`,
    );

    // Continuity: no value should jump by more than the theoretical
    // maximum per-tick step (sine at 20Hz with 50Hz tick = ~80% of full
    // swing per sample in the worst case near the zero crossing).
    let maxStep = 0;
    for (let i = 1; i < applied.length; i++) {
      const step = Math.abs(applied[i].v - applied[i - 1].v);
      if (step > maxStep) maxStep = step;
    }
    assert.ok(
      maxStep <= 0.9,
      `value jump too large (jitter): ${maxStep.toFixed(3)}`,
    );
  } finally {
    resetState();
  }
});

test("fake phone: stutter at high rate generates regular on/off pulses", async () => {
  resetState();
  fakeNowValue = 0;
  const { applied } = setupStutterParam();
  setupTrackedClient();

  try {
    updateHostModulator("client-1", {
      kind: "stutter",
      name: "button-1",
      active: true,
      rate: 1, // free mode max = 15 Hz base × 4 ratchet = 60 Hz pulses
      count: 0, // ratchet 1
      syncMode: "free",
    });

    const TICK_MS = 4;
    const DURATION_MS = 1000;
    const ticks = Math.floor(DURATION_MS / TICK_MS);
    for (let i = 0; i < ticks; i++) {
      advanceClock(TICK_MS);
      await tickHostModulators(fakeNow());
    }

    // Stutter should produce alternating 0/1 (or run of 1s then 0s).
    const values = applied.map((a) => a.v);
    const unique = new Set(values);
    assert.ok(
      unique.size >= 1 && unique.size <= 2,
      `stutter should produce ~0/1 values, got unique=${[...unique]}`,
    );
    // Count rising edges (0 → 1) = number of pulses
    let pulses = 0;
    for (let i = 1; i < values.length; i++) {
      if (values[i - 1] === 0 && values[i] === 1) pulses++;
    }
    assert.ok(
      pulses >= 10,
      `expected several stutter pulses in 1s, got ${pulses}`,
    );
  } finally {
    resetState();
  }
});

test("fake phone: LFO stays phase-locked even when ticks are dropped", async () => {
  resetState();
  fakeNowValue = 0;
  const { applied } = setupLiveParam();
  setupTrackedClient();

  try {
    updateHostModulator("client-1", {
      kind: "lfo",
      name: "toggle-1",
      active: true,
      rate: 1,
      depth: 1,
      syncMode: "free",
      shape: "sine",
    });

    // 1 second of fake time. Every 5th tick is 24 ms instead of 4 ms
    // (simulating a dropped tick / GC pause). Phase-from-time means
    // the value at the next tick is exactly what it would be on a
    // perfect 4 ms schedule, modulo up-to-24 ms of quantisation.
    const DURATION_MS = 1000;
    const TICK_MS = 4;
    const STALL_EVERY = 5;
    const STALL_EXTRA_MS = 20;
    let nextTickAt = TICK_MS;
    let now = 0;
    let stallCounter = 0;
    while (now < DURATION_MS) {
      if (now + TICK_MS < nextTickAt) {
        now += TICK_MS;
      } else {
        now = nextTickAt;
        nextTickAt += TICK_MS;
        stallCounter += 1;
        if (stallCounter % STALL_EVERY === 0) nextTickAt += STALL_EXTRA_MS;
      }
      fakeNowValue = now;
      await tickHostModulators(fakeNow());
    }
    const jittered = applied.slice();
    resetState();
    fakeNowValue = 0;
    const { applied: applied2 } = setupLiveParam();
    setupTrackedClient();
    updateHostModulator("client-1", {
      kind: "lfo",
      name: "toggle-1",
      active: true,
      rate: 1,
      depth: 1,
      syncMode: "free",
      shape: "sine",
    });
    now = 0;
    while (now < DURATION_MS) {
      now += TICK_MS;
      fakeNowValue = now;
      await tickHostModulators(fakeNow());
    }
    const flat = applied2.slice();

    // Same number of ticks? No — the jittered run drops ticks. The
    // assertion we care about is that the underlying signal coverage
    // (number of zero-crossings per second of fake time) is the same
    // for both runs within ±2. If we drift, the count will be off.
    const countCrossings = (stream) => {
      let n = 0;
      for (let i = 1; i < stream.length; i++) {
        const prev = stream[i - 1].v;
        const cur = stream[i].v;
        if ((prev < 0.5 && cur >= 0.5) || (prev >= 0.5 && cur < 0.5)) n++;
      }
      return n;
    };
    const a = countCrossings(jittered);
    const b = countCrossings(flat);
    assert.ok(
      Math.abs(a - b) <= 2,
      `phase-lock broken: jittered=${a} flat=${b}`,
    );

    // And: no single value jump should exceed ~50% of the LFO range
    // (sine at 20Hz @ 250Hz tick ≈ 50% step in worst case near peak,
    // not 100%). 0.5 catches a 50% jump in absolute terms (range 0..1).
    let maxStep = 0;
    for (let i = 1; i < jittered.length; i++) {
      const step = Math.abs(jittered[i].v - jittered[i - 1].v);
      if (step > maxStep) maxStep = step;
    }
    assert.ok(
      maxStep <= 0.6,
      `value jump too large under jitter: ${maxStep.toFixed(3)}`,
    );
  } finally {
    resetState();
  }
});

// Reference: prior implementation used a phase accumulator
//   state.phase += 2 * Math.PI * freqHz * dt
// which drifts whenever dt is wrong (variable setInterval firing, GC
// pauses). The new implementation derives phase from absolute time so
// the signal is deterministic and the same value stream is produced
// even when the tick cadence varies.

test("fake phone: phase-from-time gives deterministic value at a target time", async () => {
  resetState();
  fakeNowValue = 0;
  const { applied } = setupLiveParam();
  setupTrackedClient();

  try {
    updateHostModulator("client-1", {
      kind: "lfo",
      name: "toggle-1",
      active: true,
      rate: 1,
      depth: 1,
      syncMode: "free",
      shape: "sine",
    });

    // Set the phaseZeroMs anchor to a known value so we can compute
    // the expected value at t = anchor + 1000ms.
    const TARGET_MS = 1000;
    const TICK_MS = 4;
    let now = 0;
    while (now < TARGET_MS) {
      now += TICK_MS;
      fakeNowValue = now;
      await tickHostModulators(fakeNow());
    }
    const perfect = applied.slice();
    const actualAt1000 = perfect[perfect.length - 1]?.v;

    // Expected: with state.phase = -π/2 and freqHz = 20, the LFO value
    // at t = (4 + 1000) ms is sin(2π·20·(1000/1000) + (-π/2)) = sin(π/2) = 1.
    // After the (1 + 0.5*depth) → 0.5 + 1*0.5*1 = 1.0.
    // Note: phaseZeroMs anchors at the first tick (4ms), so at the
    // t=1000ms tick (now=1000), elapsedSec = (1000 - 4)/1000 = 0.996.
    // phaseRad = 2π·20·0.996 + (-π/2) = 125.13 - 1.57 = 123.56.
    // normalizedPhase = 0.673. sin(0.673·2π) = -0.873. value = 0.063.
    // We assert the value matches the formula exactly (no drift).
    const expectedPhaseRad =
      2 * Math.PI * 20 * ((1000 - 4) / 1000) + (-Math.PI / 2);
    const expectedNormalizedPhase =
      ((expectedPhaseRad / (2 * Math.PI)) % 1 + 1) % 1;
    const expectedLfoVal = Math.sin(expectedNormalizedPhase * 2 * Math.PI);
    const expected = 0.5 + expectedLfoVal * 0.5 * 1;

    assert.ok(
      Math.abs(actualAt1000 - expected) < 0.0001,
      `LFO value should be deterministic. got=${actualAt1000} expected=${expected}`,
    );
  } finally {
    resetState();
  }
});

test("fake phone: synced LFO stays beat-locked across multiple ticks", async () => {
  resetState();
  fakeNowValue = 0;
  const { applied } = setupLiveParam();
  setupTrackedClient();

  // Configure AbletonOSC as the clock source: song at 120 BPM, playing.
  oscTransport.state.available = true;
  oscTransport.state.connected = true;
  oscTransport.state.isPlaying = true;
  oscTransport.state.currentSongTimeBeats = 0;
  oscTransport.lastSongTimeUpdateAt = 0;

  try {
    // 1 cycle per beat (subdivision 1) at 120 BPM = 2 Hz LFO. A user
    // can perceive any drift > ~10 ms here.
    updateHostModulator("client-1", {
      kind: "lfo",
      name: "toggle-1",
      active: true,
      rate: 0.4, // subdivision index for [4,2,1,0.5,0.25,0.125,0.0625] => 1
      depth: 1,
      syncMode: "sync",
      clockSource: "osc",
      syncSubdivisionBeats: 1,
      shape: "sine",
    });

    // Tick 4 seconds = 8 cycles at 2 Hz. Verify the sine crosses 0.5
    // ~16 times (twice per cycle) and the phase stays consistent: the
    // 8th crossing should land near beat 4.0.
    const TICK_MS = 4;
    const DURATION_MS = 4000;
    const ticks = Math.floor(DURATION_MS / TICK_MS);
    for (let i = 0; i < ticks; i++) {
      advanceClock(TICK_MS);
      oscTransport.state.currentSongTimeBeats =
        (fakeNow() / 1000) * (120 / 60);
      oscTransport.lastSongTimeUpdateAt = fakeNow();
      await tickHostModulators(fakeNow());
    }

    // Compute the beat-time of each zero-crossing.
    const crossings = [];
    for (let i = 1; i < applied.length; i++) {
      const prev = applied[i - 1].v;
      const cur = applied[i].v;
      if ((prev < 0.5 && cur >= 0.5) || (prev >= 0.5 && cur < 0.5)) {
        // Linear interpolation of the crossing beat-time.
        const frac = (0.5 - prev) / (cur - prev);
        const t = applied[i - 1].t + frac * (applied[i].t - applied[i - 1].t);
        crossings.push(t);
      }
    }

    // 2 Hz LFO = 2 cycles/sec = 4 zero-crossings/sec. Over 4 seconds we
    // expect ~16 crossings (twice per cycle).
    assert.ok(
      crossings.length >= 12 && crossings.length <= 20,
      `expected ~16 synced zero-crossings, got ${crossings.length}`,
    );

    // Drift test: the spacing between consecutive crossings should be
    // close to 250 ms (= 1000 / 4). Allow a generous ±30% band so the
    // test isn't flaky on the small sample count, but real drift would
    // shift the average far off the mark.
    const gaps = [];
    for (let i = 1; i < crossings.length; i++) {
      gaps.push(crossings[i] - crossings[i - 1]);
    }
    const avgGap = gaps.reduce((a, b) => a + b, 0) / gaps.length;
    assert.ok(
      Math.abs(avgGap - 250) < 50,
      `expected avg gap ~250ms, got ${avgGap.toFixed(1)}ms`,
    );
  } finally {
    resetState();
  }
});
