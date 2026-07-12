// Copyright © 2026 Gabriel Worm
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Source: https://github.com/ntworm/ableton-rc-surface
//
// This file is part of Ableton RC Surface, distributed under the
// PolyForm Noncommercial License 1.0.0. You may obtain a copy of
// the License at https://polyformproject.org/licenses/noncommercial/1.0.0
import test from "node:test";
import assert from "node:assert/strict";

import {
  activeSmooths,
  applyMapping,
  controlMappings,
  eventModesState,
  lastMappedValues,
} from "../src/live/mappings.ts";
import { clearExtensionContext, setExtensionContext } from "../src/context.ts";

function deferred() {
  let resolve;
  const promise = new Promise((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

async function waitUntil(predicate, message) {
  const started = Date.now();
  while (Date.now() - started < 500) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail(message);
}

test("high-rate mapping applies the latest pending value after an in-flight setValue finishes", async () => {
  const pending = [];
  const applied = [];
  const param = {
    min: 0,
    max: 1,
    setValue(value) {
      applied.push(value);
      const d = deferred();
      pending.push(d);
      return d.promise;
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
  controlMappings.set("button-1", [
    { type: "device_param", trackIndex: 0, deviceIndex: 0, paramIndex: 0 },
  ]);

  try {
    const firstApply = applyMapping("client-1", "button-1", 0.1);
    await Promise.resolve();

    await applyMapping("client-1", "button-1", 0.9);
    assert.deepEqual(applied, [0.1]);

    pending[0].resolve();
    await waitUntil(
      () => applied.length === 2,
      "expected pending high-rate value to be applied after the first setValue resolved",
    );

    assert.deepEqual(applied, [0.1, 0.9]);
    pending[1].resolve();
    await firstApply;
  } finally {
    for (const d of pending) d.resolve();
    controlMappings.clear();
    lastMappedValues.clear();
    activeSmooths.clear();
    eventModesState.clear();
    clearExtensionContext();
  }
});
