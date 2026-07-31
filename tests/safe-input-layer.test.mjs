// Copyright © 2026 Gabriel Worm
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
import test from "node:test";
import assert from "node:assert/strict";

import {
  SafeContinuousInput,
  SafeInputRegistry,
  SafeSignalFilter,
} from "../src/live/safe-input.ts";

test("value scaling starts at the host value and converges without a jump", () => {
  const input = new SafeContinuousInput({ mode: "scale", deadzone: 0.02 });

  const armed = input.process(0.2, { hostValue: 0.8, timestamp: 0 });
  assert.equal(armed.value, 0.8);
  assert.equal(armed.state, "takeover");
  assert.equal(armed.captured, false);

  const moving = input.process(0.3, { timestamp: 16 });
  assert.ok(moving.value > 0.8);
  assert.ok(moving.value <= 1);
  assert.equal(moving.state, "takeover");
});

test("pickup holds the host until the physical value crosses it", () => {
  const input = new SafeContinuousInput({ mode: "pickup", deadzone: 0.01 });
  assert.equal(input.process(0.2, { hostValue: 0.7, timestamp: 0 }).value, 0.7);
  assert.equal(input.process(0.6, { timestamp: 16 }).value, 0.7);

  const crossed = input.process(0.72, { timestamp: 32 });
  assert.equal(crossed.value, 0.72);
  assert.equal(crossed.captured, true);
  assert.equal(crossed.state, "active");
});

test("jump remains available only when explicitly selected", () => {
  const input = new SafeContinuousInput({ mode: "jump" });
  const result = input.process(0.15, { hostValue: 0.9, timestamp: 0 });
  assert.equal(result.value, 0.15);
  assert.equal(result.captured, true);
});

test("a host-side change re-arms takeover without forwarding a jump", () => {
  const input = new SafeContinuousInput({ mode: "scale", deadzone: 0.02 });
  input.process(0.5, { hostValue: 0.5, timestamp: 0 });
  assert.equal(input.process(0.6, { timestamp: 16 }).state, "active");

  const reconciled = input.reconcileHost(0.1, 32);
  assert.equal(reconciled.value, 0.1);
  assert.equal(reconciled.state, "takeover");
  assert.equal(reconciled.captured, false);
});

test("loss policy holds briefly, decays to neutral, and recovers smoothly", () => {
  const input = new SafeContinuousInput({
    mode: "jump",
    loss: { holdMs: 100, releaseMs: 200, neutralValue: 0 },
  });
  input.process(0.9, { hostValue: 0.9, timestamp: 0 });

  assert.equal(input.markLost(50).state, "lost");
  assert.equal(input.tick(100).value, 0.9);
  const decaying = input.tick(200);
  assert.equal(decaying.state, "decaying");
  assert.ok(decaying.value > 0 && decaying.value < 0.9);
  assert.equal(input.tick(350).value, 0);

  const recovered = input.process(0.8, { timestamp: 366 });
  assert.equal(recovered.state, "recovering");
  assert.ok(recovered.value < 0.8);
});

test("default loss release is long enough to avoid an audible parameter snap", () => {
  const input = new SafeContinuousInput({ mode: "jump" });
  input.process(0.8, { hostValue: 0.8, timestamp: 0 });
  input.markLost(0);
  const midway = input.tick(500);
  assert.ok(midway.value > 0.4, `expected a gradual release, got ${midway.value}`);
  assert.equal(input.tick(1400).value, 0);
});

test("registry isolates controls and exposes visual takeover diagnostics", () => {
  const registry = new SafeInputRegistry();
  registry.process("client::knob-1::target", 0.1, {
    hostValue: 0.9,
    timestamp: 0,
  });
  registry.process("client::fader-1::target", 0.4, {
    hostValue: 0.4,
    timestamp: 0,
  });

  const diagnostics = registry.diagnostics();
  assert.equal(diagnostics["client::knob-1::target"].state, "takeover");
  assert.equal(diagnostics["client::knob-1::target"].hostValue, 0.9);
  assert.equal(diagnostics["client::fader-1::target"].state, "active");
});

test("registry replaces a stale takeover strategy when mapping configuration changes", () => {
  const registry = new SafeInputRegistry();
  const key = "client::knob-1::target";
  const scale = registry.process(key, 0.2, { hostValue: 0.8, timestamp: 0 }, { mode: "scale" });
  assert.equal(scale.value, 0.8);

  const pickup = registry.process(key, 0.3, { hostValue: 0.8, timestamp: 10 }, { mode: "pickup" });
  assert.equal(pickup.value, 0.8, "pickup must hold the host until crossing it");
  assert.equal(pickup.state, "takeover");

  const jump = registry.process(key, 0.4, { hostValue: 0.8, timestamp: 20 }, { mode: "jump" });
  assert.equal(jump.value, 0.4, "jump must use the phone value immediately");
  assert.equal(jump.state, "active");
});

test("sensor filter removes jitter, requires spike confirmation, and preserves real motion", () => {
  const filter = new SafeSignalFilter({ smoothingAlpha: 0.5, deadzone: 0.01, outlierDelta: 0.3 });
  assert.equal(filter.process(0.5, 0).value, 0.5);
  assert.equal(filter.process(0.505, 16).value, 0.5);
  const spike = filter.process(0.95, 32);
  assert.equal(spike.value, 0.5);
  assert.equal(spike.state, "unstable");
  const confirmed = filter.process(0.94, 48);
  assert.equal(confirmed.state, "active");
  assert.ok(confirmed.value > 0.5 && confirmed.value < 0.94);
});
