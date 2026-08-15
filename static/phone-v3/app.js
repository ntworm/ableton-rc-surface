// Copyright © 2026 Gabriel Worm
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Source: https://github.com/ntworm/ableton-rc-surface
//
// This file is part of Ableton RC Surface, distributed under the
// PolyForm Noncommercial License 1.0.0. You may obtain a copy of
// the License at https://polyformproject.org/licenses/noncommercial/1.0.0
// Phone-side WebSocket + sensor capture.
// Connects to /ws, sends resume first, then snapshots at 30Hz.
//
// v3: identical protocol to v2 (30Hz snapshot, same payload shape).
// Adds local-only sensor visibility panel + status text bindings.

(function () {
  'use strict';

  const TICK_MS = 33;          // ~30 Hz
  const PING_MS = 5000;        // heartbeat
  const HEARTBEAT_TIMEOUT_MS = 12000;
  const DEBUG_LEN = 240;       // single-line debug; truncate

  let calibration = { offsets: { alpha: 0, beta: 0, gamma: 0 }, shouldCalibrate: false };
  try {
    const saved = localStorage.getItem('ableton-rc:sensor_offsets');
    if (saved) {
      calibration.offsets = JSON.parse(saved);
    }
  } catch (e) {}

  // Per-sensor status tags + live readings + always-on diagnostic
  // (context, network). Status is the closed set from server/protocol.py.
  const state = {
    controls: [],
    touches: [],
    motion: null,
    orient: null,
    offsets: { matrix: null, active: false },
    calibration,
    sensors: {
      motion: 'unknown',
      orientation: 'unknown',
      audio: 'inactive',
      vision: 'inactive',
      audio_reading: null,
      vision_reading: null,
      motion_reading: null,
      orientation_reading: null,
      orientation_reading_raw: null,
      context: {
        secure_context: window.isSecureContext,
        scheme: window.location.protocol.replace(':', ''),
      },
      network: {
        online: navigator.onLine,
        type: null,
        downlink: null,
        rtt: null,
        save_data: null,
      },
    },
    // Local-only: per-sensor visibility (UI affordance; does NOT
    // affect the wire payload or names sent to the server).
    localToggles: {
      motion: true,
      orientation: true,
    },
    vision: {
      enabled: false,
      hand: { active: false, x: 0.5, y: 0.5, z: 0, fist: false, pinch: false, victory: false, open: false, rotateVal: 0.5, thumb: 0, index: 0, middle: 0, ring: 0, pinky: 0, fingers: 0, handLostTime: 0 }
    },
  };
  // Expor state globalmente para que mÃ³dulos carregados tardiamente
  // (ex: vision-processor) possam escrever mÃ©tricas de latÃªncia sem
  // precisar receber `state` por import circular. Leitura Ã© null-safe
  // nos consumidores.
  window.state = state;

  // Per-channel mode picker. Channels match the keys emitted on the wire
  // (without the `sensor.vision.{side}.` prefix). 'A' = momentary (default),
  // 'B' = hold last position when the hand drops, 'C' = toggle on rising edge.
  // Gesto channels only support A/C (B makes no semantic sense for a binary);
  // position channels (x/y/z) only support A/B (toggle-on-position is
  // disorienting). The defaults below match the buttons rendered in the HUD.
  state.visionModes = loadVisionModes();
  // Per-channel toggle latched state for mode C. Once the rising edge fires
  // the latch stays put until the next rising edge on the same channel,
  // independent of whether the hand is currently performing the gesture.
  state.visionToggle = { fist: 0, pinch: 0, victory: 0, open: 0 };
  // Per-channel previous-frame detection flags so each rising-edge
  // transition is detected independently. Reset on hand-loss so a hand
  // re-entering the frame always counts as a fresh rising edge.
  state.visionPrev = { fist: 0, pinch: 0, victory: 0, open: 0 };

  function loadVisionModes() {
    const defaults = { x: 'A', y: 'A', z: 'A', fist: 'A', pinch: 'A', victory: 'A', open: 'A' };
    try {
      const raw = localStorage.getItem('ableton-rc:vision_modes');
      if (!raw) return defaults;
      const parsed = JSON.parse(raw);
      // Merge so newly added channels default to 'A' instead of becoming undefined.
      return Object.assign({}, defaults, parsed);
    } catch {
      return defaults;
    }
  }

  function saveVisionModes() {
    try {
      localStorage.setItem('ableton-rc:vision_modes', JSON.stringify(state.visionModes));
    } catch {}
  }

  if (typeof window !== 'undefined' && typeof window.RCSurface?.setupWakeLock === 'function') {
    window.RCSurface.setupWakeLock();
  }

  async function requestWakeLock() {
    if (typeof window !== 'undefined' && typeof window.RCSurface?.requestWakeLock === 'function') {
      return await window.RCSurface.requestWakeLock();
    }
    return null;
  }

  function showToast(message, type = 'info') {
    if (typeof window !== 'undefined' && typeof window.showToast === 'function') {
      return window.showToast(message, type);
    }
    if (typeof window !== 'undefined' && typeof window.RCSurface?.showToast === 'function') {
      return window.RCSurface.showToast(message, type);
    }
    console.log(`[Toast] [${type}] ${message}`);
  }

  // Test-only hook: expose the state so Playwright tests can inject
  // realistic sensor readings without going through the real browser APIs.
  if (typeof window !== 'undefined') {
    window.__abletonRc = {
      state,
      requestWakeLock,
      calibrateHorizon,
    };
  }

  window.currentControlStates = {};

  window.currentControlLost = window.currentControlLost || {};
  window.onControl = (ctrl) => {
    if (ctrl.name) {
      // A `lost` control carries a placeholder, not a measurement. Writing it
      // into currentControlStates made the MAP curve read 0.00 while Live —
      // correctly honouring Safe loss = hold — kept the real value. Keep the
      // last true reading and record that the signal is gone, so the UI can
      // say so instead of drawing a number that is not happening.
      const lost = ctrl.lost === true;
      if (ctrl.x !== undefined && ctrl.y !== undefined) {
        window.currentControlLost[ctrl.name + '.x'] = lost;
        window.currentControlLost[ctrl.name + '.y'] = lost;
        if (!lost) {
          window.currentControlStates[ctrl.name + '.x'] = ctrl.x;
          window.currentControlStates[ctrl.name + '.y'] = ctrl.y;
        }
      } else if (ctrl.value !== undefined) {
        window.currentControlLost[ctrl.name] = lost;
        if (!lost) window.currentControlStates[ctrl.name] = ctrl.value;
      }
    }
    const idx = state.controls.findIndex(c => c.name === ctrl.name);
    if (idx >= 0) state.controls[idx] = ctrl;
    else state.controls.push(ctrl);
  };

  window.onModulatorState = (modulator) => {
    sendImmediateModulatorState(modulator);
  };

  const pointerPressures = new Map();
  if (typeof window !== 'undefined') {
    window.addEventListener('pointerdown', (e) => {
      if (e.pointerType === 'touch' || e.pointerType === 'pen') {
        pointerPressures.set(e.pointerId, e.pressure);
      }
    }, { passive: true });
    window.addEventListener('pointermove', (e) => {
      if (e.pointerType === 'touch' || e.pointerType === 'pen') {
        pointerPressures.set(e.pointerId, e.pressure);
      }
    }, { passive: true });
    window.addEventListener('pointerup', (e) => {
      pointerPressures.delete(e.pointerId);
    }, { passive: true });
    window.addEventListener('pointercancel', (e) => {
      pointerPressures.delete(e.pointerId);
    }, { passive: true });
  }

  // ---- Touch capture (unchanged from v2) ----
  const touchHandler = (e) => {
    state.touches = [];
    for (let i = 0; i < e.touches.length; i++) {
      const t = e.touches[i];
      state.touches.push({
        id: t.identifier,
        x: t.clientX / window.innerWidth,
        y: t.clientY / window.innerHeight,
        force: t.force || pointerPressures.get(t.identifier) || null,
      });
    }
  };
  document.addEventListener('touchstart', touchHandler, { passive: true });
  document.addEventListener('touchmove', touchHandler, { passive: true });
  document.addEventListener('touchend', touchHandler, { passive: true });
  document.addEventListener('touchcancel', touchHandler, { passive: true });

  function eventTimeMs(e) {
    if (e && typeof e.timeStamp === 'number' && Number.isFinite(e.timeStamp)) return e.timeStamp;
    if (typeof performance !== 'undefined' && typeof performance.now === 'function') return performance.now();
    return Date.now();
  }

  function resetMotionStabilization() {
    // no-op
  }

  // ---- Motion (unchanged from v2) ----
  function attachMotion() {
    if (typeof DeviceMotionEvent === 'undefined') {
      state.sensors.motion = 'unavailable';
      return;
    }
    let gotReading = false;
    try {
      window.addEventListener('devicemotion', (e) => {
        gotReading = true;
        if (state.sensors.motion !== 'available') state.sensors.motion = 'available';
        const a = e.accelerationIncludingGravity || {};
        const r = e.rotationRate || {};
        const axis = (v) => (v === null || v === undefined) ? null : v;
        const accel = e.acceleration;
        const buildVec = (src) => {
          if (!src) return null;
          const x = axis(src.x), y = axis(src.y), z = axis(src.z);
          if (x === null && y === null && z === null) return null;
          return { x, y, z };
        };

        state.motion = {
          ax: axis(a.x),
          ay: axis(a.y),
          az: axis(a.z),
          gx: axis(r.alpha),
          gy: axis(r.beta),
          gz: axis(r.gamma),
          interval: axis(e.interval),
        };

        state.sensors.motion_reading = {
          acceleration: buildVec(accel),
          acceleration_including_gravity: buildVec(a),
          rotation_rate: buildVec(r),
          interval: axis(e.interval),
        };
      });
    } catch (err) {
      state.sensors.motion = 'unavailable';
      return;
    }
    setTimeout(() => {
      if (!gotReading && state.sensors.motion === 'unknown') {
        state.sensors.motion = 'permission-denied';
      }
    }, 2000);
  }

  function deviceOrientationToRotationMatrix(alpha, beta, gamma) {
    const d2r = Math.PI / 180;
    const a = (alpha || 0) * d2r;
    const b = (beta || 0) * d2r;
    const g = (gamma || 0) * d2r;

    const ca = Math.cos(a), sa = Math.sin(a);
    const cb = Math.cos(b), sb = Math.sin(b);
    const cg = Math.cos(g), sg = Math.sin(g);

    // R = Rz(a) * Rx(b) * Ry(g)
    const r00 = ca * cg - sa * sb * sg;
    const r01 = -sa * cb;
    const r02 = ca * sg + sa * sb * cg;

    const r10 = sa * cg + ca * sb * sg;
    const r11 = ca * cb;
    const r12 = sa * sg - ca * sb * cg;

    const r20 = -cb * sg;
    const r21 = sb;
    const r22 = cb * cg;

    return [
      [r00, r01, r02],
      [r10, r11, r12],
      [r20, r21, r22]
    ];
  }

  function getScreenMatrix(alpha, beta, gamma, angle) {
    const R = deviceOrientationToRotationMatrix(alpha, beta, gamma);
    const dx = [R[0][0], R[1][0], R[2][0]];
    const dy = [R[0][1], R[1][1], R[2][1]];
    const dz = [R[0][2], R[1][2], R[2][2]];

    let ux, uy, uz;
    if (angle === 90) {
      ux = [-dy[0], -dy[1], -dy[2]];
      uy = [dx[0], dx[1], dx[2]];
      uz = [dz[0], dz[1], dz[2]];
    } else if (angle === -90 || angle === 270) {
      ux = [dy[0], dy[1], dy[2]];
      uy = [-dx[0], -dx[1], -dx[2]];
      uz = [dz[0], dz[1], dz[2]];
    } else {
      ux = [dx[0], dx[1], dx[2]];
      uy = [dy[0], dy[1], dy[2]];
      uz = [dz[0], dz[1], dz[2]];
    }

    return [
      [ux[0], uy[0], uz[0]],
      [ux[1], uy[1], uz[1]],
      [ux[2], uy[2], uz[2]]
    ];
  }

  function transpose(M) {
    return [
      [M[0][0], M[1][0], M[2][0]],
      [M[0][1], M[1][1], M[2][1]],
      [M[0][2], M[1][2], M[2][2]]
    ];
  }

  function multiply(A, B) {
    const C = [
      [0, 0, 0],
      [0, 0, 0],
      [0, 0, 0]
    ];
    for (let i = 0; i < 3; i++) {
      for (let j = 0; j < 3; j++) {
        C[i][j] = A[i][0]*B[0][j] + A[i][1]*B[1][j] + A[i][2]*B[2][j];
      }
    }
    return C;
  }

  function extractEulerAngles(R_rel) {
    const r2r = 180 / Math.PI;
    const sinBeta = -R_rel[1][2];
    const beta = Math.asin(Math.max(-1, Math.min(1, sinBeta))) * r2r;

    let alpha, gamma;
    if (Math.abs(sinBeta) < 0.9999) {
      alpha = Math.atan2(R_rel[0][2], R_rel[2][2]) * r2r;
      gamma = Math.atan2(R_rel[1][0], R_rel[1][1]) * r2r;
    } else {
      gamma = 0;
      alpha = Math.atan2(R_rel[0][1], R_rel[0][0]) * r2r;
    }
    return { alpha, beta, gamma };
  }

  // ---- Orientation (calibrated & wrap-safe) ----
  function attachOrientation() {
    if (typeof DeviceOrientationEvent === 'undefined') {
      state.sensors.orientation = 'unavailable';
      return;
    }
    let gotReading = false;
    try {
      window.addEventListener('deviceorientation', (e) => {
        gotReading = true;
        if (state.sensors.orientation !== 'available') state.sensors.orientation = 'available';
        const axis = (v) => (v === null || v === undefined) ? null : v;

        const rawAlpha = axis(e.alpha);
        const rawBeta = axis(e.beta);
        const rawGamma = axis(e.gamma);

        if (rawAlpha === null || rawBeta === null || rawGamma === null) {
          return;
        }

        let beta = rawBeta;
        let gamma = rawGamma;
        let isAccelDerived = false;

        if (state.motion && typeof state.motion.ax === 'number' && typeof state.motion.ay === 'number' && typeof state.motion.az === 'number') {
          isAccelDerived = true;
          let angle = 0;
          if (typeof window !== 'undefined') {
            if (window.orientation !== undefined) angle = window.orientation;
            else if (window.screen && window.screen.orientation) angle = window.screen.orientation.angle;
          }

          if (angle === 90 || angle === -90 || angle === 270) {
            if (angle === 90) {
              beta = -state.motion.az * 9.18;
              gamma = state.motion.ay * 18.36;
            } else {
              beta = state.motion.az * 9.18;
              gamma = -state.motion.ay * 18.36;
            }
          } else {
            beta = -state.motion.az * 9.18;
            gamma = state.motion.ax * 18.36;
          }

          beta = Math.max(-90, Math.min(90, beta));
          gamma = Math.max(-180, Math.min(180, gamma));
        }

        const R = deviceOrientationToRotationMatrix(rawAlpha, rawBeta, rawGamma);
        let alpha = (Math.atan2(R[1][1], R[0][1]) * 180 / Math.PI - 90 + 360) % 360;
        alpha = Math.round(alpha * 10000) / 10000;
        alpha = (360 - alpha) % 360;

        if (state.calibration.shouldCalibrate) {
          state.calibration.offsets = {
            alpha: alpha,
            beta: beta,
            gamma: gamma
          };
          try {
            localStorage.setItem('ableton-rc:sensor_offsets', JSON.stringify(state.calibration.offsets));
          } catch (err) {}
          state.calibration.shouldCalibrate = false;
        }

        const hasOffset = state.calibration && (
          state.calibration.offsets.alpha !== 0 ||
          state.calibration.offsets.beta !== 0 ||
          state.calibration.offsets.gamma !== 0
        );

        if (hasOffset) {
          alpha = (alpha - state.calibration.offsets.alpha + 180 + 360) % 360;
          beta = beta - state.calibration.offsets.beta;
          gamma = gamma - state.calibration.offsets.gamma;
        }

        state.orient = {
          alpha,
          beta,
          gamma,
        };
        state.sensors.orientation_reading = {
          alpha,
          beta,
          gamma,
          absolute: axis(e.absolute),
        };

        const bubble = document.getElementById('level-bubble');
        if (bubble) {
          const pitch = Math.max(-45, Math.min(45, beta));
          const roll = Math.max(-45, Math.min(45, gamma));
          const tx = (roll / 45) * 50;
          const ty = (pitch / 45) * 50; 
          bubble.style.transform = `translate(${tx.toFixed(1)}px, ${ty.toFixed(1)}px)`;
        }
      });
    } catch (err) {
      state.sensors.orientation = 'unavailable';
      return;
    }
    setTimeout(() => {
      if (!gotReading && state.sensors.orientation === 'unknown') {
        state.sensors.orientation = 'permission-denied';
      }
    }, 2000);
  }

  // ---- Network ----
  function attachNetwork() {
    const conn = navigator.connection || navigator.mozConnection || navigator.webkitConnection;
    const update = () => {
      if (conn) {
        state.sensors.network = {
          online: navigator.onLine,
          type: conn.effectiveType || null,
          downlink: conn.downlink ?? null,
          rtt: conn.rtt ?? null,
          save_data: conn.saveData ?? null,
        };
      } else {
        state.sensors.network = {
          online: navigator.onLine,
          type: null,
          downlink: null,
          rtt: null,
          save_data: null,
        };
      }
    };
    if (conn) conn.addEventListener('change', update);
    // Network online/offline is now handled by session.js via initSession().
    // We only need to update the local state.sensors.network here.
    window.addEventListener('online', () => { state.sensors.network.online = true; });
    window.addEventListener('offline', () => { state.sensors.network.online = false; });
    update();
  }

  // ---- Permission UX (iOS 13+ requires a user gesture) ----
  function maybeRequestPermissions() {
    const needsRequest = typeof DeviceMotionEvent !== 'undefined'
      && typeof DeviceMotionEvent.requestPermission === 'function';
    if (needsRequest) {
      const banner = document.getElementById('permission-banner');
      const btn = document.getElementById('permission-activate');
      banner.classList.remove('hidden');
      btn.addEventListener('click', async () => {
        try {
          const r1 = await DeviceMotionEvent.requestPermission();
          const r2 = await DeviceOrientationEvent.requestPermission();
          if (r1 === 'granted') attachMotion();
          else state.sensors.motion = 'permission-denied';
          if (r2 === 'granted') attachOrientation();
          else state.sensors.orientation = 'permission-denied';
        } catch (e) {
          state.sensors.motion = 'unavailable';
          state.sensors.orientation = 'unavailable';
        }
        banner.classList.add('hidden');
      }, { once: true });
    } else {
      attachMotion();
      attachOrientation();
    }
    attachNetwork();
  }

  // ---- Modulator immediate send (uses session.js WS) ----
  function isImmediateModulatorState(modulator) {
    if (!modulator || typeof modulator !== 'object') return false;
    if (modulator.kind !== 'lfo' && modulator.kind !== 'stutter') return false;
    if (typeof modulator.name !== 'string') return false;
    if (modulator.kind === 'lfo' && !/^toggle-\d+$/.test(modulator.name)) return false;
    if (modulator.kind === 'stutter' && !/^button-\d+$/.test(modulator.name)) return false;
    return true;
  }

  function sendImmediateModulatorState(modulator) {
    if (!isImmediateModulatorState(modulator)) return;
    const _ws = window.phoneWs;
    const _clientId = window.getPhoneClientId ? window.getPhoneClientId() : null;
    if (!_ws || _ws.readyState !== WebSocket.OPEN || !_clientId) return;
    const allowedClockSources = new Set(['osc', 'sdk', 'free']);
    const allowedLfoShapes = new Set(['sine', 'triangle', 'ramp_up', 'ramp_down', 'square']);
    const payload = {
      kind: modulator.kind,
      name: modulator.name,
      active: !!modulator.active,
      rate: typeof modulator.rate === 'number' ? modulator.rate : undefined,
      depth: typeof modulator.depth === 'number' ? modulator.depth : undefined,
      count: typeof modulator.count === 'number' ? modulator.count : undefined,
      morphMs: typeof modulator.morphMs === 'number' ? modulator.morphMs : undefined,
      syncMode: modulator.syncMode === 'free' ? 'free' : 'sync',
      clockSource: allowedClockSources.has(modulator.clockSource) ? modulator.clockSource : undefined,
      syncSubdivisionBeats: typeof modulator.syncSubdivisionBeats === 'number' ? modulator.syncSubdivisionBeats : undefined,
      phaseOffsetBeats: typeof modulator.phaseOffsetBeats === 'number' ? modulator.phaseOffsetBeats : undefined,
      shape: modulator.kind === 'lfo' && allowedLfoShapes.has(modulator.shape) ? modulator.shape : undefined,
      swing: modulator.kind === 'stutter' && typeof modulator.swing === 'number' ? modulator.swing : undefined,
    };
    _ws.send(JSON.stringify({
      type: 'modulator',
      client_id: _clientId,
      ts: Date.now(),
      modulator: payload,
    }));
  }

  // ---- Client name editor (uses session.js APIs) ----
  function setupClientName() {
    const el = document.getElementById('status');
    if (!el) return;
    el.addEventListener('click', () => {
      const current = localStorage.getItem('ableton-rc:display_name') || '';
      const newName = prompt('Client name (display):', current);
      if (newName === null) return;
      const trimmed = newName.trim();
      const _ws = window.phoneWs;
      const _clientId = window.getPhoneClientId ? window.getPhoneClientId() : null;
      const _setStatus = window.RCSurface?._setStatus;
      if (trimmed) {
        localStorage.setItem('ableton-rc:display_name', trimmed);
        if (typeof _setStatus === 'function') _setStatus(`\u26A1 ${trimmed}`, 'connected');
        if (_ws && _ws.readyState === WebSocket.OPEN && _clientId) {
          _ws.send(JSON.stringify({ type: 'set_display_name', client_id: _clientId, display_name: trimmed }));
        }
      } else {
        localStorage.removeItem('ableton-rc:display_name');
        if (typeof _setStatus === 'function') _setStatus(`\u26A1 ${_clientId ? _clientId.slice(0, 8) : ''}`, 'connected');
        if (_ws && _ws.readyState === WebSocket.OPEN && _clientId) {
          _ws.send(JSON.stringify({ type: 'set_display_name', client_id: _clientId, display_name: '' }));
        }
      }
    });
  }

  // Emit orient/motion sensor values as mapping controls. Called from both
  // the rAF loop (display-synced, 60/90/120Hz when tab visible) and the
  // 30Hz setInterval (always-on fallback). The admin/mappings page surfaces
  // these as mappable targets; without this emission the orient and motion
  // values reach the wire but never become user-bindable controls.
  function emitSensorControls() {
    if (typeof window.onControl !== 'function') return;

    const o = state.orient;
    if (o && typeof o.alpha === 'number') {
      window.onControl({ name: 'sensor.orient.alpha', value: Math.max(0, Math.min(360, o.alpha)) / 360 });
      window.onControl({ name: 'sensor.orient.beta',  value: (Math.max(-90, Math.min(90, o.beta)) + 90) / 180 });
      window.onControl({ name: 'sensor.orient.gamma', value: (Math.max(-180, Math.min(180, o.gamma)) + 180) / 360 });
    }

    const m = state.motion;
    if (m) {
      if (typeof m.ax === 'number') window.onControl({ name: 'sensor.motion.ax', value: (Math.max(-20, Math.min(20, m.ax)) + 20) / 40 });
      if (typeof m.ay === 'number') window.onControl({ name: 'sensor.motion.ay', value: (Math.max(-20, Math.min(20, m.ay)) + 20) / 40 });
      if (typeof m.az === 'number') window.onControl({ name: 'sensor.motion.az', value: (Math.max(-20, Math.min(20, m.az)) + 20) / 40 });
      if (typeof m.gx === 'number') window.onControl({ name: 'sensor.motion.gx', value: (Math.max(-360, Math.min(360, m.gx)) + 360) / 720 });
      if (typeof m.gy === 'number') window.onControl({ name: 'sensor.motion.gy', value: (Math.max(-360, Math.min(360, m.gy)) + 360) / 720 });
      if (typeof m.gz === 'number') window.onControl({ name: 'sensor.motion.gz', value: (Math.max(-360, Math.min(360, m.gz)) + 360) / 720 });
    }
  }

  /**
   * Move controls to values that came from the server — either the initial
   * state in `hello`, or another performer's move arriving as `control_sync`.
   *
   * Momentary controls are skipped in the modes where they are momentary: in A
   * and D a pad, LFO toggle or stutter button is held, not latched, so driving
   * one from a message would fire a trigger nobody's finger asked for.
   *
   * Modulator emission is suppressed for the duration: an LFO's configuration
   * belongs to the host, and re-announcing it from here would have this phone's
   * local rate and depth overwrite what the other performer just set.
   */
  function applyRemoteControlValues(values) {
    if (!values || typeof values !== 'object') return;
    if (!window.controlSetters) return;
    const currentMode = document.body.dataset.padMode || 'A';
    const momentaryMode = currentMode === 'A' || currentMode === 'D';

    const apply = () => {
      for (const [k, v] of Object.entries(values)) {
        if (typeof window.controlSetters[k] !== 'function') continue;
        if (momentaryMode && /^(?:pad|toggle|button)-/.test(k)) continue;
        try {
          window.controlSetters[k](v);
          const ctrlEl = document.querySelector(`[data-name="${k}"]`);
          if (ctrlEl) {
            ctrlEl.dataset.active = 'true';
            if (ctrlEl._activeTimeout) clearTimeout(ctrlEl._activeTimeout);
            ctrlEl._activeTimeout = setTimeout(() => { ctrlEl.dataset.active = 'false'; }, 200);
          }
        } catch (err) {}
      }
    };

    if (typeof window.withModulatorEmitSuppressed === 'function') {
      window.withModulatorEmitSuppressed(apply);
    } else {
      apply();
    }
  }
  window.applyRemoteControlValues = applyRemoteControlValues;

  // Snapshot throttle state (was previously in the WS block, now local to this module)
  let lastSnapshotSentAt = 0;

  function sendLoop() {
    setInterval(() => {
      // Smooth-decay the hand's x/y/z back to neutral (0.5, 0.5, 0) over
      // 300ms once it stops being detected.
      // Mode B (hold) freezes the position per-axis so the performer's last
      // hand pose stays mapped until they re-enter the frame.
      if (state.vision && state.vision.enabled) {
        const h = state.vision.hand;
        if (h && !h.active) {
          // No spatial tracking, so no x/y/z to decay: just zero the
          // remaining discrete channels and let the wire stay quiet.
          h.fist = false;
          h.pinch = false;
          h.victory = false;
          h.open = false;
          h.rotateVal = 0.5;
          h.thumb = 0;
          h.index = 0;
          h.middle = 0;
          h.ring = 0;
          h.pinky = 0;
          h.fingers = 0;

          if (state.sensors.vision_reading) {
            const r = state.sensors.vision_reading;
            r.fist = false;
            r.pinch = false;
            r.victory = false;
            r.open = false;
            r.rotateVal = 0.5;
            r.thumb = 0;
            r.index = 0;
            r.middle = 0;
            r.ring = 0;
            r.pinky = 0;
            r.fingers = 0;
          }

          if (window.onControl) {
            for (const detector of ['fist', 'pinch', 'victory', 'open', 'fingers']) {
              if (isVisionDetectorEnabled(detector)) {
                window.onControl({ name: `sensor.vision.${detector}`, value: 0 });
              }
            }
            // Anchor rotateVal at the neutral 0.5 mark while the hand is
            // absent so the panel-mapped parameter doesn't drift.
            if (isVisionDetectorEnabled('victory')) {
              window.onControl({ name: 'sensor.vision.rotateVal', value: 0.5 });
            }
          }
        }

        // Update HUD for the single tracked hand
        const lblGesture = document.getElementById('lbl-vision-gesture');
        if (lblGesture) lblGesture.textContent = getVisionGestureLabel(state.vision.hand);
        renderVisionReadouts();
      }

      // Orient + motion emit (rAF drives these at display rate normally;
      // this is the always-on fallback so background tabs and slow displays
      // still see fresh values).
      emitSensorControls();

      const now = Date.now();
      const throttleActive = window.RCSurface.getMappingModeActive() || window.RCSurface.getTelemetryThrottleUntil() > now;
      const minSnapshotInterval = throttleActive ? 500 : TICK_MS;
      if (now - lastSnapshotSentAt < minSnapshotInterval) return;
      lastSnapshotSentAt = now;

      const _ws = window.phoneWs;
      const _clientId = window.getPhoneClientId ? window.getPhoneClientId() : null;
      if (_ws && _ws.readyState === WebSocket.OPEN && _clientId) {
        const msg = {
          type: 'snapshot',
          client_id: _clientId,
          display_name: localStorage.getItem('ableton-rc:display_name') || undefined,
          ts: Date.now(),
          data: {
            controls: state.controls,
            touches: state.touches,
            motion: state.motion,
            orient: state.orient,
            sensors: state.sensors,
            network: state.sensors.network,
          },
        };
        _ws.send(JSON.stringify(msg));
        renderDebug(msg.data);
        renderSensorReadout();
      }
    }, TICK_MS);

    // Display-synced sensor emit for performance: rAF runs at the display's
    // native rate (60/90/120Hz). When the tab is visible the orient/motion
    // controls arrive at that rate â€” minimum-latency feel. The setInterval
    // above is the always-on fallback when rAF is throttled, unavailable
    // (node test env), or the tab is hidden.
    if (typeof requestAnimationFrame === 'function') {
      let lastFpsMeasureTime = performance.now();
      let frameCount = 0;
      function rafEmit() {
        emitSensorControls();
        
        frameCount++;
        const now = performance.now();
        if (now - lastFpsMeasureTime >= 1000) {
          const fps = Math.round((frameCount * 1000) / (now - lastFpsMeasureTime));
          state.sensors.network.fps = fps;
          frameCount = 0;
          lastFpsMeasureTime = now;
        }
        
        requestAnimationFrame(rafEmit);
      }
      requestAnimationFrame(rafEmit);
    }

    // Heartbeat ping is now handled by modules/session.js
  }

  function fmtVec(v, decimals = 1) {
    if (!v) return '-';
    return `${v.x.toFixed(decimals)}/${v.y.toFixed(decimals)}/${v.z.toFixed(decimals)}`;
  }
  function fmtNum(n, decimals = 0) {
    if (n === null || n === undefined || Number.isNaN(n)) return '-';
    return n.toFixed(decimals);
  }

  function setSensorVisual(key, value) {
    const finite = typeof value === 'number' && Number.isFinite(value);
    const motionRange = key && key.startsWith('aig.') ? 20 : 1;

    document.querySelectorAll(`[data-sensor-bar="${key}"]`).forEach((bar) => {
      const card = bar.closest('.sensor-axis-card');
      if (!finite) {
        bar.style.setProperty('--sensor-level', '0');
        bar.classList.remove('neg');
        if (card) card.classList.remove('active');
        return;
      }
      const level = Math.min(1, Math.abs(value) / motionRange);
      bar.style.setProperty('--sensor-level', level.toFixed(3));
      bar.classList.toggle('neg', value < 0);
      if (card) card.classList.toggle('active', level > 0.02);
    });

    document.querySelectorAll(`[data-sensor-orbit="${key}"]`).forEach((orbit) => {
      const card = orbit.closest('.sensor-axis-card');
      if (!finite) {
        orbit.style.setProperty('--sensor-angle', '0deg');
        orbit.classList.remove('active');
        if (card) card.classList.remove('active');
        return;
      }
      let angle = value;
      if (key === 'ori.alpha') angle = ((value % 360) + 360) % 360;
      orbit.style.setProperty('--sensor-angle', `${angle.toFixed(1)}deg`);
      orbit.classList.add('active');
      if (card) card.classList.add('active');
    });
  }

  function renderDebug(d) {
    const s = d.sensors || {};
    const ctx = s.context || {};
    const net = s.network || {};
    const mR = s.motion_reading || null;
    const oR = s.orientation_reading || null;

    const aig = mR && mR.acceleration_including_gravity;
    const rot = mR && mR.rotation_rate;
    const intervalSeg = (mR && mR.interval !== null && mR.interval !== undefined)
      ? ` Î”${fmtNum(mR.interval, 0)}ms` : '';
    const mSeg = aig
      ? `ax:${fmtNum(aig.x, 1)} ay:${fmtNum(aig.y, 1)} az:${fmtNum(aig.z, 1)}`
        + (rot ? ` rot:${fmtVec(rot, 1)}` : '') + intervalSeg
      : '-';
    const oSeg = oR
      ? `${fmtNum(oR.alpha, 0)}/${fmtNum(oR.beta, 0)}/${fmtNum(oR.gamma, 0)}`
      : '-';
    const ctxSeg = `ctx:${ctx.secure_context ? 'secure' : 'http'} ${ctx.scheme || ''}`.trim();
    const netType = net.online ? (net.type || 'on') : 'off';
    const netSeg = `net:${netType}${net.downlink ? ` ${net.downlink}Mb` : ''}${net.rtt ? ` ${net.rtt}ms` : ''}`;
    const tSeg = d.touches && d.touches.length > 0 ? `t:${d.touches.length}` : 't:-';

    const line = `m:${s.motion || '?'} ${mSeg} | ori:${s.orientation || '?'} ${oSeg} | ${tSeg} | ${ctxSeg} | ${netSeg}`;
    const el = document.getElementById('debug');
    if (!el) return;
    el.textContent = line.length > DEBUG_LEN ? line.slice(0, DEBUG_LEN - 1) + 'â€¦' : line;
  }

  // ---- Sensor readout on Sensors page ----
  function renderSensorReadout() {
    const m = state.sensors.motion_reading;
    const o = state.sensors.orientation_reading;

    function setVal(sel, v, decimals = 2) {
      const el = document.querySelector(sel);
      if (!el) return;
      el.textContent = (v === null || v === undefined || Number.isNaN(v)) ? '-' : v.toFixed(decimals);
      const key = el.dataset && el.dataset.sensorVal;
      if (key) setSensorVisual(key, v);
    }

    if (m) {
      // ACCEL (aig) is what we use for the row
      const aig = m.acceleration_including_gravity || { x: null, y: null, z: null };
      setVal('[data-sensor-val="aig.x"]', aig.x);
      setVal('[data-sensor-val="aig.y"]', aig.y);
      setVal('[data-sensor-val="aig.z"]', aig.z);
      // AIG (g-force) shows acceleration (no gravity) when available
      const a = m.acceleration || { x: null, y: null, z: null };
      setVal('[data-sensor-val="aig.x2"]', a.x);
      setVal('[data-sensor-val="aig.y2"]', a.y);
      setVal('[data-sensor-val="aig.z2"]', a.z);
    } else {
      ['aig.x', 'aig.y', 'aig.z', 'aig.x2', 'aig.y2', 'aig.z2'].forEach((k) => {
        setVal(`[data-sensor-val="${k}"]`, null);
      });
    }
    if (o) {
      setVal('[data-sensor-val="ori.alpha"]', o.alpha, 0);
      setVal('[data-sensor-val="ori.beta"]', o.beta, 0);
      setVal('[data-sensor-val="ori.gamma"]', o.gamma, 0);
    } else {
      ['ori.alpha', 'ori.beta', 'ori.gamma'].forEach((k) => {
        setVal(`[data-sensor-val="${k}"]`, null);
      });
    }

    // Status hints
    const motionStatus = document.querySelector('[data-sensor-status="motion"]');
    if (motionStatus) motionStatus.textContent = state.sensors.motion || '-';
    const orientStatus = document.querySelector('[data-sensor-status="orientation"]');
    if (orientStatus) orientStatus.textContent = state.sensors.orientation || '-';
  }

  // ---- Local sensor visibility toggles (no server effect) ----
  function setupSensorToggles() {
    document.querySelectorAll('[data-sensor-enable]').forEach((el) => {
      el.addEventListener('change', () => {
        const key = el.dataset.sensorEnable;
        state.localToggles[key] = el.checked;
      });
    });
  }

  function updateCalibrationButtons() {
    const resetBtn = document.getElementById('btn-reset-orientation');
    if (!resetBtn) return;
    const hasOffset = state.calibration && (
      state.calibration.offsets.alpha !== 0 ||
      state.calibration.offsets.beta !== 0 ||
      state.calibration.offsets.gamma !== 0
    );
    if (hasOffset) {
      resetBtn.classList.remove('hidden');
    } else {
      resetBtn.classList.add('hidden');
    }
  }

  function calibrateHorizon() {
    state.calibration.shouldCalibrate = true;

    updateDenoiseStatus('calibrating');
    setTimeout(() => {
      updateDenoiseStatus('calibrated');
    }, 600);

    const statusEl = document.getElementById('calib-status');
    if (statusEl) {
      statusEl.textContent = 'Auto-Calibrado!';
      statusEl.style.color = 'var(--ok)';
      setTimeout(() => {
        if (statusEl) {
          statusEl.textContent = 'Estabilize para auto-calibrar';
          statusEl.style.color = '';
        }
      }, 1500);
    }

  }

  function setupCalibration() {
    const zeroBtn = document.getElementById('btn-zero-orientation');
    const zeroPerfBtn = document.getElementById('btn-zero-orientation-perf');
    const resetBtn = document.getElementById('btn-reset-orientation');
    if (!zeroBtn || !resetBtn) return;

    updateCalibrationButtons();

    zeroBtn.addEventListener('click', calibrateHorizon);
    if (zeroPerfBtn) {
      zeroPerfBtn.addEventListener('click', calibrateHorizon);
    }

    resetBtn.addEventListener('click', () => {
      state.calibration.offsets = { alpha: 0, beta: 0, gamma: 0 };
      try {
        localStorage.removeItem('ableton-rc:sensor_offsets');
      } catch (e) {}
      updateCalibrationButtons();
    });
  }

  // ---- Adaptive sensor denoise UI ----
  function updateDenoiseStatus(phase) {
    const el = document.getElementById('denoise-status');
    const headerBtn = document.getElementById('btn-calibrate-sensors-header');

    if (el) {
      if (phase === 'calibrating') {
        el.textContent = 'Calibratingâ€¦';
        el.style.color = 'var(--accent)';
      } else if (phase === 'calibrated') {
        el.textContent = 'Calibrated âœ“';
        el.style.color = 'var(--ok)';
      } else {
        el.textContent = 'Not calibrated';
        el.style.color = '';
      }
    }

    if (headerBtn) {
      if (phase === 'calibrating') {
        headerBtn.textContent = 'CALIBRATINGâ€¦';
        headerBtn.style.borderColor = 'var(--accent)';
        headerBtn.style.color = 'var(--accent)';
        headerBtn.style.background = 'rgba(255, 159, 10, 0.12)';
        headerBtn.style.boxShadow = '0 0 8px rgba(255, 159, 10, 0.35)';
      } else if (phase === 'calibrated') {
        headerBtn.textContent = 'CALIBRATED';
        headerBtn.style.borderColor = 'var(--ok)';
        headerBtn.style.color = 'var(--ok)';
        headerBtn.style.background = 'rgba(48, 209, 88, 0.12)';
        headerBtn.style.boxShadow = '0 0 8px rgba(48, 209, 88, 0.35)';
      } else {
        headerBtn.textContent = 'CALIBRATE';
        headerBtn.style.borderColor = '';
        headerBtn.style.color = '';
        headerBtn.style.background = '';
        headerBtn.style.boxShadow = '';
      }
    }
  }

  function setupSensorDenoise() {
    const btn = document.getElementById('btn-calibrate-sensors');
    const headerBtn = document.getElementById('btn-calibrate-sensors-header');

    if (btn) btn.addEventListener('click', calibrateHorizon);
    if (headerBtn) headerBtn.addEventListener('click', calibrateHorizon);
  }



  function setupAudioUI() {
    const chk = document.getElementById('chk-audio-enable');
    const lblPitch = document.getElementById('lbl-audio-pitch');
    const lblNote = document.getElementById('lbl-audio-note');
    const lblBpm = document.getElementById('lbl-audio-bpm');
    const lblRms = document.getElementById('lbl-audio-rms');
    const lblEnvelope = document.getElementById('lbl-audio-envelope');
    const lblClarity = document.getElementById('lbl-audio-clarity');
    const lblGate = document.getElementById('lbl-audio-gate');
    const lblBend = document.getElementById('lbl-audio-bend');
    const barRms = document.getElementById('bar-audio-rms');

    // Emit the audio channels at zero BEFORE the user enables the mic so
    // the admin/mappings page sees them as available mapping targets. The
    // status (state.sensors.audio) carries "inactive" until the user
    // toggles the checkbox, but the controls themselves are bound and
    // updating â€” the user can map sensor.audio.pitch to a Live parameter
    // and the mapping will start working the moment they enable the mic.
    // `lost: true` because there is no microphone reading yet — the channel is
    // being registered, not measured. Without the flag a page reload would
    // slam every audio-mapped parameter to these placeholders, ignoring the
    // target's Safe loss policy.
    if (window.onControl) {
      window.onControl({ name: 'sensor.audio.rms',            value: 0,   lost: true });
      window.onControl({ name: 'sensor.audio.pitch',          value: 0,   lost: true });
      window.onControl({ name: 'sensor.audio.bpm',            value: 0,   lost: true });
      window.onControl({ name: 'sensor.audio.note',           value: 0,   lost: true });
      window.onControl({ name: 'sensor.audio.clarity',        value: 0,   lost: true });
      window.onControl({ name: 'sensor.audio.whistle.bend',   value: 0.5, lost: true });
      window.onControl({ name: 'sensor.audio.envelope',       value: 0,   lost: true });
      window.onControl({ name: 'sensor.audio.gate',           value: 0,   lost: true });
    }
    if (!chk) return;

    let audioProcessor = null;
    let smoothedRms = 0;
    let smoothedPitch = 0;
    const AUDIO_SIGNAL_TIMEOUT_MS = 180;
    let lastAudioFrameAt = 0;
    let audioLossActive = false;
    const makeAudioSignal = (neutral, outlierDelta = 0.65) => {
      if (window.SafeInputLayer?.SafeSignal) {
        return new window.SafeInputLayer.SafeSignal({
          neutral, holdMs: 150, releaseMs: 1200, outlierDelta,
          attack: 1, release: 1, recovery: 0.18,
        });
      }
      // Compatibility for partial embeds/tests that load app.js alone.
      return {
        value: neutral,
        ingest(value) { this.value = value; return { value, state: 'active' }; },
        markLost() {},
        tick() { return { value: this.value, state: 'lost' }; },
      };
    };
    const audioSafety = {
      rms: { signal: makeAudioSignal(0, 0.75), scale: 1, control: 'sensor.audio.rms' },
      pitch: { signal: makeAudioSignal(0, 0.7), scale: 5000, control: 'sensor.audio.pitch' },
      bpm: { signal: makeAudioSignal(0), scale: 300, control: 'sensor.audio.bpm' },
      note: { signal: makeAudioSignal(0), scale: 127, control: 'sensor.audio.note' },
      clarity: { signal: makeAudioSignal(0, 0.7), scale: 1, control: 'sensor.audio.clarity' },
      whistleBend: { signal: makeAudioSignal(0.5, 0.8), scale: 1, control: 'sensor.audio.whistle.bend' },
      envelope: { signal: makeAudioSignal(0, 0.75), scale: 1, control: 'sensor.audio.envelope' },
    };
    const safeAudioValue = (channel, value, timestamp = Date.now(), confidence = 1) => {
      const entry = audioSafety[channel];
      return entry.signal.ingest(value / entry.scale, timestamp, confidence).value * entry.scale;
    };
    const PITCH_ALPHA = 0.25;
    // RMS uses the adaptive smoother from audio-smoothing.js: heavy
    // smoothing on quiet signals (anti-jitter) and fast tracking on loud
    // signals (transients pass through). envelope stays raw for now; can
    // be migrated the same way once we've validated the RMS behaviour.

    const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
    function midiToNoteName(midi) {
      if (!midi || midi < 0 || midi > 127) return '--';
      const name = NOTE_NAMES[midi % 12];
      const octave = Math.floor(midi / 12) - 1;
      return `${name}${octave} (${midi})`;
    }

    const startAudio = async () => {
      if (!audioProcessor) {
        audioProcessor = new window.AudioProcessor();
        audioProcessor.onAnalysisUpdate = (data) => {
          const audioTimestamp = Date.now();
          lastAudioFrameAt = audioTimestamp;
          // RMS-specific: amplify input 3x (raw mic is 0.01â€“0.05 for everyday
          // signals), clamp saturated peaks, then smooth with adaptive alpha.
          // alpha computed from raw, not the gained value, so silence still gets
          // heavy noise suppression. See audio-smoothing.js for the formula.
          smoothedRms = window.AudioSmoothing.gainSmoothedRms(smoothedRms, data.rms, 0.08 + Math.min(0.5, data.rms * 2));
          
          if (data.pitch > 0) {
            if (smoothedPitch === 0) {
              smoothedPitch = data.pitch;
            } else {
              smoothedPitch = smoothedPitch * (1 - PITCH_ALPHA) + data.pitch * PITCH_ALPHA;
            }
          } else {
            smoothedPitch = 0;
          }

          const dispPitch = parseFloat(safeAudioValue('pitch', smoothedPitch, audioTimestamp, data.pitch > 0 ? data.clarity : 1).toFixed(1));
          const dispRms = parseFloat(safeAudioValue('rms', smoothedRms, audioTimestamp).toFixed(3));
          const safeBpm = safeAudioValue('bpm', data.bpm || 0, audioTimestamp);
          const safeNote = safeAudioValue('note', data.midiNote || 0, audioTimestamp);
          const safeClarity = safeAudioValue('clarity', data.clarity || 0, audioTimestamp);
          const safeWhistleBend = safeAudioValue('whistleBend', data.whistleBend, audioTimestamp);
          const safeEnvelope = safeAudioValue('envelope', data.envelope, audioTimestamp);
          audioLossActive = false;

          if (lblPitch) lblPitch.textContent = dispPitch > 0 ? dispPitch.toFixed(1) : '--';
          if (lblNote) lblNote.textContent = data.midiNote > 0 ? midiToNoteName(data.midiNote) : '--';
          if (lblBpm) lblBpm.textContent = data.bpm > 0 ? data.bpm : '--';
          if (barRms) {
            const pct = Math.min(100, Math.round(dispRms * 250));
            barRms.style.width = pct + '%';
          }
          if (lblRms) lblRms.textContent = dispRms.toFixed(3);
          if (lblEnvelope) lblEnvelope.textContent = safeEnvelope.toFixed(3);
          if (lblClarity) lblClarity.textContent = safeClarity.toFixed(2);
          if (lblGate) lblGate.textContent = data.gate ? 'ON' : 'OFF';
          if (lblBend) lblBend.textContent = safeWhistleBend.toFixed(2);
          for (const [element, active] of [[lblGate, data.gate]]) {
            element?.parentElement?.classList.toggle('active', Boolean(active));
          }

          if (window.onControl) {
            window.onControl({ name: 'sensor.audio.rms',            value: dispRms });
            window.onControl({ name: 'sensor.audio.pitch',          value: dispPitch });
            if (data.bpm > 0) {
              window.onControl({ name: 'sensor.audio.bpm',          value: safeBpm });
            }
            window.onControl({ name: 'sensor.audio.note',           value: safeNote });
            window.onControl({ name: 'sensor.audio.clarity',        value: safeClarity });
            window.onControl({ name: 'sensor.audio.whistle.bend',   value: safeWhistleBend });
            window.onControl({ name: 'sensor.audio.envelope',       value: safeEnvelope });
            window.onControl({ name: 'sensor.audio.gate',           value: data.gate });
          }

          state.sensors.audio_reading = {
            pitch: dispPitch,
            midi_note: data.midiNote > 0 ? midiToNoteName(data.midiNote) : '--',
            bpm: data.bpm > 0 ? Math.round(data.bpm) : 0,
            rms: dispRms,
            note: data.midiNote,
            clarity: data.clarity,
            whistle_bend: data.whistleBend,
            envelope: data.envelope,
            gate: data.gate
          };

          if (data.bpm > 0 && window.syncMode === 'free') {
            window.currentBpm = data.bpm;
            const bpmEl = document.getElementById('live-bpm');
            if (bpmEl) bpmEl.textContent = `${data.bpm.toFixed(1)} BPM (Audio)`;
          }
        };
      }
      try {
        await audioProcessor.start();
        state.sensors.audio = 'available';
      } catch (err) {
        console.error('Failed to start audio processor:', err);
        state.sensors.audio = 'error';
        chk.checked = false;
      }
    };

    const stopAudio = () => {
      if (audioProcessor) {
        audioProcessor.stop();
        audioProcessor = null;
      }
      state.sensors.audio = 'inactive';
      state.sensors.audio_reading = null;
      smoothedRms = 0;
      smoothedPitch = 0;
      if (lblPitch) lblPitch.textContent = '--';
      if (lblNote) lblNote.textContent = '--';
      if (lblBpm) lblBpm.textContent = '--';
      if (lblGate) lblGate.textContent = 'OFF';

      const lostAt = Date.now();
      audioLossActive = true;
      if (window.onControl) {
        for (const entry of Object.values(audioSafety)) {
          entry.signal.markLost(lostAt);
          const safe = entry.signal.tick(lostAt);
          window.onControl({ name: entry.control, value: safe.value * entry.scale });
        }
        window.onControl({ name: 'sensor.audio.gate',           value: 0 });
      }
    };

    // Mobile browsers can suspend AudioContext/rAF without a final callback.
    // Hold briefly, then release continuous channels to neutral. Discrete
    // gates release immediately once the timeout is confirmed.
    const audioWatchdog = setInterval(() => {
      if ((!audioProcessor && !audioLossActive) || (!lastAudioFrameAt && !audioLossActive)) return;
      const now = Date.now();
      if (!audioLossActive && now - lastAudioFrameAt <= AUDIO_SIGNAL_TIMEOUT_MS) return;
      const lostAt = audioLossActive ? now : lastAudioFrameAt + AUDIO_SIGNAL_TIMEOUT_MS;
      if (window.onControl) {
        let allIdle = true;
        for (const entry of Object.values(audioSafety)) {
          entry.signal.markLost(lostAt);
          const safe = entry.signal.tick(now);
          window.onControl({ name: entry.control, value: safe.value * entry.scale });
          if (safe.state !== 'idle') allIdle = false;
        }
        const releasedRms = audioSafety.rms.signal.value;
        const releasedEnvelope = audioSafety.envelope.signal.value;
        const releasedClarity = audioSafety.clarity.signal.value;
        const releasedBend = audioSafety.whistleBend.signal.value;
        if (barRms) barRms.style.width = `${Math.min(100, Math.round(releasedRms * 250))}%`;
        if (lblRms) lblRms.textContent = releasedRms.toFixed(3);
        if (lblEnvelope) lblEnvelope.textContent = releasedEnvelope.toFixed(3);
        if (lblClarity) lblClarity.textContent = releasedClarity.toFixed(2);
        if (lblBend) lblBend.textContent = releasedBend.toFixed(2);
        window.onControl({ name: 'sensor.audio.gate', value: 0 });
        if (allIdle) audioLossActive = false;
      }
      state.sensors.audio = document.visibilityState === 'hidden' ? 'suspended' : 'lost';
    }, 50);
    if (audioWatchdog && typeof audioWatchdog.unref === 'function') audioWatchdog.unref();

    chk.checked = false;

    chk.addEventListener('change', () => {
      if (chk.checked) {
        startAudio();
      } else {
        stopAudio();
      }
    });
  }

  function getVisionGestureLabel(h) {
    if (!h || !h.active) return 'No hand';
    return typeof state.vision.describeHand === 'function' ? state.vision.describeHand(h) : 'Hand tracked';
  }

  function renderVisionGestureBadges(h) {
    document.querySelectorAll('[data-vision-gesture]').forEach((badge) => {
      const key = badge.dataset && badge.dataset.visionGesture;
      if (!key) return;
      const enabled = badge.getAttribute('aria-pressed') === 'true';
      let active = false;
      if (key === 'fingers') active = !!h && h.active && (h.fingers || 0) > 0;
      else active = !!h && h.active && !!h[key];
      badge.classList.toggle('active', enabled && active);
    });
  }

  function isVisionDetectorEnabled(name) {
    return document.querySelector(`[data-vision-gesture="${name}"]`)?.getAttribute?.('aria-pressed') === 'true';
  }

  function renderVisionReadouts() {
    const h = state.vision && state.vision.hand;
    if (!h) return;

    const gesture = getVisionGestureLabel(h);
    const lblGesture = document.getElementById('lbl-vision-gesture');
    const cardGesture = document.getElementById('vision-card-gesture');

    if (lblGesture) lblGesture.textContent = gesture;
    if (cardGesture) cardGesture.textContent = gesture;
    const activeValue = document.getElementById('vision-value-active');
    if (activeValue) activeValue.textContent = h.active ? 'ON' : 'OFF';
    for (const channel of ['x', 'y', 'z']) {
      const value = document.getElementById(`vision-value-${channel}`);
      if (value) value.textContent = Number(h[channel] ?? (channel === 'z' ? 0 : 0.5)).toFixed(2);
    }
    renderVisionGestureBadges(h);
  }

  function renderVisionColorReadout(data) {
    const colorLabel = document.getElementById('vision-card-color');
    const swatch = document.getElementById('vision-card-color-swatch');
    if (!data) {
      for (const channel of ['r', 'g', 'b']) {
        const value = document.getElementById(`vision-value-${channel}`);
        if (value) value.textContent = '0';
      }
      if (swatch) swatch.style.backgroundColor = '';
      return null;
    }

    const r255 = Math.round(data.r * 255);
    const g255 = Math.round(data.g * 255);
    const b255 = Math.round(data.b * 255);
    const rgb = `rgb(${r255}, ${g255}, ${b255})`;
    const values = { r: r255, g: g255, b: b255 };
    for (const [channel, channelValue] of Object.entries(values)) {
      const value = document.getElementById(`vision-value-${channel}`);
      if (value) value.textContent = String(channelValue);
    }
    if (swatch) swatch.style.backgroundColor = rgb;
    return { r255, g255, b255, rgb };
  }

  function setupVisionUI() {
    const chk = document.getElementById('chk-vision-enable');
    const hud = document.getElementById('vision-hud');
    const video = document.getElementById('vision-video');
    const canvas = document.getElementById('vision-canvas');
    const lblGesture = document.getElementById('lbl-vision-gesture');
    const confidenceSelect = document.getElementById('vision-confidence');
    const gesturePresetSelect = document.getElementById('vision-recognition-preset');
    const cameraStage = document.querySelector('.vision-camera-stage');
    const cameraStateTitle = document.getElementById('vision-camera-state-title');
    const cameraStateDetail = document.getElementById('vision-camera-state-detail');
    const detectorButtons = Array.from(document.querySelectorAll('[data-vision-gesture]'))
      .filter((button) => button?.dataset?.visionGesture);
    const gestureSlotCards = Array.from(document.querySelectorAll('[data-gesture-slot]'))
      .filter((card) => card?.dataset?.gestureSlot);
    if (typeof window.VisionControlState !== 'function') return;

    // Same pattern as audio: emit the vision channels at zero BEFORE the
    // user enables the camera. Lets the user bind sensor.vision.* channels
    // to a Live parameter in advance; the mapping starts working the
    // moment the camera is enabled.
    // Same reasoning as the audio pre-arm: registering the channels, not
    // measuring them, so flag the absence rather than publishing a value.
    if (window.onControl) {
      window.onControl({ name: 'sensor.vision.active', value: 0 });
      window.onControl({ name: 'sensor.vision.x', value: 0.5, lost: true });
      window.onControl({ name: 'sensor.vision.y', value: 0.5, lost: true });
      window.onControl({ name: 'sensor.vision.z', value: 0, lost: true });
      window.onControl({ name: 'sensor.vision.color.r', value: 0, lost: true });
      window.onControl({ name: 'sensor.vision.color.g', value: 0, lost: true });
      window.onControl({ name: 'sensor.vision.color.b', value: 0, lost: true });
      window.onControl({ name: 'sensor.vision.gesture.1', value: 0, lost: true });
      window.onControl({ name: 'sensor.vision.gesture.2', value: 0, lost: true });
      window.onControl({ name: 'sensor.vision.gesture.3', value: 0, lost: true });
    }

    // Wire the per-channel mode buttons. The picker only offers the modes
    // each channel semantically supports (x/y/z â†’ A/B; gestures â†’ A/C) but
    // the data model and localStorage happily carry any letter, so a future
    // B-for-gesture or C-for-position could be enabled without UI surgery.
    // Tests mount the script into a minimal DOM stub, so skip any element
    // that lacks the expected data attribute rather than crashing the suite.
    document.querySelectorAll('#vision-modes .vision-mode-row').forEach((row) => {
      const channel = row.dataset && row.dataset.channel;
      if (!channel) return;
      const buttons = row.querySelectorAll('.vision-mode-btn');
      const apply = () => {
        buttons.forEach((btn) => {
          btn.classList.toggle('active', state.visionModes[channel] === btn.dataset.mode);
        });
      };
      apply();
      buttons.forEach((btn) => {
        btn.addEventListener('click', () => {
          state.visionModes[channel] = btn.dataset.mode;
          saveVisionModes();
          apply();
        });
      });
    });

    if (!chk || !video || !canvas || !hud) return;
    if (cameraStage?.appendChild) {
      cameraStage.appendChild(video);
      cameraStage.appendChild(hud);
    }

    const GESTURE_PRESETS = {
      precision: { threshold: 0.11, ambiguityMargin: 0.045, minimumConfidence: 0.66, captureStabilityThreshold: 0.075, holdMs: 260, releaseMs: 240 },
      balanced: { threshold: 0.16, ambiguityMargin: 0.035, minimumConfidence: 0.52, captureStabilityThreshold: 0.10, holdMs: 160, releaseMs: 220 },
      flexible: { threshold: 0.20, ambiguityMargin: 0.03, minimumConfidence: 0.44, captureStabilityThreshold: 0.125, holdMs: 120, releaseMs: 200 },
    };
    const POSE_CAPTURE_MS = 900;

    let visionProcessor = null;
    let visionGestureTestSlot = null;
    let visionGestureLearnSlot = null;
    let poseCaptureTimer = null;
    let gestureTestFeedbackTimer = null;
    let visionSafetyConfig = null;
    try {
      visionSafetyConfig = JSON.parse(localStorage.getItem('ableton-rc:vision_safety') || 'null');
    } catch {}
    visionSafetyConfig = visionSafetyConfig || {
      version: 2,
      confidence: 'medium',
      gestures: { version: 8, templates: [] },
      gestureOptions: {},
      gesturePreset: 'balanced',
      visionControls: {},
    };
    let incompatibleGestureNames = new Set();
    const migrateGestureConfig = (gestures, options = {}) => {
      const library = window.SafeInputLayer?.GestureLibrary?.fromJSON?.(gestures, options);
      incompatibleGestureNames = new Set(library?.getIncompatibleNames?.() || []);
      return library?.toJSON?.() || gestures || { version: 8, templates: [] };
    };
    visionSafetyConfig.gestures = migrateGestureConfig(visionSafetyConfig.gestures, visionSafetyConfig.gestureOptions);
    const normalizeGestureTemplates = window.normalizeVisionGestureTemplates || ((templates) => templates || []);
    visionSafetyConfig.gestures = {
      ...(visionSafetyConfig.gestures || { version: 1 }),
      templates: normalizeGestureTemplates(visionSafetyConfig.gestures?.templates),
    };

    let visionControls = new window.VisionControlState(
      visionSafetyConfig?.visionControls || {},
      visionSafetyConfig?.gestures?.templates || [],
    );
    state.vision.describeHand = (hand) => visionControls.describeHand(hand);

    const gestureTemplateFor = (name) => {
      const templates = visionProcessor?.exportSafetyConfig?.().gestures?.templates
        || visionSafetyConfig?.gestures?.templates || [];
      return templates.find((template) => template.name === name) || null;
    };
    const samplesForGesture = (name) => {
      return Math.min(3, gestureTemplateFor(name)?.samples?.length || 0);
    };
    const gestureKindFor = (name) => {
      const kind = visionProcessor?.gestureKind?.(name) || gestureTemplateFor(name)?.kind || '';
      return kind ? 'POSE' : '';
    };

    const renderVisionControlState = () => {
      detectorButtons.forEach((button) => {
        const enabled = visionControls.detectorEnabled(button.dataset.visionGesture);
        button.setAttribute('aria-pressed', enabled ? 'true' : 'false');
        button.classList.toggle('enabled', enabled);
      });
      gestureSlotCards.forEach((card) => {
        const id = Number(card.dataset.gestureSlot);
        const slot = visionControls.slots[id - 1];
        const status = card.querySelector('.vision-slot-status');
        const countLabel = card.querySelector('header strong');
        const learnButton = card.querySelector('.vision-slot-learn');
        const testButton = card.querySelector('.vision-slot-test');
        const retakeButton = card.querySelector('.vision-slot-retake');
        const deleteButton = card.querySelector('.vision-slot-delete');
        const samples = samplesForGesture(slot?.name || '');
        const kind = gestureKindFor(slot?.name || '');
        const kindPrefix = kind ? `${kind} · ` : '';
        if (countLabel) countLabel.textContent = `${samples} / 3`;
        if (learnButton) learnButton.disabled = samples >= 3;
        if (testButton) testButton.disabled = samples !== 3;
        if (retakeButton) retakeButton.disabled = samples === 0;
        if (deleteButton) deleteButton.disabled = samples === 0;
        if (status && !card.classList.contains('recording') && !card.classList.contains('testing')) {
          status.textContent = samples === 0 && incompatibleGestureNames.has(slot?.name)
            ? 'RECAPTURE REQUIRED · saved pose used the retired format'
            : samples === 0 ? 'Empty · capture 3 examples'
            : samples === 3 ? `${kindPrefix}Ready · press TEST to validate`
              : `${kindPrefix}${samples}/3 saved · capture ${3 - samples} more`;
        }
      });
    };

    const persistVisionSafety = () => {
      if (visionProcessor?.exportSafetyConfig) {
        const gesturePreset = visionSafetyConfig?.gesturePreset || gesturePresetSelect?.value || 'balanced';
        visionSafetyConfig = { ...visionProcessor.exportSafetyConfig(), gesturePreset };
      }
      if (visionSafetyConfig) {
        visionSafetyConfig.visionControls = visionControls.toJSON();
        try { localStorage.setItem('ableton-rc:vision_safety', JSON.stringify(visionSafetyConfig)); } catch {}
        if (typeof window.sendPhoneCommand === 'function') {
          window.sendPhoneCommand('saveProjectClientState', {
            camera: {
              confidence: visionSafetyConfig.confidence,
            },
            gestures: visionSafetyConfig.gestures,
            preferences: {
              visionGestureOptions: visionSafetyConfig.gestureOptions,
              visionGesturePreset: visionSafetyConfig.gesturePreset || 'balanced',
              visionControls: visionControls.toJSON(),
            },
          });
        }
      }
    };

    window.applyProjectClientState = (clientState) => {
      if (!clientState) return;
      const restoredGestureOptions = clientState.preferences?.visionGestureOptions || visionSafetyConfig?.gestureOptions || {};
      const restoredGestures = migrateGestureConfig(
        clientState.gestures || visionSafetyConfig?.gestures || { version: 1, templates: [] },
        restoredGestureOptions,
      );
      visionSafetyConfig = {
        version: 2,
        confidence: clientState.camera?.confidence || visionSafetyConfig?.confidence || 'medium',
        gestures: { ...restoredGestures, templates: normalizeGestureTemplates(restoredGestures.templates) },
        gestureOptions: restoredGestureOptions,
        gesturePreset: clientState.preferences?.visionGesturePreset || visionSafetyConfig?.gesturePreset || 'balanced',
        visionControls: clientState.preferences?.visionControls || visionSafetyConfig?.visionControls || {},
      };
      visionControls = new window.VisionControlState(visionSafetyConfig.visionControls, visionSafetyConfig.gestures?.templates || []);
      if (confidenceSelect) {
        let conf = visionSafetyConfig.confidence;
        if (conf === 0.2) conf = 'low';
        else if (conf === 0.7) conf = 'high';
        else if (conf === 0.5) conf = 'medium';
        confidenceSelect.value = conf || 'medium';
      }
      if (gesturePresetSelect) gesturePresetSelect.value = visionSafetyConfig.gesturePreset;
      visionProcessor?.importSafetyConfig(visionSafetyConfig);
      visionProcessor?.setGestureOptions(GESTURE_PRESETS[visionSafetyConfig.gesturePreset] || GESTURE_PRESETS.balanced);
      renderVisionControlState();
      if (clientState.pages?.activePage && typeof window.showPhonePage === 'function') {
        const activePage = clientState.pages.activePage === 'media' ? 'audio' : clientState.pages.activePage;
        window.showPhonePage(activePage);
      }
      try { localStorage.setItem('ableton-rc:vision_safety', JSON.stringify(visionSafetyConfig)); } catch {}
    };
    const updateGestureOptions = () => {
      const preset = gesturePresetSelect?.value || 'balanced';
      const options = GESTURE_PRESETS[preset] || GESTURE_PRESETS.balanced;
      visionProcessor?.setGestureOptions(options);
      visionSafetyConfig = { ...(visionSafetyConfig || {}), gestureOptions: options, gesturePreset: preset };
      persistVisionSafety();
    };
    if (gesturePresetSelect) {
      gesturePresetSelect.value = visionSafetyConfig.gesturePreset || 'balanced';
      gesturePresetSelect.addEventListener('change', updateGestureOptions);
    }

    if (confidenceSelect) {
      let conf = visionSafetyConfig?.confidence;
      if (conf === 0.2) conf = 'low';
      else if (conf === 0.7) conf = 'high';
      else if (conf === 0.5) conf = 'medium';
      confidenceSelect.value = conf || 'medium';
      confidenceSelect.addEventListener('change', () => {
        visionProcessor?.setConfidence?.(confidenceSelect.value);
        visionSafetyConfig = { ...(visionSafetyConfig || {}), confidence: confidenceSelect.value };
        persistVisionSafety();
      });
    }
    detectorButtons.forEach((button) => {
      button.addEventListener('click', () => {
        if (document.body.classList.contains('mapping-mode')) return;
        const detector = button.dataset.visionGesture;
        const enabled = !visionControls.detectorEnabled(detector);
        visionControls.setDetector(detector, enabled);
        if (!enabled && window.onControl) {
          window.onControl({ name: `sensor.vision.${detector}`, value: 0 });
        }
        if (!enabled && state.sensors.vision_reading) {
          delete state.sensors.vision_reading[detector];
          if (detector === 'pinch') delete state.sensors.vision_reading.pinchVal;
        }
        renderVisionControlState();
        renderVisionReadouts();
        persistVisionSafety();
      });
    });

    const stopGestureTest = () => {
      if (gestureTestFeedbackTimer) clearTimeout(gestureTestFeedbackTimer);
      gestureTestFeedbackTimer = null;
      visionProcessor?.endGestureTest?.();
      visionGestureTestSlot = null;
      gestureSlotCards.forEach((card) => {
        card.classList.remove('testing', 'recognized');
        const button = card.querySelector('.vision-slot-test');
        button?.setAttribute('aria-pressed', 'false');
        button?.classList.remove('active');
      });
      renderVisionControlState();
    };

    const removeStoredTake = (name) => {
      if (!name) return 0;
      if (visionProcessor) return visionProcessor.removeLastGestureTake(name);
      const template = visionSafetyConfig.gestures?.templates?.find((entry) => entry.name === name);
      if (!template?.samples?.length) return 0;
      template.samples.pop();
      return template.samples.length;
    };

    const deleteStoredGesture = (name) => {
      if (!name) return false;
      if (visionProcessor) return visionProcessor.deleteGesture(name);
      const templates = visionSafetyConfig.gestures?.templates || [];
      const next = templates.filter((entry) => entry.name !== name);
      visionSafetyConfig.gestures = { ...(visionSafetyConfig.gestures || {}), templates: next };
      return next.length !== templates.length;
    };

    gestureSlotCards.forEach((card) => {
      const slotId = Number(card.dataset.gestureSlot);
      const learnButton = card.querySelector('.vision-slot-learn');
      const testButton = card.querySelector('.vision-slot-test');
      const retakeButton = card.querySelector('.vision-slot-retake');
      const deleteButton = card.querySelector('.vision-slot-delete');
      const status = card.querySelector('.vision-slot-status');

      learnButton?.addEventListener('click', () => {
        if (!visionProcessor) return showToast('Enable camera before gesture Learn', 'warning');
        if (visionGestureLearnSlot !== null) {
          return showToast(`Finish Gesture ${visionGestureLearnSlot} capture first`, 'warning');
        }
        const name = visionControls.slots[slotId - 1]?.name || `Gesture ${slotId}`;
        if (samplesForGesture(name) >= 3) return showToast('This pose already has 3 examples · use REMOVE LAST first', 'warning');
        stopGestureTest();
        visionGestureLearnSlot = slotId;
        visionProcessor.beginGestureLearn(name);
        learnButton.textContent = 'CAPTURING…';
        learnButton.disabled = true;
        card.classList.add('recording');
        if (status) status.textContent = `HOLD POSE · capturing example ${samplesForGesture(name) + 1}/3 · LIVE BLOCKED`;
        poseCaptureTimer = setTimeout(() => {
          poseCaptureTimer = null;
          let samples = 0;
          try {
            samples = visionProcessor.finishGestureLearn();
            if (samples > 0) incompatibleGestureNames.delete(name);
          } catch (error) {
            samples = samplesForGesture(name);
            if (status) status.textContent = error?.message || 'Hold the pose still and try again';
          }
          visionGestureLearnSlot = null;
          learnButton.textContent = 'CAPTURE POSE';
          learnButton.disabled = false;
          card.classList.remove('recording');
          if (status && samples > 0) status.textContent = samples === 3
            ? 'POSE · 3/3 complete · press TEST'
            : `POSE · ${samples}/3 saved · capture ${3 - samples} more`;
          persistVisionSafety();
          renderVisionControlState();
        }, POSE_CAPTURE_MS);
      });

      testButton?.addEventListener('click', () => {
        const slot = visionControls.slots[slotId - 1];
        if (!slot?.name || samplesForGesture(slot.name) !== 3) return showToast('Capture exactly three pose examples before testing', 'warning');
        const shouldStart = visionGestureTestSlot !== slotId;
        stopGestureTest();
        if (!shouldStart) return;
        visionGestureTestSlot = slotId;
        visionProcessor?.beginGestureTest?.(slot.name);
        card.classList.add('testing');
        testButton.setAttribute('aria-pressed', 'true');
        testButton.classList.add('active');
        if (status) status.textContent = 'HOLD THE LEARNED POSE · waiting for a stable match';
        gestureTestFeedbackTimer = setTimeout(() => {
          if (visionGestureTestSlot === slotId && status) {
            status.textContent = 'NO POSE MATCH YET · adjust your hand and hold it still';
          }
        }, 6000);
      });

      retakeButton?.addEventListener('click', () => {
        const slot = visionControls.slots[slotId - 1];
        if (!slot?.name) return;
        stopGestureTest();
        const samples = removeStoredTake(slot.name);
        if (status) status.textContent = `${samples}/3 saved · record one replacement`;
        persistVisionSafety();
        renderVisionControlState();
      });

      deleteButton?.addEventListener('click', () => {
        const slot = visionControls.slots[slotId - 1];
        stopGestureTest();
        if (slot?.name) deleteStoredGesture(slot.name);
        persistVisionSafety();
        renderVisionControlState();
      });
    });
    renderVisionControlState();

    const startVision = async () => {
      state.vision.enabled = true;
      const h = state.vision.hand;
      h.active = false;
      h.x = 0.5;
      h.y = 0.5;
      h.z = 0;
      h.fist = false;
      h.pinch = false;
      h.victory = false;
      h.open = false;
      h.rotateVal = 0.5;
      h.thumb = 0;
      h.index = 0;
      h.middle = 0;
      h.ring = 0;
      h.pinky = 0;
      h.fingers = 0;
      if (!visionProcessor) {
        visionProcessor = new window.VisionProcessor();
        window.currentVisionProcessor = visionProcessor;
        if (visionSafetyConfig && visionProcessor.importSafetyConfig) {
          visionProcessor.importSafetyConfig(visionSafetyConfig);
        }
        // setConfidence before the camera starts so the very first
        // hands.send() already uses the chosen MediaPipe threshold.
        visionProcessor.setConfidence?.(confidenceSelect?.value || visionSafetyConfig?.confidence || 'medium');
        visionProcessor.setGestureOptions(GESTURE_PRESETS[gesturePresetSelect?.value || 'balanced'] || GESTURE_PRESETS.balanced);

        // Apply a hand reading onto state, vision_reading payload, HUD,
        // and the wire. Returns true if the hand was newly activated (so the
        // caller can distinguish "first frame after a gap" from "ongoing").
        function applyHandReading(data) {
          const h = state.vision.hand;
          const wasActive = h.active;
          h.active = true;
          h.x = data.x;
          h.y = data.y;
          h.z = data.z;

          // Detect rising edges per gesture BEFORE writing h.fist/pinch/etc
          // so prev-vs-current comparisons reflect the previous frame.
          // Only gestures that support mode C get this treatment.
          const gestureChannels = ['fist', 'pinch', 'victory', 'open'];
          for (const ch of gestureChannels) {
            const cur = data[ch] ? 1 : 0;
            const prev = state.visionPrev[ch];
            if (cur === 1 && prev === 0 && state.visionModes[ch] === 'C') {
              // Rising edge while in toggle mode â†’ flip the latch.
              state.visionToggle[ch] = state.visionToggle[ch] ? 0 : 1;
            }
            state.visionPrev[ch] = cur;
          }

          h.fist = data.fist;
          h.pinch = data.pinch;
          h.victory = data.victory;
          h.open = data.open;
          h.rotateVal = data.rotateVal;
          h.thumb = data.thumb;
          h.index = data.index;
          h.middle = data.middle;
          h.ring = data.ring;
          h.pinky = data.pinky;
          h.fingers = data.fingers;

          const color = state.sensors.vision_reading?.color;
          const visibleReading = {
            active: true, x: data.x, y: data.y, z: data.z,
            confidence: data.confidence, trackingState: data.trackingState,
          };
          for (const detector of ['fist', 'pinch', 'victory', 'open', 'fingers']) {
            if (visionControls.detectorEnabled(detector)) visibleReading[detector] = data[detector];
          }
          if (visionControls.detectorEnabled('pinch')) visibleReading.pinchVal = data.pinchVal;
          // rotateVal rides on the Victory pose: always exposed on the HUD
          // so the user can see the wrist angle as they twist, even before
          // the gesture latches. The wire output (below) only carries the
          // live reading while Victory is active; otherwise it stays pinned
          // at the 0.5 neutral.
          if (visionControls.detectorEnabled('victory')) visibleReading.rotateVal = data.rotateVal;
          if (color) visibleReading.color = color;
          state.sensors.vision_reading = visibleReading;
          renderVisionReadouts();

          if (window.onControl) {
            // Resolve the value sent on the wire for each gesture channel:
            // mode A â†’ momentary boolean, mode C â†’ latched toggle state.
            const gestureValue = (ch) => state.visionModes[ch] === 'C'
              ? state.visionToggle[ch]
              : (data[ch] ? 1 : 0);

            window.onControl({ name: 'sensor.vision.active', value: 1 });
            window.onControl({ name: 'sensor.vision.x', value: data.x });
            window.onControl({ name: 'sensor.vision.y', value: data.y });
            window.onControl({ name: 'sensor.vision.z', value: data.z });
            if (visionControls.detectorEnabled('fist')) {
              window.onControl({ name: 'sensor.vision.fist', value: gestureValue('fist') });
            }
            // Pinch is special: it carries the analog pinchVal (0.0â€“1.0) in
            // mode A so the wire exposes the continuous control surface. Mode
            // C replaces it with the latched toggle.
            if (visionControls.detectorEnabled('pinch')) {
              if (state.visionModes.pinch === 'C') {
                window.onControl({ name: 'sensor.vision.pinch', value: state.visionToggle.pinch });
              } else {
                window.onControl({ name: 'sensor.vision.pinch', value: data.pinchVal ?? 0 });
              }
            }
            if (visionControls.detectorEnabled('victory')) {
              window.onControl({ name: 'sensor.vision.victory', value: gestureValue('victory') });
            }
            // rotateVal follows the Victory gate: the analog wrist rotation
            // travels on the wire only while Victory is held, otherwise it
            // anchors at the 0.5 neutral so panel mappings don't drift.
            if (visionControls.detectorEnabled('victory')) {
              const rotateValue = data.victory ? (data.rotateVal ?? 0.5) : 0.5;
              window.onControl({ name: 'sensor.vision.rotateVal', value: rotateValue });
            }
            if (visionControls.detectorEnabled('open')) {
              window.onControl({ name: 'sensor.vision.open', value: gestureValue('open') });
            }
            if (visionControls.detectorEnabled('fingers')) {
              window.onControl({ name: 'sensor.vision.fingers', value: data.fingers });
            }
          }

          return !wasActive;
        }

        // Mark a hand as lost: snapshot its current x/y/z as the decay
        // origin so the values drift back to neutral smoothly. Reset the
        // previous-frame gesture flags so the next time this hand appears
        // the very first frame counts as a fresh rising edge for mode-C
        // toggle channels (otherwise an already-latched toggle would never
        // fire again until the gesture dropped and rose).
        function markHandLost() {
          const h = state.vision.hand;
          if (!h.active) return;
          h.active = false;
          h.x = 0.5;
          h.y = 0.5;
          h.z = 0;
          h.handLostTime = Date.now();
          if (state.visionPrev) {
            state.visionPrev.fist = 0;
            state.visionPrev.pinch = 0;
            state.visionPrev.victory = 0;
            state.visionPrev.open = 0;
          }
          if (state.sensors.vision_reading) {
            state.sensors.vision_reading.active = false;
            state.sensors.vision_reading.x = 0.5;
            state.sensors.vision_reading.y = 0.5;
            state.sensors.vision_reading.z = 0;
          }
          renderVisionReadouts();
          if (window.onControl) {
            // Report the loss, don't invent a reading. The value is only a
            // placeholder for the HUD; `lost: true` tells the server to apply
            // each target's Safe loss policy (hold / zero / center / initial /
            // custom / release / reconcile) instead of taking it literally.
            window.onControl({ name: 'sensor.vision.active', value: 0 });
            window.onControl({ name: 'sensor.vision.x', value: 0.5, lost: true });
            window.onControl({ name: 'sensor.vision.y', value: 0.5, lost: true });
            window.onControl({ name: 'sensor.vision.z', value: 0, lost: true });
          }
        }

        visionProcessor.onHandUpdate = (handData) => {
          if (handData && handData.active) {
            applyHandReading(handData);
          } else {
            markHandLost();
          }
        };
        visionProcessor.onGestureProgress = (evaluation) => {
          if (visionGestureTestSlot === null) return;
          const slot = visionControls.slots[visionGestureTestSlot - 1];
          if (!slot?.name) return;
          const target = evaluation?.candidates?.find((candidate) => candidate.name === slot.name);
          if (!target) return;
          const card = document.querySelector(`[data-gesture-slot="${slot.id}"]`);
          const status = card?.querySelector('.vision-slot-status');
          const percent = Math.round((target.confidence || 0) * 100);
          if (status) status.textContent = evaluation.accepted && evaluation.name === slot.name
            ? `POSE MATCH ${percent}% · hold still to confirm`
            : `POSE MATCH ${percent}% · adjust your hand`;
        };
        visionProcessor.onGesture = (match) => {
          const slot = visionControls.slotForGesture(match.name);
          if (!slot) return;
          if (visionGestureTestSlot !== null && visionGestureTestSlot !== slot.id) return;
          const card = document.querySelector(`[data-gesture-slot="${slot.id}"]`);
          const status = card?.querySelector('.vision-slot-status');
          const percent = Math.round(match.confidence * 100);
          card?.classList.add('recognized');
          if (visionGestureTestSlot !== null) {
            if (gestureTestFeedbackTimer) clearTimeout(gestureTestFeedbackTimer);
            gestureTestFeedbackTimer = null;
            visionGestureTestSlot = null;
            visionProcessor?.endGestureTest?.();
            card?.classList.remove('testing');
            const testButton = card?.querySelector('.vision-slot-test');
            testButton?.setAttribute('aria-pressed', 'false');
            testButton?.classList.remove('active');
            if (status) status.textContent = `✓ TEST PASSED · ${percent}% confidence · release and show the pose again to retrigger`;
            setTimeout(() => card?.classList.remove('recognized'), 1600);
            return;
          }
          if (status) status.textContent = `✓ ${match.name} recognized · ${percent}%`;
          setTimeout(() => card?.classList.remove('recognized'), 420);
          if (!window.onControl) return;
          const control = visionControls.controlForSlot(slot.id);
          window.onControl({ name: control, value: 1 });
          setTimeout(() => window.onControl && window.onControl({ name: control, value: 0 }), 80);
        };
        visionProcessor.onColorUpdate = (data) => {
          state.sensors.vision_reading = state.sensors.vision_reading || {};
          state.sensors.vision_reading.color = { r: data.r, g: data.g, b: data.b };

          if (window.onControl) {
            window.onControl({ name: 'sensor.vision.color.r', value: data.r });
            window.onControl({ name: 'sensor.vision.color.g', value: data.g });
            window.onControl({ name: 'sensor.vision.color.b', value: data.b });
          }
          const r255 = Math.round(data.r * 255);
          const g255 = Math.round(data.g * 255);
          const b255 = Math.round(data.b * 255);
          renderVisionColorReadout(data);
          hud.style.borderColor = `rgb(${r255}, ${g255}, ${b255})`;
          hud.style.boxShadow = `0 0 15px rgba(${r255}, ${g255}, ${b255}, 0.4)`;
        };
      }
      const setCameraStageState = (stateName, title, detail) => {
        cameraStage?.classList?.remove('camera-active', 'camera-starting', 'camera-error');
        if (stateName) cameraStage?.classList?.add(`camera-${stateName}`);
        if (cameraStateTitle) cameraStateTitle.textContent = title;
        if (cameraStateDetail) cameraStateDetail.textContent = detail;
      };
      // Render the pipeline's real state. "Camera shows video" and "MediaPipe
      // is inferring" are independent — the preview can look perfect while
      // inference is dead — so never assert the latter from the former.
      const renderVisionStage = (status) => {
        if (!status) return;
        if (status.stage === 'error') {
          setCameraStageState('error', 'VISION ERROR', status.lastError || 'MediaPipe inference failed.');
        } else if (status.stage === 'hand-detected') {
          setCameraStageState('active', 'HAND DETECTED', 'Hand detected — vision controls are live');
        } else if (status.stage === 'waiting-hand') {
          setCameraStageState('active', 'CAMERA ACTIVE', 'MediaPipe running — waiting for hand');
        } else if (status.stage === 'starting') {
          setCameraStageState('starting', 'STARTING CAMERA', 'Waiting for the browser video source…');
        }
      };
      visionProcessor.onVisionStatus = renderVisionStage;

      chk.disabled = true;
      try {
        setCameraStageState('starting', 'STARTING CAMERA', 'Waiting for the browser video source…');
        await visionProcessor.start(video, canvas);
        hud.classList.remove('hidden');
        renderVisionStage(visionProcessor.visionStatus);
        state.sensors.vision = 'available';
      } catch (err) {
        console.error('Failed to start vision processor:', err);
        visionProcessor?.stop();
        visionProcessor = null;
        state.sensors.vision = 'error';
        state.sensors.vision_reading = null;
        state.vision.enabled = false;
        chk.checked = false;
        hud.classList.add('hidden');
        const errorName = err?.name || '';
        const CAMERA_ERRORS = {
          NotAllowedError: ['CAMERA BLOCKED', 'Allow camera access in browser settings, then retry.'],
          SecurityError: ['CAMERA BLOCKED', 'Open this page over HTTPS and allow camera access.'],
          NotFoundError: ['NO CAMERA', 'No usable camera was found on this device.'],
          NotReadableError: ['CAMERA BUSY', 'Close the other camera app, then tap CAMERA again.'],
        };
        const unknownCameraDetail = [errorName || 'Error', err?.message || 'Unknown camera error']
          .join(': ')
          .replace(/\s+/g, ' ')
          .trim()
          .slice(0, 120);
        const [title, detail] = CAMERA_ERRORS[errorName]
          || ['CAMERA COULD NOT START', unknownCameraDetail || 'Tap CAMERA to retry.'];
        setCameraStageState('error', title, detail);
      } finally {
        chk.disabled = false;
      }
    };

    const stopVision = () => {
      stopGestureTest();
      if (poseCaptureTimer) clearTimeout(poseCaptureTimer);
      poseCaptureTimer = null;
      visionGestureLearnSlot = null;
      gestureSlotCards.forEach((card) => {
        card.classList.remove('recording');
        const button = card.querySelector('.vision-slot-learn');
        if (button) {
          button.textContent = 'CAPTURE POSE';
          button.disabled = false;
        }
      });
      if (visionProcessor) {
        persistVisionSafety();
        visionProcessor.stop();
        visionProcessor = null;
      }
      state.sensors.vision = 'inactive';
      state.sensors.vision_reading = null;
      state.vision.enabled = false;
      const h = state.vision.hand;
      h.active = false;
      h.x = 0.5;
      h.y = 0.5;
      h.z = 0;
      h.fist = false;
      h.pinch = false;
      h.victory = false;
      h.open = false;
      h.rotateVal = 0.5;
      h.thumb = 0;
      h.index = 0;
      h.middle = 0;
      h.ring = 0;
      h.pinky = 0;
      h.fingers = 0;
      hud.classList.add('hidden');
      cameraStage?.classList?.remove('camera-active', 'camera-starting', 'camera-error');
      if (cameraStateTitle) cameraStateTitle.textContent = 'CAMERA OFF';
      if (cameraStateDetail) cameraStateDetail.textContent = 'Enable Camera to begin';
      hud.style.borderColor = '';
      hud.style.boxShadow = '';
      if (lblGesture) lblGesture.textContent = '--';
      renderVisionReadouts();
      renderVisionColorReadout(null);

      if (window.onControl) {
        // Camera off is a lost signal, same as the hand leaving the frame:
        // flag it so each target's Safe loss policy decides, instead of
        // slamming every mapped parameter to a value chosen here.
        window.onControl({ name: 'sensor.vision.active', value: 0 });
        window.onControl({ name: 'sensor.vision.x', value: 0.5, lost: true });
        window.onControl({ name: 'sensor.vision.y', value: 0.5, lost: true });
        window.onControl({ name: 'sensor.vision.z', value: 0, lost: true });
        for (const detector of ['fist', 'pinch', 'victory', 'open', 'fingers']) {
          if (visionControls.detectorEnabled(detector)) {
            window.onControl({ name: `sensor.vision.${detector}`, value: 0, lost: true });
          }
        }
        if (visionControls.detectorEnabled('victory')) {
          window.onControl({ name: 'sensor.vision.rotateVal', value: 0.5, lost: true });
        }
        for (let slot = 1; slot <= 3; slot += 1) {
          window.onControl({ name: `sensor.vision.gesture.${slot}`, value: 0, lost: true });
        }
      }
    };

    chk.checked = false;

    chk.addEventListener('change', () => {
      if (chk.checked) {
        return startVision();
      } else {
        return stopVision();
      }
    });
    window.addEventListener('pagehide', stopVision);
  }

  function setupBattery() {
    if (!navigator.getBattery) return;

    navigator.getBattery().then((battery) => {
      const updateBattery = () => {
        state.sensors.network.battery = {
          level: battery.level,
          charging: battery.charging,
        };

        // Keep telemetry only; avoid disruptive alerts during performances.
        document.body.classList.remove('critical-battery');
      };

      updateBattery();

      battery.addEventListener('levelchange', updateBattery);
      battery.addEventListener('chargingchange', updateBattery);
    }).catch(() => {});
  }

  // Initialise session via modules/session.js (manages WS, reconnect, heartbeat).
  // Guard: if session.js isn't loaded (unit-test environment), provide a no-op stub
  // so the remaining init functions can run without crashing.
  if (!window.RCSurface || typeof window.RCSurface.initSession !== 'function') {
    // Unit tests load app.js directly without session.js; stub out session APIs.
    window.RCSurface = window.RCSurface || {};
    window.RCSurface.initSession = () => {};
    window.RCSurface.getMappingModeActive = () => false;
    window.RCSurface.getTelemetryThrottleUntil = () => 0;
    window.RCSurface._setStatus = () => {};
    window.RCSurface._connect = () => {};
    window.isPhoneMappingModeActive = () => false;
    window.setPhoneMappingModeActive = () => {};
    window.throttlePhoneTelemetry = () => {};
    window.getPhoneClientId = () => null;
    window.sendPhoneCommand = () => false;
    window.phoneWs = null;
  }
  window.RCSurface.initSession({
    onMessage: (msg) => {
      // The onMessage handler in session.js delivers only post-hello/post-pong messages.
      // For the phone client, session.js already handled hello (clientId persist + status).
      // Additional hello data (tempo, signature, values, projectConfig) is handled below.
      if (msg.type === 'hello') {
        if (window.state) window.state.role = msg.role || 'viewer';
        if (typeof msg.tempo === 'number') {
          window.lastSessionBpm = msg.tempo;
          if (window.syncMode === 'sync') {
            window.currentBpm = msg.tempo;
            const bpmEl = document.getElementById('live-bpm');
            if (bpmEl) bpmEl.textContent = `${msg.tempo.toFixed(1)} BPM`;
          }
        }
        if (msg.signature) {
          const sigEl = document.getElementById('live-sig');
          if (sigEl) sigEl.textContent = msg.signature;
          const sigParts = msg.signature.split('/');
          if (sigParts.length === 2) {
            window.currentNumerator = parseInt(sigParts[0]) || 4;
            window.currentDenominator = parseInt(sigParts[1]) || 4;
          }
        }
        if (msg.playheadActive !== undefined) {
          window.playheadActive = msg.playheadActive;
          window.playheadBaseTimeMs = msg.playheadTimeMs ?? 0;
          window.playheadStartTime = Date.now();
        }
        if (msg.values && typeof msg.values === 'object') {
          applyRemoteControlValues(msg.values);
        }
        if (msg.projectConfig?.clientState && typeof window.applyProjectClientState === 'function') {
          window.applyProjectClientState({
            ...msg.projectConfig.clientState,
            preferences: msg.projectConfig.preferences || {},
          });
        }
        return;
      }
      if (msg.type === 'control_sync') {
        // Another performer moved something on the shared surface. The server
        // never sends a client its own move back, so anything arriving here
        // belongs to someone else's hand.
        applyRemoteControlValues(msg.controls);
      } else if (msg.type === 'safe_input_state') {
        if (typeof window.updateSafeInputFeedback === 'function') {
          window.updateSafeInputFeedback(msg.control, msg);
        }
      } else if (msg.type === 'tempo') {
        if (typeof msg.tempo === 'number') {
          window.lastSessionBpm = msg.tempo;
          if (window.syncMode === 'sync') {
            window.currentBpm = msg.tempo;
            const bpmEl = document.getElementById('live-bpm');
            if (bpmEl) bpmEl.textContent = `${msg.tempo.toFixed(1)} BPM`;
          }
        }
      } else if (msg.type === 'live_state') {
        if (typeof msg.tempo === 'number') {
          window.lastSessionBpm = msg.tempo;
          if (window.syncMode === 'sync') {
            window.currentBpm = msg.tempo;
            const bpmEl = document.getElementById('live-bpm');
            if (bpmEl) bpmEl.textContent = `${msg.tempo.toFixed(1)} BPM`;
          }
        }
        if (msg.signature) {
          const sigEl = document.getElementById('live-sig');
          if (sigEl) sigEl.textContent = msg.signature;
          const sigParts = msg.signature.split('/');
          if (sigParts.length === 2) {
            window.currentNumerator = parseInt(sigParts[0]) || 4;
            window.currentDenominator = parseInt(sigParts[1]) || 4;
          }
        }
        if (msg.playheadActive !== undefined) {
          window.playheadActive = msg.playheadActive;
          window.playheadBaseTimeMs = msg.playheadTimeMs ?? 0;
          window.playheadStartTime = Date.now();
        }
      } else if (msg.type === 'playhead_state') {
        if (msg.playheadActive !== undefined) {
          window.playheadActive = msg.playheadActive;
          window.playheadBaseTimeMs = msg.playheadTimeMs ?? 0;
          window.playheadStartTime = Date.now();
        }
      } else if (msg.type === 'transport_state') {
        const state = msg.state;
        if (state) {
          if (state.locators && typeof window.updateTransportLocators === 'function') {
            window.updateTransportLocators(state.locators);
          }
          if (typeof window.updateOscStatus === 'function') {
            window.updateOscStatus(state.available, state.connected);
          }
          if (state.isPlaying !== undefined) {
            window.oscIsPlaying = state.isPlaying;
            if (typeof window.updateHeaderPlayState === 'function') {
              window.updateHeaderPlayState(state.isPlaying);
            }
            if (state.connected) {
              window.playheadActive = state.isPlaying;
              if (typeof state.currentSongTimeBeats === 'number' && typeof state.tempo === 'number') {
                const timeMs = (state.currentSongTimeBeats * 60 * 1000) / state.tempo;
                window.playheadBaseTimeMs = timeMs;
                window.playheadStartTime = Date.now();
              }
            }
          }
          if (typeof state.tempo === 'number' && state.connected && window.syncMode === 'sync') {
            window.currentBpm = state.tempo;
            const bpmEl = document.getElementById('live-bpm');
            if (bpmEl) bpmEl.textContent = `${state.tempo.toFixed(1)} BPM`;
          }
        }
      } else if (msg.type === 'beat') {
        if (typeof window.triggerMetronomePulse === 'function') {
          window.triggerMetronomePulse(msg.beat);
        }
      } else if (msg.type === 'highlight') {
        const el = document.querySelector(`[data-name="${msg.control}"]`);
        if (el) {
          el.classList.add('discovery-highlight');
          setTimeout(() => el.classList.remove('discovery-highlight'), msg.durationMs || 2000);
        }
      }
    },
  });
  sendLoop();
  maybeRequestPermissions();
  setupSensorToggles();
  setupCalibration();
  setupSensorDenoise();
  setupAudioUI();
  setupVisionUI();
  setupBattery();
  setupClientName();
})();
