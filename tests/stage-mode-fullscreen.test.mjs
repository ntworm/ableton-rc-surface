// Copyright © 2026 Gabriel Worm
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Source: https://github.com/ntworm/ableton-rc-surface
//
// This file is part of Ableton RC Surface, distributed under the
// PolyForm Noncommercial License 1.0.0. You may obtain a copy of
// the License at https://polyformproject.org/licenses/noncommercial/1.0.0
// tests/stage-mode-fullscreen.test.mjs
//
// Tests for the stage-mode "sticky fullscreen" behavior: when the body has
// the `stage-mode` class, any involuntary fullscreen exit (system gesture,
// native dialog, etc.) should re-arm fullscreen instead of abandoning stage
// mode. When the user genuinely wants to leave stage mode, the explicit
// exit() path is the only one that removes the class.
//
// We test the controller in isolation by injecting a fake document / element
// and a fake requestFullscreen/exitFullscreen API. The controller is a pure
// ESM module with no DOM dependencies, so we can exercise it under
// `node --test` without jsdom.

import assert from "node:assert/strict";
import test from "node:test";
import {
  createStageModeController,
} from "../static/phone-v3/stage-mode-controller.js";

/**
 * Build a minimal fake DOM sufficient for the controller.
 *
 * requestFullscreen / exitFullscreen are manually resolved via the
 * returned `complete` helpers. Tests can:
 *   - call c.enter() (returns a promise that resolves only when
 *     complete.request() is called) to simulate the user tapping STAGE.
 *   - call dom.document.fireFullscreenChange() to simulate the system
 *     delivering a fullscreenchange event (e.g. after a gesture).
 *   - call dom.complete.exit() to simulate fullscreen actually dropping.
 */
function makeFakeDom() {
  let bodyClasses = new Set();
  const fullscreenElementRef = { current: null };

  let resolveRequest = () => {};
  let resolveExit = () => {};
  const requestPromise = new Promise((res) => (resolveRequest = res));
  const exitPromise = new Promise((res) => (resolveExit = res));

  const fakeElement = {
    requestFullscreen: () => {
      fakeElement.requestFullscreen.calls += 1;
      return requestPromise;
    },
    exitFullscreen: () => {
      fakeElement.exitFullscreen.calls += 1;
      return exitPromise;
    },
  };
  fakeElement.requestFullscreen.calls = 0;
  fakeElement.exitFullscreen.calls = 0;

  const document = {
    documentElement: fakeElement,
    get fullscreenElement() {
      return fullscreenElementRef.current;
    },
    get body() {
      return {
        classList: {
          contains(cls) {
            return bodyClasses.has(cls);
          },
          add(cls) {
            bodyClasses.add(cls);
          },
          remove(cls) {
            bodyClasses.delete(cls);
          },
          toggle(cls, force) {
            if (force === true) bodyClasses.add(cls);
            else if (force === false) bodyClasses.delete(cls);
            else if (bodyClasses.has(cls)) bodyClasses.delete(cls);
            else bodyClasses.add(cls);
          },
        },
      };
    },
    exitFullscreen: () => {
      document.exitFullscreen.calls += 1;
      return exitPromise;
    },
    addEventListener(type, handler) {
      document.listeners.push({ type, handler });
    },
    listeners: [],
    fireFullscreenChange() {
      for (const l of document.listeners) {
        if (l.type === "fullscreenchange") l.handler();
      }
    },
  };
  document.exitFullscreen.calls = 0;

  const button = {
    classList: { toggle() {}, contains() { return false; }, add() {}, remove() {} },
    setAttribute() {},
    textContent: "",
  };

  return {
    document,
    bodyClasses,
    button,
    fakeElement,
    fullscreenElementRef,
    complete: {
      request: () => {
        fullscreenElementRef.current = fakeElement;
        resolveRequest();
      },
      exit: () => {
        fullscreenElementRef.current = null;
        resolveExit();
      },
    },
  };
}

const tick = (ms) => new Promise((res) => setTimeout(res, ms));

