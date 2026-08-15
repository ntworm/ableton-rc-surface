// Copyright © 2026 Gabriel Worm
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Source: https://github.com/ntworm/ableton-rc-surface
//
// This file is part of Ableton RC Surface, distributed under the
// PolyForm Noncommercial License 1.0.0. You may obtain a copy of
// the License at https://polyformproject.org/licenses/noncommercial/1.0.0
// Phone-side touch controls. Emits high-level {name, value} (and
// {name, value, pressure, delta} for pads / {name, x, y} for XY) via
// window.onControl. No network code.

(function () {
  'use strict';

  function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
  const Modes = window.AbletonRcModes;
  if (!Modes) {
    throw new Error('AbletonRcModes must be loaded before controls.js');
  }

  window.currentControlStates = window.currentControlStates || {};

  // Find the touch in e.touches whose identifier matches `id`.
  function findTouch(e, id) {
    if (id === null) return null;
    for (let i = 0; i < e.touches.length; i++) {
      if (e.touches[i].identifier === id) return e.touches[i];
    }
    return null;
  }
  // The single new touch from e.changedTouches that started on this element.
  function pickNewTouch(e) {
    if (e.changedTouches.length > 0) return e.changedTouches[0];
    return null;
  }

  // Global tempo/meter state shared with app.js
  window.currentBpm = 120;
  window.currentNumerator = 4;
  window.currentDenominator = 4;

  // Global Sync Mode ('sync' vs 'free')
  window.syncMode = 'sync';

  // Playhead estimation state
  window.playheadActive = false;
  window.playheadStartTime = Date.now();
  window.playheadBaseTimeMs = 0;

  // Global performance mode (A/B/C/D) -- shared by pads, LFOs, and stutters.
  let padMode = 'A';
  const latchedValues = new Map();    // B: last value before release
  const toggledStates = new Map();    // C: on/off boolean
  const modeClasses = ['mode-a', 'mode-b', 'mode-c', 'mode-d'];

  function clearModeClass(el) {
    modeClasses.forEach((c) => el.classList.remove(c));
  }

  function setModeClass(el, active) {
    clearModeClass(el);
    if (active) el.classList.add(`mode-${padMode.toLowerCase()}`);
  }

  function setPadMode(mode) {
    if (mode === padMode) return;
    try { localStorage.setItem('ableton-rc:pad_mode', mode); } catch {}
    cancelMorph();
    padMode = mode;
    document.body.dataset.padMode = mode;
    for (const [name, latched] of latchedValues.entries()) {
      latchedValues.delete(name);
      window.onControl && window.onControl({
        name, value: 0, pressure: 0, delta: -latched,
      });
    }
    for (const [name, on] of toggledStates.entries()) {
      toggledStates.delete(name);
      if (on) {
        window.onControl && window.onControl({
          name, value: 0, pressure: 0, delta: -1,
        });
      }
    }
    for (const [name, burst] of activeScalarBursts.entries()) {
      activeScalarBursts.delete(name);
      burst.render({ value: 0, phase: 'burst-end', active: false });
    }
    document.querySelectorAll('.pad').forEach((el) => {
      el.classList.remove('active', 'latched', 'toggled', 'burst');
      el.style.removeProperty('--pad-fill-alpha');
      el.style.removeProperty('--pad-fill-color');
    });

    // Reset LFOs
    for (const [name, state] of lfoStates.entries()) {
      state.active = false;
      state.value = 0;
      state.burstUntil = 0;
      state.pendingToggleOff = false;
      state.moved = false;
      const el = document.querySelector(`.toggle[data-name="${name}"]`);
      if (el) {
        el.classList.remove('on', 'burst');
        clearModeClass(el);
        const fill = el.querySelector('.mod-val-bar');
        if (fill) fill.style.height = '0%';
      }
      emitLfoState(name, state);
    }

    // Reset Stutters
    for (const [name, state] of stutterStates.entries()) {
      state.pressed = false;
      state.burstUntil = 0;
      state.pendingToggleOff = false;
      state.moved = false;
      const el = document.querySelector(`.button[data-name="${name}"]`);
      if (el) {
        el.classList.remove('pressed', 'burst');
        clearModeClass(el);
        el.style.removeProperty('background-color');
        el.style.removeProperty('--stut-pulse');
        el.style.removeProperty('--stut-glow-size');
        el.style.removeProperty('--stut-scale');
      }
      emitStutterState(name, state);
    }

    window.dispatchEvent(new CustomEvent('ableton-rc:pad-mode-change', {
      detail: { mode: padMode },
    }));
  }

  function setupPadModeUI() {
    document.querySelectorAll('[data-pad-mode-set]').forEach((btn) => {
      const target = btn.dataset.padModeSet;
      btn.addEventListener('click', () => setPadMode(target));
    });
    const render = () => {
      document.querySelectorAll('[data-pad-mode-set]').forEach((btn) => {
        const active = btn.dataset.padModeSet === padMode;
        btn.classList.toggle('on', active);
        btn.setAttribute('aria-pressed', active ? 'true' : 'false');
      });
    };
    window.addEventListener('ableton-rc:pad-mode-change', render);
    render();
  }

  // ---- Pad (modes A/B/C/D) ----
  function makePad(el) {
    const name = el.dataset.name;
    const gestureState = Modes.createScalarGestureState();
    let rangePx = 140;
    let lastValue = 0;

    function setPadFill(value) {
      const v = clamp(Number(value) || 0, 0, 1);
      const alpha = v <= 0.001 ? 0 : Math.min(0.72, 0.12 + (v * 0.58));
      el.style.setProperty('--pad-fill-alpha', alpha.toFixed(3));
      el.style.setProperty('--pad-fill-color', `rgba(10,132,255,${alpha.toFixed(3)})`);
    }
    function clearPadFill() {
      el.style.removeProperty('--pad-fill-alpha');
      el.style.removeProperty('--pad-fill-color');
    }
    function showValue(value) {
      setPadFill(value);
      el.classList.add('active');
      el.classList.remove('latched', 'toggled', 'burst');
    }
    function showLatched(value) {
      setPadFill(value);
      el.classList.remove('toggled', 'burst');
      el.classList.add('active', 'latched');
    }
    function showToggled(value) {
      setPadFill(value);
      el.classList.remove('latched', 'burst');
      el.classList.add('active', 'toggled');
    }
    function showBurst(value) {
      setPadFill(value);
      el.classList.remove('latched', 'toggled');
      el.classList.add('active', 'burst');
    }
    function clearVisual() {
      el.classList.remove('active', 'latched', 'toggled', 'burst');
      clearPadFill();
    }

    function emit(value) {
      value = clamp(Number(value) || 0, 0, 1);
      window.onControl && window.onControl({
        name,
        value,
        pressure: value,
        delta: value - lastValue,
      });
      lastValue = value;
    }

    function renderValue(value, mode, active) {
      if (mode === 'B') {
        if (value > 0.001) showLatched(value); else clearVisual();
        return;
      }
      if (mode === 'C') {
        if (value > 0.001) showToggled(value); else clearVisual();
        return;
      }
      if (mode === 'D') {
        if (value > 0.001 || active) showBurst(value); else clearVisual();
        return;
      }
      if (value > 0.001 || active) showValue(value); else clearVisual();
    }

    function rememberModeState(value, mode) {
      if (mode === 'B') {
        if (value > 0.001) latchedValues.set(name, value);
        else latchedValues.delete(name);
        return;
      }
      if (mode === 'C') {
        toggledStates.set(name, value > 0.001);
      }
    }

    function applyGestureEvent(event, mode) {
      if (!event) return;
      const value = clamp(Number(event.value) || 0, 0, 1);
      const eventMode = mode || gestureState.mode || padMode;
      rememberModeState(value, eventMode);
      renderValue(value, eventMode, event.active);
      emit(value);
    }

    function start(t) {
      if (gestureState.activePointerId !== null) return;
      const h = el.clientHeight || 100;
      rangePx = Modes.calculatePadRangePx(h);
      const event = Modes.beginScalarGesture(gestureState, {
        mode: padMode,
        pointerId: t.identifier,
        y: t.clientY,
        rangePx,
        now: performance.now(),
        burstDurationMs: 520,
        burstAttackMs: 70,
      });
      if (padMode === 'D') {
        activeScalarBursts.set(name, {
          state: gestureState,
          render: (burstEvent) => applyGestureEvent(burstEvent, 'D'),
        });
      }
      applyGestureEvent(event, padMode);
    }

    function update(t) {
      if (gestureState.activePointerId === null) return;
      const event = Modes.moveScalarGesture(gestureState, {
        pointerId: t.identifier,
        y: t.clientY,
      });
      applyGestureEvent(event, gestureState.mode || padMode);
    }

    function end(identifier) {
      if (gestureState.activePointerId === null) return;
      if (identifier !== gestureState.activePointerId) return;
      const mode = gestureState.mode || padMode;
      const event = Modes.endScalarGesture(gestureState, { pointerId: identifier });
      applyGestureEvent(event, mode);
    }

    function findActiveTouch(e) {
      return findTouch(e, gestureState.activePointerId);
    }

    window.addEventListener('ableton-rc:pad-mode-change', () => {
      if (gestureState.activePointerId === null) return;
      const value = gestureState.value;
      gestureState.activePointerId = null;
      gestureState.mode = null;
      activeScalarBursts.delete(name);
      renderValue(value, padMode, false);
    });

    el.addEventListener('touchstart', (e) => {
      e.preventDefault();
      const t = pickNewTouch(e);
      if (t) start(t);
    }, { passive: false });
    el.addEventListener('touchmove', (e) => {
      e.preventDefault();
      const t = findActiveTouch(e);
      if (t) update(t);
    }, { passive: false });
    el.addEventListener('touchend', (e) => {
      e.preventDefault();
      for (let i = 0; i < e.changedTouches.length; i++) {
        end(e.changedTouches[i].identifier);
      }
    }, { passive: false });
    el.addEventListener('touchcancel', (e) => {
      e.preventDefault();
      for (let i = 0; i < e.changedTouches.length; i++) {
        end(e.changedTouches[i].identifier);
      }
    }, { passive: false });

    window.controlSetters = window.controlSetters || {};
    window.controlSetters[name] = (v) => {
      const value = clamp(Number(v) || 0, 0, 1);
      gestureState.value = value;
      gestureState.on = value > 0.001;
      lastValue = value;
      rememberModeState(value, padMode);
      if (padMode === 'D' && value > 0.001) {
        if (!gestureState.burst) {
          gestureState.burst = {
            active: true,
            startTime: performance.now(),
            durationMs: 520,
            attackMs: 70,
            peak: value,
          };
          activeScalarBursts.set(name, {
            state: gestureState,
            render: (burstEvent) => applyGestureEvent(burstEvent, 'D'),
          });
        } else {
          gestureState.burst.peak = Math.max(gestureState.burst.peak, value);
        }
      } else if (padMode === 'D' && value <= 0.001) {
        activeScalarBursts.delete(name);
        if (gestureState.burst) {
          gestureState.burst.active = false;
          gestureState.burst = null;
        }
      }
      renderValue(value, padMode, value > 0.001);
      window.onControl && window.onControl({
        name,
        value,
        pressure: value,
        delta: 0,
      });
    };
  }

  // Active scalar bursts are shared by pads, LFOs, and stutters.
  const activeScalarBursts = new Map();

  // ---- LFO Modulators ----
  const lfoStates = new Map(); // name -> { active, depth, rate, phase }
  window.lfoStates = lfoStates;
  let modulatorEmitBatchDepth = 0;
  let modulatorEmitSuppressDepth = 0;
  const pendingLfoStateEmits = new Set();
  const pendingStutterStateEmits = new Set();

  window.syncSettings = {
    clockSource: 'osc',
    lfoSubdivision: 1.0,
    lfoSubdivisionPinned: false,
    lfoShape: 'sine',
    lfoPhaseOffset: 0.0,
    stutterSubdivision: 0.25,
    stutterSubdivisionPinned: false,
    stutterSwing: 0.0,
    stutterPhaseOffset: 0.0
  };

  const savedSyncSettings = localStorage.getItem('ableton-rc:sync_settings');
  if (savedSyncSettings) {
    try {
      Object.assign(window.syncSettings, JSON.parse(savedSyncSettings));
    } catch (err) {}
  }

  function computeLfoWaveValue(shape, phaseRadians) {
    const rawPhase = (phaseRadians / (2 * Math.PI)) % 1;
    const phase = (rawPhase + 1) % 1;
    switch (shape) {
      case 'triangle':
        return phase < 0.5 ? 4 * phase - 1 : 3 - 4 * phase;
      case 'ramp_up':
        return 2 * phase - 1;
      case 'ramp_down':
        return 1 - 2 * phase;
      case 'square':
        return phase < 0.5 ? 1 : -1;
      case 'sine':
      default:
        return Math.sin(phase * 2 * Math.PI);
    }
  }

  function subdivisionFromRate(rate, subdivisions) {
    return subdivisions[Math.floor(clamp(rate, 0, 1) * (subdivisions.length - 0.01))] ?? 1;
  }

  function sendLfoState(name, state, extra) {
    window.onModulatorState && window.onModulatorState({
      kind: 'lfo',
      name,
      active: !!state.active,
      rate: state.rate,
      depth: state.depth,
      syncMode: window.syncMode,
      clockSource: window.syncSettings.clockSource,
      syncSubdivisionBeats: window.syncSettings.lfoSubdivisionPinned ? window.syncSettings.lfoSubdivision : undefined,
      phaseOffsetBeats: window.syncSettings.lfoPhaseOffset,
      shape: window.syncSettings.lfoShape,
      ...(extra || {}),
    });
  }
  window.sendLfoState = sendLfoState;

  function sendStutterState(name, state, extra) {
    window.onModulatorState && window.onModulatorState({
      kind: 'stutter',
      name,
      active: !!state.pressed,
      rate: state.rate,
      count: state.count,
      syncMode: window.syncMode,
      clockSource: window.syncSettings.clockSource,
      syncSubdivisionBeats: window.syncSettings.stutterSubdivisionPinned ? window.syncSettings.stutterSubdivision : undefined,
      phaseOffsetBeats: window.syncSettings.stutterPhaseOffset,
      swing: window.syncSettings.stutterSwing,
      ...(extra || {}),
    });
  }
  window.sendStutterState = sendStutterState;

  function flushPendingModulatorStateEmits() {
    const lfoNames = Array.from(pendingLfoStateEmits);
    const stutterNames = Array.from(pendingStutterStateEmits);
    pendingLfoStateEmits.clear();
    pendingStutterStateEmits.clear();
    for (const name of lfoNames) {
      const state = lfoStates.get(name);
      if (state) sendLfoState(name, state);
    }
    for (const name of stutterNames) {
      const state = stutterStates.get(name);
      if (state) sendStutterState(name, state);
    }
  }

  function withModulatorEmitBatch(fn) {
    modulatorEmitBatchDepth += 1;
    try {
      fn();
    } finally {
      modulatorEmitBatchDepth -= 1;
      if (modulatorEmitBatchDepth === 0) flushPendingModulatorStateEmits();
    }
  }

  function withModulatorEmitSuppressed(fn) {
    modulatorEmitSuppressDepth += 1;
    try {
      fn();
    } finally {
      modulatorEmitSuppressDepth -= 1;
    }
  }
  window.withModulatorEmitSuppressed = withModulatorEmitSuppressed;

  // A drag fires one touchmove per display refresh — 60 Hz, 120 Hz on a
  // ProMotion phone — and each one used to become its own WebSocket frame.
  // rate/depth/count are continuous state where the newest value wins, so drag
  // frames coalesce into one emit per animation frame: same feel, a third of
  // the radio traffic, and the server's rate limiter is no longer the thing
  // deciding which of them survive.
  //
  // Gate transitions (activate, deactivate, controlSetters) keep going out
  // immediately — dropping one of those leaves a stuck note.
  let modulatorEmitFlushScheduled = false;

  function flushCoalescedModulatorEmits() {
    modulatorEmitFlushScheduled = false;
    flushPendingModulatorStateEmits();
  }

  function scheduleModulatorEmitFlush() {
    if (modulatorEmitFlushScheduled) return;
    if (typeof requestAnimationFrame !== 'function') {
      flushCoalescedModulatorEmits();
      return;
    }
    modulatorEmitFlushScheduled = true;
    requestAnimationFrame(flushCoalescedModulatorEmits);
  }

  function emitLfoState(name, state) {
    window.currentControlStates[name] = state.active ? 1 : 0;
    if (modulatorEmitSuppressDepth > 0) return;
    if (modulatorEmitBatchDepth > 0) {
      pendingLfoStateEmits.add(name);
      return;
    }
    // This emit carries the current state, so a queued frame would only
    // repeat it.
    pendingLfoStateEmits.delete(name);
    sendLfoState(name, state);
  }

  function emitLfoStateCoalesced(name, state) {
    window.currentControlStates[name] = state.active ? 1 : 0;
    if (modulatorEmitSuppressDepth > 0) return;
    pendingLfoStateEmits.add(name);
    // Inside an explicit batch the batch owner does the flushing.
    if (modulatorEmitBatchDepth > 0) return;
    scheduleModulatorEmitFlush();
  }

  function emitStutterState(name, state) {
    window.currentControlStates[name] = state.pressed ? 1 : 0;
    if (modulatorEmitSuppressDepth > 0) return;
    if (modulatorEmitBatchDepth > 0) {
      pendingStutterStateEmits.add(name);
      return;
    }
    pendingStutterStateEmits.delete(name);
    sendStutterState(name, state);
  }

  function emitStutterStateCoalesced(name, state) {
    window.currentControlStates[name] = state.pressed ? 1 : 0;
    if (modulatorEmitSuppressDepth > 0) return;
    pendingStutterStateEmits.add(name);
    if (modulatorEmitBatchDepth > 0) return;
    scheduleModulatorEmitFlush();
  }

  function emitAllModulatorStates() {
    for (const [name, state] of lfoStates.entries()) emitLfoState(name, state);
    for (const [name, state] of stutterStates.entries()) emitStutterState(name, state);
  }

  function makeLfoToggle(el) {
    const name = el.dataset.name;
    const fill = el.querySelector('.mod-val-bar');

    lfoStates.set(name, {
      active: false,
      depth: 0.5,
      rate: 0.5,
      phase: -Math.PI / 2,
      value: 0,
      burstUntil: 0,
      pendingToggleOff: false,
      moved: false,
    });
    window.currentControlStates[`${name}.depth`] = 0.5;
    window.currentControlStates[`${name}.rate`] = 0.5;

    let activeId = null;
    let gestureMode = null;
    let startX = 0;
    let startY = 0;
    let startDepth = 0.5;
    let startRate = 0.5;

    function renderState() {
      const state = lfoStates.get(name);
      el.classList.toggle('on', state.active);
      el.classList.toggle('burst', state.active && state.burstUntil > 0);
      setModeClass(el, state.active);
      // Limpa feedback de drag em qualquer estado (sem gesto ativo).
      el.style.removeProperty('--lfo-drag-y');
      el.style.removeProperty('--lfo-drag-x');
    }

    function armGesture(t, state) {
      activeId = t.identifier;
      gestureMode = padMode;
      startX = t.clientX;
      startY = t.clientY;
      startDepth = state.depth;
      startRate = state.rate;
      state.moved = false;
    }

    function activate(state, burstMs) {
      const wasActive = state.active;
      state.active = true;
      state.pendingToggleOff = false;
      if (!wasActive || burstMs) state.phase = -Math.PI / 2;
      state.burstUntil = burstMs ? performance.now() + burstMs : 0;
      renderState();
      emitLfoState(name, state);
    }

    function deactivate(state) {
      state.active = false;
      state.value = 0;
      state.burstUntil = 0;
      state.pendingToggleOff = false;
      if (fill) fill.style.height = '0%';
      renderState();
      emitLfoState(name, state);
    }

    function start(t) {
      if (activeId !== null) return;
      const state = lfoStates.get(name);
      armGesture(t, state);

      if (padMode === 'B') {
        activate(state, 0);
        return;
      }

      if (padMode === 'C') {
        if (state.active) {
          state.pendingToggleOff = true;
          renderState();
        } else {
          activate(state, 0);
        }
        return;
      }

      if (padMode === 'D') {
        activate(state, 1100);
        return;
      }

      activate(state, 0);
    }

    function move(t) {
      if (activeId === null) return;
      const state = lfoStates.get(name);
      if (!state.active) return;

      const dy = startY - t.clientY;
      const dx = t.clientX - startX;
      if (Math.abs(dy) > 4 || Math.abs(dx) > 4) {
        state.moved = true;
        state.pendingToggleOff = false;
      }
      state.depth = clamp(startDepth + dy / 150, 0, 1);
      state.rate = clamp(startRate + dx / 150, 0, 1);
      window.currentControlStates[`${name}.depth`] = state.depth;
      window.currentControlStates[`${name}.rate`] = state.rate;

      // Feedback visual: glow separado por eixo (CSS usa --lfo-drag-y/x)
      el.style.setProperty('--lfo-drag-y', state.depth.toFixed(3));
      el.style.setProperty('--lfo-drag-x', state.rate.toFixed(3));
      emitLfoStateCoalesced(name, state);

      // Mode B: estado final decidido no end() via depth. Move nao desativa
      // durante o gesto - usuario pode explorar valores baixos sem perder
      // o hold.
    }

    function end(identifier) {
      if (activeId === null || identifier !== activeId) return;
      activeId = null;

      const state = lfoStates.get(name);
      const mode = gestureMode || padMode;
      gestureMode = null;
      if (mode === 'A') {
        deactivate(state);
      } else if (mode === 'C' && state.pendingToggleOff && !state.moved) {
        deactivate(state);
      } else if (mode === 'B' && state.depth < 0.02) {
        // Mode B: se ao soltar a depth ficou abaixo do threshold minimo,
        // cancela o hold. Permite explorar valores ~0.02 sem desativar
        // acidentalmente (zona morta).
        deactivate(state);
      }
      // Limpa feedback visual.
      el.style.removeProperty('--lfo-drag-y');
      el.style.removeProperty('--lfo-drag-x');
    }

    el.addEventListener('touchstart', (e) => {
      e.preventDefault();
      const t = pickNewTouch(e);
      if (t) start(t);
    }, { passive: false });
    el.addEventListener('touchmove', (e) => {
      e.preventDefault();
      const t = findTouch(e, activeId);
      if (t) move(t);
    }, { passive: false });
    el.addEventListener('touchend', (e) => {
      e.preventDefault();
      for (let i = 0; i < e.changedTouches.length; i++) end(e.changedTouches[i].identifier);
    }, { passive: false });
    el.addEventListener('touchcancel', (e) => {
      e.preventDefault();
      for (let i = 0; i < e.changedTouches.length; i++) end(e.changedTouches[i].identifier);
    }, { passive: false });

    window.controlSetters = window.controlSetters || {};
    window.controlSetters[name] = (v) => {
      const state = lfoStates.get(name);
      if (state) {
        state.active = v > 0.5;
        if (state.active && padMode === 'D') {
          if (!state.burstUntil) {
            state.burstUntil = performance.now() + 1100;
          }
        } else {
          state.burstUntil = 0;
        }
        state.pendingToggleOff = false;
        renderState();
        if (!state.active) {
          state.value = 0;
          if (fill) fill.style.height = '0%';
        }
        emitLfoState(name, state);
      }
    };
    window.controlSetters[`${name}.rate`] = (v) => {
      const state = lfoStates.get(name);
      if (state) {
        state.rate = v;
        window.currentControlStates[`${name}.rate`] = v;
        emitLfoState(name, state);
      }
    };
    window.controlSetters[`${name}.depth`] = (v) => {
      const state = lfoStates.get(name);
      if (state) {
        state.depth = v;
        window.currentControlStates[`${name}.depth`] = v;
        emitLfoState(name, state);
      }
    };
  }

  // ---- Stutter Rolls (Momentary) ----
  const stutterStates = new Map(); // name -> { pressed, rate, count, burstUntil }
  window.stutterStates = stutterStates;

  function makeStutterButton(el) {
    const name = el.dataset.name;

    stutterStates.set(name, {
      pressed: false,
      rate: 0.1,
      count: 0,
      burstUntil: 0,
      pendingToggleOff: false,
      moved: false,
    });
    window.currentControlStates[`${name}.rate`] = 0.1;
    window.currentControlStates[`${name}.count`] = 0;

    let activeId = null;
    let gestureMode = null;
    let startX = 0;
    let startY = 0;
    let startRate = 0.1;
    let startCount = 0;

    function renderState(pressed) {
      el.classList.toggle('pressed', pressed);
      const state = stutterStates.get(name);
      el.classList.toggle('burst', !!state && state.pressed && state.burstUntil > 0);
      setModeClass(el, pressed);
      if (!pressed) {
        el.style.removeProperty('background-color');
        el.style.removeProperty('--stut-pulse');
        el.style.removeProperty('--stut-glow-size');
        el.style.removeProperty('--stut-scale');
      }
      // Limpa feedback de drag em qualquer estado (sem gesto ativo).
      el.style.removeProperty('--stut-drag-y');
      el.style.removeProperty('--stut-drag-x');
      el.style.removeProperty('--s1');
      el.style.removeProperty('--s2');
      el.style.removeProperty('--s3');
      el.style.removeProperty('--s4');
      el.style.removeProperty('--s5');
      el.style.removeProperty('--stut-zebra-on');
    }

    function armGesture(t, state) {
      activeId = t.identifier;
      gestureMode = padMode;
      startX = t.clientX;
      startY = t.clientY;
      startRate = state.rate;
      startCount = state.count;
      state.moved = false;
    }

    function activate(state, burstMs) {
      state.pressed = true;
      state.pendingToggleOff = false;
      state.burstUntil = burstMs ? performance.now() + burstMs : 0;
      renderState(true);
      emitStutterState(name, state);
    }

    function deactivate(state) {
      state.pressed = false;
      state.burstUntil = 0;
      state.pendingToggleOff = false;
      renderState(false);
      emitStutterState(name, state);
    }

    function start(t) {
      if (activeId !== null) return;
      const state = stutterStates.get(name);
      armGesture(t, state);

      if (padMode === 'B') {
        activate(state, 0);
        return;
      }

      if (padMode === 'C') {
        if (state.pressed) {
          state.pendingToggleOff = true;
          renderState(true);
        } else {
          activate(state, 0);
        }
        return;
      }

      if (padMode === 'D') {
        activate(state, 1100);
        return;
      }

      activate(state, 0);
    }

    function move(t) {
      if (activeId === null) return;
      const state = stutterStates.get(name);
      const dy = startY - t.clientY;
      const dx = t.clientX - startX;
      if (Math.abs(dy) > 4 || Math.abs(dx) > 4) {
        state.moved = true;
        state.pendingToggleOff = false;
      }
      state.rate = clamp(startRate + dy / 150, 0, 1);
      state.count = clamp(startCount + dx / 150, 0, 1);
      window.currentControlStates[`${name}.rate`] = state.rate;
      window.currentControlStates[`${name}.count`] = state.count;

      // Feedback visual: glow separado por eixo (CSS usa --stut-drag-y/x)
      el.style.setProperty('--stut-drag-y', state.rate.toFixed(3));
      el.style.setProperty('--stut-drag-x', state.count.toFixed(3));

      // Zebra: 5 listras pré-posicionadas. count=0 -> vazio; count=0.25 ->
      // so a central; count=1 -> todas. Animacao vem do transition nas vars.
      // ratchetIdx 0..3 -> [] / [s3] / [s2,s3,s4] / [s1..s5]
      const ratchetLevels = [1, 2, 3, 4];
      const ratchetIdx = Math.min(ratchetLevels.length - 1, Math.floor(state.count * ratchetLevels.length));
      // mapa: 0 = [], 1 = [3], 2 = [2,3,4], 3 = [1,2,3,4,5]
      const lit = ratchetIdx === 0 ? [] : ratchetIdx === 1 ? [3] : ratchetIdx === 2 ? [2,3,4] : [1,2,3,4,5];
      const on = state.pressed && padMode === 'B' && ratchetIdx >= 1;
      el.style.setProperty('--s1', lit.includes(1) ? '0.78' : '0');
      el.style.setProperty('--s2', lit.includes(2) ? '0.78' : '0');
      el.style.setProperty('--s3', lit.includes(3) ? '0.78' : '0');
      el.style.setProperty('--s4', lit.includes(4) ? '0.78' : '0');
      el.style.setProperty('--s5', lit.includes(5) ? '0.78' : '0');
      el.style.setProperty('--stut-zebra-on', on ? '1' : '0');
      emitStutterStateCoalesced(name, state);

      // Mode B: estado final decidido no end() via rate. Move nao desativa
      // durante o gesto - usuario pode explorar valores baixos sem perder
      // o hold.
    }

    function end(identifier) {
      if (activeId === null || identifier !== activeId) return;
      activeId = null;

      const state = stutterStates.get(name);
      const mode = gestureMode || padMode;
      gestureMode = null;
      if (mode === 'A') {
        deactivate(state);
      } else if (mode === 'C' && state.pendingToggleOff && !state.moved) {
        deactivate(state);
      } else if (mode === 'B' && state.rate < 0.02 && state.count < 0.01) {
        // Mode B: desativa SE rate baixo E count perto de zero. Mover
        // horizontal (count > 0) impede o cancelamento mesmo se o rate
        // caiu (drag acidental pra baixo ao mexer horizontal). Drag
        // vertical puro ate zerar OU tap sem mexer cancela.
        deactivate(state);
      } else if (mode === 'B' && !state.moved) {
        // Mode B tap puro (sem mexer em nenhum eixo): libera o hold
        // mesmo com rate inicial 0.1 (acima do threshold).
        deactivate(state);
      }
      // Limpa feedback visual.
      el.style.removeProperty('--stut-drag-y');
      el.style.removeProperty('--stut-drag-x');
      el.style.removeProperty('--s1');
      el.style.removeProperty('--s2');
      el.style.removeProperty('--s3');
      el.style.removeProperty('--s4');
      el.style.removeProperty('--s5');
      el.style.removeProperty('--stut-zebra-on');
    }

    el.addEventListener('touchstart', (e) => {
      e.preventDefault();
      const t = pickNewTouch(e);
      if (t) start(t);
    }, { passive: false });
    el.addEventListener('touchmove', (e) => {
      e.preventDefault();
      const t = findTouch(e, activeId);
      if (t) move(t);
    }, { passive: false });
    el.addEventListener('touchend', (e) => {
      e.preventDefault();
      for (let i = 0; i < e.changedTouches.length; i++) end(e.changedTouches[i].identifier);
    }, { passive: false });
    el.addEventListener('touchcancel', (e) => {
      e.preventDefault();
      for (let i = 0; i < e.changedTouches.length; i++) end(e.changedTouches[i].identifier);
    }, { passive: false });

    window.controlSetters = window.controlSetters || {};
    window.controlSetters[name] = (v) => {
      const state = stutterStates.get(name);
      if (state) {
        state.pressed = v > 0.5;
        if (state.pressed && padMode === 'D') {
          if (!state.burstUntil) {
            state.burstUntil = performance.now() + 1100;
          }
        } else {
          state.burstUntil = 0;
        }
        state.pendingToggleOff = false;
        renderState(state.pressed);
        emitStutterState(name, state);
      }
    };
    window.controlSetters[`${name}.rate`] = (v) => {
      const state = stutterStates.get(name);
      if (state) {
        state.rate = v;
        window.currentControlStates[`${name}.rate`] = v;
        emitStutterState(name, state);
      }
    };
    window.controlSetters[`${name}.count`] = (v) => {
      const state = stutterStates.get(name);
      if (state) {
        state.count = v;
        window.currentControlStates[`${name}.count`] = v;
        emitStutterState(name, state);
      }
    };
  }

  // ---- XY Physics Pad ----
  function setupXYPhysics(el) {
    const name = el.dataset.name;
    const canvas = el.querySelector('#xy-physics-canvas');
    if (!canvas) return;
    const ctx = canvas.getContext('2d');

    let activeId = null;
    let width = 0, height = 0;

    // Ball physics properties
    const radius = 9;
    let x = 0;
    let y = 0;
    let vx = 0;
    let vy = 0;
    let lastTouchX = 0;
    let lastTouchY = 0;
    let lastTouchTime = 0;
    let isDragging = false;
    const trail = [];

    function resize() {
      const rect = el.getBoundingClientRect();
      // Keep old proportional positions
      const px = width > 0 ? x / width : 0.5;
      const py = height > 0 ? y / height : 0.5;

      width = rect.width;
      height = rect.height;
      canvas.width = width;
      canvas.height = height;

      x = px * width;
      y = py * height;
    }

    window.addEventListener('resize', resize);
    setTimeout(resize, 100);

    function emitValue() {
      // Calculate normalized 0..1 coordinates
      const valX = clamp((x - radius) / (width - 2 * radius), 0, 1);
      const valY = clamp((y - radius) / (height - 2 * radius), 0, 1);
      
      const readout = document.querySelector(`[data-readout="${name}"]`);
      if (readout) readout.textContent = `${valX.toFixed(2)} / ${valY.toFixed(2)}`;

      window.onControl && window.onControl({ name, x: valX, y: valY });
    }

    function start(t) {
      if (activeId !== null) return;
      activeId = t.identifier;
      isDragging = true;
      vx = 0;
      vy = 0;
      trail.length = 0;

      const rect = canvas.getBoundingClientRect();
      x = clamp(t.clientX - rect.left, radius, width - radius);
      y = clamp(t.clientY - rect.top, radius, height - radius);
      lastTouchX = x;
      lastTouchY = y;
      lastTouchTime = performance.now();
      emitValue();
    }

    function move(t) {
      if (activeId === null) return;
      const rect = canvas.getBoundingClientRect();
      const currX = clamp(t.clientX - rect.left, radius, width - radius);
      const currY = clamp(t.clientY - rect.top, radius, height - radius);
      const now = performance.now();
      const dt = Math.max(1, now - lastTouchTime);

      // Track drag velocity
      vx = (currX - lastTouchX) / (dt / 16.6);
      vy = (currY - lastTouchY) / (dt / 16.6);

      x = currX;
      y = currY;
      lastTouchX = x;
      lastTouchY = y;
      lastTouchTime = now;
      emitValue();
    }

    function end(identifier) {
      if (activeId === null || identifier !== activeId) return;
      activeId = null;
      isDragging = false;
    }

    el.addEventListener('touchstart', (e) => {
      e.preventDefault();
      const t = pickNewTouch(e);
      if (t) start(t);
    }, { passive: false });
    el.addEventListener('touchmove', (e) => {
      e.preventDefault();
      const t = findTouch(e, activeId);
      if (t) move(t);
    }, { passive: false });
    el.addEventListener('touchend', (e) => {
      e.preventDefault();
      for (let i = 0; i < e.changedTouches.length; i++) end(e.changedTouches[i].identifier);
    }, { passive: false });
    el.addEventListener('touchcancel', (e) => {
      e.preventDefault();
      for (let i = 0; i < e.changedTouches.length; i++) end(e.changedTouches[i].identifier);
    }, { passive: false });

    // Physics + Render Animation Loop
    function animate() {
      requestAnimationFrame(animate);

      if (width === 0 || height === 0) {
        resize();
        if (width === 0 || height === 0) return;
      }

      if (!isDragging) {

        // Physics update
        const friction = 0.012;
        const bounce = 0.75;
        vx *= (1 - friction);
        vy *= (1 - friction);
        if (Math.abs(vx) < 0.01) vx = 0;
        if (Math.abs(vy) < 0.01) vy = 0;

        x += vx;
        y += vy;

        // Bouncing logic
        let bounced = false;
        if (x < radius) {
          x = radius;
          vx = -vx * bounce;
          if (Math.abs(vx) < 0.1) vx = 0;
          bounced = true;
        } else if (x > width - radius) {
          x = width - radius;
          vx = -vx * bounce;
          if (Math.abs(vx) < 0.1) vx = 0;
          bounced = true;
        }

        if (y < radius) {
          y = radius;
          vy = -vy * bounce;
          if (Math.abs(vy) < 0.1) vy = 0;
          bounced = true;
        } else if (y > height - radius) {
          y = height - radius;
          vy = -vy * bounce;
          if (Math.abs(vy) < 0.1) vy = 0;
          bounced = true;
        }

        if (bounced && (Math.abs(vx) > 0.5 || Math.abs(vy) > 0.5)) {
        }

        if (vx !== 0 || vy !== 0) {
          emitValue();
        }
      }

      // Add trail point
      trail.push({ x, y });
      if (trail.length > 15) trail.shift();

      // Render
      ctx.clearRect(0, 0, width, height);

      // Render grid lines
      ctx.strokeStyle = 'rgba(255,255,255,0.03)';
      ctx.lineWidth = 1;
      for (let i = 1; i < 4; i++) {
        const lx = (width / 4) * i;
        ctx.beginPath();
        ctx.moveTo(lx, 0);
        ctx.lineTo(lx, height);
        ctx.stroke();

        const ly = (height / 4) * i;
        ctx.beginPath();
        ctx.moveTo(0, ly);
        ctx.lineTo(width, ly);
        ctx.stroke();
      }

      // Draw trail
      if (trail.length > 1) {
        ctx.beginPath();
        ctx.moveTo(trail[0].x, trail[0].y);
        for (let i = 1; i < trail.length; i++) {
          ctx.lineTo(trail[i].x, trail[i].y);
        }
        ctx.strokeStyle = 'rgba(255, 159, 10, 0.25)';
        ctx.lineWidth = 3;
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';
        ctx.stroke();
      }

      // Draw ball glow
      const glow = ctx.createRadialGradient(x, y, 1, x, y, radius * 2);
      glow.addColorStop(0, '#ff9f0a');
      glow.addColorStop(0.3, 'rgba(255, 159, 10, 0.8)');
      glow.addColorStop(1, 'rgba(255, 159, 10, 0)');
      ctx.beginPath();
      ctx.arc(x, y, radius * 2, 0, Math.PI * 2);
      ctx.fillStyle = glow;
      ctx.fill();

      // Draw ball core
      ctx.beginPath();
      ctx.arc(x, y, radius, 0, Math.PI * 2);
      ctx.fillStyle = '#ff9f0a';
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = 2;
      ctx.fill();
      ctx.stroke();
    }

    window.controlSetters = window.controlSetters || {};
    window.controlSetters[name + '.x'] = (v) => {
      x = radius + v * (width - 2 * radius);
      emitValue();
    };
    window.controlSetters[name + '.y'] = (v) => {
      y = radius + v * (height - 2 * radius);
      emitValue();
    };

    animate();
  }

  // ---- XY pad 1 (Standard) ----
  function makeXYPad(el) {
    const name = el.dataset.name;
    const dot = el.querySelector('.xy-dot');
    const readout = document.querySelector(`[data-readout="${name}"]`);
    let activeId = null;
    let x = 0.5, y = 0.5;
    const update = () => {
      dot.style.left = `${x * 100}%`;
      dot.style.top = `${y * 100}%`;
      if (readout) {
        readout.textContent = `${x.toFixed(2)} / ${y.toFixed(2)}`;
      }
    };
    function set(t) {
      const r = el.getBoundingClientRect();
      x = clamp((t.clientX - r.left) / r.width, 0, 1);
      y = clamp((t.clientY - r.top) / r.height, 0, 1);
      window.onControl && window.onControl({ name, x, y });
      update();
    }
    el.addEventListener('touchstart', (e) => {
      e.preventDefault();
      if (activeId !== null) return;
      const t = pickNewTouch(e);
      if (!t) return;
      activeId = t.identifier;
      set(t);
    }, { passive: false });
    el.addEventListener('touchmove', (e) => {
      e.preventDefault();
      const t = findTouch(e, activeId);
      if (t) set(t);
    }, { passive: false });
    el.addEventListener('touchend', (e) => {
      e.preventDefault();
      for (let i = 0; i < e.changedTouches.length; i++) {
        if (e.changedTouches[i].identifier === activeId) {
          activeId = null;
          break;
        }
      }
    }, { passive: false });
    el.addEventListener('touchcancel', (e) => {
      e.preventDefault();
      for (let i = 0; i < e.changedTouches.length; i++) {
        if (e.changedTouches[i].identifier === activeId) {
          activeId = null;
          break;
        }
      }
    }, { passive: false });

    window.controlSetters = window.controlSetters || {};
    window.controlSetters[name + '.x'] = (v) => {
      x = v;
      update();
      window.onControl && window.onControl({ name, x, y });
    };
    window.controlSetters[name + '.y'] = (v) => {
      y = v;
      update();
      window.onControl && window.onControl({ name, x, y });
    };

    update();
  }

  // ---- Knob (Unchanged) ----
  function makeKnob(el) {
    const name = el.dataset.name;
    const isMacro = el.classList.contains('macro');
    const dial = el.querySelector('.knob-dial');
    let activeId = null;
    let value = 0.5;
    let startY = 0;
    let startVal = 0.5;
    const rangePx = isMacro ? 220 : 150;
    const update = () => {
      dial.style.transform = `rotate(${(value - 0.5) * 270}deg)`;
    };
    function start(t) {
      if (activeId !== null) return;
      activeId = t.identifier;
      startY = t.clientY;
      startVal = value;
    }
    function move(t) {
      const dy = startY - t.clientY;
      value = clamp(startVal + dy / rangePx, 0, 1);
      update();
      window.onControl && window.onControl({ name, value });
    }
    function end(identifier) {
      if (activeId === null || identifier !== activeId) return;
      activeId = null;
    }
    let lastTap = 0;
    el.addEventListener('touchstart', (e) => {
      const now = Date.now();
      if (now - lastTap < 300) {
        value = 0.5;
        update();
        window.onControl && window.onControl({ name, value });
        return;
      }
      lastTap = now;
      e.preventDefault();
      const t = pickNewTouch(e);
      if (t) start(t);
    }, { passive: false });
    el.addEventListener('touchmove', (e) => {
      e.preventDefault();
      const t = findTouch(e, activeId);
      if (t) move(t);
    }, { passive: false });
    el.addEventListener('touchend', (e) => {
      e.preventDefault();
      for (let i = 0; i < e.changedTouches.length; i++) end(e.changedTouches[i].identifier);
    }, { passive: false });
    el.addEventListener('touchcancel', (e) => {
      e.preventDefault();
      for (let i = 0; i < e.changedTouches.length; i++) end(e.changedTouches[i].identifier);
    }, { passive: false });
    el.addEventListener('dblclick', (e) => {
      e.preventDefault();
      value = 0.5;
      update();
      window.onControl && window.onControl({ name, value });
    });

    window.controlSetters = window.controlSetters || {};
    window.controlSetters[name] = (v) => {
      value = v;
      update();
      window.onControl && window.onControl({ name, value });
    };

    update();
    window.onControl && window.onControl({ name, value });
  }

  // ---- Fader (Unchanged) ----
  function makeFader(el) {
    const name = el.dataset.name;
    const isBipolar = el.classList.contains('bipolar');
    const track = el.querySelector('.fader-track');
    const thumb = el.querySelector('.fader-thumb');
    const fill = el.querySelector('.fader-fill');
    let activeId = null;
    let value = isBipolar ? 0.5 : 0.85;
    let startY = 0;
    let startVal = isBipolar ? 0.5 : 0.85;
    const rangePx = 150;
    const update = () => {
      const h = track.offsetHeight;
      thumb.style.top = `${(1 - value) * h}px`;
      if (fill) {
        if (isBipolar) {
          if (value >= 0.5) {
            fill.style.bottom = '50%';
            fill.style.height = `${(value - 0.5) * 100}%`;
          } else {
            fill.style.bottom = `${value * 100}%`;
            fill.style.height = `${(0.5 - value) * 100}%`;
          }
        } else {
          fill.style.bottom = '0';
          fill.style.height = `${value * 100}%`;
        }
      }
    };
    function start(t) {
      if (activeId !== null) return;
      activeId = t.identifier;
      startY = t.clientY;
      startVal = value;
    }
    function move(t) {
      const dy = startY - t.clientY;
      const raw = startVal + dy / rangePx;
      const clamped = clamp(raw, 0, 1);
      if (clamped !== value) {
        value = clamped;
        update();
        window.onControl && window.onControl({ name, value });
      }
    }
    function end(identifier) {
      if (activeId === null || identifier !== activeId) return;
      activeId = null;
    }
    let lastTap = 0;
    el.addEventListener('touchstart', (e) => {
      const now = Date.now();
      if (now - lastTap < 300) {
        value = isBipolar ? 0.5 : 0.85;
        update();
        window.onControl && window.onControl({ name, value });
        return;
      }
      lastTap = now;
      e.preventDefault();
      const t = pickNewTouch(e);
      if (t) start(t);
    }, { passive: false });
    el.addEventListener('touchmove', (e) => {
      e.preventDefault();
      const t = findTouch(e, activeId);
      if (t) move(t);
    }, { passive: false });
    el.addEventListener('touchend', (e) => {
      e.preventDefault();
      for (let i = 0; i < e.changedTouches.length; i++) end(e.changedTouches[i].identifier);
    }, { passive: false });
    el.addEventListener('touchcancel', (e) => {
      e.preventDefault();
      for (let i = 0; i < e.changedTouches.length; i++) end(e.changedTouches[i].identifier);
    }, { passive: false });
    el.addEventListener('dblclick', (e) => {
      e.preventDefault();
      value = 0.5;
      update();
      window.onControl && window.onControl({ name, value });
    });

    window.controlSetters = window.controlSetters || {};
    window.controlSetters[name] = (v) => {
      value = v;
      update();
      window.onControl && window.onControl({ name, value });
    };
    
    window.addEventListener('resize', update);
    // Initial delay to let the DOM settle and offsetHeight become available
    setTimeout(update, 100);
    if (isBipolar) el.dataset.bipolar = '1';
    window.onControl && window.onControl({ name, value });
  }

  // ---- Page navigation (Tabs) ----
  // Extracted to modules/layout.js — delegates to window.RCSurface.setupLayout()
  function setupTabs() {
    if (typeof window.RCSurface?.setupLayout === 'function') {
      window.RCSurface.setupLayout();
    }
  }

  function setupStageModeUI() {
    const btn = document.getElementById('btn-stage-mode');
    if (!btn) return;

    function render(active) {
      document.body.classList.toggle('stage-mode', active);
      btn.classList.toggle('on', active);
      btn.setAttribute('aria-pressed', active ? 'true' : 'false');
      btn.textContent = active ? 'EXIT' : 'STAGE';
      window.dispatchEvent(new Event('resize'));
    }

    async function enter() {
      render(true);
      const root = document.documentElement;
      if (root.requestFullscreen && !document.fullscreenElement) {
        try {
          await root.requestFullscreen();
        } catch (e) {}
      }
    }

    async function exit() {
      render(false);
      if (document.fullscreenElement && document.exitFullscreen) {
        try {
          await document.exitFullscreen();
        } catch (e) {}
      }
    }

    btn.addEventListener('click', () => {
      if (document.body.classList.contains('stage-mode')) exit();
      else enter();
    });
  }

  // ---- Physics & Modulators animation updates ----
  let lastFrameTime = performance.now();
  let activePage = document.body.dataset.page || 'performance';
  window.addEventListener('ableton-rc:page-change', (event) => {
    activePage = (event.detail && event.detail.page) || document.body.dataset.page || 'performance';
    lastFrameTime = performance.now();
  });
  
  function globalPhysicsLoop() {
    requestAnimationFrame(globalPhysicsLoop);
    const now = performance.now();
    const dt = Math.max(1, now - lastFrameTime);
    lastFrameTime = now;
    const performanceVisible = (document.body.dataset.page || activePage) === 'performance';

    // 1. Run scalar bursts (mode D pads)
    for (const [name, burst] of activeScalarBursts.entries()) {
      const event = Modes.tickBurstGesture(burst.state, { now });
      if (event) burst.render(event);
      if (!burst.state.burst || !burst.state.burst.active) {
        activeScalarBursts.delete(name);
      }
    }

    // 2. Run Active LFOs
    const subdivisions = [4, 2, 1, 0.5, 0.25, 0.125, 0.0625];
    for (const [name, state] of lfoStates.entries()) {
      if (!state.active) continue;
      if (state.burstUntil > 0 && now >= state.burstUntil) {
        state.active = false;
        state.value = 0;
        state.burstUntil = 0;
        const el = document.querySelector(`.toggle[data-name="${name}"]`);
        if (el) {
          el.classList.remove('on', 'burst');
          const fill = el.querySelector('.mod-val-bar');
          if (fill) fill.style.height = '0%';
        }
        emitLfoState(name, state);
        continue;
      }

      let freqHz;
      if (window.syncMode === 'sync') {
        const subdiv = window.syncSettings.lfoSubdivisionPinned
          ? window.syncSettings.lfoSubdivision
          : subdivisionFromRate(state.rate, subdivisions);
        freqHz = (window.currentBpm / 60) / subdiv;
      } else {
        // Free mode: 0.1 Hz to 20 Hz
        freqHz = 0.1 + state.rate * 19.9;
      }
      // Keep the mapped signal inside the same stable ceiling as free mode.
      // Above this, display-rate sampling aliases and the mapped parameter can
      // appear slower than the visible LFO.
      freqHz = Math.min(20, freqHz);

      state.phase += 2 * Math.PI * freqHz * (dt / 1000);
      
      const wave = computeLfoWaveValue(window.syncSettings.lfoShape, state.phase);
      const lfoVal = 0.5 + wave * 0.5 * state.depth;
      state.value = lfoVal;

      if (performanceVisible) {
        const el = document.querySelector(`.toggle[data-name="${name}"]`);
        if (el) {
          const fill = el.querySelector('.mod-val-bar');
          if (fill) fill.style.height = `${lfoVal * 100}%`;
        }
      }
    }

    // 4. Run Active Stutters
    const stutterSubdivs = [1, 0.5, 0.25, 0.125, 0.0625, 0.03125];
    const nowSec = now / 1000;
    for (const [name, state] of stutterStates.entries()) {
      if (!state.pressed) continue;
      if (state.burstUntil > 0 && now >= state.burstUntil) {
        state.pressed = false;
        state.burstUntil = 0;
        const el = document.querySelector(`.button[data-name="${name}"]`);
        if (el) {
          el.classList.remove('pressed', 'burst');
          clearModeClass(el);
          el.style.removeProperty('background-color');
          el.style.removeProperty('--stut-pulse');
          el.style.removeProperty('--stut-glow-size');
          el.style.removeProperty('--stut-scale');
          el.style.removeProperty('--s1');
          el.style.removeProperty('--s2');
          el.style.removeProperty('--s3');
          el.style.removeProperty('--s4');
          el.style.removeProperty('--s5');
          el.style.removeProperty('--stut-zebra-on');
        }
        emitStutterState(name, state);
        continue;
      }

      let freqHz;
      if (window.syncMode === 'sync') {
        const subdiv = window.syncSettings.stutterSubdivisionPinned
          ? window.syncSettings.stutterSubdivision
          : subdivisionFromRate(state.rate, stutterSubdivs);
        freqHz = (window.currentBpm / 60) / subdiv;
      } else {
        // Free mode: 1 Hz to 20 Hz (cap consistente com LFO)
        freqHz = 1 + state.rate * 19;
      }

      // Ratcheting: eixo X (count) quantiza em 1x, 2x, 3x, 4x por tick.
      // Multiplica a freq base para que cada subdivisao produza N repeats.
      const ratchetLevels = [1, 2, 3, 4];
      const ratchetN = ratchetLevels[Math.floor(state.count * (ratchetLevels.length - 0.01))];
      const effectiveFreqHz = freqHz * ratchetN;

      const controlFreqHz = Math.min(15, effectiveFreqHz);

      // Update UI pulse: stutter keeps its amber family fill; A/B/C/D only
      // affect the border/glow mode class. A piscada visual eh limitada
      // a 15Hz para evitar aliasing temporal quando effectiveFreqHz
      // ultrapassa Nyquist do loop de render (que pode cair a 30FPS no
      // celular). O sinal enviado ao Ableton usa o mesmo cap para que o
      // parametro mapeado corresponda ao pulso visivel em vez de aliasar.
      const visualFreqHz = controlFreqHz;
      const stutterValVisual = Math.floor(nowSec * visualFreqHz * 2) % 2 === 0 ? 1 : 0;
      if (performanceVisible) {
        const el = document.querySelector(`.button[data-name="${name}"]`);
        if (el) {
          el.style.backgroundColor = stutterValVisual > 0.5
            ? 'rgba(255,159,10,0.82)'
            : 'rgba(255,159,10,0.10)';
          el.style.setProperty('--stut-glow-size', stutterValVisual > 0.5 ? '12px' : '7px');
        }
      }

      // Zebra lock: 5 listras pré-posicionadas. Atualiza continuamente para
      // refletir state.count mesmo apos release.
      if (performanceVisible) {
        const el = document.querySelector(`.button[data-name="${name}"]`);
        if (el) {
          const ratchetLevels = [1, 2, 3, 4];
          const ratchetIdx = Math.min(ratchetLevels.length - 1, Math.floor(state.count * ratchetLevels.length));
          const lit = ratchetIdx === 0 ? [] : ratchetIdx === 1 ? [3] : ratchetIdx === 2 ? [2,3,4] : [1,2,3,4,5];
          el.style.setProperty('--s1', lit.includes(1) ? '0.78' : '0');
          el.style.setProperty('--s2', lit.includes(2) ? '0.78' : '0');
          el.style.setProperty('--s3', lit.includes(3) ? '0.78' : '0');
          el.style.setProperty('--s4', lit.includes(4) ? '0.78' : '0');
          el.style.setProperty('--s5', lit.includes(5) ? '0.78' : '0');
          el.style.setProperty('--stut-zebra-on', ratchetIdx >= 1 ? '1' : '0');
        }
      }
    }

    // 5. Run Playhead Simulation
    let playheadTimeMs = window.playheadBaseTimeMs || 0;
    if (window.playheadActive) {
      playheadTimeMs += (Date.now() - (window.playheadStartTime || Date.now()));
    }

    const beatsTotal = (playheadTimeMs / 1000) * (window.currentBpm / 60);
    const beatsPerBar = window.currentNumerator || 4;
    const subdivsPerBeat = 4;
    
    const currentBar = Math.floor(beatsTotal / beatsPerBar) + 1;
    const currentBeat = Math.floor(beatsTotal % beatsPerBar) + 1;
    const currentSixteenth = Math.floor((beatsTotal * subdivsPerBeat) % subdivsPerBeat) + 1;
    
    const playheadEl = document.getElementById('live-playhead');
    if (playheadEl) {
      playheadEl.textContent = `${currentBar}.${currentBeat}.${currentSixteenth}`;
    }
    
    const elapsedSec = playheadTimeMs / 1000;
    const mins = Math.floor(elapsedSec / 60);
    const secs = Math.floor(elapsedSec % 60);
    const tenths = Math.floor((playheadTimeMs % 1000) / 100);
    const timeEl = document.getElementById('live-time');
    if (timeEl) {
      timeEl.textContent = `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}.${tenths}`;
    }
  }

  // Extracted to modules/sync.js — delegates to window.RCSurface.setupSync()
  function setupSyncModeUI() {
    if (typeof window.RCSurface?.setupSync === 'function') {
      window.RCSurface.setupSync();
    }
  }

  // Extracted to modules/playhead.js — delegates to window.RCSurface.setupPlayhead()
  function setupPlayheadUI() {
    if (typeof window.RCSurface?.setupPlayhead === 'function') {
      window.RCSurface.setupPlayhead();
    }
  }

  // ---- Snapshots & Vector Morphing System ----
  // Extracted to modules/snapshots.js

  function cancelMorph() {
    if (typeof window.RCSurface?.snapshots?.cancelMorph === 'function') {
      window.RCSurface.snapshots.cancelMorph();
    }
  }

  function startLinearMorph(targetState, durationSec, onComplete) {
    if (typeof window.RCSurface?.snapshots?.startLinearMorph === 'function') {
      window.RCSurface.snapshots.startLinearMorph(targetState, durationSec, onComplete);
    }
  }

  function handleSnapshotSlot(idx, btn) {
    if (typeof window.RCSurface?.snapshots?.handleSnapshotSlot === 'function') {
      window.RCSurface.snapshots.handleSnapshotSlot(idx, btn);
    }
  }

  function setSnapshotCaptureMode(active) {
    if (typeof window.RCSurface?.snapshots?.setSnapshotCaptureMode === 'function') {
      window.RCSurface.snapshots.setSnapshotCaptureMode(active);
    }
  }

  function resetScalarControl(name) {
    if (window.controlSetters && typeof window.controlSetters[name] === 'function') {
      try {
        window.controlSetters[name](0);
        return;
      } catch (e) {}
    }
    window.onControl && window.onControl({ name, value: 0 });
  }

  function resetXYControl(name) {
    const xKey = `${name}.x`;
    const yKey = `${name}.y`;
    if (
      window.controlSetters &&
      typeof window.controlSetters[xKey] === 'function' &&
      typeof window.controlSetters[yKey] === 'function'
    ) {
      try {
        window.controlSetters[xKey](0.5);
        window.controlSetters[yKey](0.5);
        return;
      } catch (e) {}
    }
    window.onControl && window.onControl({ name, x: 0.5, y: 0.5 });
  }

  function resetPerformanceControls() {
    cancelMorph();
    setSnapshotCaptureMode(false);
    if (activeScalarBursts) activeScalarBursts.clear();

    for (let i = 1; i <= 12; i++) resetScalarControl(`pad-${i}`);
    for (let i = 1; i <= 4; i++) resetScalarControl(`toggle-${i}`);
    for (let i = 1; i <= 4; i++) resetScalarControl(`button-${i}`);
    resetXYControl('xy-1');
    resetXYControl('xy-2');
  }

  function setupVectorPad() {
    const vPad = document.getElementById('xy-vector-pad');
    if (!vPad) return;
    const canvas = vPad.querySelector('#xy-vector-canvas');
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    
    let width = 0, height = 0;
    let x = 0.5, y = 0.5; // proportional coordinates
    let activeId = null;
    let isDragging = false;
    const radius = 10;
    
    function resize() {
      const rect = vPad.getBoundingClientRect();
      width = rect.width;
      height = rect.height;
      canvas.width = width;
      canvas.height = height;
      draw();
    }
    
    window.addEventListener('resize', resize);
    setTimeout(resize, 150);
    
    function draw() {
      if (width === 0 || height === 0) return;
      ctx.clearRect(0, 0, width, height);
      
      // Draw grid lines
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.04)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(width / 2, 0);
      ctx.lineTo(width / 2, height);
      ctx.moveTo(0, height / 2);
      ctx.lineTo(width, height / 2);
      ctx.stroke();
      
      // Draw corner indicators
      const drawCorner = (cx, cy, label, hasSnap) => {
        ctx.beginPath();
        ctx.arc(cx, cy, 14, 0, Math.PI * 2);
        ctx.fillStyle = hasSnap ? 'rgba(191, 90, 242, 0.12)' : 'rgba(255, 255, 255, 0.02)';
        ctx.fill();
        ctx.strokeStyle = hasSnap ? '#bf5af2' : 'rgba(255, 255, 255, 0.1)';
        ctx.lineWidth = 1.5;
        ctx.stroke();
        
        ctx.fillStyle = hasSnap ? '#bf5af2' : '#8e8e93';
        ctx.font = '800 10px sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(label, cx, cy);
      };
      
      const snaps = typeof window.RCSurface?.snapshots?.getSnapshots === 'function' ? window.RCSurface.snapshots.getSnapshots() : [];
      drawCorner(22, 22, '1', !!snaps[0]);
      drawCorner(width - 22, 22, '2', !!snaps[1]);
      drawCorner(22, height - 22, '3', !!snaps[2]);
      drawCorner(width - 22, height - 22, '4', !!snaps[3]);
      
      // Draw crosshair lines
      const px = x * width;
      const py = y * height;
      ctx.strokeStyle = 'rgba(191, 90, 242, 0.2)';
      ctx.lineWidth = 1;
      ctx.setLineDash([4, 4]);
      ctx.beginPath();
      ctx.moveTo(px, 0); ctx.lineTo(px, height);
      ctx.moveTo(0, py); ctx.lineTo(width, py);
      ctx.stroke();
      ctx.setLineDash([]);
      
      // Draw ball glow
      const glow = ctx.createRadialGradient(px, py, 1, px, py, radius * 2);
      glow.addColorStop(0, '#bf5af2');
      glow.addColorStop(0.3, 'rgba(191, 90, 242, 0.6)');
      glow.addColorStop(1, 'rgba(191, 90, 242, 0)');
      ctx.beginPath();
      ctx.arc(px, py, radius * 2, 0, Math.PI * 2);
      ctx.fillStyle = glow;
      ctx.fill();
      
      // Draw ball core
      ctx.beginPath();
      ctx.arc(px, py, radius, 0, Math.PI * 2);
      ctx.fillStyle = '#bf5af2';
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = 2.5;
      ctx.fill();
      ctx.stroke();
    }
    
    function updateVectorValues() {
      const w1 = (1 - x) * (1 - y);
      const w2 = x * (1 - y);
      const w3 = (1 - x) * y;
      const w4 = x * y;
      
      const currentSnaps = typeof window.RCSurface?.snapshots?.getSnapshots === 'function' ? window.RCSurface.snapshots.getSnapshots() : [];
      const keys = new Set();
      [currentSnaps[0], currentSnaps[1], currentSnaps[2], currentSnaps[3]].forEach(snap => {
        if (snap) {
          Object.keys(snap).forEach(k => keys.add(k));
        }
      });
      
      const getVal = (snap, key) => {
        if (snap && snap[key] !== undefined) return snap[key];
        return window.currentControlStates[key] !== undefined ? window.currentControlStates[key] : 0.5;
      };
      
      withModulatorEmitBatch(() => {
        for (const key of keys) {
          const v = w1 * getVal(currentSnaps[0], key) +
                    w2 * getVal(currentSnaps[1], key) +
                    w3 * getVal(currentSnaps[2], key) +
                    w4 * getVal(currentSnaps[3], key);

          if (window.controlSetters && typeof window.controlSetters[key] === 'function') {
            try {
              window.controlSetters[key](v);
            } catch (e) {}
          }
        }
      });
    }
    
    function setFromTouch(t) {
      const rect = canvas.getBoundingClientRect();
      x = clamp((t.clientX - rect.left) / rect.width, 0, 1);
      y = clamp((t.clientY - rect.top) / rect.height, 0, 1);
      updateVectorValues();
      draw();
    }
    
    vPad.addEventListener('touchstart', (e) => {
      e.preventDefault();
      if (activeId !== null) return;
      const t = pickNewTouch(e);
      if (!t) return;
      activeId = t.identifier;
      isDragging = true;
      setFromTouch(t);
    }, { passive: false });
    
    vPad.addEventListener('touchmove', (e) => {
      e.preventDefault();
      const t = findTouch(e, activeId);
      if (t) setFromTouch(t);
    }, { passive: false });
    
    vPad.addEventListener('touchend', (e) => {
      e.preventDefault();
      for (let i = 0; i < e.changedTouches.length; i++) {
        if (e.changedTouches[i].identifier === activeId) {
          activeId = null;
          isDragging = false;
          break;
        }
      }
    }, { passive: false });
    
    vPad.addEventListener('touchcancel', (e) => {
      e.preventDefault();
      for (let i = 0; i < e.changedTouches.length; i++) {
        if (e.changedTouches[i].identifier === activeId) {
          activeId = null;
          isDragging = false;
          break;
        }
      }
    }, { passive: false });
    
    window.resetVectorPad = () => {
      x = 0.5;
      y = 0.5;
      draw();
    };
    
    window.addEventListener('ableton-rc:snapshots-updated', draw);
  }

  // Extracted to modules/snapshots.js — delegates to window.RCSurface.snapshots.setupSnapshots()
  function setupSnapshots() {
    if (typeof window.RCSurface?.snapshots?.setupSnapshots === 'function') {
      window.RCSurface.snapshots.setupSnapshots();
    }
  }

  function setupPerformanceUtilities() {
    const offBtn = document.getElementById('btn-perf-off');
    if (offBtn) {
      offBtn.addEventListener('click', resetPerformanceControls);
    }
  }

  // Extracted to modules/transport.js — delegates to window.RCSurface.setupTransport()
  function setupTransportLiteUI() {
    if (typeof window.RCSurface?.setupTransport === 'function') {
      window.RCSurface.setupTransport();
    }
  }

  function setupSyncSettingsUI() {
    const btnSettings = document.getElementById('btn-sync-settings');
    const overlay = document.getElementById('sync-settings-overlay');
    const btnClose = document.getElementById('btn-sync-settings-close');
    const btnSyncMode = document.getElementById('btn-sync-mode');

    if (!overlay) return;

    if (btnSettings) {
      btnSettings.addEventListener('click', () => {
        overlay.classList.remove('hidden');
        renderSyncSettingsUI();
      });
    }

    if (btnSyncMode) {
      let pressTimer = null;
      const startPress = () => {
        pressTimer = setTimeout(() => {
          overlay.classList.remove('hidden');
          renderSyncSettingsUI();
        }, 600);
      };
      const endPress = () => {
        if (pressTimer) clearTimeout(pressTimer);
      };
      btnSyncMode.addEventListener('mousedown', startPress);
      btnSyncMode.addEventListener('mouseup', endPress);
      btnSyncMode.addEventListener('mouseleave', endPress);
      btnSyncMode.addEventListener('touchstart', startPress);
      btnSyncMode.addEventListener('touchend', endPress);
    }

    if (btnClose) {
      btnClose.addEventListener('click', () => overlay.classList.add('hidden'));
    }
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) overlay.classList.add('hidden');
    });

    const selectClockSource = document.getElementById('select-clock-source');
    if (selectClockSource) {
      selectClockSource.addEventListener('change', () => {
        window.syncSettings.clockSource = selectClockSource.value;
        saveSyncSettings();
        emitAllModulatorStates();
      });
    }

    const lfoRateGrid = document.getElementById('lfo-rate-grid');
    if (lfoRateGrid && typeof lfoRateGrid.querySelectorAll === 'function') {
      lfoRateGrid.querySelectorAll('.grid-btn').forEach(btn => {
        btn.addEventListener('click', () => {
          const val = btn.dataset.val;
          window.syncSettings.lfoSubdivisionPinned = val !== 'auto';
          if (window.syncSettings.lfoSubdivisionPinned) {
            window.syncSettings.lfoSubdivision = parseFloat(val);
          }
          updateGridActiveState(lfoRateGrid, val);
          saveSyncSettings();
          emitAllModulatorStates();
        });
      });
    }

    const lfoShapeGrid = document.getElementById('lfo-shape-grid');
    if (lfoShapeGrid && typeof lfoShapeGrid.querySelectorAll === 'function') {
      lfoShapeGrid.querySelectorAll('.grid-btn').forEach(btn => {
        btn.addEventListener('click', () => {
          window.syncSettings.lfoShape = btn.dataset.val;
          updateGridActiveState(lfoShapeGrid, btn.dataset.val);
          saveSyncSettings();
          emitAllModulatorStates();
        });
      });
    }

    const lfoPhaseInput = document.getElementById('lfo-phase-offset');
    const lfoPhaseVal = document.getElementById('lfo-phase-offset-val');
    if (lfoPhaseInput) {
      lfoPhaseInput.addEventListener('input', () => {
        const val = parseFloat(lfoPhaseInput.value);
        window.syncSettings.lfoPhaseOffset = val;
        if (lfoPhaseVal) lfoPhaseVal.textContent = val >= 0 ? `+${val.toFixed(2)}` : val.toFixed(2);
        saveSyncSettings();
        emitAllModulatorStates();
      });
    }

    const stutterRateGrid = document.getElementById('stutter-rate-grid');
    if (stutterRateGrid && typeof stutterRateGrid.querySelectorAll === 'function') {
      stutterRateGrid.querySelectorAll('.grid-btn').forEach(btn => {
        btn.addEventListener('click', () => {
          const val = btn.dataset.val;
          window.syncSettings.stutterSubdivisionPinned = val !== 'auto';
          if (window.syncSettings.stutterSubdivisionPinned) {
            window.syncSettings.stutterSubdivision = parseFloat(val);
          }
          updateGridActiveState(stutterRateGrid, val);
          saveSyncSettings();
          emitAllModulatorStates();
        });
      });
    }

    const stutterSwingInput = document.getElementById('stutter-swing');
    const stutterSwingVal = document.getElementById('stutter-swing-val');
    if (stutterSwingInput) {
      stutterSwingInput.addEventListener('input', () => {
        const val = parseFloat(stutterSwingInput.value);
        window.syncSettings.stutterSwing = val;
        if (stutterSwingVal) stutterSwingVal.textContent = val.toFixed(2);
        saveSyncSettings();
        emitAllModulatorStates();
      });
    }

    const stutterPhaseInput = document.getElementById('stutter-phase-offset');
    const stutterPhaseVal = document.getElementById('stutter-phase-offset-val');
    if (stutterPhaseInput) {
      stutterPhaseInput.addEventListener('input', () => {
        const val = parseFloat(stutterPhaseInput.value);
        window.syncSettings.stutterPhaseOffset = val;
        if (stutterPhaseVal) stutterPhaseVal.textContent = val >= 0 ? `+${val.toFixed(2)}` : val.toFixed(2);
        saveSyncSettings();
        emitAllModulatorStates();
      });
    }

    const resetInput = (inputEl, valEl, defaultVal, key) => {
      const handler = () => {
        inputEl.value = defaultVal;
        window.syncSettings[key] = defaultVal;
        if (valEl) valEl.textContent = defaultVal >= 0 ? `+${defaultVal.toFixed(2)}` : defaultVal.toFixed(2);
        if (key === 'stutterSwing' && valEl) valEl.textContent = defaultVal.toFixed(2);
        saveSyncSettings();
        emitAllModulatorStates();
      };
      inputEl.addEventListener('dblclick', handler);
      if (valEl) {
        valEl.addEventListener('dblclick', handler);
        valEl.style.cursor = 'pointer';
      }
      const label = (typeof inputEl.closest === 'function') ? inputEl.closest('.setting-row')?.querySelector('label') : null;
      if (label) {
        label.addEventListener('dblclick', handler);
        label.style.cursor = 'pointer';
      }
    };

    if (lfoPhaseInput) resetInput(lfoPhaseInput, lfoPhaseVal, 0.0, 'lfoPhaseOffset');
    if (stutterSwingInput) resetInput(stutterSwingInput, stutterSwingVal, 0.0, 'stutterSwing');
    if (stutterPhaseInput) resetInput(stutterPhaseInput, stutterPhaseVal, 0.0, 'stutterPhaseOffset');

    function saveSyncSettings() {
      localStorage.setItem('ableton-rc:sync_settings', JSON.stringify(window.syncSettings));
    }

    function updateGridActiveState(parent, activeValue) {
      if (parent && typeof parent.querySelectorAll === 'function') {
        parent.querySelectorAll('.grid-btn').forEach(btn => {
          const isActive = parseFloat(btn.dataset.val) === parseFloat(activeValue) || btn.dataset.val === activeValue;
          btn.classList.toggle('on', isActive);
        });
      }
    }

    function renderSyncSettingsUI() {
      const settings = window.syncSettings;
      
      if (selectClockSource) selectClockSource.value = settings.clockSource;
      
      if (lfoRateGrid) updateGridActiveState(lfoRateGrid, settings.lfoSubdivisionPinned ? settings.lfoSubdivision : 'auto');
      if (lfoShapeGrid) updateGridActiveState(lfoShapeGrid, settings.lfoShape);
      
      if (lfoPhaseInput) {
        lfoPhaseInput.value = settings.lfoPhaseOffset;
        if (lfoPhaseVal) {
          const val = settings.lfoPhaseOffset;
          lfoPhaseVal.textContent = val >= 0 ? `+${val.toFixed(2)}` : val.toFixed(2);
        }
      }

      if (stutterRateGrid) updateGridActiveState(stutterRateGrid, settings.stutterSubdivisionPinned ? settings.stutterSubdivision : 'auto');
      
      if (stutterSwingInput) {
        stutterSwingInput.value = settings.stutterSwing;
        if (stutterSwingVal) stutterSwingVal.textContent = settings.stutterSwing.toFixed(2);
      }

      if (stutterPhaseInput) {
        stutterPhaseInput.value = settings.stutterPhaseOffset;
        if (stutterPhaseVal) {
          const val = settings.stutterPhaseOffset;
          stutterPhaseVal.textContent = val >= 0 ? `+${val.toFixed(2)}` : val.toFixed(2);
        }
      }
    }

    renderSyncSettingsUI();
  }

  // ---- Wire up everything ----
  // Run once the phone DOM is ready.
  function bootstrapControls() {
    setupPadModeUI();
    setupTabs();
    setupStageModeUI();
    setupSyncModeUI();
    setupPlayheadUI();
    setupVectorPad();
    setupSnapshots();
    setupPerformanceUtilities();
    setupTransportLiteUI();
    setupSyncSettingsUI();

    document.querySelectorAll('.pad').forEach(makePad);
    document.querySelectorAll('.knob').forEach(makeKnob);
    document.querySelectorAll('.fader:not(.bipolar)').forEach(makeFader);
    document.querySelectorAll('.fader.bipolar').forEach(makeFader);

    document.querySelectorAll('.xy-pad').forEach(makeXYPad);

    // LFO & Stutters
    document.querySelectorAll('.toggle').forEach(makeLfoToggle);
    document.querySelectorAll('.button').forEach(makeStutterButton);

    // Physics XY Canvas
    document.querySelectorAll('.xy-pad-physics').forEach(setupXYPhysics);

    // Start the background animation loop for physics + modulators
    globalPhysicsLoop();
  }

  // Restore last pad mode from localStorage if present — do this BEFORE
  // bootstrap so the first paint reflects the saved mode (no flash of
  // the default mode A).
  try {
    const savedMode = localStorage.getItem('ableton-rc:pad_mode');
    if (savedMode && ['A', 'B', 'C', 'D'].includes(savedMode)) {
      padMode = savedMode;
      if (typeof document !== 'undefined' && document.body) {
        document.body.dataset.padMode = savedMode;
      }
    }
  } catch {}

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', bootstrapControls);
  } else {
    // DOM already parsed (script loaded with `defer`, or `type="module"`).
    // Run synchronously.
    bootstrapControls();
  }
  // Expose setPadMode so app.js can restore saved mode on boot/reconnect.
  window.setPadMode = setPadMode;

  // Expose resetTransientControls for app.js to clear any "stuck" pad/button
  // state on WS disconnect. Momentary/burst controls (modes A/D) can be left
  // visually pressed if the user releases their finger during the disconnect
  // window; the Live side already dropped the value, so we just need to
  // refresh the visual state. Toggles/latched (B/C) keep their value.
  window.resetTransientControls = () => {
    const mode = padMode;
    if (mode !== 'A' && mode !== 'D') return;
    for (const [name, burst] of activeScalarBursts.entries()) {
      activeScalarBursts.delete(name);
      burst.render({ value: 0, phase: 'burst-end', active: false });
    }
    document.querySelectorAll('.pad').forEach((el) => {
      el.classList.remove('active', 'latched', 'toggled', 'burst');
      el.style.removeProperty('--pad-fill-alpha');
      el.style.removeProperty('--pad-fill-color');
    });
    document.querySelectorAll('.toggle, .button').forEach((el) => {
      el.classList.remove('active');
      el.style.removeProperty('--pad-fill-alpha');
      el.style.removeProperty('--pad-fill-color');
    });
  };

  // Host-confirmed soft-takeover feedback. It is intentionally rendered on
  // the control itself so performance mode never needs a modal or toast.
  window.currentSafeFeedback = {};
  window.updateSafeInputFeedback = (controlName, feedback) => {
    if (!controlName || !feedback) return;
    window.currentSafeFeedback[controlName] = feedback;
    const axisMatch = controlName.match(/\.(x|y)$/);
    const baseName = axisMatch ? controlName.slice(0, -2) : controlName;
    const el = document.querySelector(`[data-name="${baseName}"]`);
    if (!el) return;
    const host = Math.max(0, Math.min(1, Number(feedback.hostValue) || 0));
    if (axisMatch) {
      el.style.setProperty(`--safe-host-${axisMatch[1]}`, String(host));
    } else {
      el.style.setProperty('--safe-host', String(host));
    }
    el.dataset.safeDirection = String(feedback.direction || 0);
    el.dataset.safeMode = feedback.mode || 'scale';
    const takingOver = feedback.state === 'takeover' || feedback.state === 'recovering';
    el.classList.toggle('safe-takeover', takingOver);
    el.dataset.safeCaptured = feedback.captured ? 'true' : 'false';
  };

  window.emitAllModulatorStates = emitAllModulatorStates;
})();
