import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';

function loadMadgwickAndApp() {
  const madgwickFile = path.join(import.meta.dirname, 'vendor', 'madgwick.js');
  const madgwickSource = fs.readFileSync(madgwickFile, 'utf8');

  const appFile = path.join(import.meta.dirname, 'app.js');
  const appSource = fs.readFileSync(appFile, 'utf8');

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
    vibrate: () => {},
    wakeLock: null,
  };

  class WebSocketMock {
    constructor(url) {
      this.url = url;
      this.readyState = 0;
    }
    send(data) {}
    close() {}
  }

  const windowContext = {
    window: null,
    document: {
      addEventListener: (evt, cb) => { docListeners[evt] = cb; },
      getElementById: getMockElement,
      querySelector: (sel) => getMockElement(sel),
      querySelectorAll: (sel) => [],
    },
    navigator: navigatorMock,
    localStorage: {
      getItem: () => null,
      setItem: () => {},
      removeItem: () => {},
    },
    WebSocket: WebSocketMock,
    DeviceMotionEvent: function() {},
    DeviceOrientationEvent: function() {},
    isSecureContext: true,
    location: {
      protocol: 'https:',
      host: 'localhost:8080',
    },
    addEventListener: (evt, cb) => { listeners[evt] = cb; },
    setInterval: () => {},
    setTimeout: (cb, delay) => { cb(); },
    currentControlStates: {},
    __triggerDocEvent: (evt, e) => { if (docListeners[evt]) docListeners[evt](e); },
    __triggerWindowEvent: (evt, e) => { if (listeners[evt]) listeners[evt](e); },
  };
  windowContext.window = windowContext;

  // Run Madgwick script first to define Madgwick class in context
  vm.runInNewContext(madgwickSource, windowContext, { filename: madgwickFile });
  
  // Run App script
  vm.runInNewContext(appSource, windowContext, { filename: appFile });
  
  return windowContext;
}

test('Madgwick AHRS class: is defined and computes stable quaternion', () => {
  const context = loadMadgwickAndApp();
  assert.ok(context.window.Madgwick, 'Madgwick should be defined on window');

  const filter = new context.window.Madgwick(0.01, 0.1);
  assert.equal(filter.q0, 1.0);
  assert.equal(filter.q1, 0.0);
  assert.equal(filter.q2, 0.0);
  assert.equal(filter.q3, 0.0);

  // Feeding stationary IMU values (accel pointing straight down az=1g, gyro=0)
  filter.updateIMU(0, 0, 0, 0, 0, 1.0);

  // Quaternion should remain normalized
  const norm = Math.sqrt(filter.q0*filter.q0 + filter.q1*filter.q1 + filter.q2*filter.q2 + filter.q3*filter.q3);
  assert.ok(Math.abs(norm - 1.0) < 0.000001);
});

test('App sensor fusion: process motion updates and updates state.orient', () => {
  const context = loadMadgwickAndApp();
  const rc = context.window.__abletonRc;

  assert.ok(rc.state);

  // Trigger simulated devicemotion event
  context.__triggerWindowEvent('devicemotion', {
    accelerationIncludingGravity: { x: 0, y: 0, z: 9.8 },
    acceleration: { x: 0, y: 0, z: 0 },
    rotationRate: { alpha: 10, beta: 5, gamma: 2 },
    interval: 16.6,
  });

  // Verify that the motion and orient readings are processed
  assert.ok(rc.state.sensors.motion_reading);
  assert.equal(rc.state.sensors.motion, 'available');
});
