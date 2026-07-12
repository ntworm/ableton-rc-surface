// Copyright © 2026 Gabriel Worm
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Source: https://github.com/ntworm/ableton-rc-surface
//
// This file is part of Ableton RC Surface, distributed under the
// PolyForm Noncommercial License 1.0.0. You may obtain a copy of
// the License at https://polyformproject.org/licenses/noncommercial/1.0.0
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.join(__dirname, 'audio-smoothing.js');

const ctx = { window: {}, console };
ctx.window = ctx;
vm.createContext(ctx);
vm.runInContext(fs.readFileSync(SRC, 'utf8'), ctx);

const { smoothAudioValue, gainSmoothedRms } = ctx.AudioSmoothing;

// --- smoothAudioValue (existente, sanity) ---

test('smoothAudioValue: ramp progressivo converge pra raw', () => {
  let prev = 0;
  for (let i = 0; i < 200; i++) prev = smoothAudioValue(prev, 0.5, 0.5);
  assert.ok(Math.abs(prev - 0.5) < 0.001);
});

// --- gainSmoothedRms (novo) ---

test('gainSmoothedRms: raw baixo com gain 3x amplifica antes de suavizar', () => {
  // raw=0.05, prev=0, alpha~=0.18 (alpha é função do raw, não do gain)
  // output = 0*0.82 + (0.05*3=0.15)*0.18 = 0.027
  const out = gainSmoothedRms(0, 0.05, 0.18);
  assert.ok(Math.abs(out - 0.027) < 0.001, `expected ~0.027 got ${out}`);
});

test('gainSmoothedRms: raw alto satura (raw*gain >= 1)', () => {
  // raw=0.5, gain=3 → raw*gain=1.5 → clamp 1.0
  // com prev=0: output = 0*0.5 + 1.0*0.5 = 0.5 (steady pra 1.0)
  assert.equal(gainSmoothedRms(0, 0.5, 0.5), 0.5);
  // converge em algumas iteracoes:
  let prev = 0;
  for (let i = 0; i < 30; i++) prev = gainSmoothedRms(prev, 0.5, 0.5);
  assert.ok(prev > 0.99, `expected ~1.0 got ${prev}`);
});

test('gainSmoothedRms: steady-state abaixo do clamp converge pra raw*gain', () => {
  // raw=0.1, target=0.3, alpha=0.5
  let prev = 0;
  for (let i = 0; i < 200; i++) prev = gainSmoothedRms(prev, 0.1, 0.5);
  assert.ok(Math.abs(prev - 0.3) < 0.001, `expected ~0.3 got ${prev}`);
});

test('gainSmoothedRms: steady-state acima do clamp trava em 1.0', () => {
  let prev = 0;
  for (let i = 0; i < 100; i++) prev = gainSmoothedRms(prev, 0.5, 0.5);
  assert.equal(Math.round(prev * 1000), 1000);
});

test('gainSmoothedRms: ganho customizável sobrescreve default', () => {
  // gain=1 → equivalência com smoothAudioValue (já testado mas confirma integração)
  // raw=0.5, prev=0, alpha=0.5: 0 + 0.5*0.5 = 0.25
  const out = gainSmoothedRms(0, 0.5, 0.5, 1);
  assert.equal(Math.round(out * 1000), 250);
});

test('gainSmoothedRms: zero é o piso', () => {
  // raw=0, output = 0*alpha + prev*(1-alpha). prev=0 também: 0.
  assert.equal(gainSmoothedRms(0, 0, 0.5), 0);
  assert.equal(gainSmoothedRms(0.5, 0, 0.5), 0.25);
});
