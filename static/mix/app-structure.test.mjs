import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

test("Auto Filter graph is visual-only and segmented labels are shortened", () => {
  const source = fs.readFileSync(path.join(import.meta.dirname, "app.js"), "utf8");

  assert.doesNotMatch(source, /display\.addEventListener\("mousedown"/);
  assert.doesNotMatch(source, /display\.addEventListener\("touchstart"/);
  assert.match(source, /shortFilterChoiceLabel/);
});
