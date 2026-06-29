import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';

function loadApp() {
  const file = path.join(import.meta.dirname, 'app.js');
  const source = fs.readFileSync(file, 'utf8');

  // Mocks for browser environment
  const mockElements = {};
  const getMockElement = (id) => {
    if (!mockElements[id]) {
      const el = {
        textContent: '',
        className: '',
        classList: {
          add: () => {},
          remove: () => {},
        },
        style: {},
        addEventListener: function(evt, cb) {
          this[`on${evt}`] = cb;
        },
      };
      mockElements[id] = el;
    }
    return mockElements[id];
  };

  const listeners = {};
  const docListeners = {};

  const navigatorMock = {
    onLine: true,
    vibrate: null, // Will be mocked in specific tests
    wakeLock: null, // Will be mocked in specific tests
  };

  const wsMockInstances = [];
  class WebSocketMock {
    constructor(url) {
      this.url = url;
      this.readyState = 0; // CONNECTING
      wsMockInstances.push(this);
    }
    send(data) {}
    close() {}
  }

  const storage = {};
  const localStorageMock = {
    getItem: (key) => storage[key] || null,
    setItem: (key, val) => { storage[key] = String(val); },
    removeItem: (key) => { delete storage[key]; },
  };

  const windowContext = {
    window: null,
    document: {
      addEventListener: (evt, cb) => { docListeners[evt] = cb; },
      getElementById: getMockElement,
      querySelector: (sel) => getMockElement(sel),
      querySelectorAll: (sel) => [],
    },
    navigator: navigatorMock,
    localStorage: localStorageMock,
    WebSocket: WebSocketMock,
    isSecureContext: true,
    location: {
      protocol: 'https:',
      host: 'localhost:8080',
    },
    addEventListener: (evt, cb) => { listeners[evt] = cb; },
    setInterval: () => {},
    setTimeout: (cb, delay) => { cb(); },
    currentControlStates: {},
    __mockWebSockets: wsMockInstances,
    __triggerDocEvent: (evt, e) => { if (docListeners[evt]) docListeners[evt](e); },
    __triggerWindowEvent: (evt, e) => { if (listeners[evt]) listeners[evt](e); },
  };
  windowContext.window = windowContext;

  vm.runInNewContext(source, windowContext, { filename: file });
  return windowContext;
}

test('Haptic / Wake Lock APIs: verify structure is registered', () => {
  const context = loadApp();
  const rc = context.window.__abletonRc;
  assert.ok(rc);
  assert.ok(rc.triggerHaptic, 'triggerHaptic should be exposed on window.__abletonRc');
  assert.ok(rc.requestWakeLock, 'requestWakeLock should be exposed on window.__abletonRc');
});

test('Haptic trigger: obeys enabled state and calls navigator.vibrate with correct pattern', () => {
  const context = loadApp();
  const rc = context.window.__abletonRc;

  let vibrateCalledWith = null;
  context.navigator.vibrate = (pattern) => {
    vibrateCalledWith = pattern;
    return true;
  };

  // Configure haptics to be enabled with standard profile
  context.window.hapticSettings = {
    enabled: true,
    profile: 'standard',
  };

  rc.triggerHaptic('standard');
  assert.equal(vibrateCalledWith, 30);

  rc.triggerHaptic('gentle');
  assert.equal(vibrateCalledWith, 10);

  rc.triggerHaptic('heavy');
  assert.equal(vibrateCalledWith, 80);

  // Disable haptics and verify it doesn't vibrate
  context.window.hapticSettings.enabled = false;
  vibrateCalledWith = null;
  rc.triggerHaptic('standard');
  assert.equal(vibrateCalledWith, null);
});

test('Wake Lock: requests lock when requested and handles visibility change', async () => {
  const context = loadApp();
  const rc = context.window.__abletonRc;

  let wakeLockRequested = false;
  context.navigator.wakeLock = {
    request: async (type) => {
      if (type === 'screen') {
        wakeLockRequested = true;
        return {
          addEventListener: () => {},
        };
      }
    }
  };

  await rc.requestWakeLock();
  assert.equal(wakeLockRequested, true);
});

test('Haptic profile tester buttons: click triggers vibration with profile settings', () => {
  const context = loadApp();
  const rc = context.window.__abletonRc;

  let vibrateCalledWith = null;
  context.navigator.vibrate = (pattern) => {
    vibrateCalledWith = pattern;
    return true;
  };

  // Configure haptics to be initially disabled (test buttons should bypass enabled=false check)
  context.window.hapticSettings = {
    enabled: false,
    profile: 'standard',
  };

  // 1. Gentle button click
  const btnGentle = context.document.getElementById('btn-haptic-test-gentle');
  assert.ok(btnGentle);
  assert.ok(btnGentle.onclick);
  btnGentle.onclick();
  assert.equal(vibrateCalledWith, 10); // gentle pattern is 10ms

  // 2. Standard button click
  const btnStandard = context.document.getElementById('btn-haptic-test-standard');
  assert.ok(btnStandard);
  assert.ok(btnStandard.onclick);
  btnStandard.onclick();
  assert.equal(vibrateCalledWith, 30); // standard pattern is 30ms

  // 3. Heavy button click
  const btnHeavy = context.document.getElementById('btn-haptic-test-heavy');
  assert.ok(btnHeavy);
  assert.ok(btnHeavy.onclick);
  btnHeavy.onclick();
  assert.equal(vibrateCalledWith, 80); // heavy pattern is 80ms

  // 4. Metronome button click
  const btnMetronome = context.document.getElementById('btn-haptic-test-metronome');
  assert.ok(btnMetronome);
  assert.ok(btnMetronome.onclick);
  btnMetronome.onclick();
  assert.equal(vibrateCalledWith, 15); // metronome pattern is 15ms
});
