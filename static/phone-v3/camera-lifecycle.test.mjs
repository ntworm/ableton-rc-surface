// Copyright © 2026 Gabriel Worm
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

function load() {
  const source = fs.readFileSync(path.join(import.meta.dirname, 'camera-lifecycle.js'), 'utf8');
  const context = { window: null, globalThis: null, Promise, Error };
  context.window = context;
  context.globalThis = context;
  vm.runInNewContext(source, context);
  return context.AbletonRcCameraLifecycle;
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function fakeStream() {
  const track = { stopped: false, stop() { this.stopped = true; } };
  return { track, stream: { getTracks: () => [track] } };
}

test('two start calls share one acquisition and one stream', async () => {
  const { CameraLifecycle } = load();
  const gate = deferred();
  let calls = 0;
  const lifecycle = new CameraLifecycle({ acquire: () => { calls += 1; return gate.promise; } });
  const first = lifecycle.start();
  const second = lifecycle.start();
  const media = fakeStream();
  gate.resolve(media.stream);
  assert.equal(await first, media.stream);
  assert.equal(await second, media.stream);
  assert.equal(calls, 1);
  assert.equal(lifecycle.state, 'running');
});

test('failed first start is retryable without reloading', async () => {
  const { CameraLifecycle } = load();
  const media = fakeStream();
  let calls = 0;
  const lifecycle = new CameraLifecycle({ acquire: async () => {
    calls += 1;
    if (calls === 1) throw Object.assign(new Error('busy'), { name: 'NotReadableError' });
    return media.stream;
  } });
  await assert.rejects(lifecycle.start(), /busy/);
  assert.equal(lifecycle.state, 'error');
  assert.equal(await lifecycle.start(), media.stream);
  assert.equal(lifecycle.state, 'running');
});

test('stop during start disposes the late stream', async () => {
  const { CameraLifecycle } = load();
  const gate = deferred();
  const media = fakeStream();
  const lifecycle = new CameraLifecycle({ acquire: () => gate.promise });
  const starting = lifecycle.start();
  await lifecycle.stop();
  gate.resolve(media.stream);
  await assert.rejects(starting, /cancel/i);
  assert.equal(media.track.stopped, true);
  assert.equal(lifecycle.state, 'off');
});

test('stop releases a running stream', async () => {
  const { CameraLifecycle } = load();
  const media = fakeStream();
  const lifecycle = new CameraLifecycle({ acquire: async () => media.stream });
  await lifecycle.start();
  await lifecycle.stop();
  assert.equal(media.track.stopped, true);
  assert.equal(lifecycle.stream, null);
  assert.equal(lifecycle.state, 'off');
});
