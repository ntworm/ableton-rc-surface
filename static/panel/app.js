/* ── Ableton RC Bridge — Panel Client App v0.4 ──────────────── */

const clientsMap = new Map();
let currentTab = "connect";
let serverInfo = null;

// History buffer for sparklines
const sensorHistory = {};
window.sensorHistory = sensorHistory;
const sensorHistoryMax = 30;

// Packet tracking for VU meter
let packetCount = 0;
let packetsPerSec = 0;

// Define the 12 primary sensors for the Connect grid
const gridSensors = [
  { key: "sensor.orient.alpha", name: "Yaw (Alpha)", min: 0, max: 360, group: "orientation" },
  { key: "sensor.orient.beta", name: "Pitch (Beta)", min: -90, max: 90, group: "orientation" },
  { key: "sensor.orient.gamma", name: "Roll (Gamma)", min: -90, max: 90, group: "orientation" },
  { key: "sensor.motion.ax", name: "Accel X", min: -20, max: 20, group: "motion" },
  { key: "sensor.motion.ay", name: "Accel Y", min: -20, max: 20, group: "motion" },
  { key: "sensor.motion.az", name: "Accel Z", min: -20, max: 20, group: "motion" },
  { key: "sensor.audio.rms", name: "Audio RMS", min: 0, max: 1, group: "audio" },
  { key: "sensor.audio.pitch", name: "Audio Pitch", min: 50, max: 1500, group: "audio" },
  { key: "sensor.vision.hand.x", name: "Hand X", min: 0, max: 1, group: "vision" },
  { key: "sensor.vision.hand.y", name: "Hand Y", min: 0, max: 1, group: "vision" },
  { key: "sensor.vision.hand.z", name: "Hand Z (Depth)", min: 0, max: 1, group: "vision" },
  { key: "gesture.pinch", name: "Pinch", min: 0, max: 1, group: "gesture" }
];
window.gridSensors = gridSensors;

let dashboardSlots = [];

function loadDashboardConfig() {
  try {
    const saved = localStorage.getItem("ableton-rc:dashboard-slots");
    if (saved) {
      dashboardSlots = JSON.parse(saved);
    }
  } catch (e) {
    console.error("Failed to load dashboard slots:", e);
  }
  if (!dashboardSlots || dashboardSlots.length !== 12) {
    dashboardSlots = gridSensors.map(s => ({
      key: s.key,
      name: s.name,
      min: s.min,
      max: s.max,
      group: s.group
    }));
  }
}

function saveDashboardConfig() {
  localStorage.setItem("ableton-rc:dashboard-slots", JSON.stringify(dashboardSlots));
}

const allControlsGrouped = {
  SENSORS: [
    "sensor.orient.alpha", "sensor.orient.beta", "sensor.orient.gamma",
    "sensor.orient.fused.roll", "sensor.orient.fused.pitch", "sensor.orient.fused.yaw",
    "sensor.motion.ax", "sensor.motion.ay", "sensor.motion.az",
    "sensor.motion.gx", "sensor.motion.gy", "sensor.motion.gz",
    "sensor.motion.aig.ax", "sensor.motion.aig.ay", "sensor.motion.aig.az"
  ],
  AUDIO: [
    "sensor.audio.rms", "sensor.audio.pitch", "sensor.audio.bpm"
  ],
  VISION: [
    "sensor.vision.hand.active", "sensor.vision.hand.x", "sensor.vision.hand.y", "sensor.vision.hand.z", "sensor.vision.hand.fist",
    "sensor.vision.color.r", "sensor.vision.color.g", "sensor.vision.color.b"
  ],
  GESTURE: [
    "gesture.pinch", "gesture.rotate"
  ],
  Pads: [
    "pad-1", "pad-2", "pad-3", "pad-4", "pad-5", "pad-6", "pad-7", "pad-8", "pad-9", "pad-10", "pad-11", "pad-12"
  ],
  Knobs: [
    "knob-1", "knob-2", "knob-3", "knob-4", "knob-5", "knob-6"
  ],
  Faders: [
    "fader-1", "fader-2", "fader-3", "fader-4", "fader-5", "fader-6"
  ],
  "XY Pads": [
    "xy-1.x", "xy-1.y", "xy-2.x", "xy-2.y"
  ],
  Toggles: [
    "toggle-1", "toggle-2", "toggle-3", "toggle-4"
  ],
  Buttons: [
    "button-1", "button-2", "button-3", "button-4"
  ],
  Ribbons: [
    "ribbon-1", "ribbon-2"
  ]
};
window.allControlsGrouped = allControlsGrouped;

function getControlDisplayName(ctrl) {
  if (ctrl.startsWith("pad-")) {
    return `Pad ${ctrl.slice(4)}`;
  }
  if (ctrl.startsWith("knob-")) {
    return `Knob ${ctrl.slice(5)}`;
  }
  if (ctrl.startsWith("fader-")) {
    return `Fader ${ctrl.slice(6)}`;
  }
  if (ctrl.startsWith("toggle-")) {
    const num = parseInt(ctrl.slice(7));
    if (num <= 4) return `L${num} (Toggle)`;
    return `Toggle ${num}`;
  }
  if (ctrl.startsWith("button-")) {
    const num = parseInt(ctrl.slice(7));
    if (num <= 4) return `S${num} (Stutter)`;
    return `Button ${num}`;
  }
  if (ctrl.startsWith("xy-")) {
    const parts = ctrl.split(".");
    const num = parts[0].slice(3);
    const axis = (parts[1] || "").toUpperCase();
    return `XY ${num} ${axis}`;
  }
  if (ctrl.startsWith("ribbon-")) {
    return `Ribbon ${ctrl.slice(7)}`;
  }
  if (ctrl.startsWith("gate-")) {
    return `Gate ${ctrl.slice(5)}`;
  }
  if (ctrl.startsWith("scene-")) {
    return `Scene ${ctrl.slice(6)}`;
  }
  if (ctrl.startsWith("sensor.audio.")) {
    return `Audio ${ctrl.slice(13).toUpperCase()}`;
  }
  if (ctrl.startsWith("sensor.vision.")) {
    return `Vision ${ctrl.slice(14)}`;
  }
  if (ctrl.startsWith("sensor.orient.")) {
    return `Orient ${ctrl.slice(14)}`;
  }
  if (ctrl.startsWith("sensor.motion.")) {
    return `Motion ${ctrl.slice(14)}`;
  }
  if (ctrl.startsWith("gesture.")) {
    return `Gesture ${ctrl.slice(8)}`;
  }
  return ctrl;
}

