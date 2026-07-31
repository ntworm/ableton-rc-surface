// Copyright © 2026 Gabriel Worm
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Source: https://github.com/ntworm/ableton-rc-surface
//
// This file is part of Ableton RC Surface, distributed under the
// PolyForm Noncommercial License 1.0.0. You may obtain a copy of
// the License at https://polyformproject.org/licenses/noncommercial/1.0.0
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';

function makeStyle() {
  const values = new Map();
  return {
    setProperty(name, value) { values.set(name, value); },
    removeProperty(name) { values.delete(name); },
    getPropertyValue(name) { return values.get(name) || ''; },
  };
}

function makeClassList(initial = []) {
  const classes = new Set(initial);
  return {
    add(...names) { names.forEach((name) => classes.add(name)); },
    remove(...names) { names.forEach((name) => classes.delete(name)); },
    toggle(name, force) {
      const enabled = typeof force === 'boolean' ? force : !classes.has(name);
      if (enabled) classes.add(name);
      else classes.delete(name);
      return enabled;
    },
    contains(name) { return classes.has(name); },
    toArray() { return Array.from(classes); },
  };
}

function makeElement({ id = '', dataset = {}, classes = [], textContent = '' } = {}) {
  const listeners = {};
  const attrs = new Map();
  const children = new Map();
  return {
    id,
    dataset,
    listeners,
    style: makeStyle(),
    classList: makeClassList(classes),
    textContent,
    children,
    value: '1.0',
    addEventListener(type, cb) { listeners[type] = cb; },
    setAttribute(name, value) { attrs.set(name, String(value)); },
    getAttribute(name) { return attrs.get(name); },
    querySelector(selector) { return children.get(selector) || null; },
    querySelectorAll() { return []; },
    getBoundingClientRect: () => ({ top: 0, left: 0, width: 100, height: 100 }),
    clientHeight: 100,
  };
}

function makeScalarElements(className, prefix, count) {
  return Array.from({ length: count }, (_, idx) => {
    const el = makeElement({
      dataset: { name: `${prefix}-${idx + 1}` },
      classes: [className],
    });
    el.children.set('.mod-val-bar', makeElement());
    return el;
  });
}

