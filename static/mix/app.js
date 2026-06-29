// Mix View client.
//
// Connects to /mix/ws, maintains a local model of the song (tracks,
// mixer, expanded device params), renders three views (track list,
// expanded track, device detail), and sends mix.setVolume / setPan /
// toggleMute / toggleSolo / setSend / setParam commands when the user
// interacts with a control. All wire shapes and ID helpers come from
// ./protocol.mjs and ./generic-template.mjs; the client never reaches
// into the extension server's source.

import {
  MIX_PROTOCOL_VERSION,
  TRACK_TYPES,
  SERVER_MSG,
  CLIENT_CMD,
  parseId,
  trackId,
  deviceId,
  paramId,
  sendId,
  validateCommand,
} from "./protocol.mjs";
import { renderParameter, inputValueToWire, enumLabelFor } from "./generic-template.mjs";

// ---------------- Local state ----------------

const state = {
  ws: null,
  connected: false,
  hello: null,
  refCounter: 1,
  pending: new Map(), // refId -> { resolve, reject, ts }
  tracks: new Map(),   // id -> { id, name, type, groupTrackId }
  mixer: new Map(),   // id -> { volume, pan, mute, solo, sends: [{id,name,level}] }
  params: new Map(),  // trackId -> { deviceId -> Map(paramId -> descriptor) }
  selection: { trackId: null, deviceId: null },
  view: { kind: "loading" },
  
  // Render state caching to prevent DOM recreation
  renderedTrackId: null,
  renderedDeviceId: null,
  lastModifiedVolume: new Map(),
  lastModifiedPan: new Map(),
  lastModifiedSend: new Map(),
};

// ---------------- DOM helpers ----------------

const $ = (sel) => document.querySelector(sel);
const el = (tag, props = {}, children = []) => {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === "class") node.className = v;
    else if (k === "dataset") Object.assign(node.dataset, v);
    else if (k === "on") {
      for (const [evt, fn] of Object.entries(v)) node.addEventListener(evt, fn);
    } else if (k in node) node[k] = v;
    else node.setAttribute(k, v);
  }
  for (const c of children) {
    if (c == null) continue;
    node.appendChild(typeof c === "string" ? document.createTextNode(c) : c);
  }
  return node;
};

let lastSentMixer = new Map();
let sendTimeoutsMixer = new Map();

function sendMixerCommandThrottled(targetId, type, val) {
  const key = `${type}:${targetId}`;
  const now = Date.now();
  const lastTime = lastSentMixer.get(key) || 0;
  if (now - lastTime > 40) {
    lastSentMixer.set(key, now);
    sendCommand({ type, targetId, value: val }).catch(() => {});
  } else {
    const existing = sendTimeoutsMixer.get(key);
    if (existing) clearTimeout(existing);
    const timeout = setTimeout(() => {
      lastSentMixer.set(key, Date.now());
      sendCommand({ type, targetId, value: val }).catch(() => {});
    }, 40);
    sendTimeoutsMixer.set(key, timeout);
  }
}

function showOnly(view) {
  for (const v of ["loading", "error", "tracks", "track", "device"]) {
    const e = document.getElementById(`view-${v}`);
    if (e) e.hidden = v !== view;
  }
}

function setStatus(text, kind) {
  const pill = $("#status-pill");
  const t = $("#status-text");
  if (t) t.textContent = text;
  if (!pill) return;
  pill.classList.remove("status-pending", "status-online", "status-error");
  pill.classList.add(`status-${kind}`);
}

let toastTimer = null;
function toast(msg, ok) {
  const node = $("#toast");
  if (!node) return;
  node.textContent = msg;
  node.classList.toggle("toast-ok", !!ok);
  node.hidden = false;
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { node.hidden = true; }, ok ? 1500 : 4000);
}

// ---------------- WebSocket ----------------

function connect() {
  const proto = location.protocol === "https:" ? "wss" : "ws";
  const url = `${proto}://${location.host}/mix/ws`;
  setStatus("connecting…", "pending");
  const ws = new WebSocket(url);
  state.ws = ws;

  ws.addEventListener("open", () => {
    state.connected = true;
    setStatus("online", "online");
  });

  ws.addEventListener("close", () => {
    state.connected = false;
    state.hello = null;
    setStatus("offline", "error");
    setTimeout(connect, 1500);
  });

  ws.addEventListener("error", () => {
    setStatus("error", "error");
  });

  ws.addEventListener("message", (e) => {
    let msg;
    try { msg = JSON.parse(e.data); }
    catch { return; }
    if (!msg || typeof msg !== "object") return;
    handleServerMessage(msg);
  });
}

function handleServerMessage(msg) {
  if (msg.type === SERVER_MSG.HELLO) {
    state.hello = msg;
    if (msg.protocolVersion !== MIX_PROTOCOL_VERSION) {
      toast(`Protocol mismatch (server v${msg.protocolVersion}, client v${MIX_PROTOCOL_VERSION})`, false);
    }
    setView({ kind: "tracks" });
    return;
  }
  if (msg.type === SERVER_MSG.SNAPSHOT) {
    if (msg.tier === "structure") onStructure(msg);
    else if (msg.tier === "mixer") onMixer(msg);
    else if (msg.tier === "params") onParams(msg);
    return;
  }
  if (msg.type === SERVER_MSG.ACK) {
    const p = state.pending.get(msg.refId);
    if (p) {
      state.pending.delete(msg.refId);
      p.resolve(msg);
    }
    return;
  }
  if (msg.type === SERVER_MSG.ERROR) {
    if (msg.refId) {
      const p = state.pending.get(msg.refId);
      if (p) {
        state.pending.delete(msg.refId);
        p.reject(new Error(msg.reason || "unknown"));
      }
    }
    toast(msg.reason || "error", false);
    return;
  }
}

// ---------------- Commands ----------------

function nextRef() {
  return `r${state.refCounter++}-${Date.now().toString(36)}`;
}

