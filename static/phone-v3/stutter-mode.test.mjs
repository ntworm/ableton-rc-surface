import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';

function makeElement(dataset = {}) {
  const listeners = {};
  const classes = new Set();
  return {
    dataset,
    listeners,
    style: {
      values: new Map(),
      setProperty(name, value) { this.values.set(name, value); },
      removeProperty(name) { this.values.delete(name); },
      getPropertyValue(name) { return this.values.get(name) || ''; },
      get backgroundColor() { return this.values.get('backgroundColor') || ''; },
      set backgroundColor(value) { this.values.set('backgroundColor', value); },
    },
    classList: {
      add(...names) { names.forEach((name) => classes.add(name)); },
      remove(...names) { names.forEach((name) => classes.delete(name)); },
      toggle(name, force) {
        const enabled = typeof force === 'boolean' ? force : !classes.has(name);
        if (enabled) classes.add(name);
        else classes.delete(name);
        return enabled;
      },
      contains(name) { return classes.has(name); },
    },
    addEventListener(type, cb) { listeners[type] = cb; },
    setAttribute() {},
    querySelector() { return null; },
    getBoundingClientRect: () => ({ top: 0, left: 0, width: 100, height: 100 }),
    clientHeight: 100,
  };
}

function loadControls() {
  const engineFile = path.join(import.meta.dirname, 'mode-engine.js');
  const controlsFile = path.join(import.meta.dirname, 'controls.js');
  const engineSource = fs.readFileSync(engineFile, 'utf8');
  const controlsSource = fs.readFileSync(controlsFile, 'utf8');

  const stutter = makeElement({ name: 'stutter-1' });
  const lfo = makeElement({ name: 'toggle-1' });
  const modeButtons = ['A', 'B', 'C', 'D'].map((mode) => makeElement({ padModeSet: mode }));
  let rafCallback = null;
  let now = 0;
  const emitted = [];
  const modulatorStates = [];

  const context = {
    window: null,
    document: {
      body: { dataset: {} },
      getElementById: () => null,
      querySelector(selector) {
        if (selector === '.button[data-name="stutter-1"]') return stutter;
        if (selector === '.toggle[data-name="toggle-1"]') return lfo;
        return null;
      },
      querySelectorAll(selector) {
        if (selector === '[data-pad-mode-set]') return modeButtons;
        if (selector === '.toggle') return [lfo];
        if (selector === '.button') return [stutter];
        return [];
      },
      addEventListener() {},
    },
    navigator: { vibrate: () => {} },
    performance: { now: () => now },
    requestAnimationFrame(cb) { rafCallback = cb; },
    addEventListener() {},
    dispatchEvent() {},
    Event: class { constructor(type) { this.type = type; } },
    CustomEvent: class { constructor(type, init) { this.type = type; this.detail = init?.detail; } },
    setTimeout() {},
    setInterval() {},
    localStorage: { getItem: () => null, setItem: () => {} },
    onControl(ctrl) { emitted.push(ctrl); },
    onModulatorState(state) { modulatorStates.push(state); },
  };
  context.window = context;

  vm.runInNewContext(engineSource, context, { filename: engineFile });
  vm.runInNewContext(controlsSource, context, { filename: controlsFile });

  return {
    context,
    stutter,
    lfo,
    modeButtons,
    emitted,
    modulatorStates,
    tick(at) {
      now = at;
      rafCallback();
    },
  };
}

function touch(identifier, clientY) {
  return { identifier, clientX: 50, clientY };
}

test('stutter mode B auto-deactivates when rate is dragged to zero', () => {
  // Q2 redesign: mode B cancela o hold quando Y (rate) chega no minimo,
  // arrastando vertical pra baixo. Eixo X (count) nao desativa.
  const app = loadControls();
  const modeB = app.modeButtons.find((btn) => btn.dataset.padModeSet === 'B');
  modeB.listeners.click();

  app.stutter.listeners.touchstart({
    preventDefault() {},
    changedTouches: [touch(1, 100)],
  });
  app.stutter.listeners.touchmove({
    preventDefault() {},
    touches: [touch(1, 200)],  // drag para baixo: dy=-100, rate=0
  });
  app.stutter.listeners.touchend({
    preventDefault() {},
    changedTouches: [touch(1, 200)],
  });

  app.tick(1000);

  assert.equal(app.stutter.classList.contains('pressed'), false);
  const last = app.modulatorStates.at(-1);
  assert.equal(last.name, 'stutter-1');
  assert.equal(last.active, false);
});

