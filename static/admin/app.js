// Copyright © 2026 Gabriel Worm
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Source: https://github.com/ntworm/ableton-rc-surface
//
// This file is part of Ableton RC Surface, distributed under the
// PolyForm Noncommercial License 1.0.0. You may obtain a copy of
// the License at https://polyformproject.org/licenses/noncommercial/1.0.0
// Admin dashboard: connects to /admin/ws, renders client list + selected client detail.
// v0.3+: per-sensor group sparkline charts (aig/rot/ori) + 2D XY plot.
//
// Performance: the detail panel is rendered by BUILDING a static skeleton
// once per selected client and then UPDATING textContent + canvas drawings
// in place on each client_update. The previous version rebuilt the full
// innerHTML at 30Hz which thrashed the DOM and stalled with multiple
// clients connected.

(function () {
  'use strict';

  const state = {
    clients: new Map(),
    selectedId: null,
    selectionPinned: false,
    // Skeleton/refs cache. detailSkeletonFor == null means the detail
    // pane is currently empty (no selection or placeholder text).
    detailSkeletonFor: null,
    detailRefs: null,
    // Per-group signature so we only rebuild that group's innerHTML when
    // the SET of signal names actually changes (not on every numeric tick).
    detailGroupKeys: {},
    detailGroupValCells: {},
    // Counts/list text cache so we only re-render when content changes.
    lastCountsText: '',
    lastListSignature: '',
    listItemRefs: new Map(), // clientId -> { root, age, ua, status, label }
  };

  // Per-client sensor time series, ring-buffered client-side. The server
  // does not track sensors in `ClientState.history`; we build the series
  // here from each `client_update` message's `latest.sensors`. Keyed by
  // clientId so two simultaneous phones don't mix data.
  const SENSOR_HISTORY_MAX = 60;  // ~6s at 10Hz broadcast
  const CLIENT_PRUNE_MS = 35_000;
  const SENSOR_GROUPS = ['aig.x', 'aig.y', 'aig.z',
                         'rot.x', 'rot.y', 'rot.z',
                         'ori.alpha', 'ori.beta', 'ori.gamma'];
  const EMA_ALPHA = 0.3;  // simple exponential moving average
  const sensorHistoryByClient = new Map();

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
  }

  function normalizeAig(sig, v) {
    if (sig === 'aig.z') v = v - 9.81;
    return clamp(0.5 + v / 20, 0, 1);
  }
  function normalizeRot(_sig, v) {
    return clamp(0.5 + v / 200, 0, 1);
  }
  function normalizeOri(sig, v) {
    if (sig === 'ori.alpha') {
      return clamp(v / 360, 0, 1);
    }
    const scale = sig === 'ori.beta' ? 180 : 90;
    return clamp(0.5 + v / scale, 0, 1);
  }
  function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

  function groupControls(controls) {
    const pads = [], knobs = [], faders = [], xy = [], audio = [], vision = [];
    for (const c of (controls || [])) {
      if (c.x !== undefined) {
        xy.push(c);
      } else if (c.name && c.name.startsWith('pad-')) {
        pads.push(c);
      } else if (c.name && c.name.startsWith('knob-')) {
        knobs.push(c);
      } else if (c.name && c.name.startsWith('fader-')) {
        faders.push(c);
      } else if (c.name && c.name.startsWith('sensor.audio.')) {
        audio.push(c);
      } else if (c.name && c.name.startsWith('sensor.vision.')) {
        vision.push(c);
      } else if (c.value !== undefined) {
        knobs.push(c);
      }
    }
    return { pads, knobs, faders, xy, audio, vision };
  }

  // ---------- Counts (top-right "N clients - M stale") ----------
  function renderCounts() {
    const all = Array.from(state.clients.values());
    const active = all.filter(c => c.client.status === 'active').length;
    const stale = all.length - active;
    const text = `${all.length} client${all.length !== 1 ? 's' : ''} - ${stale} stale`;
    if (text !== state.lastCountsText) {
      const el = document.getElementById('counts');
      if (el) el.textContent = text;
      state.lastCountsText = text;
    }
  }

  // ---------- Sidebar client list (incremental) ----------
  function renderList() {
    const list = document.getElementById('client-list');
    if (!list) return;
    const clients = Array.from(state.clients.values())
      .sort((a, b) => b.client.last_seen - a.client.last_seen);

    // Signature: ordered tuple of (id, status). If this changes we
    // need to rebuild the list structure; otherwise we just refresh the
    // age text on existing items.
    const sig = clients.map(c => `${c.client.client_id}/${c.client.status}`).join('|');
    if (sig !== state.lastListSignature) {
      state.lastListSignature = sig;
      state.listItemRefs = new Map();
      if (clients.length === 0) {
        list.innerHTML = '<div class="empty">No clients yet</div>';
        return;
      }
      list.innerHTML = '';
      for (const upd of clients) {
        const div = document.createElement('div');
        div.className = 'client-item';
        const id = upd.client.client_id;
        div.dataset.clientId = id;
        div.innerHTML = `
          <div class="row1"><span data-ref="icon"></span> <span data-ref="label"></span></div>
          <div class="row2" data-ref="ua"></div>
          <div class="row3" data-ref="age"></div>
        `;
        div.addEventListener('click', () => {
          state.selectedId = id;
          state.selectionPinned = true;
          renderList();
          renderDetail();
        });
        list.appendChild(div);
        state.listItemRefs.set(id, {
          root: div,
          icon: div.querySelector('[data-ref="icon"]'),
          label: div.querySelector('[data-ref="label"]'),
          ua: div.querySelector('[data-ref="ua"]'),
          age: div.querySelector('[data-ref="age"]'),
        });
        populateListItem(state.listItemRefs.get(id), upd);
      }
    }
    // Always refresh the textual content (age ticks every second).
    for (const upd of clients) {
      const ref = state.listItemRefs.get(upd.client.client_id);
      if (ref) populateListItem(ref, upd);
    }
  }

  function populateListItem(ref, upd) {
    if (!ref) return;
    const c = upd.client;
    if (ref.root.classList.contains('selected') !== (c.client_id === state.selectedId)) {
      ref.root.classList.toggle('selected', c.client_id === state.selectedId);
    }
    const ageMs = Date.now() - c.last_seen;
    const ageS = (ageMs / 1000).toFixed(0);
    const uaShort = (c.user_agent || '').split(' ').slice(-2).join(' ');
    const statusIcon = c.status === 'active' ? '●' : '○';
    const clientLabel = c.display_name || c.client_id.slice(0, 8);
    if (ref.icon.textContent !== statusIcon) ref.icon.textContent = statusIcon;
    if (ref.label.textContent !== clientLabel) ref.label.textContent = clientLabel;
    const ageTxt = `${ageS}s ago${c.status !== 'active' ? ' ⚠' : ''}`;
    if (ref.age.textContent !== ageTxt) ref.age.textContent = ageTxt;
    if (ref.ua.textContent !== uaShort) ref.ua.textContent = uaShort;
  }

  // ---------- Detail pane: skeleton + incremental updates ----------
  function clearDetail() {
    const detail = document.getElementById('detail');
    if (detail) detail.innerHTML = '<div class="empty">Select a client on the left</div>';
    state.detailSkeletonFor = null;
    state.detailRefs = null;
    state.detailGroupKeys = {};
    state.detailGroupValCells = {};
  }

  function buildSkeleton(upd) {
    const detail = document.getElementById('detail');
    if (!detail) return;
    const ua = esc(upd.client.user_agent || '-');
    const clientLabel = upd.client.display_name
      ? `${esc(upd.client.display_name)} <span style="opacity:0.5;font-size:0.7em">${esc(upd.client.client_id.slice(0, 8))}</span>`
      : esc(upd.client.client_id.slice(0, 8));

    // Skeleton uses data-ref placeholders. Text values are filled in by
    // updateDetailFromLatest(); control group bodies are filled in by
    // updateControlGroup(), which rebuilds innerHTML only when the set of
    // signal names in that group changes.
    detail.innerHTML = `
      <div class="hdr">
        <h2>${clientLabel}</h2>
        <span class="muted">${ua} · <span data-ref="age">0</span>s ago</span>
      </div>
      <div class="cards">
        <div class="card"><h3>pads (<span data-ref="cnt-pads">0</span>)</h3><div data-ref="body-pads"></div></div>
        <div class="card"><h3>knobs (<span data-ref="cnt-knobs">0</span>)</h3><div data-ref="body-knobs"></div></div>
        <div class="card"><h3>faders (<span data-ref="cnt-faders">0</span>)</h3><div data-ref="body-faders"></div></div>
        <div class="card"><h3>xy (<span data-ref="cnt-xy">0</span>)</h3><div data-ref="body-xy"></div></div>
        <div class="card"><h3>audio (<span data-ref="cnt-audio">0</span>)</h3><div data-ref="body-audio"></div></div>
        <div class="card"><h3>vision (<span data-ref="cnt-vision">0</span>)</h3><div data-ref="body-vision"></div></div>
        <div class="card">
          <h3>sensors</h3>
          <div class="sensor-block">
            <div class="kv"><div class="k">motion</div><div class="v" data-ref="motion-line">-</div></div>
            <div class="sensor-charts">
              <div class="chart-line"><span class="lbl">aig</span><canvas data-signal-group="aig" width="100" height="22"></canvas></div>
              <div class="chart-line"><span class="lbl">rot</span><canvas data-signal-group="rot" width="100" height="22"></canvas></div>
            </div>
          </div>
          <div class="sensor-block">
            <div class="kv"><div class="k">orientation</div><div class="v" data-ref="orient-line">-</div></div>
            <div class="sensor-charts">
              <div class="chart-line"><span class="lbl">ori</span><canvas data-signal-group="ori" width="100" height="22"></canvas></div>
            </div>
          </div>
          <div class="sensor-block"><div class="kv"><div class="k">audio input</div><div class="v" data-ref="audio-line">-</div></div></div>
          <div class="sensor-block"><div class="kv"><div class="k">camera vision</div><div class="v" data-ref="vision-line">-</div></div></div>
          <div class="kv"><div class="k">context</div><div class="v" data-ref="ctx-line">-</div></div>
          <div class="kv"><div class="k">network</div><div class="v" data-ref="net-line">-</div></div>
        </div>
        <div class="card"><h3>touches (<span data-ref="cnt-touches">0</span> active)</h3><div data-ref="body-touches"></div></div>
      </div>
    `;

    const ref = (sel) => detail.querySelector(`[data-ref="${sel}"]`);

    state.detailRefs = {
      age: ref('age'),
      counts: {
        pads: ref('cnt-pads'),
        knobs: ref('cnt-knobs'),
        faders: ref('cnt-faders'),
        xy: ref('cnt-xy'),
        audio: ref('cnt-audio'),
        vision: ref('cnt-vision'),
        touches: ref('cnt-touches'),
      },
      bodies: {
        pads: ref('body-pads'),
        knobs: ref('body-knobs'),
        faders: ref('body-faders'),
        xy: ref('body-xy'),
        audio: ref('body-audio'),
        vision: ref('body-vision'),
        touches: ref('body-touches'),
      },
      lines: {
        motion: ref('motion-line'),
        orient: ref('orient-line'),
        audio: ref('audio-line'),
        vision: ref('vision-line'),
        ctx: ref('ctx-line'),
        net: ref('net-line'),
      },
      sensorChartCanvases: detail.querySelectorAll('canvas[data-signal-group]'),
    };
    state.detailGroupKeys = {};
    state.detailGroupValCells = {};
  }

  function controlRow(c) {
    const rawName = c.name;
    const name = esc(cleanControlName(rawName));
    if (c.x !== undefined && c.y !== undefined) {
      return `
        <div class="xy-plot"><canvas data-xy="${esc(rawName)}" width="120" height="120"></canvas></div>
        <div class="kv">
          <div class="k" data-signal="${esc(rawName)}" title="${esc(rawName)}">${name}</div>
          <div class="v">x:${c.x.toFixed(2)} y:${c.y.toFixed(2)}</div>
        </div>`;
    }
    const val = (c.value !== undefined && c.value !== null) ? c.value.toFixed(2) : '0.00';
    const pressure = (c.pressure !== undefined && c.pressure !== null)
      ? ` · p=${c.pressure.toFixed(2)}` : '';
    return `
      <div class="kv">
        <div class="k" data-signal="${esc(rawName)}" title="${esc(rawName)}">${name}</div>
        <div class="v">${val}${pressure}</div>
        <canvas class="spark" data-signal="${esc(rawName)}" width="120" height="20"></canvas>
      </div>`;
  }

  // Build or update one control group (pads, knobs, faders, etc). Rebuilds
  // innerHTML only when the set of signal names changes; otherwise patches
  // textContent of the .v cells and the cached sparkline canvas refs.
  function updateControlGroup(groupKey, controls) {
    const refs = state.detailRefs;
    if (!refs) return;
    const body = refs.bodies[groupKey];
    const countEl = refs.counts[groupKey];
    if (!body || !countEl) return;

    if (countEl.textContent !== String(controls.length)) {
      countEl.textContent = String(controls.length);
    }

    if (controls.length === 0) {
      const empty = '<div class="muted">none</div>';
      if (state.detailGroupKeys[groupKey] !== '__empty__') {
        body.innerHTML = empty;
        state.detailGroupKeys[groupKey] = '__empty__';
        state.detailGroupValCells[groupKey] = null;
      }
      return;
    }

    const sig = controls.map(c => c.name).join('|');
    if (state.detailGroupKeys[groupKey] !== sig) {
      // Structure changed: rebuild innerHTML and re-cache cells.
      body.innerHTML = controls.map(controlRow).join('');
      state.detailGroupKeys[groupKey] = sig;
      const cells = new Map();
      body.querySelectorAll('.kv').forEach(kv => {
        const kEl = kv.querySelector('.k');
        const vEl = kv.querySelector('.v');
        if (kEl && vEl) cells.set(kEl.dataset.signal, vEl);
      });
      state.detailGroupValCells[groupKey] = cells;
    }

    // Patch .v textContent in place.
    const cells = state.detailGroupValCells[groupKey];
    if (cells) {
      for (const c of controls) {
        const v = cells.get(c.name);
        if (!v) continue;
        let txt;
        if (c.x !== undefined && c.y !== undefined) {
          txt = `x:${c.x.toFixed(2)} y:${c.y.toFixed(2)}`;
        } else {
          const val = (c.value !== undefined && c.value !== null) ? c.value.toFixed(2) : '0.00';
          txt = val
            + ((c.pressure !== undefined && c.pressure !== null) ? ` · p=${c.pressure.toFixed(2)}` : '');
        }
        if (v.textContent !== txt) v.textContent = txt;
      }
    }
  }

  function updateTXT(el, txt, klass) {
    if (!el) return;
    if (el.textContent !== txt) el.textContent = txt;
    if (klass !== undefined) {
      const cur = el.className;
      if (cur !== klass) el.className = klass;
    }
  }

  function updateDetailFromLatest(upd) {
    const refs = state.detailRefs;
    if (!refs) return;
    const d = upd.latest || {};
    const s = d.sensors || {};
    const net = s.network || d.network || {};
    const ctx = s.context || {};
    const mR = s.motion_reading || null;
    const oR = s.orientation_reading || null;
    const g = groupControls(d.controls);

    // Age (s)
    const ageS = Math.max(0, Math.round((Date.now() - upd.client.last_seen) / 1000));
    updateTXT(refs.age, String(ageS));

    // Control groups
    updateControlGroup('pads', g.pads);
    updateControlGroup('knobs', g.knobs);
    updateControlGroup('faders', g.faders);
    updateControlGroup('xy', g.xy);
    updateControlGroup('audio', g.audio);
    updateControlGroup('vision', g.vision);

    // Touches
    const touches = d.touches || [];
    refs.counts.touches.textContent = String(touches.length);
    const touchesHtml = touches.length === 0
      ? '<span class="muted">none</span>'
      : touches.map(t =>
          `<span class="touch">#${t.id} x:${t.x.toFixed(2)} y:${t.y.toFixed(2)} f:${(t.force ?? 0).toFixed(2)}</span>`
        ).join(' ');
    if (refs.bodies.touches.innerHTML !== touchesHtml) {
      refs.bodies.touches.innerHTML = touchesHtml;
    }

    // Sensor text lines
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
    updateTXT(refs.lines.motion, motionLine, statusClass(motionStatus));

    const orientStatus = s.orientation || 'unknown';
    const orientLine = `${orientStatus} · `
      + (oR
          ? `α ${fmt(oR.alpha, 0)}° β ${fmt(oR.beta, 0)}° γ ${fmt(oR.gamma, 0)}°`
          : 'α - β - γ -')
      + (oR && oR.absolute !== null && oR.absolute !== undefined
          ? ` · abs:${oR.absolute}` : '');
    updateTXT(refs.lines.orient, orientLine, statusClass(orientStatus));

    const audioStatus = s.audio || 'inactive';
    const aR = s.audio_reading || null;
    const audioLine = `${audioStatus}`
      + (aR
          ? ` · rms ${fmt(aR.rms, 3)} · pitch ${fmt(aR.pitch, 1)} Hz · nota ${aR.midi_note || '-'} · bpm ${aR.bpm || '-'}`
          : '');
    updateTXT(refs.lines.audio, audioLine, statusClass(audioStatus));

    const visionStatus = s.vision || 'inactive';
    const vR = s.vision_reading || null;
    let visionColorStr = '';
    if (vR && vR.color) {
      visionColorStr = ` · color rgb(${fmt(vR.color.r * 255, 0)}, ${fmt(vR.color.g * 255, 0)}, ${fmt(vR.color.b * 255, 0)})`;
    }
    const visionLine = `${visionStatus}`
      + (vR
          ? ` · active:${vR.active ? 'yes' : 'no'}`
            + (vR.active ? ` · x:${fmt(vR.x, 2)} y:${fmt(vR.y, 2)} z:${fmt(vR.z, 2)} · fist:${vR.is_fist ? 'yes' : 'no'}` : '')
            + visionColorStr
          : '');
    updateTXT(refs.lines.vision, visionLine, statusClass(visionStatus));

    const ctxLine = (ctx.secure_context ? 'secure' : 'insecure')
      + (ctx.scheme ? ` · ${ctx.scheme}` : '');
    updateTXT(refs.lines.ctx, ctxLine, ctx.secure_context ? 'ok' : 'warn');

    const netLine = (net.online ? (net.type || 'online') : 'offline')
      + (net.downlink !== null && net.downlink !== undefined ? ` · ${fmt(net.downlink, 1)} Mb/s` : '')
      + (net.rtt !== null && net.rtt !== undefined ? ` · ${fmt(net.rtt, 0)}ms` : '')
      + (net.save_data ? ' · save-data' : '');
    updateTXT(refs.lines.net, netLine);
  }

  function renderDetail() {
    const upd = state.selectedId ? state.clients.get(state.selectedId) : null;
    if (!upd) { clearDetail(); return; }
    if (state.detailSkeletonFor !== state.selectedId) {
      buildSkeleton(upd);
      state.detailSkeletonFor = state.selectedId;
    }
    updateDetailFromLatest(upd);
    drawSparklines();
    drawSensorCharts();
    drawXYPlots();
  }

  function cleanControlName(name) {
    if (!name) return '';
    if (name.startsWith('sensor.audio.')) return name.replace('sensor.audio.', 'audio:');
    if (name.startsWith('sensor.vision.')) return name.replace('sensor.vision.', 'vision:');
    return name;
  }

  function fmt(n, decimals) {
    if (n === null || n === undefined || Number.isNaN(n)) return '-';
    return Number(n).toFixed(decimals);
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
    let removed = false;
    for (const [clientId, upd] of state.clients.entries()) {
      if (now - upd.client.last_seen <= CLIENT_PRUNE_MS) continue;
      state.clients.delete(clientId);
      sensorHistoryByClient.delete(clientId);
      removed = true;
      if (state.selectedId === clientId) {
        state.selectedId = chooseBestClientId();
        state.selectionPinned = false;
      }
    }
    return removed;
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

  // Existing per-control sparkline: reads from the SERVER's per-control
  // history, not the sensor history we maintain client-side. The spark
  // canvas refs live inside the control groups, which we re-cache on
  // group rebuild.
  function drawSparklines() {
    const upd = state.selectedId ? state.clients.get(state.selectedId) : null;
    if (!upd) return;
    const refs = state.detailRefs;
    if (!refs) return;
    const groups = ['pads', 'knobs', 'faders'];
    for (const g of groups) {
      const body = refs.bodies[g];
      if (!body) continue;
      const sparks = body.querySelectorAll('canvas.spark');
      for (const canvas of sparks) {
        const name = canvas.dataset.signal;
        const series = upd.history[name] || [];
        const ctx2 = canvas.getContext('2d');
        ctx2.clearRect(0, 0, canvas.width, canvas.height);
        if (series.length < 2) continue;
        ctx2.strokeStyle = '#0a84ff';
        ctx2.lineWidth = 1.5;
        ctx2.beginPath();
        const w = canvas.width, h = canvas.height;
        const xstep = w / Math.max(1, series.length - 1);
        series.forEach(([t, v], i) => {
          const x = i * xstep;
          const y = h - (v * h);
          if (i === 0) ctx2.moveTo(x, y); else ctx2.lineTo(x, y);
        });
        ctx2.stroke();
      }
    }
  }

  // Per-sensor-group chart (aig / rot / ori). The canvases are
  // cached at skeleton-build time, so we never querySelectorAll.
  const SENSOR_GROUP_AXES = {
    aig: ['aig.x', 'aig.y', 'aig.z'],
    rot: ['rot.x', 'rot.y', 'rot.z'],
    ori: ['ori.alpha', 'ori.beta', 'ori.gamma'],
  };
  const SENSOR_COLORS = ['#0a84ff', '#34c759', '#ff9f0a'];
  const SENSOR_GROUP_NORMALIZER = {
    aig: normalizeAig,
    rot: normalizeRot,
    ori: normalizeOri,
  };

  function drawSensorCharts() {
    const refs = state.detailRefs;
    if (!refs) return;
    const upd = state.selectedId ? state.clients.get(state.selectedId) : null;
    const hist = upd ? sensorHistoryByClient.get(upd.client.client_id) : null;
    for (const canvas of refs.sensorChartCanvases) {
      const group = canvas.dataset.signalGroup;
      const signals = SENSOR_GROUP_AXES[group] || [];
      const normalizer = SENSOR_GROUP_NORMALIZER[group];
      const ctx2 = canvas.getContext('2d');
      const w = canvas.width, h = canvas.height;
      ctx2.clearRect(0, 0, w, h);
      ctx2.strokeStyle = '#333';
      ctx2.beginPath();
      ctx2.moveTo(0, h * 0.5);
      ctx2.lineTo(w, h * 0.5);
      ctx2.stroke();
      for (let i = 0; i < signals.length; i++) {
        const sig = signals[i];
        const series = (hist && hist[sig]) || [];
        if (series.length < 2) continue;
        ctx2.strokeStyle = SENSOR_COLORS[i];
        ctx2.lineWidth = 1.5;
        ctx2.beginPath();
        const xstep = w / Math.max(1, series.length - 1);
        series.forEach(([t, rawV, smoothV], j) => {
          const smoothed = smoothV !== undefined ? smoothV : rawV;
          const v = normalizer ? normalizer(sig, smoothed, hist) : smoothed;
          const x = j * xstep;
          const y = h - v * h;
          if (j === 0) ctx2.moveTo(x, y); else ctx2.lineTo(x, y);
        });
        ctx2.stroke();
      }
    }
  }

  function drawXYPlots() {
    const refs = state.detailRefs;
    if (!refs) return;
    const body = refs.bodies.xy;
    if (!body) return;
    const upd = state.selectedId ? state.clients.get(state.selectedId) : null;
    const xyCanvases = body.querySelectorAll('canvas[data-xy]');
    if (xyCanvases.length === 0) return;
    const controls = (upd && upd.latest && upd.latest.controls) || [];
    for (const canvas of xyCanvases) {
      const name = canvas.dataset.xy;
      const xy = controls.find(c => c.x !== undefined && c.name === name);
      const ctx2 = canvas.getContext('2d');
      const w = canvas.width, h = canvas.height;
      ctx2.clearRect(0, 0, w, h);
      ctx2.strokeStyle = '#2d2d2f';
      ctx2.lineWidth = 1;
      for (let i = 1; i < 4; i++) {
        ctx2.beginPath();
        ctx2.moveTo(0, (h * i) / 4);
        ctx2.lineTo(w, (h * i) / 4);
        ctx2.stroke();
        ctx2.beginPath();
        ctx2.moveTo((w * i) / 4, 0);
        ctx2.lineTo((w * i) / 4, h);
        ctx2.stroke();
      }
      ctx2.strokeStyle = '#3d3d3f';
      ctx2.beginPath();
      ctx2.moveTo(0, h * 0.5);
      ctx2.lineTo(w, h * 0.5);
      ctx2.moveTo(w * 0.5, 0);
      ctx2.lineTo(w * 0.5, h);
      ctx2.stroke();
      if (!xy) continue;
      const x = xy.x, y = xy.y;
      if (x === null || x === undefined || y === null || y === undefined) continue;
      ctx2.fillStyle = '#ff9f0a';
      ctx2.beginPath();
      ctx2.arc(x * w, y * h, 5, 0, Math.PI * 2);
      ctx2.fill();
      ctx2.strokeStyle = 'rgba(255,159,10,0.4)';
      ctx2.beginPath();
      ctx2.moveTo(w * 0.5, h * 0.5);
      ctx2.lineTo(x * w, y * h);
      ctx2.stroke();
    }
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
        const oldSig = isNewClient ? null : clientCompositionKey(state.clients.get(clientId));
        state.clients.set(clientId, msg);
        pruneDeadClients();
        pushSensorsFromLatest(clientId, msg.latest);

        let selectionChanged = false;
        if (shouldAutoFollow(msg)) {
          state.selectedId = clientId;
          state.selectionPinned = false;
          selectionChanged = true;
        }

        if (isNewClient || selectionChanged) {
          renderCounts();
          renderList();
        } else {
          // Even if signature unchanged, refresh ages/labels in-place.
          renderList();
        }

        if (selectionChanged || clientId === state.selectedId) {
          renderDetail();
        }
      } catch (err) { /* ignore */ }
    };
    ws.onclose = () => {
      const el = document.getElementById('counts');
      if (el) {
        el.textContent = 'disconnected - retrying…';
        state.lastCountsText = el.textContent;
      }
      setTimeout(connect, 1000);
    };
  }

  function clientCompositionKey(upd) {
    if (!upd) return '';
    return `${upd.client.client_id}/${upd.client.status}/${upd.client.display_name || ''}/${upd.client.user_agent || ''}`;
  }

  // Test-only hook. Exposes the per-client sensor history and selection
  // state so Playwright tests can verify isolation and smoothing.
  if (typeof window !== 'undefined') {
    window.__abletonRcAdmin = {
      get sensorHistoryByClient() { return sensorHistoryByClient; },
      get selectedId() { return state.selectedId; },
      get selectionPinned() { return state.selectionPinned; },
    };
  }

  // Per-second upkeep. We DO NOT re-render the full detail on this tick;
  // detail only re-renders when the selected client emits a snapshot.
  // Here we just refresh the sidebar age text and prune dead clients.
  setInterval(() => {
    const removed = pruneDeadClients();
    if (removed) {
      renderCounts();
      renderList();
      renderDetail();
    } else {
      renderList();
    }
  }, 1000);

  connect();
})();
