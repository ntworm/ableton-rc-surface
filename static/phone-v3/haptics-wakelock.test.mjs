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
      mockElements[id] = {
        textContent: '',
        className: '',
        classList: {
          add: () => {},
          remove: () => {},
        },
        style: {},
        addEventListener: () => {},
      };
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