function sendCommand(msg) {
  if (!state.connected || !state.ws) {
    toast("Not connected", false);
    return Promise.reject(new Error("not_connected"));
  }
  const refId = nextRef();
  const payload = { refId, ...msg };
  const err = validateCommand(payload);
  if (err) {
    toast(err, false);
    return Promise.reject(new Error(err));
  }
  const promise = new Promise((resolve, reject) => {
    state.pending.set(refId, { resolve, reject, ts: Date.now() });
    setTimeout(() => {
      if (state.pending.has(refId)) {
        state.pending.delete(refId);
        reject(new Error("ack_timeout"));
      }
    }, 3000);
  });
  state.ws.send(JSON.stringify(payload));
  return promise;
}

function setSelection(trackId, deviceId) {
  state.selection = { trackId, deviceId };
  state.params.delete(trackId || "");
  sendCommand({ type: "mix.setSelection", targetId: trackId || trackId(TRACK_TYPES.REGULAR, 0), selection: { trackId, deviceId } })
    .catch(() => {});
}

// ---------------- Snapshot handlers ----------------

function onStructure(msg) {
  if (!Array.isArray(msg.tracks)) return;
  const next = new Map();
  for (const t of msg.tracks) {
    if (!t || typeof t.id !== "string") continue;
    next.set(t.id, {
      id: t.id,
      name: t.name || "(unnamed)",
      type: t.type,
      groupTrackId: t.groupTrackId || null,
    });
  }
  state.tracks = next;
  // Drop mixer/params entries for tracks that disappeared.
  for (const id of [...state.mixer.keys()]) {
    if (!state.tracks.has(id)) state.mixer.delete(id);
  }
  for (const id of [...state.params.keys()]) {
    if (!state.tracks.has(id)) state.params.delete(id);
  }
  // Re-render whatever view is active.
  renderActiveView();
}function onMixer(msg) {
  if (!Array.isArray(msg.tracks)) return;
  for (const m of msg.tracks) {
    if (!m || typeof m.id !== "string") continue;
    const existing = state.mixer.get(m.id) || { volume: 0, pan: 0, mute: false, solo: false, sends: [] };
    
    let vol = typeof m.volume === "number" ? m.volume : 0;
    const lastVolTime = state.lastModifiedVolume.get(m.id) || 0;
    if (Date.now() - lastVolTime < 1000) {
      vol = existing.volume;
    }

    let pan = typeof m.pan === "number" ? m.pan : 0;
    const lastPanTime = state.lastModifiedPan.get(m.id) || 0;
    if (Date.now() - lastPanTime < 1000) {
      pan = existing.pan;
    }

    let sends = Array.isArray(m.sends) ? m.sends : [];
    const updatedSends = sends.map(s => {
      const lastSendTime = state.lastModifiedSend.get(s.id) || 0;
      if (Date.now() - lastSendTime < 1000) {
        const extSend = existing.sends.find(x => x.id === s.id);
        if (extSend) return { ...s, level: extSend.level };
      }
      return s;
    });

    state.mixer.set(m.id, {
      volume: vol,
      pan: pan,
      mute: !!m.mute,
      solo: !!m.solo,
      sends: updatedSends,
    });
  }
  
  if (state.view.kind === "track") {
    updateTrackValues(state.view.trackId);
  } else {
    renderActiveView();
  }
}

function onParams(msg) {
  if (typeof msg.trackId !== "string" || !Array.isArray(msg.parameters)) return;
  if (!state.tracks.has(msg.trackId)) return;
  let perDevice = state.params.get(msg.trackId);
  if (!perDevice) {
    perDevice = new Map();
    state.params.set(msg.trackId, perDevice);
  }
  const seenDeviceIds = new Set();
  for (const p of msg.parameters) {
    if (!p || typeof p.id !== "string") continue;
    const parsed = parseId(p.id);
    if (!parsed || parsed.kind !== "parameter" || parsed.deviceIndex === null) continue;
    const did = deviceId(trackIdFor(parsed), parsed.deviceIndex);
    seenDeviceIds.add(did);
    let perParam = perDevice.get(did);
    if (!perParam) {
      perParam = new Map();
      perDevice.set(did, perParam);
    }
    const existing = perParam.get(p.id);
    if (existing && existing.lastModifiedLocally && (Date.now() - existing.lastModifiedLocally < 1000)) {
      p.value = existing.value;
      p.lastModifiedLocally = existing.lastModifiedLocally;
    }
    perParam.set(p.id, p);
  }
  
  if (state.view.kind === "device") {
    const v = state.view;
    if (v.trackId === msg.trackId) {
      const perDevice = state.params.get(v.trackId);
      const perParam = perDevice ? perDevice.get(v.deviceId) : null;
      if (perParam) {
        const firstParam = perParam.values().next().value;
        const devName = (firstParam && firstParam.deviceName) ? firstParam.deviceName : "";
        if (devName === "Auto Filter") {
          updateAutoFilterDeviceValues(v.trackId, v.deviceId);
        } else {
          updateGenericDeviceValues(v.trackId, v.deviceId);
        }
      }
    }
  } else if (state.view.kind === "track") {
    renderActiveView();
  }
  void seenDeviceIds;
}

function trackIdFor(parsed) {
  if (parsed.type === "master") return "mix:main";
  if (parsed.type === "return") return `mix:return:${parsed.trackIndex}`;
  return `mix:track:${parsed.trackIndex}`;
}

// ---------------- View rendering ----------------

function setView(view, opts) {
  state.view = view;
  state.refCounter += 1; // invalidate any in-flight params so the
                          // view doesn't re-render stale values
  
  if (view.kind !== "track") {
    state.renderedTrackId = null;
  }
  if (view.kind !== "device") {
    state.renderedDeviceId = null;
  }

  renderActiveView();
  if (opts && opts.replace) {
    // Fallback (track removed, etc): replace the current history
    // entry so pressing back skips the orphan and lands on the
    // real previous view.
    history.replaceState({ v: view }, "");
  } else {
    history.pushState({ v: view }, "");
  }
}

