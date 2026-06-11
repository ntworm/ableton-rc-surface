// Admin dashboard: connects to /admin/ws, renders client list + selected client detail.
// v0.3+: per-sensor group sparkline charts (aig/rot/ori/lux) + 2D XY plot.

(function () {
  'use strict';

  const state = {
    clients: new Map(),
    selectedId: null,
    selectionPinned: false,
  };

  // Per-client sensor time series, ring-buffered client-side. The server
  // does not track sensors in `ClientState.history`; we build the series
  // here from each `client_update` message's `latest.sensors`. Keyed by
  // clientId so two simultaneous phones don't mix data.
  const SENSOR_HISTORY_MAX = 60;  // ~6s at 10Hz broadcast
  const CLIENT_PRUNE_MS = 35_000;
  const SENSOR_GROUPS = ['aig.x', 'aig.y', 'aig.z',
                         'rot.x', 'rot.y', 'rot.z',
                         'ori.alpha', 'ori.beta', 'ori.gamma',
                         'lux'];
  const EMA_ALPHA = 0.3;  // simple exponential moving average
  const sensorHistoryByClient = new Map();  // clientId -> { <signal>: [[ts, v], ...], _ema: { <signal>: smoothedV } }

  function getOrCreateHistory(clientId) {
    let h = sensorHistoryByClient.get(clientId);
    if (!h) {
      h = { _ema: {} };
      for (const sig of SENSOR_GROUPS) h[sig] = [];
      sensorHistoryByClient.set(clientId, h);
    }
    return h;
  }
  function pushSensor(hist, signal, value) {
    if (value === null || value === undefined || Number.isNaN(value)) return;
    const series = hist[signal];
    if (!series) return;
    const smoothed = emaUpdate(hist, signal, value);
    series.push([Date.now(), value, smoothed]);
    if (series.length > SENSOR_HISTORY_MAX) {
      series.splice(0, series.length - SENSOR_HISTORY_MAX);
    }
  }
  // EMA smoothing for chart stability. We do NOT smooth the wire value
  // sent to the consumer (admin renders the smoothed value; consumers
  // downstream see the raw value).
  function emaUpdate(hist, signal, raw) {
    const prev = hist._ema[signal];
    const next = prev === undefined ? raw : (EMA_ALPHA * raw + (1 - EMA_ALPHA) * prev);
    hist._ema[signal] = next;
    return next;
  }
  function pushSensorsFromLatest(clientId, latest) {
    const hist = getOrCreateHistory(clientId);
    const s = (latest && latest.sensors) || {};
    const mR = s.motion_reading;
    const oR = s.orientation_reading;
    const lR = s.light_reading;
    if (mR) {
      const aig = mR.acceleration_including_gravity;
      if (aig) {
        pushSensor(hist, 'aig.x', aig.x);
        pushSensor(hist, 'aig.y', aig.y);
        pushSensor(hist, 'aig.z', aig.z);
      }
      const rot = mR.rotation_rate;
      if (rot) {
        pushSensor(hist, 'rot.x', rot.x);
        pushSensor(hist, 'rot.y', rot.y);
        pushSensor(hist, 'rot.z', rot.z);
      }
    }
    if (oR) {
      pushSensor(hist, 'ori.alpha', oR.alpha);
      pushSensor(hist, 'ori.beta', oR.beta);
      pushSensor(hist, 'ori.gamma', oR.gamma);
    }
    if (lR && lR.lux !== null && lR.lux !== undefined) {
      pushSensor(hist, 'lux', lR.lux);
    }
  }

  // Per-group normalization. Sensor values are NOT 0..1 (aig.z ~ 9.81,
  // ori in degrees, etc.), so we map each axis to 0..1 for the canvas.
  // The 0.5 baseline = "0 / center" for centered groups; lux auto-scales
  // to the max of the recent series (since lux is always positive).
  function normalizeAig(sig, v) {
    // Subtract gravity from Z so it sits at 0 like X/Y when the device
    // is at rest. Scale by ±20 m/s².
    if (sig === 'aig.z') v = v - 9.81;
    return clamp(0.5 + v / 20, 0, 1);
  }
  function normalizeRot(_sig, v) {
    // rotationRate is in deg/s. Scale by ±200 deg/s.
    return clamp(0.5 + v / 200, 0, 1);
  }
  function normalizeOri(sig, v) {
    // alpha wraps 0..360; beta -180..180; gamma -90..90. Per-axis scale
    // (360 / 180 / 90) keeps each axis visible at its natural range.
    const scale = sig === 'ori.alpha' ? 360 : sig === 'ori.beta' ? 180 : 90;
    return clamp(0.5 + v / scale, 0, 1);
  }
  function normalizeLux(_sig, v, hist) {
    // Auto-scale: use the max of the recent series (with a 1-unit floor
    // so 0/lux-less phones still draw a line).
    const series = hist && hist.lux ? hist.lux : [];
    let maxV = 1;
    for (const [, vv] of series) if (vv > maxV) maxV = vv;
    return clamp(0.1 + (v / maxV) * 0.65, 0.1, 0.75);
  }
  function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

  function groupControls(controls) {
    const pads = [], knobs = [], faders = [], xy = [];
    for (const c of (controls || [])) {
      if (c.x !== undefined) xy.push(c);
      else if (c.name && c.name.startsWith('pad-')) pads.push(c);
      else if (c.name && c.name.startsWith('knob-')) knobs.push(c);
      else if (c.name && c.name.startsWith('fader-')) faders.push(c);
      else if (c.value !== undefined) knobs.push(c);
    }
    return { pads, knobs, faders, xy };
  }

  function renderCounts() {
    pruneDeadClients();
    const all = Array.from(state.clients.values());
    const active = all.filter(c => c.client.status === 'active').length;
    const stale = all.length - active;
    document.getElementById('counts').textContent =
      `${all.length} client${all.length !== 1 ? 's' : ''} - ${stale} stale`;
  }

  function renderList() {
    const list = document.getElementById('client-list');
    const clients = Array.from(state.clients.values())
      .sort((a, b) => b.client.last_seen - a.client.last_seen);
    if (clients.length === 0) {
      list.innerHTML = '<div class="empty">No clients yet</div>';
      return;
    }
    list.innerHTML = '';
    for (const upd of clients) {
      const div = document.createElement('div');
      div.className = 'client-item';
      if (upd.client.client_id === state.selectedId) div.classList.add('selected');
      const ageMs = Date.now() - upd.client.last_seen;
      const ageS = (ageMs / 1000).toFixed(0);
      const uaShort = (upd.client.user_agent || '').split(' ').slice(-2).join(' ');
      const statusIcon = upd.client.status === 'active' ? '●' : '○';
      const clientLabel = upd.client.display_name || upd.client.client_id.slice(0, 8);
      div.innerHTML = `
        <div class="row1">${statusIcon} ${clientLabel}</div>
        <div class="row2">${uaShort}</div>
        <div class="row3">${ageS}s ago${upd.client.status !== 'active' ? ' ⚠' : ''}</div>
      `;
      div.addEventListener('click', () => {
        state.selectedId = upd.client.client_id;
        state.selectionPinned = true;
        renderList();
        renderDetail();
      });
      list.appendChild(div);
    }
  }

  function controlRow(c) {
    const name = esc(c.name);
    const val = c.value.toFixed(2);
    const pressure = (c.pressure !== undefined && c.pressure !== null)
      ? ` · p=${c.pressure.toFixed(2)}` : '';
    return `
      <div class="kv">
        <div class="k">${name}</div>
        <div class="v">${val}${pressure}</div>
        <canvas class="spark" data-signal="${name}" width="120" height="20"></canvas>
      </div>`;
  }

  function renderDetail() {
    const detail = document.getElementById('detail');
    const upd = state.clients.get(state.selectedId);
    if (!upd) { detail.innerHTML = '<div class="empty">Select a client on the left</div>'; return; }
    const d = upd.latest;
    const ua = upd.client.user_agent || '-';
    const ageS = ((Date.now() - upd.client.last_seen) / 1000).toFixed(0);
    const g = groupControls(d.controls);
    const s = d.sensors || {};
    const net = s.network || d.network || {};
    const ctx = s.context || {};
    const mR = s.motion_reading || null;
    const oR = s.orientation_reading || null;
    const lR = s.light_reading || null;

    const padHtml = g.pads.map(controlRow).join('') || '<div class="muted">none</div>';
    const knobHtml = g.knobs.map(controlRow).join('') || '<div class="muted">none</div>';
    const faderHtml = g.faders.map(controlRow).join('') || '<div class="muted">none</div>';

    // XY card with 2D plot + text
    const xyHtml = g.xy.length === 0
      ? '<div class="muted">none</div>'
      : g.xy.map(c => `
        <div class="xy-plot"><canvas data-xy="${esc(c.name)}" width="120" height="120"></canvas></div>
        <div class="kv">
          <div class="k">${esc(c.name)}</div>
          <div class="v">x ${c.x.toFixed(2)} y ${c.y.toFixed(2)}</div>
        </div>`).join('');

    const touchHtml = (d.touches || []).map(t =>
      `<span class="touch">#${t.id} x:${t.x.toFixed(2)} y:${t.y.toFixed(2)} f:${(t.force ?? 0).toFixed(2)}</span>`
    ).join(' ') || '<span class="muted">none</span>';

    // ---- Sensor rendering: status + live values + mini charts ----
    const aig = mR && mR.acceleration_including_gravity;
    const rot = mR && mR.rotation_rate;
    const accel = mR && mR.acceleration;
    const motionStatus = s.motion || 'unknown';
    const motionLine = `${motionStatus} · `
      + (aig
          ? `aig ${fmt(aig.x, 2)}/${fmt(aig.y, 2)}/${fmt(aig.z, 2)} m/s²`
          : 'aig -')
      + (accel ? ` · accel ${fmt(accel.x, 2)}/${fmt(accel.y, 2)}/${fmt(accel.z, 2)}` : ' · accel -')
      + (rot ? ` · rot ${fmt(rot.x, 1)}/${fmt(rot.y, 1)}/${fmt(rot.z, 1)} °/s` : ' · rot -')
      + (mR && mR.interval !== null && mR.interval !== undefined
          ? ` · Δ${fmt(mR.interval, 0)}ms` : '');

    const orientStatus = s.orientation || 'unknown';
    const orientLine = `${orientStatus} · `
      + (oR
          ? `α ${fmt(oR.alpha, 0)}° β ${fmt(oR.beta, 0)}° γ ${fmt(oR.gamma, 0)}°`
          : 'α - β - γ -')
      + (oR && oR.absolute !== null && oR.absolute !== undefined
          ? ` · abs:${oR.absolute}` : '');

    const lightStatus = s.light || 'unknown';
    const lightLine = `${lightStatus} · `
      + (lR && lR.lux !== null && lR.lux !== undefined
          ? `${fmt(lR.lux, 0)} lux` : '-');

    const ctxLine = (ctx.secure_context ? 'secure' : 'insecure')
      + (ctx.scheme ? ` · ${ctx.scheme}` : '');

    const netLine = (net.online ? (net.type || 'online') : 'offline')
      + (net.downlink !== null && net.downlink !== undefined ? ` · ${fmt(net.downlink, 1)} Mb/s` : '')
      + (net.rtt !== null && net.rtt !== undefined ? ` · ${fmt(net.rtt, 0)}ms` : '')
      + (net.save_data ? ' · save-data' : '');

    const detailLabel = upd.client.display_name
      ? `${upd.client.display_name} <span style="opacity:0.5;font-size:0.7em">${upd.client.client_id.slice(0, 8)}</span>`
      : upd.client.client_id.slice(0, 8);
    detail.innerHTML = `
      <div class="hdr">
        <h2>${detailLabel}</h2>
        <span class="muted">${ua} · ${ageS}s ago</span>
      </div>
      <div class="cards">
        <div class="card"><h3>pads (${g.pads.length})</h3>${padHtml}</div>
        <div class="card"><h3>knobs (${g.knobs.length})</h3>${knobHtml}</div>
        <div class="card"><h3>faders (${g.faders.length})</h3>${faderHtml}</div>
        <div class="card">
          <h3>xy (${g.xy.length})</h3>
          ${xyHtml}
        </div>
        <div class="card">
          <h3>sensors</h3>
          <div class="sensor-block">
            <div class="kv">
              <div class="k">motion</div>
              <div class="v ${statusClass(motionStatus)}">${motionLine}</div>
            </div>
            <div class="sensor-charts">
              <div class="chart-line"><span class="lbl">aig</span>
                <canvas data-signal-group="aig" width="100" height="22"></canvas></div>
              <div class="chart-line"><span class="lbl">rot</span>
                <canvas data-signal-group="rot" width="100" height="22"></canvas></div>
            </div>
          </div>
          <div class="sensor-block">
            <div class="kv">
              <div class="k">orientation</div>
              <div class="v ${statusClass(orientStatus)}">${orientLine}</div>
            </div>
            <div class="sensor-charts">
              <div class="chart-line"><span class="lbl">ori</span>
                <canvas data-signal-group="ori" width="100" height="22"></canvas></div>
            </div>
          </div>
          <div class="sensor-block">
            <div class="kv">
              <div class="k">light</div>
              <div class="v ${statusClass(lightStatus)}">${lightLine}</div>
            </div>
            <div class="sensor-charts">
              <div class="chart-line"><span class="lbl">lux</span>
                <canvas data-signal-group="lux" width="100" height="22"></canvas></div>
            </div>
          </div>
          <div class="kv">
            <div class="k">context</div>
            <div class="v ${ctx.secure_context ? 'ok' : 'warn'}">${ctxLine}</div>
          </div>
          <div class="kv">
            <div class="k">network</div>
            <div class="v">${netLine}</div>
          </div>
        </div>
        <div class="card">
          <h3>touches (${(d.touches || []).length} active)</h3>
          ${touchHtml}
        </div>
      </div>
    `;
    drawSparklines();
    drawSensorCharts();
    drawXYPlots();
  }

  function fmt(n, decimals) {
    if (n === null || n === undefined || Number.isNaN(n)) return '-';
    return Number(n).toFixed(decimals);
  }
  function fmtVec(v, decimals) {
    if (!v) return '-';
    return `${fmt(v.x, decimals)}/${fmt(v.y, decimals)}/${fmt(v.z, decimals)}`;
  }

  function statusClass(s) {
    if (s === 'available') return 'ok';
    if (s === 'insecure-context' || s === 'unavailable' || s === 'permission-denied') return 'warn';
    return 'muted';
  }

  function chooseBestClientId() {
    const clients = Array.from(state.clients.values())
      .sort((a, b) => b.client.last_seen - a.client.last_seen);
    const active = clients.find(c => c.client.status === 'active');
    return active ? active.client.client_id : (clients[0] && clients[0].client.client_id) || null;
  }

  function pruneDeadClients() {
    const now = Date.now();
    let selectedWasRemoved = false;
    for (const [clientId, upd] of state.clients.entries()) {
      if (now - upd.client.last_seen <= CLIENT_PRUNE_MS) continue;
      state.clients.delete(clientId);
      sensorHistoryByClient.delete(clientId);
      if (state.selectedId === clientId) selectedWasRemoved = true;
    }
    if (selectedWasRemoved || (state.selectedId && !state.clients.has(state.selectedId))) {
      state.selectedId = chooseBestClientId();
      state.selectionPinned = false;
    }
  }

  function shouldAutoFollow(incoming) {
    if (!incoming || incoming.client.status !== 'active') return false;
    if (!state.selectedId) return true;
    const current = state.clients.get(state.selectedId);
    if (!current) return true;
    if (current.client.status === 'active' && current.client.client_id !== incoming.client.client_id) return false;
    if (state.selectionPinned && current.client.status === 'active') return false;
    if (current.client.status !== 'active') return true;
    return incoming.client.last_seen > current.client.last_seen;
  }

  // Existing per-control sparkline (uses SERVER history, not sensorHistory)
  function drawSparklines() {
    const upd = state.clients.get(state.selectedId);
    if (!upd) return;
    document.querySelectorAll('canvas.spark').forEach(canvas => {
      const name = canvas.dataset.signal;
      const series = upd.history[name] || [];
      const ctx = canvas.getContext('2d');
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      if (series.length < 2) return;
      ctx.strokeStyle = '#0a84ff';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      const w = canvas.width, h = canvas.height;
      const xstep = w / Math.max(1, series.length - 1);
      series.forEach(([t, v], i) => {
        const x = i * xstep;
        const y = h - (v * h);
        if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      });
      ctx.stroke();
    });
  }

  // New: per-sensor-group 3-line chart (x/α, y/β, z/γ).
  // data-signal-group: "aig" / "rot" / "ori" / "lux"
  const SENSOR_GROUP_AXES = {
    aig: ['aig.x', 'aig.y', 'aig.z'],
    rot: ['rot.x', 'rot.y', 'rot.z'],
    ori: ['ori.alpha', 'ori.beta', 'ori.gamma'],
    lux: ['lux'],
  };
  const SENSOR_COLORS = ['#0a84ff', '#34c759', '#ff9f0a'];  // x/y/z or α/β/γ
  const SENSOR_COLOR_LUX = ['#5ac8fa'];
  const SENSOR_GROUP_NORMALIZER = {
    aig: normalizeAig,
    rot: normalizeRot,
    ori: normalizeOri,
    lux: normalizeLux,
  };

  function drawSensorCharts() {
    const upd = state.clients.get(state.selectedId);
    const hist = upd ? sensorHistoryByClient.get(upd.client.client_id) : null;
    document.querySelectorAll('canvas[data-signal-group]').forEach(canvas => {
      const group = canvas.dataset.signalGroup;
      const signals = SENSOR_GROUP_AXES[group] || [];
      const colors = group === 'lux' ? SENSOR_COLOR_LUX : SENSOR_COLORS;
      const normalizer = SENSOR_GROUP_NORMALIZER[group];
      const ctx = canvas.getContext('2d');
      const w = canvas.width, h = canvas.height;
      ctx.clearRect(0, 0, w, h);
      // baseline at 0.5
      ctx.strokeStyle = '#333';
      ctx.beginPath();
      ctx.moveTo(0, h * 0.5);
      ctx.lineTo(w, h * 0.5);
      ctx.stroke();
      // each axis as one line
      for (let i = 0; i < signals.length; i++) {
        const sig = signals[i];
        const series = (hist && hist[sig]) || [];
        if (series.length < 2) continue;
        ctx.strokeStyle = colors[i];
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        const xstep = w / Math.max(1, series.length - 1);
        series.forEach(([t, rawV, smoothV], j) => {
          const smoothed = smoothV !== undefined ? smoothV : rawV;
          // Normalize to 0..1 for canvas Y. Group-specific:
          //   aig: subtract gravity from Z, scale ±20 m/s²
          //   rot: scale ±200 deg/s
          //   ori: per-axis (alpha 360, beta 180, gamma 90)
          //   lux: auto-scale to recent max
          const v = normalizer ? normalizer(sig, smoothed, hist) : smoothed;
          const x = j * xstep;
          const y = h - v * h;
          if (j === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
        });
        ctx.stroke();
      }
    });
  }

  // 2D XY plot: a small square with a dot at (x, y).
  function drawXYPlots() {
    const upd = state.clients.get(state.selectedId);
    if (!upd) return;
    document.querySelectorAll('canvas[data-xy]').forEach(canvas => {
      const name = canvas.dataset.xy;
      const controls = (upd.latest && upd.latest.controls) || [];
      const xy = controls.find(c => c.x !== undefined && c.name === name);
      const ctx = canvas.getContext('2d');
      const w = canvas.width, h = canvas.height;
      ctx.clearRect(0, 0, w, h);
      // 4x4 grid
      ctx.strokeStyle = '#2d2d2f';
      ctx.lineWidth = 1;
      for (let i = 1; i < 4; i++) {
        ctx.beginPath();
        ctx.moveTo(0, (h * i) / 4);
        ctx.lineTo(w, (h * i) / 4);
        ctx.stroke();
        ctx.beginPath();
        ctx.moveTo((w * i) / 4, 0);
        ctx.lineTo((w * i) / 4, h);
        ctx.stroke();
      }
      // axes
      ctx.strokeStyle = '#3d3d3f';
      ctx.beginPath();
      ctx.moveTo(0, h * 0.5);
      ctx.lineTo(w, h * 0.5);
      ctx.moveTo(w * 0.5, 0);
      ctx.lineTo(w * 0.5, h);
      ctx.stroke();
      if (!xy) return;
      // dot
      const x = xy.x, y = xy.y;
      if (x === null || x === undefined || y === null || y === undefined) return;
      ctx.fillStyle = '#ff9f0a';
      ctx.beginPath();
      ctx.arc(x * w, y * h, 5, 0, Math.PI * 2);
      ctx.fill();
      // trace line from center to dot
      ctx.strokeStyle = 'rgba(255,159,10,0.4)';
      ctx.beginPath();
      ctx.moveTo(w * 0.5, h * 0.5);
      ctx.lineTo(x * w, y * h);
      ctx.stroke();
    });
  }

  function esc(s) {
    return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  }

  function connect() {
    const proto = window.location.protocol === 'https:' ? 'wss' : 'ws';
    const url = `${proto}://${window.location.host}/admin/ws`;
    const ws = new WebSocket(url);
    ws.onmessage = (e) => {
      try {
        const msg = JSON.parse(e.data);
        if (msg.type !== 'client_update') return;
        const clientId = msg.client.client_id;
        const isNewClient = !state.clients.has(clientId);
        state.clients.set(clientId, msg);
        pruneDeadClients();
        let selectionChanged = false;
        if (shouldAutoFollow(msg)) {
          state.selectedId = clientId;
          state.selectionPinned = false;
          selectionChanged = true;
        }
        pushSensorsFromLatest(clientId, msg.latest);
        if (selectionChanged || clientId === state.selectedId) {
          renderDetail();
        }
        if (isNewClient || selectionChanged) {
          renderCounts();
          renderList();
        }
      } catch (err) { /* ignore */ }
    };
    ws.onclose = () => {
      document.getElementById('counts').textContent = 'disconnected - retrying…';
      setTimeout(connect, 1000);
    };
  }

  // Test-only hook. Exposes the per-client sensor history (including
  // EMA state) so Playwright tests can verify isolation and smoothing.
  if (typeof window !== 'undefined') {
    window.__abletonRcAdmin = {
      get sensorHistoryByClient() { return sensorHistoryByClient; },
      get selectedId() { return state.selectedId; },
      get selectionPinned() { return state.selectionPinned; },
    };
  }

  setInterval(() => {
    pruneDeadClients();
    renderCounts();
    renderList();
    if (state.selectedId) renderDetail();
  }, 1000);

  connect();
})();
