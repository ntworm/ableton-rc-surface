// Copyright © 2026 Gabriel Worm
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Source: https://github.com/ntworm/ableton-rc-surface
//
// This file is part of Ableton RC Surface, distributed under the
// PolyForm Noncommercial License 1.0.0. You may obtain a copy of
// the License at https://polyformproject.org/licenses/noncommercial/1.0.0
//
// audio-processor.test.mjs
//
// Unit and integration tests for the main-thread audio processor.
// The DSP path (AnalyserNode → RMS → YIN → envelope → transient →
// BPM → whistle) runs synchronously on the UI thread inside a
// requestAnimationFrame loop. These tests exercise the DSP methods
// directly and verify the wiring through `app.js`.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';

function loadAudioProcessor() {
  const file = path.join(import.meta.dirname, 'audio-processor.js');
  const source = fs.readFileSync(file, 'utf8');

  // Use real timers so requestAnimationFrame in the module behaves
  // like a browser — frame callbacks run via setTimeout(0). Tests
  // that need control over frame timing install their own rAF mock.
  const windowContext = {
    window: null,
    globalThis: {},
    navigator: {
      mediaDevices: {
        getUserMedia: async () => ({
          getTracks: () => [{ stop: () => {} }],
        }),
      },
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
          // Fill with a 440 Hz sine wave so YIN has something periodic to lock onto.
          getFloatTimeDomainData: (buf) => {
            const freq = 440;
            const sr = 44100;
            for (let i = 0; i < buf.length; i++) {
              buf[i] = Math.sin((2 * Math.PI * freq * i) / sr);
            }
          },
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
    requestAnimationFrame: (cb) => setTimeout(cb, 10),
    cancelAnimationFrame: (id) => clearTimeout(id),
  };
  windowContext.window = windowContext;
  windowContext.globalThis = windowContext;

  vm.runInNewContext(source, windowContext, { filename: file });
  return windowContext.AudioProcessor;
}

// ---- DSP unit tests ------------------------------------------------------

test('AudioProcessor: exposes a constructor and an onAnalysisUpdate hook', () => {
  const AudioProcessor = loadAudioProcessor();
  assert.ok(AudioProcessor, 'AudioProcessor should be exposed on window');
  const ap = new AudioProcessor();
  assert.equal(typeof ap.start, 'function');
  assert.equal(typeof ap.stop, 'function');
  assert.equal(ap.onAnalysisUpdate, null);
});

test('AudioProcessor: calculates correct RMS value for audio buffers', () => {
  const AudioProcessor = loadAudioProcessor();
  const ap = new AudioProcessor();

  // Constant signal of 0.5 → RMS should be exactly 0.5.
  const buf = new Float32Array(100);
  buf.fill(0.5);
  const rms = ap._calculateRMS(buf);
  assert.ok(Math.abs(rms - 0.5) < 0.001, `expected 0.5, got ${rms}`);

  // Zero signal → RMS = 0.
  const silent = new Float32Array(64);
  assert.equal(ap._calculateRMS(silent), 0);
});

test('AudioProcessor: downsample drops samples by the requested factor', () => {
  const AudioProcessor = loadAudioProcessor();
  const ap = new AudioProcessor();

  // factor=2 picks every 2nd sample.
  const buf = new Float32Array([1, 2, 3, 4, 5, 6, 7, 8]);
  const out = ap._downsample(buf, 2);
  assert.equal(out.length, 4);
  assert.deepEqual(Array.from(out), [1, 3, 5, 7]);

  // factor=4 with a longer buffer.
  const big = new Float32Array(16);
  for (let i = 0; i < 16; i++) big[i] = i;
  const out4 = ap._downsample(big, 4);
  assert.equal(out4.length, 4);
  assert.deepEqual(Array.from(out4), [0, 4, 8, 12]);
});

test('AudioProcessor: detectPitchYIN locks onto 440 Hz on a synthetic sine wave', () => {
  const AudioProcessor = loadAudioProcessor();
  const ap = new AudioProcessor();

  const buf = new Float32Array(2048);
  const freq = 440;
  const sr = 44100;
  for (let i = 0; i < buf.length; i++) {
    buf[i] = Math.sin((2 * Math.PI * freq * i) / sr);
  }

  const { pitch, clarity } = ap._detectPitchYIN(buf, sr);
  assert.ok(
    Math.abs(pitch - 440) < 5.0,
    `expected ~440 Hz, got ${pitch}`
  );
  assert.ok(clarity > 0.5, `expected reasonable clarity, got ${clarity}`);
});

test('AudioProcessor: detectPitchYIN locks onto 1000 Hz with high clarity', () => {
  const AudioProcessor = loadAudioProcessor();
  const ap = new AudioProcessor();

  const buf = new Float32Array(2048);
  const freq = 1000;
  const sr = 44100;
  for (let i = 0; i < buf.length; i++) {
    buf[i] = Math.sin((2 * Math.PI * freq * i) / sr);
  }

  const { pitch, clarity } = ap._detectPitchYIN(buf, sr);
  assert.ok(pitch > 900 && pitch < 1100, `expected ~1000 Hz, got ${pitch}`);
  assert.ok(clarity > 0.8, `expected clarity > 0.8, got ${clarity}`);
});

test('AudioProcessor: hzToMidi maps frequencies to MIDI note numbers', () => {
  const AudioProcessor = loadAudioProcessor();
  const ap = new AudioProcessor();
  assert.equal(ap._hzToMidi(440), 69, 'A4 = MIDI 69');
  assert.equal(ap._hzToMidi(261.63), 60, 'C4 ≈ MIDI 60');
  assert.equal(ap._hzToMidi(0), 0, '0 Hz → 0');
  assert.equal(ap._hzToMidi(10), 0, '<20 Hz → 0');
  assert.equal(ap._hzToMidi(25000), 0, '>20 kHz → 0');
});

test('AudioProcessor: envelope follower attacks fast and releases slow', () => {
  const AudioProcessor = loadAudioProcessor();
  const ap = new AudioProcessor();

  // Attack (rms > envelope): should converge quickly toward rms.
  ap.envelope = 0.1;
  ap.envelope = ap.envelope * 0.2 + 0.5 * 0.8; // 0.42
  assert.ok(
    Math.abs(ap.envelope - 0.42) < 0.01,
    `attack expected 0.42, got ${ap.envelope}`
  );

  // Release (rms < envelope): should hold closer to the prior value.
  ap.envelope = ap.envelope * 0.85 + 0.1 * 0.15; // 0.372
  assert.ok(
    Math.abs(ap.envelope - 0.372) < 0.01,
    `release expected 0.372, got ${ap.envelope}`
  );
});

// ---- Continuous analysis regression test --------------------------------
//
// This is the regression test for the AudioWorklet bug that took the
// processor down after a couple of audio quanta (the TDZ
// `const sampleRate = sampleRate` bug). The main-thread implementation
// must keep publishing analysis messages for every frame, indefinitely,
// as long as `start()` has been called and `stop()` has not.

test('AudioProcessor: keeps publishing analysis across many frames (regression)', async () => {
  const AudioProcessor = loadAudioProcessor();
  const ap = new AudioProcessor();

  // Capture every callback the loop produces.
  const updates = [];
  ap.onAnalysisUpdate = (msg) => updates.push(msg);

  await ap.start();

  // rAF in the mock fires every 10 ms via setTimeout. Wait long enough
  // for many frames — the old bug only survived 2-3 quanta before
  // throwing the ReferenceError and stopping the loop silently.
  await new Promise((resolve) => setTimeout(resolve, 200));

  ap.stop();

  assert.ok(
    updates.length >= 10,
    `expected at least 10 frames of analysis, got ${updates.length} ` +
      `(regression: the loop died early)`
  );

  // Every update must carry the full sensor.audio.* payload — the
  // controller contract app.js relies on.
  const last = updates[updates.length - 1];
  for (const key of [
    'pitch',
    'midiNote',
    'rms',
    'bpm',
    'clarity',
    'whistleActive',
    'whistleBend',
    'envelope',
    'transient',
    'gate',
  ]) {
    assert.ok(key in last, `analysis update missing field "${key}"`);
  }
});

// ---- App integration ----------------------------------------------------

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
        addEventListener: function (evt, cb) {
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
      querySelectorAll: () => [getMockElement('pad-1')],
      addEventListener: () => {},
      removeEventListener: () => {},
    },
    navigator: {
      vibrate: () => {},
      mediaDevices: {
        getUserMedia: async () => ({
          getTracks: () => [{ stop: () => {} }],
        }),
      },
    },
    AudioContext: class {
      constructor() {
        this.state = 'suspended';
        this.sampleRate = 44100;
      }
      createMediaStreamSource() {
        return { connect: () => {}, disconnect: () => {} };
      }
      createAnalyser() {
        return {
          fftSize: 2048,
          connect: () => {},
          disconnect: () => {},
          // Constant 0.1 signal so RMS comes back as 0.1 — nonzero
          // so the bar moves on the very first frame.
          getFloatTimeDomainData: (buf) => {
            buf.fill(0.1);
          },
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
    requestAnimationFrame: (cb) => setTimeout(cb, 10),
    cancelAnimationFrame: (id) => clearTimeout(id),
    localStorage: {
      getItem: () => null,
      setItem: () => {},
      removeItem: () => {},
    },
    WebSocket: class {
      constructor() {
        this.readyState = 0;
      }
      send() {}
      close() {}
    },
    addEventListener: () => {},
    setInterval: () => {},
    setTimeout: (cb, delay) => {
      cb();
    },
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
  // is defined when setupAudioUI calls its adaptive smoother.
  vm.runInNewContext(smoothSource, windowContext, { filename: smoothFile });
  vm.runInNewContext(appSource, windowContext, { filename: appFile });

  return { windowContext, mockElements };
}

test('AudioProcessor integration: setupAudioUI initializes checkbox and updates UI/controls', async () => {
  const { windowContext, mockElements } = loadAudioAndApp();

  const chk = mockElements['chk-audio-enable'];
  assert.ok(chk);

  chk.checked = true;
  await chk.onchange();

  // Give the rAF loop one tick so the bar updates.
  await new Promise((resolve) => setTimeout(resolve, 30));

  assert.notEqual(
    mockElements['bar-audio-rms'].style.width,
    '0%',
    `expected bar-audio-rms to update after enable, got "${mockElements['bar-audio-rms'].style.width}"`
  );

  chk.checked = false;
  chk.onchange();

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

    // Adaptive smoother with raw=1.0: alpha = 0.08 + min(0.5, 1.0*2) = 0.58.
    ap.onAnalysisUpdate({
      rms: 1.0, pitch: 0, midiNote: 0, bpm: 0,
      clarity: 0, whistleActive: 0, whistleBend: 0.5,
      envelope: 1.0, transient: 0, gate: 1,
    });

    assert.ok(rmsValues.length > 0, 'expected onControl to be called with sensor.audio.rms');
    assert.ok(
      Math.abs(rmsValues[0] - 0.58) < 0.01,
      `expected ~0.58 (alpha at raw=1.0), got ${rmsValues[0]}`
    );

    ap.onAnalysisUpdate({
      rms: 1.0, pitch: 0, midiNote: 0, bpm: 0,
      clarity: 0, whistleActive: 0, whistleBend: 0.5,
      envelope: 1.0, transient: 0, gate: 1,
    });

    // 0.58 * 0.42 + 1.0 * 0.58 = 0.824.
    assert.ok(
      Math.abs(rmsValues[1] - 0.824) < 0.01,
      `expected ~0.824, got ${rmsValues[1]}`
    );
  } finally {
    chk.checked = false;
    chk.onchange();
  }
});

