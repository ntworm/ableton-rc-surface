// Copyright © 2026 Gabriel Worm
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Source: https://github.com/ntworm/ableton-rc-surface
//
// static/phone-v3/wake-lock.test.mjs — Unit tests for Wake Lock & Toast module.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

const source = fs.readFileSync(path.join(import.meta.dirname, 'modules/wake-lock.js'), 'utf8');

function loadModule(customGlobals = {}) {
  const context = {
    window: {},
    console,
    setTimeout,
    clearTimeout,
    ...customGlobals,
  };
  context.window = context.window || {};
  context.globalThis = context;
  vm.runInNewContext(source, context);
  return context;
}

test('window.showToast creates and displays toast element in DOM container', () => {
  let toastContainer = null;

  const mockDocument = {
    getElementById(id) {
      if (id === 'toast-container') return toastContainer;
      return null;
    },
    createElement(tagName) {
      const el = {
        tagName,
        id: '',
        className: '',
        textContent: '',
        style: {},
        children: [],
        appendChild(child) {
          child.parent = this;
          this.children.push(child);
          return child;
        },
        remove() {
          if (this.parent) {
            const idx = this.parent.children.indexOf(this);
            if (idx !== -1) this.parent.children.splice(idx, 1);
          }
        },
        get offsetHeight() {
          return 20;
        }
      };
      return el;
    },
    body: {
      children: [],
      appendChild(child) {
        child.parent = this;
        this.children.push(child);
        if (child.id === 'toast-container') {
          toastContainer = child;
        }
        return child;
      }
    }
  };

  const env = loadModule({ document: mockDocument });
  assert.equal(typeof env.window.showToast, 'function');
  assert.equal(env.window.showToast, env.window.RCSurface.showToast);

  env.window.showToast('Test Toast Warning', 'warning');

  assert.ok(toastContainer, 'toast-container should be created');
  assert.equal(toastContainer.id, 'toast-container');
  assert.equal(toastContainer.children.length, 1);

  const toast = toastContainer.children[0];
  assert.equal(toast.className, 'toast toast-warning');
  assert.equal(toast.textContent, 'Test Toast Warning');
  assert.equal(toast.style.background, '#ffaa00');
});

test('window.RCSurface.requestWakeLock requests screen lock when navigator.wakeLock is supported', async () => {
  let requestedType = null;
  const fakeLock = { type: 'screen' };
  const mockNavigator = {
    wakeLock: {
      request: async (type) => {
        requestedType = type;
        return fakeLock;
      }
    }
  };

  const env = loadModule({ navigator: mockNavigator });
  const lock = await env.window.RCSurface.requestWakeLock();
  assert.equal(requestedType, 'screen');
  assert.equal(lock, fakeLock);

  // Unsupported navigator
  const envNoSupport = loadModule({ navigator: {} });
  const lockNoSupport = await envNoSupport.window.RCSurface.requestWakeLock();
  assert.equal(lockNoSupport, null);

  // Exception thrown during request
  const mockFailingNavigator = {
    wakeLock: {
      request: async () => {
        throw new Error('NotAllowedError');
      }
    }
  };
  const envFail = loadModule({ navigator: mockFailingNavigator });
  const lockFail = await envFail.window.RCSurface.requestWakeLock();
  assert.equal(lockFail, null);
});

test('window.RCSurface.setupWakeLock binds touch/mouse/visibilitychange listeners', async () => {
  const listeners = new Map();
  let requestedCount = 0;
  const fakeLock = { type: 'screen' };

  const mockNavigator = {
    wakeLock: {
      request: async (type) => {
        requestedCount++;
        return fakeLock;
      }
    }
  };

  const mockDocument = {
    visibilityState: 'visible',
    addEventListener(event, handler) {
      if (!listeners.has(event)) listeners.set(event, []);
      listeners.get(event).push(handler);
    },
    removeEventListener(event, handler) {
      if (listeners.has(event)) {
        const arr = listeners.get(event);
        const idx = arr.indexOf(handler);
        if (idx !== -1) arr.splice(idx, 1);
      }
    }
  };

  const mockWindow = {};

  const env = loadModule({
    window: mockWindow,
    document: mockDocument,
    navigator: mockNavigator,
  });

  env.window.RCSurface.setupWakeLock();

  assert.ok(listeners.has('touchstart'), 'touchstart listener bound');
  assert.ok(listeners.has('mousedown'), 'mousedown listener bound');
  assert.ok(listeners.has('visibilitychange'), 'visibilitychange listener bound');

  // Trigger touchstart listener
  const touchHandler = listeners.get('touchstart')[0];
  await touchHandler();

  assert.equal(requestedCount, 1);
  assert.equal(listeners.get('touchstart').length, 0);
  assert.equal(listeners.get('mousedown').length, 0);

  // Trigger visibilitychange when visible
  const visHandler = listeners.get('visibilitychange')[0];
  await visHandler();
  assert.equal(requestedCount, 2);
});
