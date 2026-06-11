import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';

function loadEngineAndApp() {
  const engineFile = path.join(import.meta.dirname, 'mode-engine.js');
  const engineSource = fs.readFileSync(engineFile, 'utf8');

  const appFile = path.join(import.meta.dirname, 'app.js');
  const appSource = fs.readFileSync(appFile, 'utf8');

  const controlsFile = path.join(import.meta.dirname, 'controls.js');
  const controlsSource = fs.readFileSync(controlsFile, 'utf8');

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
          toggle: () => {},
          contains: () => false,
        },
        style: {
          setProperty: () => {},
          removeProperty: () => {},
        },
        addEventListener: () => {},
        clientHeight: 100,
        getBoundingClientRect: () => ({ top: 0, height: 100 }),
        dataset: { padModeSet: 'A' },
        setAttribute: () => {},
        querySelector: (sel) => getMockElement(sel),
        getContext: () => ({
          clearRect: () => {},
          beginPath: () => {},
          arc: () => {},
          fill: () => {},
          stroke: () => {},
          moveTo: () => {},
          lineTo: () => {},
          fillText: () => {},
          setLineDash: () => {},
          createRadialGradient: () => ({ addColorStop: () => {} }),
        }),
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
      body: { dataset: {} },
      addEventListener: (evt, cb) => { docListeners[evt] = cb; },
      removeEventListener: () => {},
      getElementById: getMockElement,
      querySelector: (sel) => getMockElement(sel),
      querySelectorAll: (sel) => [getMockElement('pad-1')],
    },
    navigator: navigatorMock,
    localStorage: {
      getItem: () => null,
      setItem: () => {},
      removeItem: () => {},
    },
    WebSocket: WebSocketMock,
    Event: class { constructor(t) { this.type = t; } },
    CustomEvent: class { constructor(t, o) { this.type = t; this.detail = o?.detail; } },
    requestAnimationFrame: () => {},
    isSecureContext: true,
    performance: {
      now: () => Date.now(),
    },
    location: {
      protocol: 'https:',
      host: 'localhost:8080',
    },
    addEventListener: (evt, cb) => { listeners[evt] = cb; },
    setInterval: () => {},
    setTimeout: (cb, delay) => { cb(); },
    currentControlStates: {},
    dispatchEvent: () => {},
    __triggerDocEvent: (evt, e) => { if (docListeners[evt]) docListeners[evt](e); },
    __triggerWindowEvent: (evt, e) => { if (listeners[evt]) listeners[evt](e); },
  };
  windowContext.window = windowContext;

  vm.runInNewContext(engineSource, windowContext, { filename: engineFile });
  vm.runInNewContext(appSource, windowContext, { filename: appFile });
  vm.runInNewContext(controlsSource, windowContext, { filename: controlsFile });
  
  return windowContext;
}

test('Touch pressure: updates state.touches with correct force and pressure value', () => {
  const context = loadEngineAndApp();
  const rc = context.window.__abletonRc;

  // Trigger window touch start event with mock force/pressure
  context.__triggerDocEvent('touchstart', {
    touches: [
      { identifier: 1, clientX: 100, clientY: 150, force: 0.8 }
    ]
  });

  assert.ok(rc.state.touches.length > 0);
  assert.equal(rc.state.touches[0].force, 0.8);
});

test('PointerEvent pressure: tracks active pointer pressures and translates them to touches', () => {
  const context = loadEngineAndApp();
  const rc = context.window.__abletonRc;

  // Trigger pointerdown with touch type and pressure
  context.__triggerWindowEvent('pointerdown', {
    pointerId: 2,
    pointerType: 'touch',
    pressure: 0.65,
  });

  // Trigger window touch start event for touch identifier 2
  context.__triggerDocEvent('touchstart', {
    touches: [
      { identifier: 2, clientX: 200, clientY: 300 }
    ]
  });

  assert.ok(rc.state.touches.length > 0);
  assert.equal(rc.state.touches[0].force, 0.65);
});

test('Two-finger swipe/pinch: detects initial contact and emits pinch and rotate controls', () => {
  const context = loadEngineAndApp();

  let lastEmittedControl = null;
  context.window.onControl = (ctrl) => {
    lastEmittedControl = ctrl;
  };

  // Trigger two-finger touchstart
  context.__triggerDocEvent('touchstart', {
    touches: [
      { identifier: 1, clientX: 100, clientY: 100 },
      { identifier: 2, clientX: 200, clientY: 200 }
    ],
    changedTouches: []
  });

  // Trigger two-finger touchmove (separated further apart for pinch)
  context.__triggerDocEvent('touchmove', {
    touches: [
      { identifier: 1, clientX: 50, clientY: 50 },
      { identifier: 2, clientX: 250, clientY: 250 }
    ],
    changedTouches: []
  });

  assert.ok(lastEmittedControl);
});
