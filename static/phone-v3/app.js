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
      hand: { active: false, x: 0.5, y: 0.5, z: 0, fist: false, pinch: false, victory: false, open: false, thumb: 0, index: 0, middle: 0, ring: 0, pinky: 0, fingers: 0, startX: 0.5, startY: 0.5, startZ: 0, handLostTime: 0 }
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

  let wakeLock = null;

  async function requestWakeLock() {
    if (!navigator.wakeLock || typeof navigator.wakeLock.request !== 'function') {
      return;
    }
    try {
      wakeLock = await navigator.wakeLock.request('screen');
      console.log('Wake Lock is active');
    } catch (err) {
      console.error(`Wake Lock failed: ${err.name}, ${err.message}`);
    }
  }

  // Request wake lock on first touch/click.
  const requestWakeLockOnce = async () => {
    await requestWakeLock();
    document.removeEventListener('touchstart', requestWakeLockOnce);
    document.removeEventListener('mousedown', requestWakeLockOnce);
  };
  document.addEventListener('touchstart', requestWakeLockOnce, { passive: true });
  document.addEventListener('mousedown', requestWakeLockOnce, { passive: true });

  // Handle visibility change
  document.addEventListener('visibilitychange', async () => {
    if (wakeLock !== null && document.visibilityState === 'visible') {
      await requestWakeLock();
    }
  });

  function showToast(message, type = 'info') {
    if (typeof document === 'undefined' || typeof document.createElement !== 'function') {
      console.log(`[Toast] [${type}] ${message}`);
      return;
    }
    let toastContainer = document.getElementById('toast-container');
    if (!toastContainer) {
      toastContainer = document.createElement('div');
      toastContainer.id = 'toast-container';
      toastContainer.style.position = 'fixed';
      toastContainer.style.top = '70px'; // Positioned below top tabbar
      toastContainer.style.left = '50%';
      toastContainer.style.transform = 'translateX(-50%)';
      toastContainer.style.zIndex = '9999';
      toastContainer.style.display = 'flex';
      toastContainer.style.flexDirection = 'column';
      toastContainer.style.gap = '8px';
      toastContainer.style.pointerEvents = 'none';
      document.body.appendChild(toastContainer);
    }

    const toast = document.createElement('div');
    toast.className = `toast toast-${type}`;
    toast.textContent = message;
    toast.style.padding = '6px 12px';
    toast.style.borderRadius = '4px';
    toast.style.fontSize = '10px';
    toast.style.fontWeight = 'bold';
    toast.style.color = '#fff';
    toast.style.boxShadow = '0 2px 8px rgba(0,0,0,0.5)';
    toast.style.opacity = '0';
    toast.style.transition = 'opacity 0.2s ease, transform 0.2s ease';
    toast.style.transform = 'translateY(5px)';

    if (type === 'error') {
      toast.style.background = '#ff4a4a';
    } else if (type === 'warning') {
      toast.style.background = '#ffaa00';
    } else if (type === 'success') {
      toast.style.background = '#00c853';
    } else {
      toast.style.background = '#00e5ff';
    }

    toastContainer.appendChild(toast);

    // Force reflow
    toast.offsetHeight;
    toast.style.opacity = '1';
    toast.style.transform = 'translateY(0)';

    setTimeout(() => {
      toast.style.opacity = '0';
      toast.style.transform = 'translateY(-5px)';
      setTimeout(() => {
        toast.remove();
      }, 200);
    }, 2000);
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

  window.onControl = (ctrl) => {
    if (ctrl.name) {
      if (ctrl.x !== undefined && ctrl.y !== undefined) {
        window.currentControlStates[ctrl.name + '.x'] = ctrl.x;
        window.currentControlStates[ctrl.name + '.y'] = ctrl.y;
      } else if (ctrl.value !== undefined) {
        window.currentControlStates[ctrl.name] = ctrl.value;
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

  // ---- Network (unchanged from v2) ----
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

  // ---- WebSocket (unchanged from v2) ----
  let ws = null;
  let clientId = null;
  let reconnectDelay = 1000;

  const phoneCommandCallbacks = new Map();
  let phoneCommandSeq = 0;
  let mappingModeActive = false;
  let telemetryThrottleUntil = 0;
  let lastSnapshotSentAt = 0;

  function dispatchPhoneEvent(name, detail = {}) {
    if (typeof CustomEvent !== 'undefined' && typeof window.dispatchEvent === 'function') {
      window.dispatchEvent(new CustomEvent(name, { detail }));
    } else if (typeof window.dispatchEvent === 'function') {
      try {
        window.dispatchEvent({ type: name, detail });
      } catch (e) {}
    }
  }

  function failPendingPhoneCommands(error) {
    for (const [id, cb] of phoneCommandCallbacks.entries()) {
      const response = { id, ok: false, error };
      try {
        if (typeof cb === 'function') cb(response);
      } catch (e) {}
      dispatchPhoneEvent('ableton-rc:phone-command-response', { id, response });
    }
    phoneCommandCallbacks.clear();
  }

  window.isPhoneMappingModeActive = function() {
    return mappingModeActive;
  };

  window.setPhoneMappingModeActive = function(active) {
    mappingModeActive = !!active;
    if (!mappingModeActive) telemetryThrottleUntil = 0;
  };

  window.throttlePhoneTelemetry = function(durationMs = 1500) {
    telemetryThrottleUntil = Math.max(telemetryThrottleUntil, Date.now() + durationMs);
  };

  window.getPhoneClientId = function() {
    return clientId;
  };

  window.sendPhoneCommand = function(cmd, args = {}, cb) {
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      const response = { ok: false, error: 'Not connected to server' };
      if (typeof cb === 'function') cb(response);
      dispatchPhoneEvent('ableton-rc:phone-command-response', { response });
      return false;
    }

    phoneCommandSeq += 1;
    const id = `phone-map-${phoneCommandSeq}`;
    if (typeof cb === 'function') {
      phoneCommandCallbacks.set(id, cb);
    }
    ws.send(JSON.stringify({ id, cmd, args }));
    return true;
  };



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
    if (!ws || ws.readyState !== WebSocket.OPEN || !clientId) return;
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
    ws.send(JSON.stringify({
      type: 'modulator',
      client_id: clientId,
      ts: Date.now(),
      modulator: payload,
    }));
  }

  function setStatus(text, cls) {
    const el = document.getElementById('status');
    // Hide the placeholder during handshake; show only when there is real
    // status (connected client name or a real connection problem).
    if (cls === '' && text === '\u26A1 ...') {
      el.textContent = '';
      el.className = 'status status-empty';
      el.title = '';
      return;
    }
    el.textContent = text;
    el.className = 'status ' + (cls || '');
    if (cls === 'connected') {
      el.title = 'Tap to rename';
    } else {
      el.title = '';
    }
  }

  function setupClientName() {
    const el = document.getElementById('status');
    if (!el) return;

    el.addEventListener('click', () => {
      const current = localStorage.getItem('ableton-rc:display_name') || '';
      const newName = prompt('Client name (display):', current);
      if (newName === null) return; // cancelled
      const trimmed = newName.trim();
      if (trimmed) {
        localStorage.setItem('ableton-rc:display_name', trimmed);
        setStatus(`\u26A1 ${trimmed}`, 'connected');
        // Notify server immediately
        if (ws && ws.readyState === WebSocket.OPEN && clientId) {
          ws.send(JSON.stringify({
            type: 'set_display_name',
            client_id: clientId,
            display_name: trimmed,
          }));
        }
      } else {
        localStorage.removeItem('ableton-rc:display_name');
        setStatus(`\u26A1 ${clientId ? clientId.slice(0, 8) : ''}`, 'connected');
        if (ws && ws.readyState === WebSocket.OPEN && clientId) {
          ws.send(JSON.stringify({
            type: 'set_display_name',
            client_id: clientId,
            display_name: '',
          }));
        }
      }
    });
  }

  function handlePhoneCommandResponse(msg) {
    if (!msg || typeof msg.id !== 'string') return false;
    if (!msg.id.startsWith('phone-map-')) return false;

    const cb = phoneCommandCallbacks.get(msg.id);
    phoneCommandCallbacks.delete(msg.id);
    if (typeof cb === 'function') cb(msg);
    dispatchPhoneEvent('ableton-rc:phone-command-response', { id: msg.id, response: msg });
    return true;
  }

  function connect() {
    const proto = window.location.protocol === 'https:' ? 'wss' : 'ws';
    const stored = localStorage.getItem('ableton-rc:client_id');
    const url = `${proto}://${window.location.host}/ws` + (stored ? `?client_id=${encodeURIComponent(stored)}` : '');
    ws = new WebSocket(url);
    window.phoneWs = ws;
    setStatus('\u26A1 ...', '');

    ws.onopen = () => {
      const stored = localStorage.getItem('ableton-rc:client_id');
      const displayName = localStorage.getItem('ableton-rc:display_name') || '';
      const resume = { type: 'resume', client_id: stored || null, display_name: displayName || undefined, ts: Date.now() };
      ws.send(JSON.stringify(resume));
      reconnectDelay = 1000;
      dispatchPhoneEvent('ableton-rc:phone-ws-open', { clientId: stored || null });
    };

    ws.onmessage = (e) => {
      try {
        const msg = JSON.parse(e.data);
        if (handlePhoneCommandResponse(msg)) return;
        if (msg.type === 'pong') {
          const rtt = Date.now() - msg.ts;
          state.sensors.network.rtt = rtt;
          return;
        }
        if (msg.type === 'hello') {
          clientId = msg.client_id;
          dispatchPhoneEvent('ableton-rc:phone-client-id', { clientId });
          localStorage.setItem('ableton-rc:client_id', clientId);
          const name = localStorage.getItem('ableton-rc:display_name') || clientId.slice(0, 8);
          setStatus(`\u26A1 ${name}`, 'connected');
          
          // Send display name immediately to sync with the server
          const savedName = localStorage.getItem('ableton-rc:display_name');
          if (savedName && ws && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({
              type: 'set_display_name',
              client_id: clientId,
              display_name: savedName
            }));
          }

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
            const currentMode = document.body.dataset.padMode || 'A';
            for (const [k, v] of Object.entries(msg.values)) {
              if (window.controlSetters && typeof window.controlSetters[k] === 'function') {
                try {
                  // Skip initial sync values for momentary/burst performance controls on boot
                  if (k.startsWith('pad-') && (currentMode === 'A' || currentMode === 'D')) continue;
                  if (k.startsWith('toggle-') && (currentMode === 'A' || currentMode === 'D')) continue;
                  if (k.startsWith('button-') && (currentMode === 'A' || currentMode === 'D')) continue;

                  window.controlSetters[k](v);
                  // CHANGED: Set data-active="true" when control updated from server
                  const ctrlEl = document.querySelector(`[data-name="${k}"]`);
                  if (ctrlEl) {
                    ctrlEl.dataset.active = 'true';
                    if (ctrlEl._activeTimeout) clearTimeout(ctrlEl._activeTimeout);
                    ctrlEl._activeTimeout = setTimeout(() => {
                      ctrlEl.dataset.active = 'false';
                    }, 200);
                  }
                } catch (err) {}
              }
            }
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
      } catch (err) { /* ignore */ }
    };

    ws.onclose = () => {
      setStatus(`\u26A0 ${(reconnectDelay/1000).toFixed(0)}s`, 'disconnected');
      clientId = null;
      failPendingPhoneCommands('Connection closed before command response');
      // Clear any "stuck" pad/button visual state from moment of disconnect.
      if (typeof window.resetTransientControls === 'function') {
        window.resetTransientControls();
      }
      dispatchPhoneEvent('ableton-rc:phone-ws-close', {});
      setTimeout(connect, reconnectDelay);
      reconnectDelay = Math.min(reconnectDelay * 2, 30_000);
    };

    ws.onerror = () => { /* onclose fires next */ };
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

  function sendLoop() {
    setInterval(() => {
      // Smooth-decay the hand's x/y/z back to neutral (0.5, 0.5, 0) over
      // 300ms once it stops being detected.
      // Mode B (hold) freezes the position per-axis so the performer's last
      // hand pose stays mapped until they re-enter the frame.
      if (state.vision && state.vision.enabled) {
        const h = state.vision.hand;
        if (h && !h.active) {
          const elapsed = Date.now() - h.handLostTime;
          const t = Math.min(1.0, elapsed / 300);
          // Mode B â†’ t is forced to 0 for that axis so start === current
          // and the lerp below stays put. Mode A â†’ normal lerp.
          const xT = state.visionModes.x === 'B' ? 0 : t;
          const yT = state.visionModes.y === 'B' ? 0 : t;
          const zT = state.visionModes.z === 'B' ? 0 : t;
          h.x = h.startX + (0.5 - h.startX) * xT;
          h.y = h.startY + (0.5 - h.startY) * yT;
          h.z = h.startZ + (0.0 - h.startZ) * zT;
          h.fist = false;
          h.pinch = false;
          h.victory = false;
          h.open = false;
          h.thumb = 0;
          h.index = 0;
          h.middle = 0;
          h.ring = 0;
          h.pinky = 0;
          h.fingers = 0;

          if (state.sensors.vision_reading) {
            const r = state.sensors.vision_reading;
            r.x = parseFloat(h.x.toFixed(3));
            r.y = parseFloat(h.y.toFixed(3));
            r.z = parseFloat(h.z.toFixed(3));
            r.fist = false;
            r.pinch = false;
            r.victory = false;
            r.open = false;
            r.thumb = 0;
            r.index = 0;
            r.middle = 0;
            r.ring = 0;
            r.pinky = 0;
            r.fingers = 0;
          }

          if (window.onControl) {
            const v = parseFloat(h.x.toFixed(3));
            window.onControl({ name: 'sensor.vision.x', value: v });
            window.onControl({ name: 'sensor.vision.y', value: parseFloat(h.y.toFixed(3)) });
            window.onControl({ name: 'sensor.vision.z', value: parseFloat(h.z.toFixed(3)) });
            window.onControl({ name: 'sensor.vision.fist', value: 0 });
            window.onControl({ name: 'sensor.vision.pinch', value: 0 });
            window.onControl({ name: 'sensor.vision.victory', value: 0 });
            window.onControl({ name: 'sensor.vision.open', value: 0 });
            window.onControl({ name: 'sensor.vision.thumb', value: 0 });
            window.onControl({ name: 'sensor.vision.index', value: 0 });
            window.onControl({ name: 'sensor.vision.middle', value: 0 });
            window.onControl({ name: 'sensor.vision.ring', value: 0 });
            window.onControl({ name: 'sensor.vision.pinky', value: 0 });
            window.onControl({ name: 'sensor.vision.fingers', value: 0 });
          }
        }

        // Update HUD for the single tracked hand
        const lblX = document.getElementById('lbl-vision-x');
        const lblY = document.getElementById('lbl-vision-y');
        const lblZ = document.getElementById('lbl-vision-z');
        const lblGesture = document.getElementById('lbl-vision-gesture');
        if (lblX || lblY || lblZ || lblGesture) {
          const hh = state.vision.hand;
          if (lblX) lblX.textContent = hh.x.toFixed(2);
          if (lblY) lblY.textContent = hh.y.toFixed(2);
          if (lblZ) lblZ.textContent = hh.z.toFixed(2);
          if (lblGesture) lblGesture.textContent = hh.active ? (hh.fist ? 'Fist' : (hh.pinch ? 'Pinch' : (hh.victory ? 'Victory' : (hh.open ? 'Open' : `${(hh.fingers * 5).toFixed(0)} fingers`)))) : 'Out';
        }
        renderVisionReadouts();
      }

      // Orient + motion emit (rAF drives these at display rate normally;
      // this is the always-on fallback so background tabs and slow displays
      // still see fresh values).
      emitSensorControls();

      const now = Date.now();
      const throttleActive = mappingModeActive || telemetryThrottleUntil > now;
      const minSnapshotInterval = throttleActive ? 500 : TICK_MS;
      if (now - lastSnapshotSentAt < minSnapshotInterval) return;
      lastSnapshotSentAt = now;

      if (ws && ws.readyState === WebSocket.OPEN && clientId) {
        const msg = {
          type: 'snapshot',
          client_id: clientId,
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
        ws.send(JSON.stringify(msg));
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

    setInterval(() => {
      if (ws && ws.readyState === WebSocket.OPEN && clientId) {
        ws.send(JSON.stringify({ type: 'ping', ts: Date.now() }));
      }
    }, PING_MS);
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
    const barRms = document.getElementById('bar-audio-rms');

    // Emit the audio channels at zero BEFORE the user enables the mic so
    // the admin/mappings page sees them as available mapping targets. The
    // status (state.sensors.audio) carries "inactive" until the user
    // toggles the checkbox, but the controls themselves are bound and
    // updating â€” the user can map sensor.audio.pitch to a Live parameter
    // and the mapping will start working the moment they enable the mic.
    if (window.onControl) {
      window.onControl({ name: 'sensor.audio.rms',            value: 0 });
      window.onControl({ name: 'sensor.audio.pitch',          value: 0 });
      window.onControl({ name: 'sensor.audio.bpm',            value: 0 });
      window.onControl({ name: 'sensor.audio.note',           value: 0 });
      window.onControl({ name: 'sensor.audio.clarity',        value: 0 });
      window.onControl({ name: 'sensor.audio.whistle.active', value: 0 });
      window.onControl({ name: 'sensor.audio.whistle.bend',   value: 0.5 });
      window.onControl({ name: 'sensor.audio.envelope',       value: 0 });
      window.onControl({ name: 'sensor.audio.transient',      value: 0 });
      window.onControl({ name: 'sensor.audio.gate',           value: 0 });
    }
    if (!chk) return;

    let audioProcessor = null;
    let smoothedRms = 0;
    let smoothedPitch = 0;
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

          const dispPitch = parseFloat(smoothedPitch.toFixed(1));
          const dispRms = parseFloat(smoothedRms.toFixed(3));

          if (lblPitch) lblPitch.textContent = dispPitch > 0 ? dispPitch.toFixed(1) : '--';
          if (lblNote) lblNote.textContent = data.midiNote > 0 ? midiToNoteName(data.midiNote) : '--';
          if (lblBpm) lblBpm.textContent = data.bpm > 0 ? data.bpm : '--';
          if (barRms) {
            const pct = Math.min(100, Math.round(dispRms * 250));
            barRms.style.width = pct + '%';
          }

          if (window.onControl) {
            window.onControl({ name: 'sensor.audio.rms',            value: dispRms });
            window.onControl({ name: 'sensor.audio.pitch',          value: dispPitch });
            if (data.bpm > 0) {
              window.onControl({ name: 'sensor.audio.bpm',          value: data.bpm });
            }
            window.onControl({ name: 'sensor.audio.note',           value: data.midiNote });
            window.onControl({ name: 'sensor.audio.clarity',        value: data.clarity });
            window.onControl({ name: 'sensor.audio.whistle.active', value: data.whistleActive });
            window.onControl({ name: 'sensor.audio.whistle.bend',   value: data.whistleBend });
            window.onControl({ name: 'sensor.audio.envelope',       value: data.envelope });
            window.onControl({ name: 'sensor.audio.transient',      value: data.transient });
            window.onControl({ name: 'sensor.audio.gate',           value: data.gate });
          }

          state.sensors.audio_reading = {
            pitch: dispPitch,
            midi_note: data.midiNote > 0 ? midiToNoteName(data.midiNote) : '--',
            bpm: data.bpm > 0 ? Math.round(data.bpm) : 0,
            rms: dispRms,
            note: data.midiNote,
            clarity: data.clarity,
            whistle_active: data.whistleActive,
            whistle_bend: data.whistleBend,
            envelope: data.envelope,
            transient: data.transient,
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
      if (barRms) barRms.style.width = '0%';

      if (window.onControl) {
        window.onControl({ name: 'sensor.audio.rms',            value: 0 });
        window.onControl({ name: 'sensor.audio.pitch',          value: 0 });
        window.onControl({ name: 'sensor.audio.bpm',            value: 0 });
        window.onControl({ name: 'sensor.audio.note',           value: 0 });
        window.onControl({ name: 'sensor.audio.clarity',        value: 0 });
        window.onControl({ name: 'sensor.audio.whistle.active', value: 0 });
        window.onControl({ name: 'sensor.audio.whistle.bend',   value: 0.5 });
        window.onControl({ name: 'sensor.audio.envelope',       value: 0 });
        window.onControl({ name: 'sensor.audio.transient',      value: 0 });
        window.onControl({ name: 'sensor.audio.gate',           value: 0 });
      }
    };

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
    if (h.fist) return 'Fist';
    if (h.pinch) return 'Pinch';
    if (h.victory) return 'Victory';
    if (h.open) return 'Open hand';
    return `${Math.round((h.fingers || 0) * 5)} fingers`;
  }

  function renderVisionGestureBadges(h) {
    document.querySelectorAll('[data-vision-gesture]').forEach((badge) => {
      const key = badge.dataset && badge.dataset.visionGesture;
      if (!key) return;
      let active = false;
      if (key === 'fingers') active = !!h && h.active && (h.fingers || 0) > 0;
      else active = !!h && h.active && !!h[key];
      badge.classList.toggle('active', active);
    });
  }

  function renderVisionReadouts() {
    const h = state.vision && state.vision.hand;
    if (!h) return;

    const position = `${h.x.toFixed(2)} / ${h.y.toFixed(2)} / ${h.z.toFixed(2)}`;
    const gesture = getVisionGestureLabel(h);
    const lblX = document.getElementById('lbl-vision-x');
    const lblY = document.getElementById('lbl-vision-y');
    const lblZ = document.getElementById('lbl-vision-z');
    const lblGesture = document.getElementById('lbl-vision-gesture');
    const cardPosition = document.getElementById('vision-card-position');
    const cardGesture = document.getElementById('vision-card-gesture');

    if (lblX) lblX.textContent = h.x.toFixed(2);
    if (lblY) lblY.textContent = h.y.toFixed(2);
    if (lblZ) lblZ.textContent = h.z.toFixed(2);
    if (lblGesture) lblGesture.textContent = gesture;
    if (cardPosition) cardPosition.textContent = position;
    if (cardGesture) cardGesture.textContent = gesture;
    renderVisionGestureBadges(h);
  }

  function renderVisionColorReadout(data) {
    const colorLabel = document.getElementById('vision-card-color');
    const swatch = document.getElementById('vision-card-color-swatch');
    if (!data) {
      if (colorLabel) colorLabel.textContent = '--';
      if (swatch) swatch.style.backgroundColor = '';
      return null;
    }

    const r255 = Math.round(data.r * 255);
    const g255 = Math.round(data.g * 255);
    const b255 = Math.round(data.b * 255);
    const rgb = `rgb(${r255}, ${g255}, ${b255})`;
    if (colorLabel) colorLabel.textContent = `${r255}, ${g255}, ${b255}`;
    if (swatch) swatch.style.backgroundColor = rgb;
    return { r255, g255, b255, rgb };
  }

  function setupVisionHudControls() {
    const hud = document.getElementById('vision-hud');
    if (!hud) return;

    const positionKey = 'ableton-rc:vision-hud-position';
    const minimizedKey = 'ableton-rc:vision-hud-minimized';
    let drag = null;
    let lastTapAt = 0;

    function clampHudPosition(x, y) {
      const rect = hud.getBoundingClientRect();
      const width = rect.width || 148;
      const height = rect.height || 120;
      const maxX = Math.max(0, window.innerWidth - width - 8);
      const maxY = Math.max(0, window.innerHeight - height - 8);
      return {
        x: Math.max(8, Math.min(x, maxX)),
        y: Math.max(8, Math.min(y, maxY)),
      };
    }

    function applyHudPosition(x, y, persist) {
      const pos = clampHudPosition(x, y);
      hud.style.left = `${Math.round(pos.x)}px`;
      hud.style.top = `${Math.round(pos.y)}px`;
      hud.style.right = 'auto';
      hud.style.bottom = 'auto';
      if (persist) {
        try {
          localStorage.setItem(positionKey, JSON.stringify(pos));
        } catch (e) {}
      }
    }

    function setHudMinimized(minimized, persist = true) {
      hud.classList.toggle('minimized', minimized);
      hud.dataset.visionHudMinimized = minimized ? 'true' : 'false';
      if (persist) {
        try {
          localStorage.setItem(minimizedKey, minimized ? 'true' : 'false');
        } catch (e) {}
      }
      requestAnimationFrame(() => {
        const rect = hud.getBoundingClientRect();
        applyHudPosition(rect.left, rect.top, persist);
      });
    }

    function toggleHudMinimized() {
      setHudMinimized(!hud.classList.contains('minimized'));
    }

    try {
      const savedPosition = JSON.parse(localStorage.getItem(positionKey) || 'null');
      if (savedPosition && typeof savedPosition.x === 'number' && typeof savedPosition.y === 'number') {
        applyHudPosition(savedPosition.x, savedPosition.y, false);
      }
      setHudMinimized(localStorage.getItem(minimizedKey) === 'true', false);
    } catch (e) {}

    hud.addEventListener('pointerdown', (event) => {
      if (event.button !== undefined && event.button !== 0) return;
      event.preventDefault();
      event.stopPropagation();
      const rect = hud.getBoundingClientRect();
      drag = {
        pointerId: event.pointerId,
        offsetX: event.clientX - rect.left,
        offsetY: event.clientY - rect.top,
        startX: event.clientX,
        startY: event.clientY,
        moved: false,
      };
      hud.setAttribute('data-vision-hud-dragging', 'true');
      if (hud.setPointerCapture) {
        try { hud.setPointerCapture(event.pointerId); } catch (e) {}
      }
    });

    window.addEventListener('pointermove', (event) => {
      if (!drag || event.pointerId !== drag.pointerId) return;
      event.preventDefault();
      if (Math.abs(event.clientX - drag.startX) > 3 || Math.abs(event.clientY - drag.startY) > 3) {
        drag.moved = true;
      }
      applyHudPosition(event.clientX - drag.offsetX, event.clientY - drag.offsetY, false);
    });

    function endDrag(event) {
      if (!drag || event.pointerId !== drag.pointerId) return;
      event.preventDefault();
      const moved = drag.moved;
      drag = null;
      hud.removeAttribute('data-vision-hud-dragging');
      if (hud.releasePointerCapture) {
        try { hud.releasePointerCapture(event.pointerId); } catch (e) {}
      }
      const rect = hud.getBoundingClientRect();
      applyHudPosition(rect.left, rect.top, true);
      if (moved) {
        lastTapAt = 0;
        return;
      }
      const now = Date.now();
      if (now - lastTapAt < 320) {
        toggleHudMinimized();
        lastTapAt = 0;
      } else {
        lastTapAt = now;
      }
    }

    window.addEventListener('pointerup', endDrag);
    window.addEventListener('pointercancel', endDrag);
  }

  function setupVisionUI() {
    const chk = document.getElementById('chk-vision-enable');
    const hud = document.getElementById('vision-hud');
    const video = document.getElementById('vision-video');
    const canvas = document.getElementById('vision-canvas');
    const lblX = document.getElementById('lbl-vision-x');
    const lblY = document.getElementById('lbl-vision-y');
    const lblZ = document.getElementById('lbl-vision-z');
    const lblGesture = document.getElementById('lbl-vision-gesture');

    // Same pattern as audio: emit the vision channels at zero BEFORE the
    // user enables the camera. Lets the user bind sensor.vision.* channels
    // to a Live parameter in advance; the mapping starts working the
    // moment the camera is enabled.
    if (window.onControl) {
      window.onControl({ name: 'sensor.vision.active', value: 0 });
      window.onControl({ name: 'sensor.vision.x',      value: 0.5 });
      window.onControl({ name: 'sensor.vision.y',      value: 0.5 });
      window.onControl({ name: 'sensor.vision.z',      value: 0 });
      window.onControl({ name: 'sensor.vision.fist',   value: 0 });
      window.onControl({ name: 'sensor.vision.pinch',  value: 0 });
      window.onControl({ name: 'sensor.vision.victory',value: 0 });
      window.onControl({ name: 'sensor.vision.open',   value: 0 });
      window.onControl({ name: 'sensor.vision.thumb',  value: 0 });
      window.onControl({ name: 'sensor.vision.index',  value: 0 });
      window.onControl({ name: 'sensor.vision.middle', value: 0 });
      window.onControl({ name: 'sensor.vision.ring',   value: 0 });
      window.onControl({ name: 'sensor.vision.pinky',  value: 0 });
      window.onControl({ name: 'sensor.vision.fingers',value: 0 });
      window.onControl({ name: 'sensor.vision.color.r', value: 0 });
      window.onControl({ name: 'sensor.vision.color.g', value: 0 });
      window.onControl({ name: 'sensor.vision.color.b', value: 0 });
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

    let visionProcessor = null;

    const startVision = async () => {
      state.vision.enabled = true;
      const h = state.vision.hand;
      h.active = false;
      h.x = 0.5;
      h.y = 0.5;
      h.z = 0.0;
      h.fist = false;
      h.pinch = false;
      h.victory = false;
      h.open = false;
      h.thumb = 0;
      h.index = 0;
      h.middle = 0;
      h.ring = 0;
      h.pinky = 0;
      h.fingers = 0;
      if (!visionProcessor) {
        visionProcessor = new window.VisionProcessor();

        // Apply a hand reading onto state, vision_reading payload, HUD,
        // and the wire. Returns true if the hand was newly activated (so the
        // caller can distinguish "first frame after a gap" from "ongoing").
        function applyHandReading(data) {
          const h = state.vision.hand;
          const wasActive = h.active;
          h.active = true;

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

          h.x = data.x;
          h.y = data.y;
          h.z = data.z;
          h.fist = data.fist;
          h.pinch = data.pinch;
          h.victory = data.victory;
          h.open = data.open;
          h.thumb = data.thumb;
          h.index = data.index;
          h.middle = data.middle;
          h.ring = data.ring;
          h.pinky = data.pinky;
          h.fingers = data.fingers;

          if (!state.sensors.vision_reading) state.sensors.vision_reading = {};
          Object.assign(state.sensors.vision_reading, data);
          renderVisionReadouts();

          if (lblX) lblX.textContent = h.x.toFixed(2);
          if (lblY) lblY.textContent = h.y.toFixed(2);
          if (lblZ) lblZ.textContent = h.z.toFixed(2);
          if (lblGesture) lblGesture.textContent = h.fist ? 'Fist' : (h.pinch ? 'Pinch' : (h.victory ? 'Victory' : (h.open ? 'Open' : `${(h.fingers * 5).toFixed(0)} fingers`)));

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
            window.onControl({ name: 'sensor.vision.fist', value: gestureValue('fist') });
            // Pinch is special: it carries the analog pinchVal (0.0â€“1.0) in
            // mode A so the wire exposes the continuous control surface. Mode
            // C replaces it with the latched toggle.
            if (state.visionModes.pinch === 'C') {
              window.onControl({ name: 'sensor.vision.pinch', value: state.visionToggle.pinch });
            } else {
              window.onControl({ name: 'sensor.vision.pinch', value: data.pinchVal ?? 0 });
            }
            window.onControl({ name: 'sensor.vision.victory', value: gestureValue('victory') });
            window.onControl({ name: 'sensor.vision.open', value: gestureValue('open') });
            window.onControl({ name: 'sensor.vision.thumb', value: data.thumb });
            window.onControl({ name: 'sensor.vision.index', value: data.index });
            window.onControl({ name: 'sensor.vision.middle', value: data.middle });
            window.onControl({ name: 'sensor.vision.ring', value: data.ring });
            window.onControl({ name: 'sensor.vision.pinky', value: data.pinky });
            window.onControl({ name: 'sensor.vision.fingers', value: data.fingers });
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
          // For x/y/z in mode B we freeze the position on hand-loss: skip
          // capturing startX/Y/Z (so the decay loop sees h.x === h.startX,
          // â†’ t=0 â†’ no drift). Per-axis check so e.g. mode B on X but A on
          // Y still lets Y decay.
          if (state.visionModes.x !== 'B') h.startX = h.x;
          if (state.visionModes.y !== 'B') h.startY = h.y;
          if (state.visionModes.z !== 'B') h.startZ = h.z;
          h.handLostTime = Date.now();
          if (state.visionPrev) {
            state.visionPrev.fist = 0;
            state.visionPrev.pinch = 0;
            state.visionPrev.victory = 0;
            state.visionPrev.open = 0;
          }
          if (state.sensors.vision_reading) {
            state.sensors.vision_reading.active = false;
          }
          renderVisionReadouts();
          if (window.onControl) {
            window.onControl({ name: 'sensor.vision.active', value: 0 });
          }
        }

        visionProcessor.onHandUpdate = (handData) => {
          if (handData && handData.active) {
            applyHandReading(handData);
          } else {
            markHandLost();
          }
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
      try {
        hud.classList.remove('hidden');
        await visionProcessor.start(video, canvas);
        state.sensors.vision = 'available';
      } catch (err) {
        console.error('Failed to start vision processor:', err);
        state.sensors.vision = 'error';
        chk.checked = false;
        hud.classList.add('hidden');
        alert("Could not access the camera. Make sure you:\n1. Grant camera permission to the site.\n2. Open this page in your phone's native browser (Safari or Chrome), and NOT inside QR Code readers or social network apps (Instagram, Telegram, etc.) that block WebRTC.");
      }
    };

    const stopVision = () => {
      if (visionProcessor) {
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
      h.z = 0.0;
      h.fist = false;
      h.pinch = false;
      h.victory = false;
      h.open = false;
      h.thumb = 0;
      h.index = 0;
      h.middle = 0;
      h.ring = 0;
      h.pinky = 0;
      h.fingers = 0;
      hud.classList.add('hidden');
      hud.style.borderColor = '';
      hud.style.boxShadow = '';
      if (lblX) lblX.textContent = '--';
      if (lblY) lblY.textContent = '--';
      if (lblZ) lblZ.textContent = '--';
      if (lblGesture) lblGesture.textContent = '--';
      renderVisionReadouts();
      renderVisionColorReadout(null);

      if (window.onControl) {
        window.onControl({ name: 'sensor.vision.active', value: 0 });
        window.onControl({ name: 'sensor.vision.x', value: 0.5 });
        window.onControl({ name: 'sensor.vision.y', value: 0.5 });
        window.onControl({ name: 'sensor.vision.z', value: 0.0 });
        window.onControl({ name: 'sensor.vision.fist', value: 0 });
        window.onControl({ name: 'sensor.vision.pinch', value: 0 });
        window.onControl({ name: 'sensor.vision.victory', value: 0 });
        window.onControl({ name: 'sensor.vision.open', value: 0 });
        window.onControl({ name: 'sensor.vision.thumb', value: 0 });
        window.onControl({ name: 'sensor.vision.index', value: 0 });
        window.onControl({ name: 'sensor.vision.middle', value: 0 });
        window.onControl({ name: 'sensor.vision.ring', value: 0 });
        window.onControl({ name: 'sensor.vision.pinky', value: 0 });
        window.onControl({ name: 'sensor.vision.fingers', value: 0 });
      }
    };

    chk.checked = false;

    chk.addEventListener('change', () => {
      if (chk.checked) {
        startVision();
      } else {
        stopVision();
      }
    });
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

  connect();
  sendLoop();
  maybeRequestPermissions();
  setupSensorToggles();
  setupCalibration();
  setupSensorDenoise();
  setupAudioUI();
  setupVisionHudControls();
  setupVisionUI();
  setupBattery();
  setupClientName();
})();
