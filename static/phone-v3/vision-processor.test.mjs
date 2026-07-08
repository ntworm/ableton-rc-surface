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
    multiHandLandmarks: [mockLandmarks],
    multiHandedness: [{ label: 'Right' }]
  });

  // Check window.currentControlStates
  assert.equal(windowContext.currentControlStates['sensor.vision.active'], 1);
  const lastX = windowContext.currentControlStates['sensor.vision.x'];
  const lastY = windowContext.currentControlStates['sensor.vision.y'];
  const lastZ = windowContext.currentControlStates['sensor.vision.z'];

  assert.ok(Math.abs(lastX - 0.6) < 0.01);
  assert.ok(Math.abs(lastY - 0.467) < 0.01);

  // 2. Simulate hand lost
  const startTime = 1000;
  windowContext.currentTime = startTime;

  HandsMock.instance.resultsCallback({
    image: {},
    multiHandLandmarks: [],
    multiHandedness: []
  });

  assert.ok(windowContext.lastIntervalCallback, "setInterval callback was not captured");

  // Tick 1: 150ms after loss (halfway through decay)
  windowContext.currentTime = startTime + 150;
  windowContext.lastIntervalCallback();

  const midX = windowContext.currentControlStates['sensor.vision.x'];
  const midY = windowContext.currentControlStates['sensor.vision.y'];
  const midZ = windowContext.currentControlStates['sensor.vision.z'];

  assert.ok(Math.abs(midX - 0.55) < 0.02, `midX was ${midX}, expected ~0.55`);
  assert.ok(Math.abs(midY - 0.483) < 0.02, `midY was ${midY}, expected ~0.483`);
  assert.equal(windowContext.currentControlStates['sensor.vision.active'], 0);
  // The decay path must also write the gesture keys to zero so
  // any downstream mapping stops seeing stale gestures after the hand drops.
  assert.equal(windowContext.currentControlStates['sensor.vision.fist'], 0);

  // Tick 2: 300ms after loss (fully decayed)
  windowContext.currentTime = startTime + 300;
  windowContext.lastIntervalCallback();

  const finalX = windowContext.currentControlStates['sensor.vision.x'];
  const finalY = windowContext.currentControlStates['sensor.vision.y'];
  const finalZ = windowContext.currentControlStates['sensor.vision.z'];

  assert.equal(finalX, 0.5);
  assert.equal(finalY, 0.5);
  assert.equal(finalZ, 0.0);
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


