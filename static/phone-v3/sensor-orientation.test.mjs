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

function loadApp() {
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

  let vibrateCalls = 0;
  const navigatorMock = {
    onLine: true,
    vibrate: () => { vibrateCalls += 1; },
    wakeLock: null,
  };

  const sockets = [];
  class WebSocketMock {
    static OPEN = 1;

    constructor(url) {
      this.url = url;
      this.readyState = 0;
      this.sent = [];
      sockets.push(this);
    }
    send(data) { this.sent.push(JSON.parse(data)); }
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
    __getVibrateCalls: () => vibrateCalls,
    __getSockets: () => sockets,
    __triggerDocEvent: (evt, e) => { if (docListeners[evt]) docListeners[evt](e); },
    __triggerWindowEvent: (evt, e) => { if (listeners[evt]) listeners[evt](e); },
  };
  windowContext.window = windowContext;

  // Run App script
  vm.runInNewContext(appSource, windowContext, { filename: appFile });
  
  return windowContext;
}

function completeHandshake(context) {
  const socket = context.__getSockets()[0];
  assert.ok(socket, 'expected app.js to create a WebSocket');
  socket.readyState = context.WebSocket.OPEN;
  socket.onopen();
  socket.onmessage({
    data: JSON.stringify({ type: 'hello', client_id: 'client-1' }),
  });
  socket.sent = [];
  return socket;
}

test('Performance controls are queued into state.controls and do not send an immediate message', () => {
  const context = loadApp();
  const socket = completeHandshake(context);

  context.window.onControl({ name: 'button-1', value: 1 });

  // Performance controls are no longer sent as an immediate `type: 'control'`
  // message: they are written to state.controls and dispatched by the 33ms
  // snapshot loop. This avoids double-send (immediate + snapshot) and the
  // duplicated applyMapping/appendHistory calls on the server.
  const sentImmediate = socket.sent.some((msg) => {
    const parsed = JSON.parse(msg);
    return parsed.type === 'control';
  });
  assert.equal(sentImmediate, false, 'expected no immediate control message');

  // The value must still be staged in state.controls for the next snapshot.
  const state = context.window.__abletonRc.state;
  const staged = state.controls.find((c) => c.name === 'button-1');
  assert.ok(staged, 'expected button-1 in state.controls');
  assert.equal(staged.value, 1);
});

test('Modulator state sends an immediate host-modulator message after handshake', () => {
  const context = loadApp();
  const socket = completeHandshake(context);

  context.window.onModulatorState({
    kind: 'stutter',
    name: 'button-1',
    active: true,
    rate: 1,
    count: 1,
    morphMs: 1000,
    syncMode: 'free',
  });

  assert.deepEqual(socket.sent.at(-1), {
    type: 'modulator',
    client_id: 'client-1',
    ts: socket.sent.at(-1).ts,
    modulator: {
      kind: 'stutter',
      name: 'button-1',
      active: true,
      rate: 1,
      count: 1,
      morphMs: 1000,
      syncMode: 'free',
    },
  });
  assert.equal(typeof socket.sent.at(-1).ts, 'number');
});

test('Direct Orientation: deviceorientation event writes raw values to state.orient directly', () => {
  const context = loadApp();
  const rc = context.window.__abletonRc;

  assert.ok(rc.state);
  assert.equal(rc.state.orient, null);

  // Trigger simulated deviceorientation event
  context.__triggerWindowEvent('deviceorientation', {
    alpha: 120.5,
    beta: -45.2,
    gamma: 15.8,
    absolute: true,
  });

  // Verify direct mapping with no transformation/smoothing
  assert.ok(rc.state.orient);
  assert.equal(rc.state.orient.alpha, 239.5);
  assert.equal(rc.state.orient.beta, -45.2);
  assert.equal(rc.state.orient.gamma, 15.8);

  assert.ok(rc.state.sensors.orientation_reading);
  assert.equal(rc.state.sensors.orientation_reading.alpha, 239.5);
  assert.equal(rc.state.sensors.orientation_reading.beta, -45.2);
  assert.equal(rc.state.sensors.orientation_reading.gamma, 15.8);
  assert.equal(rc.state.sensors.orientation, 'available');
});

test('Direct Motion: devicemotion event writes raw acceleration and rotationRate directly to state.motion', () => {
  const context = loadApp();
  const rc = context.window.__abletonRc;

  // Trigger simulated devicemotion event
  context.__triggerWindowEvent('devicemotion', {
    accelerationIncludingGravity: { x: 1.2, y: -2.3, z: 9.8 },
    acceleration: { x: 0.1, y: 0.2, z: 0.3 },
    rotationRate: { alpha: 45.0, beta: -12.5, gamma: 90.0 },
    interval: 16.6,
  });

  // Verify direct mapping
  assert.ok(rc.state.motion);
  assert.equal(rc.state.motion.ax, 1.2);
  assert.equal(rc.state.motion.ay, -2.3);
  assert.equal(rc.state.motion.az, 9.8);
  assert.equal(rc.state.motion.gx, 45.0);
  assert.equal(rc.state.motion.gy, -12.5);
  assert.equal(rc.state.motion.gz, 90.0);
  assert.equal(rc.state.sensors.motion, 'available');
});