window.addEventListener("popstate", () => {
  if (!history.state || !history.state.v || history.state.v.kind !== "track") {
    state.renderedTrackId = null;
  }
  if (!history.state || !history.state.v || history.state.v.kind !== "device") {
    state.renderedDeviceId = null;
  }
  // The history state doesn't carry the view; the renderer falls
  // back to the tracks view on its own when state.view is stale
  // (e.g. the track was removed) and replaces the orphan entry so
  // the back button doesn't loop.
  renderActiveView();
});

function renderActiveView() {
  const v = state.view;
  const back = $("#btn-back");
  if (back) back.hidden = v.kind === "tracks" || v.kind === "loading";
  if (v.kind === "loading" || v.kind === "error") {
    showOnly(v.kind);
    return;
  }
  if (v.kind === "tracks") { showOnly("tracks"); renderTrackList(); $("#view-sub").textContent = `${state.tracks.size} tracks`; $("#view-title").textContent = "Mix"; return; }
  if (v.kind === "track") { showOnly("track"); renderTrack(v.trackId); return; }
  if (v.kind === "device") { showOnly("device"); renderDevice(v.trackId, v.deviceId); return; }
}

function renderTrackList() {
  const list = $("#track-list");
  if (!list) return;
  list.innerHTML = "";
  if (state.tracks.size === 0) {
    list.appendChild(el("li", { class: "muted" }, ["No tracks in the current Live set."]));
    return;
  }
  // Render regulars and groups first, then returns, then master, in
  // the order the server sent them. The server already sorts this
  // way; we trust the order.
  for (const t of state.tracks.values()) {
    const m = state.mixer.get(t.id) || { volume: 0, pan: 0, mute: false, solo: false, sends: [] };
    const row = el("li", { class: "track-row" + (m.mute ? " muted" : "") + (m.solo ? " soloed" : "") }, [
      el("span", { class: "name" }, [t.name]),
      el("span", { class: "badge " + (t.type || "regular") }, [t.type || "regular"]),
      el("span", { class: "ind" }, [volLabel(m.volume)]),
    ]);
    row.addEventListener("click", () => {
      if (t.type === "return") {
        // Returns have no mixer writes in v0.3.1; just show the detail
        // with sends (and a "read-only mixer" note in the future).
        setView({ kind: "track", trackId: t.id });
        return;
      }
      setView({ kind: "track", trackId: t.id });
    });
    list.appendChild(row);
  }
}

function volLabel(v) {
  if (typeof v !== "number") return "—";
  if (v < 0.0005) return "-inf";
  const db = 20 * Math.log10(v);
  return `${db.toFixed(1)} dB`;
}

function renderTrack(trackId) {
  const t = state.tracks.get(trackId);
  if (!t) {
    setView({ kind: "tracks" }, { replace: true });
    return;
  }
  const m = state.mixer.get(trackId) || { volume: 0, pan: 0, mute: false, solo: false, sends: [] };
  
  if (state.renderedTrackId !== trackId) {
    state.renderedTrackId = trackId;
    
    $("#view-title").textContent = t.name;
    $("#view-sub").textContent = t.type;
    $("#track-title").textContent = t.name;
    
    const volInput = $("#track-volume");
    if (volInput) {
      volInput.disabled = t.type === "return";
      volInput.oninput = () => {
        const val = Number(volInput.value);
        const volVal = $("#track-volume-val");
        if (volVal) volVal.textContent = (val * 100).toFixed(0) + "%";
        state.lastModifiedVolume.set(trackId, Date.now());
        sendMixerCommandThrottled(t.id, CLIENT_CMD.SET_VOLUME, clamp01(val));
      };
      volInput.onchange = null;
    }
    
    const panInput = $("#track-pan");
    if (panInput) {
      panInput.disabled = t.type === "return";
      panInput.oninput = () => {
        const val = Number(panInput.value);
        const panVal = $("#track-pan-val");
        if (panVal) panVal.textContent = val.toFixed(2);
        state.lastModifiedPan.set(trackId, Date.now());
        sendMixerCommandThrottled(t.id, CLIENT_CMD.SET_PAN, clampN11(val));
      };
      panInput.onchange = null;
    }

    const mute = $("#track-mute");
    if (mute) {
      mute.disabled = t.type === "return";
      mute.onclick = () => {
        sendCommand({ type: CLIENT_CMD.TOGGLE_MUTE, targetId: t.id })
          .then((res) => {
            if (res && res.result && typeof res.result.mute === "boolean") {
              mute.textContent = res.result.mute ? "Muted" : "Mute";
              mute.setAttribute("aria-pressed", res.result.mute ? "true" : "false");
            }
          })
          .catch((e) => toast(`Mute: ${e.message}`, false));
      };
    }

    const solo = $("#track-solo");
    if (solo) {
      solo.disabled = t.type === "return" || t.type === "master";
      solo.onclick = () => {
        sendCommand({ type: CLIENT_CMD.TOGGLE_SOLO, targetId: t.id })
          .then((res) => {
            if (res && res.result && typeof res.result.solo === "boolean") {
              solo.textContent = res.result.solo ? "Soloed" : "Solo";
              solo.setAttribute("aria-pressed", res.result.solo ? "true" : "false");
            }
          })
          .catch((e) => toast(`Solo: ${e.message}`, false));
      };
    }

    const sendsBody = $("#sends-body");
    if (sendsBody) {
      sendsBody.innerHTML = "";
      if (!m.sends || m.sends.length === 0) {
        sendsBody.appendChild(el("p", { class: "muted" }, ["No sends."]));
      } else {
        for (const s of m.sends) {
          const row = el("div", { class: "send-row" }, [
            el("span", { class: "lbl" }, [s.name || `Send ${s.id}`]),
            (() => {
              const r = el("input", {
                type: "range",
                min: "0",
                max: "1",
                step: "0.001",
                value: String(s.level)
              });
              r.setAttribute("data-send-id", s.id);
              r.disabled = t.type === "master";
              r.oninput = () => {
                const val = Number(r.value);
                const valEl = row.querySelector(`span[data-send-val-id="${s.id}"]`);
                if (valEl) valEl.textContent = (val * 100).toFixed(0) + "%";
                state.lastModifiedSend.set(s.id, Date.now());
                sendMixerCommandThrottled(s.id, CLIENT_CMD.SET_SEND, clamp01(val));
              };
              return r;
            })(),
          ]);
          const valEl = el("span", { class: "val" }, [(s.level * 100).toFixed(0) + "%"]);
          valEl.setAttribute("data-send-val-id", s.id);
          row.appendChild(valEl);
          sendsBody.appendChild(row);
        }
      }
    }

    const devList = $("#device-list");
    if (devList) {
      devList.innerHTML = "";
      const hint = el("li", { class: "muted", style: "padding: 8px" }, ["Tap a device to load its parameters."]);
      devList.appendChild(hint);
      const perDevice = state.params.get(trackId);
      if (perDevice) {
        const deviceIds = Array.from(perDevice.keys());
        deviceIds.sort((a, b) => {
          const ai = Number(a.split(":dev:")[1] || 0);
          const bi = Number(b.split(":dev:")[1] || 0);
          return ai - bi;
        });
        for (const did of deviceIds) {
          const perParam = perDevice.get(did);
          if (!perParam || perParam.size === 0) continue;
          const first = perParam.values().next().value;
          const devName = (first && first.deviceName) ? first.deviceName : `Device ${Number(did.split(":dev:")[1]) + 1}`;
          const row = el("li", { class: "device-row" }, [
            el("span", { class: "name" }, [devName]),
            el("span", { class: "arrow" }, ["›"]),
          ]);
          row.addEventListener("click", () => {
            setSelection(trackId, did);
            setView({ kind: "device", trackId, deviceId: did });
          });
          devList.appendChild(row);
        }
      }
    }

    if (!state.selection || state.selection.trackId !== trackId || state.selection.deviceId !== null) {
      setSelection(trackId, null);
    }
  }

  updateTrackValues(trackId);
}

