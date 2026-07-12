// Copyright © 2026 Gabriel Worm
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Source: https://github.com/ntworm/ableton-rc-surface
//
// This file is part of Ableton RC Surface, distributed under the
// PolyForm Noncommercial License 1.0.0. You may obtain a copy of
// the License at https://polyformproject.org/licenses/noncommercial/1.0.0
import test from "node:test";
import assert from "node:assert/strict";

// RED: src/util/cpu.ts não existe ainda. Será criado pela Task 5 do v0.5.0.
// Este teste deve falhar ATÉ o módulo existir e exportar `sampleCpuUsagePercent`.

test("src/util/cpu.ts module loads", async () => {
  const mod = await import("../src/util/cpu.ts");
  assert.equal(typeof mod.sampleCpuUsagePercent, "function");
});

test("sampleCpuUsagePercent returns number in [0, 1] after warmup", async () => {
  const { sampleCpuUsagePercent, resetCpuUsageSampleForTest } = await import("../src/util/cpu.ts");
  resetCpuUsageSampleForTest();
  // first call may need a second delta sample to settle — give it a tick.
  await new Promise((r) => setTimeout(r, 50));
  const v = sampleCpuUsagePercent();
  assert.ok(typeof v === "number");
  assert.ok(Number.isFinite(v), "should be finite");
  assert.ok(v >= 0 && v <= 1, "should be in [0,1] after clamp");
});