test('Calibration: zero button click triggers calibrateHorizon and sets offsets on the next deviceorientation event', () => {
  const context = loadApp();
  const rc = context.window.__abletonRc;

  // Initial event
  context.__triggerWindowEvent('deviceorientation', {
    alpha: 100,
    beta: 20,
    gamma: -10,
    absolute: true,
  });

  assert.equal(rc.state.orient.alpha, 260);

  // Trigger calibration
  rc.calibrateHorizon();
  assert.equal(context.__getVibrateCalls(), 0);

  // Next event sets the offsets
  context.__triggerWindowEvent('deviceorientation', {
    alpha: 110,
    beta: 25,
    gamma: -5,
    absolute: true,
  });

  // Since we calibrated at (110, 25, -5), the values should offset to (0, 0, 0)
  assert.equal(rc.state.calibration.offsets.alpha, 250);
  assert.equal(rc.state.calibration.offsets.beta, 25);
  assert.equal(rc.state.calibration.offsets.gamma, -5);

  assert.equal(rc.state.orient.alpha, 180);
  assert.equal(rc.state.orient.beta, 0);
  assert.equal(rc.state.orient.gamma, 0);

  // Subsequent event relative to offset
  context.__triggerWindowEvent('deviceorientation', {
    alpha: 120,
    beta: 35,
    gamma: 0,
    absolute: true,
  });

  assert.equal(rc.state.orient.alpha, 170);
  assert.equal(rc.state.orient.beta, 10);
  assert.equal(rc.state.orient.gamma, 5);
});

test('Calibration: reset button clears offsets back to zero', () => {
  const context = loadApp();
  const rc = context.window.__abletonRc;

  // Set non-zero offsets
  rc.state.calibration.offsets = { alpha: 50, beta: 10, gamma: -5 };

  // Clear offsets
  rc.state.calibration.offsets = { alpha: 0, beta: 0, gamma: 0 };
  
  context.__triggerWindowEvent('deviceorientation', {
    alpha: 120,
    beta: -45,
    gamma: 15,
    absolute: true,
  });

  assert.equal(rc.state.orient.alpha, 240);
  assert.equal(rc.state.orient.beta, -45);
  assert.equal(rc.state.orient.gamma, 15);
});

test('Direct Orientation: derives beta and gamma from state.motion if accelerometer values are available', () => {
  const context = loadApp();
  const rc = context.window.__abletonRc;

  // Set accelerometer values (e.g. phone tilted forward Z-accel, tilted right X-accel)
  // ax = 4.9 (roll), az = -4.9 (pitch)
  context.__triggerWindowEvent('devicemotion', {
    accelerationIncludingGravity: { x: 4.9, y: 9.8, z: -4.9 },
    acceleration: { x: 0, y: 0, z: 0 },
    rotationRate: { alpha: 0, beta: 0, gamma: 0 },
    interval: 16.6,
  });

  // Now trigger deviceorientation
  context.__triggerWindowEvent('deviceorientation', {
    alpha: 100,
    beta: 20,
    gamma: -10,
    absolute: true,
  });

  // beta = -az * 9.18 = 45 degrees
  assert.ok(Math.abs(rc.state.orient.beta - 45) < 0.1, `beta was ${rc.state.orient.beta}`);
  // gamma = ax * 18.36 = 90 degrees
  assert.ok(Math.abs(rc.state.orient.gamma - 90) < 0.1, `gamma was ${rc.state.orient.gamma}`);
});

test('XY pads, knobs, and faders are queued into state.controls and do not send immediate messages', () => {
  const context = loadApp();
  const socket = completeHandshake(context);

  const state = context.window.__abletonRc.state;
  const initialSent = socket.sent.length;

  context.window.onControl({ name: 'xy-1', x: 0.25, y: 0.75 });
  context.window.onControl({ name: 'knob-1', value: 0.42 });
  context.window.onControl({ name: 'fader-2', value: 0.88 });

  // All three should be queued in state.controls but no immediate `control`
  // message should be on the wire.
  const sentAfter = socket.sent.slice(initialSent).filter((msg) => {
    return JSON.parse(msg).type === 'control';
  });
  assert.equal(sentAfter.length, 0, 'expected no immediate control messages for performance controls');

  const xy = state.controls.find((c) => c.name === 'xy-1');
  assert.ok(xy, 'expected xy-1 in state.controls');
  assert.equal(xy.x, 0.25);
  assert.equal(xy.y, 0.75);

  const knob = state.controls.find((c) => c.name === 'knob-1');
  assert.ok(knob, 'expected knob-1 in state.controls');
  assert.equal(knob.value, 0.42);

  const fader = state.controls.find((c) => c.name === 'fader-2');
  assert.ok(fader, 'expected fader-2 in state.controls');
  assert.equal(fader.value, 0.88);
});

