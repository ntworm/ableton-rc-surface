/* ── Ableton RC Bridge — Panel Dialog Mappings Tab Logic ────────── */

window.renderMappingsTab = function() {
  const listEl = document.getElementById("map-list");
  if (!listEl) return;
  const filter = document.getElementById("map-search").value.toLowerCase();
  listEl.innerHTML = "";

  Object.entries(window.allControlsGrouped).forEach(([groupName, controls]) => {
    const filteredControls = controls.filter(c => c.toLowerCase().includes(filter));
    if (filteredControls.length === 0) return;

    // Group Header
    const gh = document.createElement("div");
    gh.className = "map-group-header";
    gh.innerHTML = `<span>${groupName}</span><span class="count">${filteredControls.length}</span>`;
    listEl.appendChild(gh);

    filteredControls.forEach(ctrl => {
      const item = document.createElement("div");
      const isMapped = window.currentMappings[ctrl] && window.currentMappings[ctrl].length > 0;
      item.className = `map-item ${ctrl === window.selectedControl ? 'selected' : ''} ${isMapped ? 'mapped' : ''}`;
      item.setAttribute("data-ctrl", ctrl);
      const liveVal = window.liveControls.get(ctrl);
      const liveValStr = liveVal !== undefined ? (typeof liveVal === 'number' ? liveVal.toFixed(3) : (liveVal.val !== undefined ? liveVal.val.toFixed(3) : "—")) : "—";
      item.innerHTML = `
        <span class="led"></span>
        <span class="dot"></span>
        <span class="name">${getControlDisplayName(ctrl)}</span>
        <span class="live-val">${liveValStr}</span>
      `;
      item.addEventListener("click", () => {
        window.selectedControl = ctrl;
        window.renderMappingsTab();
        window.renderMappingDetail();
      });
      listEl.appendChild(item);
    });
  });

  // Attach search filter update
  const searchInput = document.getElementById("map-search");
  if (searchInput && !searchInput.dataset.bound) {
    searchInput.dataset.bound = "true";
    searchInput.addEventListener("input", window.renderMappingsTab);
  }

  window.renderMappingDetail();
};

window.renderMappingDetail = function() {
  const empty = document.getElementById("map-empty");
  const detail = document.getElementById("map-detail");
  if (!empty || !detail) return;
  
  if (!window.selectedControl) {
    empty.classList.remove("hidden");
    detail.classList.add("hidden");
    return;
  }

  empty.classList.add("hidden");
  detail.classList.remove("hidden");

  document.getElementById("map-detail-name").textContent = getControlDisplayName(window.selectedControl);

  // Bind/unbind triggers
  const targets = window.currentMappings[window.selectedControl] || [];
  const targetContainer = document.getElementById("map-detail-targets");
  targetContainer.innerHTML = "";

  if (targets.length === 0) {
    targetContainer.innerHTML = `<span style="font-size:11px;color:var(--text3);font-style:italic">No targets bound</span>`;
  } else {
    targets.forEach((t, idx) => {
      const chip = document.createElement("div");
      chip.className = "bound-chip";
      chip.innerHTML = `
        <span>${t.label || t.type}</span>
        <span class="remove" title="Remove mapping">✕</span>
      `;
      chip.querySelector(".remove").addEventListener("click", () => {
        window.removeBoundTarget(idx);
      });
      targetContainer.appendChild(chip);
    });
  }

  // Setup range sliders for the first target
  const primaryTarget = targets[0];
  window.setupRangeSliders(primaryTarget);

  // Draw response preview graph if mapping exists
  const graphContainer = document.getElementById("map-detail-graph");
  if (graphContainer) {
    if (primaryTarget) {
      graphContainer.innerHTML = window.renderMappingGraph(primaryTarget, 160, 60);
    } else {
      graphContainer.innerHTML = `<span style="font-size:10px;color:var(--text3)">No graph available</span>`;
    }
  }

  // Bind to button trigger
  const btnBind = document.getElementById("btn-bind");
  btnBind.onclick = () => window.openBindModal();
};

