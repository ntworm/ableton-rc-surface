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

    const pitch = ap.detectPitchYIN(mockBuffer, sr);
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
    assert.ok(Math.abs(rmsValues[0] - 0.35) < 0.05, `Expected 0.35, got ${rmsValues[0]}`);

    ap.onAnalysisUpdate({ rms: 1.0, pitch: 0, midiNote: 0, bpm: 0 });
    assert.ok(Math.abs(rmsValues[1] - 0.5775) < 0.05, `Expected 0.5775, got ${rmsValues[1]}`);
  } finally {
    chk.checked = false;
    chk.onchange();
  }
});

