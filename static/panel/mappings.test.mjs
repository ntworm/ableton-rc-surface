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

class FakeClassList {
  constructor(owner, initial = '') {
    this.owner = owner;
    this.values = new Set(initial.split(/\s+/).filter(Boolean));
  }
  sync() {
    this.owner._className = [...this.values].join(' ');
  }
  add(name) {
    this.values.add(name);
    this.sync();
  }
  remove(name) {
    this.values.delete(name);
    this.sync();
  }
  contains(name) {
    return this.values.has(name);
  }
  toggle(name, force) {
    const next = force === undefined ? !this.values.has(name) : Boolean(force);
    if (next) this.values.add(name);
    else this.values.delete(name);
    this.sync();
    return next;
  }
}

class FakeElement {
  constructor(document, tagName = 'div', id = '') {
    this.document = document;
    this.tagName = tagName.toUpperCase();
    this.children = [];
    this.parentNode = null;
    this.dataset = {};
    this.style = {};
    this.attributes = new Map();
    this.listeners = new Map();
    this.textContent = '';
    this.value = '';
    this._innerHTML = '';
    this._className = '';
    this.classList = new FakeClassList(this);
    this.onclick = null;
    this.onchange = null;
    this.oninput = null;
    this.onmousedown = null;
    if (id) this.id = id;
  }
  set id(value) {
    this._id = value;
    if (value) this.document.register(this);
  }
  get id() {
    return this._id || '';
  }
  set className(value) {
    this._className = value;
    this.classList = new FakeClassList(this, value);
  }
  get className() {
    return this._className;
  }
  set innerHTML(value) {
    this._innerHTML = value;
    this.children = [];
  }
  get innerHTML() {
    return this._innerHTML;
  }
  get value() {
    // For <select> elements, mirror the real DOM: value defaults to the
    // first option unless an option is marked selected.
    if (this.tagName === 'SELECT') {
      const sel = this.children.find((c) => c && c.selected);
      if (sel) return sel.value;
      return this.children.length > 0 ? this.children[0].value : '';
    }
    return this._value;
  }
  set value(v) {
    this._value = v;
  }
  appendChild(child) {
    child.parentNode = this;
    this.children.push(child);
    if (child.id) this.document.register(child);
    return child;
  }
  setAttribute(name, value) {
    this.attributes.set(name, value);
    if (name === 'id') this.id = value;
  }
  getAttribute(name) {
    return this.attributes.get(name);
  }
  addEventListener(name, fn) {
    this.listeners.set(name, fn);
  }
  focus() {
    // Stub: tests don't actually need focus semantics.
  }
  removeEventListener(name, fn) {
    if (!fn) this.listeners.clear();
    else this.listeners.delete(name);
  }
  querySelector(selector) {
    return this.querySelectorAll(selector)[0] || null;
  }
  querySelectorAll(selector) {
    return this.document.queryWithin(this, selector);
  }
}

class FakeDocument {
  constructor(ids = []) {
    this.elements = new Map();
    this.body = new FakeElement(this, 'body', 'body');
    this.documentElement = new FakeElement(this, 'html', 'html');
    for (const id of ids) {
      this.register(new FakeElement(this, 'div', id));
    }
  }
  register(el) {
    if (!el.id) return;
    this.elements.set(el.id, el);
  }
  getElementById(id) {
    return this.elements.get(id) || null;
  }
  createElement(tagName) {
    return new FakeElement(this, tagName);
  }
  addEventListener() {}
  removeEventListener() {}
  querySelector() {
    return null;
  }
  querySelectorAll(selector) {
    return this.queryWithin(null, selector);
  }
  queryWithin(root, selector) {
    const start = root ? [root] : [this.body, ...this.elements.values()];
    const seen = new Set();
    const out = [];
    const visit = (el) => {
      if (!el || seen.has(el)) return;
      seen.add(el);
      if (matchesSelector(el, selector)) out.push(el);
      el.children.forEach(visit);
    };
    start.forEach(visit);
    return out;
  }
}

function matchesSelector(el, selector) {
  if (selector === '[data-url]') return Object.prototype.hasOwnProperty.call(el.dataset, 'url');
  // Composite selector: tag.class (only the simple form we actually use in
  // these tests, e.g. `select.target-curve`). Real CSS combinators aren't
  // supported because we only need enough to assert structure.
  const tagClass = selector.match(/^([a-zA-Z]+)\.([a-zA-Z0-9_-]+)$/);
  if (tagClass) {
    const [, tag, cls] = tagClass;
    return el.tagName === tag.toUpperCase() && el.classList.contains(cls);
  }
  if (selector.startsWith('.')) return el.classList.contains(selector.slice(1));
  if (selector.startsWith('#')) return el.id === selector.slice(1);
  return false;
}

const PANEL_DOM_IDS = [
  'ctrl-groups',
  'sensor-grid',
  'footer-dot',
  'footer-status',
  'btn-start',
  'btn-stop',
  'iface-primary-ip',
  'iface-primary-url',
  'iface-list',
  'mode-proto',
  'mode-port',
  'mode-cert',
  'vu-fill',
  'qr-perf',
  'url-perf',
  'qr-row',
  'qr-placeholder',
  'open-perf',
  'copy-primary',
  'link-admin',
  // Mappings tab DOM
  'map-search',
  'map-clear-category',
  'btn-clear',
  'map-list',
  'map-empty',
  'map-detail',
  'map-detail-name',
  'map-detail-val',
  'map-detail-spark',
  'map-detail-targets',
  'btn-bind',
  'range-bar',
  'range-fill',
  'range-min',
  'range-max',
  'range-min-label',
  'range-max-label',
  'map-detail-graph',
  // Inline picker inside the detail panel (replaces bind-modal)
  'map-picker',
  'map-picker-search',
  'map-picker-list',
  'map-picker-cancel',
  // Conflict warning shown inline in the detail panel (replaces bind-conflict)
  'map-conflict-banner',
  'map-conflict-msg',
  'map-conflict-replace',
  'map-conflict-cancel',
];

function loadMappingsModule(extraOptions = {}) {
  const staticRoot = path.resolve(import.meta.dirname, '..');
  const document = new FakeDocument(PANEL_DOM_IDS);
  const context = {
    console,
    document,
    navigator: {},
    localStorage: extraOptions.localStorage || {
      getItem() { return null; },
      setItem() {},
    },
    window: {
      document,
      navigator: {},
      localStorage: {},
      addEventListener() {},
      location: { port: '' },
    },
    liveControls: new Map(),
    selectedControl: null,
    currentMappings: {},
    allControlsGrouped: {
      PADS: ['pad-1', 'pad-2', 'pad-3'],
      KNOBS: ['knob-1', 'knob-2'],
      FADERS: ['fader-1'],
    },
    allTargetsRaw: [],
    sensorHistory: {},
    setInterval() { return 1; },
    setTimeout(fn) {
      if (typeof fn === 'function') fn();
      return 1;
    },
    clearTimeout() {},
    // sendWS is captured per test
    sendWS: extraOptions.sendWS || (() => {}),
    fetchMappings: extraOptions.fetchMappings || (() => {}),
    QRCode: function QRCode() {},
    renderMappingsTab: () => {},
    discoveryActive: false,
    selectedClient: null,
    getControlDisplayName: (s) => s,
    // Will be populated by mappings.js init
  };
  context.window.navigator = context.navigator;
  context.window.localStorage = context.localStorage;
  context.window.liveControls = context.liveControls;
  context.window.selectedControl = context.selectedControl;
  context.window.currentMappings = context.currentMappings;
  context.window.allControlsGrouped = context.allControlsGrouped;
  context.window.allTargetsRaw = context.allTargetsRaw;
  context.window.sensorHistory = context.sensorHistory;
  context.window.selectedClient = context.selectedClient;
  context.window.sendWS = context.sendWS;
  context.window.fetchMappings = context.fetchMappings;
  context.window.discoveryActive = false;
  context.window.getControlDisplayName = context.getControlDisplayName;
  context.QRCode.CorrectLevel = { L: 1 };
  context.window.QRCode = context.QRCode;

  vm.createContext(context);

  const mappingsSrc = fs.readFileSync(path.join(staticRoot, 'panel', 'mappings.js'), 'utf8');
  vm.runInContext(mappingsSrc, context, { filename: 'panel/mappings.js' });

  return { context, document };
}