window.renderMappingGraph = function(target, width = 120, height = 40) {
  const inMin = target.inMin ?? 0;
  const inMax = target.inMax ?? 1;
  const outMin = target.outMin ?? 0;
  const outMax = target.outMax ?? 1;
  const curve = target.curve || 'linear';

  const points = [];
  for (let i = 0; i <= 20; i++) {
    const x = i / 20;
    // Map input range
    const normalized = (x - inMin) / (inMax - inMin || 1);
    const clamped = Math.max(0, Math.min(1, normalized));

    let curved;
    switch (curve) {
      case 'exponential': curved = clamped * clamped; break;
      case 'logarithmic': curved = Math.sqrt(clamped); break;
      case 's-curve': curved = 0.5 * (1 - Math.cos(clamped * Math.PI)); break;
      default: curved = clamped;
    }

    const y = curved * (outMax - outMin) + outMin;
    const px = x * width;
    const py = height - y * height; // invert Y since SVG 0 is top
    points.push(`${px.toFixed(1)},${py.toFixed(1)}`);
  }

  return `
    <svg viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" style="overflow:visible">
      <polyline points="${points.join(' ')}" stroke="var(--accent)" stroke-width="1.5" fill="none"/>
      <line x1="0" y1="${height}" x2="${width}" y2="${height}" stroke="var(--border)" stroke-width="0.5"/>
      <line x1="0" y1="0" x2="0" y2="${height}" stroke="var(--border)" stroke-width="0.5"/>
    </svg>
  `;
};

window.updateMappingDetailLive = function(ctrl, value) {
  if (ctrl !== window.selectedControl) return;
  document.getElementById("map-detail-val").textContent = value.toFixed(3);

  if (!window.sensorHistory[ctrl]) window.sensorHistory[ctrl] = [];
  // Mappings page detail shows a slightly wider viewport
  const path = document.getElementById("map-detail-spark");
  if (path) {
    // Guessing ranges for basic sparklines in detail panel
    let min = 0, max = 1;
    const matchedGrid = window.gridSensors.find(s => s.key === ctrl);
    if (matchedGrid) {
      min = matchedGrid.min;
      max = matchedGrid.max;
    } else if (ctrl.includes("beta") || ctrl.includes("gamma") || ctrl.includes("roll") || ctrl.includes("pitch")) {
      min = -90; max = 90;
    } else if (ctrl.includes("alpha") || ctrl.includes("yaw")) {
      min = 0; max = 360;
    } else if (ctrl.includes("motion")) {
      min = -20; max = 20;
    }
    
    window.drawSparkline(path, window.sensorHistory[ctrl], min, max);
  }
};

window.setupRangeSliders = function(target) {
  const fill = document.getElementById("range-fill");
  const handleMin = document.getElementById("range-min");
  const handleMax = document.getElementById("range-max");
  const labelMin = document.getElementById("range-min-label");
  const labelMax = document.getElementById("range-max-label");
  const bar = document.getElementById("range-bar");

  if (!fill || !handleMin || !handleMax || !bar) return;

  if (!target) {
    // Default inactive ranges
    fill.style.left = "0%";
    fill.style.width = "100%";
    handleMin.style.left = "0%";
    handleMax.style.left = "100%";
    labelMin.textContent = "0.00";
    labelMax.textContent = "1.00";
    return;
  }

  let minVal = target.outMin ?? 0;
  let maxVal = target.outMax ?? 1;

  updateSlidersUI();

  function updateSlidersUI() {
    const minPct = minVal * 100;
    const maxPct = maxVal * 100;
    handleMin.style.left = minPct + "%";
    handleMax.style.left = maxPct + "%";
    fill.style.left = Math.min(minPct, maxPct) + "%";
    fill.style.width = Math.abs(maxPct - minPct) + "%";
    labelMin.textContent = minVal.toFixed(2);
    labelMax.textContent = maxVal.toFixed(2);

    // Redraw graph while dragging
    const graphContainer = document.getElementById("map-detail-graph");
    if (graphContainer) {
      target.outMin = minVal;
      target.outMax = maxVal;
      graphContainer.innerHTML = window.renderMappingGraph(target, 160, 60);
    }
  }

  function handleDrag(e, type) {
    e.preventDefault();
    const rect = bar.getBoundingClientRect();
    
    function onMouseMove(moveEvent) {
      const pct = Math.max(0, Math.min(1, (moveEvent.clientX - rect.left) / rect.width));
      if (type === "min") {
        minVal = pct;
      } else {
        maxVal = pct;
      }
      updateSlidersUI();
    }

    function onMouseUp() {
      window.removeEventListener("mousemove", onMouseMove);
      window.removeEventListener("mouseup", onMouseUp);
      // Save changes back to server
      target.outMin = minVal;
      target.outMax = maxVal;
      window.saveMappingTargets();
    }

    window.addEventListener("mousemove", onMouseMove);
    window.addEventListener("mouseup", onMouseUp);
  }

  handleMin.onmousedown = (e) => handleDrag(e, "min");
  handleMax.onmousedown = (e) => handleDrag(e, "max");
};

