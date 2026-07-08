import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';

function loadAppWithBattery(batteryMock) {
  const appFile = path.join(import.meta.dirname, 'app.js');
  const appSource = fs.readFileSync(appFile, 'utf8');

  const mockElements = {};
  const getMockElement = (id) => {
    if (!mockElements[id]) {
      const el = {
        textContent: '',
        checked: false,
        className: '',
        addEventListener: function(evt, cb) {
          this[`on${evt}`] = cb;
        },
      };
      el.classList = {
        add: (c) => { el.className = c; },
        remove: (c) => { el.className = ''; },
        toggle: () => {},
        contains: () => false,
      };
      mockElements[id] = el;
    }
    return mockElements[id];
  };

  const windowContext = {
    window: null,
    globalThis: {},
    document: {
      body: {
        dataset: {},
        classList: {
          add: function(c) { windowContext.bodyClassName = c; },
          remove: function(c) { windowContext.bodyClassName = ''; }
        }
      },
      getElementById: getMockElement,
      querySelector: getMockElement,
      querySelectorAll: () => [getMockElement('pad-1')],
      addEventListener: () => {},
      removeEventListener: () => {},
    },
    navigator: {
      vibrate: function(pattern) {
        windowContext.lastVibrationPattern = pattern;
      },
      getBattery: () => Promise.resolve(batteryMock)
    },
    performance: { now: () => Date.now() },
    isSecureContext: true,
    location: {
      protocol: 'https:',
      host: 'localhost:8080',
    },
    requestAnimationFrame: (cb) => {
      return setTimeout(cb, 10);
    },
    cancelAnimationFrame: (id) => {
      clearTimeout(id);
    },
    localStorage: {
      getItem: () => null,
      setItem: () => {},
      removeItem: () => {},
    },
    WebSocket: class {
      constructor() { this.readyState = 0; }
      send() {}
      close() {}
    },
    addEventListener: () => {},
    setInterval: (cb, interval) => {
      windowContext.lastIntervalCallback = cb;
      windowContext.lastIntervalTime = interval;
      return 1;
    },
    setTimeout: (cb, delay) => { cb(); },
    dispatchEvent: () => {},
    lastVibrationPattern: null,
    bodyClassName: '',
  };
  windowContext.window = windowContext;
  windowContext.globalThis = windowContext;

  vm.runInNewContext(appSource, windowContext, { filename: appFile });

  return windowContext;
}

test('Battery Telemetry: tracks levels and triggers alarm under 20% when discharging', async () => {
  let batteryListener = null;
  const mockBatteryObj = {
    level: 0.5,
    charging: true,
    addEventListener: (evt, cb) => {
      if (evt === 'levelchange' || evt === 'chargingchange') {
        batteryListener = cb;
      }
    }
  };

  const context = loadAppWithBattery(mockBatteryObj);

  // Wait a small duration to let startup getBattery run
  await new Promise(resolve => setTimeout(resolve, 20));

  // Initially: 50% and charging -> no alert, no vibration
  assert.equal(context.lastVibrationPattern, null);
  assert.equal(context.bodyClassName, '');

  // Simulate drop to 15% and discharging
  mockBatteryObj.level = 0.15;
  mockBatteryObj.charging = false;
  
  if (batteryListener) {
    batteryListener();
  }

  // Verify telemetry is updated but no obtrusive alarms/classes are triggered
  const rc = context.window.__abletonRc;
  assert.equal(rc.state.sensors.network.battery.level, 0.15);
  assert.equal(rc.state.sensors.network.battery.charging, false);
  assert.equal(context.lastVibrationPattern, null);
  assert.equal(context.bodyClassName, '');
});
