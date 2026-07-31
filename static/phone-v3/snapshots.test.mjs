// Copyright © 2026 Gabriel Worm
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Source: https://github.com/ntworm/ableton-rc-surface
//
// static/phone-v3/snapshots.test.mjs — Unit tests for Snapshots & Morphing module.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

const html = fs.readFileSync(path.join(import.meta.dirname, 'index.html'), 'utf8');
const source = fs.readFileSync(path.join(import.meta.dirname, 'modules/snapshots.js'), 'utf8');

function loadModule(mockGlobals = {}) {
  const store = new Map();
  const mockLocalStorage = {
    getItem(key) { return store.get(key) || null; },
    setItem(key, value) { store.set(key, String(value)); },
    clear() { store.clear(); }
  };

  const context = {
    window: {
      currentControlStates: { 'pad-1': 0.8 }
    },
    document: {
      querySelectorAll() { return []; },
      getElementById() { return null; }
    },
    localStorage: mockLocalStorage,
    Date,
    console,
    Array,
    JSON,
    setTimeout,
    clearTimeout,
  };
  context.window = context.window || {};
  context.globalThis = context;

  Object.assign(context, mockGlobals);

  vm.runInNewContext(source, context);

  return {
    window: context.window,
    localStorage: mockLocalStorage,
    store,
  };
}

test('index.html loads modules/snapshots.js before controls.js', () => {
  const moduleIdx = html.indexOf('src="modules/snapshots.js"');
  const controlsIdx = html.indexOf('src="controls.js"');

  assert.ok(moduleIdx !== -1, 'modules/snapshots.js script tag must be present in index.html');
  assert.ok(controlsIdx !== -1, 'controls.js script tag must be present in index.html');
  assert.ok(moduleIdx < controlsIdx, 'modules/snapshots.js must be loaded before controls.js');
});

test('RCSurface.snapshots loads, captures, and persists 8 snapshot slots', () => {
  const env = loadModule();
  const snaps = env.window.RCSurface.snapshots;

  assert.equal(typeof snaps.loadSnapshots, 'function');
  assert.equal(typeof snaps.setSnapshotCaptureMode, 'function');
  assert.equal(typeof snaps.handleSnapshotSlot, 'function');

  // Initial load: 8 empty slots
  snaps.loadSnapshots();
  assert.equal(snaps.getSnapshots().length, 8);
  assert.equal(snaps.getSnapshots()[0], null);

  // Enable capture mode and capture slot 0
  snaps.setSnapshotCaptureMode(true);
  assert.equal(snaps.isCaptureMode(), true);

  snaps.handleSnapshotSlot(0);
  assert.equal(snaps.isCaptureMode(), false);
  assert.deepEqual(snaps.getSnapshots()[0], { 'pad-1': 0.8 });

  // Persistence check in localStorage
  const saved = env.store.get('ableton-rc:snapshots');
  assert.ok(saved, 'Snapshots must be saved to localStorage');
  const parsed = JSON.parse(saved);
  assert.equal(parsed.length, 8);
  assert.deepEqual(parsed[0], { 'pad-1': 0.8 });
});

test('Structural Check: controls.js has no morphRafId, no direct snapshots[n] indexing, and single startLinearMorph', () => {
  const controlsSource = fs.readFileSync(path.join(import.meta.dirname, 'controls.js'), 'utf8');

  // 1. morphRafId must not be in controls.js
  const hasMorphRafId = controlsSource.includes('morphRafId');
  assert.equal(hasMorphRafId, false, 'controls.js must not reference morphRafId');

  // 2. Direct snapshots[n] indexing must not be in controls.js
  const directSnapshotMatches = controlsSource.match(/snapshots\s*\[\s*\d+\s*\]/g);
  assert.equal(directSnapshotMatches, null, 'controls.js must not directly index snapshots[n]');

  // 3. Exactly one startLinearMorph function declaration in controls.js
  const morphMatches = controlsSource.match(/function\s+startLinearMorph\b/g);
  assert.ok(morphMatches !== null && morphMatches.length === 1, 'controls.js must have exactly 1 startLinearMorph declaration (the delegator)');
});