// ── Init & Resize ────────────────────────────────────────────
window.addEventListener("DOMContentLoaded", () => {
  // Initialize serverInfo from injected globals or fallback to window.location
  const isRunning = window.INITIAL_IS_RUNNING !== undefined ? window.INITIAL_IS_RUNNING : (window.location.port ? true : false);
  const port = window.INITIAL_PORT !== undefined ? window.INITIAL_PORT : (window.location.port ? parseInt(window.location.port) : null);
  
  serverInfo = {
    isRunning: isRunning,
    port: port,
    statusText: isRunning ? "Running" : "Stopped",
    phoneUrl: null,
    mixUrl: null,
    qrSrc: "",
    mixQrSrc: "",
    primaryIp: "—",
    otherIps: []
  };
  updateServerUI();

  initTabs();
  initCopyButtons();
  initFooterActions();
  initTemplatesUI();
  loadDashboardConfig();
  buildSensorGrid();
  buildCtrlGroups();
  connectWS();

  // Poll server state and VU meter regularly
  setInterval(updateVUMeter, 1000);
  setInterval(refreshServerInfo, 3000);
});


// ── Tab Navigation ───────────────────────────────────────────
function initTabs() {
  document.querySelectorAll(".tab-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      const tab = btn.dataset.tab;
      switchTab(tab);
    });
  });
}

function switchTab(tab) {
  currentTab = tab;
  document.querySelectorAll(".tab-btn").forEach(b => b.classList.toggle("active", b.dataset.tab === tab));
  document.querySelectorAll(".tab-content").forEach(c => c.classList.toggle("active", c.id === `tab-${tab}`));

  if (tab === "mappings") {
    renderMappingsTab();
  }
}

// ── WebSocket Communications ─────────────────────────────────
function connectWS() {
  const port = serverInfo ? serverInfo.port : null;
  if (!port) {
    // If not running, show offline placeholder
    updateServerUI();
    return;
  }
  const wsUrl = `ws://127.0.0.1:${port}/admin/ws`;
  window.connectCoreWS(
    wsUrl,
    // onOpen
    () => {
      refreshServerInfo();
      fetchTargets();
      fetchMappings();
    },
    // onClose
    () => {
      // managed by core
    },
    // onClientUpdate
    (msg) => {
      packetCount++;
      const clientId = msg.client.client_id;
      if (msg.client.status === "stale") {
        clientsMap.delete(clientId);
      } else {
        clientsMap.set(clientId, msg);
      }
      updateClientsStrip();
      processClientSensors(msg);
    }
  );
}

// sendWS is provided globally by mappings-core.js (window.sendWS)
function refreshServerInfo() {
  sendWS("getServerInfo", {}, (res) => {
    if (res.ok) {
      serverInfo = res.result;
      updateServerUI();
    }
  });
}

function fetchTargets() {
  sendWS("getTargets", {}, (res) => {
    if (res.ok) {
      window.allTargetsRaw = res.result.targets || [];
      // Flatten target structures
      window.allTargets = [];
      window.allTargetsRaw.forEach(t => {
        if (t.type === "tempo") {
          window.allTargets.push(t);
        } else {
          // Track mixer params
          if (t.mixer) t.mixer.forEach(m => window.allTargets.push(m));
          // Device params
          if (t.devices) {
            t.devices.forEach(d => {
              if (d.params) d.params.forEach(p => {
                p.trackName = t.name;
                p.deviceName = d.name;
                window.allTargets.push(p);
              });
            });
          }
        }
      });
    }
  });
}

function fetchMappings() {
  sendWS("getMappings", {}, (res) => {
    if (res.ok) {
      window.currentMappings = res.result.mappings || {};
      const count = res.result.total || 0;
      document.getElementById("badge-mappings").textContent = count;
      if (currentTab === "mappings") {
        window.renderMappingsTab();
      }
    }
  });
}

// ── Connect Tab UI ───────────────────────────────────────────
let activePicker = null;

