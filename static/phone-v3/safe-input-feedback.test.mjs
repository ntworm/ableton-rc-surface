// Copyright © 2026 Gabriel Worm
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const read = (name) => fs.readFileSync(path.join(import.meta.dirname, name), 'utf8');

test('phone consumes safe-input state and exposes integrated ghost feedback', () => {
  const app = read('app.js');
  const controls = read('controls.js');
  const css = read('style.css');

  assert.match(app, /msg\.type === ['"]safe_input_state['"]/);
  assert.match(app, /updateSafeInputFeedback/);
  assert.match(controls, /window\.updateSafeInputFeedback\s*=/);
  assert.match(controls, /--safe-host/);
  assert.match(controls, /safe-takeover/);
  assert.match(css, /\.safe-takeover/);
  assert.match(css, /--safe-host/);
  assert.match(controls, /dataset\.safeCaptured/);
  assert.doesNotMatch(controls, /void el\.offsetWidth/);
  assert.match(css, /\.knob-face::after/);
  assert.doesNotMatch(css, /\.knob\.safe-takeover::after/);
  assert.match(css, /\.fader\.safe-takeover[^\{]* \.fader-track::after/);
  assert.doesNotMatch(css, /\.fader\.safe-takeover::after/);
  assert.match(controls, /dataset\.safeMode/);
});

test('audio panel exposes live values for every mapped analysis channel', () => {
  const html = read('index.html');
  const app = read('app.js');
  for (const channel of ['rms', 'envelope', 'clarity', 'gate', 'bend']) {
    assert.match(html, new RegExp(`id=["']lbl-audio-${channel}["']`));
    assert.match(app, new RegExp(`lbl-audio-${channel}`));
  }
});
