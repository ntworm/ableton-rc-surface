// Copyright © 2026 Gabriel Worm
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Source: https://github.com/ntworm/ableton-rc-surface
//
// This file is part of Ableton RC Surface, distributed under the
// PolyForm Noncommercial License 1.0.0. You may obtain a copy of
// the License at https://polyformproject.org/licenses/noncommercial/1.0.0
import test from "node:test";
import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

const testsDir = join(import.meta.dirname, "..", "tests");

test("parallel server tests reserve non-overlapping HTTP and HTTPS port pairs", async () => {
  const assignments = [];

  for (const file of await readdir(testsDir)) {
    if (!file.endsWith(".test.mjs")) continue;
    const source = await readFile(join(testsDir, file), "utf8");
    const match = source.match(/process\.env\.RC_SURFACE_PORT\s*=\s*["'](\d+)["']/);
    if (match) assignments.push({ file, base: Number(match[1]) });
  }

  const occupied = new Map();
  for (const { file, base } of assignments) {
    for (const [kind, port] of [["HTTP", base], ["HTTPS", base + 1]]) {
      const previous = occupied.get(port);
      assert.equal(
        previous,
        undefined,
        `${file} ${kind} port ${port} overlaps ${previous}`,
      );
      occupied.set(port, `${file} ${kind}`);
    }
  }
});
