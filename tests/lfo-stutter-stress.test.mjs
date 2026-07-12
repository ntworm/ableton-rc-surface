// Copyright © 2026 Gabriel Worm
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Source: https://github.com/ntworm/ableton-rc-surface
//
// This file is part of Ableton RC Surface, distributed under the
// PolyForm Noncommercial License 1.0.0. You may obtain a copy of
// the License at https://polyformproject.org/licenses/noncommercial/1.0.0
// tests/lfo-stutter-stress.test.mjs
//
// Stress tests for the LFO/stutter host-side motor. Builds on the
// foundation in tests/lfo-high-rate-jitter.test.mjs by pushing the motor
// to sustained high-frequency operation, concurrent modulators, and
// live configuration changes. The goal is to catch regressions that
// would only surface in a long-running performance session (not in
// short unit tests).

import assert from "node:assert/strict";
import test from "node:test";
import { setExtensionContext, clearExtensionContext } from "../src/context.ts";
import {
  updateHostModulator,
  tickHostModulators,
  stopHostModulatorLoop,
  controlMappings,
} from "../src/live/mappings.ts";

const tick = (ms) => new Promise((res) => setTimeout(res, ms));

// fakeClock mutates Date.now() so the phase-from-time motor sees a
// deterministic timeline. We use a per-test clock so each test starts
// at t=0.
function installFakeClock(initial = 0) {
  const realNow = Date.now.bind(Date);
  let now = initial;
  Date.now = () => now;
  return {
    advance: (ms) => { now += ms; },
    set: (v) => { now = v; },
    restore: () => { Date.now = realNow; },
    get: () => now,
  };
}

function makeParam(name) {
  const applied = [];
  const param = {
    name,
    min: 0,
    max: 1,
    setValue(value) {
      applied.push({ t: Date.now(), value });
    },
  };
  return { param, applied };
}

function setupMappedParam(controlName) {
  const { param, applied } = makeParam(controlName);
  setExtensionContext({
    application: {
      song: {
        tempo: 120,
        tracks: [
          {
            devices: [
              {
                parameters: [param],
              },
            ],
          },
        ],
      },
    },
  });
  // Register the control so the host-modulator apply path finds a
  // target to write to. The motor looks up `controlMappings.get(name)`.
  controlMappings.set(controlName, [
    { type: "device_param", trackIndex: 0, deviceIndex: 0, paramIndex: 0 },
  ]);
  return { applied, param };
}

function teardown() {
  stopHostModulatorLoop();
  controlMappings.clear();
  clearExtensionContext();
}

// `clientId` is the first arg; the second is the full payload
function upd(controlId, payload) {
  return updateHostModulator("client-stress", { name: controlId, ...payload });
}

test("60s @ 5Hz LFO: no glitches, no NaN, no out-of-range values", async () => {
  const clock = installFakeClock(0);
  try {
    const { applied } = setupMappedParam("toggle-1");
    upd("toggle-1", {
      kind: "lfo",
      active: true,
      rate: 0.25, // 5Hz (rate ∈ [0,1] maps to 0.1-20Hz)
      depth: 1.0,
      shape: "sine",
      syncMode: "free",
    });

    // Simulate 60s of 4ms tick cadence
    const totalMs = 60_000;
    const step = 4;
    for (let t = 0; t < totalMs; t += step) {
      clock.advance(step);
      await tickHostModulators(clock.get());
    }

    assert.ok(applied.length > 10_000, `should have many samples, got ${applied.length}`);

    // validate every value is a finite number in [0, 1]
    for (const a of applied) {
      assert.ok(Number.isFinite(a.value), `value at t=${a.t} is not finite: ${a.value}`);
      assert.ok(a.value >= -0.0001 && a.value <= 1.0001, `value out of [0,1]: ${a.value}`);
    }

    // validate that values are NOT constant (motor is actually working)
    const distinct = new Set(applied.map((a) => a.value.toFixed(4)));
    assert.ok(distinct.size > 100, `LFO produced too few distinct values (${distinct.size}) — likely stuck`);

    teardown();
  } finally {
    clock.restore();
  }
});