function loadControls({ snapshots = null } = {}) {
  const engineFile = path.join(import.meta.dirname, 'mode-engine.js');
  const snapshotsFile = path.join(import.meta.dirname, 'modules/snapshots.js');
  const controlsFile = path.join(import.meta.dirname, 'controls.js');
  const engineSource = fs.readFileSync(engineFile, 'utf8');
  const snapshotsSource = fs.readFileSync(snapshotsFile, 'utf8');
  const controlsSource = fs.readFileSync(controlsFile, 'utf8');

  const pads = makeScalarElements('pad', 'pad', 12);
  const toggles = makeScalarElements('toggle', 'toggle', 4);
  const buttons = makeScalarElements('button', 'button', 4);

  const xy1 = makeElement({ dataset: { name: 'xy-1' }, classes: ['xy-pad'] });
  xy1.children.set('.xy-dot', makeElement());
  const xyReadout = makeElement({ dataset: { readout: 'xy-1' } });

  const captureButton = makeElement({ id: 'btn-perf-snapshot-capture' });
  const offButton = makeElement({ id: 'btn-perf-off' });
  const modeButtons = Array.from(['A', 'B', 'C', 'D'], (mode) => makeElement({ dataset: { padModeSet: mode } }));
  const perfSlots = Array.from({ length: 4 }, (_, idx) => makeElement({
    dataset: { perfSnapshotSlot: String(idx + 1) },
    classes: ['perf-snapshot-slot', 'empty'],
  }));
  const snpSlots = Array.from({ length: 8 }, (_, idx) => makeElement({
    dataset: { slot: String(idx + 1) },
    classes: ['snapshot-slot', 'empty'],
  }));

  for (const slot of [...perfSlots, ...snpSlots]) {
    slot.children.set('.status-indicator', makeElement({ textContent: 'Empty' }));
  }

  const idMap = new Map([
    ['btn-perf-snapshot-capture', captureButton],
    ['btn-perf-off', offButton],
  ]);
  const store = new Map();
  if (snapshots) {
    store.set('ableton-rc:snapshots', JSON.stringify(snapshots));
  }

  let rafCallback = null;
  let now = 0;
  const emitted = [];
  const modulatorStates = [];

  const context = {
    window: null,
    document: {
      body: { dataset: {}, classList: makeClassList() },
      getElementById: (id) => idMap.get(id) || null,
      querySelector(selector) {
        if (selector === '[data-readout="xy-1"]') return xyReadout;
        return null;
      },
      querySelectorAll(selector) {
        if (selector === '.pad') return pads;
        if (selector === '.toggle') return toggles;
        if (selector === '.button') return buttons;
        if (selector === '.xy-pad') return [xy1];
        if (selector === '.snapshot-slot') return snpSlots;
        if (selector === '.perf-snapshot-slot') return perfSlots;
        if (selector === '.tabs .tab') return [];
        if (selector === '.page') return [];
        if (selector === '[data-pad-mode-set]') return modeButtons;
        if (selector === '[data-morph-mode]') return [];
        return [];
      },
      addEventListener() {},
    },
    Date: { now: () => now },
    performance: { now: () => now },
    requestAnimationFrame(cb) { rafCallback = cb; return 1; },
    cancelAnimationFrame() { rafCallback = null; },
    addEventListener() {},
    dispatchEvent() {},
    Event: class { constructor(type) { this.type = type; } },
    CustomEvent: class { constructor(type, init) { this.type = type; this.detail = init?.detail; } },
    setTimeout() {},
    setInterval() {},
    clearInterval() {},
    localStorage: {
      getItem: (key) => store.get(key) || null,
      setItem: (key, value) => store.set(key, String(value)),
    },
    onControl(ctrl) {
      emitted.push(ctrl);
      if (ctrl.name) {
        if (ctrl.x !== undefined && ctrl.y !== undefined) {
          context.window.currentControlStates[`${ctrl.name}.x`] = ctrl.x;
          context.window.currentControlStates[`${ctrl.name}.y`] = ctrl.y;
        } else if (ctrl.value !== undefined) {
          context.window.currentControlStates[ctrl.name] = ctrl.value;
        }
      }
    },
    onModulatorState(state) {
      modulatorStates.push(state);
    },
  };
  context.window = context;
  context.currentControlStates = {};

  vm.runInNewContext(engineSource, context, { filename: engineFile });
  vm.runInNewContext(snapshotsSource, context, { filename: snapshotsFile });
  vm.runInNewContext(controlsSource, context, { filename: controlsFile });

  return {
    context,
    captureButton,
    offButton,
    modeButtons,
    perfSlots,
    emitted,
    modulatorStates,
    click(el) {
      if (el.listeners.click) el.listeners.click({ preventDefault() {} });
    },
    tick(at) {
      now = at;
      const cb = rafCallback;
      rafCallback = null;
      if (cb) cb(at);
    },
    storedSnapshots() {
      return JSON.parse(store.get('ableton-rc:snapshots') || '[]');
    },
  };
}

test('PERF capture stores slot 1 and recall applies it through control setters', () => {
  const app = loadControls();

  app.context.window.currentControlStates = { 'pad-1': 0.8, 'xy-1.x': 0.2, 'xy-1.y': 0.7 };
  app.click(app.captureButton);
  app.click(app.perfSlots[0]);
  const stored = app.storedSnapshots();
  assert.ok(stored[0], 'slot 1 should be saved');
  assert.equal(stored[0]['pad-1'], 0.8);
  assert.equal(app.perfSlots[0].classList.contains('empty'), false);

  app.context.window.currentControlStates = { 'pad-1': 0, 'xy-1.x': 0.5, 'xy-1.y': 0.5 };
  app.click(app.perfSlots[0]);
  app.tick(1000);

  assert.ok(app.emitted.some((event) => event.name === 'pad-1' && event.value === 0.8));
  assert.ok(app.emitted.some((event) => event.name === 'xy-1' && event.x === 0.2 && event.y === 0.7));
});

test('PERF OFF resets performance gestures without resetting mixer controls', () => {
  const app = loadControls();

  app.context.window.controlSetters['knob-1'] = (value) => app.emitted.push({ name: 'knob-1', value });
  app.click(app.offButton);

  assert.ok(app.emitted.some((event) => event.name === 'pad-1' && event.value === 0));
  assert.ok(app.modulatorStates.some((event) => event.name === 'toggle-1' && event.active === false));
  assert.ok(app.modulatorStates.some((event) => event.name === 'button-1' && event.active === false));
  assert.ok(app.emitted.some((event) => event.name === 'xy-1' && event.x === 0.5 && event.y === 0.5));
  assert.ok(app.emitted.some((event) => event.name === 'xy-2' && event.x === 0.5 && event.y === 0.5));
  assert.equal(app.emitted.some((event) => event.name === 'knob-1'), false);
});

