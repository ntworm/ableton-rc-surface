// Copyright © 2026 Gabriel Worm
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

test('desktop and mobile mapping editors expose takeover and neutral safety policy', () => {
  const panel = fs.readFileSync(path.join(import.meta.dirname, 'mappings.js'), 'utf8');
  const mobile = fs.readFileSync(path.join(import.meta.dirname, '..', 'phone-v3', 'mapping-mode.js'), 'utf8');
  for (const source of [panel, mobile]) {
    assert.match(source, /takeoverMode/);
    assert.match(source, /scale/);
    assert.match(source, /pickup/);
    assert.match(source, /jump/);
    assert.match(source, /neutralPolicy/);
    assert.match(source, /neutralValue/);
  }
});