// ───────────────────────────────────────────────────────────────────────────
// Pure helpers
// ───────────────────────────────────────────────────────────────────────────

test('isSameTarget returns true only when type and every index match', () => {
  const { context } = loadMappingsModule();
  const a = { type: 'mixer_volume', trackIndex: 1 };
  const b = { type: 'mixer_volume', trackIndex: 1 };
  const c = { type: 'mixer_volume', trackIndex: 2 };
  const d = { type: 'mixer_pan', trackIndex: 1 };
  assert.equal(context.window.isSameTarget(a, b), true);
  assert.equal(context.window.isSameTarget(a, c), false);
  assert.equal(context.window.isSameTarget(a, d), false);
});

test('isSameTarget treats missing indices as 0 (consistent with server getTargetKey)', () => {
  const { context } = loadMappingsModule();
  const a = { type: 'tempo' };
  const b = { type: 'tempo' };
  assert.equal(context.window.isSameTarget(a, b), true);
});

test('findMappingConflict returns null when no other control binds the same target', () => {
  const { context } = loadMappingsModule();
  const mappings = {
    'pad-1': [{ type: 'mixer_volume', trackIndex: 0 }],
    'knob-1': [{ type: 'mixer_volume', trackIndex: 1 }],
  };
  const t = { type: 'mixer_volume', trackIndex: 2 };
  assert.equal(context.window.findMappingConflict(t, 'pad-2', mappings), null);
});

test('findMappingConflict returns the binding control name when another control already targets it', () => {
  const { context } = loadMappingsModule();
  const mappings = {
    'pad-1': [{ type: 'mixer_volume', trackIndex: 0 }],
    'knob-1': [{ type: 'mixer_volume', trackIndex: 1 }],
  };
  const t = { type: 'mixer_volume', trackIndex: 1 };
  assert.equal(context.window.findMappingConflict(t, 'pad-2', mappings), 'knob-1');
});

test('findMappingConflict ignores the currently selected control (self-bind is not a conflict)', () => {
  const { context } = loadMappingsModule();
  const mappings = {
    'pad-1': [{ type: 'mixer_volume', trackIndex: 0 }],
  };
  const t = { type: 'mixer_volume', trackIndex: 0 };
  assert.equal(context.window.findMappingConflict(t, 'pad-1', mappings), null);
});

test('findMappingConflict matches full device_param signature including device/param/send indices', () => {
  const { context } = loadMappingsModule();
  const mappings = {
    'fader-1': [{ type: 'device_param', trackIndex: 0, deviceIndex: 1, paramIndex: 4 }],
  };
  const tSame = { type: 'device_param', trackIndex: 0, deviceIndex: 1, paramIndex: 4 };
  const tOtherParam = { type: 'device_param', trackIndex: 0, deviceIndex: 1, paramIndex: 5 };
  assert.equal(context.window.findMappingConflict(tSame, 'pad-1', mappings), 'fader-1');
  assert.equal(context.window.findMappingConflict(tOtherParam, 'pad-1', mappings), null);
});

// ───────────────────────────────────────────────────────────────────────────
// Detail rendering
// ───────────────────────────────────────────────────────────────────────────

function collectText(el) {
  let out = el.textContent || '';
  for (const c of el.children || []) {
    out += ' ' + collectText(c);
  }
  return out;
}

test('renderMappingDetail shows "No targets bound" placeholder when control has no targets', () => {
  const { context, document } = loadMappingsModule();
  context.window.selectedControl = 'pad-1';
  context.window.currentMappings = {};

  context.window.renderMappingDetail();

  const targets = document.getElementById('map-detail-targets');
  assert.match(collectText(targets), /No targets bound/);
});

test('renderMappingDetail renders a chip per existing target plus a curve select', () => {
  const { context, document } = loadMappingsModule();
  context.window.selectedControl = 'pad-1';
  context.window.currentMappings = {
    'pad-1': [
      { type: 'mixer_volume', trackIndex: 0, label: 'Track 1 Vol', curve: 'linear' },
      { type: 'device_param', trackIndex: 0, deviceIndex: 0, paramIndex: 2, label: 'Cutoff', curve: 'exponential' },
    ],
  };

  context.window.renderMappingDetail();

  const targets = document.getElementById('map-detail-targets');
  const chips = targets.querySelectorAll('.bound-chip');
  assert.ok(chips.length >= 2, `expected >=2 chips, got ${chips.length}`);
  const curves = targets.querySelectorAll('select.target-curve');
  assert.equal(curves.length, 2);
  assert.equal(curves[0].value, 'linear');
  assert.equal(curves[1].value, 'exponential');
});

// ───────────────────────────────────────────────────────────────────────────
// removeBoundTarget — preserve other targets
// ───────────────────────────────────────────────────────────────────────────

test('removeBoundTarget removes only the targeted target and saves the remaining set', () => {
  const { context } = loadMappingsModule();
  const calls = [];
  context.window.selectedControl = 'pad-1';
  context.window.currentMappings = {
    'pad-1': [
      { type: 'mixer_volume', trackIndex: 0, label: 'Vol' },
      { type: 'mixer_pan', trackIndex: 0, label: 'Pan' },
      { type: 'device_param', trackIndex: 0, deviceIndex: 0, paramIndex: 0, label: 'Cutoff' },
    ],
  };
  context.window.sendWS = (cmd, args, cb) => {
    calls.push({ cmd, args });
    if (cb) cb({ ok: true, result: {} });
  };

  context.window.removeBoundTarget(1);

  assert.equal(context.window.currentMappings['pad-1'].length, 2);
  assert.equal(context.window.currentMappings['pad-1'][0].type, 'mixer_volume');
  assert.equal(context.window.currentMappings['pad-1'][1].type, 'device_param');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].cmd, 'setMapping');
  assert.equal(calls[0].args.control, 'pad-1');
  assert.equal(calls[0].args.targets.length, 2);
});

