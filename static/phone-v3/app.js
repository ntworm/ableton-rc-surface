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

  let initialOffsets = { matrix: null, active: false };
  try {
    const saved = localStorage.getItem('ableton-rc:sensor_ref_matrix');
    if (saved) {
      initialOffsets = { matrix: JSON.parse(saved), active: true };
    }
  } catch (e) {}

  let madgwickFilter = null;

  // Per-sensor status tags + live readings + always-on diagnostic
  // (context, network). Status is the closed set from server/protocol.py.
  const state = {
    controls: [],
    touches: [],
    motion: null,
    orient: null,
    light: null,
    offsets: initialOffsets,
    sensors: {
      motion: 'unknown',
      orientation: 'unknown',
      light: 'unknown',
      motion_reading: null,
      orientation_reading: null,
      orientation_reading_raw: null,
      light_reading: null,
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
  };

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

  // Request wake lock on first touch/click
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

  function triggerHaptic(patternType) {
    if (!window.hapticSettings || !window.hapticSettings.enabled) return;
    if (!navigator.vibrate) return;

    const profile = window.hapticSettings.profile || 'standard';
    let duration = 30; // standard default
    if (patternType === 'gentle') duration = 10;
    else if (patternType === 'heavy') duration = 80;
    else if (patternType === 'metronome') duration = 15;
    else if (patternType === 'error') duration = [100, 50, 100];
    else if (typeof patternType === 'number') duration = patternType;
    else if (Array.isArray(patternType)) duration = patternType;
    
    // Scale or adjust based on profile setting
    if (typeof duration === 'number') {
      if (profile === 'gentle') {
        duration = Math.max(5, Math.round(duration * 0.5));
      } else if (profile === 'heavy') {
        duration = Math.round(duration * 2);
      }
    } else if (Array.isArray(duration)) {
      if (profile === 'gentle') {
        duration = duration.map(d => Math.max(5, Math.round(d * 0.5)));
      } else if (profile === 'heavy') {
        duration = duration.map(d => Math.round(d * 2));
      }
    }

    try {
      navigator.vibrate(duration);
    } catch (e) {}
  }

  // Test-only hook: expose the state so Playwright tests can inject
  // realistic sensor readings without going through the real browser APIs.
  if (typeof window !== 'undefined') {
    window.__abletonRc = {
      state,
      triggerHaptic,
      requestWakeLock,
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

  let initialPinchDistance = null;
  let initialPinchAngle = null;

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

    // Two-finger gesture tracking
    if (e.touches.length === 2) {
      const t1 = e.touches[0];
      const t2 = e.touches[1];
      const dx = t2.clientX - t1.clientX;
      const dy = t2.clientY - t1.clientY;
      const dist = Math.sqrt(dx * dx + dy * dy);
      const angle = Math.atan2(dy, dx);

      if (initialPinchDistance === null) {
        initialPinchDistance = dist;
        initialPinchAngle = angle;
      } else {
        const scale = dist / initialPinchDistance;
        const rotation = angle - initialPinchAngle;
        
        const pinchVal = Math.max(0, Math.min(1, scale / 2));
        let normRotation = (rotation + Math.PI) / (2 * Math.PI);
        if (normRotation < 0) normRotation += 1;
        normRotation = Math.max(0, Math.min(1, normRotation));

        if (window.onControl) {
          window.onControl({ name: 'gesture.pinch', value: pinchVal });
          window.onControl({ name: 'gesture.rotate', value: normRotation });
        }
      }
    } else {
      initialPinchDistance = null;
      initialPinchAngle = null;
    }
  };
  document.addEventListener('touchstart', touchHandler, { passive: true });
  document.addEventListener('touchmove', touchHandler, { passive: true });
  document.addEventListener('touchend', touchHandler, { passive: true });
  document.addEventListener('touchcancel', touchHandler, { passive: true });

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
        const aig = buildVec(a);
        const rot = buildVec(r);
        state.motion = {
          ax: axis(a.x), ay: axis(a.y), az: axis(a.z),
          gx: axis(r.alpha), gy: axis(r.beta), gz: axis(r.gamma),
          interval: axis(e.interval),
        };
        state.sensors.motion_reading = {
          acceleration: buildVec(accel),
          acceleration_including_gravity: aig,
          rotation_rate: rot,
          interval: axis(e.interval),
        };

        const hasA = a && a.x !== null && a.x !== undefined;
        const hasR = r && r.alpha !== null && r.alpha !== undefined;
        if (window.Madgwick && hasA && hasR) {
          const dt = (e.interval || 16.6) / 1000.0;
          if (!madgwickFilter) {
            madgwickFilter = new window.Madgwick(dt, 0.1);
          } else {
            madgwickFilter.sampleInterval = dt;
          }

          // Convert gyro rates from deg/s to rad/s
          const d2r = Math.PI / 180;
          const gx = (r.alpha || 0) * d2r;
          const gy = (r.beta || 0) * d2r;
          const gz = (r.gamma || 0) * d2r;

          // Update Madgwick IMU algorithm
          madgwickFilter.updateIMU(gx, gy, gz, a.x, a.y, a.z);

          // Get fused Euler angles
          const fused = madgwickFilter.getEulerAngles();

          // Overwrite orient state with fused orientation
          state.orient = {
            alpha: fused.alpha,
            beta: fused.beta,
            gamma: fused.gamma,
          };
          state.sensors.orientation_reading = {
            alpha: fused.alpha,
            beta: fused.beta,
            gamma: fused.gamma,
            absolute: false,
          };
          if (state.sensors.orientation !== 'available') {
            state.sensors.orientation = 'available';
          }
          
          // Render level bubble if element is present
          const bubble = document.getElementById('level-bubble');
          if (bubble) {
            const pitch = Math.max(-45, Math.min(45, fused.beta));
            const roll = Math.max(-45, Math.min(45, fused.gamma));
            const tx = (roll / 45) * 50;
            const ty = (pitch / 45) * 50; 
            bubble.style.transform = `translate(${tx.toFixed(1)}px, ${ty.toFixed(1)}px)`;
          }
        }
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

        // Always capture raw orientation so calibration (calibrateHorizon)
        // can compute a reference matrix. Previously this was gated on
        // !madgwickFilter, which meant the calibrate button silently failed
        // whenever Madgwick was active (the common case).
        state.sensors.orientation_reading_raw = {
          alpha: rawAlpha,
          beta: rawBeta,
          gamma: rawGamma,
          absolute: axis(e.absolute),
        };

        // When Madgwick is active, devicemotion writes state.orient from the
        // fused Euler angles; skip the relative-matrix calculation here to
        // avoid double-writing the orientation.
        if (madgwickFilter) return;

        let angle = 0;
        if (typeof window !== 'undefined') {
          if (window.orientation !== undefined) angle = window.orientation;
          else if (window.screen && window.screen.orientation) angle = window.screen.orientation.angle;
        }

        const Rs_curr = getScreenMatrix(rawAlpha, rawBeta, rawGamma, angle);

        let Rs_ref;
        if (state.offsets.active && state.offsets.matrix) {
          Rs_ref = state.offsets.matrix;
        } else {
          // Default reference matrix based on screen orientation
          let defA = 0, defB = 0, defG = 0;
          if (angle === 90) {
            defA = 0; defB = 0; defG = -90;
          } else if (angle === -90 || angle === 270) {
            defA = 0; defB = 0; defG = 90;
          } else {
            defA = 0; defB = 90; defG = 0;
          }
          Rs_ref = getScreenMatrix(defA, defB, defG, angle);
        }

        const R_rel = multiply(transpose(Rs_ref), Rs_curr);
        const extracted = extractEulerAngles(R_rel);

        const adjAlpha = extracted.alpha;
        const adjBeta = -extracted.beta; // invert pitch so pointing up is positive
        const adjGamma = extracted.gamma;

        state.orient = {
          alpha: adjAlpha, beta: adjBeta, gamma: adjGamma,
        };
        state.sensors.orientation_reading = {
          alpha: adjAlpha,
          beta: adjBeta,
          gamma: adjGamma,
          absolute: axis(e.absolute),
        };

        const bubble = document.getElementById('level-bubble');
        if (bubble) {
          const pitch = Math.max(-45, Math.min(45, adjBeta));
          const roll = Math.max(-45, Math.min(45, adjGamma));
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

  function setStatus(text, cls) {
    const el = document.getElementById('status');
    el.textContent = text;
    el.className = 'status ' + (cls || '');
  }

  function updateDisplayNameUI() {
    const el = document.getElementById('client-display-name');
    if (!el) return;
    const saved = localStorage.getItem('ableton-rc:display_name');
    if (saved) {
      el.textContent = saved;
    } else if (clientId) {
      el.textContent = clientId.slice(0, 8);
    }
  }

  function setupClientName() {
    const el = document.getElementById('client-display-name');
    if (!el) return;
    const saved = localStorage.getItem('ableton-rc:display_name');
    if (saved) el.textContent = saved;

    el.addEventListener('click', () => {
      const current = localStorage.getItem('ableton-rc:display_name') || '';
      const newName = prompt('Nome do cliente (display):', current);
      if (newName === null) return; // cancelled
      const trimmed = newName.trim();
      if (trimmed) {
        localStorage.setItem('ableton-rc:display_name', trimmed);
        el.textContent = trimmed;
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
        el.textContent = clientId ? clientId.slice(0, 8) : '';
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

  function connect() {
    const proto = window.location.protocol === 'https:' ? 'wss' : 'ws';
    const stored = localStorage.getItem('ableton-rc:client_id');
    const url = `${proto}://${window.location.host}/ws` + (stored ? `?client_id=${encodeURIComponent(stored)}` : '');
    ws = new WebSocket(url);
    window.phoneWs = ws;
    setStatus('⚡ …', '');

    ws.onopen = () => {
      const stored = localStorage.getItem('ableton-rc:client_id');
      const displayName = localStorage.getItem('ableton-rc:display_name') || '';
      const resume = { type: 'resume', client_id: stored || null, display_name: displayName || undefined, ts: Date.now() };
      ws.send(JSON.stringify(resume));
      reconnectDelay = 1000;
    };

    ws.onmessage = (e) => {
      try {
        const msg = JSON.parse(e.data);
        if (msg.type === 'hello') {
          clientId = msg.client_id;
          localStorage.setItem('ableton-rc:client_id', clientId);
          setStatus(`⚡ ${clientId.slice(0, 8)}`, 'connected');
          updateDisplayNameUI();
          if (typeof msg.tempo === 'number') {
            window.currentBpm = msg.tempo;
            const bpmEl = document.getElementById('live-bpm');
            if (bpmEl) bpmEl.textContent = `${msg.tempo.toFixed(1)} BPM`;
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
          if (msg.scale) {
            const scaleEl = document.getElementById('live-scale');
            if (scaleEl) scaleEl.textContent = `Scale: ${msg.scale}`;
          }
          if (msg.playheadActive !== undefined) {
            window.playheadActive = msg.playheadActive;
            window.playheadBaseTimeMs = msg.playheadTimeMs ?? 0;
            window.playheadStartTime = Date.now();
            const btn = document.getElementById('btn-play-sim');
            if (btn) {
              btn.textContent = window.playheadActive ? '||' : '▶';
              btn.classList.toggle('playing', window.playheadActive);
            }
          }
          if (msg.values && typeof msg.values === 'object') {
            for (const [k, v] of Object.entries(msg.values)) {
              if (window.controlSetters && typeof window.controlSetters[k] === 'function') {
                try {
                  window.controlSetters[k](v);
                } catch (err) {}
              }
            }
          }
        } else if (msg.type === 'tempo') {
          if (typeof msg.tempo === 'number') {
            window.currentBpm = msg.tempo;
            const bpmEl = document.getElementById('live-bpm');
            if (bpmEl) bpmEl.textContent = `${msg.tempo.toFixed(1)} BPM`;
          }
        } else if (msg.type === 'live_state') {
          if (typeof msg.tempo === 'number') {
            window.currentBpm = msg.tempo;
            const bpmEl = document.getElementById('live-bpm');
            if (bpmEl) bpmEl.textContent = `${msg.tempo.toFixed(1)} BPM`;
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
          if (msg.scale) {
            const scaleEl = document.getElementById('live-scale');
            if (scaleEl) scaleEl.textContent = `Scale: ${msg.scale}`;
          }
          if (msg.playheadActive !== undefined) {
            window.playheadActive = msg.playheadActive;
            window.playheadBaseTimeMs = msg.playheadTimeMs ?? 0;
            window.playheadStartTime = Date.now();
            const btn = document.getElementById('btn-play-sim');
            if (btn) {
              btn.textContent = window.playheadActive ? '||' : '▶';
              btn.classList.toggle('playing', window.playheadActive);
            }
          }
        } else if (msg.type === 'playhead_state') {
          if (msg.playheadActive !== undefined) {
            window.playheadActive = msg.playheadActive;
            window.playheadBaseTimeMs = msg.playheadTimeMs ?? 0;
            window.playheadStartTime = Date.now();
            const btn = document.getElementById('btn-play-sim');
            if (btn) {
              btn.textContent = window.playheadActive ? '||' : '▶';
              btn.classList.toggle('playing', window.playheadActive);
            }
          }
        } else if (msg.type === 'haptic_vibrate') {
          triggerHaptic(msg.pattern || 'standard');
        }
      } catch (err) { /* ignore */ }
    };

    ws.onclose = () => {
      setStatus(`⚠ ${(reconnectDelay/1000).toFixed(0)}s`, 'disconnected');
      clientId = null;
      setTimeout(connect, reconnectDelay);
      reconnectDelay = Math.min(reconnectDelay * 2, 30_000);
    };

    ws.onerror = () => { /* onclose fires next */ };
  }

  function sendLoop() {
    setInterval(() => {
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
            light: state.light,
            sensors: state.sensors,
            network: state.sensors.network,
          },
        };
        ws.send(JSON.stringify(msg));
        renderDebug(msg.data);
        renderSensorReadout();
      }
    }, TICK_MS);

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

  function renderDebug(d) {
    const s = d.sensors || {};
    const ctx = s.context || {};
    const net = s.network || {};
    const mR = s.motion_reading || null;
    const oR = s.orientation_reading || null;

    const aig = mR && mR.acceleration_including_gravity;
    const rot = mR && mR.rotation_rate;
    const intervalSeg = (mR && mR.interval !== null && mR.interval !== undefined)
      ? ` Δ${fmtNum(mR.interval, 0)}ms` : '';
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
    el.textContent = line.length > DEBUG_LEN ? line.slice(0, DEBUG_LEN - 1) + '…' : line;
  }

  // ---- Sensor readout on Sensors page ----
  function renderSensorReadout() {
    const m = state.sensors.motion_reading;
    const o = state.sensors.orientation_reading;

    function setVal(sel, v, decimals = 2) {
      const el = document.querySelector(sel);
      if (!el) return;
      el.textContent = (v === null || v === undefined || Number.isNaN(v)) ? '-' : v.toFixed(decimals);
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
    if (state.offsets.active) {
      resetBtn.classList.remove('hidden');
    } else {
      resetBtn.classList.add('hidden');
    }
  }

  function calibrateHorizon() {
    // Reset the Madgwick filter so the current physical orientation becomes
    // the new (0,0,0) reference. Without this, calibration only touched the
    // raw-orientation path; the values you see in the sensors panel come
    // from Madgwick (when active), so they would not move.
    if (madgwickFilter) {
      const dt = madgwickFilter.sampleInterval || 0.0166;
      madgwickFilter = new window.Madgwick(dt, 0.1);
    }

    // Also save a reference matrix for the raw-orientation path (used when
    // Madgwick is off), keeping both paths in sync.
    const raw = state.sensors.orientation_reading_raw;
    if (raw && raw.alpha !== null && raw.beta !== null && raw.gamma !== null) {
      let angle = 0;
      if (typeof window !== 'undefined') {
        if (window.orientation !== undefined) angle = window.orientation;
        else if (window.screen && window.screen.orientation) angle = window.screen.orientation.angle;
      }
      const matrix = getScreenMatrix(raw.alpha, raw.beta, raw.gamma, angle);
      state.offsets.matrix = matrix;
      state.offsets.active = true;
      try {
        localStorage.setItem('ableton-rc:sensor_ref_matrix', JSON.stringify(matrix));
      } catch (e) {}
    }

    updateCalibrationButtons();

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

    if (navigator.vibrate) navigator.vibrate(50);
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
      state.offsets.matrix = null;
      state.offsets.active = false;
      try {
        localStorage.removeItem('ableton-rc:sensor_ref_matrix');
      } catch (e) {}
      updateCalibrationButtons();
      if (navigator.vibrate) navigator.vibrate(30);
    });
  }

  function setupHapticsUI() {
    const chk = document.getElementById('chk-haptics-enable');
    const sel = document.getElementById('sel-haptics-profile');
    if (!chk || !sel) return;

    try {
      const savedEnabled = localStorage.getItem('ableton-rc:haptics_enabled');
      if (savedEnabled !== null) {
        chk.checked = savedEnabled === 'true';
      } else {
        chk.checked = false;
      }
      const savedProfile = localStorage.getItem('ableton-rc:haptics_profile');
      if (savedProfile !== null) {
        sel.value = savedProfile;
      }
    } catch (e) {}

    window.hapticSettings = {
      enabled: chk.checked,
      profile: sel.value,
    };

    chk.addEventListener('change', () => {
      window.hapticSettings.enabled = chk.checked;
      try {
        localStorage.setItem('ableton-rc:haptics_enabled', chk.checked);
      } catch (e) {}
    });

    sel.addEventListener('change', () => {
      window.hapticSettings.profile = sel.value;
      try {
        localStorage.setItem('ableton-rc:haptics_profile', sel.value);
      } catch (e) {}
    });
  }

  function setupAudioUI() {
    const chk = document.getElementById('chk-audio-enable');
    const lblPitch = document.getElementById('lbl-audio-pitch');
    const lblNote = document.getElementById('lbl-audio-note');
    const lblBpm = document.getElementById('lbl-audio-bpm');
    const barRms = document.getElementById('bar-audio-rms');
    if (!chk) return;

    let audioProcessor = null;

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
          if (lblPitch) lblPitch.textContent = data.pitch > 0 ? data.pitch.toFixed(1) : '--';
          if (lblNote) lblNote.textContent = data.midiNote > 0 ? midiToNoteName(data.midiNote) : '--';
          if (lblBpm) lblBpm.textContent = data.bpm > 0 ? data.bpm : '--';
          if (barRms) {
            const pct = Math.min(100, Math.round(data.rms * 250));
            barRms.style.width = pct + '%';
          }

          if (window.onControl) {
            window.onControl({ name: 'sensor.audio.rms', value: data.rms });
            window.onControl({ name: 'sensor.audio.pitch', value: data.pitch });
            if (data.bpm > 0) {
              window.onControl({ name: 'sensor.audio.bpm', value: data.bpm });
            }
          }

          if (data.bpm > 0) {
            window.currentBpm = data.bpm;
            const bpmEl = document.getElementById('live-bpm');
            if (bpmEl) bpmEl.textContent = `${data.bpm.toFixed(1)} BPM (Audio)`;
          }
        };
      }
      try {
        await audioProcessor.start();
      } catch (err) {
        console.error('Failed to start audio processor:', err);
        chk.checked = false;
        try {
          localStorage.setItem('ableton-rc:audio_enabled', false);
        } catch (e) {}
      }
    };

    const stopAudio = () => {
      if (audioProcessor) {
        audioProcessor.stop();
        audioProcessor = null;
      }
      if (lblPitch) lblPitch.textContent = '--';
      if (lblNote) lblNote.textContent = '--';
      if (lblBpm) lblBpm.textContent = '--';
      if (barRms) barRms.style.width = '0%';
    };

    try {
      const savedEnabled = localStorage.getItem('ableton-rc:audio_enabled');
      if (savedEnabled === 'true') {
        chk.checked = true;
        const initOnInteraction = () => {
          if (chk.checked) {
            startAudio();
          }
          document.removeEventListener('touchstart', initOnInteraction);
          document.removeEventListener('mousedown', initOnInteraction);
        };
        document.addEventListener('touchstart', initOnInteraction, { passive: true });
        document.addEventListener('mousedown', initOnInteraction, { passive: true });
      } else {
        chk.checked = false;
      }
    } catch (e) {}

    chk.addEventListener('change', () => {
      try {
        localStorage.setItem('ableton-rc:audio_enabled', chk.checked);
      } catch (e) {}
      if (chk.checked) {
        startAudio();
      } else {
        stopAudio();
      }
    });
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
    if (!chk || !video || !canvas || !hud) return;

    let visionProcessor = null;

    const startVision = async () => {
      if (!visionProcessor) {
        visionProcessor = new window.VisionProcessor();
        visionProcessor.onHandUpdate = (data) => {
          if (lblX) lblX.textContent = data.x.toFixed(2);
          if (lblY) lblY.textContent = data.y.toFixed(2);
          if (lblZ) lblZ.textContent = data.z.toFixed(2);
          if (lblGesture) lblGesture.textContent = data.isFist ? 'Punho' : 'Aberta';

          if (window.onControl) {
            window.onControl({ name: 'sensor.vision.hand.x', value: data.x });
            window.onControl({ name: 'sensor.vision.hand.y', value: data.y });
            window.onControl({ name: 'sensor.vision.hand.z', value: data.z });
            window.onControl({ name: 'sensor.vision.hand.fist', value: data.isFist ? 1 : 0 });
          }
        };
      }
      try {
        hud.classList.remove('hidden');
        await visionProcessor.start(video, canvas);
      } catch (err) {
        console.error('Failed to start vision processor:', err);
        chk.checked = false;
        try {
          localStorage.setItem('ableton-rc:vision_enabled', false);
        } catch (e) {}
        hud.classList.add('hidden');
      }
    };

    const stopVision = () => {
      if (visionProcessor) {
        visionProcessor.stop();
        visionProcessor = null;
      }
      hud.classList.add('hidden');
      if (lblX) lblX.textContent = '--';
      if (lblY) lblY.textContent = '--';
      if (lblZ) lblZ.textContent = '--';
      if (lblGesture) lblGesture.textContent = '--';
    };

    try {
      const savedEnabled = localStorage.getItem('ableton-rc:vision_enabled');
      if (savedEnabled === 'true') {
        chk.checked = true;
        const initOnInteraction = () => {
          if (chk.checked) {
            startVision();
          }
          document.removeEventListener('touchstart', initOnInteraction);
          document.removeEventListener('mousedown', initOnInteraction);
        };
        document.addEventListener('touchstart', initOnInteraction, { passive: true });
        document.addEventListener('mousedown', initOnInteraction, { passive: true });
      } else {
        chk.checked = false;
      }
    } catch (e) {}

    chk.addEventListener('change', () => {
      try {
        localStorage.setItem('ableton-rc:vision_enabled', chk.checked);
      } catch (e) {}
      if (chk.checked) {
        startVision();
      } else {
        stopVision();
      }
    });
  }

  connect();
  sendLoop();
  maybeRequestPermissions();
  setupSensorToggles();
  setupCalibration();
  setupHapticsUI();
  setupAudioUI();
  setupVisionUI();
  setupClientName();
})();
