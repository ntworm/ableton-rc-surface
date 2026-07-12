// Copyright © 2026 Gabriel Worm
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Source: https://github.com/ntworm/ableton-rc-surface
//
// This file is part of Ableton RC Surface, distributed under the
// PolyForm Noncommercial License 1.0.0. You may obtain a copy of
// the License at https://polyformproject.org/licenses/noncommercial/1.0.0
// static/phone-v3/stage-mode-controller.js
//
// Stage Mode controller — encapsulates the "sticky fullscreen" behavior so
// the visual stage mode and the fullscreen API stay in lockstep:
//
//   - enter(): adds `stage-mode` to <body> and requests fullscreen on
//     document.documentElement (the <html> root, which is what gives the
//     page a real fullscreen surface on iOS Safari, not just <body>).
//   - exit(): removes `stage-mode` and exits fullscreen.
//   - handleFullscreenChange(): if the body still has `stage-mode` (i.e.
//     the exit was not user-initiated via our exit() path) and fullscreen
//     dropped, re-arm fullscreen. Debounced so a flurry of system events
//     (iOS edge gestures, native confirm dialogs) doesn't cause a
//     fullscreen-loop.
//
// Why this is split out of controls.js: controls.js bundles the whole
// phone UI together and depends on real DOM/HTML, which is hard to unit
// test. The controller is pure ESM and operates on whatever document /
// button / element you hand it, which keeps the behavior testable
// under `node --test` without jsdom.
//
// The module also exposes itself on `globalThis.AbletonRcStageMode` so it
// can be loaded via a classic <script> tag (no module type) and consumed
// by controls.js. The same code is also ESM-importable from the test
// suite (see tests/stage-mode-fullscreen.test.mjs).

const DEFAULT_REARM_DEBOUNCE_MS = 350;

export function createStageModeController(options = {}) {
  if (!options || typeof options !== "object") {
    throw new TypeError("createStageModeController requires an options object");
  }
  const {
    document: doc,
    button = null,
    rearmDebounceMs = DEFAULT_REARM_DEBOUNCE_MS,
  } = options;

  if (!doc) {
    throw new TypeError("createStageModeController requires a document");
  }

  let mounted = false;
  // True when the user (or our exit() call) explicitly asked to leave
  // stage mode. Prevents the fullscreenchange handler from re-arming
  // after a deliberate exit.
  let userExited = false;
  // Timestamp of the last re-arm attempt. Used to debounce bursts of
  // fullscreenchange events that fire as a result of a single user
  // gesture (e.g. iOS edge swipe exits fullscreen, several events
  // follow).
  let lastRearmAt = 0;
  let pendingRearmTimer = null;

  function isInStageMode() {
    return doc.body && doc.body.classList && doc.body.classList.contains("stage-mode");
  }

  function setStageClass(active) {
    if (!doc.body || !doc.body.classList) return;
    doc.body.classList.toggle("stage-mode", !!active);
    if (button) {
      button.classList.toggle("on", !!active);
      try {
        button.setAttribute("aria-pressed", active ? "true" : "false");
      } catch {
        // setAttribute may not exist on the test stub
      }
      button.textContent = active ? "EXIT" : "STAGE";
    }
    // notify any listeners (e.g. controls.js dispatches resize for
    // layout reflow on stage entry/exit)
    try {
      if (typeof window !== "undefined" && window && typeof window.dispatchEvent === "function") {
        window.dispatchEvent(new Event("resize"));
      }
    } catch {
      // no-op in test environments where window may be undefined
    }
  }

  function isFullscreenActive() {
    return !!doc.fullscreenElement;
  }

  function requestRootFullscreen() {
    const root = doc.documentElement;
    if (root && typeof root.requestFullscreen === "function" && !doc.fullscreenElement) {
      try {
        return root.requestFullscreen();
      } catch (e) {
        return Promise.resolve();
      }
    }
    return Promise.resolve();
  }

  function exitActiveFullscreen() {
    if (doc.fullscreenElement && typeof doc.exitFullscreen === "function") {
      try {
        return doc.exitFullscreen();
      } catch (e) {
        return Promise.resolve();
      }
    }
    return Promise.resolve();
  }

  function scheduleRearm() {
    if (pendingRearmTimer !== null) return;
    const now = Date.now();
    const sinceLast = now - lastRearmAt;
    const delay = sinceLast >= rearmDebounceMs ? 0 : rearmDebounceMs - sinceLast;
    pendingRearmTimer = setTimeout(() => {
      pendingRearmTimer = null;
      lastRearmAt = Date.now();
      if (userExited) return;
      if (!isInStageMode()) return;
      if (isFullscreenActive()) return;
      // re-arm
      requestRootFullscreen();
    }, delay);
  }

  function onFullscreenChange() {
    if (userExited) return;
    if (!isInStageMode()) return;
    if (isFullscreenActive()) return;
    // Stage mode is still wanted, but fullscreen dropped. This is most
    // likely an involuntary exit (system gesture, native confirm, etc.).
    // Re-arm.
    scheduleRearm();
  }

  async function enter() {
    userExited = false;
    setStageClass(true);
    if (typeof window !== "undefined" && window && typeof window.dispatchEvent === "function") {
      window.dispatchEvent(new Event("resize"));
    }
    try {
      // Wait for the browser to actually grant fullscreen. If the request
      // is rejected (no user gesture, secure-context violation, system
      // dialog ate the gesture, etc.) we roll the UI back so the state
      // and the visible chrome stay in sync. Without this rollback the
      // user sees a phantom "EXIT" button while the page is still
      // showing the URL bar — exactly the regression reported when the
      // mic permission prompt ate the first fullscreen attempt.
      await requestRootFullscreen();
    } catch (e) {
      setStageClass(false);
      if (typeof window !== "undefined" && window && typeof window.dispatchEvent === "function") {
        window.dispatchEvent(new Event("resize"));
      }
      throw e;
    }
  }

  async function exit() {
    userExited = true;
    if (pendingRearmTimer !== null) {
      clearTimeout(pendingRearmTimer);
      pendingRearmTimer = null;
    }
    setStageClass(false);
    if (typeof window !== "undefined" && window && typeof window.dispatchEvent === "function") {
      window.dispatchEvent(new Event("resize"));
    }
    return exitActiveFullscreen();
  }

  function mount() {
    if (mounted) return;
    mounted = true;
    doc.addEventListener("fullscreenchange", onFullscreenChange);
    if (button && typeof button.addEventListener === "function") {
      button.addEventListener("click", () => {
        if (isInStageMode()) {
          exit();
        } else {
          enter();
        }
      });
    }
  }

  function unmount() {
    if (!mounted) return;
    mounted = false;
    // we don't have a removeEventListener reference, but the controller
    // is expected to be a singleton for the page lifetime, so unmount
    // is provided for completeness in tests only.
  }

  return {
    mount,
    unmount,
    enter,
    exit,
    handleFullscreenChange: onFullscreenChange,
  };
}

// Expose for classic <script> consumers (e.g. controls.js) while keeping
// the same module ESM-importable for tests.
if (typeof globalThis !== "undefined") {
  globalThis.AbletonRcStageMode = { createStageModeController };
}
