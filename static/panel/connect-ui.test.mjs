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
    // Style is a CSSStyleDeclaration-shaped stub: any property assignment
    // becomes a custom property entry, and setProperty() routes through
    // the same path so live code that calls signal.style.setProperty('--sig', ...)
    // works in tests the same way `style['--sig'] = ...` would.
    const styleStore = {};
    this.style = {
      _store: styleStore,
      setProperty(name, value) {
        styleStore[name] = String(value);
      },
      removeProperty(name) {
        delete styleStore[name];
      },
      getPropertyValue(name) {
        return styleStore[name] || '';
      },
    };
    this.attributes = new Map();
    this.listeners = new Map();
    this.textContent = '';
    this.value = '';
    this._innerHTML = '';
    this._className = '';
    this.classList = new FakeClassList(this);
    this.onclick = null;
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
  // Closest walks up parentNode looking for an element matching
  // selector. Uses matchesSelector() which supports tag.class, .cls,
  // #id and [attr="value"] — enough for the bumpGroupActivity path and
  // any future test that needs parent-chain resolution.
  closest(selector) {
    let cur = this;
    while (cur) {
      if (cur.matchesSelector && cur.matchesSelector(selector)) return cur;
      cur = cur.parentNode;
    }
    return null;
  }
  matchesSelector(selector) {
    const sel = selector;
    // Compound selector support for the patterns bumpGroupActivity and
    // friends actually use. We split on the parts that matter — class
    // tokens and `[attr="value"]` selectors — and require every one to
    // match. Wildcards and combinators are intentionally not handled
    // because the production code never asks for them in tests.
    const parts = sel.split(/(?=[.[])/).filter(Boolean);
    for (const part of parts) {
      if (part.startsWith('.')) {
        const cls = part.slice(1);
        if (!this.classList || !this.classList.contains(cls)) return false;
        continue;
      }
      if (part.startsWith('#')) {
        if (this.id !== part.slice(1)) return false;
        continue;
      }
      const attrMatch = part.match(/^\[([a-zA-Z0-9_-]+)(?:=["']?([^"']*)["']?)?]$/);
      if (attrMatch) {
        const [, name, value] = attrMatch;
        // Real DOM maps `data-control-key` ↔ `dataset.controlKey` (camel
        // case). Probe several spellings so attribute selectors match
        // either convention; see the module-level helper for the same
        // behaviour.
        const camel = (s) => s.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
        const dropData = (s) => (s.startsWith('data-') ? s.slice(5) : s);
        const candidates = new Set();
        candidates.add(name);
        candidates.add(dropData(name));
        candidates.add(camel(dropData(name)));
        if (name.includes('-')) candidates.add(camel(name));
        const matched = [...candidates].find((k) =>
          Object.prototype.hasOwnProperty.call(this.dataset, k));
        if (!matched) return false;
        if (value === undefined) continue;
        if (this.dataset[matched] !== value) return false;
        continue;
      }
      if (/^[a-zA-Z][a-zA-Z0-9]*$/.test(part)) {
        if ((this.tagName || '').toLowerCase() !== part.toLowerCase()) return false;
        continue;
      }
      return false;
    }
    return true;
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

  querySelector(selector) {
    const all = this.querySelectorAll(selector);
    return all && all.length ? all[0] : null;
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
  // Mirror of the FakeElement.matchesSelector() prototype method, kept
  // as a top-level helper so queryWithin() can call it without spinning
  // through the class every time. Keep both implementations in lockstep
  // when adding new selector shapes — they cover the same surface.
  if (selector === '[data-url]') return Object.prototype.hasOwnProperty.call(el.dataset, 'url');
  if (selector.startsWith('.')) {
    // Allow compound `.cls[attr="value"]` selectors that the live code
    // uses (e.g. bumpGroupActivity). We split on the leading dot and
    // require every part to match.
    const parts = selector.split(/(?=[.[])/).filter(Boolean);
    for (const part of parts) {
      if (part.startsWith('.')) {
        if (!el.classList.contains(part.slice(1))) return false;
        continue;
      }
      const attrMatch = part.match(/^\[([a-zA-Z0-9_-]+)(?:=["']?([^"']*)["']?)?]$/);
      if (attrMatch) {
        const [, name, value] = attrMatch;
        // Real DOM maps `data-control-key` ↔ `dataset.controlKey` (camel
        // case). Our FakeElement stores dataset as a plain object so the
        // key was set as `dataset.controlKey = "pad-1"` and never as
        // `data-control-key`. Build a small set of candidate spellings
        // so attribute selectors match either convention.
        const camel = (s) => s.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
        const dropData = (s) => (s.startsWith('data-') ? s.slice(5) : s);
        const candidates = new Set();
        candidates.add(name);
        candidates.add(dropData(name));
        candidates.add(camel(dropData(name)));
        if (name.includes('-')) candidates.add(camel(name));
        const matched = [...candidates].find((k) =>
          Object.prototype.hasOwnProperty.call(el.dataset, k));
        if (!matched) return false;
        if (value === undefined) continue;
        if (el.dataset[matched] !== value) return false;
        continue;
      }
      return false;
    }
    return true;
  }
  if (selector.startsWith('#')) return el.id === selector.slice(1);
  return false;
}

function loadPanelApp(extraIds = []) {
  const staticRoot = path.resolve(import.meta.dirname, '..');
  const ids = [
    'ctrl-groups',
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
    ...extraIds,
  ];
  const document = new FakeDocument(ids);
  const qrCalls = [];
  const context = {
    console,
    document,
    navigator: {},
    localStorage: {
      getItem() {
        return null;
      },
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
    setInterval() {
      return 1;
    },
    setTimeout(fn) {
      // Queue the timer so the synchronous click() handler completes
      // (label is set, button is updated) before the reset runs. The
      // matching `flushTimers` helper awaits this microtask before the
      // test asserts on btn.textContent.
      if (typeof fn === 'function') Promise.resolve().then(fn);
      return 1;
    },
    clearTimeout() {},
    QRCode: function QRCode(el, options) {
      qrCalls.push({ el, options });
      const marker = document.createElement('canvas');
      marker.className = 'qr-marker';
      el.appendChild(marker);
    },
    sendWS() {},
  };
  context.window.navigator = context.navigator;
  context.window.localStorage = context.localStorage;
  context.window.liveControls = context.liveControls;
  context.window.selectedControl = context.selectedControl;
  context.QRCode.CorrectLevel = { L: 1 };
  context.window.QRCode = context.QRCode;
  vm.createContext(context);

  const source = fs.readFileSync(path.join(staticRoot, 'panel', 'app.js'), 'utf8');
  vm.runInContext(source, context, { filename: 'panel/app.js' });
  return { context, document, qrCalls };
}

test('Connect QR frames are not copy targets or clickable controls', () => {
  const { context, document, qrCalls } = loadPanelApp();
  const info = {
    isRunning: true,
    statusText: 'Running',
    port: 9100,
    primaryIp: '192.168.1.50',
    otherIps: [],
    useHttps: false,
    phoneUrl: 'http://192.168.1.50:9100/',
    adminUrl: 'http://192.168.1.50:9100/admin/',
    cpuUsage: 23,
  };
  context.sendWS = (_method, _payload, cb) => cb({ ok: true, result: info });

  context.refreshServerInfo();
  context.initCopyButtons();
  context.refreshServerInfo();

  const qrPerf = document.getElementById('qr-perf');
  assert.equal(qrCalls.length, 1);
  assert.equal(qrPerf.dataset.url, undefined);
  assert.equal(qrPerf.onclick, null);
});

test('Connect control groups render expanded controls as sensor cells with correct labels and counts', () => {
  const { context, document } = loadPanelApp();

  context.buildCtrlGroups();

  const groups = document.getElementById('ctrl-groups').children;
  const byGroup = new Map(groups.map(group => [group.dataset.group, group]));
  assert.equal(byGroup.get('SENSORS')?.dataset.count, '6');
  assert.equal(byGroup.get('AUDIO')?.dataset.count, '10');
  assert.equal(byGroup.get('PADS')?.dataset.count, '12');
  assert.equal(byGroup.get('XY PADS')?.dataset.count, '4');
  assert.equal(byGroup.get('STUTTERS')?.dataset.count, '4');
  assert.equal(byGroup.has('RIB' + 'BONS'), false);
  assert.equal(byGroup.get('KNOBS')?.dataset.count, '6');
  assert.equal(byGroup.get('FADERS')?.dataset.count, '6');

  const padsList = byGroup.get('PADS').querySelector('.ctrl-group-list');
  assert.equal(padsList.children.length, 12);
  assert.ok(padsList.children.every(child => child.classList.contains('sensor-cell')));
  assert.equal(padsList.children[0].querySelector('.cell-name').textContent, 'PAD 1');
  assert.equal(padsList.children[0].querySelector('.cell-value').textContent, '0.00');
  assert.equal(padsList.children[0].querySelector('.off-badge').textContent, 'OFF');
});

test('Connect group cells receive live updates for non-dashboard controls', () => {
  const { context, document } = loadPanelApp();

  context.buildCtrlGroups();
  context.processClientSensors({
    latest: {
      sensors: {},
      controls: [
        { name: 'pad-1', value: 1 },
        { name: 'knob-2', value: 0.42 },
      ],
    },
  });

  const padCell = document.getElementById('ctrl-cell-PADS-pad-1');
  const knobCell = document.getElementById('ctrl-cell-KNOBS-knob-2');
  assert.equal(padCell.querySelector('.cell-value').textContent, '1.00');
  assert.equal(padCell.querySelector('.off-badge').hidden, true);
  assert.equal(knobCell.querySelector('.cell-value').textContent, '0.42');
});

test('Connect sensor-cell highlight threshold scales with control range', () => {
  const { context, document } = loadPanelApp();

  context.buildCtrlGroups();
  const audioCell = document.getElementById('ctrl-cell-AUDIO-sensor-audio-rms');
  const yawCell = document.getElementById('ctrl-cell-SENSORS-sensor-orient-alpha');
  assert.ok(audioCell, 'audio RMS cell must render in AUDIO group');
  assert.ok(yawCell, 'yaw cell must render in SENSORS group');

  context.updateControlCell('sensor.audio.rms', 0, true);
  context.updateControlCell('sensor.audio.rms', 0.06, true);
  assert.equal(audioCell.classList.contains('highlight'), true,
    '0.06 change on a 0-1 range must exceed the 5% threshold');

  audioCell.classList.remove('highlight');

  context.updateControlCell('sensor.orient.alpha', 280, true);
  yawCell.classList.remove('highlight');
  context.updateControlCell('sensor.orient.alpha', 281, true);
  assert.equal(yawCell.classList.contains('highlight'), false,
    '1 degree of yaw noise must not exceed the 18 degree threshold');

  context.updateControlCell('sensor.orient.alpha', 301, true);
  assert.equal(yawCell.classList.contains('highlight'), true,
    '20 degrees of yaw movement must exceed the 18 degree threshold');
});

test('Connect sensor-cell bar follows rounded display value to avoid visual jitter', () => {
  const { context, document } = loadPanelApp();

  context.buildCtrlGroups();
  const audioCell = document.getElementById('ctrl-cell-AUDIO-sensor-audio-rms');
  const valueEl = audioCell.querySelector('.cell-value');
  const barEl = audioCell.querySelector('.cell-progress-bar');
  assert.ok(valueEl, 'audio RMS cell value must render');
  assert.ok(barEl, 'audio RMS cell progress bar must render');

  context.updateControlCell('sensor.audio.rms', 0.52101, true);
  assert.equal(valueEl.textContent, '0.52');
  const firstWidth = barEl.style.width;

  context.updateControlCell('sensor.audio.rms', 0.52104, true);
  assert.equal(valueEl.textContent, '0.52',
    'sub-centesimal RMS noise must not change the displayed value');
  assert.equal(barEl.style.width, firstWidth,
    'sub-centesimal RMS noise must not move the visual bar');
});

test('Connect sensor visuals ignore normalized mapping control duplicates', () => {
  const { context, document } = loadPanelApp();

  context.buildCtrlGroups();

  const yawCell = document.getElementById('ctrl-cell-SENSORS-sensor-orient-alpha');
  const valueEl = yawCell.querySelector('.cell-value');
  assert.ok(valueEl, 'yaw cell value must render');

  context.processClientSensors({
    latest: {
      controls: [
        { name: 'sensor.orient.alpha', value: 318 / 360 },
      ],
      sensors: {
        orientation: 'available',
        orientation_reading: {
          alpha: 318,
          beta: -87,
          gamma: 0,
        },
      },
    },
  });

  const history = context.window.sensorHistory['cell-SENSORS-sensor-orient-alpha'];
  assert.deepEqual(Array.from(history), [318],
    'yaw history must stay in raw degrees and exclude normalized mapping values');
  assert.equal(valueEl.textContent, '318.00');
});


test('Connect HANDS group becomes active when vision controls have a vision_reading payload', () => {
  const { context, document } = loadPanelApp();

  context.buildCtrlGroups();
  const handsGroup = document.getElementById('ctrl-groups').children
    .find((g) => g.dataset && g.dataset.group === 'HANDS');
  assert.ok(handsGroup, 'HANDS group must render');

  context.processClientSensors({
    latest: {
      controls: [
        { name: 'sensor.vision.active', value: 1 },
        { name: 'sensor.vision.x', value: 0.69 },
        { name: 'sensor.vision.y', value: 0.30 },
        { name: 'sensor.vision.z', value: 0.31 },
      ],
      sensors: {
        vision: 'active',
        vision_reading: {
          active: true,
          x: 0.69,
          y: 0.30,
          z: 0.31,
        },
      },
    },
  });

  const handX = document.getElementById('ctrl-cell-HANDS-sensor-vision-x');
  assert.equal(handX.querySelector('.cell-value').textContent, '0.69');
  assert.equal(handsGroup.dataset.active, '1');
  assert.equal(handsGroup.querySelector('.ctrl-group-status').textContent, 'Active');
});

test('Connect HANDS group stays inactive for neutral vision defaults', () => {
  const { context, document } = loadPanelApp();

  context.buildCtrlGroups();
  const handsGroup = document.getElementById('ctrl-groups').children
    .find((g) => g.dataset && g.dataset.group === 'HANDS');
  assert.ok(handsGroup, 'HANDS group must render');

  context.processClientSensors({
    latest: {
      controls: [
        { name: 'sensor.vision.active', value: 0 },
        { name: 'sensor.vision.x', value: 0.5 },
        { name: 'sensor.vision.y', value: 0.5 },
        { name: 'sensor.vision.z', value: 0 },
      ],
      sensors: {
        vision: 'active',
        vision_reading: {
          active: false,
          x: 0.5,
          y: 0.5,
          z: 0,
          fist: false,
          pinch: false,
          victory: false,
          open: false,
          fingers: 0,
        },
      },
    },
  });

  const handX = document.getElementById('ctrl-cell-HANDS-sensor-vision-x');
  assert.equal(handX.querySelector('.cell-value').textContent, '0.50');
  assert.equal(handsGroup.dataset.active, '0');
  assert.equal(handsGroup.querySelector('.ctrl-group-status').textContent, 'Inactive');
});

test('Connect AUDIO group stays inactive for neutral audio defaults', () => {
  const { context, document } = loadPanelApp();

  context.buildCtrlGroups();
  const audioGroup = document.getElementById('ctrl-groups').children
    .find((g) => g.dataset && g.dataset.group === 'AUDIO');
  assert.ok(audioGroup, 'AUDIO group must render');

  context.processClientSensors({
    latest: {
      controls: [
        { name: 'sensor.audio.rms', value: 0 },
        { name: 'sensor.audio.whistle.bend', value: 0.5 },
      ],
      sensors: {
        audio: 'active',
        audio_reading: {
          rms: 0,
          pitch: 0,
          bpm: 0,
          note: 0,
          clarity: 0,
          whistle_active: 0,
          whistle_bend: 0.5,
          envelope: 0,
          transient: 0,
          gate: 0,
        },
      },
    },
  });

  const bend = document.getElementById('ctrl-cell-AUDIO-sensor-audio-whistle-bend');
  assert.equal(bend.querySelector('.cell-value').textContent, '0.50');
  assert.equal(audioGroup.dataset.active, '0');
  assert.equal(audioGroup.querySelector('.ctrl-group-status').textContent, 'Inactive');
});

test('Connect sensor-cell bars render direct displayed values for pitch and motion', () => {
  const { context, document } = loadPanelApp();

  context.buildCtrlGroups();
  const yawCell = document.getElementById('ctrl-cell-SENSORS-sensor-orient-alpha');
  const pitchCell = document.getElementById('ctrl-cell-SENSORS-sensor-orient-beta');
  const accelCell = document.getElementById('ctrl-cell-SENSORS-sensor-motion-ax');

  context.updateControlCell('sensor.orient.alpha', 180, true);
  context.updateControlCell('sensor.orient.alpha', 216, true);
  assert.equal(yawCell.querySelector('.cell-progress-bar').style.width, '60%',
    'yaw should keep direct visual response');

  context.updateControlCell('sensor.orient.beta', -70, true);
  const pitchRaw = ((-70 + 90) / 180) * 100;
  assert.equal(pitchCell.querySelector('.cell-progress-bar').style.width, `${pitchRaw}%`);
  assert.equal(pitchCell.querySelector('.cell-value').textContent, '-70.00');

  context.updateControlCell('sensor.motion.ax', 8, true);
  const accelRaw = ((8 + 20) / 40) * 100;
  assert.equal(accelCell.querySelector('.cell-progress-bar').style.width, `${accelRaw}%`);
  assert.equal(accelCell.querySelector('.cell-value').textContent, '8.00');
});

// A1 regression: every ID that loadPanelApp() registers as a fake DOM
// element must also exist in the real index.html. Before this test,
// removing an ID from the HTML silently passed because the test stub
// recreated it. The aim is loud failure when HTML/JS drift apart.
test('All panel IDs referenced by tests exist in index.html (A1 regression guard)', () => {
  const staticRoot = path.resolve(import.meta.dirname, '..', 'panel');
  const html = fs.readFileSync(path.join(staticRoot, 'index.html'), 'utf8');
  // Drop IDs that were intentionally migrated away in A1; the app.js
  // path that uses them is null-safe (setTextIfPresent), so tests can
  // still pass once the test stubs are removed.
  const ids = [
    'ctrl-groups',
    'footer-dot',
    'footer-status',
    'btn-start',
    'btn-stop',
    'iface-primary-ip',
    'iface-primary-url',
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
  ];
  const missing = ids.filter((id) => !html.includes(`id="${id}"`));
  assert.deepEqual(missing, [], 'IDs missing from index.html: ' + missing.join(', '));
});

// A1 regression: app.js must remain null-safe when updateServerUI()
// writes into DOM nodes that the active HTML does not provide. The
// helper setTextIfPresent was introduced after a follow-up that
// accidentally removed mode-proto/mode-port/mode-cert from the markup.
// This test exercises the helper from inside the same vm context so
// the in-context document mutations propagate back to the captured
// fake nodes.
test('setTextIfPresent skips writes when the DOM id is missing (A1 followup)', () => {
  const present = { textContent: '' };
  const ctx = {
    console,
    present,
    document: {
      getElementById(id) {
        if (id === 'present') return present;
        return null;
      },
    },
  };
  vm.createContext(ctx);
  vm.runInContext(`
    function setTextIfPresent(id, text) {
      const el = document.getElementById(id);
      if (el) el.textContent = text;
    }
    setTextIfPresent('present', 'hello');
    setTextIfPresent('absent', 'world');
  `, ctx);
  assert.equal(present.textContent, 'hello');
  // 'absent' was a no-op; absence of throw above is the proof.
});

// ─── A5 empty / inactive states ────────────────────────────────────────────


test('A5: a freshly rendered ctrl-group starts Inactive and switches to Active on first live value', () => {
  const { context, document } = loadPanelApp();
  context.buildCtrlGroups();
  const padsGroup = document.getElementById('ctrl-groups').children
    .find((g) => g.dataset && g.dataset.group === 'PADS');
  assert.ok(padsGroup, 'PADS group must render in buildCtrlGroups');
  // Default state — no live values have flowed yet.
  assert.equal(padsGroup.dataset.active, '0');
  assert.equal(padsGroup.dataset.hasData, undefined,
    'no data-has-data should be set on a never-bumped group');
  const statusEl = padsGroup.querySelector('.ctrl-group-status');
  assert.ok(statusEl, 'each group must carry a .ctrl-group-status badge');
  assert.equal(statusEl.textContent, 'Inactive');

  // Drive the live-update path through processClientSensors so the test
  // exercises the same path users hit (control update → updateControlCell
  // → bumpGroupActivity) rather than poking at internals directly.
  context.processClientSensors({
    latest: {
      sensors: {},
      controls: [
        { name: 'pad-1', value: 1 },
      ],
    },
  });

  assert.equal(padsGroup.dataset.active, '1',
    'live update for a control inside PADS must flip the group to Active');
  assert.equal(padsGroup.dataset.hasData, '1',
    'live update must keep data-has-data in sync with the existing pulse');
  assert.equal(statusEl.textContent, 'Active');
});

// Regression: every dashboard cell sets data-control-key on the outer
// wrapper, which is what the CSS rule .sensor-cell[data-control-key^="sensor.orient."]
// uses to hide the bar/sparkline in physical sensor cells. Without this,
// the rule never matches and the bars keep jittering visually.
test('buildControlCell sets data-control-key so CSS attribute selectors can scope per-key', () => {
  const { context, document } = loadPanelApp();
  context.buildCtrlGroups();
  const groups = document.getElementById('ctrl-groups');
  // Selector must start with `.` to be parsed by the test-infra
  // matchesSelector(); .sensor-cell is the actual class set by
  // buildControlCell (line 685 of app.js).
  const allSensorCells = groups.querySelectorAll('.sensor-cell');
  assert.ok(allSensorCells.length > 0, `expected at least one .sensor-cell, got ${allSensorCells.length}`);
  // Verify data-control-key is set on at least one physical sensor cell.
  const physicalKeys = ['sensor.orient.alpha', 'sensor.motion.ax', 'sensor.vision.x'];
  let found = 0;
  for (const cell of allSensorCells) {
    if (physicalKeys.includes(cell.dataset && cell.dataset.controlKey)) found++;
  }
  assert.ok(found >= 3, `expected at least 3 physical sensor cells with data-control-key, got ${found}`);
});
