import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';

function loadVisionProcessor() {
  const file = path.join(import.meta.dirname, 'vision-processor.js');
  const source = fs.readFileSync(file, 'utf8');

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

  // Simulate MediaPipe results callback
  // Hand structure: 21 landmarks with x, y, z
  const mockLandmarks = [];
  for (let i = 0; i < 21; i++) {
    // Fill with default coordinates
    mockLandmarks.push({ x: 0.5, y: 0.5, z: 0.0 });
  }

  // Set wrist (0), index mcp (5), pinky mcp (17) to define hand center
  mockLandmarks[0] = { x: 0.4, y: 0.8, z: 0.0 }; // wrist
  mockLandmarks[5] = { x: 0.3, y: 0.4, z: 0.0 }; // index mcp
  mockLandmarks[17] = { x: 0.5, y: 0.4, z: 0.0 }; // pinky mcp

  // Wrist to middle mcp (9) distance determines scale/Z
  mockLandmarks[9] = { x: 0.4, y: 0.4, z: 0.0 }; // middle mcp

  // Set finger tips far away (not a fist)
  // Tips: 8, 12, 16, 20
  [8, 12, 16, 20].forEach((tip) => {
    mockLandmarks[tip] = { x: 0.4, y: 0.1, z: 0.0 };
  });

  // Call onResults
  HandsMock.instance.resultsCallback({
    image: {},
    multiHandLandmarks: [mockLandmarks]
  });

  assert.ok(handUpdateData);
  // Expected coordinates:
  // x: average of wrist.x (0.4), indexMcp.x (0.3), pinkyMcp.x (0.5) = 0.4. Inverted: 1 - 0.4 = 0.6
  // y: average of wrist.y (0.8), indexMcp.y (0.4), pinkyMcp.y (0.4) = 0.533. Inverted: 1 - 0.533 = 0.467
  assert.ok(Math.abs(handUpdateData.x - 0.6) < 0.01);
  assert.ok(Math.abs(handUpdateData.y - 0.467) < 0.01);
  assert.equal(handUpdateData.isFist, false);

  // Now simulate a fist (tips close to wrist)
  [8, 12, 16, 20].forEach((tip) => {
    mockLandmarks[tip] = { x: 0.4, y: 0.75, z: 0.0 };
  });

  HandsMock.instance.resultsCallback({
    image: {},
    multiHandLandmarks: [mockLandmarks]
  });

  assert.equal(handUpdateData.isFist, true);

  // Stop the processor
  vp.stop();
  assert.equal(vp.active, false);
  assert.ok(CameraMock.instance.stopped);
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
    }
    start() {
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

  vm.runInNewContext(vpSource, windowContext, { filename: vpFile });
  vm.runInNewContext(appSource, windowContext, { filename: appFile });

  return { windowContext, mockElements, HandsMock };
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

test('VisionProcessor integration: hand active status and coordinate decay', async () => {
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

  // 1. Simulate hand detected
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
    multiHandLandmarks: [mockLandmarks]
  });

  // Check window.currentControlStates
  assert.equal(windowContext.currentControlStates['sensor.vision.hand.active'], 1);
  const lastX = windowContext.currentControlStates['sensor.vision.hand.x'];
  const lastY = windowContext.currentControlStates['sensor.vision.hand.y'];
  const lastZ = windowContext.currentControlStates['sensor.vision.hand.z'];

  assert.ok(Math.abs(lastX - 0.6) < 0.01);
  assert.ok(Math.abs(lastY - 0.467) < 0.01);

  // 2. Simulate hand lost
  const startTime = 1000;
  windowContext.currentTime = startTime;

  HandsMock.instance.resultsCallback({
    image: {},
    multiHandLandmarks: [] // empty = hand lost
  });

  assert.ok(windowContext.lastIntervalCallback, "setInterval callback was not captured");

  // Tick 1: 150ms after loss (halfway through decay)
  windowContext.currentTime = startTime + 150;
  windowContext.lastIntervalCallback();

  const midX = windowContext.currentControlStates['sensor.vision.hand.x'];
  const midY = windowContext.currentControlStates['sensor.vision.hand.y'];
  const midZ = windowContext.currentControlStates['sensor.vision.hand.z'];
  
  assert.ok(Math.abs(midX - 0.55) < 0.02, `midX was ${midX}, expected ~0.55`);
  assert.ok(Math.abs(midY - 0.483) < 0.02, `midY was ${midY}, expected ~0.483`);
  assert.equal(windowContext.currentControlStates['sensor.vision.hand.active'], 0);

  // Tick 2: 300ms after loss (fully decayed)
  windowContext.currentTime = startTime + 300;
  windowContext.lastIntervalCallback();

  const finalX = windowContext.currentControlStates['sensor.vision.hand.x'];
  const finalY = windowContext.currentControlStates['sensor.vision.hand.y'];
  const finalZ = windowContext.currentControlStates['sensor.vision.hand.z'];

  assert.equal(finalX, 0.5);
  assert.equal(finalY, 0.5);
  assert.equal(finalZ, 0.0);
});


