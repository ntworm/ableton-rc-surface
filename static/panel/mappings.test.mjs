import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';

class FakeClassList {
  constructor(initial = '') {
    this.values = new Set(initial.split(/\s+/).filter(Boolean));
  }

  add(name) {
    this.values.add(name);
  }

  remove(name) {
    this.values.delete(name);
  }

  contains(name) {
    return this.values.has(name);
  }

  toggle(name, force) {
    const next = force === undefined ? !this.values.has(name) : Boolean(force);
    if (next) this.add(name);
    else this.remove(name);
    return next;
  }
}

class FakeElement {
  constructor(id = '') {
    this.id = id;
    this.children = [];
    this.dataset = {};
    this.style = {};
    this.className = '';
    this.classList = new FakeClassList();
    this.textContent = '';
    this.value = '';
    this.innerHTML = '';
    this.listeners = new Map();
    this.attributes = new Map();
  }

  appendChild(child) {
    this.children.push(child);
    return child;
  }

  setAttribute(name, value) {
    this.attributes.set(name, value);
  }

  addEventListener(name, fn) {
    this.listeners.set(name, fn);
  }
}

function createDocument() {
  const elements = new Map();
  const ids = [
    'map-list',
    'map-search',
    'map-empty',
    'map-detail',
    'map-detail-name',
    'map-detail-val',
    'map-detail-spark',
    'map-detail-targets',
  ];
  for (const id of ids) elements.set(id, new FakeElement(id));
  elements.get('map-search').value = '';
  elements.get('map-detail').classList.add('hidden');

  return {
    getElementById(id) {
      return elements.get(id) || null;
    },
    createElement(tagName) {
      const el = new FakeElement();
      el.tagName = tagName.toUpperCase();
      return el;
    },
  };
}

function loadPanelContext() {
  const staticRoot = path.resolve(import.meta.dirname, '..');
  const context = {
    console,
    document: createDocument(),
    localStorage: {
      getItem() {
        return null;
      },
      setItem() {},
    },
    navigator: {},
    setInterval() {
      return 1;
    },
    setTimeout() {
      return 1;
    },
    clearTimeout() {},
    window: {
      addEventListener() {},
      location: { port: '' },
    },
  };
  context.window.document = context.document;
  context.window.localStorage = context.localStorage;
  context.window.navigator = context.navigator;
  context.window.setInterval = context.setInterval;
  context.window.setTimeout = context.setTimeout;
  vm.createContext(context);

  for (const file of [
    'admin/mappings-core.js',
    'panel/app.js',
    'panel/mappings.js',
  ]) {
    const source = fs.readFileSync(path.join(staticRoot, file), 'utf8');
    vm.runInContext(source, context, { filename: file });
  }
  return context;
}

test('panel mappings tab renders grouped controls without a selected detail', () => {
  const context = loadPanelContext();

  assert.doesNotThrow(() => context.window.renderMappingsTab());

  const groups = context.document
    .getElementById('map-list')
    .children
    .filter((child) => child.className === 'map-group-header');

  assert.equal(groups.length, Object.keys(context.window.allControlsGrouped).length);
  assert.ok(groups.length >= 10);
  assert.equal(context.document.getElementById('map-empty').classList.contains('hidden'), false);
  assert.equal(context.document.getElementById('map-detail').classList.contains('hidden'), true);
});

test('phone v3 loads local assets through relative paths', () => {
  const html = fs.readFileSync(path.join(import.meta.dirname, '..', 'phone-v3', 'index.html'), 'utf8');

  assert.match(html, /href="style\.css"/);
  assert.doesNotMatch(html, /(?:href|src)="\/static\/phone-v3\//);
});

test('panel mapping live detail can read exported sensor ranges', () => {
  const context = loadPanelContext();
  context.window.selectedControl = 'sensor.orient.beta';
  context.window.drawSparkline = () => {};

  assert.doesNotThrow(() => context.window.updateMappingDetailLive('sensor.orient.beta', -12.345));
  assert.equal(context.document.getElementById('map-detail-val').textContent, '-12.345');
});