test('old snapshot keys without setters are skipped during recall', () => {
  const oldKey = 'rib' + 'bon-1';
  const app = loadControls({
    snapshots: [{ [oldKey]: 0.9, 'pad-1': 0.4 }, null, null, null, null, null, null, null],
  });

  app.click(app.perfSlots[0]);
  app.tick(1000);

  assert.ok(app.emitted.some((event) => event.name === 'pad-1' && event.value === 0.4));
  assert.equal(app.emitted.some((event) => event.name === oldKey), false);
});

test('PERF capture and recall correctly stores LFO/stutter active state and rate/depth parameters', () => {
  const app = loadControls();

  // Configure LFO 1 active, rate=0.85, depth=0.65
  app.context.window.controlSetters['toggle-1'](1.0);
  app.context.window.controlSetters['toggle-1.rate'](0.85);
  app.context.window.controlSetters['toggle-1.depth'](0.65);

  // Configure Stutter 1 active, rate=0.45, count=0.75
  app.context.window.controlSetters['button-1'](1.0);
  app.context.window.controlSetters['button-1.rate'](0.45);
  app.context.window.controlSetters['button-1.count'](0.75);

  // Capture Snapshot on Slot 1
  app.click(app.captureButton);
  app.click(app.perfSlots[0]);

  const stored = app.storedSnapshots();
  assert.ok(stored[0], 'slot 1 should be saved');

  // Verify binary active state is captured instead of the instantaneous oscillating value
  assert.equal(stored[0]['toggle-1'], 1.0);
  assert.equal(stored[0]['toggle-1.rate'], 0.85);
  assert.equal(stored[0]['toggle-1.depth'], 0.65);

  assert.equal(stored[0]['button-1'], 1.0);
  assert.equal(stored[0]['button-1.rate'], 0.45);
  assert.equal(stored[0]['button-1.count'], 0.75);

  // Deactivate them
  app.context.window.controlSetters['toggle-1'](0.0);
  app.context.window.controlSetters['button-1'](0.0);

  // Recall slot 1
  app.click(app.perfSlots[0]);
  app.tick(1000);

  // Verify they are restored and reactivated through host-side modulator state.
  const toggleState = app.modulatorStates.findLast(e => e.name === 'toggle-1');
  const buttonState = app.modulatorStates.findLast(e => e.name === 'button-1');

  // Since we morph from 0.0 to 1.0, they should activate (cross 0.5)
  assert.equal(toggleState.active, true);
  assert.equal(toggleState.rate, 0.85);
  assert.equal(toggleState.depth, 0.65);
  assert.equal(buttonState.active, true);
  assert.equal(buttonState.rate, 0.45);
  assert.equal(buttonState.count, 0.75);

  // Verify rate and depth morphed/restored values
  assert.equal(app.context.window.currentControlStates['toggle-1.rate'], 0.85);
  assert.equal(app.context.window.currentControlStates['toggle-1.depth'], 0.65);
  assert.equal(app.context.window.currentControlStates['button-1.rate'], 0.45);
  assert.equal(app.context.window.currentControlStates['button-1.count'], 0.75);
});

test('PERF recall sends an active LFO morph target before local visual tween', () => {
  const app = loadControls({
    snapshots: [
      { 'toggle-1': 1, 'toggle-1.rate': 0.9, 'toggle-1.depth': 0.7 },
      null, null, null, null, null, null, null,
    ],
  });

  app.context.window.controlSetters['toggle-1'](0);
  app.context.window.controlSetters['toggle-1.rate'](0.1);
  app.context.window.controlSetters['toggle-1.depth'](0.2);
  app.context.window.currentControlStates['toggle-1'] = 0;
  app.modulatorStates.length = 0;

  app.click(app.perfSlots[0]);

  const lfoState = app.modulatorStates.findLast(e => e.name === 'toggle-1');
  assert.equal(lfoState.active, true);
  assert.equal(lfoState.rate, 0.9);
  assert.equal(lfoState.depth, 0.7);
  assert.equal(lfoState.morphMs, 1000);
});

