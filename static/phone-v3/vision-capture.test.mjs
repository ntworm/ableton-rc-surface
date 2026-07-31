// Copyright © 2026 Gabriel Worm
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
//
// Vision capture quality, part 1: what MediaPipe is given and how its output
// is conditioned before anything else sees it.
//
// Field report: moving the hand quickly makes MediaPipe lose it, and the
// mapped values then jump. Three causes, all upstream of the mapping tab:
//
//   1. the camera was captured at 160x120 — at that size a fast hand is a few
//      blurred pixels, so there is nothing left to track;
//   2. minDetectionConfidence and minTrackingConfidence were set to the SAME
//      preset value. Detection SHOULD be strict (don't latch onto background
//      clutter) but tracking should be lenient (keep following through motion
//      blur). With CONF=High both were 0.7, so the hand was dropped the moment
//      tracking quality dipped — exactly during fast movement;
//   3. nothing filtered the derived position, so every frame's noise reached
//      the mapping directly.
//
// The 1€ filter is the standard answer for (3): a low-pass whose cutoff rises
// with speed, so it kills jitter when the hand is still without adding lag
// when it moves. Casiez, Roussel & Vogel, CHI 2012.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';

const source = fs.readFileSync(path.join(import.meta.dirname, 'vision-processor.js'), 'utf8');

function loadGlobals() {
  const ctx = { window: null, document: { createElement: () => ({}), head: { appendChild() {} } }, console };
  ctx.window = ctx;
  ctx.globalThis = ctx;
  vm.runInNewContext(
    fs.readFileSync(path.join(import.meta.dirname, 'safe-input-layer.js'), 'utf8'), ctx,
  );
  vm.runInNewContext(
    fs.readFileSync(path.join(import.meta.dirname, 'camera-lifecycle.js'), 'utf8'), ctx,
  );
  vm.runInNewContext(source, ctx, { filename: 'vision-processor.js' });
  return ctx;
}

test('capture: the camera is requested at a resolution a fast hand survives', () => {
  const width = /width:\s*(\d+)/.exec(source);
  const height = /height:\s*(\d+)/.exec(source);
  assert.ok(width && height, 'camera options must declare width and height');
  assert.ok(
    Number(width[1]) >= 320 && Number(height[1]) >= 240,
    `160x120 leaves nothing to track once the hand blurs; got ${width[1]}x${height[1]}`,
  );
});

test('capture: tracking confidence is more forgiving than detection confidence', () => {
  const ctx = loadGlobals();
  const vp = new ctx.VisionProcessor();
  const seen = [];
  vp.hands = { setOptions: (o) => seen.push(o) };

  for (const preset of ['low', 'medium', 'high']) {
    seen.length = 0;
    vp.setConfidence(preset);
    assert.equal(seen.length, 1, `${preset} must push options to MediaPipe`);
    const { minDetectionConfidence, minTrackingConfidence } = seen[0];
    assert.ok(
      minTrackingConfidence < minDetectionConfidence,
      `${preset}: tracking (${minTrackingConfidence}) must be looser than detection ` +
        `(${minDetectionConfidence}), otherwise a fast hand is dropped mid-motion`,
    );
    assert.ok(minTrackingConfidence >= 0.1, `${preset}: tracking must not drop to noise`);
  }
});

test('1€ filter: kills jitter while the hand is essentially still', () => {
  const ctx = loadGlobals();
  assert.equal(typeof ctx.OneEuroFilter, 'function', 'OneEuroFilter must be exposed');
  const f = new ctx.OneEuroFilter();

  // A hand held still at 0.5 with +/-0.02 of sensor noise.
  const noise = [0.02, -0.018, 0.015, -0.02, 0.017, -0.016, 0.019, -0.014, 0.02, -0.02];
  let t = 0;
  let maxDeviation = 0;
  for (let i = 0; i < noise.length; i++) {
    t += 33;
    const out = f.filter(0.5 + noise[i], t);
    if (i > 2) maxDeviation = Math.max(maxDeviation, Math.abs(out - 0.5));
  }
  assert.ok(
    maxDeviation < 0.01,
    `still-hand jitter must be cut well below the raw +/-0.02; got ${maxDeviation.toFixed(4)}`,
  );
});

test('1€ filter: keeps up with a fast sweep instead of lagging behind', () => {
  const ctx = loadGlobals();
  const f = new ctx.OneEuroFilter();

  // Hand crossing the frame in ~0.4s at 30fps.
  let t = 0;
  let out = 0;
  for (let i = 0; i <= 12; i++) {
    t += 33;
    out = f.filter(i / 12, t);
  }
  assert.ok(
    out > 0.85,
    `a fast sweep to 1.0 must not be smeared; filter ended at ${out.toFixed(3)}`,
  );
});

test('1€ filter: a fixed heavy smoother would lag where the 1€ filter does not', () => {
  const ctx = loadGlobals();
  const f = new ctx.OneEuroFilter();
  let ema = 0;
  let t = 0;
  let oneEuro = 0;
  for (let i = 0; i <= 12; i++) {
    t += 33;
    const raw = i / 12;
    oneEuro = f.filter(raw, t);
    ema = ema + (raw - ema) * 0.15; // fixed low-pass with comparable still-hand damping
  }
  assert.ok(
    oneEuro > ema + 0.2,
    `the adaptive filter must beat a fixed one on lag: 1€=${oneEuro.toFixed(3)} ema=${ema.toFixed(3)}`,
  );
});

test('vision: hand position is filtered before it leaves the processor', () => {
  assert.match(source, /OneEuroFilter/, 'the processor must use the filter');
  assert.match(
    source,
    /positionFilters|filterHandPosition/,
    'x/y/z must go through the filter, not just be exposed raw',
  );
});
