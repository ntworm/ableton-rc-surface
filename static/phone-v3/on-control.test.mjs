// Copyright © 2026 Gabriel Worm
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
//
// ROOT CAUSE C2 — the MAP curve readout lies when the signal is lost.
//
// onControl() wrote the placeholder value that accompanies `lost: true` into
// currentControlStates, and the curve animation reads exactly that. So with
// Safe loss = hold the Live parameter correctly stayed put (BPM held at
// 269.48) while the phone drew "In: 0.00 | Out: 0.00" — telling the user the
// opposite of what the DAW was doing.
//
// A lost reading is not a measurement: it must not overwrite the last real one.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';

const source = fs.readFileSync(path.join(import.meta.dirname, 'app.js'), 'utf8');

function extractOnControl() {
  // app.js is a large bootstrap; pull out just the onControl assignment so the
  // contract can be exercised without standing up the whole phone UI.
  // Anchor on the lost-state initialiser that immediately precedes the
  // handler, so the extracted slice is self-contained.
  const start = source.indexOf('window.currentControlLost = window.currentControlLost');
  assert.ok(start > 0, 'window.currentControlLost initialiser must exist in app.js');
  const end = source.indexOf('window.onModulatorState', start);
  assert.ok(end > start, 'could not bound the onControl definition');
  return source.slice(start, end);
}

function loadOnControl() {
  const context = {
    window: null,
    state: { controls: [] },
    console,
  };
  context.window = context;
  context.globalThis = context;
  context.currentControlStates = {};
  vm.runInNewContext(extractOnControl(), context, { filename: 'app-onControl.js' });
  return context;
}

test('C2: a real reading updates the value shown on the curve', () => {
  const ctx = loadOnControl();
  ctx.onControl({ name: 'sensor.vision.z', value: 0.68 });
  assert.equal(ctx.currentControlStates['sensor.vision.z'], 0.68);
});

test('C2: a lost reading must not overwrite the last real value', () => {
  const ctx = loadOnControl();
  ctx.onControl({ name: 'sensor.vision.z', value: 0.68 });
  ctx.onControl({ name: 'sensor.vision.z', value: 0, lost: true });

  assert.equal(
    ctx.currentControlStates['sensor.vision.z'],
    0.68,
    'BUG CONFIRMED: the placeholder that accompanies a lost signal overwrote the ' +
      'last real reading, so the curve shows 0.00 while Live correctly holds the value',
  );
});

test('C2: the lost state is exposed so the UI can say "no signal"', () => {
  const ctx = loadOnControl();
  ctx.onControl({ name: 'sensor.vision.z', value: 0.68 });
  ctx.onControl({ name: 'sensor.vision.z', value: 0, lost: true });
  assert.equal(ctx.currentControlLost?.['sensor.vision.z'], true);

  ctx.onControl({ name: 'sensor.vision.z', value: 0.42 });
  assert.equal(ctx.currentControlLost?.['sensor.vision.z'], false,
    'a fresh reading must clear the lost flag');
  assert.equal(ctx.currentControlStates['sensor.vision.z'], 0.42);
});