function openSlotEditor(index, anchorBtn) {
  if (activePicker) {
    activePicker.remove();
    activePicker = null;
  }

  const picker = document.createElement("div");
  picker.className = "slot-picker-popup";
  picker.style.cssText = `
    position: absolute;
    z-index: 10000;
    background: #1c1c1e;
    border: 1px solid #2c2c2e;
    border-radius: 8px;
    box-shadow: 0 4px 12px rgba(0,0,0,0.5);
    width: 180px;
    max-height: 250px;
    overflow-y: auto;
    padding: 4px;
    font-family: inherit;
    font-size: 11px;
  `;

  const rect = anchorBtn.getBoundingClientRect();
  const scrollX = window.scrollX || document.documentElement.scrollX || 0;
  const scrollY = window.scrollY || document.documentElement.scrollY || 0;
  
  // Position slightly to the left to align right edge
  picker.style.left = (rect.left + scrollX - 160) + "px";
  picker.style.top = (rect.bottom + scrollY + 4) + "px";

  const groups = {
    "Sensors": [
      { key: "sensor.orient.alpha", name: "Yaw (Alpha)", min: 0, max: 360, group: "orientation" },
      { key: "sensor.orient.beta", name: "Pitch (Beta)", min: -90, max: 90, group: "orientation" },
      { key: "sensor.orient.gamma", name: "Roll (Gamma)", min: -90, max: 90, group: "orientation" },
      { key: "sensor.motion.ax", name: "Accel X", min: -20, max: 20, group: "motion" },
      { key: "sensor.motion.ay", name: "Accel Y", min: -20, max: 20, group: "motion" },
      { key: "sensor.motion.az", name: "Accel Z", min: -20, max: 20, group: "motion" },
      { key: "sensor.audio.rms", name: "Audio RMS", min: 0, max: 1, group: "audio" },
      { key: "sensor.audio.pitch", name: "Audio Pitch", min: 50, max: 1500, group: "audio" },
      { key: "sensor.vision.hand.x", name: "Hand X", min: 0, max: 1, group: "vision" },
      { key: "sensor.vision.hand.y", name: "Hand Y", min: 0, max: 1, group: "vision" },
      { key: "sensor.vision.hand.z", name: "Hand Z (Depth)", min: 0, max: 1, group: "vision" },
      { key: "gesture.pinch", name: "Pinch", min: 0, max: 1, group: "gesture" }
    ],
    "Pads": Array.from({length: 12}, (_, i) => ({ key: `pad-${i+1}`, name: `Pad ${i+1}`, min: 0, max: 1, group: "controls" })),
    "Knobs": Array.from({length: 6}, (_, i) => ({ key: `knob-${i+1}`, name: `Knob ${i+1}`, min: 0, max: 1, group: "controls" })),
    "Faders": Array.from({length: 6}, (_, i) => ({ key: `fader-${i+1}`, name: `Fader ${i+1}`, min: 0, max: 1, group: "controls" })),
    "XY Pads": [
      { key: "xy-1.x", name: "XY 1 X", min: 0, max: 1, group: "controls" },
      { key: "xy-1.y", name: "XY 1 Y", min: 0, max: 1, group: "controls" },
      { key: "xy-2.x", name: "XY 2 X", min: 0, max: 1, group: "controls" },
      { key: "xy-2.y", name: "XY 2 Y", min: 0, max: 1, group: "controls" }
    ],
    "Toggles": Array.from({length: 4}, (_, i) => ({ key: `toggle-${i+1}`, name: `L${i+1} (Toggle)`, min: 0, max: 1, group: "controls" })),
    "Buttons": Array.from({length: 4}, (_, i) => ({ key: `button-${i+1}`, name: `S${i+1} (Stutter)`, min: 0, max: 1, group: "controls" })),
    "Ribbons": [
      { key: "ribbon-1", name: "Ribbon 1", min: 0, max: 1, group: "controls" },
      { key: "ribbon-2", name: "Ribbon 2", min: 0, max: 1, group: "controls" }
    ]
  };

  Object.entries(groups).forEach(([groupName, items]) => {
    const header = document.createElement("div");
    header.style.cssText = `
      padding: 4px 6px;
      font-weight: 700;
      color: var(--text3);
      text-transform: uppercase;
      font-size: 8px;
      letter-spacing: 0.5px;
      border-bottom: 1px solid rgba(255,255,255,0.03);
      margin-top: 4px;
    `;
    header.textContent = groupName;
    picker.appendChild(header);

    items.forEach(item => {
      const option = document.createElement("div");
      option.style.cssText = `
        padding: 4px 8px;
        color: var(--text2);
        cursor: pointer;
        border-radius: 4px;
        transition: background 0.1s, color 0.1s;
      `;
      option.textContent = item.name;
      
      if (dashboardSlots[index] && dashboardSlots[index].key === item.key) {
        option.style.fontWeight = "bold";
        option.style.color = "var(--accent)";
      }

      option.onmouseenter = () => {
        option.style.background = "rgba(255,255,255,0.08)";
        option.style.color = "var(--text)";
      };
      option.onmouseleave = () => {
        option.style.background = "transparent";
        option.style.color = (dashboardSlots[index] && dashboardSlots[index].key === item.key) ? "var(--accent)" : "var(--text2)";
      };

      option.onclick = () => {
        dashboardSlots[index] = item;
        saveDashboardConfig();
        buildSensorGrid();
        picker.remove();
        activePicker = null;
      };

      picker.appendChild(option);
    });
  });

  document.body.appendChild(picker);
  activePicker = picker;

  const dismiss = (e) => {
    if (activePicker && !picker.contains(e.target) && e.target !== anchorBtn) {
      picker.remove();
      activePicker = null;
      document.removeEventListener("mousedown", dismiss);
    }
  };
  document.addEventListener("mousedown", dismiss);
}

const controlCellRefs = new Map();

function safeDomId(value) {
  return String(value).replace(/[^a-zA-Z0-9_-]+/g, "-").replace(/^-+|-+$/g, "");
}

function unregisterControlCellScope(scope) {
  for (const [key, refs] of controlCellRefs.entries()) {
    for (const ref of [...refs]) {
      if (ref.scope === scope) refs.delete(ref);
    }
    if (refs.size === 0) controlCellRefs.delete(key);
  }
}

