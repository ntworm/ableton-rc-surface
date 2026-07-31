// Copyright © 2026 Gabriel Worm
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const read = (file) => fs.readFileSync(path.join(import.meta.dirname, file), 'utf8');

test('stale clients receive a high-contrast visual state', () => {
  assert.match(read('app.js'), /classList\.toggle\(['"]stale['"]/);
  const css = read('style.css');
  assert.match(css, /\.client-item\.stale/);
  assert.match(css, /#ff453a/i);
});