test('stutter visual state follows the active performance mode while pulsing the full interior', () => {
  const app = loadControls();
  const modeC = app.modeButtons.find((btn) => btn.dataset.padModeSet === 'C');
  modeC.listeners.click();

  app.stutter.listeners.touchstart({
    preventDefault() {},
    changedTouches: [touch(1, 100)],
  });

  assert.equal(app.stutter.classList.contains('mode-c'), true);

  app.tick(1000);

  assert.match(app.stutter.style.backgroundColor, /^rgba\(255,\s*159,\s*10,/);
  assert.equal(app.stutter.style.getPropertyValue('--stut-glow-size'), '12px');
});

test('stutter keeps emitting while hidden but skips visual writes until Performance returns', () => {
  const app = loadControls();
  const modeB = app.modeButtons.find((btn) => btn.dataset.padModeSet === 'B');
  modeB.listeners.click();

  app.stutter.listeners.touchstart({
    preventDefault() {},
    changedTouches: [touch(1, 100)],
  });

  app.context.document.body.dataset.page = 'media';
  app.tick(1000);

  assert.equal(app.stutter.style.backgroundColor, '');
  assert.equal(app.modulatorStates.at(-1).name, 'stutter-1');

  app.context.document.body.dataset.page = 'performance';
  app.tick(1016);

  assert.match(app.stutter.style.backgroundColor, /^rgba\(255,\s*159,\s*10,/);
});

test('stutter high sync rates emit the capped visual pulse rate to avoid aliasing', () => {
  const app = loadControls();
  const modeB = app.modeButtons.find((btn) => btn.dataset.padModeSet === 'B');
  modeB.listeners.click();

  app.stutter.listeners.touchstart({
    preventDefault() {},
    changedTouches: [touch(1, 100)],
  });
  app.context.controlSetters['stutter-1.rate'](1);
  app.context.controlSetters['stutter-1.count'](1);

  app.tick(1002);

  const stutterEvents = app.emitted.filter((event) => event.name === 'stutter-1');
  assert.equal(stutterEvents.length, 0);
  assert.equal(app.modulatorStates.at(-1).name, 'stutter-1');
  assert.equal(app.modulatorStates.at(-1).kind, 'stutter');
  assert.equal(app.modulatorStates.at(-1).active, true);
});

test('LFO sync rates are capped to the stable free-mode maximum', () => {
  const app = loadControls();
  const modeB = app.modeButtons.find((btn) => btn.dataset.padModeSet === 'B');
  modeB.listeners.click();

  app.lfo.listeners.touchstart({
    preventDefault() {},
    changedTouches: [touch(1, 100)],
  });
  app.context.controlSetters['toggle-1.rate'](1);
  app.context.controlSetters['toggle-1.depth'](1);

  app.tick(1007);

  const lfoEvents = app.emitted.filter((event) => event.name === 'toggle-1');
  assert.equal(lfoEvents.length, 0);
  assert.equal(app.modulatorStates.at(-1).name, 'toggle-1');
  assert.equal(app.modulatorStates.at(-1).kind, 'lfo');
  assert.equal(app.modulatorStates.at(-1).active, true);
});

test('LFO sync payload uses per-control rate unless subdivision is pinned', () => {
  const app = loadControls();
  const modeB = app.modeButtons.find((btn) => btn.dataset.padModeSet === 'B');
  modeB.listeners.click();

  app.lfo.listeners.touchstart({
    preventDefault() {},
    changedTouches: [touch(1, 100)],
  });

  let lfoState = app.modulatorStates.findLast((event) => event.name === 'toggle-1');
  assert.equal(lfoState.syncMode, 'sync');
  assert.equal(lfoState.syncSubdivisionBeats, undefined);

  app.lfo.listeners.touchend({
    preventDefault() {},
    changedTouches: [touch(1, 100)],
  });
  app.modulatorStates.length = 0;
  app.context.syncSettings.lfoSubdivisionPinned = true;
  app.context.syncSettings.lfoSubdivision = 0.25;
  app.context.controlSetters['toggle-1'](0);

  app.lfo.listeners.touchstart({
    preventDefault() {},
    changedTouches: [touch(2, 100)],
  });

  lfoState = app.modulatorStates.findLast((event) => event.name === 'toggle-1');
  assert.equal(lfoState.syncSubdivisionBeats, 0.25);
});