function registerControlCell(key, ref) {
  if (!controlCellRefs.has(key)) controlCellRefs.set(key, new Set());
  controlCellRefs.get(key).add(ref);
}

function controlCellName(key, fallbackName) {
  if (fallbackName) return fallbackName.toUpperCase();
  if (key.startsWith("pad-")) return `PAD ${key.slice(4)}`;
  if (key.startsWith("knob-")) return `KNOB ${key.slice(5)}`;
  if (key.startsWith("fader-")) return `FADER ${key.slice(6)}`;
  if (key.startsWith("toggle-")) return `L${key.slice(7)} TOGGLE`;
  if (key.startsWith("button-")) return `S${key.slice(7)} STUTTER`;
  if (key.startsWith("xy-")) {
    const [pad, axis = ""] = key.split(".");
    return `XY ${pad.slice(3)} ${axis.toUpperCase()}`;
  }
  const gridSensor = gridSensors.find(sensor => sensor.key === key);
  if (gridSensor) return gridSensor.name.toUpperCase();
  return getControlDisplayName(key).toUpperCase();
}

function controlCellRange(key, minVal, maxVal) {
  if (Number.isFinite(minVal) && Number.isFinite(maxVal)) {
    return { min: minVal, max: maxVal };
  }
  const gridSensor = gridSensors.find(sensor => sensor.key === key);
  if (gridSensor) return { min: gridSensor.min, max: gridSensor.max };
  return { min: 0, max: 1 };
}

function createEl(tagName, className, text) {
  const el = document.createElement(tagName);
  if (className) el.className = className;
  if (text !== undefined) el.textContent = text;
  return el;
}

function buildControlCell(key, options = {}) {
  const scope = options.scope || "control";
  const instanceId = safeDomId(options.instanceId || `${scope}-${key}`);
  const range = controlCellRange(key, options.min, options.max);

  const cell = createEl("div", `sensor-cell inactive${options.className ? ` ${options.className}` : ""}`);
  cell.id = options.id || `ctrl-cell-${instanceId}`;
  cell.dataset.controlKey = key;
  cell.dataset.cellScope = scope;

  const badge = createEl("span", "off-badge", "OFF");
  const nameEl = createEl("div", "cell-name", controlCellName(key, options.name));
  const valueEl = createEl("div", "cell-value", "0.00");
  valueEl.id = `val-ctrl-${safeDomId(key)}-${instanceId}`;

  const progress = createEl("div", "cell-progress-container");
  const barEl = createEl("div", "cell-progress-bar");
  barEl.id = `bar-ctrl-${safeDomId(key)}-${instanceId}`;
  progress.appendChild(barEl);

  const spark = createEl("div", "cell-sparkline");
  const svg = document.createElement("svg");
  svg.setAttribute("viewBox", "0 0 120 20");
  svg.setAttribute("preserveAspectRatio", "none");
  const sparkPath = document.createElement("path");
  sparkPath.id = `spark-ctrl-${safeDomId(key)}-${instanceId}`;
  sparkPath.setAttribute("d", "M0,10");
  svg.appendChild(sparkPath);
  spark.appendChild(svg);

  cell.appendChild(badge);

  if (options.editIndex !== undefined) {
    const editBtn = createEl("button", "cell-edit-btn", "✎");
    editBtn.title = "Configurar Slot";
    editBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      openSlotEditor(options.editIndex, editBtn);
    });
    editBtn.addEventListener("mouseenter", () => {
      editBtn.style.color = "var(--text)";
      editBtn.style.background = "rgba(255,255,255,0.08)";
    });
    editBtn.addEventListener("mouseleave", () => {
      editBtn.style.color = "var(--text3)";
      editBtn.style.background = "transparent";
    });
    cell.appendChild(editBtn);
    nameEl.style.paddingRight = "12px";
  }

  cell.appendChild(nameEl);
  cell.appendChild(valueEl);
  cell.appendChild(progress);
  cell.appendChild(spark);

  cell.addEventListener("click", () => {
    window.selectedControl = key;
    selectedControl = key;
    switchTab("mappings");
  });

  registerControlCell(key, {
    scope,
    cell,
    badge,
    valueEl,
    barEl,
    sparkPath,
    min: range.min,
    max: range.max,
    historyKey: `cell-${instanceId}`
  });

  return cell;
}

