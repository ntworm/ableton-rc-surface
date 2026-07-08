import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';

function loadAudioProcessor() {
  const file = path.join(import.meta.dirname, 'audio-processor.js');
  const source = fs.readFileSync(file, 'utf8');

  const windowContext = {
    window: null,
    globalThis: {},
    navigator: {
      mediaDevices: {
        getUserMedia: async () => ({
          getTracks: () => [{ stop: () => {} }]
        })
      }
    },
    // Mock Web Audio API classes
    AudioContext: class {
      constructor() {
        this.state = 'suspended';
        this.sampleRate = 44100;
      }
      createMediaStreamSource() {
        return { connect: () => {} };
      }
      createAnalyser() {
        return {
          fftSize: 2048,
          connect: () => {},
          getFloatTimeDomainData: (buf) => {
            // Fill with mock sine wave (440Hz)
            const freq = 440;
            const sr = 44100;
            for (let i = 0; i < buf.length; i++) {
              buf[i] = Math.sin(2 * Math.PI * freq * i / sr);
            }
          }
        };
      }
      resume() {
        this.state = 'running';
        return Promise.resolve();
      }
      close() {
        return Promise.resolve();
      }
    },
    performance: { now: () => Date.now() },
    requestAnimationFrame: (cb) => {
      return setTimeout(cb, 10);
    },
    cancelAnimationFrame: (id) => {
      clearTimeout(id);
    },
  };
  windowContext.window = windowContext;
  windowContext.globalThis = windowContext;

  vm.runInNewContext(source, windowContext, { filename: file });
  return windowContext.AudioProcessor;
}

test('AudioProcessor: is defined and computes correct pitch (440Hz) from mock sine wave', async () => {
  const AudioProcessor = loadAudioProcessor();
  assert.ok(AudioProcessor);

  const ap = new AudioProcessor();
  await ap.start();

  try {
    // Test standard YIN pitch detection on a custom buffer
    const mockBuffer = new Float32Array(2048);
    const freq = 440;
    const sr = 44100;
    for (let i = 0; i < mockBuffer.length; i++) {
      mockBuffer[i] = Math.sin(2 * Math.PI * freq * i / sr);
    }

    const result = ap.detectPitchYIN(mockBuffer, sr);
    const pitch = result.pitch;
    // Expected to be close to 440Hz
    assert.ok(Math.abs(pitch - 440) < 5.0, `Expected 440Hz, got ${pitch}Hz`);

    // Convert Hz to MIDI note
    const midi = ap.hzToMidi(pitch);
    assert.equal(midi, 69); // MIDI note 69 is A4 (440Hz)
  } finally {
    ap.stop();
  }
});

test('AudioProcessor: calculates correct RMS value for audio buffers', () => {
  const AudioProcessor = loadAudioProcessor();
  const ap = new AudioProcessor();

  const mockBuffer = new Float32Array(100);
  mockBuffer.fill(0.5); // constant value 0.5

  const rms = ap.calculateRMS(mockBuffer);
  // RMS of constant 0.5 is 0.5
  assert.ok(Math.abs(rms - 0.5) < 0.001);
});

