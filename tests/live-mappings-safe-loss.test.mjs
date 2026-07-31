// Copyright © 2026 Gabriel Worm
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
//
// Safe loss — the policy applied when a control's signal is lost while the
// phone is still connected (hand out of frame, camera off, sensor denied).
//
// Five modes, each one doing something the others do not:
//   hold    freeze at the last real value
//   zero    park at 0
//   center  park at 0.5
//   custom  park at the NEUTRAL slider value
//   release glide back to the control's natural rest position
//
// "initial" and "reconcile" were dropped: both ended up meaning "adopt Live's
// current value", which made them duplicates of each other and of hold from
// the user's point of view. Mappings saved with either are migrated to hold,
// the closest surviving behaviour (leave the parameter where Live has it).

import test from "node:test";
import assert from "node:assert/strict";
import {
  activeSmooths,
  applyMapping,
  controlMappings,
  eventModesState,
  lastMappedValues,
  resolveNeutralInputValue,
  startSmoothTimer,
  stopSmoothTimer,
} from "../src/live/mappings.ts";
import { clearExtensionContext, setExtensionContext } from "../src/context.ts";

const LAST = 0.9;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

test("safe loss: each surviving policy resolves to its own value", () => {
  const cases = [
    ["hold", null, "hold keeps the parameter where it is"],
    ["zero", 0, "zero parks at the bottom"],
    ["center", 0.5, "center parks at the middle"],
    ["custom", 0.42, "custom uses the NEUTRAL slider value"],
  ];
  for (const [policy, expected, message] of cases) {
    const target = { neutralPolicy: policy, neutralValue: 0.42 };
    assert.equal(resolveNeutralInputValue("sensor.vision.x", target, LAST), expected, message);
  }
});

test("safe loss: release targets the control's natural rest, not a blanket zero", () => {
  // A position axis rests in the middle; a gate rests closed. Collapsing both
  // to zero is what made every lost signal slam to the minimum.
  assert.equal(resolveNeutralInputValue("sensor.vision.x", { neutralPolicy: "release" }, LAST), 0.5);
  assert.equal(resolveNeutralInputValue("sensor.vision.fist", { neutralPolicy: "release" }, LAST), 0);
});

test("safe loss: an unset policy behaves like release", () => {
  assert.equal(resolveNeutralInputValue("sensor.vision.y", {}, LAST), 0.5);
});

test("safe loss: legacy 'initial' and 'reconcile' mappings migrate to hold", () => {
  for (const legacy of ["initial", "reconcile"]) {
    assert.equal(
      resolveNeutralInputValue("sensor.vision.x", { neutralPolicy: legacy }, LAST),
      null,
      `${legacy} must fall back to hold rather than silently acting like release`,
    );
  }
});

function setupSong(targets) {
  const param = {
    name: "Dry/Wet", min: 0, max: 1, value: 0.9,
    setValue: async (v) => { param.value = v; },
  };
  controlMappings.clear();
  lastMappedValues.clear();
  activeSmooths.clear();
  eventModesState.clear();
  setExtensionContext({
    application: { song: { tempo: 120, tracks: [{ devices: [{ parameters: [param] }] }] } },
  });
  controlMappings.set("sensor.vision.x", targets);
  return param;
}

test("safe loss: center parks the parameter at the middle immediately", async (t) => {
  const param = setupSong([
    { type: "device_param", trackIndex: 0, deviceIndex: 0, paramIndex: 0, neutralPolicy: "center" },
  ]);
  t.after(() => { stopSmoothTimer(); clearExtensionContext(); });

  await applyMapping("client-1", "sensor.vision.x", 0.9);
  await applyMapping("client-1", "sensor.vision.x", 0.9, true);
  assert.ok(Math.abs(param.value - 0.5) < 0.01, `expected 0.5, got ${param.value}`);
});

test("safe loss: hold leaves the parameter untouched", async (t) => {
  const param = setupSong([
    { type: "device_param", trackIndex: 0, deviceIndex: 0, paramIndex: 0, neutralPolicy: "hold" },
  ]);
  t.after(() => { stopSmoothTimer(); clearExtensionContext(); });

  await applyMapping("client-1", "sensor.vision.x", 0.8);
  const held = param.value;
  await applyMapping("client-1", "sensor.vision.x", 0.0, true);
  assert.equal(param.value, held, `hold must not move the parameter, moved to ${param.value}`);
});

test("safe loss: release GLIDES to the rest position instead of jumping", async (t) => {
  const param = setupSong([
    { type: "device_param", trackIndex: 0, deviceIndex: 0, paramIndex: 0, neutralPolicy: "release" },
  ]);
  t.after(() => { stopSmoothTimer(); activeSmooths.clear(); clearExtensionContext(); });
  startSmoothTimer();

  await applyMapping("client-1", "sensor.vision.x", 1.0);
  assert.ok(Math.abs(param.value - 1.0) < 0.02, `live reading should apply, got ${param.value}`);

  await applyMapping("client-1", "sensor.vision.x", 1.0, true);
  // Immediately after the loss it must still be near the last real value —
  // that gradual return is the whole point of "release" versus "center".
  await wait(40);
  const justAfter = param.value;
  assert.ok(
    justAfter > 0.7,
    `release must not jump straight to rest; it was already at ${justAfter}`,
  );

  await wait(1500);
  assert.ok(
    Math.abs(param.value - 0.5) < 0.05,
    `release must settle at the rest position 0.5, got ${param.value}`,
  );
});
