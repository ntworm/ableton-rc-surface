// Copyright © 2026 Gabriel Worm
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Source: https://github.com/ntworm/ableton-rc-surface
//
// The phone applies moves made by other performers on the shared surface. Two
// things must hold while it does: a momentary control must not be fired by a
// message (in modes A and D a pad is held, not latched, so driving one would
// trigger a note nobody's finger asked for), and applying a value must not
// re-announce modulator configuration — an LFO belongs to the host, and
// re-sending it from here would overwrite the rate and depth the other
// performer just set with this phone's local ones.
import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

function loadApp({ padMode = 'B' } = {}) {
  const read = (rel) => fs.readFileSync(path.join(import.meta.dirname, rel), 'utf8');

  const applied = [];
  const suppressionDepth = { max: 0, current: 0 };
  const elements = new Map();
  const makeEl = () => ({
    dataset: {},
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    style: { setProperty() {}, removeProperty() {} },
    addEventListener() {},
    setAttribute() {},
    getBoundingClientRect: () => ({ top: 0, left: 0, width: 100, height: 100 }),
    querySelector: () => makeEl(),
    querySelectorAll: () => [],
    getContext: () => ({
      clearRect() {}, beginPath() {}, arc() {}, fill() {}, stroke() {},
      moveTo() {}, lineTo() {}, fillText() {}, setLineDash() {},
      createRadialGradient: () => ({ addColorStop() {} }),
    }),
  });

  const context = {
    window: null,
    document: {
      body: { dataset: { padMode } },
      addEventListener() {},
      removeEventListener() {},
      getElementById: () => makeEl(),
      querySelector: (sel) => {
        if (!elements.has(sel)) elements.set(sel, makeEl());
        return elements.get(sel);
      },
      querySelectorAll: () => [],
    },
    navigator: { onLine: true, vibrate() {}, wakeLock: null },
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    WebSocket: class { constructor() { this.readyState = 0; } send() {} close() {} },
    Event: class { constructor(t) { this.type = t; } },
    CustomEvent: class { constructor(t, o) { this.type = t; this.detail = o?.detail; } },
    requestAnimationFrame: () => {},
    isSecureContext: true,
    performance: { now: () => Date.now() },
    location: { protocol: 'https:', host: 'localhost:8080', search: '' },
    addEventListener() {},
    dispatchEvent() {},
    setInterval: () => {},
    setTimeout: () => {},
    clearTimeout: () => {},
    currentControlStates: {},
    currentControlLost: {},
  };
  context.window = context;

  vm.runInNewContext(read('mode-engine.js'), context, { filename: 'mode-engine.js' });
  vm.runInNewContext(read('app.js'), context, { filename: 'app.js' });

  // Stand in for controls.js: record what the surface was asked to move.
  context.controlSetters = {};
  for (const name of ['fader-1', 'knob-2', 'xy-1.x', 'pad-3', 'toggle-1', 'button-2']) {
    context.controlSetters[name] = (v) => applied.push([name, v]);
  }
  context.withModulatorEmitSuppressed = (fn) => {
    suppressionDepth.current += 1;
    suppressionDepth.max = Math.max(suppressionDepth.max, suppressionDepth.current);
    try {
      fn();
    } finally {
      suppressionDepth.current -= 1;
    }
  };

  return { context, applied, suppressionDepth };
}

test('a remote fader move is applied to the local surface', () => {
  const { context, applied } = loadApp();
  context.window.applyRemoteControlValues({ 'fader-1': 0.25, 'knob-2': 0.8 });
  assert.deepEqual(applied, [['fader-1', 0.25], ['knob-2', 0.8]]);
});

test('both axes of an XY pad are applied', () => {
  const { context, applied } = loadApp();
  context.window.applyRemoteControlValues({ 'xy-1.x': 0.4 });
  assert.deepEqual(applied, [['xy-1.x', 0.4]]);
});

test('momentary controls are not fired by a message in modes A and D', () => {
  for (const padMode of ['A', 'D']) {
    const { context, applied } = loadApp({ padMode });
    context.window.applyRemoteControlValues({
      'pad-3': 1,
      'toggle-1': 1,
      'button-2': 1,
      'fader-1': 0.5,
    });
    assert.deepEqual(
      applied,
      [['fader-1', 0.5]],
      `mode ${padMode}: a held control must not be latched from the wire`,
    );
  }
});

test('in a latching mode the same controls do follow', () => {
  const { context, applied } = loadApp({ padMode: 'B' });
  context.window.applyRemoteControlValues({ 'pad-3': 1, 'toggle-1': 1 });
  assert.deepEqual(applied, [['pad-3', 1], ['toggle-1', 1]]);
});

test('modulator emission is suppressed while remote values are applied', () => {
  const { context, suppressionDepth } = loadApp();
  context.window.applyRemoteControlValues({ 'fader-1': 0.1 });
  assert.equal(
    suppressionDepth.max,
    1,
    "applying someone else's move must not re-announce this phone's LFO config",
  );
  assert.equal(suppressionDepth.current, 0, 'and the suppression must be released');
});

test('unknown controls and junk are ignored without throwing', () => {
  const { context, applied } = loadApp();
  context.window.applyRemoteControlValues({ 'no-such-control': 1 });
  context.window.applyRemoteControlValues(null);
  context.window.applyRemoteControlValues(undefined);
  context.window.applyRemoteControlValues('nonsense');
  assert.deepEqual(applied, []);
});

test('a setter that throws does not stop the rest of the batch', () => {
  const { context, applied } = loadApp();
  context.controlSetters['knob-2'] = () => {
    throw new Error('boom');
  };
  context.window.applyRemoteControlValues({ 'knob-2': 0.5, 'fader-1': 0.9 });
  assert.deepEqual(applied, [['fader-1', 0.9]]);
});