function updateTrackValues(trackId) {
  const t = state.tracks.get(trackId);
  if (!t) return;
  const m = state.mixer.get(trackId) || { volume: 0, pan: 0, mute: false, solo: false, sends: [] };

  const volInput = $("#track-volume");
  const volVal = $("#track-volume-val");
  const lastVolTime = state.lastModifiedVolume.get(trackId) || 0;
  if (volInput && (Date.now() - lastVolTime >= 1000)) {
    volInput.value = String(m.volume);
    if (volVal) volVal.textContent = (m.volume * 100).toFixed(0) + "%";
  }

  const panInput = $("#track-pan");
  const panVal = $("#track-pan-val");
  const lastPanTime = state.lastModifiedPan.get(trackId) || 0;
  if (panInput && (Date.now() - lastPanTime >= 1000)) {
    panInput.value = String(m.pan);
    if (panVal) panVal.textContent = m.pan.toFixed(2);
  }

  const mute = $("#track-mute");
  if (mute) {
    mute.textContent = m.mute ? "Muted" : "Mute";
    mute.setAttribute("aria-pressed", m.mute ? "true" : "false");
  }

  const solo = $("#track-solo");
  if (solo) {
    solo.textContent = m.solo ? "Soloed" : "Solo";
    solo.setAttribute("aria-pressed", m.solo ? "true" : "false");
  }

  if (m.sends) {
    for (const s of m.sends) {
      const sendInput = document.querySelector(`input[data-send-id="${s.id}"]`);
      const sendVal = document.querySelector(`span[data-send-val-id="${s.id}"]`);
      const lastSendTime = state.lastModifiedSend.get(s.id) || 0;
      if (sendInput && (Date.now() - lastSendTime >= 1000)) {
        sendInput.value = String(s.level);
        if (sendVal) sendVal.textContent = (s.level * 100).toFixed(0) + "%";
      }
    }
  }
}

function renderDevice(trackId, deviceId) {
  const t = state.tracks.get(trackId);
  if (!t) {
    setView({ kind: "tracks" }, { replace: true });
    return;
  }
  const devNum = Number(deviceId.split(":dev:")[1] || 0);
  const list = $("#param-list");
  if (!list) return;

  const perDevice = state.params.get(trackId);
  const perParam = perDevice ? perDevice.get(deviceId) : null;
  if (!perParam || perParam.size === 0) {
    list.innerHTML = "";
    $("#view-title").textContent = `Device ${devNum + 1}`;
    $("#device-title").textContent = `Device ${devNum + 1}`;
    const sub = $("#device-sub");
    if (sub) sub.textContent = `${t.name} • ${devNum + 1} parameters may be limited by the per-tick budget.`;
    list.appendChild(el("p", { class: "muted" }, ["No parameters received yet. The server polls them in the background."]));
    state.renderedDeviceId = null;
    return;
  }

  // Detect correct device name from first parameter's deviceName
  const firstParam = perParam.values().next().value;
  const devName = (firstParam && firstParam.deviceName) ? firstParam.deviceName : `Device ${devNum + 1}`;
  $("#view-title").textContent = devName;
  $("#device-title").textContent = devName;
  const sub = $("#device-sub");
  if (sub) sub.textContent = `${t.name} • ${perParam.size} parameters may be limited by the per-tick budget.`;

  // Render structure once!
  if (state.renderedDeviceId !== deviceId) {
    state.renderedDeviceId = deviceId;
    list.innerHTML = "";

    if (devName === "Auto Filter") {
      renderAutoFilterDevice(trackId, deviceId, perParam, list);
    } else {
      // Sort by numeric suffix.
      const arr = Array.from(perParam.values()).sort((a, b) => {
        const ai = Number((a.id || "").split(":par:")[1] || 0);
        const bi = Number((b.id || "").split(":par:")[1] || 0);
        return ai - bi;
      });
      for (const p of arr) {
        const dom = renderParameter(p);
        const wrapper = document.createElement("div");
        wrapper.innerHTML = dom.html.trim();
        const node = wrapper.firstElementChild;
        if (!node) continue;
        const input = node.querySelector("input");
        const pvalEl = node.querySelector("[data-ref='pval']");
        const kind = p.kind;
        const enumSteps = kind === "enum" ? (Array.isArray(p.valueItems) ? p.valueItems.length : 0) : 0;
        
        node.setAttribute("data-param-row-id", p.id);
        if (pvalEl) pvalEl.setAttribute("data-param-val-id", p.id);

        if (input && !input.disabled) {
          input.addEventListener("input", () => {
            if (pvalEl) {
              if (kind === "enum") pvalEl.textContent = enumLabelFor(inputValueToWire(Number(input.value), kind, enumSteps), p.valueItems);
              else if (kind !== "toggle") pvalEl.textContent = (Number(input.value) * 100).toFixed(0) + "%";
            }
            p.lastModifiedLocally = Date.now();
            const wire = inputValueToWire(Number(input.value), kind, enumSteps);
            sendCommand({ type: CLIENT_CMD.SET_PARAM, targetId: p.id, value: wire }).catch(() => {});
          });
        }
        list.appendChild(node);
      }
    }
  }

  // Always update values dynamically!
  if (devName === "Auto Filter") {
    updateAutoFilterDeviceValues(trackId, deviceId);
  } else {
    updateGenericDeviceValues(trackId, deviceId);
  }
}