window.removeBoundTarget = function(index) {
  if (!window.selectedControl) return;
  const targets = window.currentMappings[window.selectedControl] || [];
  targets.splice(index, 1);
  if (targets.length === 0) {
    window.sendWS("removeMapping", { control: window.selectedControl }, () => {
      window.fetchMappings();
    });
  } else {
    window.saveMappingTargets(targets);
  }
};

window.saveMappingTargets = function(targets = null) {
  if (!window.selectedControl) return;
  const finalTargets = targets || window.currentMappings[window.selectedControl] || [];
  window.sendWS("setMapping", { control: window.selectedControl, targets: finalTargets }, () => {
    window.fetchMappings();
  });
};

window.openBindModal = function() {
  const modal = document.getElementById("bind-modal");
  const list = document.getElementById("bind-list");
  const search = document.getElementById("bind-search");
  const step1 = document.getElementById("bind-step-1");
  const step2 = document.getElementById("bind-step-2");

  if (!modal || !list || !search || !step1 || !step2) return;

  modal.classList.remove("hidden");
  step1.classList.remove("hidden");
  step2.classList.add("hidden");
  search.value = "";
  search.focus();

  const expanded = new Set();
  renderModalList();

  search.oninput = renderModalList;

  function renderModalList() {
    list.innerHTML = "";
    const filter = search.value.toLowerCase().trim();
    let totalShown = 0;

    window.allTargetsRaw.forEach((track) => {
      if (track.type === "tempo") {
        if (!filter || "song tempo".includes(filter)) {
          const row = document.createElement("div");
          row.className = "bind-track";
          row.innerHTML = `<span class="bind-chev">▶</span><span class="bind-track-name">Song Tempo</span>`;
          row.onclick = () => {
            window.openBindStep2(track);
          };
          list.appendChild(row);
          totalShown++;
        }
        return;
      }

      const trackLabel = track.name || `Track ${track.trackIndex + 1}`;
      if (filter && !trackLabel.toLowerCase().includes(filter)) {
        const mixerMatches = (track.mixer || []).some(m =>
          (m.label || m.type || "").toLowerCase().includes(filter));
        const deviceMatches = (track.devices || []).some(d =>
          (d.name || "").toLowerCase().includes(filter) ||
          (d.params || []).some(p => (p.label || p.type || "").toLowerCase().includes(filter)));
        if (!mixerMatches && !deviceMatches) return;
      }

      const trackKey = `track-${track.trackIndex}`;
      const isExpanded = filter || expanded.has(trackKey);

      const trackRow = document.createElement("div");
      trackRow.className = "bind-track";
      trackRow.innerHTML = `<span class="bind-chev">${isExpanded ? "▼" : "▶"}</span><span class="bind-track-name">${trackLabel}</span>`;
      trackRow.onclick = () => {
        if (expanded.has(trackKey)) expanded.delete(trackKey);
        else expanded.add(trackKey);
        renderModalList();
      };
      list.appendChild(trackRow);
      totalShown++;

      if (!isExpanded) return;

      (track.mixer || []).forEach((m) => {
        const lbl = m.label || m.type;
        if (filter && !lbl.toLowerCase().includes(filter)) return;
        const row = document.createElement("div");
        row.className = "bind-param bind-mixer";
        row.innerHTML = `<span class="bind-name">${lbl}</span><span class="bind-kind">mixer</span>`;
        row.onclick = () => {
          window.openBindStep2(m);
        };
        list.appendChild(row);
        totalShown++;
      });

      (track.devices || []).forEach((dev) => {
        const devLabel = dev.name || `Device ${dev.index + 1}`;
        const devKey = `device-${track.trackIndex}-${dev.index}`;
        const devMatches = !filter ||
          devLabel.toLowerCase().includes(filter) ||
          (dev.params || []).some(p => (p.label || p.type || "").toLowerCase().includes(filter));

        if (!devMatches) return;

        const devExpanded = filter || expanded.has(devKey);

        const devRow = document.createElement("div");
        devRow.className = "bind-device";
        devRow.innerHTML = `<span class="bind-chev">${devExpanded ? "▼" : "▶"}</span><span class="bind-device-name">${devLabel}</span><span class="bind-kind">device</span>`;
        devRow.onclick = () => {
          if (expanded.has(devKey)) expanded.delete(devKey);
          else expanded.add(devKey);
          renderModalList();
        };
        list.appendChild(devRow);
        totalShown++;

        if (!devExpanded) return;

        (dev.params || []).forEach((p) => {
          const plbl = p.label || p.type;
          if (filter && !plbl.toLowerCase().includes(filter)) return;
          const row = document.createElement("div");
          row.className = "bind-param bind-device-param";
          row.innerHTML = `<span class="bind-name">${plbl}</span><span class="bind-kind">param</span>`;
          row.onclick = () => {
            window.openBindStep2(p);
          };
          list.appendChild(row);
          totalShown++;
        });
      });
    });

    if (totalShown === 0) {
      list.innerHTML = `<div style="padding:12px;color:var(--text3);text-align:center;font-size:11px">No parameters found</div>`;
    }
  }

  const closeBtn = document.getElementById("bind-modal-close");
  if (closeBtn) closeBtn.onclick = () => modal.classList.add("hidden");
};

