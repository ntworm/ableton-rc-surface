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

  function triggerHaptic(type) {
    if (!window.hapticSettings || !window.hapticSettings.enabled) return;
    if (!navigator.vibrate) return;

    const profile = window.hapticSettings.profile || 'standard';
    let duration = 0;

    switch (type) {
      case 'tap':
        duration = profile === 'gentle' ? 6 : (profile === 'heavy' ? 15 : 10);
        break;
      case 'toggle':
        duration = profile === 'gentle' ? 8 : (profile === 'heavy' ? 22 : 15);
        break;
      case 'collision':
        duration = profile === 'gentle' ? 12 : (profile === 'heavy' ? 30 : 20);
        break;
      case 'double':
        const d1 = profile === 'gentle' ? 5 : (profile === 'heavy' ? 12 : 8);
        const gap = profile === 'gentle' ? 30 : (profile === 'heavy' ? 50 : 40);
        navigator.vibrate([d1, gap, d1]);
        return;
    }

    if (duration > 0) {
      navigator.vibrate(duration);
    }
  }

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
  let syncMode = 'sync';

  // Playhead estimation state
  window.playheadActive = false;
  window.playheadStartTime = Date.now();
  window.playheadBaseTimeMs = 0;

  // Global performance mode (A/B/C/D) -- shared by pads, LFOs, and stutters.
  let padMode = 'A';
  const latchedValues = new Map();    // B: last value before release
  const toggledStates = new Map();    // C: on/off boolean

  function setPadMode(mode) {
    if (mode === padMode) return;
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
      el.style.removeProperty('--pad-color');
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
        const fill = el.querySelector('.mod-val-bar');
        if (fill) fill.style.height = '0%';
      }
      window.onControl && window.onControl({ name, value: 0 });
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
        el.style.removeProperty('background-color');
      }
      window.onControl && window.onControl({ name, value: 0 });
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

    function showValue(value) {
      el.classList.add('active');
      el.classList.remove('latched', 'toggled', 'burst');
      el.style.setProperty('--pad-color', `rgba(10,132,255,${0.25 + 0.75 * value})`);
    }
    function showLatched(value) {
      el.classList.remove('toggled', 'burst');
      el.classList.add('active', 'latched');
      el.style.setProperty('--pad-color', `rgba(255,159,10,${0.30 + 0.70 * value})`);
    }
    function showToggled(value) {
      el.classList.remove('latched', 'burst');
      el.classList.add('active', 'toggled');
      el.style.setProperty('--pad-color', `rgba(52,199,89,${0.30 + 0.70 * value})`);
    }
    function showBurst(value) {
      el.classList.remove('latched', 'toggled');
      el.classList.add('active', 'burst');
      el.style.setProperty('--pad-color', `rgba(255,55,95,${0.28 + 0.72 * value})`);
    }
    function clearVisual() {
      el.classList.remove('active', 'latched', 'toggled', 'burst');
      el.style.removeProperty('--pad-color');
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
        if (value > 0.001 || active) showToggled(value || 1); else clearVisual();
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
      triggerHaptic(padMode === 'A' ? 'tap' : 'toggle');
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
      renderValue(value, padMode, value > 0.001);
      window.onControl && window.onControl({
        name,
        value,
        pressure: value,
        delta: 0,
      });
    };
  }

  // ---- Physics Ribbons (Expression) ----
  // We manage active physics updates in a Map of update functions.
  const activeScalarBursts = new Map();
  const activePhysicsTick = new Map();

  function makePhysicsRibbon(el) {
    const name = el.dataset.name;
    const fill = el.querySelector('.ribbon-fill-perf');
    const isSpring = name === 'ribbon-2'; // Ribbon 2 is spring back to center 0.5

    let activeId = null;
    let value = isSpring ? 0.5 : 0.0;
    let velocity = 0;
    let isDragging = false;
    let lastY = 0;
    let lastTime = 0;

    const render = () => {
      fill.style.height = `${value * 100}%`;
    };

    function updateTouch(t) {
      const r = el.getBoundingClientRect();
      const rawVal = clamp(1 - (t.clientY - r.top) / r.height, 0, 1);
      
      const now = performance.now();
      const dt = Math.max(1, now - lastTime);
      
      // Calculate touch speed/velocity
      velocity = (rawVal - value) / (dt / 16.6); // normalized velocity per frame (16.6ms)
      value = rawVal;
      lastTime = now;
      render();
      window.onControl && window.onControl({ name, value });
    }

    function start(t) {
      if (activeId !== null) return;
      activeId = t.identifier;
      isDragging = true;
      lastTime = performance.now();
      velocity = 0;
      activePhysicsTick.delete(name); // Stop physics simulation
      triggerHaptic('tap');
      updateTouch(t);
    }

    function move(t) {
      if (activeId === null) return;
      updateTouch(t);
    }

    function end(identifier) {
      if (activeId === null || identifier !== activeId) return;
      activeId = null;
      isDragging = false;

      // Start physics loop when touch ends
      activePhysicsTick.set(name, () => {
        if (isSpring) {
          // Tension pulling back to 0.5
          const tension = 0.15;
          const friction = 0.12;
          const accel = -tension * (value - 0.5);
          velocity += accel;
          velocity *= (1 - friction);
          value += velocity;

          if (Math.abs(value - 0.5) < 0.001 && Math.abs(velocity) < 0.001) {
            value = 0.5;
            velocity = 0;
            render();
            window.onControl && window.onControl({ name, value });
            activePhysicsTick.delete(name); // Stop simulation
          } else {
            render();
            window.onControl && window.onControl({ name, value });
          }
        } else {
          // Inertia sliding with friction + bouncing
          const friction = 0.07;
          const bounce = 0.4;
          velocity *= (1 - friction);
          value += velocity;

          if (value <= 0) {
            value = 0;
            velocity = -velocity * bounce;
            if (Math.abs(velocity) < 0.002) velocity = 0;
            triggerHaptic('collision');
          } else if (value >= 1) {
            value = 1;
            velocity = -velocity * bounce;
            if (Math.abs(velocity) < 0.002) velocity = 0;
            triggerHaptic('collision');
          }

          if (Math.abs(velocity) < 0.001) {
            velocity = 0;
            activePhysicsTick.delete(name); // Stop simulation
          }
          render();
          window.onControl && window.onControl({ name, value });
        }
      });
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
      value = v;
      render();
      window.onControl && window.onControl({ name, value });
    };

    render();
  }

  // ---- LFO Modulator Toggles ----
  const lfoStates = new Map(); // name -> { active, depth, rate, phase }

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
    }

    function deactivate(state) {
      state.active = false;
      state.value = 0;
      state.burstUntil = 0;
      state.pendingToggleOff = false;
      if (fill) fill.style.height = '0%';
      renderState();
      window.onControl && window.onControl({ name, value: 0 });
    }

    function start(t) {
      if (activeId !== null) return;
      const state = lfoStates.get(name);
      armGesture(t, state);

      if (padMode === 'B') {
        activate(state, 0);
        triggerHaptic('toggle');
        return;
      }

      if (padMode === 'C') {
        if (state.active) {
          state.pendingToggleOff = true;
          renderState();
        } else {
          activate(state, 0);
        }
        triggerHaptic('toggle');
        return;
      }

      if (padMode === 'D') {
        activate(state, 1100);
        triggerHaptic('double');
        return;
      }

      activate(state, 0);
      triggerHaptic('tap');
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
      }
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
        state.burstUntil = 0;
        state.pendingToggleOff = false;
        renderState();
        if (!state.active) {
          state.value = 0;
          if (fill) fill.style.height = '0%';
        }
        window.onControl && window.onControl({ name, value: state.value });
      }
    };
  }

  // ---- Stutter Rolls (Momentary) ----
  const stutterStates = new Map(); // name -> { pressed, rate }

  function makeStutterButton(el) {
    const name = el.dataset.name;

    stutterStates.set(name, {
      pressed: false,
      rate: 0.5,
      burstUntil: 0,
      pendingToggleOff: false,
      moved: false,
    });

    let activeId = null;
    let gestureMode = null;
    let startY = 0;
    let startRate = 0.5;

    function renderState(pressed) {
      el.classList.toggle('pressed', pressed);
      const state = stutterStates.get(name);
      el.classList.toggle('burst', !!state && state.pressed && state.burstUntil > 0);
      if (!pressed) {
        el.style.removeProperty('background-color');
      }
    }

    function armGesture(t, state) {
      activeId = t.identifier;
      gestureMode = padMode;
      startY = t.clientY;
      startRate = state.rate;
      state.moved = false;
    }

    function activate(state, burstMs) {
      state.pressed = true;
      state.pendingToggleOff = false;
      state.burstUntil = burstMs ? performance.now() + burstMs : 0;
      renderState(true);
    }

    function deactivate(state) {
      state.pressed = false;
      state.burstUntil = 0;
      state.pendingToggleOff = false;
      renderState(false);
      window.onControl && window.onControl({ name, value: 0 });
    }

    function start(t) {
      if (activeId !== null) return;
      const state = stutterStates.get(name);
      armGesture(t, state);

      if (padMode === 'B') {
        activate(state, 0);
        triggerHaptic('toggle');
        return;
      }

      if (padMode === 'C') {
        if (state.pressed) {
          state.pendingToggleOff = true;
          renderState(true);
        } else {
          activate(state, 0);
        }
        triggerHaptic('toggle');
        return;
      }

      if (padMode === 'D') {
        activate(state, 700);
        triggerHaptic('double');
        return;
      }

      activate(state, 0);
      triggerHaptic('tap');
    }

    function move(t) {
      if (activeId === null) return;
      const state = stutterStates.get(name);
      const dy = startY - t.clientY;
      if (Math.abs(dy) > 4) {
        state.moved = true;
        state.pendingToggleOff = false;
      }
      state.rate = clamp(startRate + dy / 150, 0, 1);
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
      }
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
        state.burstUntil = 0;
        state.pendingToggleOff = false;
        renderState(state.pressed);
        window.onControl && window.onControl({ name, value: v });
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
      triggerHaptic('tap');
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
          triggerHaptic('collision');
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
      triggerHaptic('tap');
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
      triggerHaptic('tap');
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
      value = v;
      update();
      window.onControl && window.onControl({ name, value });
    };

    update();
  }

  // ---- Fader (Unchanged) ----
  function makeFader(el) {
    const name = el.dataset.name;
    const isBipolar = el.classList.contains('bipolar');
    const track = el.querySelector('.fader-track');
    const thumb = el.querySelector('.fader-thumb');
    const fill = el.querySelector('.fader-fill');
    let activeId = null;
    let value = 0.5;
    let startY = 0;
    let startVal = 0.5;
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
      triggerHaptic('tap');
    }
    function move(t) {
      const dy = startY - t.clientY;
      const raw = startVal + dy / rangePx;
      const clamped = clamp(raw, 0, 1);
      if (clamped !== value) {
        if ((clamped === 0 && value > 0) || (clamped === 1 && value < 1)) {
          triggerHaptic('collision');
        }
        value = clamped;
        update();
        window.onControl && window.onControl({ name, value });
      }
    }
    function end(identifier) {
      if (activeId === null || identifier !== activeId) return;
      activeId = null;
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
      value = v;
      update();
      window.onControl && window.onControl({ name, value });
    };
    
    window.addEventListener('resize', update);
    // Initial delay to let the DOM settle and offsetHeight become available
    setTimeout(update, 100);
    if (isBipolar) el.dataset.bipolar = '1';
  }

  // ---- Bipolar Ribbons in Mixer (Unchanged) ----
  function makeBipolarRibbon(el) {
    const name = el.dataset.name;
    const fill = el.querySelector('.ribbon-fill');
    let activeId = null;
    let value = 0;
    let lastValue = 0;
    const update = () => {
      fill.style.width = `${value * 100}%`;
    };
    function set(t) {
      const r = el.getBoundingClientRect();
      const v = clamp((t.clientX - r.left) / r.width, 0, 1);
      if (v !== value) {
        const delta = v - lastValue;
        value = v;
        lastValue = v;
        update();
        window.onControl && window.onControl({ name, value, delta });
      }
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
          if (value !== 0) {
            const delta = 0 - lastValue;
            value = 0;
            lastValue = 0;
            update();
            window.onControl && window.onControl({ name, value: 0, delta });
          }
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
    window.controlSetters[name] = (v) => {
      value = v;
      lastValue = v;
      update();
      window.onControl && window.onControl({ name, value });
    };

    update();
  }

  // ---- Page navigation (Tabs) ----
  function setupTabs() {
    const tabs = document.querySelectorAll('.tabs .tab');
    const bankTiles = document.querySelectorAll('[data-bank]');
    function show(page) {
      document.body.dataset.page = page;
      document.querySelectorAll('.page').forEach((p) => {
        p.classList.toggle('hidden', p.dataset.page !== page);
      });
      document.querySelectorAll('.tabs .tab').forEach((t) => {
        const active = t.dataset.page === page;
        t.classList.toggle('on', active);
        t.setAttribute('aria-selected', active ? 'true' : 'false');
      });
      const info = document.getElementById('bank-info');
      if (info) info.textContent = `Banco atual: ${page.toUpperCase()}`;
      window.dispatchEvent(new Event('resize'));
    }
    tabs.forEach((t) => {
      t.addEventListener('click', () => show(t.dataset.page));
    });
    bankTiles.forEach((b) => {
      b.addEventListener('click', () => show(b.dataset.bank));
    });
    show('performance');
  }

  // ---- Physics & Modulators animation updates ----
  let lastFrameTime = performance.now();
  
  function globalPhysicsLoop() {
    requestAnimationFrame(globalPhysicsLoop);
    const now = performance.now();
    const dt = Math.max(1, now - lastFrameTime);
    lastFrameTime = now;

    // 1. Run Active Physics Ribbons
    for (const tick of activePhysicsTick.values()) {
      tick();
    }

    // 2. Run scalar bursts (mode D pads)
    for (const [name, burst] of activeScalarBursts.entries()) {
      const event = Modes.tickBurstGesture(burst.state, { now });
      if (event) burst.render(event);
      if (!burst.state.burst || !burst.state.burst.active) {
        activeScalarBursts.delete(name);
      }
    }

    // 3. Run Active LFOs
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
        window.onControl && window.onControl({ name, value: 0 });
        continue;
      }

      let freqHz;
      if (syncMode === 'sync') {
        const subdiv = subdivisions[Math.floor(state.rate * (subdivisions.length - 0.01))];
        freqHz = (window.currentBpm / 60) / subdiv;
      } else {
        // Free mode: 0.1 Hz to 20 Hz
        freqHz = 0.1 + state.rate * 19.9;
      }
      
      state.phase += 2 * Math.PI * freqHz * (dt / 1000);
      
      const lfoVal = 0.5 + Math.sin(state.phase) * 0.5 * state.depth;
      state.value = lfoVal;

      // Update UI bar fill
      const el = document.querySelector(`.toggle[data-name="${name}"]`);
      if (el) {
        const fill = el.querySelector('.mod-val-bar');
        if (fill) fill.style.height = `${lfoVal * 100}%`;
      }
      
      // Emit to Ableton
      window.onControl && window.onControl({ name, value: lfoVal });
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
          el.style.removeProperty('background-color');
        }
        window.onControl && window.onControl({ name, value: 0 });
        continue;
      }

      let freqHz;
      if (syncMode === 'sync') {
        const subdiv = stutterSubdivs[Math.floor(state.rate * (stutterSubdivs.length - 0.01))];
        freqHz = (window.currentBpm / 60) / subdiv;
      } else {
        // Free mode: 1 Hz to 30 Hz
        freqHz = 1 + state.rate * 29;
      }
      
      const stutterVal = Math.floor(nowSec * freqHz * 2) % 2 === 0 ? 1 : 0;
      
      // Update UI pulse (opacity/color)
      const el = document.querySelector(`.button[data-name="${name}"]`);
      if (el) {
        el.style.backgroundColor = stutterVal > 0.5 ? 'rgba(255, 159, 10, 0.8)' : 'rgba(255, 159, 10, 0.08)';
      }

      // Emit to Ableton
      window.onControl && window.onControl({ name, value: stutterVal });
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

  // ---- Sync Mode UI ----
  function setupSyncModeUI() {
    const btn = document.getElementById('btn-sync-mode');
    if (!btn) return;
    btn.addEventListener('click', () => {
      syncMode = (syncMode === 'sync') ? 'free' : 'sync';
      btn.textContent = syncMode.toUpperCase();
      btn.className = `sync-mode-btn ${syncMode}`;
    });
  }

  // ---- Playhead Simulation UI ----
  function setupPlayheadUI() {
    const btn = document.getElementById('btn-play-sim');
    if (!btn) return;
    btn.addEventListener('click', () => {
      if (window.phoneWs && window.phoneWs.readyState === WebSocket.OPEN) {
        window.phoneWs.send(JSON.stringify({ type: 'toggle_play' }));
      } else {
        // Fallback for offline/development test
        window.playheadActive = !window.playheadActive;
        if (window.playheadActive) {
          window.playheadStartTime = Date.now();
        } else {
          window.playheadBaseTimeMs += (Date.now() - (window.playheadStartTime || Date.now()));
        }
        btn.textContent = window.playheadActive ? '||' : '▶';
        btn.classList.toggle('playing', window.playheadActive);
      }
    });
  }

  // ---- Snapshots & Vector Morphing System ----
  let snapshots = [null, null, null, null, null, null, null, null];
  let morphRafId = null;
  let morphMode = 'grid'; // 'grid' or 'vector'

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
      
      drawCorner(22, 22, '1', !!snapshots[0]);
      drawCorner(width - 22, 22, '2', !!snapshots[1]);
      drawCorner(22, height - 22, '3', !!snapshots[2]);
      drawCorner(width - 22, height - 22, '4', !!snapshots[3]);
      
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
      
      const keys = new Set();
      [snapshots[0], snapshots[1], snapshots[2], snapshots[3]].forEach(snap => {
        if (snap) {
          Object.keys(snap).forEach(k => keys.add(k));
        }
      });
      
      const getVal = (snap, key) => {
        if (snap && snap[key] !== undefined) return snap[key];
        return window.currentControlStates[key] !== undefined ? window.currentControlStates[key] : 0.5;
      };
      
      for (const key of keys) {
        const v = w1 * getVal(snapshots[0], key) +
                  w2 * getVal(snapshots[1], key) +
                  w3 * getVal(snapshots[2], key) +
                  w4 * getVal(snapshots[3], key);
                  
        if (window.controlSetters && typeof window.controlSetters[key] === 'function') {
          try {
            window.controlSetters[key](v);
          } catch (e) {}
        }
      }
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
      triggerHaptic('tap');
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

  function startLinearMorph(targetState, durationSec, onComplete) {
    if (morphRafId) {
      cancelAnimationFrame(morphRafId);
      morphRafId = null;
    }
    
    const duration = durationSec * 1000;
    const startTime = performance.now();
    const startStates = {};
    
    for (const key in targetState) {
      startStates[key] = window.currentControlStates[key] !== undefined 
        ? window.currentControlStates[key] 
        : targetState[key];
    }
    
    function tick(now) {
      const elapsed = now - startTime;
      const progress = clamp(elapsed / duration, 0, 1);
      
      for (const [key, targetVal] of Object.entries(targetState)) {
        const startVal = startStates[key];
        const val = startVal + (targetVal - startVal) * progress;
        
        if (window.controlSetters && typeof window.controlSetters[key] === 'function') {
          try {
            window.controlSetters[key](val);
          } catch (e) {}
        }
      }
      
      if (progress < 1) {
        morphRafId = requestAnimationFrame(tick);
      } else {
        morphRafId = null;
        if (onComplete) onComplete();
      }
    }
    morphRafId = requestAnimationFrame(tick);
  }

  function setupSnapshots() {
    try {
      const saved = localStorage.getItem('ableton-rc:snapshots');
      if (saved) {
        snapshots = JSON.parse(saved);
        if (!Array.isArray(snapshots) || snapshots.length !== 8) {
          snapshots = [null, null, null, null, null, null, null, null];
        }
      }
    } catch (e) {}
    
    const slots = document.querySelectorAll('.snapshot-slot');
    
    function updateSlotsUI() {
      slots.forEach((btn, idx) => {
        const snap = snapshots[idx];
        const isEmpty = !snap;
        btn.classList.toggle('empty', isEmpty);
        
        const label = btn.querySelector('.status-indicator');
        if (label) {
          label.textContent = isEmpty ? 'Vazio' : 'Salvo';
        }
      });
      window.dispatchEvent(new Event('ableton-rc:snapshots-updated'));
    }
    
    updateSlotsUI();
    
    let captureMode = false;
    const btnCapture = document.getElementById('btn-snapshot-capture');
    if (btnCapture) {
      btnCapture.addEventListener('click', () => {
        captureMode = !captureMode;
        btnCapture.classList.toggle('active', captureMode);
        triggerHaptic('toggle');
      });
    }
    
    const btnClear = document.getElementById('btn-snapshot-clear');
    if (btnClear) {
      btnClear.addEventListener('click', () => {
        if (confirm("Deseja realmente limpar todos os snapshots salvos?")) {
          snapshots = [null, null, null, null, null, null, null, null];
          try {
            localStorage.setItem('ableton-rc:snapshots', JSON.stringify(snapshots));
          } catch (e) {}
          updateSlotsUI();
          triggerHaptic('double');
          if (window.resetVectorPad) window.resetVectorPad();
        }
      });
    }
    
    const sliderTime = document.getElementById('slider-morph-time');
    const displayTime = document.getElementById('morph-time-val');
    let morphDurationSec = 1.0;
    if (sliderTime && displayTime) {
      sliderTime.addEventListener('input', () => {
        morphDurationSec = parseFloat(sliderTime.value) || 1.0;
        displayTime.textContent = morphDurationSec.toFixed(1) + 's';
      });
    }
    
    const modeBtns = document.querySelectorAll('[data-morph-mode]');
    const vectorContainer = document.getElementById('snp-vector-container');
    modeBtns.forEach(btn => {
      btn.addEventListener('click', () => {
        const mode = btn.dataset.morphMode;
        if (mode === morphMode) return;
        
        morphMode = mode;
        modeBtns.forEach(b => b.classList.toggle('on', b.dataset.morphMode === mode));
        if (vectorContainer) {
          vectorContainer.classList.toggle('hidden', mode !== 'vector');
        }
        triggerHaptic('toggle');
        window.dispatchEvent(new Event('resize'));
      });
    });
    
    slots.forEach((btn, idx) => {
      btn.addEventListener('click', () => {
        if (captureMode) {
          snapshots[idx] = JSON.parse(JSON.stringify(window.currentControlStates));
          try {
            localStorage.setItem('ableton-rc:snapshots', JSON.stringify(snapshots));
          } catch (e) {}
          updateSlotsUI();
          captureMode = false;
          if (btnCapture) btnCapture.classList.remove('active');
          triggerHaptic('tap');
        } else {
          const snap = snapshots[idx];
          if (!snap) return;
          slots.forEach(s => s.classList.remove('morphing'));
          btn.classList.add('morphing');
          triggerHaptic('tap');
          startLinearMorph(snap, morphDurationSec, () => {
            btn.classList.remove('morphing');
          });
        }
      });
    });
  }

  // ---- Wire up everything ----
  setupPadModeUI();
  setupTabs();
  setupSyncModeUI();
  setupPlayheadUI();
  setupVectorPad();
  setupSnapshots();
  
  document.querySelectorAll('.pad').forEach(makePad);
  document.querySelectorAll('.knob').forEach(makeKnob);
  document.querySelectorAll('.fader:not(.bipolar)').forEach(makeFader);
  document.querySelectorAll('.fader.bipolar').forEach(makeFader);
  
  // Custom Performance Expression Ribbons
  document.querySelectorAll('.ribbon-perf').forEach(makePhysicsRibbon);
  
  // Mixer Bipolar Ribbons (untouched)
  document.querySelectorAll('.ribbon').forEach(makeBipolarRibbon);
  
  document.querySelectorAll('.xy-pad').forEach(makeXYPad);
  
  // LFO & Stutters
  document.querySelectorAll('.toggle').forEach(makeLfoToggle);
  document.querySelectorAll('.button').forEach(makeStutterButton);
  
  // Physics XY Canvas
  document.querySelectorAll('.xy-pad-physics').forEach(setupXYPhysics);

  // Start the background animation loop for physics + modulators
  globalPhysicsLoop();

})();
