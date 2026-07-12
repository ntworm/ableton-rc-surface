// Copyright © 2026 Gabriel Worm
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Source: https://github.com/ntworm/ableton-rc-surface
//
// This file is part of Ableton RC Surface, distributed under the
// PolyForm Noncommercial License 1.0.0. You may obtain a copy of
// the License at https://polyformproject.org/licenses/noncommercial/1.0.0
import test from "node:test";
import assert from "node:assert/strict";

// RED: src/server/client-id.ts não existe ainda. Será criado pela Task 5.

test("src/server/client-id.ts exports createClientId", async () => {
  const mod = await import("../src/server/client-id.ts");
  assert.equal(typeof mod.createClientId, "function");
});

test("createClientId returns a string in UUID v4 format", async () => {
  const { createClientId } = await import("../src/server/client-id.ts");
  const id = createClientId();
  assert.equal(typeof id, "string");
  // RFC 4122 v4: 8-4-4-4-12 with version 4 and variant nibble
  const uuidV4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  assert.match(id, uuidV4, "should be a UUID v4 string");
});

test("createClientId returns unique values on each call", async () => {
  const { createClientId } = await import("../src/server/client-id.ts");
  const ids = new Set();
  for (let i = 0; i < 100; i++) ids.add(createClientId());
  assert.equal(ids.size, 100, "should produce 100 unique IDs");
});
