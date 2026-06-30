import test from "node:test";
import assert from "node:assert/strict";

// RED: src/live/mappings.ts já existe mas algumas helpers podem ser adicionados
// ou tornados export na Task 4 ou 6. Estes testes verificam os contratos.

test("applyCurve exists and is a function", async () => {
  const mod = await import("../src/live/mappings.ts");
  assert.equal(typeof mod.applyCurve, "function",
    "applyCurve should be exported from live/mappings.ts");
});

test("applyCurve linear identity", async () => {
  const { applyCurve } = await import("../src/live/mappings.ts");
  assert.equal(applyCurve(0.5, "linear"), 0.5);
  assert.equal(applyCurve(0, "linear"), 0);
  assert.equal(applyCurve(1, "linear"), 1);
});

test("applyCurveInverse inverts applyCurve for known curves", async () => {
  const { applyCurve, applyCurveInverse } = await import("../src/live/mappings.ts");
  // For monotonic curves, applyCurveInverse(applyCurve(x)) === x (within float epsilon)
  for (const curve of ["linear", "exponential", "logarithmic", "s-curve"]) {
    const v = 0.37;
    const encoded = applyCurve(v, curve);
    const decoded = applyCurveInverse(encoded, curve);
    assert.ok(Math.abs(v - decoded) < 1e-6,
      `curve ${curve}: round-trip error should be < 1e-6, got ${Math.abs(v - decoded)}`);
  }
});
