// Copyright © 2026 Gabriel Worm
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
//
// ROOT CAUSE B1 — a mapping with Smooth > 0 stops updating Live, permanently.
//
// startSmoothTimer() is called exactly once, at extension activation. Its
// interval body self-terminates the moment the queue drains:
//
//     if (activeSmooths.size === 0) { clearInterval(...); return; }
//
// and the loop deletes each entry as it settles. applyMapping() pushes new
// smoothed values into activeSmooths but never restarts the timer, so after
// the first time every smooth settles, nothing ever drains the queue again.
//
// Field report: "quando eu coloco smooth no valor ele buga" and "teve uma hora
// que mexendo nas configs de mapeamento o valor parou de atualizar no ableton".

import test from "node:test";
import assert from "node:assert/strict";
import {
  activeSmooths,
  applyMapping,
  controlMappings,
  eventModesState,
  lastMappedValues,
  startSmoothTimer,
  stopSmoothTimer,
  isSmoothTimerRunning,
} from "../src/live/mappings.ts";
import { clearExtensionContext, setExtensionContext } from "../src/context.ts";

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

function setupSong() {
  const applied = [];
  const param = {
    name: "Dry/Wet",
    min: 0,
    max: 1,
    value: 0,
    setValue: async (v) => { param.value = v; applied.push(v); },
  };
  controlMappings.clear();
  lastMappedValues.clear();
  activeSmooths.clear();
  eventModesState.clear();
  setExtensionContext({
    application: {
      song: { tempo: 120, tracks: [{ devices: [{ parameters: [param] }] }] },
    },
  });
  controlMappings.set("knob-1", [
    { type: "device_param", trackIndex: 0, deviceIndex: 0, paramIndex: 0, smooth: 0.5 },
  ]);
  return { param, applied };
}

test("B1: a smoothed mapping still reaches Live after the smooth queue has drained once", async (t) => {
  const { param, applied } = setupSong();
  t.after(() => { stopSmoothTimer(); activeSmooths.clear(); clearExtensionContext(); });

  startSmoothTimer();

  // First move: the smoother runs and eventually settles, emptying the queue.
  await applyMapping("client-1", "knob-1", 0.8);
  await wait(400);
  assert.ok(applied.length > 0, "the first smoothed move must reach the parameter");
  assert.ok(Math.abs(param.value - 0.8) < 0.05, `expected ~0.8, got ${param.value}`);
  assert.equal(activeSmooths.size, 0, "queue must drain once the value settles");

  // Let the interval observe the empty queue (this is where it kills itself).
  await wait(80);

  // Second move: this is the one the user never sees in Live.
  const before = applied.length;
  await applyMapping("client-1", "knob-1", 0.2);
  await wait(400);

  assert.ok(
    applied.length > before,
    "BUG CONFIRMED: after the smooth queue drained once, the timer stopped for good " +
      "and every later smoothed value is queued but never applied — the Live " +
      "parameter freezes.",
  );
  assert.ok(
    Math.abs(param.value - 0.2) < 0.05,
    `expected the parameter to reach ~0.2, got ${param.value}`,
  );
});

test("B1: queueing a smoothed value restarts the timer when it is not running", async (t) => {
  setupSong();
  t.after(() => { stopSmoothTimer(); activeSmooths.clear(); clearExtensionContext(); });

  stopSmoothTimer();
  assert.equal(isSmoothTimerRunning(), false, "precondition: timer stopped");

  await applyMapping("client-1", "knob-1", 0.7);

  assert.equal(
    isSmoothTimerRunning(),
    true,
    "BUG CONFIRMED: a smoothed value was queued while no timer was running, " +
      "so nothing will ever drain it",
  );
});
