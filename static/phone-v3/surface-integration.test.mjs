// Copyright © 2026 Gabriel Worm
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Source: https://github.com/ntworm/ableton-rc-surface
//
// static/phone-v3/surface-integration.test.mjs — Integration tests for Surface wake-lock and playhead modules.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

const html = fs.readFileSync(path.join(import.meta.dirname, 'index.html'), 'utf8');
const wakeLockSource = fs.readFileSync(path.join(import.meta.dirname, 'modules/wake-lock.js'), 'utf8');

test('index.html loads modules/wake-lock.js before app.js and playhead.js before controls.js', () => {
  const wakeLockIdx = html.indexOf('src="modules/wake-lock.js"');
  const appIdx = html.indexOf('src="app.js"');
  const playheadIdx = html.indexOf('src="modules/playhead.js"');
  const controlsIdx = html.indexOf('src="controls.js"');

  assert.ok(wakeLockIdx !== -1 && appIdx !== -1, 'wake-lock.js and app.js must be in index.html');
  assert.ok(wakeLockIdx < appIdx, 'wake-lock.js must be loaded before app.js');

  assert.ok(playheadIdx !== -1 && controlsIdx !== -1, 'playhead.js and controls.js must be in index.html');
  assert.ok(playheadIdx < controlsIdx, 'playhead.js must be loaded before controls.js');
});

test('setupWakeLock is idempotent and does not multiply visibilitychange listeners when called repeatedly', () => {
  const listeners = [];
  const mockDocument = {
    addEventListener(event, fn) {
      if (event === 'visibilitychange') {
        listeners.push(fn);
      }
    },
    removeEventListener() {}
  };

  const context = {
    window: {},
    document: mockDocument,
    console,
  };
  context.window = context.window || {};
  context.globalThis = context;

  vm.runInNewContext(wakeLockSource, context);

  // Call setupWakeLock multiple times
  context.window.RCSurface.setupWakeLock();
  context.window.RCSurface.setupWakeLock();
  context.window.RCSurface.setupWakeLock();

  assert.equal(listeners.length, 1, 'setupWakeLock should only register visibilitychange listener once');
});
