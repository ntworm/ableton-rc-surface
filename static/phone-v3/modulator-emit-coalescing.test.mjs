// Copyright © 2026 Gabriel Worm
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Source: https://github.com/ntworm/ableton-rc-surface
//
// A drag over an LFO toggle or a stutter button fires one touchmove per
// display refresh. Each of those used to become its own WebSocket frame, which
// put a single finger well past the server's per-client budget — and a
// rate-limited frame is dropped without a reply, so the only symptom was a
// control that stopped following the finger.
//
// rate/depth/count are continuous state where the newest value wins, so drag
// frames coalesce to one per animation frame. What must NOT coalesce is a gate
// transition: a dropped activate/deactivate is a stuck note.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';

function loadControls() {
  const read = (rel) => fs.readFileSync(path.join(import.meta.dirname, rel), 'utf8');

  const elementListeners = new Map();
  const mockElements = {};
  const makeElement = (key, dataName) => ({
    textContent: '',
    className: '',
    dataset: { name: dataName, padModeSet: 'A' },
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    style: { setProperty() {}, removeProperty() {} },
    addEventListener(evt, cb) {
      let byEvent = elementListeners.get(key);
      if (!byEvent) {
        byEvent = {};
        elementListeners.set(key, byEvent);
      }
      byEvent[evt] = cb;
    },
    setAttribute() {},
    clientHeight: 100,
    getBoundingClientRect: () => ({ top: 0, left: 0, width: 100, height: 100 }),
    querySelector: (sel) => getMockElement(sel),
    querySelectorAll: () => [],
    getContext: () => ({
      clearRect() {}, beginPath() {}, arc() {}, fill() {}, stroke() {},
      moveTo() {}, lineTo() {}, fillText() {}, setLineDash() {},
      createRadialGradient: () => ({ addColorStop() {} }),
    }),
  });
  const getMockElement = (id) => {
    if (!mockElements[id]) mockElements[id] = makeElement(id, id);
    return mockElements[id];
  };

  const rafQueue = [];
  const context = {
    window: null,
    document: {
      body: { dataset: {} },
      addEventListener() {},
      removeEventListener() {},
      getElementById: getMockElement,
      querySelector: (sel) => getMockElement(sel),
      querySelectorAll: (sel) => {
        if (sel === '.toggle') return [getMockElement('toggle-1')];
        if (sel === '.button') return [getMockElement('button-1')];
        return [];
      },
    },
    navigator: { onLine: true, vibrate() {}, wakeLock: null },
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    WebSocket: class { constructor() { this.readyState = 0; } send() {} close() {} },
    Event: class { constructor(t) { this.type = t; } },
    CustomEvent: class { constructor(t, o) { this.type = t; this.detail = o?.detail; } },
    requestAnimationFrame: (cb) => { rafQueue.push(cb); return rafQueue.length; },
    isSecureContext: true,
    performance: { now: () => Date.now() },
    location: { protocol: 'https:', host: 'localhost:8080' },
    addEventListener() {},
    dispatchEvent() {},
    setInterval: () => {},
    setTimeout: () => {},
    currentControlStates: {},
    syncMode: 'sync',
    syncSettings: {
      clockSource: 'osc',
      lfoSubdivisionPinned: false,
      lfoPhaseOffset: 0,
      lfoShape: 'sine',
      stutterSubdivisionPinned: false,
      stutterPhaseOffset: 0,
      stutterSwing: 0,
    },
    __flushFrame: () => {
      const pending = rafQueue.splice(0, rafQueue.length);
      for (const cb of pending) cb();
    },
    __fire: (elementKey, evt, payload) => {
      const cb = elementListeners.get(elementKey)?.[evt];
      assert.ok(cb, `no ${evt} listener registered on ${elementKey}`);
      cb(payload);
    },
  };
  context.window = context;

  vm.runInNewContext(read('mode-engine.js'), context, { filename: 'mode-engine.js' });
  vm.runInNewContext(read('app.js'), context, { filename: 'app.js' });
  vm.runInNewContext(read('modules/snapshots.js'), context, { filename: 'snapshots.js' });
  vm.runInNewContext(read('controls.js'), context, { filename: 'controls.js' });

  const emitted = [];
  context.onModulatorState = (modulator) => emitted.push(modulator);
  return { context, emitted };
}

function touch(identifier, clientX, clientY) {
  return { identifier, clientX, clientY, force: 1 };
}

function touchEvent(touches) {
  return {
    preventDefault() {},
    touches,
    changedTouches: touches,
  };
}

test('an LFO drag emits one modulator frame per animation frame, not per touchmove', () => {
  const { context, emitted } = loadControls();

  context.__fire('toggle-1', 'touchstart', touchEvent([touch(1, 100, 100)]));
  context.__flushFrame();
  emitted.length = 0;

  // Ten touchmoves inside a single frame — what a 120 Hz digitiser delivers
  // between two 60 Hz repaints, twice over.
  for (let i = 1; i <= 10; i++) {
    context.__fire('toggle-1', 'touchmove', touchEvent([touch(1, 100 + i, 100 - i * 3)]));
  }

  assert.equal(emitted.length, 0, 'drag frames must wait for the animation frame');

  context.__flushFrame();

  assert.equal(emitted.length, 1, 'ten touchmoves must coalesce into one emit');
  assert.equal(emitted[0].name, 'toggle-1');
  // The coalesced frame carries the newest value, not the first one.
  const state = context.window.lfoStates.get('toggle-1');
  assert.equal(emitted[0].depth, state.depth);
  assert.equal(emitted[0].rate, state.rate);
  assert.ok(state.depth > 0, 'the drag must have moved depth');
});

test('a stutter drag coalesces the same way', () => {
  const { context, emitted } = loadControls();

  context.__fire('button-1', 'touchstart', touchEvent([touch(1, 100, 100)]));
  context.__flushFrame();
  emitted.length = 0;

  for (let i = 1; i <= 8; i++) {
    context.__fire('button-1', 'touchmove', touchEvent([touch(1, 100 + i * 2, 100 - i)]));
  }
  assert.equal(emitted.length, 0);

  context.__flushFrame();
  assert.equal(emitted.length, 1, 'eight touchmoves must coalesce into one emit');
  assert.equal(emitted[0].name, 'button-1');
});

test('the gate transition at the end of a gesture is emitted immediately', () => {
  const { context, emitted } = loadControls();

  context.__fire('toggle-1', 'touchstart', touchEvent([touch(1, 100, 100)]));
  context.__flushFrame();
  emitted.length = 0;

  context.__fire('toggle-1', 'touchmove', touchEvent([touch(1, 110, 60)]));
  context.__fire('toggle-1', 'touchend', touchEvent([touch(1, 110, 60)]));

  assert.ok(emitted.length >= 1, 'the release must reach the wire without waiting for a frame');
  const release = emitted[emitted.length - 1];
  assert.equal(release.name, 'toggle-1');
  assert.equal(release.active, false, 'mode A releases the gate on touchend');

  // The superseded drag frame must not resurface after the release and
  // re-open a gate the performer just closed.
  const afterRelease = emitted.length;
  context.__flushFrame();
  assert.equal(emitted.length, afterRelease, 'no stale drag frame after the gate closed');
});
