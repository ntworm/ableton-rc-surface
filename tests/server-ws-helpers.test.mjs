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

test("appendHistory caps at HISTORY_MAX (300 entries)", async () => {
  const { appendHistory, HISTORY_MAX } = await import("../src/server/ws.ts");
  // fake tracked client with empty history
  const c = { history: {} };
  for (let i = 0; i < HISTORY_MAX + 50; i++) {
    appendHistory(c, "knob1", i, Date.now());
  }
  const series = c.history.knob1;
  assert.ok(series.length <= HISTORY_MAX,
    `history should be capped at ${HISTORY_MAX}, got ${series.length}`);
});