test('removeBoundTarget on the last remaining target sends removeMapping (not an empty setMapping)', () => {
  const { context } = loadMappingsModule();
  const calls = [];
  context.window.selectedControl = 'pad-1';
  context.window.currentMappings = {
    'pad-1': [{ type: 'mixer_volume', trackIndex: 0, label: 'Vol' }],
  };
  context.window.sendWS = (cmd, args, cb) => {
    calls.push({ cmd, args });
    if (cb) cb({ ok: true, result: {} });
  };

  context.window.removeBoundTarget(0);

  assert.equal(calls.length, 1);
  assert.equal(calls[0].cmd, 'removeMapping');
  assert.equal(calls[0].args.control, 'pad-1');
});

// ───────────────────────────────────────────────────────────────────────────
// bind-confirm: no alert; preserves existing targets on push
// ───────────────────────────────────────────────────────────────────────────

test('commitBind appends a new target to the existing set with default curve/range', () => {
  const { context } = loadMappingsModule();
  context.window.selectedControl = 'pad-1';
  context.window.currentMappings = {
    'pad-1': [{ type: 'mixer_volume', trackIndex: 0, label: 'Vol', curve: 'linear' }],
  };
  const calls = [];
  context.window.sendWS = (cmd, args, cb) => {
    calls.push({ cmd, args });
    if (cb) cb({ ok: true, result: {} });
  };

  const t = { type: 'mixer_pan', trackIndex: 0, label: 'Pan' };
  context.window.commitBind(t);

  // Should send exactly one setMapping carrying BOTH the existing volume and
  // the freshly committed pan (defaults applied: linear, full range, smooth=0).
  assert.equal(calls.length, 1);
  assert.equal(calls[0].cmd, 'setMapping');
  assert.equal(calls[0].args.targets.length, 2);
  assert.equal(calls[0].args.targets[0].type, 'mixer_volume');
  assert.equal(calls[0].args.targets[1].type, 'mixer_pan');
  assert.equal(calls[0].args.targets[1].curve, 'linear');
  assert.equal(calls[0].args.targets[1].inMin, 0);
  assert.equal(calls[0].args.targets[1].inMax, 1);
  assert.equal(calls[0].args.targets[1].outMin, 0);
  assert.equal(calls[0].args.targets[1].outMax, 1);
  assert.equal(calls[0].args.targets[1].smooth, 0);
});

test('commitBind on a target already bound to the same control is a no-op (idempotent)', () => {
  const { context } = loadMappingsModule();
  context.window.selectedControl = 'pad-1';
  context.window.currentMappings = {
    'pad-1': [{ type: 'mixer_volume', trackIndex: 0, label: 'Vol' }],
  };
  const calls = [];
  context.window.sendWS = (cmd, args, cb) => {
    calls.push({ cmd, args });
    if (cb) cb({ ok: true, result: {} });
  };

  const t = { type: 'mixer_volume', trackIndex: 0, label: 'Vol' };
  context.window.commitBind(t);

  assert.equal(calls.length, 0,
    'expected no WS call when re-binding the same target to the same control');
  assert.equal(context.window.currentMappings['pad-1'].length, 1,
    'local state must not double-bind to the same target');
});

test('commitBind on a target owned by a different control surfaces an inline banner in the detail panel', () => {
  const { context, document } = loadMappingsModule();
  let alertCalled = false;
  context.alert = () => { alertCalled = true; };

  context.window.selectedControl = 'pad-1';
  context.window.currentMappings = {
    'pad-1': [{ type: 'mixer_volume', trackIndex: 0, label: 'Vol' }],
    'knob-1': [{ type: 'mixer_pan', trackIndex: 0, label: 'Pan' }],
  };
  const calls = [];
  context.window.sendWS = (cmd, args, cb) => {
    calls.push({ cmd, args });
    if (cb) cb({ ok: true, result: {} });
  };

  const t = { type: 'mixer_pan', trackIndex: 0, label: 'Pan' };
  context.window.commitBind(t);

  assert.equal(alertCalled, false, 'must not use alert() for conflict warnings');

  const banner = document.getElementById('map-conflict-banner');
  assert.ok(banner, 'expected #map-conflict-banner to exist in the detail panel');
  assert.equal(banner.classList.contains('hidden'), false);

  const msg = document.getElementById('map-conflict-msg');
  assert.ok(msg, 'expected #map-conflict-msg to exist');
  assert.match(msg.textContent, /knob-1/i);

  // No setMapping must be sent until the user clicks Replace
  assert.equal(calls.length, 0, 'must not commit while a conflict is pending');
});

test('clicking Replace in the conflict banner removes from the other control and applies to the current one', () => {
  const { context, document } = loadMappingsModule();
  context.window.selectedControl = 'pad-1';
  context.window.currentMappings = {
    'pad-1': [],
    'knob-1': [{ type: 'mixer_pan', trackIndex: 0, label: 'Pan' }],
  };
  const calls = [];
  context.window.sendWS = (cmd, args, cb) => {
    calls.push({ cmd, args });
    if (cb) cb({ ok: true, result: {} });
  };

  const t = { type: 'mixer_pan', trackIndex: 0, label: 'Pan' };
  context.window.commitBind(t);

  const replaceBtn = document.getElementById('map-conflict-replace');
  assert.ok(replaceBtn, 'expected #map-conflict-replace button');
  assert.equal(typeof replaceBtn.onclick, 'function');

  replaceBtn.onclick();

  const cmds = calls.map((c) => c.cmd);
  assert.ok(cmds.includes('removeMapping'), `expected removeMapping; got ${cmds.join(',')}`);
  assert.ok(cmds.includes('setMapping'), `expected setMapping; got ${cmds.join(',')}`);
  const remove = calls.find((c) => c.cmd === 'removeMapping');
  const set = calls.find((c) => c.cmd === 'setMapping');
  assert.equal(remove.args.control, 'knob-1');
  assert.equal(set.args.control, 'pad-1');
  assert.equal(set.args.targets.length, 1);
  assert.equal(set.args.targets[0].type, 'mixer_pan');
});

test('Replace flow sequences removeMapping before setMapping (no race window)', () => {
  const { context, document } = loadMappingsModule();
  context.window.selectedControl = 'pad-1';
  context.window.currentMappings = {
    'pad-1': [],
    'knob-1': [{ type: 'mixer_pan', trackIndex: 0, label: 'Pan' }],
  };
  const calls = [];
  context.window.sendWS = (cmd, args, cb) => {
    calls.push({ cmd, args });
    if (cb) cb({ ok: true, result: {} });
  };

  const t = { type: 'mixer_pan', trackIndex: 0, label: 'Pan' };
  context.window.commitBind(t);
  context.document.getElementById('map-conflict-replace').onclick();

  const removeIdx = calls.findIndex((c) => c.cmd === 'removeMapping');
  const setIdx = calls.findIndex((c) => c.cmd === 'setMapping');
  assert.notEqual(removeIdx, -1, 'removeMapping was not sent');
  assert.notEqual(setIdx, -1, 'setMapping was not sent');
  assert.ok(removeIdx < setIdx,
    `removeMapping (${removeIdx}) must come before setMapping (${setIdx})`);
});

