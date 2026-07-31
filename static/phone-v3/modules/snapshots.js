// Copyright © 2026 Gabriel Worm
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Source: https://github.com/ntworm/ableton-rc-surface
//
// modules/snapshots.js — Snapshots & Vector Morphing Engine for RC Surface phone client.
// Extracted from controls.js.

(function () {
  'use strict';

  window.RCSurface = window.RCSurface || {};

  const SNAPSHOT_COUNT = 8;
  const emptySnapshots = () => Array.from({ length: SNAPSHOT_COUNT }, () => null);
  let snapshots = emptySnapshots();
  let morphRafId = null;
  let morphMode = 'grid';
  let snapshotCaptureMode = false;
  let morphDurationSec = 1.0;

  function getLfoStates() {
    return window.lfoStates || (typeof lfoStates !== 'undefined' ? lfoStates : null);
  }

  function getStutterStates() {
    return window.stutterStates || (typeof stutterStates !== 'undefined' ? stutterStates : null);
  }

  function cloneControlStates() {
    const states = JSON.parse(JSON.stringify(window.currentControlStates || {}));
    const lfos = getLfoStates();
    if (lfos && typeof lfos.entries === 'function') {
      for (const [name, state] of lfos.entries()) {
        states[name] = state.active ? 1.0 : 0.0;
      }
    }
    const stutters = getStutterStates();
    if (stutters && typeof stutters.entries === 'function') {
      for (const [name, state] of stutters.entries()) {
        states[name] = state.pressed ? 1.0 : 0.0;
      }
    }
    return states;
  }

  function loadSnapshots() {
    try {
      if (typeof localStorage === 'undefined') return;
      const saved = localStorage.getItem('ableton-rc:snapshots');
      if (!saved) return;
      const parsed = JSON.parse(saved);
      snapshots = Array.isArray(parsed) && parsed.length === SNAPSHOT_COUNT ? parsed : emptySnapshots();
    } catch (e) {
      snapshots = emptySnapshots();
    }
  }

  function saveSnapshots() {
    try {
      if (typeof localStorage === 'undefined') return;
      localStorage.setItem('ableton-rc:snapshots', JSON.stringify(snapshots));
    } catch (e) {}
  }

  function updateSnapshotButton(btn, idx) {
    if (!btn || idx < 0 || idx >= snapshots.length) return;
    const isEmpty = !snapshots[idx];
    btn.classList.toggle('empty', isEmpty);
    const label = btn.querySelector('.status-indicator');
    if (label) {
      if (isEmpty) {
        label.textContent = 'Empty';
      } else {
        label.textContent = btn.dataset.flashSaved === 'true' ? 'Saved' : 'Ready';
      }
    }
  }

  function updateSnapshotSlotUI() {
    if (typeof document === 'undefined') return;
    document.querySelectorAll('.snapshot-slot').forEach((btn) => {
      updateSnapshotButton(btn, Number(btn.dataset.slot) - 1);
    });
    document.querySelectorAll('.perf-snapshot-slot').forEach((btn) => {
      updateSnapshotButton(btn, Number(btn.dataset.perfSnapshotSlot) - 1);
    });
    if (typeof window.dispatchEvent === 'function' && typeof CustomEvent !== 'undefined') {
      window.dispatchEvent(new Event('ableton-rc:snapshots-updated'));
    }
  }

  function setSnapshotCaptureMode(active) {
    snapshotCaptureMode = !!active;
    if (typeof document === 'undefined') return;
    [
      document.getElementById('btn-snapshot-capture'),
      document.getElementById('btn-perf-snapshot-capture'),
    ].forEach((btn) => {
      if (!btn) return;
      btn.classList.toggle('active', snapshotCaptureMode);
      btn.setAttribute('aria-pressed', snapshotCaptureMode ? 'true' : 'false');
    });
  }

  function clearMorphingSlots() {
    if (typeof document === 'undefined') return;
    document.querySelectorAll('.snapshot-slot').forEach((btn) => btn.classList.remove('morphing'));
    document.querySelectorAll('.perf-snapshot-slot').forEach((btn) => btn.classList.remove('morphing'));
  }

  function cancelMorph() {
    if (morphRafId && typeof cancelAnimationFrame === 'function') {
      cancelAnimationFrame(morphRafId);
      morphRafId = null;
    }
    clearMorphingSlots();
  }

  function applyControlValue(key, value) {
    if (window.controlSetters && Object.keys(window.controlSetters).length > 0) {
      if (typeof window.controlSetters[key] === 'function') {
        try {
          window.controlSetters[key](value);
        } catch (e) {}
      }
      return;
    }
    if (typeof window.onControl === 'function') {
      try {
        window.onControl({ name: key, value });
      } catch (e) {}
    }
  }

  function isModulatorGateKey(key) {
    return /^toggle-\d+$/.test(key) || /^button-\d+$/.test(key);
  }

  function resolveMorphValue(key, startVal, targetVal, progress) {
    if (!isModulatorGateKey(key)) {
      return startVal + (targetVal - startVal) * progress;
    }
    const targetActive = Number(targetVal) > 0.5;
    if (targetActive) return 1;
    const startActive = Number(startVal) > 0.5;
    return startActive && progress < 1 ? 1 : 0;
  }

  function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
  }

  function getSnapshotNumber(targetState, key, fallback) {
    if (!Object.prototype.hasOwnProperty.call(targetState, key)) return fallback;
    const value = Number(targetState[key]);
    return Number.isFinite(value) ? clamp(value, 0, 1) : fallback;
  }

  function collectSnapshotModulatorNames(targetState, prefix) {
    const names = new Set();
    const pattern = prefix === 'toggle'
      ? /^(toggle-\d+)(?:\.(?:rate|depth))?$/
      : /^(button-\d+)(?:\.(?:rate|count))?$/;
    for (const key of Object.keys(targetState)) {
      const match = key.match(pattern);
      if (match) names.add(match[1]);
    }
    return names;
  }

  function emitSnapshotMorphModulatorTargets(targetState, durationMs) {
    const morphMs = Math.max(0, Math.round(Number(durationMs) || 0));
    const lfos = getLfoStates();
    const stutters = getStutterStates();
    const sendLfo = window.sendLfoState || (typeof sendLfoState !== 'undefined' ? sendLfoState : null);
    const sendStutter = window.sendStutterState || (typeof sendStutterState !== 'undefined' ? sendStutterState : null);

    if (lfos && typeof sendLfo === 'function') {
      for (const name of collectSnapshotModulatorNames(targetState, 'toggle')) {
        const state = lfos.get(name);
        if (!state) continue;
        const active = Object.prototype.hasOwnProperty.call(targetState, name)
          ? Number(targetState[name]) > 0.5
          : !!state.active;
        sendLfo(name, {
          active,
          rate: getSnapshotNumber(targetState, `${name}.rate`, state.rate),
          depth: getSnapshotNumber(targetState, `${name}.depth`, state.depth),
        }, { morphMs });
      }
    }

    if (stutters && typeof sendStutter === 'function') {
      for (const name of collectSnapshotModulatorNames(targetState, 'button')) {
        const state = stutters.get(name);
        if (!state) continue;
        const pressed = Object.prototype.hasOwnProperty.call(targetState, name)
          ? Number(targetState[name]) > 0.5
          : !!state.pressed;
        sendStutter(name, {
          pressed,
          rate: getSnapshotNumber(targetState, `${name}.rate`, state.rate),
          count: getSnapshotNumber(targetState, `${name}.count`, state.count),
        }, { morphMs });
      }
    }
  }

  function startLinearMorph(targetState, durationSec = 1.0, onComplete) {
    cancelMorph();
    const durationMs = Math.max(50, (Number(durationSec) || 1.0) * 1000);
    emitSnapshotMorphModulatorTargets(targetState, durationMs);
    const startState = cloneControlStates();
    const startTime = Date.now();

    const keys = new Set([
      ...Object.keys(startState),
      ...Object.keys(targetState || {}),
    ]);

    function step() {
      const elapsed = Date.now() - startTime;
      const progress = Math.min(1.0, elapsed / durationMs);

      const applyStep = () => {
        for (const key of keys) {
          const startVal = Number(startState[key]) || 0;
          const targetVal = Object.prototype.hasOwnProperty.call(targetState, key)
            ? Number(targetState[key])
            : startVal;
          const currentVal = resolveMorphValue(key, startVal, targetVal, progress);
          applyControlValue(key, currentVal);
        }
      };

      if (typeof window.withModulatorEmitSuppressed === 'function') {
        window.withModulatorEmitSuppressed(applyStep);
      } else {
        applyStep();
      }

      if (progress < 1.0) {
        morphRafId = typeof requestAnimationFrame === 'function' ? requestAnimationFrame(step) : null;
      } else {
        morphRafId = null;
        clearMorphingSlots();
        if (typeof onComplete === 'function') onComplete();
      }
    }

    step();
  }

  function handleSnapshotSlot(idx, btn) {
    if (idx < 0 || idx >= snapshots.length) return;
    if (snapshotCaptureMode) {
      snapshots[idx] = cloneControlStates();
      saveSnapshots();

      const targetSlot = idx + 1;
      if (typeof document !== 'undefined') {
        document.querySelectorAll(`.snapshot-slot[data-slot="${targetSlot}"], .perf-snapshot-slot[data-perf-snapshot-slot="${targetSlot}"]`)
          .forEach(btnEl => {
            btnEl.dataset.flashSaved = 'true';
          });
      }

      updateSnapshotSlotUI();

      setTimeout(() => {
        if (typeof document !== 'undefined') {
          document.querySelectorAll(`.snapshot-slot[data-slot="${targetSlot}"], .perf-snapshot-slot[data-perf-snapshot-slot="${targetSlot}"]`)
            .forEach(btnEl => {
              delete btnEl.dataset.flashSaved;
            });
        }
        updateSnapshotSlotUI();
      }, 1500);

      setSnapshotCaptureMode(false);
      return;
    }

    const snap = snapshots[idx];
    if (!snap) return;
    startLinearMorph(snap, morphDurationSec, () => {
      if (btn) btn.classList.remove('morphing');
    });
    if (btn) btn.classList.add('morphing');
  }

  let snapshotsInitialized = false;

  function setupSnapshots() {
    loadSnapshots();

    if (typeof document === 'undefined') return;
    if (snapshotsInitialized) {
      updateSnapshotSlotUI();
      return;
    }
    snapshotsInitialized = true;

    [
      document.getElementById('btn-snapshot-capture'),
      document.getElementById('btn-perf-snapshot-capture'),
    ].forEach((btn) => {
      if (!btn) return;
      btn.addEventListener('click', () => setSnapshotCaptureMode(!snapshotCaptureMode));
    });

    document.querySelectorAll('.snapshot-slot').forEach((btn) => {
      const slotIdx = Number(btn.dataset.slot) - 1;
      btn.addEventListener('click', () => handleSnapshotSlot(slotIdx, btn));
    });

    document.querySelectorAll('.perf-snapshot-slot').forEach((btn) => {
      const slotIdx = Number(btn.dataset.perfSnapshotSlot) - 1;
      btn.addEventListener('click', () => handleSnapshotSlot(slotIdx, btn));
    });

    updateSnapshotSlotUI();
  }

  // Public API
  window.RCSurface.snapshots = {
    loadSnapshots,
    saveSnapshots,
    getSnapshots: () => snapshots,
    setSnapshotCaptureMode,
    isCaptureMode: () => snapshotCaptureMode,
    handleSnapshotSlot,
    startLinearMorph,
    cancelMorph,
    setupSnapshots,
    updateSnapshotSlotUI,
  };
})();
