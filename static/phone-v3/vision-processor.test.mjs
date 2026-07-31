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

test('VisionProcessor: MediaPipe dependencies are bundled locally for offline use', () => {
  const source = fs.readFileSync(path.join(import.meta.dirname, 'vision-processor.js'), 'utf8');
  const buildSource = fs.readFileSync(path.join(import.meta.dirname, '..', '..', 'build.ts'), 'utf8');
  assert.match(source, /vendor\/mediapipe\/camera_utils\/camera_utils\.js/);
  assert.match(source, /vendor\/mediapipe\/hands\/hands\.js/);
  assert.doesNotMatch(source, /cdn\.jsdelivr\.net/);
  assert.match(buildSource, /node_modules["', ]+, ["']@mediapipe/);
});

function loadVisionProcessor() {
  const file = path.join(import.meta.dirname, 'vision-processor.js');
  const source = fs.readFileSync(file, 'utf8');
  const safeSource = fs.readFileSync(path.join(import.meta.dirname, 'safe-input-layer.js'), 'utf8');
  const cameraSource = fs.readFileSync(path.join(import.meta.dirname, 'camera-lifecycle.js'), 'utf8');

  // Stub MediaPipe Hands and Camera
  class HandsMock {
    constructor(config) {
      HandsMock.instance = this;
      this.config = config;
      this.options = {};
    }
    setOptions(opts) {
      this.options = opts;
    }
    onResults(cb) {
      this.resultsCallback = cb;
    }
    send(data) {
      this.sentData = data;
      return Promise.resolve();
    }
    close() {
      this.closed = true;
    }
  }

  class CameraMock {
    constructor(video, config) {
      CameraMock.instance = this;
      this.video = video;
      this.config = config;
    }
    start() {
      CameraMock.startCalls = (CameraMock.startCalls || 0) + 1;
      if (CameraMock.failNext) {
        const error = CameraMock.failNext;
        CameraMock.failNext = null;
        return Promise.reject(error);
      }
      this.started = true;
      return Promise.resolve();
    }
    stop() {
      this.stopped = true;
    }
  }

  const windowContext = {
    window: null,
    globalThis: {},
    document: {
      createElement: (tag) => {
        return {
          onload: null,
          onerror: null,
          set src(val) {
            // Simulate script load asynchronously
            setTimeout(() => {
              if (val.includes('hands.js')) {
                windowContext.Hands = HandsMock;
              } else if (val.includes('camera_utils.js')) {
                windowContext.Camera = CameraMock;
              }
              if (this.onload) this.onload();
            }, 5);
          }
        };
      },
      head: {
        appendChild: () => {}
      }
    },
    Hands: null,
    Camera: null,
  };
  windowContext.window = windowContext;
  windowContext.globalThis = windowContext;

  vm.runInNewContext(safeSource, windowContext, { filename: 'safe-input-layer.js' });
  vm.runInNewContext(cameraSource, windowContext, { filename: 'camera-lifecycle.js' });
  vm.runInNewContext(source, windowContext, { filename: file });

  return {
    VisionProcessor: windowContext.VisionProcessor,
    windowContext,
    HandsMock,
    CameraMock
  };
}

test('VisionProcessor: lifecycle load, start, process, stop', async () => {
  const { VisionProcessor, windowContext, HandsMock, CameraMock } = loadVisionProcessor();
  assert.ok(VisionProcessor);

  const vp = new VisionProcessor();

  // Set up mock elements
  const mockVideo = {};
  const mockCanvas = {
    width: 320,
    height: 240,
    getContext: () => ({
      save: () => {},
      restore: () => {},
      clearRect: () => {},
      drawImage: () => {},
      beginPath: () => {},
      arc: () => {},
      moveTo: () => {},
      lineTo: () => {},
      stroke: () => {},
      fill: () => {},
    })
  };

  let handUpdateData = null;
  vp.onHandUpdate = (data) => {
    handUpdateData = data;
  };

  // Start the processor (triggers dynamic script loading and camera start)
  await vp.start(mockVideo, mockCanvas);

  assert.ok(vp.active);
  assert.ok(HandsMock.instance);
  assert.ok(CameraMock.instance);
  assert.ok(CameraMock.instance.started);
  // 320x240, not the old 160x120: at that size a fast-moving hand was a few
  // blurred pixels and MediaPipe dropped it mid-gesture.
  assert.equal(CameraMock.instance.config.width, 320);
  assert.equal(CameraMock.instance.config.height, 240);
  assert.equal(HandsMock.instance.options.maxNumHands, 1);

  // Simulate MediaPipe results callback with handedness metadata so the
  // processor can attribute the reading to "Right".
  const mockLandmarks = makeOpenHand();

  HandsMock.instance.resultsCallback({
    image: {},
    multiHandLandmarks: [mockLandmarks],
    multiHandedness: [{ label: 'Right' }]
  });

  assert.ok(handUpdateData);
  // Open hand → 5 stretched fingers, no fist/pinch, x/y from palm center.
  assert.equal(handUpdateData.active, true);
  assert.equal(handUpdateData.fist, false);
  assert.equal(handUpdateData.open, true);
  // fingers normalized to 1.0 (= 5 raised / 5)
  assert.equal(handUpdateData.fingers, 1);

  // Now simulate a fist (all fingertips collapsed near wrist)
  const fistLandmarks = makeOpenHand();
  [4, 8, 12, 16, 20].forEach((tip) => {
    fistLandmarks[tip] = { x: 0.4, y: 0.75, z: 0.0 };
  });
  HandsMock.instance.resultsCallback({
    image: {},
    multiHandLandmarks: [fistLandmarks],
    multiHandedness: [{ label: 'Right' }]
  });

  assert.equal(handUpdateData.fist, true);
  assert.equal(handUpdateData.open, false);
  assert.ok(handUpdateData.fingers <= 1, `expected <=1 stretched finger, got ${handUpdateData.fingers}`);

  // Stop the processor
  vp.stop();
  assert.equal(vp.active, false);
  assert.ok(CameraMock.instance.stopped);
});

test('VisionProcessor: a failed camera start cleans up and a retry really reacquires it', async () => {
  const { VisionProcessor, CameraMock } = loadVisionProcessor();
  const vp = new VisionProcessor();
  const cameraError = Object.assign(new Error('Could not start video source'), { name: 'NotReadableError' });
  CameraMock.startCalls = 0;
  CameraMock.failNext = cameraError;
  await assert.rejects(vp.start({}, { getContext: () => null }), cameraError);
  assert.equal(vp.active, false);
  await vp.start({}, { getContext: () => null });
  assert.equal(vp.active, true);
  assert.equal(CameraMock.startCalls, 2);
  vp.stop();
});

test('Managed camera releases a stream that arrives after stop and restarts cleanly', async () => {
  const { windowContext } = loadVisionProcessor();
  const ManagedCameraSession = windowContext.ManagedCameraSession;
  assert.equal(typeof ManagedCameraSession, 'function');

  let resolveFirst;
  const firstTrack = { readyState: 'live', stopped: false, stop() { this.stopped = true; this.readyState = 'ended'; } };
  const secondTrack = { readyState: 'live', stopped: false, stop() { this.stopped = true; this.readyState = 'ended'; } };
  const firstStream = { getTracks: () => [firstTrack], getVideoTracks: () => [firstTrack] };
  const secondStream = { getTracks: () => [secondTrack], getVideoTracks: () => [secondTrack] };
  let acquisitions = 0;
  windowContext.navigator = {
    mediaDevices: {
      getUserMedia: () => {
        acquisitions += 1;
        if (acquisitions === 1) return new Promise((resolve) => { resolveFirst = resolve; });
        return Promise.resolve(secondStream);
      },
    },
  };
  windowContext.requestAnimationFrame = () => 17;
  windowContext.cancelAnimationFrame = () => {};
  const video = {
    srcObject: null,
    paused: false,
    readyState: 4,
    play: () => Promise.resolve(),
    pause() { this.paused = true; },
  };
  const camera = new ManagedCameraSession(video, { width: 160, height: 120, onFrame: async () => {} });

  const pendingStart = camera.start();
  camera.stop();
  resolveFirst(firstStream);
  await assert.rejects(pendingStart, /cancel/i);
  assert.equal(firstTrack.stopped, true);
  assert.equal(video.srcObject, null);

  video.paused = false;
  await camera.start();
  assert.equal(video.srcObject, secondStream);
  camera.stop();
  assert.equal(secondTrack.stopped, true);
  assert.equal(video.srcObject, null);
});

test('Managed camera starts playback when mobile loadeddata never fires', async () => {
  const { windowContext } = loadVisionProcessor();
  const ManagedCameraSession = windowContext.ManagedCameraSession;
  const track = { stop() {} };
  const stream = { getTracks: () => [track], getVideoTracks: () => [track] };
  windowContext.navigator = { mediaDevices: { getUserMedia: async () => stream } };
  windowContext.requestAnimationFrame = () => 99;
  windowContext.cancelAnimationFrame = () => {};
  windowContext.setTimeout = (callback) => {
    setImmediate(callback);
    return 1;
  };
  windowContext.clearTimeout = () => {};
  let readinessListeners = 0;
  let playCalls = 0;
  const video = {
    srcObject: null,
    readyState: 0,
    muted: false,
    playsInline: false,
    addEventListener(name) {
      if (name === 'loadeddata' || name === 'error') readinessListeners += 1;
    },
    removeEventListener() {},
    async play() {
      playCalls += 1;
      this.readyState = 2;
    },
    pause() {},
  };
  const camera = new ManagedCameraSession(video, { onFrame: async () => {} });

  await camera.start();
  assert.equal(playCalls, 1);
  assert.equal(readinessListeners, 0);
  assert.equal(video.muted, true);
  assert.equal(video.playsInline, true);
  assert.equal(video.srcObject, stream);
  assert.equal(camera.running, true);
  camera.stop();
});

test('VisionProcessor uses the managed camera lifecycle when getUserMedia is available', async () => {
  const { VisionProcessor, windowContext, CameraMock } = loadVisionProcessor();
  const track = { stopped: false, stop() { this.stopped = true; } };
  const stream = { getTracks: () => [track], getVideoTracks: () => [track] };
  windowContext.navigator = { mediaDevices: { getUserMedia: async () => stream } };
  windowContext.requestAnimationFrame = () => 31;
  windowContext.cancelAnimationFrame = () => {};
  CameraMock.startCalls = 0;
  const video = {
    srcObject: null,
    play: async () => {},
    pause: () => {},
  };
  const vp = new VisionProcessor();

  await vp.start(video, { getContext: () => null });
  assert.equal(video.srcObject, stream);
  assert.equal(CameraMock.startCalls, 0);
  vp.stop();
  assert.equal(track.stopped, true);
  assert.equal(video.srcObject, null);
});

test('VisionProcessor requests the native camera before first-load MediaPipe dependencies finish', async () => {
  const { VisionProcessor, windowContext } = loadVisionProcessor();
  const track = { stop() {} };
  const stream = { getTracks: () => [track], getVideoTracks: () => [track] };
  let acquisitions = 0;
  windowContext.navigator = {
    mediaDevices: {
      getUserMedia: async () => {
        acquisitions += 1;
        return stream;
      },
    },
  };
  windowContext.requestAnimationFrame = () => 41;
  windowContext.cancelAnimationFrame = () => {};
  const video = { srcObject: null, play: async () => {}, pause: () => {} };
  const vp = new VisionProcessor();

  const starting = vp.start(video, { getContext: () => null });
  assert.equal(acquisitions, 1, 'camera acquisition must begin in the original user activation');
  await starting;
  vp.stop();
});

test('VisionProcessor: ambient color detection processes canvas frames and calculates average RGB', async () => {
  const { VisionProcessor, HandsMock } = loadVisionProcessor();
  const vp = new VisionProcessor();

  const mockVideo = {};
  const mockCanvas = {
    width: 160,
    height: 120,
    getContext: () => ({
      save: () => {},
      restore: () => {},
      clearRect: () => {},
      drawImage: () => {},
      getImageData: () => {
        const data = new Uint8ClampedArray(160 * 120 * 4);
        for (let i = 0; i < data.length; i += 4) {
          data[i] = 255;
          data[i + 1] = 127;
          data[i + 2] = 0;
          data[i + 3] = 255;
        }
        return { data };
      }
    })
  };

  let colorUpdateData = null;
  vp.onColorUpdate = (data) => {
    colorUpdateData = data;
  };

  await vp.start(mockVideo, mockCanvas);

  HandsMock.instance.resultsCallback({
    image: {},
    multiHandLandmarks: []
  });

  assert.ok(colorUpdateData);
  assert.ok(Math.abs(colorUpdateData.r - 1.0) < 0.01);
  assert.ok(Math.abs(colorUpdateData.g - 0.498) < 0.01);
  assert.ok(Math.abs(colorUpdateData.b - 0.0) < 0.01);

  vp.stop();
});

function loadVisionAndApp() {
  const vpFile = path.join(import.meta.dirname, 'vision-processor.js');
  const vpSource = fs.readFileSync(vpFile, 'utf8');

  const appFile = path.join(import.meta.dirname, 'app.js');
  const appSource = fs.readFileSync(appFile, 'utf8');

  // Stubs for MediaPipe Hands and Camera
  class HandsMock {
    constructor(config) {
      HandsMock.instance = this;
      this.config = config;
    }
    setOptions() {}
    onResults(cb) {
      this.resultsCallback = cb;
    }
    close() {}
  }

  class CameraMock {
    constructor(video, config) {
      CameraMock.instance = this;
      // Keep the options so tests can drive the frame loop by hand; the real
      // camera_utils Camera invokes config.onFrame() per presented frame.
      this.config = config;
    }
    start() {
      CameraMock.startCalls = (CameraMock.startCalls || 0) + 1;
      if (CameraMock.failNext) {
        const error = CameraMock.failNext;
        CameraMock.failNext = null;
        return Promise.reject(error);
      }
      return Promise.resolve();
    }
    stop() {}
  }

  const mockElements = {};
  const getMockElement = (id) => {
    if (!mockElements[id]) {
      const el = {
        textContent: '',
        checked: false,
        className: '',
        style: {},
        addEventListener: function(evt, cb) {
          this[`on${evt}`] = cb;
        },
        getContext: () => ({
          save: () => {},
          restore: () => {},
          clearRect: () => {},
          drawImage: () => {},
          beginPath: () => {},
          arc: () => {},
          moveTo: () => {},
          lineTo: () => {},
          stroke: () => {},
          fill: () => {},
        }),
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
      body: { dataset: {} },
      getElementById: getMockElement,
      querySelector: getMockElement,
      querySelectorAll: () => [getMockElement('pad-1')],
      addEventListener: () => {},
      removeEventListener: () => {},
      createElement: (tag) => {
        return {
          onload: null,
          onerror: null,
          set src(val) {
            setTimeout(() => {
              windowContext.Hands = HandsMock;
              windowContext.Camera = CameraMock;
              if (this.onload) this.onload();
            }, 5);
          }
        };
      },
      head: {
        appendChild: () => {}
      }
    },
    navigator: {
      vibrate: () => {},
    },
    currentTime: Date.now(),
    Date: {
      now: () => windowContext.currentTime
    },
    performance: { now: () => windowContext.currentTime },
    isSecureContext: true,
    location: {
      protocol: 'https:',
      host: 'localhost:8080',
    },
    requestAnimationFrame: () => 1,
    cancelAnimationFrame: () => {},
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
    setInterval: (cb, delay) => {
      if (delay === 33) {
        windowContext.lastIntervalCallback = cb;
      }
    },
    setTimeout: (cb, delay) => { cb(); },
    dispatchEvent: () => {},
    Hands: null,
    Camera: null,
  };
  windowContext.window = windowContext;
  windowContext.globalThis = windowContext;

  // Provide window.RCSurface stub so app.js can call initSession() without crashing.
  windowContext.RCSurface = {
    initSession: (opts = {}) => {},
    getMappingModeActive: () => false,
    getTelemetryThrottleUntil: () => 0,
    _setStatus: () => {},
    _connect: () => {},
  };
  windowContext.isPhoneMappingModeActive = () => false;
  windowContext.setPhoneMappingModeActive = () => {};
  windowContext.throttlePhoneTelemetry = () => {};
  windowContext.getPhoneClientId = () => null;
  windowContext.sendPhoneCommand = () => false;

  const visionStateFile = path.join(import.meta.dirname, 'vision-control-state.js');
  vm.runInNewContext(fs.readFileSync(visionStateFile, 'utf8'), windowContext, { filename: visionStateFile });
  vm.runInNewContext(vpSource, windowContext, { filename: vpFile });
  vm.runInNewContext(appSource, windowContext, { filename: appFile });

  return { windowContext, mockElements, HandsMock, CameraMock };
}

test('VisionProcessor integration: setupVisionUI initializes checkbox and updates HUD', async () => {
  const { windowContext, mockElements, HandsMock } = loadVisionAndApp();

  const chk = mockElements['chk-vision-enable'];
  assert.ok(chk);

  // Trigger change event to enable vision
  chk.checked = true;
  await chk.onchange(); // calls startVision() inside setupVisionUI

  // Verify HUD classList had 'hidden' removed
  assert.equal(mockElements['vision-hud'].className, '');

  // Stop vision
  chk.checked = false;
  chk.onchange(); // calls stopVision()

  assert.equal(mockElements['vision-hud'].className, 'hidden');
});

test('VisionProcessor integration: a busy camera renders inline error and retry succeeds', async () => {
  const { mockElements, CameraMock } = loadVisionAndApp();
  const chk = mockElements['chk-vision-enable'];
  CameraMock.startCalls = 0;
  CameraMock.failNext = Object.assign(new Error('Could not start video source'), { name: 'NotReadableError' });
  chk.checked = true;
  await chk.onchange();
  assert.equal(chk.checked, false);
  assert.equal(mockElements['vision-camera-state-title'].textContent, 'CAMERA BUSY');
  assert.equal(mockElements['.vision-camera-stage'].className, 'camera-error');
  chk.checked = true;
  await chk.onchange();
  assert.equal(mockElements['.vision-camera-stage'].className, 'camera-active');
  assert.equal(CameraMock.startCalls, 2);
});

test('VisionProcessor integration: hand active status and mappable X/Y/Z follow detection and loss', async () => {
  const { windowContext, mockElements, HandsMock } = loadVisionAndApp();

  const chk = mockElements['chk-vision-enable'];
  assert.ok(chk);

  // Enable vision
  chk.checked = true;
  await chk.onchange();

  // Wait for HandsMock.instance to initialize asynchronously
  for (let i = 0; i < 20; i++) {
    if (HandsMock.instance) break;
    await new Promise(resolve => setTimeout(resolve, 5));
  }

  assert.ok(HandsMock.instance, "HandsMock.instance was not initialized");

  // 1. Simulate hand detected. Direct X/Y/Z measurements remain mappable
  // even though calibrated/predicted spatial tracking is retired.
  const mockLandmarks = [];
  for (let i = 0; i < 21; i++) {
    mockLandmarks.push({ x: 0.5, y: 0.5, z: 0.0 });
  }
  mockLandmarks[0] = { x: 0.4, y: 0.8, z: 0.0 }; // wrist
  mockLandmarks[5] = { x: 0.3, y: 0.4, z: 0.0 }; // index mcp
  mockLandmarks[17] = { x: 0.5, y: 0.4, z: 0.0 }; // pinky mcp
  mockLandmarks[9] = { x: 0.4, y: 0.4, z: 0.0 }; // middle mcp
  [8, 12, 16, 20].forEach((tip) => {
    mockLandmarks[tip] = { x: 0.4, y: 0.1, z: 0.0 };
  });

  HandsMock.instance.resultsCallback({
    image: {},
    multiHandLandmarks: [mockLandmarks],
    multiHandedness: [{ label: 'Right' }]
  });

  assert.equal(windowContext.currentControlStates['sensor.vision.active'], 1);
  for (const axis of ['x', 'y', 'z']) {
    assert.equal(typeof windowContext.currentControlStates[`sensor.vision.${axis}`], 'number');
  }
  // MCP-based rotateVal lives on the hand state. The wire only carries
  // it when the Victory detector is opted in, which is the default the
  // panel uses, but the integration test does not toggle detectors —
  // assert on the state instead.
  assert.equal(typeof windowContext.state.vision.hand.rotateVal, 'number');

  // 2. Simulate hand lost
  const startTime = 1000;
  windowContext.currentTime = startTime;

  HandsMock.instance.resultsCallback({
    image: {},
    multiHandLandmarks: [],
    multiHandedness: []
  });

  assert.ok(windowContext.lastIntervalCallback, "setInterval callback was not captured");

  // Tick the decay loop once and assert the hand flag flipped off.
  windowContext.currentTime = startTime + 150;
  windowContext.lastIntervalCallback();

  assert.equal(windowContext.currentControlStates['sensor.vision.active'], 0);
  // Built-in gesture detectors are opt-in; a disabled detector must stay
  // completely off the output stream instead of producing noisy zeroes.
  assert.equal(windowContext.currentControlStates['sensor.vision.fist'], undefined);

  // Tick 2: 300ms after loss (fully decayed). With spatial tracking
  // retired there is nothing to decay toward a neutral; the only
  // state change is that `sensor.vision.active` is now 0.
  windowContext.currentTime = startTime + 300;
  windowContext.lastIntervalCallback();

  assert.equal(windowContext.currentControlStates['sensor.vision.active'], 0);
});

// Build a synthetic 21-landmark "open hand" in the same coordinates used
// across the original test suite. All fingertips are stretched far from the
// wrist so every stretch ratio should land well above 0.65.
function makeOpenHand() {
  const lms = [];
  for (let i = 0; i < 21; i++) lms.push({ x: 0.5, y: 0.5, z: 0.0 });
  lms[0] = { x: 0.4, y: 0.8, z: 0.0 }; // wrist
  lms[5] = { x: 0.3, y: 0.4, z: 0.0 }; // index mcp
  lms[17] = { x: 0.5, y: 0.4, z: 0.0 }; // pinky mcp
  lms[9] = { x: 0.4, y: 0.4, z: 0.0 }; // middle mcp (sets palmSize)
  // Extend every fingertip far from the wrist to maximize stretch.
  // Thumb tip sits laterally (smaller x) so the open hand is anatomically
  // plausible and the thumb-to-index distance stays large enough that the
  // analog pinchVal stays near 0 instead of spuriously saturating to 1.
  lms[4] = { x: 0.2, y: 0.1, z: 0.0 };
  [8, 12, 16, 20].forEach((tip) => {
    lms[tip] = { x: 0.4, y: 0.1, z: 0.0 };
  });
  return lms;
}

test('dist3D computes Euclidean distance between two landmarks', () => {
  const { windowContext } = loadVisionProcessor();
  // 3-4-5 triangle: sqrt(3² + 4² + 0²) = 5
  assert.equal(
    windowContext.dist3D({ x: 0, y: 0, z: 0 }, { x: 3, y: 4, z: 0 }),
    5
  );
  // 1-2-2: sqrt(1 + 4 + 4) = 3
  assert.equal(
    windowContext.dist3D({ x: 1, y: 2, z: 2 }, { x: 0, y: 0, z: 0 }),
    3
  );
});

test('computeHandData: open hand reports 5 stretched fingers and no fist', () => {
  const { windowContext } = loadVisionProcessor();
  const data = windowContext.computeHandData(makeOpenHand());
  // Every finger stretched beyond 0.65 → open + fingers normalized to 1.0
  // (5 raised / 5). The PC panel multiplies this back by 5 for display.
  assert.equal(data.open, true);
  assert.equal(data.fist, false);
  assert.equal(data.fingers, 1);
  assert.ok(data.thumb > 0.65);
  assert.ok(data.index > 0.65);
  assert.ok(data.middle > 0.65);
  assert.ok(data.ring > 0.65);
  assert.ok(data.pinky > 0.65);
  // Palm center mirrored: (1 - avg(0.4, 0.3, 0.5)) = 0.6
  assert.ok(Math.abs(data.x - 0.6) < 0.01);
  assert.ok(Math.abs(data.y - 0.467) < 0.01);
});

test('computeHandData: fist (tips collapsed to wrist) reports fist=true and fingers=0', () => {
  const { windowContext } = loadVisionProcessor();
  const lms = makeOpenHand();
  // Collapse every tip onto the wrist so each finger stretch ratio drops
  // to ~0.0, well below the 0.35 fist threshold for index/middle/ring/pinky.
  lms[4]  = { x: 0.4, y: 0.8, z: 0.0 };
  lms[8]  = { x: 0.4, y: 0.78, z: 0.0 };
  lms[12] = { x: 0.4, y: 0.78, z: 0.0 };
  lms[16] = { x: 0.4, y: 0.78, z: 0.0 };
  lms[20] = { x: 0.4, y: 0.78, z: 0.0 };
  const data = windowContext.computeHandData(lms);
  assert.equal(data.fist, true);
  assert.equal(data.open, false);
  // fingers stays 0 in normalized space (0 raised / 5)
  assert.equal(data.fingers, 0);
  assert.ok(data.index < 0.35);
  assert.ok(data.middle < 0.35);
  assert.ok(data.ring < 0.35);
  assert.ok(data.pinky < 0.35);
});

test('computeHandData: victory gesture (index+middle extended, ring+pinky folded)', () => {
  const { windowContext } = loadVisionProcessor();
  const lms = makeOpenHand();
  // Fold ring (16) and pinky (20) onto the wrist so they're below 0.35.
  lms[16] = { x: 0.4, y: 0.78, z: 0.0 };
  lms[20] = { x: 0.4, y: 0.78, z: 0.0 };
  // Fold the thumb onto the wrist too: classic V-sign has the thumb tucked
  // over the palm, not stretched outward. Without this the thumb stretch
  // ratio stays >0.65 and the finger count jumps to 3.
  lms[4]  = { x: 0.4, y: 0.78, z: 0.0 };
  // Keep index (8) and middle (12) extended far from wrist.
  const data = windowContext.computeHandData(lms);
  assert.equal(data.victory, true);
  assert.equal(data.fist, false);
  // Two raised fingers → 2/5 = 0.4 in normalized wire format
  assert.equal(data.fingers, 0.4);
  assert.ok(data.index > 0.65);
  assert.ok(data.middle > 0.65);
});

test('computeHandData: pinch (thumb tip near index tip) reports pinch=true and pinchVal≈1', () => {
  const { windowContext } = loadVisionProcessor();
  const lms = makeOpenHand();
  // Bring thumb tip (4) onto index tip (8). Tips fully closed → pinchRatio
  // drops near 0 → pinchVal saturates at 1 → boolean pinch gate trips.
  lms[4] = { x: 0.4, y: 0.1, z: 0.0 };
  lms[8] = { x: 0.4, y: 0.1, z: 0.0 };
  const data = windowContext.computeHandData(lms);
  assert.equal(data.pinch, true);
  assert.ok(data.pinchVal > 0.75, `expected pinchVal > 0.75 (gate threshold), got ${data.pinchVal}`);
  assert.ok(data.pinchVal <= 1, `expected pinchVal ≤ 1, got ${data.pinchVal}`);
});

test('computeHandData: pinch halfway between closed and open reports pinchVal between 0 and 1', () => {
  const { windowContext } = loadVisionProcessor();
  const lms = makeOpenHand();
  // Halfway pinch: thumb tip 30% of the way from wrist to index tip.
  // dist(4, 8) ≈ 0.21, palmSize = 0.4, ratio ≈ 0.525 → pinchVal ≈ (0.60-0.525)/0.50 ≈ 0.15.
  lms[4] = { x: 0.4, y: 0.38, z: 0.0 };
  const data = windowContext.computeHandData(lms);
  assert.ok(data.pinchVal >= 0 && data.pinchVal <= 1, `pinchVal out of range: ${data.pinchVal}`);
  // Halfway pinch should NOT trip the gate (pinchVal well below 0.75).
  assert.equal(data.pinch, false);
});

test('computeHandData: open hand has pinchVal near 0 (no pinch)', () => {
  const { windowContext } = loadVisionProcessor();
  const data = windowContext.computeHandData(makeOpenHand());
  // Open hand: thumb and index tips are far apart (palmSize × 1.0+ ratio)
  // → pinchVal collapses well below the 0.75 gate.
  assert.ok(data.pinchVal <= 0.2, `expected pinchVal ≤ 0.2 for open hand, got ${data.pinchVal}`);
  assert.equal(data.pinch, false);
});

// Build a synthetic Victory pose (index + middle extended, thumb/ring/pinky
// folded onto the wrist). The optional `tiltDeg` rotates the palm base —
// the MCP (knuckle) anchors of the index finger (landmark 5) and the
// pinky finger (landmark 17) — around the wrist (landmark 0) so we can
// drive the wrist rotation reading without depending on fingertip
// positions that collapse during Victory.
function makeVictoryHand({ tiltDeg = 0 } = {}) {
  const lms = makeOpenHand();
  // Victory pose: thumb/ring/pinky collapsed onto the wrist; index and
  // middle tips kept extended. Collapsing the fingertips makes the
  // gesture unambiguous and prevents any thumb-stretch residue from
  // tripping other gates.
  lms[4]  = { x: 0.4, y: 0.78, z: 0.0 };
  lms[16] = { x: 0.4, y: 0.78, z: 0.0 };
  lms[20] = { x: 0.4, y: 0.78, z: 0.0 };
  // Rotate the palm base MCP anchors (5 = index MCP, 17 = pinky MCP)
  // around the wrist to simulate wrist pronation/supination. This is the
  // anchor pair the rotateVal calculation reads from, so moving them is
  // what actually exercises the math.
  const wrist = lms[0];
  const arm = 0.4;
  // Horizontal baseline: index MCP on the left, pinky MCP on the right.
  const baseIndexDeg = -160;
  const basePinkyDeg = -20;
  const indexDeg = baseIndexDeg + tiltDeg;
  const pinkyDeg = basePinkyDeg + tiltDeg;
  const toRad = (deg) => (deg * Math.PI) / 180;
  lms[5] = {
    x: wrist.x + Math.cos(toRad(indexDeg)) * arm,
    y: wrist.y + Math.sin(toRad(indexDeg)) * arm,
    z: 0.0,
  };
  lms[17] = {
    x: wrist.x + Math.cos(toRad(pinkyDeg)) * arm,
    y: wrist.y + Math.sin(toRad(pinkyDeg)) * arm,
    z: 0.0,
  };
  return lms;
}

test('computeHandData: victory pose reports victory=true and rotateVal≈0.5 when the palm is horizontal', () => {
  const { windowContext } = loadVisionProcessor();
  const data = windowContext.computeHandData(makeVictoryHand());
  assert.equal(data.victory, true);
  assert.equal(data.fist, false);
  assert.equal(data.open, false);
  // Horizontal palm: index MCP and pinky MCP share the same y → atan2(0, dx) = 0
  // → normalized value lands on the neutral 0.5 mark.
  assert.ok(Math.abs(data.rotateVal - 0.5) < 0.05, `expected rotateVal≈0.5, got ${data.rotateVal}`);
  assert.ok(data.rotateVal >= 0 && data.rotateVal <= 1, `rotateVal out of range: ${data.rotateVal}`);
});

test('computeHandData: rotateVal is computed unconditionally from the palm MCP anchors', () => {
  const { windowContext } = loadVisionProcessor();
  // rotateVal no longer depends on a "rotate gate" — the MCP-based angle
  // is computed for every frame so the app.js pipeline can latch onto it
  // the moment the Victory pose fires.
  const open = windowContext.computeHandData(makeOpenHand());
  assert.equal(typeof open.rotateVal, 'number');
  assert.ok(open.rotateVal >= 0 && open.rotateVal <= 1);
  const f = makeOpenHand();
  [4, 8, 12, 16, 20].forEach((tip) => { f[tip] = { x: 0.4, y: 0.78, z: 0.0 }; });
  const fist = windowContext.computeHandData(f);
  assert.ok(fist.rotateVal >= 0 && fist.rotateVal <= 1);
});

test('computeHandData: victory tilted -45° (pinky MCP down) shifts rotateVal above neutral', () => {
  const { windowContext } = loadVisionProcessor();
  const data = windowContext.computeHandData(makeVictoryHand({ tiltDeg: -45 }));
  assert.equal(data.victory, true);
  assert.ok(Math.abs(data.rotateVal - 0.5) > 0.05, `expected rotateVal tilted away from 0.5, got ${data.rotateVal}`);
});

test('computeHandData: victory tilted +45° (pinky MCP up) shifts rotateVal to the opposite side of neutral', () => {
  const { windowContext } = loadVisionProcessor();
  const data = windowContext.computeHandData(makeVictoryHand({ tiltDeg: 45 }));
  assert.equal(data.victory, true);
  assert.ok(Math.abs(data.rotateVal - 0.5) > 0.05, `expected rotateVal tilted away from 0.5, got ${data.rotateVal}`);
});

test('processMissing: returns null and resets gesture recognition so the panel returns to neutral when the hand drops', () => {
  const { VisionProcessor } = loadVisionProcessor();
  const vp = new VisionProcessor();
  vp.setGestureOptions({ threshold: 0.13, minimumConfidence: 0.55, holdMs: 0, releaseMs: 0 });
  vp.beginGestureTest('Gesture 1');
  vp.processHandData({ victory: true, rotateVal: 0.9 }, 0);
  // No tracker → no inertial prediction: the wire stays silent. The
  // gesture library still gets the null tick so it can clear its
  // candidate / active state.
  assert.equal(vp.processMissing(100), null);
  assert.equal(vp.processMissing(300), null);
});

test('processResults: delivers a single hand reading', async () => {
  const { VisionProcessor, HandsMock } = loadVisionProcessor();
  const vp = new VisionProcessor();
  const mockVideo = {};
  const mockCanvas = {
    width: 320, height: 240,
    getContext: () => ({
      save: () => {}, restore: () => {}, clearRect: () => {}, drawImage: () => {},
      beginPath: () => {}, arc: () => {}, moveTo: () => {}, lineTo: () => {},
      stroke: () => {}, fill: () => {},
    })
  };
  let handData = null;
  vp.onHandUpdate = (data) => { handData = data; };
  await vp.start(mockVideo, mockCanvas);

  HandsMock.instance.resultsCallback({
    image: {},
    multiHandLandmarks: [makeOpenHand()],
    multiHandedness: [{ label: 'Right' }]
  });

  assert.ok(handData, "expected hand reading");
  assert.equal(handData.active, true);
  assert.equal(handData.open, true);

  vp.stop();
});

test('processResults: empty multiHandLandmarks emits null (no active hands)', async () => {
  const { VisionProcessor, HandsMock } = loadVisionProcessor();
  const vp = new VisionProcessor();
  const mockVideo = {};
  const mockCanvas = {
    width: 320, height: 240,
    getContext: () => ({
      save: () => {}, restore: () => {}, clearRect: () => {}, drawImage: () => {},
      beginPath: () => {}, arc: () => {}, moveTo: () => {}, lineTo: () => {},
      stroke: () => {}, fill: () => {},
    })
  };
  let handData = { sentinel: true };
  vp.onHandUpdate = (data) => { handData = data; };
  await vp.start(mockVideo, mockCanvas);

  HandsMock.instance.resultsCallback({
    image: {},
    multiHandLandmarks: [],
    multiHandedness: []
  });

  assert.equal(handData, null);
  vp.stop();
});

test('processResults: hand detection is delivered even when canvas rendering is unavailable', async () => {
  const { VisionProcessor, HandsMock } = loadVisionProcessor();
  const vp = new VisionProcessor();
  const mockVideo = {};
  const mockCanvas = {
    width: 320,
    height: 240,
    getContext: () => null,
  };
  let handData = null;
  vp.onHandUpdate = (data) => { handData = data; };
  await vp.start(mockVideo, mockCanvas);

  HandsMock.instance.resultsCallback({
    image: {},
    multiHandLandmarks: [makeOpenHand()],
    multiHandedness: [{ label: 'Right' }],
  });

  assert.equal(handData?.active, true);
  assert.equal(handData?.open, true);
  vp.stop();
});

test('VisionProcessor: ambient color sampling is throttled without throttling hand frames', () => {
  const { VisionProcessor } = loadVisionProcessor();
  const vp = new VisionProcessor();
  let colorUpdates = 0;
  let handUpdates = 0;
  vp.active = true;
  vp.canvas = { width: 320, height: 240 };
  vp.ctx = {
    save: () => {}, restore: () => {}, clearRect: () => {}, drawImage: () => {},
  };
  vp.calculateAverageColor = () => ({ r: 0.1, g: 0.2, b: 0.3 });
  vp.onColorUpdate = () => { colorUpdates += 1; };
  vp.onHandUpdate = () => { handUpdates += 1; };
  const results = { image: {}, multiHandLandmarks: [] };

  vp.processResults(results, 0);
  vp.processResults(results, 40);
  vp.processResults(results, 80);
  vp.processResults(results, 120);

  assert.equal(handUpdates, 4);
  assert.equal(colorUpdates, 2);
});

test('VisionProcessor: gesture persistence and confidence control are exposed', () => {
  const { VisionProcessor } = loadVisionProcessor();
  const vp = new VisionProcessor();
  // setGestureOptions still works (gestures are unchanged).
  vp.setGestureOptions({ threshold: 0.12, ambiguityMargin: 0.04 });
  assert.equal(vp.exportSafetyConfig().gestureOptions.threshold, 0.12);
  assert.equal(vp.exportSafetyConfig().gestureOptions.ambiguityMargin, 0.04);
  // setConfidence reconfigures MediaPipe so the next hands.send uses
  // the new minDetection / minTracking thresholds. We assert against the
  // captured value on the processor itself because the mocked Hands
  // instance is only created once start() is called.
  vp.setConfidence('low');
  assert.equal(vp.confidence, 0.2);
  vp.setConfidence('medium');
  assert.equal(vp.confidence, 0.5);
  vp.setConfidence('high');
  assert.equal(vp.confidence, 0.7);
  // Unknown presets fall back to the medium default so a malformed UI
  // value never breaks the camera.
  vp.setConfidence('garbage');
  assert.equal(vp.confidence, 0.5);
});

test('VisionProcessor: processMissing returns null when no tracker is active (spatial tracking retired)', () => {
  const { VisionProcessor } = loadVisionProcessor();
  const vp = new VisionProcessor();
  // No tracker means no inertial prediction: the hand simply vanishes.
  // Discrete gesture flags must always be cleared so a stale reading
  // can never linger in the wire payload after the hand drops.
  vp.processHandData({ x: 0.2, y: 0.5, z: 0.5, fist: true, pinch: true, victory: true, open: true }, 0);
  vp.processHandData({ x: 0.4, y: 0.5, z: 0.5, fist: true, pinch: true, victory: true, open: true }, 50);
  assert.equal(vp.processMissing(100), null);
  assert.equal(vp.processMissing(300), null);
});

test('VisionProcessor learns and recognizes only stable static landmark poses', () => {
  const { VisionProcessor } = loadVisionProcessor();
  const vp = new VisionProcessor();
  vp.setGestureOptions({ threshold: 0.13, minimumConfidence: 0.55, holdMs: 200, releaseMs: 150 });
  const landmarks = [
    [0, 0], [-0.3, 0.1], [-0.45, 0.25], [-0.55, 0.45], [-0.65, 0.7],
    [-0.3, 0.4], [-0.32, 0.7], [-0.34, 0.95], [-0.35, 1.15],
    [0, 0.48], [0, 0.18], [0, 0.2], [0, 0.22],
    [0.28, 0.43], [0.28, 0.17], [0.3, 0.19], [0.31, 0.21],
    [0.5, 0.35], [0.5, 0.14], [0.52, 0.16], [0.54, 0.18],
  ].map(([x, y]) => ({ x, y, z: 0 }));
  const raw = { x: 0.5, y: 0.5, z: 0.4, confidence: 1 };

  for (let take = 0; take < 3; take += 1) {
    vp.beginGestureLearn('Gesture 1');
    for (let frame = 0; frame < 8; frame += 1) {
      vp.processHandData(raw, take * 1000 + frame * 33, landmarks);
    }
    assert.equal(vp.finishGestureLearn(), take + 1);
  }
  assert.equal(vp.gestureKind('Gesture 1'), 'pose');
  assert.equal(vp.gestures.templates.get('Gesture 1')[0].length, 42);

  let recognized = null;
  vp.onGesture = (match) => { recognized = match; };
  vp.processHandData(raw, 4000, landmarks);
  vp.processHandData(raw, 4100, landmarks);
  vp.processHandData(raw, 4210, landmarks);
  assert.equal(recognized?.name, 'Gesture 1');
  vp.processHandData(raw, 4500, landmarks);
  assert.equal(recognized?.name, 'Gesture 1', 'holding the same pose must not emit another trigger');
  assert.equal(vp.removeLastGestureTake('Gesture 1'), 2);
  assert.equal(vp.deleteGesture('Gesture 1'), true);
  assert.equal(vp.gestureSampleCount('Gesture 1'), 0);
});

// ── Root cause R4 ───────────────────────────────────────────────────────────
// Field report: "the camera opens and shows video, but MediaPipe never detects
// the hand". The UI had no way to distinguish a dead pipeline from a live one
// that simply has no hand in frame, and hands.send() rejections were swallowed
// by a console.warn inside the frame loop.

function startedProcessor() {
  const loaded = loadVisionProcessor();
  const vp = new loaded.VisionProcessor();
  const canvas = { width: 320, height: 240, getContext: () => null };
  return { ...loaded, vp, start: () => vp.start({}, canvas) };
}

test('vision: reports waiting-for-hand once MediaPipe is loaded but no hand is in frame', async () => {
  const env = startedProcessor();
  await env.start();
  assert.equal(env.vp.visionStatus.cameraActive, true);
  assert.equal(env.vp.visionStatus.mediapipeLoaded, true);
  assert.equal(env.vp.visionStatus.stage, 'waiting-hand');
});

test('vision: reports hand-detected after landmarks arrive, and back to waiting when they stop', async () => {
  const env = startedProcessor();
  await env.start();

  env.HandsMock.instance.resultsCallback({
    image: {},
    multiHandLandmarks: [makeOpenHand()],
    multiHandedness: [{ label: 'Right' }],
  });
  assert.equal(env.vp.visionStatus.stage, 'hand-detected');
  assert.ok(env.vp.visionStatus.resultsReceived >= 1);

  env.HandsMock.instance.resultsCallback({ image: {}, multiHandLandmarks: [] });
  assert.equal(env.vp.visionStatus.stage, 'waiting-hand');
});

test('vision: a hands.send() rejection is surfaced as an inference error, not swallowed', async () => {
  const env = startedProcessor();
  await env.start();

  env.HandsMock.instance.send = () => Promise.reject(new Error('wasm module failed to load'));
  await env.CameraMock.instance.config.onFrame();

  assert.equal(
    env.vp.visionStatus.stage,
    'error',
    'a failing inference must be visible in the UI state',
  );
  assert.match(env.vp.visionStatus.lastError, /wasm module failed to load/);
});

test('vision: status changes are published so the UI can render them', async () => {
  const env = startedProcessor();
  const seen = [];
  env.vp.onVisionStatus = (s) => seen.push(s.stage);
  await env.start();

  env.HandsMock.instance.resultsCallback({
    image: {},
    multiHandLandmarks: [makeOpenHand()],
    multiHandedness: [{ label: 'Right' }],
  });

  assert.ok(seen.includes('waiting-hand'), `stages seen: ${seen.join(',')}`);
  assert.ok(seen.includes('hand-detected'), `stages seen: ${seen.join(',')}`);
});

test('vision: frames sent to MediaPipe are counted so a dead pipeline is distinguishable', async () => {
  const env = startedProcessor();
  await env.start();
  assert.equal(env.vp.visionStatus.framesSent, 0);
  await env.CameraMock.instance.config.onFrame();
  assert.equal(env.vp.visionStatus.framesSent, 1);
});

test('VisionProcessor integration: camera stage reports waiting-for-hand, then hand detected', async () => {
  const { mockElements, HandsMock } = loadVisionAndApp();
  const chk = mockElements['chk-vision-enable'];

  chk.checked = true;
  await chk.onchange();

  // The old copy claimed "MediaPipe is receiving frames" the instant start()
  // resolved, which is exactly what made a dead pipeline indistinguishable
  // from a live one with no hand in view.
  assert.match(
    mockElements['vision-camera-state-detail'].textContent,
    /waiting for hand/i,
    `got: ${mockElements['vision-camera-state-detail'].textContent}`,
  );

  HandsMock.instance.resultsCallback({
    image: {},
    multiHandLandmarks: [makeOpenHand()],
    multiHandedness: [{ label: 'Right' }],
  });
  assert.match(
    mockElements['vision-camera-state-detail'].textContent,
    /hand detected/i,
    `got: ${mockElements['vision-camera-state-detail'].textContent}`,
  );

  HandsMock.instance.resultsCallback({ image: {}, multiHandLandmarks: [] });
  assert.match(mockElements['vision-camera-state-detail'].textContent, /waiting for hand/i);
});

test('VisionProcessor integration: an inference failure is shown on the camera stage', async () => {
  const { mockElements, HandsMock, CameraMock } = loadVisionAndApp();
  const chk = mockElements['chk-vision-enable'];

  chk.checked = true;
  await chk.onchange();

  HandsMock.instance.send = () => Promise.reject(new Error('wasm module failed to load'));
  await CameraMock.instance.config.onFrame();

  assert.equal(mockElements['.vision-camera-stage'].className, 'camera-error');
  assert.match(
    mockElements['vision-camera-state-detail'].textContent,
    /wasm module failed to load/,
    `got: ${mockElements['vision-camera-state-detail'].textContent}`,
  );
});

// Same defect class as markHandLost(): whenever the client has no reading, it
// must SAY so and let each target's Safe loss policy decide, instead of
// inventing a number the server then applies literally.
test('VisionProcessor integration: turning the camera off reports lost signal, not a fixed value', async () => {
  const { windowContext, mockElements } = loadVisionAndApp();
  const chk = mockElements['chk-vision-enable'];

  chk.checked = true;
  await chk.onchange();

  const seen = [];
  const real = windowContext.onControl;
  windowContext.onControl = (ctrl) => { seen.push(ctrl); if (real) real(ctrl); };

  chk.checked = false;
  await chk.onchange();

  for (const name of ['sensor.vision.x', 'sensor.vision.y', 'sensor.vision.z']) {
    const emitted = seen.find((c) => c.name === name);
    assert.ok(emitted, `${name} must still be reported when the camera stops`);
    assert.equal(
      emitted.lost,
      true,
      `${name} must be flagged lost so Safe loss decides; got value ${emitted.value} with no flag`,
    );
  }
});