test('Replace flow when the other control only had this target removes it entirely (no empty setMapping)', () => {
  const { context, document } = loadMappingsModule();
  context.window.selectedControl = 'pad-1';
  context.window.currentMappings = {
    'pad-1': [],
    'knob-1': [{ type: 'mixer_pan', trackIndex: 0, label: 'Pan' }],
  };
  const calls = [];
  context.window.sendWS = (cmd, args, cb) => {
    calls.push({ cmd, args });
    if (cb) cb({ ok: true, result: {} });
  };

  const t = { type: 'mixer_pan', trackIndex: 0, label: 'Pan' };
  context.window.commitBind(t);
  context.document.getElementById('map-conflict-replace').onclick();

  const removeForKnob = calls.filter((c) => c.cmd === 'removeMapping' && c.args.control === 'knob-1');
  const setForKnob = calls.filter((c) => c.cmd === 'setMapping' && c.args.control === 'knob-1');
  assert.equal(removeForKnob.length, 1);
  assert.equal(setForKnob.length, 0);
});

test('Replace flow when the other control had multiple targets keeps the remainder', () => {
  const { context, document } = loadMappingsModule();
  context.window.selectedControl = 'pad-1';
  context.window.currentMappings = {
    'pad-1': [],
    'knob-1': [
      { type: 'mixer_pan', trackIndex: 0, label: 'Pan' },
      { type: 'mixer_volume', trackIndex: 1, label: 'Vol' },
    ],
  };
  const calls = [];
  context.window.sendWS = (cmd, args, cb) => {
    calls.push({ cmd, args });
    if (cb) cb({ ok: true, result: {} });
  };

  const t = { type: 'mixer_pan', trackIndex: 0, label: 'Pan' };
  context.window.commitBind(t);
  context.document.getElementById('map-conflict-replace').onclick();

  const setForKnob = calls.find((c) => c.cmd === 'setMapping' && c.args.control === 'knob-1');
  assert.ok(setForKnob, 'expected setMapping to preserve the other control\'s remaining targets');
  assert.equal(setForKnob.args.targets.length, 1);
  assert.equal(setForKnob.args.targets[0].type, 'mixer_volume');
});

test('clicking Cancel in the conflict banner hides the banner and does not commit', () => {
  const { context, document } = loadMappingsModule();
  context.window.selectedControl = 'pad-1';
  context.window.currentMappings = {
    'pad-1': [],
    'knob-1': [{ type: 'mixer_pan', trackIndex: 0, label: 'Pan' }],
  };
  const calls = [];
  context.window.sendWS = (cmd, args, cb) => {
    calls.push({ cmd, args });
    if (cb) cb({ ok: true, result: {} });
  };

  const t = { type: 'mixer_pan', trackIndex: 0, label: 'Pan' };
  context.window.commitBind(t);

  const banner = document.getElementById('map-conflict-banner');
  assert.equal(banner.classList.contains('hidden'), false);

  const cancelBtn = document.getElementById('map-conflict-cancel');
  assert.ok(cancelBtn);
  cancelBtn.onclick();

  assert.equal(banner.classList.contains('hidden'), true,
    'banner must hide after Cancel');
  assert.equal(calls.length, 0, 'must not commit when user cancels');
});

// ───────────────────────────────────────────────────────────────────────────
// Inline picker (replaces the bind modal entirely)
// ───────────────────────────────────────────────────────────────────────────

function makePickerAllTargetsRaw() {
  // Build a minimal target tree so the picker has something to render.
  return [
    {
      type: 'tempo',
      label: 'Song Tempo',
    },
    {
      name: 'Input',
      trackIndex: 0,
      mixer: [
        { type: 'mixer_volume', trackIndex: 0, label: 'Volume' },
        { type: 'mixer_pan', trackIndex: 0, label: 'Pan' },
      ],
      devices: [
        {
          name: 'Auto Filter',
          index: 0,
          params: [
            { type: 'device_param', trackIndex: 0, deviceIndex: 0, paramIndex: 0, label: 'Frequency' },
            { type: 'device_param', trackIndex: 0, deviceIndex: 0, paramIndex: 1, label: 'Resonance' },
          ],
        },
      ],
    },
  ];
}

test('clicking Bind to... reveals the inline picker and renders targets', () => {
  const { context, document } = loadMappingsModule();
  context.window.selectedControl = 'pad-1';
  context.window.allTargetsRaw = makePickerAllTargetsRaw();
  context.window.renderMappingDetail();

  assert.equal(context.window.pickerOpen, false,
    'picker starts closed until user clicks Bind to...');

  context.window.renderMappingsTab();
  const btnBind = document.getElementById('btn-bind');
  btnBind.onclick();

  assert.equal(context.window.pickerOpen, true,
    'picker must show after clicking Bind to...');

  const list = document.getElementById('map-picker-list');
  assert.ok(list);
  // Should render at least the track row and the tempo row.
  assert.ok(list.children.length > 0, 'picker list must populate from allTargetsRaw');
  assert.match(list.children[0]._innerHTML, /Song Tempo/);
});

test('clicking a parameter in the picker commits with defaults and hides the picker', () => {
  const { context, document } = loadMappingsModule();
  context.window.selectedControl = 'pad-1';
  context.window.currentMappings = {};
  context.window.allTargetsRaw = makePickerAllTargetsRaw();
  const calls = [];
  context.window.sendWS = (cmd, args, cb) => {
    calls.push({ cmd, args });
    if (cb) cb({ ok: true, result: {} });
  };
  context.window.renderMappingDetail();
  context.window.renderMappingsTab();
  document.getElementById('btn-bind').onclick();

  const list = document.getElementById('map-picker-list');
  // First child is the Song Tempo row; pick it.
  const tempoRow = list.children[0];
  assert.ok(tempoRow && typeof tempoRow.onclick === 'function');
  tempoRow.onclick();

  assert.equal(calls.length, 1);
  assert.equal(calls[0].cmd, 'setMapping');
  assert.equal(calls[0].args.targets[0].type, 'tempo');
  assert.equal(calls[0].args.targets[0].curve, 'linear');
  assert.equal(calls[0].args.targets[0].inMin, 0);
  assert.equal(calls[0].args.targets[0].inMax, 1);
  assert.equal(calls[0].args.targets[0].smooth, 0);

  assert.equal(context.window.pickerOpen, false,
    'picker must close after a successful commit');
});

test('Cancel button on the picker hides the picker without committing', () => {
  const { context, document } = loadMappingsModule();
  context.window.selectedControl = 'pad-1';
  context.window.allTargetsRaw = makePickerAllTargetsRaw();
  const calls = [];
  context.window.sendWS = (cmd, args, cb) => {
    calls.push({ cmd, args });
    if (cb) cb({ ok: true, result: {} });
  };
  context.window.renderMappingDetail();
  context.window.renderMappingsTab();
  document.getElementById('btn-bind').onclick();

  assert.equal(context.window.pickerOpen, true);

  const cancelBtn = document.getElementById('map-picker-cancel');
  assert.ok(cancelBtn);
  cancelBtn.onclick();

  assert.equal(context.window.pickerOpen, false);
  assert.equal(calls.length, 0, 'cancel must not commit anything');
});

test('Esc key closes the picker when it is open', () => {
  const { context, document } = loadMappingsModule();
  context.window.selectedControl = 'pad-1';
  context.window.allTargetsRaw = makePickerAllTargetsRaw();
  context.window.renderMappingDetail();
  context.window.renderMappingsTab();
  document.getElementById('btn-bind').onclick();

  assert.equal(context.window.pickerOpen, true);

  // Simulate a keydown Esc on the picker search input.
  const search = document.getElementById('map-picker-search');
  const escHandler = search.listeners.get('keydown');
  assert.ok(escHandler, 'picker search must have a keydown listener');
  escHandler({ key: 'Escape' });

  assert.equal(context.window.pickerOpen, false);
});

