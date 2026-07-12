// Copyright © 2026 Gabriel Worm
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Source: https://github.com/ntworm/ableton-rc-surface
//
// This file is part of Ableton RC Surface, distributed under the
// PolyForm Noncommercial License 1.0.0. You may obtain a copy of
// the License at https://polyformproject.org/licenses/noncommercial/1.0.0
(function (global) {
  'use strict';

  function clamp(v, lo, hi) {
    return Math.max(lo, Math.min(hi, v));
  }

  function createScalarGestureState(initialValue) {
    const value = typeof initialValue === 'number' ? clamp(initialValue, 0, 1) : 0;
    return {
      value,
      on: value > 0,
      activePointerId: null,
      mode: null,
      startY: 0,
      startValue: value,
      rangePx: 100,
      pendingToggleOff: false,
      moved: false,
      burst: null,
      lastToggleValue: value > 0 ? value : 1,
    };
  }

  function changedValue(state, value, phase, active) {
    const next = clamp(value, 0, 1);
    const rounded = roundValue(next);
    state.value = rounded;
    state.on = next > 0;
    return { value: rounded, phase, active };
  }

  function roundValue(v) {
    return Math.round(v * 10000) / 10000;
  }

  function calculatePadRangePx(_height) {
    // Match the LFO / stutter / fader / knob range (150px) so the vertical
    // drag depth of a pad feels identical to the other vertical controls.
    return 150;
  }

  function valueFromDrag(state, y) {
    const dy = state.startY - y;
    return clamp(state.startValue + dy / state.rangePx, 0, 1);
  }

  function beginScalarGesture(state, opts) {
    if (state.activePointerId !== null) return null;

    const mode = opts.mode || 'A';
    const rangePx = Math.max(1, opts.rangePx || 100);
    state.mode = mode;
    state.activePointerId = opts.pointerId;
    state.startY = opts.y;
    state.rangePx = rangePx;
    state.pendingToggleOff = false;
    state.moved = false;
    state.burst = null;

    if (mode === 'A') {
      state.startValue = 0;
      return changedValue(state, 0, 'start', true);
    }

    if (mode === 'B') {
      state.startValue = state.value;
      state.on = state.value > 0;
      return { value: roundValue(state.value), phase: 'start', active: true };
    }

    if (mode === 'C') {
      if (state.on) {
        state.startValue = state.value;
        state.pendingToggleOff = true;
        return null;
      }

      const defaultValue = typeof opts.defaultToggleValue === 'number'
        ? opts.defaultToggleValue
        : state.lastToggleValue;
      state.startValue = clamp(state.value > 0 ? state.value : defaultValue, 0, 1);
      const event = changedValue(state, state.startValue, 'toggle-on', true);
      if (state.value > 0) state.lastToggleValue = state.value;
      return event;
    }

    if (mode === 'D') {
      const durationMs = Math.max(80, opts.burstDurationMs || 520);
      const attackMs = Math.max(10, Math.min(opts.burstAttackMs || 70, durationMs - 10));
      state.startValue = 0;
      state.burst = {
        active: true,
        startTime: opts.now || 0,
        durationMs,
        attackMs,
        peak: 1,
      };
      return changedValue(state, 0, 'burst-start', true);
    }

    state.startValue = 0;
    return changedValue(state, 0, 'start', true);
  }

  function moveScalarGesture(state, opts) {
    if (state.activePointerId !== opts.pointerId) return null;

    if (state.mode === 'D') {
      if (state.burst) {
        const dy = state.startY - opts.y;
        state.burst.peak = clamp(0.75 + dy / state.rangePx, 0.15, 1);
      }
      state.moved = true;
      return null;
    }

    const dy = Math.abs(state.startY - opts.y);
    if (dy > 4) {
      state.moved = true;
      state.pendingToggleOff = false;
    }

    const next = valueFromDrag(state, opts.y);
    if (roundValue(next) === roundValue(state.value)) return null;

    const event = changedValue(state, next, 'move', true);
    if (state.mode === 'C') {
      if (state.value > 0) state.lastToggleValue = state.value;
      else state.on = false;
    }
    return event;
  }

  function endScalarGesture(state, opts) {
    if (state.activePointerId !== opts.pointerId) return null;

    const mode = state.mode;
    const wasMoved = state.moved;
    const shouldToggleOff = state.pendingToggleOff && !wasMoved;
    state.activePointerId = null;
    state.mode = null;
    state.pendingToggleOff = false;
    state.moved = false;

    if (mode === 'A') {
      return changedValue(state, 0, 'release', false);
    }

    if (mode === 'C' && shouldToggleOff && state.on) {
      if (state.value > 0) state.lastToggleValue = state.value;
      return changedValue(state, 0, 'toggle-off', false);
    }

    return null;
  }

  function tickBurstGesture(state, opts) {
    if (!state.burst || !state.burst.active) return null;

    const elapsed = Math.max(0, (opts.now || 0) - state.burst.startTime);
    const duration = state.burst.durationMs;
    const attack = state.burst.attackMs;
    const peak = state.burst.peak;

    if (elapsed >= duration) {
      state.burst.active = false;
      state.burst = null;
      state.activePointerId = null;
      return changedValue(state, 0, 'burst-end', false);
    }

    let value;
    if (elapsed <= attack) {
      value = peak * (elapsed / attack);
    } else {
      value = peak * (1 - ((elapsed - attack) / (duration - attack)));
    }

    return changedValue(state, value, 'burst', true);
  }

  global.AbletonRcModes = {
    clamp,
    calculatePadRangePx,
    createScalarGestureState,
    beginScalarGesture,
    moveScalarGesture,
    endScalarGesture,
    tickBurstGesture,
  };
})(typeof globalThis !== 'undefined' ? globalThis : window);
