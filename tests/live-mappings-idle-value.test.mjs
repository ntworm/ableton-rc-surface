import test from "node:test";
import assert from "node:assert/strict";

import {
  applyMapping,
  controlMappings,
  lastMappedValues,
  activeSmooths,
  eventModesState,
} from "../src/live/mappings.ts";
import { clearExtensionContext, setExtensionContext } from "../src/context.ts";

test("mappings correctly respect idleValue when deactivated", async () => {
  const applied = [];
  const param = {
    min: 0,
    max: 1,
    setValue(value) {
      applied.push(value);
      return Promise.resolve();
    },
  };

  controlMappings.clear();
  lastMappedValues.clear();
  activeSmooths.clear();
  eventModesState.clear();
  
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

  // Target 1: has idleValue = 0.5
  controlMappings.set("toggle-1", [
    { type: "device_param", trackIndex: 0, deviceIndex: 0, paramIndex: 0, outMin: 0.1, outMax: 0.9, idleValue: 0.5 },
  ]);

  try {
    // 1. Normal active tick (value = 0) -> should scale to outMin (0.1)
    await applyMapping("client-1", "toggle-1", 0, false);
    assert.equal(applied[applied.length - 1], 0.1);

    // 2. Normal active tick (value = 1) -> should scale to outMax (0.9)
    await applyMapping("client-1", "toggle-1", 1, false);
    assert.equal(applied[applied.length - 1], 0.9);

    // 3. Deactivated tick with value=0 -> should apply idleValue (0.5)
    await applyMapping("client-1", "toggle-1", 0, true);
    assert.equal(applied[applied.length - 1], 0.5);

    // Now let's test Target 2: NO idleValue configured (should fallback to scaled value at 0, i.e., outMin = 0.1)
    controlMappings.set("toggle-1", [
      { type: "device_param", trackIndex: 0, deviceIndex: 0, paramIndex: 0, outMin: 0.1, outMax: 0.9 },
    ]);

    await applyMapping("client-1", "toggle-1", 0, true);
    assert.equal(applied[applied.length - 1], 0.1);

  } finally {
    controlMappings.clear();
    lastMappedValues.clear();
    activeSmooths.clear();
    eventModesState.clear();
    clearExtensionContext();
  }
});