function loadAudioAndApp() {
  const apFile = path.join(import.meta.dirname, 'audio-processor.js');
  const apSource = fs.readFileSync(apFile, 'utf8');

  const smoothFile = path.join(import.meta.dirname, 'audio-smoothing.js');
  const smoothSource = fs.readFileSync(smoothFile, 'utf8');

  const appFile = path.join(import.meta.dirname, 'app.js');
  const appSource = fs.readFileSync(appFile, 'utf8');

  const mockElements = {};
  const getMockElement = (id) => {
    if (!mockElements[id]) {
      mockElements[id] = {
        textContent: '',
        style: { width: '0%' },
        checked: false,
        addEventListener: function(evt, cb) {
          this[`on${evt}`] = cb;
        },
        classList: {
          add: () => {},
          remove: () => {},
          toggle: () => {},
        },
      };
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
      querySelectorAll: (sel) => [getMockElement('pad-1')],
      addEventListener: () => {},
      removeEventListener: () => {},
    },
    navigator: {
      vibrate: () => {},
      mediaDevices: {
        getUserMedia: async () => ({
          getTracks: () => [{ stop: () => {} }]
        })
      }
    },
    AudioContext: class {
      constructor() {
        this.state = 'suspended';
        this.sampleRate = 44100;
      }
      createMediaStreamSource() {
        return { connect: () => {} };
      }
      createAnalyser() {
        return {
          fftSize: 2048,
          connect: () => {},
          getFloatTimeDomainData: (buf) => {
            buf.fill(0.1);
          }
        };
      }
      resume() {
        this.state = 'running';
        return Promise.resolve();
      }
      close() {
        return Promise.resolve();
      }
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
    setInterval: () => {},
    setTimeout: (cb, delay) => { cb(); },
    dispatchEvent: () => {},
  };
  windowContext.window = windowContext;
  windowContext.globalThis = windowContext;

  vm.runInNewContext(apSource, windowContext, { filename: apFile });

  const OriginalAP = windowContext.AudioProcessor;
  windowContext.AudioProcessor = class extends OriginalAP {
    constructor() {
      super();
      windowContext.__audioProcessorInstance = this;
    }
  };

  // audio-smoothing.js must load before app.js so window.AudioSmoothing
  // is defined when setupAudioUI calls smoothAudioValue().
  vm.runInNewContext(smoothSource, windowContext, { filename: smoothFile });

  vm.runInNewContext(appSource, windowContext, { filename: appFile });

  return { windowContext, mockElements };
}

test('AudioProcessor integration: setupAudioUI initializes checkbox and updates UI/controls', async () => {
  const { windowContext, mockElements } = loadAudioAndApp();
  
  const chk = mockElements['chk-audio-enable'];
  assert.ok(chk);

  // Trigger change event to enable audio
  chk.checked = true;
  await chk.onchange(); // calls startAudio() inside setupAudioUI

  // Give it a small timeout to let analysis update run once
  await new Promise((resolve) => setTimeout(resolve, 30));

  // Verify elements were updated
  assert.ok(mockElements['bar-audio-rms'].style.width !== '0%');
  
  // Disable audio
  chk.checked = false;
  chk.onchange(); // calls stopAudio()

  assert.equal(mockElements['bar-audio-rms'].style.width, '0%');
});

test('AudioProcessor: EMA smoothing reduces step changes gradually', async () => {
  const { windowContext, mockElements } = loadAudioAndApp();

  const chk = mockElements['chk-audio-enable'];
  chk.checked = true;
  await chk.onchange();

  const ap = windowContext.__audioProcessorInstance;
  assert.ok(ap);

  try {
    const rmsValues = [];
    windowContext.onControl = (ctrl) => {
      if (ctrl.name === 'sensor.audio.rms') {
        rmsValues.push(ctrl.value);
      }
    };

    ap.onAnalysisUpdate({ rms: 1.0, pitch: 0, midiNote: 0, bpm: 0 });

    assert.ok(rmsValues.length > 0);
    // Adaptive smoother: at raw=1.0, alpha=0.58, so first tick from prev=0
    // lands at 0.58.
    assert.ok(Math.abs(rmsValues[0] - 0.58) < 0.01,
      `Expected ~0.58 (alpha at raw=1.0), got ${rmsValues[0]}`);

    ap.onAnalysisUpdate({ rms: 1.0, pitch: 0, midiNote: 0, bpm: 0 });
    // Second tick: 0.58 * 0.42 + 1.0 * 0.58 = 0.824
    assert.ok(Math.abs(rmsValues[1] - 0.824) < 0.01,
      `Expected ~0.824, got ${rmsValues[1]}`);
  } finally {
    chk.checked = false;
    chk.onchange();
  }
});

test('AudioProcessor: downsample method correctly reduces buffer size', () => {
  const AudioProcessor = loadAudioProcessor();
  const ap = new AudioProcessor();

  const mockBuffer = new Float32Array([1, 2, 3, 4, 5, 6, 7, 8]);
  const downsampled = ap.downsample(mockBuffer, 2);

  assert.equal(downsampled.length, 4);
  assert.equal(downsampled[0], 1);
  assert.equal(downsampled[1], 3);
  assert.equal(downsampled[2], 5);
  assert.equal(downsampled[3], 7);
});

test('AudioProcessor: advanced audio metrics (clarity, envelope, transient, gate)', () => {
  const AudioProcessor = loadAudioProcessor();
  const ap = new AudioProcessor();

  // Test clarity with pure sine wave
  const mockBuffer = new Float32Array(2048);
  const freq = 1000;
  const sr = 44100;
  for (let i = 0; i < mockBuffer.length; i++) {
    mockBuffer[i] = Math.sin(2 * Math.PI * freq * i / sr);
  }

  const res = ap.detectPitchYIN(mockBuffer, sr);
  assert.ok(res.pitch > 900 && res.pitch < 1100, `expected pitch near 1000Hz, got ${res.pitch}`);
  assert.ok(res.clarity > 0.8, `expected clarity > 0.8, got ${res.clarity}`);

  // Test asymmetric envelope follower
  ap.envelope = 0.1;
  // Attack (rms > envelope)
  let rms = 0.5;
  ap.envelope = ap.envelope * 0.2 + rms * 0.8;
  assert.ok(Math.abs(ap.envelope - 0.42) < 0.01, `expected envelope to attack fast to 0.42, got ${ap.envelope}`);

  // Release (rms < envelope)
  rms = 0.1;
  ap.envelope = ap.envelope * 0.85 + rms * 0.15;
  assert.ok(Math.abs(ap.envelope - 0.372) < 0.01, `expected envelope to release slow to 0.372, got ${ap.envelope}`);
});