test('PERF recall suppresses per-frame LFO host state while local visual tween runs', () => {
  const app = loadControls({
    snapshots: [
      { 'toggle-1': 1, 'toggle-1.rate': 0.9, 'toggle-1.depth': 0.7 },
      null, null, null, null, null, null, null,
    ],
  });

  app.context.window.controlSetters['toggle-1'](0);
  app.context.window.controlSetters['toggle-1.rate'](0.1);
  app.context.window.controlSetters['toggle-1.depth'](0.2);
  app.context.window.currentControlStates['toggle-1'] = 0;
  app.modulatorStates.length = 0;

  app.click(app.perfSlots[0]);
  app.tick(100);

  const lfoStates = app.modulatorStates.filter(e => e.name === 'toggle-1');
  assert.equal(lfoStates.length, 1);
  assert.equal(lfoStates[0].active, true);
  assert.equal(lfoStates[0].rate, 0.9);
  assert.equal(lfoStates[0].depth, 0.7);
  assert.equal(lfoStates[0].morphMs, 1000);
});

test('PERF recall sends one host-side LFO morph target and suppresses frame spam', () => {
  const app = loadControls({
    snapshots: [
      { 'toggle-1': 1, 'toggle-1.rate': 0.9, 'toggle-1.depth': 0.7 },
      null, null, null, null, null, null, null,
    ],
  });

  app.context.window.controlSetters['toggle-1'](0);
  app.context.window.controlSetters['toggle-1.rate'](0.1);
  app.context.window.controlSetters['toggle-1.depth'](0.2);
  app.context.window.currentControlStates['toggle-1'] = 0;
  app.modulatorStates.length = 0;

  app.click(app.perfSlots[0]);

  const initialStates = app.modulatorStates.filter(e => e.name === 'toggle-1');
  assert.equal(initialStates.length, 1);
  assert.equal(initialStates[0].active, true);
  assert.equal(initialStates[0].rate, 0.9);
  assert.equal(initialStates[0].depth, 0.7);
  assert.equal(initialStates[0].morphMs, 1000);

  app.tick(100);
  app.tick(500);

  assert.equal(app.modulatorStates.filter(e => e.name === 'toggle-1').length, 1);
});

test('PERF recall keeps host LFO active until inactive morph completes', () => {
  const app = loadControls({
    snapshots: [
      { 'toggle-1': 0, 'toggle-1.rate': 0.2, 'toggle-1.depth': 0.1 },
      null, null, null, null, null, null, null,
    ],
  });

  app.context.window.controlSetters['toggle-1'](1);
  app.context.window.controlSetters['toggle-1.rate'](0.8);
  app.context.window.controlSetters['toggle-1.depth'](0.6);
  app.context.window.currentControlStates['toggle-1'] = 1;
  app.modulatorStates.length = 0;

  app.click(app.perfSlots[0]);
  app.tick(600);

  let lfoState = app.modulatorStates.findLast(e => e.name === 'toggle-1');
  assert.equal(lfoState.active, false);
  assert.equal(lfoState.morphMs, 1000);
  assert.equal(app.context.window.currentControlStates['toggle-1'], 1);
  assert.equal(app.modulatorStates.filter(e => e.name === 'toggle-1').length, 1);

  app.tick(1000);

  lfoState = app.modulatorStates.findLast(e => e.name === 'toggle-1');
  assert.equal(lfoState.active, false);
  assert.equal(app.context.window.currentControlStates['toggle-1'], 0);
  assert.equal(app.modulatorStates.filter(e => e.name === 'toggle-1').length, 1);
});

test('PERF Mode D snapshot recall triggers burst decays for pads/LFOs/stutters', () => {
  const app = loadControls();

  // Set padMode to D by clicking the mode button
  const modeD = app.modeButtons.find((btn) => btn.dataset.padModeSet === 'D');
  app.click(modeD);

  // Recall LFO-1, Stutter-1, Pad-1 as active
  app.context.window.controlSetters['toggle-1'](1.0);
  app.context.window.controlSetters['button-1'](1.0);
  app.context.window.controlSetters['pad-1'](0.8);

  // Execute initial physics frame (now = 100ms)
  app.tick(100);

  // Execute subsequent frame beyond burst limits (now = 1300ms, elapsed 1200ms)
  app.tick(1300);

  // Assert they auto-deactivated and sent value 0.0 to Ableton
  assert.ok(app.emitted.some(e => e.name === 'pad-1' && e.value === 0));
  assert.ok(app.modulatorStates.some(e => e.name === 'toggle-1' && e.active === false));
  assert.ok(app.modulatorStates.some(e => e.name === 'button-1' && e.active === false));
});
