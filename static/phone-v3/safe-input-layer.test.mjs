// Copyright © 2026 Gabriel Worm
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

function load() {
  const source = fs.readFileSync(path.join(import.meta.dirname, 'safe-input-layer.js'), 'utf8');
  const context = { window: null, globalThis: null };
  context.window = context;
  context.globalThis = context;
  vm.runInNewContext(source, context);
  return context.SafeInputLayer;
}

test('safe signal rejects an isolated spike and decays to neutral after loss', () => {
  const { SafeSignal } = load();
  const signal = new SafeSignal({ neutral: 0, holdMs: 100, releaseMs: 200, outlierDelta: 0.5 });
  assert.equal(signal.ingest(0.2, 0).value, 0.2);
  assert.equal(signal.ingest(0.95, 16).value, 0.2);
  signal.markLost(50);
  assert.equal(signal.tick(100).value, 0.2);
  assert.ok(signal.tick(200).value < 0.2);
  assert.equal(signal.tick(350).value, 0);
  const recovered = signal.ingest(1, 366);
  assert.equal(recovered.state, 'recovering');
  assert.ok(recovered.value < 1);
});

test('safe signal accepts a sustained large change on confirmation', () => {
  const { SafeSignal } = load();
  const signal = new SafeSignal({ outlierDelta: 0.5, attack: 1 });
  signal.ingest(0.2, 0);
  assert.equal(signal.ingest(0.95, 16).state, 'unstable');
  const confirmed = signal.ingest(0.94, 32);
  assert.equal(confirmed.state, 'active');
  assert.equal(confirmed.value, 0.94);
});

test('phone audio integration uses watchdog loss handling instead of freezing the last value', () => {
  const app = fs.readFileSync(path.join(import.meta.dirname, 'app.js'), 'utf8');
  assert.match(app, /AUDIO_SIGNAL_TIMEOUT_MS/);
  assert.match(app, /new window\.SafeInputLayer\.SafeSignal/);
  assert.match(app, /markLost/);
  assert.match(app, /releaseMs:\s*1200/);
});

test('vision UI exposes tracking confidence and three static pose slots without retired smoothing', () => {
  const html = fs.readFileSync(path.join(import.meta.dirname, 'index.html'), 'utf8');
  const app = fs.readFileSync(path.join(import.meta.dirname, 'app.js'), 'utf8');
  for (const id of ['vision-confidence', 'vision-recognition-preset']) {
    assert.match(html, new RegExp(`id=["']${id}["']`));
  }
  assert.doesNotMatch(html, /id=["']vision-smoothing["']/);
  assert.match(app, /beginGestureLearn/);
  assert.match(app, /finishGestureLearn/);
  assert.match(app, /POSE_CAPTURE_MS/);
  assert.equal((html.match(/data-gesture-slot=/g) || []).length, 3);
  assert.match(html, /sensor\.vision\.gesture\.1/);
  assert.match(html, /sensor\.vision\.gesture\.3/);
});