// Grouped control categories: PADS, XY PADS, TOGGLES, STUTTERS, KNOBS, FADERS, SENSORS.
// Each category is a clickable header showing name + count. Click expands
// the same big cells used by the top Connect grid.
function buildCtrlGroups() {
  const container = document.getElementById("ctrl-groups");
  if (!container) return;

  unregisterControlCellScope("SENSORS");
  unregisterControlCellScope("PADS");
  unregisterControlCellScope("XY PADS");
  unregisterControlCellScope("TOGGLES");
  unregisterControlCellScope("STUTTERS");
  unregisterControlCellScope("KNOBS");
  unregisterControlCellScope("FADERS");

  const groups = [
    { id: "SENSORS", label: "SENSORS", keys: gridSensors.map(s => s.key) },
    { id: "PADS", label: "PADS", keys: allControlsGrouped.Pads || [] },
    { id: "XY PADS", label: "XY PADS", keys: allControlsGrouped["XY Pads"] || [] },
    { id: "TOGGLES", label: "TOGGLES", keys: allControlsGrouped.Toggles || [] },
    { id: "STUTTERS", label: "STUTTERS", keys: allControlsGrouped.Buttons || [] },
    { id: "KNOBS", label: "KNOBS", keys: allControlsGrouped.Knobs || [] },
    { id: "FADERS", label: "FADERS", keys: allControlsGrouped.Faders || [] },
  ];

  container.innerHTML = "";

  groups.forEach(group => {
    if (!group.keys || group.keys.length === 0) return;

    const wrap = document.createElement("div");
    wrap.className = "ctrl-group";
    wrap.dataset.group = group.label;
    wrap.dataset.count = String(group.keys.length);

    const header = document.createElement("button");
    header.className = "ctrl-group-header";
    header.type = "button";
    const title = createEl("span", "ctrl-group-title", group.label);
    const meta = createEl("span", "ctrl-group-meta");
    const count = createEl("span", "ctrl-group-count", String(group.keys.length));
    const chevron = createEl("span", "ctrl-group-chevron", "▸");
    meta.appendChild(count);
    meta.appendChild(chevron);
    header.appendChild(title);
    header.appendChild(meta);

    const list = document.createElement("div");
    list.className = "ctrl-group-list hidden";
    list.dataset.group = group.label;

    group.keys.forEach((key, index) => {
      list.appendChild(buildControlCell(key, {
        scope: group.label,
        instanceId: `${group.label}-${key}`,
        min: gridSensors.find(s => s.key === key)?.min,
        max: gridSensors.find(s => s.key === key)?.max,
        name: gridSensors.find(s => s.key === key)?.name,
      }));
    });

    header.onclick = () => {
      const isHidden = list.classList.toggle("hidden");
      if (chevron) chevron.style.transform = isHidden ? "rotate(0deg)" : "rotate(90deg)";
    };

    wrap.appendChild(header);
    wrap.appendChild(list);
    container.appendChild(wrap);
  });
}

function buildSensorGrid() {
  const grid = document.getElementById("sensor-grid");
  grid.innerHTML = "";
  unregisterControlCellScope("dashboard");
  
  dashboardSlots.forEach((slot, index) => {
    grid.appendChild(buildControlCell(slot.key, {
      scope: "dashboard",
      instanceId: `slot-${index}-${slot.key}`,
      id: `cell-slot-${index}`,
      name: slot.name,
      min: slot.min,
      max: slot.max,
      editIndex: index,
    }));
  });
}

function updateClientsStrip() {
  const countEl = document.getElementById("conn-count");
  const count = clientsMap.size;
  countEl.textContent = count;
  document.getElementById("conn-pulse").classList.toggle("active", count > 0);
}

// Latest CPU reading from getServerInfo.cpuUsage (0-100). Used by the
// shared VU meter to display server load.
let lastCpuUsage = 0;

function updateVUMeter() {
  packetsPerSec = packetCount;
  packetCount = 0;
  const fill = document.getElementById("vu-fill");
  if (!fill) return;
  fill.style.width = Math.max(0, Math.min(100, lastCpuUsage)) + "%";
  if (lastCpuUsage < 50) {
    fill.style.background = "var(--accent)";
  } else if (lastCpuUsage < 80) {
    fill.style.background = "#f5a623";
  } else {
    fill.style.background = "#e74c3c";
  }
}

