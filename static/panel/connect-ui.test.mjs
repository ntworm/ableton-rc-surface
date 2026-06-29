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
  if (selector.startsWith('.')) return el.classList.contains(selector.slice(1));
  if (selector.startsWith('#')) return el.id === selector.slice(1);
  return false;
}

function loadPanelApp(extraIds = []) {
  const staticRoot = path.resolve(import.meta.dirname, '..');
  const ids = [
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
    'qr-mix',
    'url-perf',
    'url-mix',
    'qr-row',
    'qr-placeholder',
    'open-perf',
    'open-mix',
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
      if (typeof fn === 'function') fn();
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
    mixUrl: 'http://192.168.1.50:9100/mix/',
    adminUrl: 'http://192.168.1.50:9100/admin/',
    cpuUsage: 23,
  };
  context.sendWS = (_method, _payload, cb) => cb({ ok: true, result: info });

  context.refreshServerInfo();
  context.initCopyButtons();
  context.refreshServerInfo();

  const qrPerf = document.getElementById('qr-perf');
  const qrMix = document.getElementById('qr-mix');
  assert.equal(qrCalls.length, 2);
  assert.equal(qrPerf.dataset.url, undefined);
  assert.equal(qrMix.dataset.url, undefined);
  assert.equal(qrPerf.onclick, null);
  assert.equal(qrMix.onclick, null);
});

test('Connect control groups render expanded controls as sensor cells with correct labels and counts', () => {
  const { context, document } = loadPanelApp();

  context.buildCtrlGroups();

  const groups = document.getElementById('ctrl-groups').children;
  const byGroup = new Map(groups.map(group => [group.dataset.group, group]));
  assert.equal(byGroup.get('SENSORS')?.dataset.count, '12');
  assert.equal(byGroup.get('PADS')?.dataset.count, '12');
  assert.equal(byGroup.get('XY PADS')?.dataset.count, '4');
  assert.equal(byGroup.get('STUTTERS')?.dataset.count, '4');
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
