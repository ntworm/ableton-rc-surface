// Copyright © 2026 Gabriel Worm
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

function load() {
  const source = fs.readFileSync(path.join(import.meta.dirname, 'safe-input-layer.js'), 'utf8');
  const context = { window: null, globalThis: null };
  context.window = context;
  context.globalThis = context;
  vm.runInNewContext(source, context);
  return context.SafeInputLayer;
}

function handPose({ thumb = 0.5, index = 1, middle = 1, ring = 1, pinky = 1 } = {}) {
  const points = [
    [0, 0, 0],
    [-0.36, 0.16, 0], [-0.50, 0.34, 0], [-0.58, 0.52, 0], [-0.65, 0.68 * thumb, 0],
    [-0.32, 0.42, 0], [-0.34, 0.68 * index, 0], [-0.35, 0.90 * index, 0], [-0.36, 1.10 * index, 0],
    [0, 0.48, 0], [0, 0.75 * middle, 0], [0, 1.00 * middle, 0], [0, 1.22 * middle, 0],
    [0.28, 0.43, 0], [0.30, 0.70 * ring, 0], [0.31, 0.92 * ring, 0], [0.32, 1.10 * ring, 0],
    [0.50, 0.35, 0], [0.54, 0.58 * pinky, 0], [0.56, 0.76 * pinky, 0], [0.58, 0.92 * pinky, 0],
  ];
  return points.map(([x, y, z]) => ({ x, y, z }));
}

function transform(landmarks, { scale = 1, x = 0, y = 0, z = 0 } = {}) {
  return landmarks.map((point) => ({
    x: point.x * scale + x,
    y: point.y * scale + y,
    z: point.z * scale + z,
  }));
}

function transform2D(landmarks, { scale = 1, x = 0, y = 0, radians = 0, z = 0 } = {}) {
  const c = Math.cos(radians);
  const s = Math.sin(radians);
  return landmarks.map((point) => ({
    x: (point.x * c - point.y * s) * scale + x,
    y: (point.x * s + point.y * c) * scale + y,
    z: point.z + z,
  }));
}

function frames(descriptor, count = 8, jitter = 0.002) {
  return Array.from({ length: count }, (_, frame) => descriptor.map((value, index) =>
    value + Math.sin(frame * 1.7 + index * 0.31) * jitter));
}

test('normalizes all 21 MediaPipe landmarks independently of screen position and hand scale', () => {
  const { normalizeHandPose, poseDistance } = load();
  assert.equal(typeof normalizeHandPose, 'function');
  const pose = handPose({ thumb: 1, index: 1, middle: 0.25, ring: 0.2, pinky: 0.2 });
  const original = normalizeHandPose(transform(pose, { scale: 0.2, x: 0.15, y: 0.7, z: -0.1 }));
  const moved = normalizeHandPose(transform(pose, { scale: 0.75, x: 0.8, y: 0.1, z: 0.4 }));
  assert.equal(original.length, 42);
  assert.ok(poseDistance(original, moved) < 0.001);
});

test('static pose ignores depth and tolerates modest wrist rotation', () => {
  const { GestureLibrary, normalizeHandPose } = load();
  const pose = handPose({ thumb: 1, index: 1, middle: 0.2, ring: 0.2, pinky: 0.2 });
  const library = new GestureLibrary({ holdMs: 0, minimumConfidence: 0.5 });
  for (const jitter of [-0.004, 0, 0.004]) {
    const sample = normalizeHandPose(transform2D(pose, { x: jitter }));
    library.learn('Gesture 1', frames(sample, 8, 0.002));
  }
  const liveLandmarks = transform2D(pose, {
    scale: 1.7,
    x: 0.31,
    y: -0.22,
    radians: Math.PI / 15,
  }).map((point, index) => ({ ...point, z: Math.sin(index * 1.9) * 0.8 }));
  const live = normalizeHandPose(liveLandmarks);
  assert.equal(library.evaluate(live)?.accepted, true);
});

