import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';

function load() {
  const window = {};
  const context = vm.createContext({ window, globalThis: window });
  vm.runInContext(fs.readFileSync(path.join(import.meta.dirname, 'vision-control-state.js'), 'utf8'), context);
  return window;
}

test('restored gesture templates are capped to three takes before the UI renders', () => {
  const { normalizeVisionGestureTemplates } = load();
  const templates = normalizeVisionGestureTemplates([{ name: 'Gesture 1', samples: [1, 2, 3, 4] }]);
  assert.deepEqual(Array.from(templates[0].samples), [1, 2, 3]);
});

test('vision detectors are opt-in and persist only explicit choices', () => {
  const { VisionControlState } = load();
  const state = new VisionControlState();
  for (const detector of ['open', 'fist', 'pinch', 'victory', 'fingers']) {
    assert.equal(state.detectorEnabled(detector), false);
  }
  state.setDetector('victory', true);
  assert.equal(state.detectorEnabled('victory'), true);
  assert.equal(state.toJSON().detectors.victory, true);
});

test('vision learned gestures have exactly three stable numbered controls', () => {
  const { VisionControlState } = load();
  const state = new VisionControlState({}, [
    { name: 'Wave' }, { name: 'Circle' }, { name: 'Push' }, { name: 'Ignored' },
  ]);
  assert.equal(state.slots.length, 3);
  assert.deepEqual(Array.from(state.slots, (slot) => slot.name), ['Wave', 'Circle', 'Push']);
  assert.equal(state.controlForSlot(1), 'sensor.vision.gesture.1');
  assert.equal(state.controlForSlot(3), 'sensor.vision.gesture.3');
  assert.equal(state.slotForGesture('circle').id, 2);
});

test('new learned gesture slots have fixed names and need no performer text input', () => {
  const { VisionControlState } = load();
  const state = new VisionControlState();
  assert.deepEqual(Array.from(state.slots, (slot) => slot.name), ['Gesture 1', 'Gesture 2', 'Gesture 3']);
});

test('saved slot names take precedence over migrated gesture templates', () => {
  const { VisionControlState } = load();
  const state = new VisionControlState({ slots: [{ name: 'Saved wave' }] }, [{ name: 'Old wave' }]);
  assert.equal(state.slots[0].name, 'Saved wave');
  assert.equal(state.slots[1].name, 'Gesture 2');
});

test('hand label only exposes detectors explicitly enabled by the performer', () => {
  const { VisionControlState } = load();
  const state = new VisionControlState();
  const hand = { active: true, open: true, fist: true, fingers: 0.8 };
  assert.equal(state.describeHand(hand), 'Hand tracked');
  state.setDetector('open', true);
  assert.equal(state.describeHand(hand), 'Open hand');
  state.setDetector('open', false);
  state.setDetector('fingers', true);
  assert.equal(state.describeHand(hand), '4 fingers');
});
