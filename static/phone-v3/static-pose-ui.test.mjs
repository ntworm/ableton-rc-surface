// Copyright © 2026 Gabriel Worm
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

test('learned gesture UI captures only static poses with a short automatic take', () => {
  const html = fs.readFileSync(path.join(import.meta.dirname, 'index.html'), 'utf8');
  const app = fs.readFileSync(path.join(import.meta.dirname, 'app.js'), 'utf8');
  // The capture affordance is one button per gesture slot. Its label was
  // compacted from "CAPTURE POSE" to "CAP" when the Vision page was rebuilt to
  // fit a phone in landscape; what the contract cares about is that every slot
  // still owns a capture control and that the studio is framed as poses.
  assert.equal((html.match(/class="vision-slot-learn"/g) || []).length, 3);
  assert.match(html, /<strong>LEARNED POSES<\/strong>/);
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