test("endurance: motor survives 60s of mixed shape/rate changes", async () => {
  const clock = installFakeClock(0);
  try {
    const { applied } = setupMappedParam("toggle-2");
    upd("toggle-2", {
      kind: "lfo",
      active: true,
      rate: 0.3,
      depth: 0.7,
      shape: "sine",
      syncMode: "free",
    });

    const shapes = ["sine", "triangle", "square", "saw"];
    const step = 4;
    for (let t = 0; t < 60_000; t += step) {
      // change shape every 5s
      if (t % 5000 === 0 && t > 0) {
        upd("toggle-2", {
          kind: "lfo",
          active: true,
          rate: 0.1 + (t / 60_000) * 0.8,
          depth: 0.3 + (t / 60_000) * 0.5,
          shape: shapes[(t / 5000) % shapes.length],
          syncMode: "free",
        });
      }
      clock.advance(step);
      await tickHostModulators(clock.get());
      if (t % 1000 === 0) await tick(0); // yield
    }

    assert.ok(applied.length > 5_000, `motor produced too few samples: ${applied.length}`);

    // every value must be finite and in range
    let bad = 0;
    for (const a of applied) {
      if (!Number.isFinite(a.value) || a.value < 0 || a.value > 1) bad += 1;
    }
    assert.equal(bad, 0, `${bad} samples were bad (NaN or out of range)`);

    teardown();
  } finally {
    clock.restore();
  }
});

test("disabling a modulator mid-run stops it from applying values", async () => {
  const clock = installFakeClock(0);
  try {
    const { applied } = setupMappedParam("toggle-3");
    upd("toggle-3", {
      kind: "lfo",
      active: true,
      rate: 0.5,
      depth: 1.0,
      shape: "sine",
      syncMode: "free",
    });

    for (let t = 0; t < 1000; t += 4) {
      clock.advance(4);
      await tickHostModulators(clock.get());
    }
    const samplesBeforeStop = applied.length;
    assert.ok(samplesBeforeStop > 50, "LFO should have produced samples before disable");

    // disable
    upd("toggle-3", {
      kind: "lfo",
      active: false,
      rate: 0.5,
      depth: 1.0,
      shape: "sine",
      syncMode: "free",
    });

    for (let t = 0; t < 1000; t += 4) {
      clock.advance(4);
      await tickHostModulators(clock.get());
    }
    const samplesAfterStop = applied.length;

    // when disabled, motor should stop applying OR apply a constant.
    // Either way the distinct values after stop should be ≤ the
    // distinct values before (probably = 1).
    const distinctAfter = new Set(applied.slice(samplesBeforeStop).map((a) => a.value.toFixed(6)));
    assert.ok(distinctAfter.size <= 1, `motor kept producing ${distinctAfter.size} distinct values after disable`);

    teardown();
  } finally {
    clock.restore();
  }
});

test("CPU budget: 4 modulators at 4ms tick stays under 4ms per tick (avg)", async () => {
  const clock = installFakeClock(0);
  try {
    // 4 separate params + 4 mappings to keep them isolated
    setupMappedParam("toggle-4");
    setupMappedParam("button-1");
    setupMappedParam("button-2");
    setupMappedParam("button-3");

    upd("toggle-4", { kind: "lfo", active: true, rate: 0.5, depth: 0.8, shape: "sine", syncMode: "free" });
    upd("button-1", { kind: "stutter", active: true, rate: 0.6, depth: 0.8, shape: "square", syncMode: "free" });
    upd("button-2", { kind: "stutter", active: true, rate: 0.7, depth: 0.8, shape: "triangle", syncMode: "free" });
    upd("button-3", { kind: "lfo", active: true, rate: 0.9, depth: 0.8, shape: "sine", syncMode: "free" });

    // Warm up
    for (let t = 0; t < 200; t += 4) {
      clock.advance(4);
      await tickHostModulators(clock.get());
    }

    // Measure over 1 second
    const measured = [];
    for (let t = 0; t < 1000; t += 4) {
      clock.advance(4);
      const start = performance.now();
      await tickHostModulators(clock.get());
      const elapsed = performance.now() - start;
      measured.push(elapsed);
    }

    const avg = measured.reduce((a, b) => a + b, 0) / measured.length;
    const max = Math.max(...measured);
    assert.ok(avg < 4, `average tick took ${avg.toFixed(3)}ms (budget 4ms)`);
    // burst budget is calibrated for the GitHub Actions ubuntu runner. Windows
    // runners share a smaller pool and exhibit ~30% more jitter under the same
    // workload, so this assertion uses a wider headroom than the average-budget
    // check above. The intent is to catch regressions where the motor suddenly
    // becomes pathologically slow, not to assert a tight timing envelope on
    // any one runner. A real regression will push max well above 16ms.
    assert.ok(max < 16, `max tick took ${max.toFixed(3)}ms (burst budget 16ms)`);

    teardown();
  } finally {
    clock.restore();
  }
});