function processClientSensors(msg) {
  const latest = msg.latest;
  if (!latest) return;

  // Track sensor status configurations
  const statuses = latest.sensors || {};
  
  // Extract control values
  const controls = latest.controls || [];
  const controlsMap = new Map();
  controls.forEach(c => {
    if (c.x !== undefined && c.y !== undefined) {
      controlsMap.set(c.name + ".x", c.x);
      controlsMap.set(c.name + ".y", c.y);
    } else {
      controlsMap.set(c.name, c.value);
    }
  });

  // Update liveControls Map & DOM rows for physical controls (with XY pads support)
  for (const ctrl of controls) {
    if (ctrl.x !== undefined && ctrl.y !== undefined) {
      const nameX = ctrl.name + ".x";
      const nameY = ctrl.name + ".y";

      const prevX = liveControls.get(nameX);
      if (prevX === undefined || Math.abs(prevX - ctrl.x) > 0.001) {
        liveControls.set(nameX, ctrl.x);
        updateControlRowValue(nameX, ctrl.x);
        updateControlCell(nameX, ctrl.x, true);
      }

      const prevY = liveControls.get(nameY);
      if (prevY === undefined || Math.abs(prevY - ctrl.y) > 0.001) {
        liveControls.set(nameY, ctrl.y);
        updateControlRowValue(nameY, ctrl.y);
        updateControlCell(nameY, ctrl.y, true);
      }
    } else {
      const prev = liveControls.get(ctrl.name);
      if (prev === undefined || Math.abs(prev - ctrl.value) > 0.001) {
        liveControls.set(ctrl.name, ctrl.value);
        updateControlRowValue(ctrl.name, ctrl.value);
        updateControlCell(ctrl.name, ctrl.value, true);
      }
    }
  }

  // Extract readings
  const motion = latest.sensors?.motion_reading || {};
  const orient = latest.sensors?.orientation_reading || {};
  const audio = latest.sensors?.audio_reading || {};
  const vision = latest.sensors?.vision_reading || {};

  // For sensors, update liveControls and DOM rows too
  if (statuses.orientation === "available" || statuses.orientation === "active") {
    if (typeof orient.alpha === 'number') {
      updateSensorLiveControl("sensor.orient.alpha", orient.alpha);
      updateSensorLiveControl("sensor.orient.beta", orient.beta);
      updateSensorLiveControl("sensor.orient.gamma", orient.gamma);
      updateSensorLiveControl("sensor.orient.fused.yaw", orient.alpha);
      updateSensorLiveControl("sensor.orient.fused.pitch", orient.beta);
      updateSensorLiveControl("sensor.orient.fused.roll", orient.gamma);
    }
  }
  if (statuses.motion === "available" || statuses.motion === "active") {
    const lm = latest.motion || {};
    if (lm.ax !== undefined) {
      updateSensorLiveControl("sensor.motion.ax", lm.ax);
      updateSensorLiveControl("sensor.motion.ay", lm.ay);
      updateSensorLiveControl("sensor.motion.az", lm.az);
    } else {
      const a = motion.acceleration;
      if (a) {
        updateSensorLiveControl("sensor.motion.ax", a.x);
        updateSensorLiveControl("sensor.motion.ay", a.y);
        updateSensorLiveControl("sensor.motion.az", a.z);
      }
    }
    const aig = motion.acceleration_including_gravity;
    if (aig) {
      updateSensorLiveControl("sensor.motion.aig.ax", aig.x);
      updateSensorLiveControl("sensor.motion.aig.ay", aig.y);
      updateSensorLiveControl("sensor.motion.aig.az", aig.z);
    }
    const rot = latest.sensors?.motion_reading?.rotation_rate || latest.motion;
    if (rot) {
      updateSensorLiveControl("sensor.motion.gx", rot.gx ?? rot.x ?? 0);
      updateSensorLiveControl("sensor.motion.gy", rot.gy ?? rot.y ?? 0);
      updateSensorLiveControl("sensor.motion.gz", rot.gz ?? rot.z ?? 0);
    }
  }
  if (statuses.audio === "available" || statuses.audio === "active") {
    if (typeof audio.rms === 'number') {
      updateSensorLiveControl("sensor.audio.rms", audio.rms);
      updateSensorLiveControl("sensor.audio.pitch", audio.pitch);
      updateSensorLiveControl("sensor.audio.bpm", audio.bpm);
    }
  }
  if (statuses.vision === "available" || statuses.vision === "active") {
    if (typeof vision.active === 'number' || typeof vision.x === 'number') {
      updateSensorLiveControl("sensor.vision.hand.active", vision.active ? 1 : 0);
      updateSensorLiveControl("sensor.vision.hand.x", vision.x);
      updateSensorLiveControl("sensor.vision.hand.y", vision.y);
      updateSensorLiveControl("sensor.vision.hand.z", vision.z);
      updateSensorLiveControl("sensor.vision.hand.fist", vision.is_fist ? 1 : 0);
      if (vision.color) {
        updateSensorLiveControl("sensor.vision.color.r", vision.color.r);
        updateSensorLiveControl("sensor.vision.color.g", vision.color.g);
        updateSensorLiveControl("sensor.vision.color.b", vision.color.b);
      }
    }
  }

  dashboardSlots.forEach((slot, index) => {
    let value = 0;
    let available = false;

    // Check category status or availability
    if (slot.key.startsWith("sensor.orient.")) {
      const axis = slot.key.split(".").pop();
      value = orient[axis] ?? 0;
      available = statuses.orientation === "available" || statuses.orientation === "active";
    } else if (slot.key.startsWith("sensor.motion.")) {
      const axis = slot.key.split(".").pop();
      const cleanAxis = axis === "ax" ? "x" : (axis === "ay" ? "y" : (axis === "az" ? "z" : axis));
      if (latest.motion && latest.motion[axis] !== undefined) {
        value = latest.motion[axis] ?? 0;
      } else {
        value = motion.acceleration?.[cleanAxis] ?? 0;
      }
      available = statuses.motion === "available" || statuses.motion === "active";
    } else if (slot.key.startsWith("sensor.audio.")) {
      const prop = slot.key.split(".").pop();
      value = audio[prop] ?? 0;
      available = statuses.audio === "available" || statuses.audio === "active";
    } else if (slot.key.startsWith("sensor.vision.hand.")) {
      const prop = slot.key.split(".").pop();
      value = vision[prop] ?? 0;
      available = statuses.vision === "available" || statuses.vision === "active";
    } else if (slot.key === "gesture.pinch") {
      value = controlsMap.get("gesture.pinch") ?? 0;
      available = true;
    } else {
      value = controlsMap.get(slot.key) ?? 0;
      available = true;
    }

    updateDashboardSlotCell(index, slot.key, value, available, slot.min, slot.max);
  });

  // If selected control in mappings tab is active, update details
  if (currentTab === "mappings" && selectedControl) {
    let activeVal = 0;
    if (selectedControl.startsWith("sensor.orient.")) {
      activeVal = orient[selectedControl.split(".").pop()] ?? 0;
    } else if (selectedControl.startsWith("sensor.motion.")) {
      const axis = selectedControl.split(".").pop();
      const cleanAxis = axis === "ax" ? "x" : (axis === "ay" ? "y" : (axis === "az" ? "z" : axis));
      if (latest.motion && latest.motion[axis] !== undefined) {
        activeVal = latest.motion[axis] ?? 0;
      } else {
        activeVal = motion.acceleration?.[cleanAxis] ?? 0;
      }
    } else if (selectedControl.startsWith("sensor.audio.")) {
      activeVal = audio[selectedControl.split(".").pop()] ?? 0;
    } else if (selectedControl.startsWith("sensor.vision.")) {
      activeVal = vision[selectedControl.split(".").pop()] ?? 0;
    } else {
      activeVal = controlsMap.get(selectedControl) ?? 0;
    }
    updateMappingDetailLive(selectedControl, activeVal);
  }
}

