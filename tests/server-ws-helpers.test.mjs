// Copyright © 2026 Gabriel Worm
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Source: https://github.com/ntworm/ableton-rc-surface
//
// This file is part of Ableton RC Surface, distributed under the
// PolyForm Noncommercial License 1.0.0. You may obtain a copy of
// the License at https://polyformproject.org/licenses/noncommercial/1.0.0
import test from "node:test";
import assert from "node:assert/strict";

// RED: src/server/ws.ts já existe. Estes testes verificam exports que serão adicionados
// na Task 6 ou se já existem não-exportados.

test("ws.ts exports appendHistory", async () => {
  const mod = await import("../src/server/ws.ts");
  assert.equal(typeof mod.appendHistory, "function",
    "appendHistory should be exported as a helper");
});

test("ws.ts exports broadcastToAdmins", async () => {
  const mod = await import("../src/server/ws.ts");
  assert.equal(typeof mod.broadcastToAdmins, "function");
});

test("appendHistory caps at HISTORY_MAX (120 ring-buffer entries per ADR-004)", async () => {
  const { appendHistory, HISTORY_MAX } = await import("../src/server/ws.ts");
  assert.equal(HISTORY_MAX, 120, "HISTORY_MAX should be 120 per ADR-004");
  // fake tracked client with empty history
  const c = { history: {} };
  for (let i = 0; i < HISTORY_MAX + 50; i++) {
    appendHistory(c, "knob1", i, Date.now());
  }
  const series = c.history.knob1;
  assert.ok(series.length <= HISTORY_MAX,
    `history should be capped at ${HISTORY_MAX}, got ${series.length}`);
});

test("ws.ts treats typed phone messages as non-command envelopes", async () => {
  const { isCommandEnvelope } = await import("../src/server/ws.ts");

  assert.equal(isCommandEnvelope({ type: "snapshot" }), false);
  assert.equal(isCommandEnvelope({ type: "ping" }), false);
  assert.equal(isCommandEnvelope({ cmd: "getServerInfo" }), true);
  assert.equal(isCommandEnvelope({ cmd: 42 }), false);
});