function updateGenericDeviceValues(trackId, deviceId) {
  const perDevice = state.params.get(trackId);
  const perParam = perDevice ? perDevice.get(deviceId) : null;
  if (!perParam) return;

  perParam.forEach(p => {
    const lastMod = p.lastModifiedLocally || 0;
    if (Date.now() - lastMod < 1000) return;

    const row = document.querySelector(`[data-param-row-id="${p.id}"]`);
    if (!row) return;

    const input = row.querySelector("input");
    const pvalEl = row.querySelector("[data-param-val-id]");
    const kind = p.kind;

    if (input) {
      if (kind === "toggle") {
        input.checked = p.value >= 0.5;
      } else {
        input.value = String(p.value);
      }
    }

    if (pvalEl) {
      if (kind === "enum") {
        pvalEl.textContent = enumLabelFor(p.value, p.valueItems);
      } else if (kind !== "toggle") {
        pvalEl.textContent = (p.value * 100).toFixed(0) + "%";
      }
    }
  });
}

function updateAutoFilterDeviceValues(trackId, deviceId) {
  const perDevice = state.params.get(trackId);
  const perParam = perDevice ? perDevice.get(deviceId) : null;
  if (!perParam) return;

  const params = Array.from(perParam.values());
  const typeParam = params.find(p => p.name === "Filter Type");
  const circuitParam = params.find(p => p.name === "Filter Circuit");
  const lfoWaveParam = params.find(p => p.name.toLowerCase().includes("wave") || p.name.toLowerCase().includes("waveform"));

  updateSegmentedActive(typeParam, "af-type-selector");
  updateSegmentedActive(circuitParam, "af-circuit-selector");
  updateSegmentedActive(lfoWaveParam, "af-lfo-wave-selector");

  perParam.forEach(p => {
    const lastMod = p.lastModifiedLocally || 0;
    if (Date.now() - lastMod < 1000) return;

    const knobWrapper = document.querySelector(`.rotary-knob-container[data-param-id="${p.id}"]`);
    if (!knobWrapper) return;

    const val = p.value ?? 0.5;
    const deg = -135 + val * 270;
    const pointer = knobWrapper.querySelector(".rotary-pointer");
    const valText = knobWrapper.querySelector(".rotary-value");

    if (pointer) pointer.style.transform = `rotate(${deg}deg)`;
    if (valText) valText.textContent = (val * 100).toFixed(0) + "%";
  });
}

function updateSegmentedActive(param, containerId) {
  if (!param) return;
  const container = document.getElementById(containerId);
  if (!container) return;

  const lastMod = param.lastModifiedLocally || 0;
  if (Date.now() - lastMod < 1000) return;

  const items = param.valueItems || [];
  const activeIdx = Math.round(param.value * (items.length - 1));
  const buttons = container.querySelectorAll(".seg-btn");
  buttons.forEach((btn, idx) => {
    btn.classList.toggle("active", idx === activeIdx);
  });
}