function updateSensorLiveControl(name, value) {
  if (typeof value !== 'number') return;
  const prev = liveControls.get(name);
  if (prev === undefined || Math.abs(prev - value) > 0.001) {
    liveControls.set(name, value);
    updateControlRowValue(name, value);
    updateControlCell(name, value, true);
  }
}

function updateControlRowValue(name, val) {
  const row = document.querySelector(`.map-item[data-ctrl="${name}"] .live-val`);
  if (row) row.textContent = val.toFixed(3);
}

function updateControlCell(key, value, available = true, minVal, maxVal) {
  if (typeof value !== "number" || !Number.isFinite(value)) return;
  const refs = controlCellRefs.get(key);
  if (!refs) return;
  for (const ref of refs) {
    updateControlCellRef(ref, value, available, minVal, maxVal);
  }
}

function updateControlCellRef(ref, value, available, minVal, maxVal) {
  const { cell, badge, valueEl, barEl, sparkPath } = ref;
  if (!cell) return;
  // Toggle active/inactive states
  cell.classList.toggle("inactive", !available);
  if (badge) badge.hidden = available;

  // Update value text
  if (valueEl) {
    const prevStr = valueEl.textContent;
    const newStr = value.toFixed(2);
    valueEl.textContent = newStr;

    // Trigger brief highlighting on shifts > 5%
    if (prevStr !== newStr) {
      const prev = parseFloat(prevStr);
      if (!isNaN(prev) && Math.abs(value - prev) > 0.05) {
        cell.classList.add("highlight");
        setTimeout(() => cell.classList.remove("highlight"), 200);
      }
    }
  }

  // Update progress bar
  if (barEl) {
    const min = Number.isFinite(minVal) ? minVal : ref.min;
    const max = Number.isFinite(maxVal) ? maxVal : ref.max;
    const range = max - min;
    const normalized = range === 0 ? 0.5 : (value - min) / range;
    const pct = Math.max(0, Math.min(100, normalized * 100));
    barEl.style.width = pct + "%";
  }

  // Push values and redraw sparklines
  const historyKey = ref.historyKey;
  if (!sensorHistory[historyKey]) sensorHistory[historyKey] = [];
  sensorHistory[historyKey].push(value);
  if (sensorHistory[historyKey].length > sensorHistoryMax) sensorHistory[historyKey].shift();

  if (available && sparkPath) {
    const min = Number.isFinite(minVal) ? minVal : ref.min;
    const max = Number.isFinite(maxVal) ? maxVal : ref.max;
    drawSparkline(sparkPath, sensorHistory[historyKey], min, max);
  }
}

function updateDashboardSlotCell(index, key, value, available, minVal, maxVal) {
  updateControlCell(key, value, available, minVal, maxVal);
}

function drawSparkline(pathEl, values, minVal, maxVal) {
  if (values.length < 2) return;
  const width = 120;
  const height = 16;
  let d = "";
  for (let i = 0; i < values.length; i++) {
    const x = (i / (values.length - 1)) * width;
    const range = maxVal - minVal;
    const normalized = range === 0 ? 0.5 : (values[i] - minVal) / range;
    const y = height - Math.max(0, Math.min(1, normalized)) * height;
    d += `${i === 0 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)}`;
  }
  pathEl.setAttribute("d", d);
}

// ── Mappings Tab UI ──────────────────────────────────────────
// Handled by mappings.js

// ── Interfaces Tab UI ────────────────────────────────────────
function ensureQRCode(frame, url) {
  if (!frame || !url) return;
  frame.onclick = null;
  delete frame.dataset.url;
  frame.style.cursor = "default";
  if (frame.dataset.qrUrl === url) return;

  frame.innerHTML = "";
  frame.dataset.qrUrl = url;
  new QRCode(frame, {
    text: url,
    width: 140,
    height: 140,
    colorDark: "#000000",
    colorLight: "#ffffff",
    correctLevel: QRCode.CorrectLevel.L
  });
}

function clearQRCode(frame) {
  if (!frame) return;
  frame.onclick = null;
  delete frame.dataset.url;
  delete frame.dataset.qrUrl;
  frame.innerHTML = "";
}

