// Copyright © 2026 Gabriel Worm
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Source: https://github.com/ntworm/ableton-rc-surface
//
// static/phone-v3/playhead.test.mjs — Unit tests for Playhead UI module.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

const source = fs.readFileSync(path.join(import.meta.dirname, 'modules/playhead.js'), 'utf8');

function loadModule(mockElements = {}) {
  const listeners = new Map();
  const classes = new Set();
  let textContent = '';

  const mockBtn = {
    textContent: '',
    classList: {
      toggle(cls, active) {
        if (active) classes.add(cls);
        else classes.delete(cls);
      },
      contains(cls) {
        return classes.has(cls);
      }
    },
    addEventListener(event, fn) {
      listeners.set(event, fn);
    }
  };

  const context = {
    window: {},
    document: {
      getElementById(id) {
        if (id === 'btn-play-sim') return mockBtn;
        return mockElements[id] || null;
      }
    },
    Date,
    console,
  };
  context.window = context.window || {};
  context.globalThis = context;
  vm.runInNewContext(source, context);

  return {
    window: context.window,
    mockBtn,
    click: () => listeners.get('click')?.()
  };
}

test('playhead module sends toggle_play message over WebSocket when connected', () => {
  const sent = [];
  const env = loadModule();
  env.window.phoneWs = {
    readyState: 1, // WebSocket.OPEN
    send(data) {
      sent.push(JSON.parse(data));
    }
  };

  assert.equal(typeof env.window.RCSurface.setupPlayhead, 'function');
  env.window.RCSurface.setupPlayhead();

  env.click();
  assert.equal(sent.length, 1);
  assert.deepEqual(sent[0], { type: 'toggle_play' });
});

test('playhead module toggles offline playhead state when WebSocket is disconnected', () => {
  const env = loadModule();
  env.window.phoneWs = null;
  env.window.playheadActive = false;
  env.window.playheadBaseTimeMs = 0;

  env.window.RCSurface.setupPlayhead();

  // First click: start playhead
  env.click();
  assert.equal(env.window.playheadActive, true);
  assert.equal(env.mockBtn.textContent, '||');
  assert.equal(env.mockBtn.classList.contains('playing'), true);

  // Second click: pause playhead
  env.click();
  assert.equal(env.window.playheadActive, false);
  assert.equal(env.mockBtn.textContent, '▶');
  assert.equal(env.mockBtn.classList.contains('playing'), false);
});
