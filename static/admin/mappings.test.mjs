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

function extractFunction(source, name) {
  const marker = `function ${name}(`;
  const start = source.indexOf(marker);
  assert.notEqual(start, -1, `${name} function exists`);

  const openBrace = source.indexOf('{', start);
  let depth = 0;
  for (let i = openBrace; i < source.length; i++) {
    const char = source[i];
    if (char === '{') depth++;
    if (char === '}') depth--;
    if (depth === 0) return source.slice(start, i + 1);
  }

  throw new Error(`Could not extract ${name}`);
}

test('admin targetLabel delegates to the shared mapping core with target metadata', () => {
  const html = fs.readFileSync(path.join(import.meta.dirname, 'mappings.html'), 'utf8');
  const targetLabelSource = extractFunction(html, 'targetLabel');
  const calls = [];
  const context = {
    result: null,
    targets: [{ trackIndex: 0, name: 'Drums' }],
    window: {
      targetLabel(target, targetsList) {
        calls.push({ target, targetsList });
        return `${targetsList[0].name} -> ${target.type}`;
      },
    },
  };
  vm.createContext(context);

  vm.runInContext(`${targetLabelSource}\nresult = targetLabel({ type: 'mixer_volume', trackIndex: 0 });`, context);

  assert.equal(context.result, 'Drums -> mixer_volume');
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].targetsList, context.targets);
});

test('admin shell loads local assets through relative paths', () => {
  const html = fs.readFileSync(path.join(import.meta.dirname, 'index.html'), 'utf8');

  assert.match(html, /href="style\.css"/);
  assert.match(html, /src="app\.js"/);
  assert.doesNotMatch(html, /(?:href|src)="\/static\/admin\//);
});

test('admin mappings expose only current canonical phone controls', () => {
  const source = fs.readFileSync(path.join(import.meta.dirname, 'mappings-core.js'), 'utf8');
  const context = { window: {} };
  vm.createContext(context);

  vm.runInContext(source, context);

  const groups = context.window.phoneControls;
  const byGroup = new Map(groups.map((g) => [g.group, g.items]));
  const items = (group) => Array.from(byGroup.get(group) || []);
  assert.deepEqual(items('Pads'), Array.from({ length: 12 }, (_, i) => `pad-${i + 1}`));
  assert.deepEqual(items('Mix Knobs (1-6)'), Array.from({ length: 6 }, (_, i) => `knob-${i + 1}`));
  assert.deepEqual(items('Mix Faders (1-6)'), Array.from({ length: 6 }, (_, i) => `fader-${i + 1}`));
  assert.deepEqual(items('LFOs (1-4)'), ['toggle-1', 'toggle-2', 'toggle-3', 'toggle-4']);
  assert.deepEqual(items('Stutters (Buttons 1-4)'), ['button-1', 'button-2', 'button-3', 'button-4']);
  assert.equal(byGroup.has('Expression (' + 'Rib' + 'bons 1-2)'), false);
  const controls = groups.flatMap((g) => g.items);
  for (const current of ['sensor.audio.rms', 'sensor.audio.pitch', 'sensor.vision.active', 'sensor.vision.color.b']) {
    assert.equal(controls.includes(current), true, `current control should be exposed: ${current}`);
  }
  for (const retired of ['knob-7', 'fader-7', 'toggle-5', 'button-5', 'rib' + 'bon-3', 'gate-1', 'scene-1', 'sensor.light.lux']) {
    assert.equal(controls.includes(retired), false, `retired control should not be exposed: ${retired}`);
  }
});

test('admin dashboard does not render retired light sensor telemetry', () => {
  const source = fs.readFileSync(path.join(import.meta.dirname, 'app.js'), 'utf8');

  assert.doesNotMatch(source, /light_reading/);
  assert.doesNotMatch(source, /data-ref="light-line"/);
  assert.doesNotMatch(source, /data-signal-group="lux"/);
});