function updateServerUI() {
  if (!serverInfo) return;

  const active = serverInfo.isRunning;
  const dot = document.getElementById("footer-dot");
  dot.className = `server-dot ${active ? 'on' : 'off'}`;
  document.getElementById("footer-status").textContent = serverInfo.statusText || (active ? "Running" : "Stopped");

  // Show start/stop buttons accordingly
  document.getElementById("btn-start").classList.toggle("hidden", active);
  document.getElementById("btn-stop").classList.toggle("hidden", !active);

  // Interfaces info
  const primaryIp = serverInfo.primaryIp || "—";
  document.getElementById("iface-primary-ip").textContent = primaryIp;
  document.getElementById("iface-primary-url").textContent = serverInfo.phoneUrl || "Server not running";

  const otherList = document.getElementById("iface-list");
  otherList.innerHTML = "";
  if (serverInfo.otherIps && serverInfo.otherIps.length > 0) {
    serverInfo.otherIps.forEach(ip => {
      const url = `http://${ip}:${serverInfo.port}/`;
      const row = document.createElement("div");
      row.className = "iface-row";
      row.innerHTML = `
        <span class="ip">${url}</span>
        <button class="btn sm copy-btn" data-url="${url}">Copy</button>
      `;
      otherList.appendChild(row);
    });
    // Bind new copies
    initCopyButtons();
  } else {
    otherList.innerHTML = `<div style="color:var(--text3);font-size:11px;padding:8px">No other interfaces detected</div>`;
  }

  // Connection mode info
  document.getElementById("mode-proto").textContent = serverInfo.useHttps ? "HTTPS" : "HTTP";
  document.getElementById("mode-port").textContent = serverInfo.port || "—";
  document.getElementById("mode-cert").textContent = serverInfo.useHttps ? "Self-signed" : "n/a";

  // Server CPU usage (consumed by the conn-strip VU meter via lastCpuUsage)
  lastCpuUsage = typeof serverInfo.cpuUsage === "number" ? serverInfo.cpuUsage : 0;
  updateVUMeter();

  // Connect QRs
  const qrPerf = document.getElementById("qr-perf");
  const qrMix = document.getElementById("qr-mix");
  const urlPerf = document.getElementById("url-perf");
  const urlMix = document.getElementById("url-mix");

  const row = document.getElementById("qr-row");
  const placeholder = document.getElementById("qr-placeholder");

  if (active && serverInfo.phoneUrl) {
    if (row) row.classList.remove("hidden");
    if (placeholder) placeholder.classList.add("hidden");

    ensureQRCode(qrPerf, serverInfo.phoneUrl);
    ensureQRCode(qrMix, serverInfo.mixUrl);

    if (urlPerf) urlPerf.textContent = serverInfo.phoneUrl;
    if (urlMix) urlMix.textContent = serverInfo.mixUrl;

    const openPerf = document.getElementById("open-perf");
    if (openPerf) openPerf.href = serverInfo.phoneUrl;
    const openMix = document.getElementById("open-mix");
    if (openMix) openMix.href = serverInfo.mixUrl;

    const copyPrimary = document.getElementById("copy-primary");
    if (copyPrimary) copyPrimary.dataset.url = serverInfo.phoneUrl;

    const adminLink = document.getElementById("link-admin");
    if (adminLink) adminLink.href = serverInfo.adminUrl;
  } else {
    if (row) row.classList.add("hidden");
    if (placeholder) placeholder.classList.remove("hidden");
    clearQRCode(qrPerf);
    clearQRCode(qrMix);
    if (urlPerf) urlPerf.textContent = "";
    if (urlMix) urlMix.textContent = "";
  }
}

// ── Copy to Clipboard & Actions ──────────────────────────────
function initCopyButtons() {
  document.querySelectorAll("[data-url]").forEach(btn => {
    btn.onclick = (e) => {
      e.stopPropagation();
      copyText(btn.dataset.url, btn);
    };
  });
}

function copyText(text, btn) {
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(text).then(() => showCopied(btn)).catch(() => fallbackCopy(text, btn));
  } else {
    fallbackCopy(text, btn);
  }
}

function fallbackCopy(text, btn) {
  const ta = document.createElement("textarea");
  ta.value = text;
  ta.style.position = "fixed";
  ta.style.opacity = "0";
  document.body.appendChild(ta);
  ta.select();
  try {
    document.execCommand("copy");
    showCopied(btn);
  } catch {}
  document.body.removeChild(ta);
}

function showCopied(btn) {
  const oldText = btn.textContent;
  btn.textContent = "Copied!";
  btn.classList.add("copied");
  setTimeout(() => {
    btn.textContent = oldText;
    btn.classList.remove("copied");
  }, 1200);
}

function initFooterActions() {
  document.querySelectorAll(".footer .btn[data-action]").forEach(btn => {
    btn.addEventListener("click", () => {
      sendHostAction(btn.dataset.action);
    });
  });
}

function sendHostAction(action) {
  // Use postMessage bridge back to Live host
  const m = { method: "close_and_send", params: [action] };
  if (window.webkit?.messageHandlers?.live) {
    window.webkit.messageHandlers.live.postMessage(m);
  } else if (window.chrome?.webview) {
    window.chrome.webview.postMessage(m);
  }
}

// ── Starter Templates Interaction ─────────────────────────────
function initTemplatesUI() {
  const btnTemplate = document.getElementById("btn-template-modal");
  const modal = document.getElementById("template-modal");
  const closeBtn = document.getElementById("template-modal-close");
  const list = document.getElementById("template-list");

  if (!btnTemplate || !modal || !closeBtn || !list) return;

  closeBtn.onclick = () => modal.classList.add("hidden");

  btnTemplate.onclick = () => {
    modal.classList.remove("hidden");
    list.innerHTML = "";

    Object.entries(window.MappingTemplates).forEach(([id, t]) => {
      const card = document.createElement("div");
      card.style.cssText = `
        background: var(--bg2);
        border: 1px solid var(--border);
        border-radius: 6px;
        padding: 10px;
        cursor: pointer;
        transition: border-color var(--transition);
      `;
      card.innerHTML = `
        <div style="font-weight:700;font-size:11px;color:var(--accent)">${t.name}</div>
        <div style="font-size:10px;color:var(--text2);margin-top:2px">${t.description}</div>
      `;
      card.onmouseenter = () => card.style.borderColor = "var(--accent)";
      card.onmouseleave = () => card.style.borderColor = "var(--border)";
      card.onclick = () => {
        if (confirm(`Load template "${t.name}"? This will overwrite existing mappings for these controls.`)) {
          loadMappingTemplate(t.mappings);
          modal.classList.add("hidden");
        }
      };
      list.appendChild(card);
    });
  };
}

function loadMappingTemplate(mappings) {
  // Apply each control mapping to currentMappings
  Object.entries(mappings).forEach(([control, targets]) => {
    // Determine the mapping key (with client prefix if active, otherwise global)
    const mapKey = window.getMappingKey(window.selectedClient, control);
    window.currentMappings[mapKey] = targets;
    
    // Send to server
    window.sendWS("setMapping", { control: mapKey, targets }, () => {
      fetchMappings();
    });
  });
}
