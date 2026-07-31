// Copyright © 2026 Gabriel Worm
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

test('learned gesture UI captures only static poses with a short automatic take', () => {
  const html = fs.readFileSync(path.join(import.meta.dirname, 'index.html'), 'utf8');
  const app = fs.readFileSync(path.join(import.meta.dirname, 'app.js'), 'utf8');
  assert.match(html, /CAPTURE POSE/);
  assert.match(app, /POSE_CAPTURE_MS/);
  assert.match(app, /HOLD POSE/);
  assert.match(app, /POSE · 3\/3 complete/);
  assert.doesNotMatch(app, /perform one MOTION/);
  assert.doesNotMatch(app, /STOP & SAVE TAKE/);
  assert.doesNotMatch(app, /repeat the full movement/);
});

test('pose testing explains arming, confidence and release instead of movement tracking', () => {
  const app = fs.readFileSync(path.join(import.meta.dirname, 'app.js'), 'utf8');
  assert.match(app, /HOLD THE LEARNED POSE/);
  assert.match(app, /POSE MATCH/);
  assert.match(app, /release and show the pose again/i);
});