function renderAutoFilterDevice(trackId, deviceId, perParam, list) {
  const params = Array.from(perParam.values());
  const freqParam = params.find(p => p.name === "Frequency");
  const resParam = params.find(p => p.name === "Resonance");
  const typeParam = params.find(p => p.name === "Filter Type");
  const circuitParam = params.find(p => p.name === "Filter Circuit");
  const lfoWaveParam = params.find(p => p.name.toLowerCase().includes("wave") || p.name.toLowerCase().includes("waveform"));

  // Throttled sender for server updates
  let lastSent = new Map();
  let sendTimeouts = new Map();

  function sendParamValueThrottled(paramId, val) {
    const now = Date.now();
    const lastTime = lastSent.get(paramId) || 0;
    if (now - lastTime > 40) {
      lastSent.set(paramId, now);
      sendCommand({ type: CLIENT_CMD.SET_PARAM, targetId: paramId, value: val }).catch(() => {});
    } else {
      const existing = sendTimeouts.get(paramId);
      if (existing) clearTimeout(existing);
      const timeout = setTimeout(() => {
        lastSent.set(paramId, Date.now());
        sendCommand({ type: CLIENT_CMD.SET_PARAM, targetId: paramId, value: val }).catch(() => {});
      }, 40);
      sendTimeouts.set(paramId, timeout);
    }
  }

  list.innerHTML = `
    <div class="autofilter-container" style="display:flex; flex-direction:column; gap:10px; padding:4px; box-sizing:border-box; width:100%;">
      <!-- Canvas visualizer -->
      <div id="af-display" style="position:relative; width:100%; height:130px; background:#0c0c0e; border:1px solid #242426; border-radius:6px; overflow:hidden; touch-action:none;">
        <canvas id="af-canvas" style="width:100%; height:100%; display:block;"></canvas>
        <div id="af-dot" style="position:absolute; width:14px; height:14px; background:#0a84ff; border:2px solid #fff; border-radius:50%; margin-left:-7px; margin-top:-7px; box-shadow:0 0 10px #0a84ff; pointer-events:none;"></div>
      </div>

      <!-- Collapsible Panel 1: Filter Settings -->
      <div class="af-panel" id="panel-filter" style="background:#1c1c1e; border:1px solid #2c2c2e; border-radius:6px; overflow:hidden;">
        <div class="af-panel-header" style="display:flex; justify-content:space-between; align-items:center; padding:10px; background:#2c2c2e; cursor:pointer; font-size:11px; font-weight:700; color:#fff; text-transform:uppercase; letter-spacing:0.5px;">
          <span>Filter Settings</span>
          <span class="af-arrow" style="font-size:10px; transition:transform 0.2s;">▼</span>
        </div>
        <div class="af-panel-body" style="padding:10px; display:flex; flex-direction:column; gap:8px;">
          <div style="display:grid; grid-template-columns:1fr auto; gap:10px; align-items:center;">
            <div style="display:flex; flex-direction:column; gap:6px; min-width:0;">
              <!-- Filter Type Selector -->
              <div style="display:flex; align-items:center; gap:8px;">
                <span style="font-size:9px; color:#86868b; width:45px; flex-shrink:0;">Type</span>
                <div id="af-type-selector" style="display:flex; flex:1; background:#0c0c0e; padding:1px; border-radius:5px; border:1px solid #2c2c2e; gap:1px; min-width:0;"></div>
              </div>
              <!-- Filter Circuit Selector -->
              <div style="display:flex; align-items:center; gap:8px;">
                <span style="font-size:9px; color:#86868b; width:45px; flex-shrink:0;">Circuit</span>
                <div id="af-circuit-selector" style="display:flex; flex:1; background:#0c0c0e; padding:1px; border-radius:5px; border:1px solid #2c2c2e; gap:1px; min-width:0;"></div>
              </div>
            </div>
            <!-- Drive knob slot -->
            <div id="af-drive-slot" style="display:flex; justify-content:center; align-items:center; width:72px;"></div>
          </div>
        </div>
      </div>

      <!-- Collapsible Panel 2: Envelope -->
      <div class="af-panel" id="panel-envelope" style="background:#1c1c1e; border:1px solid #2c2c2e; border-radius:6px; overflow:hidden;">
        <div class="af-panel-header" style="display:flex; justify-content:space-between; align-items:center; padding:10px; background:#2c2c2e; cursor:pointer; font-size:11px; font-weight:700; color:#fff; text-transform:uppercase; letter-spacing:0.5px;">
          <span>Envelope</span>
          <span class="af-arrow" style="font-size:10px; transition:transform 0.2s;">▼</span>
        </div>
        <div class="af-panel-body" style="padding:10px;">
          <div id="af-env-dials" class="af-dials-grid"></div>
        </div>
      </div>

      <!-- Collapsible Panel 3: LFO / Mod -->
      <div class="af-panel" id="panel-lfo" style="background:#1c1c1e; border:1px solid #2c2c2e; border-radius:6px; overflow:hidden;">
        <div class="af-panel-header" style="display:flex; justify-content:space-between; align-items:center; padding:10px; background:#2c2c2e; cursor:pointer; font-size:11px; font-weight:700; color:#fff; text-transform:uppercase; letter-spacing:0.5px;">
          <span>LFO / Mod</span>
          <span class="af-arrow" style="font-size:10px; transition:transform 0.2s;">▼</span>
        </div>
        <div class="af-panel-body" style="padding:10px; display:flex; flex-direction:column; gap:10px;">
          <!-- Subgroup 1: Rate & Wave -->
          <div style="display:flex; flex-direction:column; gap:8px; border-bottom:1px solid #2c2c2e; padding-bottom:10px; margin-bottom:10px;">
            <div style="font-size:9px; font-weight:700; color:#86868b; text-transform:uppercase; letter-spacing:0.5px; margin-bottom:4px;">LFO Generator</div>
            <div style="display:grid; grid-template-columns:1fr auto; gap:10px; align-items:center;">
              <div style="display:flex; align-items:center; gap:8px;">
                <span style="font-size:9px; color:#86868b; width:45px; flex-shrink:0;">Wave</span>
                <div id="af-lfo-wave-selector" style="display:flex; flex:1; background:#0c0c0e; padding:1px; border-radius:5px; border:1px solid #2c2c2e; gap:1px; min-width:0;"></div>
              </div>
              <div id="af-lfo-rate-slot" style="display:flex; justify-content:center; align-items:center; width:72px;"></div>
            </div>
          </div>

          <!-- Subgroup 2: Modulation Depth -->
          <div style="display:flex; flex-direction:column; gap:8px; border-bottom:1px solid #2c2c2e; padding-bottom:10px; margin-bottom:10px;">
            <div style="font-size:9px; font-weight:700; color:#86868b; text-transform:uppercase; letter-spacing:0.5px; margin-bottom:4px;">Modulation Depth</div>
            <div id="af-lfo-depth-slot" class="af-dials-grid" style="grid-template-columns: 1fr;"></div>
          </div>

          <!-- Subgroup 3: Phase / Stereo / Spin -->
          <div style="display:flex; flex-direction:column; gap:8px;">
            <div style="font-size:9px; font-weight:700; color:#86868b; text-transform:uppercase; letter-spacing:0.5px; margin-bottom:4px;">Stereo & Phase</div>
            <div id="af-lfo-stereo-dials" class="af-dials-grid"></div>
          </div>
        </div>
      </div>
    </div>
  `;

  // Accordion toggle behavior
  document.querySelectorAll(".af-panel-header").forEach(header => {
    const panel = header.parentNode;
    const body = panel.querySelector(".af-panel-body");
    const arrow = header.querySelector(".af-arrow");
    
    header.onclick = () => {
      const collapsed = body.style.display === "none";
      body.style.display = collapsed ? "flex" : "none";
      arrow.style.transform = collapsed ? "rotate(0deg)" : "rotate(-90deg)";
      localStorage.setItem(`af-panel-collapsed:${panel.id}`, collapsed ? "false" : "true");
    };

    // Restore state
    const isCollapsed = localStorage.getItem(`af-panel-collapsed:${panel.id}`) === "true";
    if (isCollapsed) {
      body.style.display = "none";
      arrow.style.transform = "rotate(-90deg)";
    } else {
      body.style.display = "flex";
      arrow.style.transform = "rotate(0deg)";
    }
  });

  // Segment selector helper
  function renderSegmented(param, containerEl) {
    if (!param || !containerEl) return;
    containerEl.innerHTML = "";
    const items = param.valueItems || [];
    const activeIdx = Math.round(param.value * (items.length - 1));
    items.forEach((item, idx) => {
      const btn = document.createElement("button");
      btn.className = `seg-btn ${idx === activeIdx ? 'active' : ''}`;
      btn.textContent = item.name || `Step ${idx+1}`;
      btn.onclick = () => {
        const wireVal = items.length > 1 ? idx / (items.length - 1) : 0;
        param.value = wireVal;
        param.lastModifiedLocally = Date.now();
        sendCommand({ type: CLIENT_CMD.SET_PARAM, targetId: param.id, value: wireVal })
          .then(() => updateAutoFilterDeviceValues(trackId, deviceId))
          .catch((e) => toast(`Select: ${e.message}`, false));
      };
      containerEl.appendChild(btn);
    });
  }

  renderSegmented(typeParam, document.getElementById("af-type-selector"));
  renderSegmented(circuitParam, document.getElementById("af-circuit-selector"));
  renderSegmented(lfoWaveParam, document.getElementById("af-lfo-wave-selector"));

  // Rotary Dial rendering and drag logic helper
  function createRotaryDial(param, containerEl) {
    if (!param || !containerEl) return;

    const initialVal = param.value ?? 0.5;
    const initialDeg = -135 + initialVal * 270;
    const valTextStr = (initialVal * 100).toFixed(0) + "%";

    const knobWrapper = document.createElement("div");
    knobWrapper.className = "rotary-knob-container";
    knobWrapper.setAttribute("data-param-id", param.id);
    knobWrapper.innerHTML = `
      <div class="rotary-knob" style="touch-action:none; user-select:none;">
        <div class="rotary-pointer" style="transform: rotate(${initialDeg}deg);"></div>
      </div>
      <span class="rotary-label" title="${param.name}">${param.name}</span>
      <span class="rotary-value">${valTextStr}</span>
    `;

    containerEl.appendChild(knobWrapper);

    const knob = knobWrapper.querySelector(".rotary-knob");
    const pointer = knobWrapper.querySelector(".rotary-pointer");
    const valText = knobWrapper.querySelector(".rotary-value");

    let isKnobDragging = false;
    let startY = 0;
    let startVal = 0;

    function dragStart(clientY) {
      isKnobDragging = true;
      startY = clientY;
      startVal = param.value ?? 0.5;
    }

    function dragMove(clientY) {
      if (!isKnobDragging) return;
      const deltaY = startY - clientY;
      const sensitivity = 120; // 120px drag for full scale
      const newVal = Math.max(0, Math.min(1, startVal + deltaY / sensitivity));
      param.value = newVal;
      param.lastModifiedLocally = Date.now();
      const deg = -135 + newVal * 270;
      pointer.style.transform = `rotate(${deg}deg)`;
      valText.textContent = (newVal * 100).toFixed(0) + "%";
      sendParamValueThrottled(param.id, newVal);
    }

    function dragEnd() {
      isKnobDragging = false;
    }

    knob.addEventListener("mousedown", (e) => {
      dragStart(e.clientY);
    });
    window.addEventListener("mousemove", (e) => {
      if (isKnobDragging) dragMove(e.clientY);
    });
    window.addEventListener("mouseup", () => {
      if (isKnobDragging) dragEnd();
    });

    knob.addEventListener("touchstart", (e) => {
      dragStart(e.touches[0].clientY);
    }, { passive: true });
    window.addEventListener("touchmove", (e) => {
      if (isKnobDragging) dragMove(e.touches[0].clientY);
    });
    window.addEventListener("touchend", () => {
      if (isKnobDragging) dragEnd();
    });
  }

  // Populate Groups with Rotary Dials
  const driveSlot = document.getElementById("af-drive-slot");
  const envDials = document.getElementById("af-env-dials");
  const rateSlot = document.getElementById("af-lfo-rate-slot");
  const depthSlot = document.getElementById("af-lfo-depth-slot");
  const stereoDials = document.getElementById("af-lfo-stereo-dials");

  params.forEach(p => {
    // Skip frequency, resonance, filter type, filter circuit, and wave parameter
    if (p.id === freqParam?.id || p.id === resParam?.id || p.id === typeParam?.id || p.id === circuitParam?.id || p.id === lfoWaveParam?.id) {
      return;
    }

    const n = p.name.toLowerCase();
    if (n.includes("drive")) {
      createRotaryDial(p, driveSlot);
    } else if (n.includes("env") || n.includes("attack") || n.includes("release") || n.includes("decay") || n.includes("hold")) {
      createRotaryDial(p, envDials);
    } else if (n.includes("rate") || n.includes("frequency")) {
      createRotaryDial(p, rateSlot);
    } else if (n.includes("amount") || n.includes("depth")) {
      createRotaryDial(p, depthSlot);
    } else {
      createRotaryDial(p, stereoDials);
    }
  });

  // Canvas drawing & drag support
  const canvas = document.getElementById("af-canvas");
  const dot = document.getElementById("af-dot");
  const display = document.getElementById("af-display");
  const ctx = canvas.getContext("2d");

  function drawFilterCurve() {
    const rect = display.getBoundingClientRect();
    const w = rect.width;
    const h = rect.height;
    
    if (canvas.width !== Math.floor(w * window.devicePixelRatio) || canvas.height !== Math.floor(h * window.devicePixelRatio)) {
      canvas.width = w * window.devicePixelRatio;
      canvas.height = h * window.devicePixelRatio;
      ctx.scale(window.devicePixelRatio, window.devicePixelRatio);
    }

    ctx.clearRect(0, 0, w, h);

    // Draw background grid lines
    ctx.strokeStyle = "rgba(255, 255, 255, 0.04)";
    ctx.lineWidth = 1;
    for (let x = 0; x < w; x += 30) {
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, h);
      ctx.stroke();
    }
    for (let y = 0; y < h; y += 30) {
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(w, y);
      ctx.stroke();
    }

    // Dynamic parameter fetch for curve drawing!
    const pMap = state.params.get(trackId)?.get(deviceId);
    const fParam = pMap?.get(freqParam?.id);
    const rParam = pMap?.get(resParam?.id);
    const tParam = pMap?.get(typeParam?.id);

    const cx = fParam ? fParam.value : 0.5;
    const cy = rParam ? rParam.value : 0.2;

    const px = cx * w;
    const py = h - (cy * (h - 20) + 10);

    dot.style.left = `${px}px`;
    dot.style.top = `${py}px`;

    let typeName = "lowpass";
    if (tParam) {
      const items = tParam.valueItems || [];
      const activeIdx = Math.round(tParam.value * (items.length - 1));
      typeName = (items[activeIdx]?.name || "lowpass").toLowerCase();
    }

    ctx.strokeStyle = "var(--accent)";
    ctx.lineWidth = 3;
    ctx.beginPath();

    if (typeName.includes("highpass")) {
      ctx.moveTo(0, h);
      ctx.bezierCurveTo(px - 30, h, px - 15, py, px, py);
      ctx.bezierCurveTo(px + 10, py, px + 20, h * 0.4, px + 40, h * 0.4);
      ctx.lineTo(w, h * 0.4);
    } else if (typeName.includes("bandpass")) {
      ctx.moveTo(0, h);
      ctx.bezierCurveTo(px - 40, h, px - 20, py, px, py);
      ctx.bezierCurveTo(px + 20, py, px + 40, h, w, h);
    } else if (typeName.includes("notch")) {
      ctx.moveTo(0, h * 0.4);
      ctx.lineTo(px - 30, h * 0.4);
      ctx.bezierCurveTo(px - 15, h * 0.4, px - 5, h, px, h);
      ctx.bezierCurveTo(px + 5, h, px + 15, h * 0.4, px + 30, h * 0.4);
      ctx.lineTo(w, h * 0.4);
    } else {
      ctx.moveTo(0, h * 0.4);
      ctx.lineTo(Math.max(0, px - 40), h * 0.4);
      ctx.bezierCurveTo(px - 20, h * 0.4, px - 10, py, px, py);
      ctx.bezierCurveTo(px + 15, py, px + 25, h, px + 60, h);
      ctx.lineTo(w, h);
    }
    ctx.stroke();
  }

  // Draw
  requestAnimationFrame(drawFilterCurve);

  // Drag listeners
  let isDragging = false;
  function updateFromCoords(clientX, clientY) {
    const rect = display.getBoundingClientRect();
    const x = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
    const y = Math.max(0, Math.min(1, 1 - (clientY - rect.top) / rect.height));

    const pMap = state.params.get(trackId)?.get(deviceId);
    const fParamDynamic = pMap?.get(freqParam?.id);
    const rParamDynamic = pMap?.get(resParam?.id);

    if (fParamDynamic) {
      fParamDynamic.value = x;
      fParamDynamic.lastModifiedLocally = Date.now();
      sendParamValueThrottled(fParamDynamic.id, x);
    }
    if (rParamDynamic) {
      rParamDynamic.value = y;
      rParamDynamic.lastModifiedLocally = Date.now();
      sendParamValueThrottled(rParamDynamic.id, y);
    }
  }

  display.addEventListener("mousedown", (e) => {
    isDragging = true;
    updateFromCoords(e.clientX, e.clientY);
  });
  window.addEventListener("mousemove", (e) => {
    if (isDragging) updateFromCoords(e.clientX, e.clientY);
  });
  window.addEventListener("mouseup", () => {
    isDragging = false;
  });

  display.addEventListener("touchstart", (e) => {
    isDragging = true;
    const t = e.touches[0];
    updateFromCoords(t.clientX, t.clientY);
  }, { passive: true });
  window.addEventListener("touchmove", (e) => {
    if (isDragging) {
      const t = e.touches[0];
      updateFromCoords(t.clientX, t.clientY);
    }
  });
  window.addEventListener("touchend", () => {
    isDragging = false;
  });
}

// ---------------- Wire up ----------------

function clamp01(v) {
  if (!Number.isFinite(v)) return 0;
  if (v <= 0) return 0;
  if (v >= 1) return 1;
  return v;
}
function clampN11(v) {
  if (!Number.isFinite(v)) return 0;
  if (v <= -1) return -1;
  if (v >= 1) return 1;
  return v;
}

const back = $("#btn-back");
if (back) back.addEventListener("click", () => history.back());

// Rescan button: there isn't one in the markup but the server has
// the mix.rescan command. We trigger a rescan on first connect to
// force the structure cache to rebuild.
setTimeout(() => {
  if (state.connected && state.ws) {
    state.ws.send(JSON.stringify({ refId: nextRef(), type: CLIENT_CMD.RESCAN, targetId: trackId(TRACK_TYPES.REGULAR, 0) }));
  }
}, 500);

connect();