window.openBindStep2 = function(t) {
  const step1 = document.getElementById("bind-step-1");
  const step2 = document.getElementById("bind-step-2");
  if (!step1 || !step2) return;

  step1.classList.add("hidden");
  step2.classList.remove("hidden");

  document.getElementById("bind-target-label").textContent = "Selected: " + window.getTargetLabel(t);

  const curveSelect = document.getElementById("bind-curve");
  const inMinSlider = document.getElementById("bind-in-min");
  const inMaxSlider = document.getElementById("bind-in-max");
  const outMinSlider = document.getElementById("bind-out-min");
  const outMaxSlider = document.getElementById("bind-out-max");

  curveSelect.value = "linear";
  inMinSlider.value = 0;
  inMaxSlider.value = 100;
  outMinSlider.value = 0;
  outMaxSlider.value = 100;

  document.getElementById("bind-in-min-val").textContent = "0.00";
  document.getElementById("bind-in-max-val").textContent = "1.00";
  document.getElementById("bind-out-min-val").textContent = "0.00";
  document.getElementById("bind-out-max-val").textContent = "1.00";

  function updatePreviewCurve() {
    const curve = curveSelect.value;
    const inMin = parseFloat(inMinSlider.value) / 100;
    const inMax = parseFloat(inMaxSlider.value) / 100;
    const outMin = parseFloat(outMinSlider.value) / 100;
    const outMax = parseFloat(outMaxSlider.value) / 100;

    const points = [];
    const width = 120, height = 50;
    for (let i = 0; i <= 20; i++) {
      const x = i / 20;
      // Map input range
      const normalized = (x - inMin) / (inMax - inMin || 1);
      const clamped = Math.max(0, Math.min(1, normalized));

      let curved;
      switch (curve) {
        case 'exponential': curved = clamped * clamped; break;
        case 'logarithmic': curved = Math.sqrt(clamped); break;
        case 's-curve': curved = 0.5 * (1 - Math.cos(clamped * Math.PI)); break;
        default: curved = clamped;
      }

      const y = curved * (outMax - outMin) + outMin;
      const px = x * width;
      const py = height - y * height;
      points.push(`${i === 0 ? 'M' : 'L'}${px.toFixed(1)},${py.toFixed(1)}`);
    }
    const path = document.getElementById("bind-preview-line");
    if (path) {
      path.setAttribute("d", points.join(' '));
    }
  }

  function syncVal(slider, labelId) {
    const val = (parseFloat(slider.value) / 100).toFixed(2);
    document.getElementById(labelId).textContent = val;
    updatePreviewCurve();
  }

  inMinSlider.oninput = () => syncVal(inMinSlider, "bind-in-min-val");
  inMaxSlider.oninput = () => syncVal(inMaxSlider, "bind-in-max-val");
  outMinSlider.oninput = () => syncVal(outMinSlider, "bind-out-min-val");
  outMaxSlider.oninput = () => syncVal(outMaxSlider, "bind-out-max-val");
  curveSelect.onchange = updatePreviewCurve;

  updatePreviewCurve();

  document.getElementById("btn-bind-back").onclick = () => {
    step2.classList.add("hidden");
    step1.classList.remove("hidden");
  };

  document.getElementById("btn-bind-confirm").onclick = () => {
    if (!window.selectedControl) return;
    const targets = window.currentMappings[window.selectedControl] || [];

    // Check conflict
    let conflictControl = null;
    for (const [ctrl, ctrlTargets] of Object.entries(window.currentMappings)) {
      if (ctrl === window.selectedControl) continue;
      for (const tgt of ctrlTargets) {
        if (tgt.type === t.type &&
            tgt.trackIndex === t.trackIndex &&
            tgt.deviceIndex === t.deviceIndex &&
            tgt.paramIndex === t.paramIndex &&
            tgt.sendIndex === t.sendIndex) {
          conflictControl = ctrl;
          break;
        }
      }
      if (conflictControl) break;
    }

    if (conflictControl) {
      alert(`Cannot bind: This parameter is already bound to "${getControlDisplayName(conflictControl)}". Please unbind it first.`);
      return;
    }

    const alreadyBoundToSelf = targets.some(tgt =>
      tgt.type === t.type &&
      tgt.trackIndex === t.trackIndex &&
      tgt.deviceIndex === t.deviceIndex &&
      tgt.paramIndex === t.paramIndex &&
      tgt.sendIndex === t.sendIndex
    );
    if (alreadyBoundToSelf) {
      alert(`This parameter is already bound to "${getControlDisplayName(window.selectedControl)}".`);
      return;
    }

    const newTarget = {
      type: t.type,
      trackIndex: t.trackIndex,
      deviceIndex: t.deviceIndex,
      paramIndex: t.paramIndex,
      sendIndex: t.sendIndex,
      label: window.getTargetLabel(t),
      curve: curveSelect.value,
      inMin: parseFloat(inMinSlider.value) / 100,
      inMax: parseFloat(inMaxSlider.value) / 100,
      outMin: parseFloat(outMinSlider.value) / 100,
      outMax: parseFloat(outMaxSlider.value) / 100,
      smooth: 0
    };

    targets.push(newTarget);
    window.saveMappingTargets(targets);
    document.getElementById("bind-modal").classList.add("hidden");
  };
};