test('Esc key does nothing when the picker is closed (no stray listener side-effect)', () => {
  const { context, document } = loadMappingsModule();
  context.window.selectedControl = 'pad-1';
  context.window.allTargetsRaw = makePickerAllTargetsRaw();
  context.window.renderMappingDetail();
  // Picker is hidden by default; no keydown handler should be wired.
  const search = document.getElementById('map-picker-search');
  const escHandler = search.listeners.get('keydown');
  assert.equal(escHandler, undefined,
    'picker must not wire Esc handler until it is opened');
});

test('commitBind surfaces conflict banner alongside the still-open picker (no modal in the way)', () => {
  const { context, document } = loadMappingsModule();
  context.window.selectedControl = 'pad-1';
  context.window.currentMappings = {
    'pad-1': [],
    'knob-1': [{ type: 'mixer_volume', trackIndex: 0, label: 'Volume' }],
  };
  context.window.allTargetsRaw = makePickerAllTargetsRaw();
  const calls = [];
  context.window.sendWS = (cmd, args, cb) => {
    calls.push({ cmd, args });
    if (cb) cb({ ok: true, result: {} });
  };
  context.window.renderMappingDetail();
  context.window.renderMappingsTab();
  document.getElementById('btn-bind').onclick();

  assert.equal(context.window.pickerOpen, true,
    'picker stays open so user can pick a different param without re-opening');

  // Trigger a conflict by committing the same target as knob-1.
  context.window.commitBind({ type: 'mixer_volume', trackIndex: 0, label: 'Volume' });

  const banner = document.getElementById('map-conflict-banner');
  assert.equal(banner.classList.contains('hidden'), false,
    'banner must appear in the detail view, not hidden behind a modal');
  assert.equal(context.window.pickerOpen, true,
    'picker stays open so user can replace or pick another');
  assert.equal(calls.length, 0);
});

// ───────────────────────────────────────────────────────────────────────────
// Per-target inline editing on the detail panel
// ───────────────────────────────────────────────────────────────────────────

function queryByClass(scope, className) {
  const out = [];
  const walk = (el) => {
    if (!el) return;
    if (el.classList && el.classList.contains(className)) out.push(el);
    for (const c of el.children || []) walk(c);
  };
  walk(scope);
  return out;
}

test('renderMappingDetail renders input range sliders per target (inMin / inMax)', () => {
  const { context, document } = loadMappingsModule();
  context.window.selectedControl = 'pad-1';
  context.window.currentMappings = {
    'pad-1': [
      { type: 'mixer_volume', trackIndex: 0, label: 'Vol', inMin: 0.1, inMax: 0.9, outMin: 0, outMax: 1, curve: 'linear' },
    ],
  };

  context.window.renderMappingDetail();

  const targets = document.getElementById('map-detail-targets');
  const inMins = queryByClass(targets, 'target-in-min');
  const inMaxs = queryByClass(targets, 'target-in-max');
  assert.equal(inMins.length, 1);
  assert.equal(inMaxs.length, 1);
  assert.equal(inMins[0].value, '10'); // 0.1 → 10
  assert.equal(inMaxs[0].value, '90'); // 0.9 → 90
});

test('renderMappingDetail renders output range sliders per target (outMin / outMax)', () => {
  const { context, document } = loadMappingsModule();
  context.window.selectedControl = 'pad-1';
  context.window.currentMappings = {
    'pad-1': [
      { type: 'mixer_volume', trackIndex: 0, label: 'Vol', inMin: 0, inMax: 1, outMin: 0.25, outMax: 0.75, curve: 'linear' },
    ],
  };

  context.window.renderMappingDetail();

  const targets = document.getElementById('map-detail-targets');
  const outMins = queryByClass(targets, 'target-out-min');
  const outMaxs = queryByClass(targets, 'target-out-max');
  assert.equal(outMins.length, 1);
  assert.equal(outMaxs.length, 1);
  assert.equal(outMins[0].value, '25');
  assert.equal(outMaxs[0].value, '75');
});

test('renderMappingDetail renders a response graph for every target, not only the primary', () => {
  const { context, document } = loadMappingsModule();
  context.window.selectedControl = 'pad-1';
  context.window.currentMappings = {
    'pad-1': [
      { type: 'mixer_volume', trackIndex: 0, label: 'Vol', curve: 'linear' },
      { type: 'mixer_pan', trackIndex: 0, label: 'Pan', curve: 'exponential' },
      { type: 'device_param', trackIndex: 0, deviceIndex: 0, paramIndex: 2, label: 'Cutoff', curve: 's-curve' },
    ],
  };

  context.window.renderMappingDetail();

  const targets = document.getElementById('map-detail-targets');
  const graphs = queryByClass(targets, 'target-graph');
  assert.equal(graphs.length, 3, `expected one graph per target, got ${graphs.length}`);
});

test('changing a target curve select in the detail persists the new curve via setMapping', () => {
  const { context, document } = loadMappingsModule();
  context.window.selectedControl = 'pad-1';
  context.window.currentMappings = {
    'pad-1': [{ type: 'mixer_volume', trackIndex: 0, label: 'Vol', curve: 'linear' }],
  };
  const calls = [];
  context.window.sendWS = (cmd, args, cb) => {
    calls.push({ cmd, args });
    if (cb) cb({ ok: true, result: {} });
  };

  context.window.renderMappingDetail();
  const targets = document.getElementById('map-detail-targets');
  const curve = queryByClass(targets, 'target-curve')[0];
  // Mark the s-curve option as selected so the fake <select>.value getter
  // (mirrors the real DOM) reflects the new choice.
  for (const opt of curve.children) {
    opt.selected = opt.value === 's-curve';
  }
  curve.listeners.get('change')();

  assert.equal(context.window.currentMappings['pad-1'][0].curve, 's-curve');
  assert.ok(calls.some((c) => c.cmd === 'setMapping' && c.args.control === 'pad-1'));
});

test('typing a Trigger Note value persists the MIDI note without waiting for blur', () => {
  const { context, document } = loadMappingsModule();
  context.window.selectedControl = 'pad-1';
  context.window.currentMappings = {
    'pad-1': [{ type: 'device_param', trackIndex: 0, label: 'MIDI', mode: 'trigger_note', midiNote: 'C3', midiVelocity: 100 }],
  };
  let fetchCalls = 0;
  context.window.fetchMappings = () => { fetchCalls++; };
  const calls = [];
  context.window.sendWS = (cmd, args, cb) => {
    calls.push({ cmd, args });
    if (cb) cb({ ok: true, result: {} });
  };

  context.window.renderMappingDetail();
  const targets = document.getElementById('map-detail-targets');
  const note = queryByClass(targets, 'target-midi-note')[0];
  const inputHandler = note.listeners.get('input');
  assert.ok(inputHandler, 'Trigger Note input should persist valid edits as the user types');

  note.value = 'C7';
  inputHandler();

  assert.equal(context.window.currentMappings['pad-1'][0].midiNote, 'C7');
  const last = calls.filter((c) => c.cmd === 'setMapping').pop();
  assert.ok(last, 'expected setMapping to be sent');
  assert.equal(last.args.targets[0].midiNote, 'C7');
  assert.equal(fetchCalls, 0, 'typing should not refetch and rebuild the focused input');
});