test('version 7 spatial pose samples request recapture instead of appearing ready', () => {
  const { GestureLibrary } = load();
  const restored = GestureLibrary.fromJSON({
    version: 7,
    templates: [{ name: 'Gesture 1', kind: 'pose', samples: [Array(63).fill(0)] }],
  });
  assert.deepEqual(Array.from(restored.getIncompatibleNames()), ['Gesture 1']);
  assert.equal(restored.sampleCount('Gesture 1'), 0);
});

test('learns a static hand pose from three stable takes and rejects a different pose', () => {
  const { GestureLibrary, normalizeHandPose } = load();
  const gun = normalizeHandPose(handPose({ thumb: 1, index: 1, middle: 0.2, ring: 0.2, pinky: 0.2 }));
  const thumbsUp = normalizeHandPose(handPose({ thumb: 1, index: 0.2, middle: 0.2, ring: 0.2, pinky: 0.2 }));
  const lib = new GestureLibrary({ threshold: 0.13, minimumConfidence: 0.55, holdMs: 200 });
  lib.learn('Gesture 1', frames(gun, 8, 0.002));
  lib.learn('Gesture 1', frames(gun, 8, 0.003));
  lib.learn('Gesture 1', frames(gun, 8, 0.004));

  assert.equal(lib.kind('Gesture 1'), 'pose');
  assert.equal(lib.evaluate(gun).accepted, true);
  assert.equal(lib.evaluate(thumbsUp).accepted, false);
});

test('requires a stable pose, fires once, and rearms only after release', () => {
  const { GestureLibrary, normalizeHandPose } = load();
  const gun = normalizeHandPose(handPose({ thumb: 1, index: 1, middle: 0.2, ring: 0.2, pinky: 0.2 }));
  const open = normalizeHandPose(handPose());
  const lib = new GestureLibrary({ threshold: 0.13, minimumConfidence: 0.55, holdMs: 200, releaseMs: 150 });
  for (let take = 0; take < 3; take += 1) lib.learn('Gesture 1', frames(gun));

  assert.equal(lib.recognize(gun, 0), null);
  assert.equal(lib.recognize(gun, 100), null);
  assert.equal(lib.recognize(gun, 210)?.name, 'Gesture 1');
  assert.equal(lib.recognize(gun, 500), null, 'holding the pose must not repeat');
  assert.equal(lib.recognize(open, 550), null);
  assert.equal(lib.recognize(open, 720), null);
  assert.equal(lib.recognize(gun, 800), null);
  assert.equal(lib.recognize(gun, 1010)?.name, 'Gesture 1');
});

test('uses the median of three pose examples and persists only the static format', () => {
  const { GestureLibrary, normalizeHandPose } = load();
  const gun = normalizeHandPose(handPose({ thumb: 1, index: 1, middle: 0.2, ring: 0.2, pinky: 0.2 }));
  const open = normalizeHandPose(handPose());
  const lib = new GestureLibrary({ threshold: 0.13, minimumConfidence: 0.55, holdMs: 0 });
  lib.learn('Gesture 1', frames(gun));
  lib.learn('Gesture 1', frames(gun, 8, 0.004));
  lib.learn('Gesture 1', frames(open));
  assert.equal(lib.evaluate(gun).accepted, true);

  const saved = lib.toJSON();
  assert.equal(saved.version, 8);
  assert.equal(saved.templates[0].kind, 'pose');
  const restored = GestureLibrary.fromJSON(saved, { threshold: 0.13, minimumConfidence: 0.55, holdMs: 0 });
  assert.equal(restored.evaluate(gun).accepted, true);

  const legacy = GestureLibrary.fromJSON({
    version: 6,
    templates: [{ name: 'Gesture 1', samples: [[{ x: 0, y: 0, z: 0 }]], kind: 'motion' }],
  });
  assert.equal(legacy.sampleCount('Gesture 1'), 0);
});

test('rejects an unstable capture instead of learning hand movement as a pose', () => {
  const { GestureLibrary, normalizeHandPose } = load();
  const gun = normalizeHandPose(handPose({ thumb: 1, index: 1, middle: 0.2, ring: 0.2, pinky: 0.2 }));
  const open = normalizeHandPose(handPose());
  const lib = new GestureLibrary({ captureStabilityThreshold: 0.08 });
  assert.throws(() => lib.learn('Gesture 1', [gun, open, gun, open, gun]), /hold the pose still/i);
});