function loadFullEnvironment() {
  const engineFile = path.join(import.meta.dirname, 'mode-engine.js');
  const snapshotsFile = path.join(import.meta.dirname, 'modules/snapshots.js');
  const controlsFile = path.join(import.meta.dirname, 'controls.js');

  const engineSource = fs.readFileSync(engineFile, 'utf8');
  const snapshotsSource = fs.readFileSync(snapshotsFile, 'utf8');
  const controlsSource = fs.readFileSync(controlsFile, 'utf8');

  const listenersMap = new Map(); // el -> Map(type -> Array<fn>)

  function createMockElement(id = '', className = '', dataset = {}) {
    const elListeners = new Map();
    const children = [];
    const el = {
      id,
      className,
      classList: {
        add: () => {},
        remove: () => {},
        toggle: () => {},
        contains: () => false,
      },
      dataset,
      style: { setProperty: () => {}, removeProperty: () => {} },
      setAttribute: () => {},
      removeAttribute: () => {},
      addEventListener(type, fn) {
        if (!elListeners.has(type)) elListeners.set(type, []);
        elListeners.get(type).push(fn);
      },
      click() {
        const fns = elListeners.get('click') || [];
        fns.forEach(fn => fn({ preventDefault() {} }));
      },
      get listenerCount() {
        let count = 0;
        for (const list of elListeners.values()) count += list.length;
        return count;
      },
      querySelector: (sel) => null,
      querySelectorAll: (sel) => [],
      getContext: () => ({
        clearRect() {},
        beginPath() {},
        arc() {},
        fill() {},
        stroke() {},
        fillText() {},
        setLineDash() {},
        moveTo() {},
        lineTo() {},
      }),
      clientHeight: 100,
      clientWidth: 100,
      getBoundingClientRect: () => ({ top: 0, left: 0, width: 100, height: 100 }),
    };
    listenersMap.set(el, elListeners);
    return el;
  }

  const captureBtn = createMockElement('btn-perf-snapshot-capture');
  const mainCaptureBtn = createMockElement('btn-snapshot-capture');
  const offBtn = createMockElement('btn-perf-off');

  const perfSlots = Array.from({ length: 4 }, (_, i) =>
    createMockElement('', 'perf-snapshot-slot', { perfSnapshotSlot: String(i + 1) })
  );
  const snapSlots = Array.from({ length: 8 }, (_, i) =>
    createMockElement('', 'snapshot-slot', { slot: String(i + 1) })
  );

  const vectorPad = createMockElement('xy-vector-pad');
  const vectorContainer = createMockElement('snp-vector-container');

  const elementsById = new Map([
    ['btn-perf-snapshot-capture', captureBtn],
    ['btn-snapshot-capture', mainCaptureBtn],
    ['btn-perf-off', offBtn],
    ['xy-vector-pad', vectorPad],
    ['snp-vector-container', vectorContainer],
  ]);

  const store = new Map();
  const mockLocalStorage = {
    getItem(key) { return store.get(key) || null; },
    setItem(key, value) { store.set(key, String(value)); },
    clear() { store.clear(); }
  };

  const context = {
    window: null,
    document: {
      body: createMockElement('body'),
      getElementById: (id) => elementsById.get(id) || null,
      querySelector: (sel) => null,
      querySelectorAll: (sel) => {
        if (sel === '.perf-snapshot-slot') return perfSlots;
        if (sel === '.snapshot-slot') return snapSlots;
        if (sel === '.pad' || sel === '.toggle' || sel === '.button' || sel === '.xy-pad') return [];
        if (sel === '[data-pad-mode-set]' || sel === '[data-morph-mode]') return [];
        return [];
      },
      addEventListener() {},
    },
    localStorage: mockLocalStorage,
    navigator: { vibrate() {} },
    Date: { now: () => 1000 },
    performance: { now: () => 1000 },
    requestAnimationFrame: (fn) => setTimeout(fn, 16),
    cancelAnimationFrame: () => {},
    addEventListener() {},
    dispatchEvent() {},
    Event: class { constructor(t) { this.type = t; } },
    CustomEvent: class { constructor(t, o) { this.type = t; this.detail = o?.detail; } },
    setTimeout,
    clearTimeout,
    setInterval() {},
    clearInterval() {},
    console,
    Array,
    JSON,
  };
  context.window = context;

  vm.runInNewContext(engineSource, context, { filename: engineFile });
  vm.runInNewContext(snapshotsSource, context, { filename: snapshotsFile });
  vm.runInNewContext(controlsSource, context, { filename: controlsFile });

  return {
    context,
    captureBtn,
    mainCaptureBtn,
    offBtn,
    perfSlots,
    snapSlots,
    vectorPad,
  };
}

test('Listener Ownership & Idempotency: setupSnapshots() is idempotent and setupPerformanceUtilities() does not duplicate capture/slot listeners', () => {
  const env = loadFullEnvironment();
  const snaps = env.context.window.RCSurface.snapshots;

  // 1. Initial setupSnapshots() was run at load time
  // Clicking btn-perf-snapshot-capture toggles capture mode ONCE
  assert.equal(snaps.isCaptureMode(), false);
  env.captureBtn.click();
  assert.equal(snaps.isCaptureMode(), true, 'Clicking capture button must set captureMode to true');

  // Click again to turn off
  env.captureBtn.click();
  assert.equal(snaps.isCaptureMode(), false, 'Clicking capture button again must set captureMode to false');

  // 2. Call setupSnapshots() TWICE
  snaps.setupSnapshots();
  snaps.setupSnapshots();

  // Clicking capture button must STILL toggle capture mode exactly ONCE (not twice, which would revert it!)
  env.captureBtn.click();
  assert.equal(snaps.isCaptureMode(), true, 'Calling setupSnapshots() multiple times must not duplicate click listeners');
});

test('Vector Pad Interpolation with 4 snapshots without ReferenceError', () => {
  const env = loadFullEnvironment();
  const snaps = env.context.window.RCSurface.snapshots;

  // Save 4 snapshots
  snaps.setSnapshotCaptureMode(true);
  env.context.window.currentControlStates = { 'pad-1': 0.1 };
  snaps.handleSnapshotSlot(0);

  snaps.setSnapshotCaptureMode(true);
  env.context.window.currentControlStates = { 'pad-1': 0.5 };
  snaps.handleSnapshotSlot(1);

  snaps.setSnapshotCaptureMode(true);
  env.context.window.currentControlStates = { 'pad-1': 0.8 };
  snaps.handleSnapshotSlot(2);

  snaps.setSnapshotCaptureMode(true);
  env.context.window.currentControlStates = { 'pad-1': 1.0 };
  snaps.handleSnapshotSlot(3);

  // Vector pad draw/resize check — should not throw ReferenceError: snapshots is not defined
  assert.doesNotThrow(() => {
    if (typeof env.context.window.setupVectorPad === 'function') {
      env.context.window.setupVectorPad();
    }
  }, 'setupVectorPad must access snapshots via getSnapshots() without ReferenceError');
});