test('changing a target input range slider in the detail persists inMin / inMax via setMapping', () => {
  const { context, document } = loadMappingsModule();
  context.window.selectedControl = 'pad-1';
  context.window.currentMappings = {
    'pad-1': [{ type: 'mixer_volume', trackIndex: 0, label: 'Vol', inMin: 0, inMax: 1, outMin: 0, outMax: 1, curve: 'linear' }],
  };
  const calls = [];
  context.window.sendWS = (cmd, args, cb) => {
    calls.push({ cmd, args });
    if (cb) cb({ ok: true, result: {} });
  };

  context.window.renderMappingDetail();
  const targets = document.getElementById('map-detail-targets');
  const inMin = queryByClass(targets, 'target-in-min')[0];
  inMin.value = '25';
  inMin.listeners.get('input')();

  assert.equal(context.window.currentMappings['pad-1'][0].inMin, 0.25);
  const last = calls.filter((c) => c.cmd === 'setMapping').pop();
  assert.ok(last, 'expected setMapping to be sent');
  assert.equal(last.args.targets[0].inMin, 0.25);
});

test('changing a target output range slider in the detail persists outMin / outMax via setMapping', () => {
  const { context, document } = loadMappingsModule();
  context.window.selectedControl = 'pad-1';
  context.window.currentMappings = {
    'pad-1': [{ type: 'mixer_volume', trackIndex: 0, label: 'Vol', inMin: 0, inMax: 1, outMin: 0, outMax: 1, curve: 'linear' }],
  };
  const calls = [];
  context.window.sendWS = (cmd, args, cb) => {
    calls.push({ cmd, args });
    if (cb) cb({ ok: true, result: {} });
  };

  context.window.renderMappingDetail();
  const targets = document.getElementById('map-detail-targets');
  const outMax = queryByClass(targets, 'target-out-max')[0];
  outMax.value = '80';
  outMax.listeners.get('input')();

  assert.equal(context.window.currentMappings['pad-1'][0].outMax, 0.8);
  const last = calls.filter((c) => c.cmd === 'setMapping').pop();
  assert.ok(last, 'expected setMapping to be sent');
  assert.equal(last.args.targets[0].outMax, 0.8);
});

test('saveMappingTargets(null, {refresh:false}) skips the getMappings refetch (avoids stealing focus mid-drag)', () => {
  const { context } = loadMappingsModule();
  let fetchCalls = 0;
  context.window.fetchMappings = () => { fetchCalls++; };
  context.window.selectedControl = 'pad-1';
  context.window.currentMappings = {
    'pad-1': [{ type: 'mixer_volume', trackIndex: 0, label: 'Vol' }],
  };
  const wsCalls = [];
  context.window.sendWS = (cmd, args, cb) => {
    wsCalls.push({ cmd, args });
    if (cb) cb({ ok: true, result: {} });
  };

  // Pass `targets` as the first arg (null = use currentMappings) and the
  // refresh flag as the second arg. Passing `{refresh:false}` as the first
  // arg would be treated as a targets payload, not an option.
  context.window.saveMappingTargets(null, { refresh: false });

  // setMapping must still be sent so the server persists the change.
  const setCalls = wsCalls.filter((c) => c.cmd === 'setMapping');
  assert.equal(setCalls.length, 1);
  // But the post-write refetch must NOT happen, otherwise
  // renderMappingDetail() recreates the slider the user is dragging.
  assert.equal(fetchCalls, 0, `expected no fetchMappings; got ${fetchCalls}`);
});

test('saveMappingTargets() (default) DOES refetch so the server is the source of truth', () => {
  const { context } = loadMappingsModule();
  let fetchCalls = 0;
  context.window.fetchMappings = () => { fetchCalls++; };
  context.window.selectedControl = 'pad-1';
  context.window.currentMappings = {
    'pad-1': [{ type: 'mixer_volume', trackIndex: 0, label: 'Vol' }],
  };
  const wsCalls = [];
  context.window.sendWS = (cmd, args, cb) => {
    wsCalls.push({ cmd, args });
    if (cb) cb({ ok: true, result: {} });
  };

  context.window.saveMappingTargets();

  const setCalls = wsCalls.filter((c) => c.cmd === 'setMapping');
  assert.equal(setCalls.length, 1);
  assert.equal(fetchCalls, 1, 'default saveMappingTargets must refetch so subsequent reads see the persisted state');
});

test('dragging an input range slider commits to server without triggering fetchMappings mid-drag', () => {
  const { context, document } = loadMappingsModule();
  context.window.selectedControl = 'pad-1';
  context.window.currentMappings = {
    'pad-1': [{ type: 'mixer_volume', trackIndex: 0, label: 'Vol', inMin: 0, inMax: 1, outMin: 0, outMax: 1, curve: 'linear' }],
  };
  let fetchCalls = 0;
  context.window.fetchMappings = () => { fetchCalls++; };
  const wsCalls = [];
  context.window.sendWS = (cmd, args, cb) => {
    wsCalls.push({ cmd, args });
    if (cb) cb({ ok: true, result: {} });
  };

  context.window.renderMappingDetail();
  const targets = document.getElementById('map-detail-targets');
  const inMin = queryByClass(targets, 'target-in-min')[0];

  // Simulate three drag ticks in a row — each input must hit the server
  // immediately so a tab-switch keeps the data, but the refetch must NOT
  // fire until the user releases the slider (we model "release" as the
  // final commit, i.e. one saveMappingTargets without refresh=false).
  inMin.value = '20';
  inMin.listeners.get('input')();
  inMin.value = '40';
  inMin.listeners.get('input')();
  inMin.value = '55';
  inMin.listeners.get('input')();

  const setCalls = wsCalls.filter((c) => c.cmd === 'setMapping');
  assert.equal(setCalls.length, 3, 'each input tick should send a setMapping');
  assert.equal(fetchCalls, 0, `fetchMappings must not fire during drag; got ${fetchCalls}`);
  assert.equal(context.window.currentMappings['pad-1'][0].inMin, 0.55);

  // Simulate pointerup / commit: a single saveMappingTargets(refresh:true)
  // re-syncs local state with the server.
  context.window.saveMappingTargets();
  assert.equal(fetchCalls, 1, 'commit should refetch exactly once');
});