window.getTargetLabel = function(t) {
  if (t.type === "tempo") return "Song Tempo";
  let label = `Track ${t.trackIndex + 1}`;
  if (t.trackName) label = t.trackName;
  if (t.deviceName) label += ` > ${t.deviceName}`;
  label += ` > ${t.label || t.type}`;
  return label;
};

window.bindToTarget = function(t) {
  // Backwards compatibility layer (if anything directly references bindToTarget)
  window.openBindStep2(t);
};

function updateLeds() {
  const now = Date.now();
  document.querySelectorAll('.map-item').forEach(item => {
    const name = item.dataset.ctrl;
    const clientKey = window.selectedClient + '::' + name;
    const last = window.liveControls.get(clientKey);
    const led = item.querySelector('.led');
    if (led) {
      if (last && now - last.ts < 200) {
        led.classList.add('on');
        const valEl = item.querySelector('.live-val');
        if (valEl) valEl.textContent = last.val.toFixed(3);
      } else {
        led.classList.remove('on');
      }
    }
  });
}
setInterval(updateLeds, 100);

window.discoveryActive = false;

function initDiscoverButton() {
  const btn = document.getElementById("btn-discover");
  if (!btn || btn.dataset.bound) return;
  btn.dataset.bound = "true";

  btn.onclick = () => {
    if (window.discoveryActive) {
      window.discoveryActive = false;
      btn.textContent = "Discover";
    } else {
      window.discoveryActive = true;
      btn.textContent = "Stop";
      
      async function runDiscovery() {
        const allControls = window.phoneControls.flatMap(g => g.items);
        for (const ctrl of allControls) {
          if (!window.discoveryActive) break;
          
          const row = document.querySelector(`.map-item[data-ctrl="${ctrl}"]`);
          if (row) {
            row.style.background = "var(--accent-bg)";
            row.scrollIntoView({ block: "nearest", behavior: "smooth" });
          }
          
          window.sendWS('highlightControl', { control: ctrl, durationMs: 1500 });
          await new Promise(r => setTimeout(r, 1700));
          
          if (row) {
            row.style.background = "";
          }
        }
        window.discoveryActive = false;
        btn.textContent = "Discover";
      }
      runDiscovery();
    }
  };
}

const originalRenderMappingsTab = window.renderMappingsTab;
window.renderMappingsTab = function() {
  originalRenderMappingsTab();
  initDiscoverButton();
};