test("enter() adds stage-mode class and requests fullscreen on documentElement", async () => {
  const dom = makeFakeDom();
  const c = createStageModeController({ document: dom.document, button: dom.button });
  c.mount();

  const enterPromise = c.enter();
  // The class is added synchronously, but fullscreen promise is pending
  // until we resolve it.
  assert.equal(dom.bodyClasses.has("stage-mode"), true, "stage-mode class added immediately");
  assert.equal(dom.fakeElement.requestFullscreen.calls, 1, "requestFullscreen called once");

  // Resolve the underlying fullscreen request
  dom.complete.request();
  await enterPromise;
});

test("exit() removes stage-mode class and exits fullscreen", async () => {
  const dom = makeFakeDom();
  const c = createStageModeController({ document: dom.document, button: dom.button });
  c.mount();

  const enterPromise = c.enter();
  dom.complete.request();
  await enterPromise;
  assert.equal(dom.bodyClasses.has("stage-mode"), true);

  const exitPromise = c.exit();
  // Class removed immediately
  assert.equal(dom.bodyClasses.has("stage-mode"), false, "stage-mode class removed immediately");
  dom.complete.exit();
  await exitPromise;
});

test("fullscreenchange while in stage-mode re-arms fullscreen (not exit)", async () => {
  const dom = makeFakeDom();
  const c = createStageModeController({ document: dom.document, button: dom.button });
  c.mount();

  const enterPromise = c.enter();
  dom.complete.request();
  await enterPromise;
  const initialCalls = dom.fakeElement.requestFullscreen.calls;

  // Simulate the system dropping fullscreen. This is what the OS does
  // (iOS edge swipe, native confirm dialog, etc.) — the fullscreen
  // element goes null, then fullscreenchange fires.
  dom.fullscreenElementRef.current = null;
  dom.document.fireFullscreenChange();

  // The controller schedules a re-arm with debounce. Wait past debounce window.
  await tick(400);

  assert.equal(
    dom.bodyClasses.has("stage-mode"),
    true,
    "stage-mode class still present after involuntary fullscreen exit",
  );
  assert.ok(
    dom.fakeElement.requestFullscreen.calls > initialCalls,
    `requestFullscreen was re-armed (was ${initialCalls}, now ${dom.fakeElement.requestFullscreen.calls})`,
  );
});

test("fullscreenchange while NOT in stage-mode is a no-op", async () => {
  const dom = makeFakeDom();
  const c = createStageModeController({ document: dom.document, button: dom.button });
  c.mount();

  // Never enter stage mode
  dom.document.fireFullscreenChange();
  await tick(400);

  assert.equal(dom.bodyClasses.has("stage-mode"), false);
  assert.equal(
    dom.fakeElement.requestFullscreen.calls,
    0,
    "no fullscreen requests when not in stage mode",
  );
});

test("debounce: a burst of fullscreenchange events triggers at most one re-arm", async () => {
  const dom = makeFakeDom();
  const c = createStageModeController({ document: dom.document, button: dom.button });
  c.mount();

  const enterPromise = c.enter();
  dom.complete.request();
  await enterPromise;
  const initialCalls = dom.fakeElement.requestFullscreen.calls;

  // Simulate fullscreen dropping (system gesture) and the burst of
  // fullscreenchange events that follow.
  dom.fullscreenElementRef.current = null;
  for (let i = 0; i < 10; i++) {
    dom.document.fireFullscreenChange();
  }
  await tick(400);

  const rearmCount = dom.fakeElement.requestFullscreen.calls - initialCalls;
  assert.ok(
    rearmCount >= 1 && rearmCount <= 2,
    `rearm count ${rearmCount} should be 1 (or 2 if the debounce window expired) within 400ms`,
  );
});

test("explicit exit() prevents re-arm even when fullscreenchange fires", async () => {
  const dom = makeFakeDom();
  const c = createStageModeController({ document: dom.document, button: dom.button });
  c.mount();

  const enterPromise = c.enter();
  dom.complete.request();
  await enterPromise;

  const exitPromise = c.exit();
  dom.complete.exit();
  await exitPromise;
  const callsAfterExit = dom.fakeElement.requestFullscreen.calls;

  // Even if a stray fullscreenchange fires (e.g. browser delayed event),
  // we should not re-arm
  dom.document.fireFullscreenChange();
  await tick(400);

  assert.equal(dom.bodyClasses.has("stage-mode"), false);
  assert.equal(
    dom.fakeElement.requestFullscreen.calls,
    callsAfterExit,
    "no rearm after explicit exit",
  );
});