test('Clear control: "__all__" dispatches to clearAllMappings (one server call, empties every mapping)', () => {
  const { context, document } = loadMappingsModule();
  context.window.selectedControl = 'pad-1';
  context.window.currentMappings = {
    'pad-1': [{ type: 'mixer_volume', trackIndex: 0, label: 'Vol' }],
    'knob-1': [{ type: 'mixer_pan', trackIndex: 0, label: 'Pan' }],
  };
  const wsCalls = [];
  context.window.sendWS = (cmd, args, cb) => {
    wsCalls.push({ cmd, args });
    if (cb) cb({ ok: true, result: { cleared: 2 } });
  };
  context.window.confirm = () => true;
  context.window.renderMappingsTab();

  // Default selection is "__all__" (first option) so the first click
  // must take the global path.
  const btn = document.getElementById('btn-clear');
  assert.ok(btn && typeof btn.onclick === 'function', 'btn-clear must be bound on render');

  btn.onclick();

  const clearCalls = wsCalls.filter((c) => c.cmd === 'clearMappings');
  const removeCalls = wsCalls.filter((c) => c.cmd === 'removeMapping');
  assert.equal(clearCalls.length, 1, '"__all__" must send exactly one clearMappings command');
  assert.equal(removeCalls.length, 0, '"__all__" must NOT issue per-control removeMapping');
  assert.equal(Object.keys(context.window.currentMappings).length, 0,
    'currentMappings must be empty after global clear');
  assert.equal(context.window.selectedControl, null,
    'selectedControl must be reset to null after global clear');
});

test('Clear control: clicking "__all__" with declined confirm is a no-op', () => {
  const { context, document } = loadMappingsModule();
  context.window.currentMappings = { 'pad-1': [{ type: 'mixer_volume', trackIndex: 0 }] };
  const wsCalls = [];
  context.window.sendWS = (cmd, args, cb) => {
    wsCalls.push({ cmd, args });
    if (cb) cb({ ok: true, result: { cleared: 1 } });
  };
  context.window.confirm = () => false;
  context.window.renderMappingsTab();
  document.getElementById('btn-clear').onclick();
  assert.equal(wsCalls.length, 0, 'must not call server when user declines confirm');
  assert.equal(Object.keys(context.window.currentMappings).length, 1,
    'local state must remain when user declines');
});

test('Clear control: selecting a category clears ONLY its mapped controls and leaves others intact', () => {
  const { context, document } = loadMappingsModule();
  // Mix of family + cross-family mappings so we can prove category
  // clearing is precise. KNOBS has knob-1 mapped; PADS has pad-1 and
  // pad-2 mapped (pad-2 belongs to PADS); FADERS has fader-1 mapped.
  context.window.currentMappings = {
    'pad-1': [{ type: 'mixer_volume', trackIndex: 0 }],
    'pad-2': [{ type: 'mixer_volume', trackIndex: 1 }],
    'knob-1': [{ type: 'mixer_pan', trackIndex: 0 }],
    'fader-1': [{ type: 'mixer_send', trackIndex: 0 }],
  };
  const wsCalls = [];
  context.window.sendWS = (cmd, args, cb) => {
    wsCalls.push({ cmd, args });
    if (cb) cb({ ok: true, result: { removed: 1 } });
  };
  context.window.confirm = () => true;
  context.window.renderMappingsTab();

  // Drive the click through the select so we exercise the same path the
  // UI uses, not the window.clearMappingsByCategory entry point.
  const sel = document.getElementById('map-clear-category');
  const btn = document.getElementById('btn-clear');
  assert.ok(sel && btn, 'category select and clear button must both be present');

  // Verify the select options were populated from allControlsGrouped.
  const optionValues = Array.from(sel.children).map((o) => o.value);
  assert.ok(optionValues.includes('__all__'), 'placeholder option __all__ must be first');
  assert.ok(optionValues.includes('PADS'), 'PADS option must be populated from allControlsGrouped');
  assert.ok(optionValues.includes('KNOBS'), 'KNOBS option must be populated');
  assert.ok(optionValues.includes('FADERS'), 'FADERS option must be populated');

  // Pick PADS and click.
  sel.value = 'PADS';
  sel.listeners.get('change')();
  btn.onclick();

  // Sequential removeMapping calls — one per mapped PAD control.
  const removeCalls = wsCalls.filter((c) => c.cmd === 'removeMapping');
  const clearedControls = removeCalls.map((c) => c.args && c.args.control).sort();
  assert.deepEqual(clearedControls, ['pad-1', 'pad-2'],
    'PADS clear must remove pad-1 and pad-2 only, never knob-1 or fader-1');

  // After the chain completes, knock-1 and fader-1 must still be mapped locally.
  // The local state is reconciled by fetchMappings(), which our test sendWS
  // doesn't drive — but our clearMappingsByCategory does not delete local
  // entries itself; only the post-fetch does. Either way the global clear
  // command must NOT have been sent.
  const globalClears = wsCalls.filter((c) => c.cmd === 'clearMappings');
  assert.equal(globalClears.length, 0,
    'PADS clear must NOT issue the global clearMappings command');
});

test('Clear control: clearing a category with no mapped controls is a silent no-op', () => {
  const { context, document } = loadMappingsModule();
  context.window.currentMappings = {
    'pad-1': [{ type: 'mixer_volume', trackIndex: 0 }],
    // KNOBS deliberately has no entry in currentMappings even though
    // allControlsGrouped still lists it.
  };
  const wsCalls = [];
  context.window.sendWS = (cmd, args, cb) => wsCalls.push({ cmd, args });
  context.window.confirm = () => true;
  context.window.renderMappingsTab();

  const sel = document.getElementById('map-clear-category');
  const btn = document.getElementById('btn-clear');
  sel.value = 'KNOBS';
  sel.listeners.get('change')();
  btn.onclick();

  // The early "no mappings to clear" branch never reaches sendWS.
  assert.equal(wsCalls.length, 0,
    'no removeMapping or clearMappings command must be issued for an empty category');
});


// A1 regression guard: IDs the test mocks must also exist in the real
// index.html. Removing an ID from the markup silently passed before
// because the FakeDocument re-instantiated it. This guard surfaces the
// drift loudly the next time anyone edits the HTML.
test('All mappings test IDs exist in index.html (A1 regression guard)', () => {
  const staticRoot = path.resolve(import.meta.dirname, '..', 'panel');
  const html = fs.readFileSync(path.join(staticRoot, 'index.html'), 'utf8');
  const ids = [
    'mode-proto', 'mode-port', 'mode-cert',
    'map-list', 'map-empty', 'map-detail', 'map-detail-name',
    'map-detail-val', 'map-detail-spark', 'map-search', 'btn-clear',
    'map-clear-category', 'btn-bind', 'map-conflict-banner', 'map-conflict-replace',
    'map-conflict-cancel', 'map-picker', 'map-picker-toolbar',
    'map-picker-search', 'map-picker-cancel', 'map-picker-list',
    'map-detail-targets',
  ];
  const missing = ids.filter((id) => !html.includes(`id="${id}"`));
  assert.deepEqual(missing, [], 'Mappings IDs missing from index.html: ' + missing.join(', '));
});

// A3 followup guards: a group that holds the currently selected control
// must stay open both at render-time (driven by storedState + selection)
// and on subsequent toggle clicks. Without this, the panel would let
// the user silently bury the source they were editing by collapsing its
// family category.

function makeLocalStorage(initial = {}) {
  const store = { ...initial };
  return {
    getItem(key) {
      return Object.prototype.hasOwnProperty.call(store, key) ? store[key] : null;
    },
    setItem(key, value) {
      store[key] = value;
    },
    _dump() { return store; },
  };
}

function findGroupNode(documentEl, groupName) {
  const listEl = documentEl.getElementById('map-list');
  if (!listEl) return null;
  return listEl.children.find((c) => c && c.dataset && c.dataset.group === groupName) || null;
}

test('A3 followup: group holding the selected control stays open even when localStorage says collapsed', () => {
  const lsStore = { 'map-group-state': JSON.stringify({ KNOBS: true }) };
  const { context, document } = loadMappingsModule({ localStorage: makeLocalStorage(lsStore) });
  context.window.localStorage = context.localStorage;
  context.window.selectedControl = 'knob-1';
  context.window.allControlsGrouped = {
    PADS: ['pad-1', 'pad-2'],
    KNOBS: ['knob-1', 'knob-2'],
    FADERS: ['fader-1'],
  };
  context.window.renderMappingsTab();

  const knobsGroup = findGroupNode(document, 'KNOBS');
  assert.ok(knobsGroup, 'KNOBS group wrap must exist after render');
  assert.equal(knobsGroup.classList.contains('collapsed'), false,
    'KNOBS (holds selectedControl) must not be collapsed even with storedState true');
  const itemsWrap = knobsGroup.children.find((c) => c && c.classList && c.classList.contains('map-group-items'));
  assert.ok(itemsWrap, 'KNOBS must always render its items container');
  assert.ok(itemsWrap.children.length >= 2,
    'KNOBS items wrap must contain the controls (filter is empty, so all KNOBS show)');
});

test('A3 followup: clicking the header of the selected-control group does not hide its items', () => {
  const lsStore = { 'map-group-state': JSON.stringify({}) };
  const { context, document } = loadMappingsModule({ localStorage: makeLocalStorage(lsStore) });
  context.window.localStorage = context.localStorage;
  context.window.selectedControl = 'knob-1';
  context.window.allControlsGrouped = {
    PADS: ['pad-1', 'pad-2'],
    KNOBS: ['knob-1', 'knob-2'],
    FADERS: ['fader-1'],
  };
  context.window.renderMappingsTab();

  const knobsGroup = findGroupNode(document, 'KNOBS');
  const header = knobsGroup.children.find((c) => c.classList.contains('map-group-header'));
  assert.ok(header, 'KNOBS header must exist');

  // dispatch click — FakeElement listens via listeners Map, so call directly.
  header.listeners.get('click')();

  assert.equal(knobsGroup.classList.contains('collapsed'), false,
    'click on the selected-control group header must not collapse the group');
  const itemsWrap = knobsGroup.children.find((c) => c.classList.contains('map-group-items'));
  assert.ok(itemsWrap.children.length >= 2,
    'items must remain visible after the click would have collapsed an empty group');
  const stored = JSON.parse(context.window.localStorage.getItem('map-group-state') || '{}');
  assert.equal(stored.KNOBS, false,
    'storedState for KNOBS must be reset to false so a later selection clear re-allows folding');
});

test('A3 followup: clicking the header of a non-selected group still toggles normally', () => {
  const { context, document } = loadMappingsModule({ localStorage: makeLocalStorage({}) });
  context.window.localStorage = context.localStorage;
  context.window.selectedControl = 'knob-1';
  context.window.allControlsGrouped = {
    PADS: ['pad-1', 'pad-2'],
    KNOBS: ['knob-1', 'knob-2'],
    FADERS: ['fader-1'],
  };
  context.window.renderMappingsTab();

  const padsGroup = findGroupNode(document, 'PADS');
  const header = padsGroup.children.find((c) => c.classList.contains('map-group-header'));
  header.listeners.get('click')();

  assert.equal(padsGroup.classList.contains('collapsed'), true,
    'PADS (no selection inside) must collapse on click');
  // The CSS class controls display; FakeDocument has no layout engine,
  // so the items stay in `children` regardless of collapse state. The
  // meaningful assertions are the class flag (the renderer agreement)
  // and the persisted storedState (the user contract).
  assert.ok(padsGroup.children.find((c) => c.classList.contains('map-group-items')),
    'items wrap must still be present in collapsed group (display:none is CSS concern)');
  const stored = JSON.parse(context.window.localStorage.getItem('map-group-state') || '{}');
  assert.equal(stored.PADS, true,
    'PADS collapse must be persisted');
});

// ─── A5 empty states ────────────────────────────────────────────────────────

test('A5: renderMappingsTab shows the .map-list-empty banner when currentMappings is empty', () => {
  const { context, document } = loadMappingsModule();
  context.window.currentMappings = {};
  context.window.allControlsGrouped = {
    PADS: ['pad-1', 'pad-2'],
    KNOBS: ['knob-1'],
  };
  context.window.renderMappingsTab();

  const listEl = document.getElementById('map-list');
  const empty = listEl.children.find((c) => c.classList && c.classList.contains('map-list-empty'));
  assert.ok(empty, 'a .map-list-empty banner must render above the group list');
  assert.match(empty.textContent, /No mappings yet/);
});

test('A5: renderMappingsTab hides the .map-list-empty banner once any mapping is active', () => {
  const { context, document } = loadMappingsModule();
  // currentMappings with at least one entry whose array has targets.
  context.window.currentMappings = {
    'pad-1': [{ type: 'mixer_volume', trackIndex: 0 }],
  };
  context.window.allControlsGrouped = {
    PADS: ['pad-1', 'pad-2'],
    KNOBS: ['knob-1'],
  };
  context.window.renderMappingsTab();

  const listEl = document.getElementById('map-list');
  const empty = listEl.children.find((c) => c.classList && c.classList.contains('map-list-empty'));
  assert.equal(empty, undefined,
    'the empty-state banner must NOT render once a mapping exists');
});

test('A5: renderPickerList shows a .picker-empty notice when nothing matches', () => {
  const { context, document } = loadMappingsModule();
  context.window.allTargetsRaw = [
    { type: 'tempo' },
    { trackIndex: 0, name: 'Drums', mixer: [], devices: [] },
  ];
  // Open the picker so the search/list elements exist; the FakeDocument
  // already provides their IDs.
  if (typeof context.window.openPicker === 'function') {
    context.window.openPicker('pad-1');
  }
  const search = document.getElementById('map-picker-search');
  const list = document.getElementById('map-picker-list');
  if (search) search.value = 'absolutely-no-match-token';
  // Drive the same oninput handler the UI uses so the path is faithful.
  // The picker wires `oninput = renderPickerList` rather than
  // addEventListener, so we must read `search.oninput` rather than the
  // FakeElement listeners map.
  if (search && typeof search.oninput === 'function') search.oninput();
  if (!list) {
    // Some picker variants defer rendering until openPicker; if the
    // list element is not present we cannot test this contract here.
    return;
  }
  const empties = list.children.filter((c) => c.classList && c.classList.contains('picker-empty'));
  assert.ok(empties.length >= 1,
    'a .picker-empty notice must render when no parameter matches the filter');
  assert.equal(empties[0].textContent, 'No parameters found');
});

test('new desktop bindings default to release on signal loss', () => {
  const source = fs.readFileSync(path.join(import.meta.dirname, 'mappings.js'), 'utf8');
  const bind = source.slice(source.indexOf('function doApplyBind'), source.indexOf('targets.push(newTarget)'));
  assert.match(bind, /neutralPolicy:\s*['"]release['"]/);
  assert.match(bind, /takeoverMode:\s*['"]scale['"]/);
  assert.match(source, /\(t\.neutralPolicy \|\| ["']release["']\)/);
});
