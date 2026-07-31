// Copyright © 2026 Gabriel Worm
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Source: https://github.com/ntworm/ableton-rc-surface
//
// This file is part of Ableton RC Surface, distributed under the
// PolyForm Noncommercial License 1.0.0. You may obtain a copy of
// the License at https://polyformproject.org/licenses/noncommercial/1.0.0
/* ── Ableton RC Surface — Panel Dialog Mappings Tab Logic ────────── */

window.frontendToggleStates = new Map();

/**
 * Two mapping-target descriptors are considered identical when their
 * `type` plus every positional index match. Missing indices are treated
 * as 0 to stay consistent with the server's getTargetKey() fallback.
 * Pure function, exported on `window` for unit tests.
 */
window.isSameTarget = function(a, b) {
  if (!a || !b) return false;
  if (a.type !== b.type) return false;
  // trigger_note uses a distinct identity (track + midiNote) and must never
  // collide with a regular device_param on the same slot.
  const aTrigger = a.mode === 'trigger_note';
  const bTrigger = b.mode === 'trigger_note';
  if (aTrigger !== bTrigger) return false;
  if (aTrigger && bTrigger) {
    return (a.trackIndex ?? 0) === (b.trackIndex ?? 0)
        && (a.midiNote ?? 'C3') === (b.midiNote ?? 'C3');
  }
  return (a.trackIndex ?? 0) === (b.trackIndex ?? 0)
      && (a.deviceIndex ?? 0) === (b.deviceIndex ?? 0)
      && (a.paramIndex ?? 0) === (b.paramIndex ?? 0)
      && (a.sendIndex ?? 0) === (b.sendIndex ?? 0);
};

/**
 * Returns the name of any control in `allMappings` that already binds
 * the same target as `t`, excluding `selectedControl` (so self-binding
 * is never reported as a conflict). Pure function.
 */
window.findMappingConflict = function(t, selectedControl, allMappings) {
  if (!t || !allMappings) return null;
  for (const [ctrl, ctrlTargets] of Object.entries(allMappings)) {
    if (ctrl === selectedControl) continue;
    if (!Array.isArray(ctrlTargets)) continue;
    for (const tgt of ctrlTargets) {
      if (window.isSameTarget(t, tgt)) return ctrl;
    }
  }
  return null;
};

/**
 * Safe wrapper so unit tests (which mock the DOM without an alert()
 * implementation) don't crash when the binding UI surfaces a conflict.
 * Always returns true when the global alert exists.
 */
function showAlert(message) {
  try {
    if (typeof alert === "function") {
      alert(message);
      return true;
    }
  } catch {}
  return false;
}

window.renderMappingsTab = function() {
  const listEl = document.getElementById("map-list");
  if (!listEl) return;
  const filter = (document.getElementById("map-search").value || "").toLowerCase();
  listEl.innerHTML = "";

  // A5: when there are no active mappings at all (no key in
  // currentMappings has targets), prepend a soft hint banner above the
  // group list. Empty array / undefined values are ignored so a control
  // that was once mapped but currently has zero targets does not count.
  const hasActiveMappings = window.currentMappings
    && typeof window.currentMappings === "object"
    && Object.values(window.currentMappings).some((arr) => Array.isArray(arr) && arr.length > 0);
  if (!hasActiveMappings) {
    const empty = document.createElement("div");
    empty.className = "map-list-empty";
    empty.textContent = "No mappings yet. Pick a control and bind a parameter.";
    listEl.appendChild(empty);
  }

  // Pull persisted collapse state once per render. Storing by group name
  // (not full controls array) is intentional: if the implementation adds
  // or removes a group, we keep what the user explicitly collapsed. A
  // non-empty filter forces every visible group open so search does not
  // hide matches behind a stored collapse.
  let storedState = {};
  try {
    const raw = localStorage.getItem("map-group-state");
    if (raw) storedState = JSON.parse(raw) || {};
  } catch (_) {}
  const forceOpen = filter.length > 0;

  // Track which group (if any) holds the currently selected control, so
  // we can keep that group expanded even when the user has toggled it
  // closed — silent visibility loss of the active selection was a real
  // footgun in the always-expanded raw list.
  const selectedGroupName = (() => {
    const sel = window.selectedControl;
    if (!sel) return null;
    for (const [groupName, controls] of Object.entries(window.allControlsGrouped)) {
      if (controls.includes(sel)) return groupName;
    }
    return null;
  })();

  const persistState = () => {
    try {
      localStorage.setItem("map-group-state", JSON.stringify(storedState));
    } catch (_) {}
  };

  Object.entries(window.allControlsGrouped).forEach(([groupName, controls]) => {
    const filteredControls = controls.filter(c => c.toLowerCase().includes(filter));
    if (filteredControls.length === 0) return;

    // Decide collapse: defaults to expanded for first visit; user-toggle
    // and search override it. We never auto-collapse a group the user
    // has not explicitly collapsed and we never keep a group closed
    // when search is matching or when it holds the active selection.
    const storedFlag = storedState[groupName];
    const isCollapsed =
      !forceOpen &&
      storedFlag === true &&
      selectedGroupName !== groupName;

    // Group container (header + items together so collapse toggles both).
    const wrap = document.createElement("div");
    wrap.className = `map-group${isCollapsed ? " collapsed" : ""}`;
    wrap.dataset.group = groupName;

    // Group Header — click toggles collapse, no separate link to chase.
    const gh = document.createElement("div");
    gh.className = "map-group-header";
    const chev = document.createElement("span");
    chev.className = "chev";
    chev.textContent = "▸";
    const label = document.createElement("span");
    label.className = "label";
    label.textContent = groupName;
    const count = document.createElement("span");
    count.className = "count";
    count.textContent = String(filteredControls.length);
    gh.appendChild(chev);
    gh.appendChild(label);
    gh.appendChild(count);
    if (!isCollapsed) chev.classList.add("open");
    gh.addEventListener("click", () => {
      const wouldBeCollapsed = !wrap.classList.contains("collapsed");
      // A group that holds window.selectedControl must stay open while
      // that selection persists — silently hiding the active detail is
      // worse than leaving a group the user wanted to fold sitting
      // expanded. The stored flag is cleared to false so a future
      // selection that clears window.selectedControl lets the user
      // collapse this group without having to re-find and re-toggle it.
      if (wouldBeCollapsed && groupName === selectedGroupName) {
        if (storedState[groupName] !== false) {
          storedState[groupName] = false;
          persistState();
        }
        return;
      }
      wrap.classList.toggle("collapsed", wouldBeCollapsed);
      chev.classList.toggle("open", !wouldBeCollapsed);
      storedState[groupName] = wouldBeCollapsed;
      persistState();
    });
    wrap.appendChild(gh);

    // Items container — independent element so the CSS rule can target
    // its display without leaking into the header.
    const itemsWrap = document.createElement("div");
    itemsWrap.className = "map-group-items";

    filteredControls.forEach(ctrl => {
      const item = document.createElement("div");
      const isMapped = window.currentMappings[ctrl] && window.currentMappings[ctrl].length > 0;
      item.className = `map-item ${ctrl === window.selectedControl ? 'selected' : ''} ${isMapped ? 'mapped' : ''}`;
      item.setAttribute("data-ctrl", ctrl);
      const liveVal = window.liveControls.get(ctrl);
      const liveValStr = liveVal !== undefined ? (typeof liveVal === 'number' ? liveVal.toFixed(3) : (liveVal.val !== undefined ? liveVal.val.toFixed(3) : "—")) : "—";
      const led = document.createElement("span");
      led.className = "led";
      const dot = document.createElement("span");
      dot.className = "dot";
      const name = document.createElement("span");
      name.className = "name";
      name.textContent = getControlDisplayName(ctrl);
      const val = document.createElement("span");
      val.className = "live-val";
      val.textContent = liveValStr;
      item.appendChild(led);
      item.appendChild(dot);
      item.appendChild(name);
      item.appendChild(val);
      item.addEventListener("click", () => {
        window.selectedControl = ctrl;
        if (typeof window.markSensorRecent === "function") {
          window.markSensorRecent(ctrl);
        }
        window.renderMappingsTab();
        window.renderMappingDetail();
      });
      itemsWrap.appendChild(item);
    });

    wrap.appendChild(itemsWrap);
    listEl.appendChild(wrap);
  });

  // Attach search filter update
  const searchInput = document.getElementById("map-search");
  if (searchInput && !searchInput.dataset.bound) {
    searchInput.dataset.bound = "true";
    searchInput.addEventListener("input", window.renderMappingsTab);
  }

  window.renderMappingDetail();
};

/**
 * Build a single per-target editor block:
 *   [label] [curve select] [inMin slider] [inMax slider]
 *   [outMin slider] [outMax slider] [response graph svg] [remove]
 *
 * The element is appended to `targetContainer` so the rest of the
 * panel CSS can style the chips individually.
 */
function makeKnob(container, labelText, value, min, max, isPercent, isMs, step, className, target, keyName, onChange, onCommit) {
  const wrapper = document.createElement("div");
  wrapper.className = "knob-container";
  wrapper.style.cssText = "display:flex; flex-direction:column; align-items:center; width:55px; user-select:none; margin: 4px 0;";

  const label = document.createElement("div");
  label.className = "knob-label";
  label.style.cssText = "font-size:9px; color:#a1a1a5; font-weight:600; margin-bottom:4px; text-align:center; text-transform:uppercase; letter-spacing:0.5px;";
  label.textContent = labelText;
  wrapper.appendChild(label);

  const wheel = document.createElement("div");
  wheel.className = "knob-wheel";
  wheel.style.cssText = "position:relative; width:28px; height:28px; border-radius:50%; background:#1c1c1f; border:2.5px solid #3c3c40; cursor:ns-resize; box-shadow:inset 0 1px 3px rgba(0,0,0,0.5); display:flex; align-items:center; justify-content:center; outline:none;";

  const pointer = document.createElement("div");
  pointer.className = "knob-pointer";
  pointer.style.cssText = "position:absolute; width:2.5px; height:9px; background:#00ffcc; top:2px; transform-origin:bottom center; transform:rotate(-135deg); border-radius:1px;";
  wheel.appendChild(pointer);
  wrapper.appendChild(wheel);

  const valEl = document.createElement("div");
  valEl.className = "knob-value";
  valEl.style.cssText = "font-size:9px; color:#fff; font-family:monospace; margin-top:4px;";
  wrapper.appendChild(valEl);

  // Hidden native input range for test compatibility and event delegation
  const input = document.createElement("input");
  input.type = "range";
  input.className = className + " bound-chip-range-input";
  input.style.display = "none";
  input.min = "0";
  input.max = "100";
  // Sync initial value (scaled to 0-100)
  const normVal = (value - min) / (max - min || 1);
  input.value = String(Math.round(normVal * 100));
  wrapper.appendChild(input);

  function updateVisuals(val) {
    const pct = (val - min) / (max - min || 1);
    const angle = -135 + pct * 270;
    pointer.style.transform = `rotate(${angle}deg)`;

    if (isPercent) {
      valEl.textContent = `${Math.round(val * 100)}%`;
    } else if (isMs) {
      valEl.textContent = `${Math.round(val)}ms`;
    } else {
      valEl.textContent = val.toFixed(2);
    }
  }

  updateVisuals(value);

  // Sync back from native input to visually update if tests or external changes touch input.value
  input.addEventListener("input", () => {
    const val = min + (parseInt(input.value, 10) / 100) * (max - min);
    updateVisuals(val);
    if (onChange) onChange(val);
  });

  input.addEventListener("change", () => {
    if (onCommit) onCommit();
  });

  let startY = 0;
  let startVal = 0;

  function onPointerDown(e) {
    startY = e.clientY;
    startVal = min + (parseInt(input.value, 10) / 100) * (max - min);
    document.addEventListener("pointermove", onPointerMove);
    document.addEventListener("pointerup", onPointerUp);
    wheel.style.borderColor = "#00ffcc";
  }

  function onPointerMove(e) {
    const dy = startY - e.clientY; // drag up increases value
    const range = max - min;
    const sensitivity = 0.005; // Drag scaling factor
    let delta = dy * sensitivity * range;
    let newVal = startVal + delta;
    newVal = Math.max(min, Math.min(max, newVal));

    input.value = String(Math.round(((newVal - min) / (max - min || 1)) * 100));
    updateVisuals(newVal);

    if (onChange) onChange(newVal);

    // Dispatch input event on the hidden range input for test/listener compatibility
    input.dispatchEvent(new Event("input"));
  }

  function onPointerUp() {
    document.removeEventListener("pointermove", onPointerMove);
    document.removeEventListener("pointerup", onPointerUp);
    wheel.style.borderColor = "#3c3c40";
    input.dispatchEvent(new Event("change"));
  }

  wheel.addEventListener("pointerdown", onPointerDown);
  container.appendChild(wrapper);
}

function renderTargetChip(targetContainer, t, idx) {
  const chip = document.createElement("div");
  chip.className = "bound-chip";
  chip.dataset.targetIdx = String(idx);
  chip.style.cssText = "position:relative; display:flex; flex-direction:column; gap:12px; padding:12px; margin-bottom:12px; background:#2c2c2f; border:1px solid #1a1a1c; border-radius:4px; box-shadow:0 3px 8px rgba(0,0,0,0.3); color:#d1d1d1; width:100%; box-sizing:border-box;";

  // Close/remove button in top-right corner
  const removeBtn = document.createElement("span");
  removeBtn.className = "remove";
  removeBtn.title = "Remove mapping";
  removeBtn.style.cssText = "position:absolute; top:8px; right:8px; cursor:pointer; color:#888; font-size:12px; padding:2px; line-height:1; z-index:10;";
  removeBtn.textContent = "✕";
  removeBtn.addEventListener("click", () => {
    window.removeBoundTarget(idx);
  });
  chip.appendChild(removeBtn);

  // Main columns row
  const colRow = document.createElement("div");
  colRow.style.cssText = "display:flex; flex-direction:row; gap:16px; align-items:stretch;";
  chip.appendChild(colRow);

  // Column 1: Graph, Curve Selector, Title Label
  const col1 = document.createElement("div");
  col1.style.cssText = "display:flex; flex-direction:column; gap:8px; width:180px; flex-shrink:0;";

  const labelSpan = document.createElement("span");
  labelSpan.style.cssText = "font-size:11px; font-weight:600; color:#fff; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; padding-right:15px;";
  labelSpan.textContent = t.label || t.type;
  col1.appendChild(labelSpan);
  if (t.relinkStatus && t.relinkStatus !== 'loaded') {
    const relinkBadge = document.createElement('span');
    relinkBadge.className = `relink-status relink-${t.relinkStatus}`;
    relinkBadge.textContent = `${t.relinkStatus} ${Math.round((t.relinkConfidence || 0) * 100)}%`;
    relinkBadge.style.cssText = `font-size:9px;color:${t.relinkStatus === 'relinked' ? '#34c759' : '#ff9f0a'};`;
    col1.appendChild(relinkBadge);
    if (Array.isArray(t.relinkCandidates) && t.relinkCandidates.length) {
      const candidates = document.createElement('div');
      candidates.className = 'relink-candidates';
      candidates.style.cssText = 'display:flex;flex-direction:column;gap:3px;';
      t.relinkCandidates.forEach((candidate, candidateIndex) => {
        const button = document.createElement('button');
        button.className = 'btn sm relink-candidate';
        const signature = candidate.target?.signature || {};
        button.textContent = `${Math.round(candidate.confidence * 100)}% ${signature.trackName || ''} › ${signature.deviceName || ''} › ${signature.parameterName || candidate.target?.type}`;
        button.addEventListener('click', () => {
          const mapping = window.getMappingForControl(window.selectedControl);
          window.sendWS('confirmProjectRelink', {
            control: mapping?.key || window.selectedControl,
            targetIndex: idx,
            candidateIndex,
          }, (res) => {
            if (!res.ok) return showAlert(res.error || 'Relink confirmation failed');
            window.fetchMappings();
          });
        });
        candidates.appendChild(button);
      });
      col1.appendChild(candidates);
    }
  }

  const graphWrap = document.createElement("div");
  graphWrap.className = "target-graph";
  graphWrap.style.cssText = "width:180px; height:130px; background:#151517; border:1px solid #3e3e42; border-radius:3px; overflow:hidden; flex-shrink:0;";
  graphWrap.innerHTML = window.renderMappingGraph(t, 180, 130);
  col1.appendChild(graphWrap);

  const curveSelect = document.createElement("select");
  curveSelect.className = "target-curve";
  curveSelect.style.cssText = "background:#1e1e21; color:#fff; border:1px solid #3e3e42; border-radius:3px; font-size:10px; height:20px; padding:0 2px; width:100%; cursor:pointer;";
  for (const opt of ["linear", "exponential", "logarithmic", "s-curve"]) {
    const o = document.createElement("option");
    o.value = opt;
    o.textContent = opt.charAt(0).toUpperCase() + opt.slice(1);
    if ((t.curve || "linear") === opt) o.selected = true;
    curveSelect.appendChild(o);
  }
  curveSelect.addEventListener("change", () => {
    t.curve = curveSelect.value;
    window.saveMappingTargets();
    refreshTargetGraph(chip, t);
  });
  col1.appendChild(curveSelect);

  const takeoverSelect = document.createElement("select");
  takeoverSelect.className = "target-takeover";
  takeoverSelect.title = "Soft takeover mode";
  takeoverSelect.style.cssText = curveSelect.style.cssText;
  for (const opt of ["scale", "pickup", "jump"]) {
    const option = document.createElement("option");
    option.value = opt;
    option.textContent = `Takeover: ${opt}`;
    option.selected = (t.takeoverMode || "scale") === opt;
    takeoverSelect.appendChild(option);
  }
  takeoverSelect.addEventListener("change", () => {
    t.takeoverMode = takeoverSelect.value;
    window.saveMappingTargets();
  });
  col1.appendChild(takeoverSelect);

  const neutralSelect = document.createElement("select");
  neutralSelect.className = "target-neutral-policy";
  neutralSelect.title = "Signal-loss policy";
  neutralSelect.style.cssText = curveSelect.style.cssText;
  // Five distinct modes; "initial" and "reconcile" were retired because both
  // resolved to "adopt Live's current value", duplicating hold.
  for (const opt of ["release", "hold", "zero", "center", "custom"]) {
    const option = document.createElement("option");
    option.value = opt;
    option.textContent = `Loss: ${opt}`;
    option.selected = (t.neutralPolicy || "release") === opt;
    neutralSelect.appendChild(option);
  }
  neutralSelect.addEventListener("change", () => {
    t.neutralPolicy = neutralSelect.value;
    if (t.neutralPolicy === "center") t.neutralValue = 0.5;
    if (t.neutralPolicy === "zero" || t.neutralPolicy === "release") t.neutralValue = 0;
    window.saveMappingTargets();
  });
  col1.appendChild(neutralSelect);

  // Mode Select (Continuous / Toggle)
  const modeSelect = document.createElement("select");
  modeSelect.className = "target-mode";
  modeSelect.style.cssText = "background:#1e1e21; color:#fff; border:1px solid #3e3e42; border-radius:3px; font-size:10px; height:20px; padding:0 2px; width:100%; cursor:pointer; margin-top:4px;";
  for (const opt of [
    { value: "continuous", label: "Continuous" },
    { value: "toggle", label: "Toggle" },
    { value: "trigger_note", label: "Trigger Note" }
  ]) {
    const o = document.createElement("option");
    o.value = opt.value;
    o.textContent = opt.label;
    if ((t.mode || "continuous") === opt.value) o.selected = true;
    modeSelect.appendChild(o);
  }
  col1.appendChild(modeSelect);

  colRow.appendChild(col1);

  // Column 2: Drive & Comp / Threshold (Dynamic based on mode)
  const col2 = document.createElement("div");
  col2.style.cssText = "display:flex; flex-direction:column; justify-content:space-around; padding-top:14px; width:60px; flex-shrink:0;";
  colRow.appendChild(col2);

  // Sub-container A: Continuous Knobs (Drive & Comp & Smooth)
  const col2Continuous = document.createElement("div");
  col2Continuous.style.cssText = "display:flex; flex-direction:column; gap:4px; align-items:center; width:100%;";
  makeKnob(col2Continuous, "Drive", t.drive ?? 0, -1.0, 1.0, true, false, 0.01, "target-drive", t, "drive", (val) => {
    t.drive = val;
    window.saveMappingTargets(undefined, { refresh: false });
    refreshTargetGraph(chip, t);
  }, () => {
    window.saveMappingTargets();
  });
  makeKnob(col2Continuous, "Comp", t.compressor ?? 0, -1.0, 1.0, true, false, 0.01, "target-compressor", t, "compressor", (val) => {
    t.compressor = val;
    window.saveMappingTargets(undefined, { refresh: false });
    refreshTargetGraph(chip, t);
  }, () => {
    window.saveMappingTargets();
  });
  makeKnob(col2Continuous, "Smooth", (t.smooth ?? 0) * 1000, 0, 1000, false, true, 50, "target-smooth-knob", t, "smooth", (val) => {
    t.smooth = val / 1000;
    window.saveMappingTargets(undefined, { refresh: false });
  }, () => {
    window.saveMappingTargets();
  });
  col2.appendChild(col2Continuous);

  // Sub-container B: Toggle Knobs (Threshold & Smooth)
  const col2Toggle = document.createElement("div");
  col2Toggle.style.cssText = "display:flex; flex-direction:column; gap:4px; align-items:center; width:100%;";
  makeKnob(col2Toggle, "Thresh", t.threshold ?? 0.5, 0, 1, true, false, 0.01, "target-threshold", t, "threshold", (val) => {
    t.threshold = val;
    window.saveMappingTargets(undefined, { refresh: false });
    refreshTargetGraph(chip, t);
  }, () => {
    window.saveMappingTargets();
  });
  makeKnob(col2Toggle, "Smooth", (t.smooth ?? 0) * 1000, 0, 1000, false, true, 50, "target-smooth-knob", t, "smooth", (val) => {
    t.smooth = val / 1000;
    window.saveMappingTargets(undefined, { refresh: false });
  }, () => {
    window.saveMappingTargets();
  });
  col2.appendChild(col2Toggle);

  // Sub-container C: Trigger Note controls (MidiNote & Velocity)
  const col2TriggerNote = document.createElement("div");
  col2TriggerNote.style.cssText = "display:flex; flex-direction:column; gap:4px; align-items:center; width:100%;";

  const noteLabel = document.createElement("div");
  noteLabel.style.cssText = "font-size:9px; color:#a1a1a5; font-weight:600; text-transform:uppercase; letter-spacing:0.5px; margin-top:4px; margin-bottom:2px; text-align:center;";
  noteLabel.textContent = "Nota";
  col2TriggerNote.appendChild(noteLabel);

  const noteInput = document.createElement("input");
  noteInput.type = "text";
  noteInput.className = "target-midi-note";
  noteInput.style.cssText = "background:#1c1c1f; color:#fff; border:1px solid #3c3c40; border-radius:3px; font-size:10px; height:20px; width:45px; text-align:center; outline:none; font-family:monospace; margin-bottom:4px;";
  noteInput.value = t.midiNote ?? "C3";
  function parseMidiNoteInput() {
    const val = noteInput.value.trim().toUpperCase();
    if (/^[A-G]#?-?\d+$/.test(val) || /^\d+$/.test(val)) {
      return val;
    }
    return null;
  }
  noteInput.addEventListener("input", () => {
    const val = parseMidiNoteInput();
    if (!val) return;
    t.midiNote = val;
    window.saveMappingTargets(undefined, { refresh: false });
  });
  noteInput.addEventListener("change", () => {
    const val = parseMidiNoteInput();
    if (val) t.midiNote = val;
    noteInput.value = t.midiNote ?? "C3";
    window.saveMappingTargets();
  });
  col2TriggerNote.appendChild(noteInput);

  makeKnob(col2TriggerNote, "Veloc", t.midiVelocity ?? 100, 1, 127, false, false, 1, "target-midi-velocity", t, "midiVelocity", (val) => {
    t.midiVelocity = Math.round(val);
    window.saveMappingTargets(undefined, { refresh: false });
  }, () => {
    window.saveMappingTargets();
  });

  col2.appendChild(col2TriggerNote);

  // Live status box for values (placed in Column 3 bottom)
  const liveBox = document.createElement("div");
  liveBox.className = "live-status-box";
  liveBox.style.cssText = "display:flex; gap:12px; justify-content:center; align-items:center; background:#1e1e21; border:1px solid #3e3e42; border-radius:3px; padding:4px 8px; font-family:monospace; font-size:10px; color:#a1a1a5; width:100%; box-sizing:border-box; margin-top:8px;";

  const liveInLabel = document.createElement("div");
  liveInLabel.innerHTML = 'In: <span class="live-in-val" style="color:#fff; font-weight:bold;">0.000</span>';
  liveBox.appendChild(liveInLabel);

  const liveOutLabel = document.createElement("div");
  liveOutLabel.innerHTML = 'Out: <span class="live-out-val" style="color:#fff; font-weight:bold;">0.000</span>';
  liveBox.appendChild(liveOutLabel);

  // Column 3: Limits (Out Hi, Out Lo, Range, Lowest)
  const col3 = document.createElement("div");
  col3.style.cssText = "display:flex; flex-direction:column; justify-content:space-between; padding-top:14px; width:130px; flex-shrink:0;";
  colRow.appendChild(col3);

  const knobGrid = document.createElement("div");
  knobGrid.style.cssText = "display:flex; flex-direction:row; flex-wrap:wrap; gap:12px; justify-content:center; align-content:space-between;";
  col3.appendChild(knobGrid);

  // Out Hi Knob (outMax)
  makeKnob(knobGrid, "Out Hi", t.outMax ?? 1, 0, 1, true, false, 0.01, "target-out-max", t, "outMax", (val) => {
    t.outMax = val;
    window.saveMappingTargets(undefined, { refresh: false });
    refreshTargetGraph(chip, t);
  }, () => {
    window.saveMappingTargets();
  });

  // Out Lo Knob (outMin)
  makeKnob(knobGrid, "Out Lo", t.outMin ?? 0, 0, 1, true, false, 0.01, "target-out-min", t, "outMin", (val) => {
    t.outMin = val;
    window.saveMappingTargets(undefined, { refresh: false });
    refreshTargetGraph(chip, t);
  }, () => {
    window.saveMappingTargets();
  });

  // Range Knob (inMax)
  makeKnob(knobGrid, "Range", t.inMax ?? 1, 0, 1, true, false, 0.01, "target-in-max", t, "inMax", (val) => {
    t.inMax = val;
    window.saveMappingTargets(undefined, { refresh: false });
    refreshTargetGraph(chip, t);
  }, () => {
    window.saveMappingTargets();
  });

  // Lowest Knob (inMin)
  makeKnob(knobGrid, "Lowest", t.inMin ?? 0, 0, 1, true, false, 0.01, "target-in-min", t, "inMin", (val) => {
    t.inMin = val;
    window.saveMappingTargets(undefined, { refresh: false });
    refreshTargetGraph(chip, t);
  }, () => {
    window.saveMappingTargets();
  });

  makeKnob(knobGrid, "Neutral", t.neutralValue ?? 0, 0, 1, true, false, 0.01, "target-neutral-value", t, "neutralValue", (val) => {
    t.neutralValue = val;
    if (!t.neutralPolicy || t.neutralPolicy === "zero" || t.neutralPolicy === "center") {
      t.neutralPolicy = "custom";
    }
    window.saveMappingTargets(undefined, { refresh: false });
  }, () => {
    window.saveMappingTargets();
  });

  col3.appendChild(liveBox);

  // Helper function to show/hide knobs based on mode
  function updateModeUI(mode) {
    col2Continuous.style.display = mode === "continuous" ? "flex" : "none";
    col2Toggle.style.display = mode === "toggle" ? "flex" : "none";
    col2TriggerNote.style.display = mode === "trigger_note" ? "flex" : "none";
  }

  modeSelect.addEventListener("change", () => {
    t.mode = modeSelect.value;
    window.saveMappingTargets();
    updateModeUI(t.mode);
  });

  // Init UI visibility
  updateModeUI(t.mode || "continuous");

  targetContainer.appendChild(chip);
}

function refreshTargetGraph(chip, t) {
  if (!chip || !t) return;
  const wrap = chip.querySelector(".target-graph");
  if (wrap) wrap.innerHTML = window.renderMappingGraph(t, 180, 130);
}

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

  const displayName = (typeof window.getControlDisplayName === "function"
    ? window.getControlDisplayName(window.selectedControl)
    : String(window.selectedControl));
  const nameEl = document.getElementById("map-detail-name");
  if (nameEl) nameEl.textContent = displayName;

  // Bind/unbind triggers
  const targets = window.currentMappings[window.selectedControl] || [];
  const targetContainer = document.getElementById("map-detail-targets");
  targetContainer.innerHTML = "";

  if (targets.length === 0) {
    const placeholder = document.createElement("div");
    placeholder.style.cssText = "font-size:11px;color:var(--text3);font-style:italic";
    placeholder.textContent = "No targets bound";
    targetContainer.appendChild(placeholder);
  } else {
    targets.forEach((t, idx) => {
      renderTargetChip(targetContainer, t, idx);
    });
  }

  // Bind to button trigger
  const btnBind = document.getElementById("btn-bind");
  btnBind.onclick = () => window.openPicker();

  const btnTrigger = document.getElementById("btn-trigger");
  if (btnTrigger) {
    btnTrigger.onclick = () => window.openMidiTrackPicker();
  }
};

function bindProjectProfileActions() {
  const importBtn = document.getElementById('btn-project-import');
  const exportBtn = document.getElementById('btn-project-export');
  const rollbackBtn = document.getElementById('btn-project-rollback');
  if (importBtn && !importBtn.dataset.bound) {
    importBtn.dataset.bound = 'true';
    importBtn.addEventListener('click', () => {
      const picker = document.createElement('input');
      picker.type = 'file';
      picker.accept = '.rcsurface,application/json';
      picker.addEventListener('change', async () => {
        const file = picker.files?.[0];
        if (!file) return;
        const content = await file.text();
        window.sendWS('importProjectConfig', { content }, (res) => {
          if (!res.ok) return showAlert(res.error || 'Project import failed');
          window.fetchMappings();
          showAlert('Project profile imported and safely relinked.');
        });
      });
      picker.click();
    });
  }
  if (exportBtn && !exportBtn.dataset.bound) {
    exportBtn.dataset.bound = 'true';
    exportBtn.addEventListener('click', () => {
      window.sendWS('exportProjectConfig', {}, (res) => {
        if (!res.ok || !res.result?.content) return showAlert(res.error || 'Project export failed');
        const blob = new Blob([res.result.content], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = url;
        link.download = res.result.filename || 'Ableton-RC-Surface.rcsurface';
        link.click();
        URL.revokeObjectURL(url);
      });
    });
  }
  if (rollbackBtn && !rollbackBtn.dataset.bound) {
    rollbackBtn.dataset.bound = 'true';
    rollbackBtn.addEventListener('click', () => {
      window.sendWS('rollbackProjectConfig', {}, (res) => {
        if (!res.ok) return showAlert(res.error || 'No project backup available');
        window.fetchMappings();
        showAlert('Previous project profile restored.');
      });
    });
  }
}

bindProjectProfileActions();

window.renderMappingGraph = function(target, width = 120, height = 40) {
  // Draw grid path
  let gridLines = '';
  // Vertical grid lines
  for (let g = 25; g <= 75; g += 25) {
    const pos = (g / 100) * width;
    gridLines += `<line x1="${pos}" y1="0" x2="${pos}" y2="${height}" stroke="#3a3a3d" stroke-width="1" stroke-dasharray="2,2" opacity="0.4" />`;
  }
  // Horizontal grid lines
  for (let g = 25; g <= 75; g += 25) {
    const pos = (g / 100) * height;
    gridLines += `<line x1="0" y1="${pos}" x2="${width}" y2="${pos}" stroke="#3a3a3d" stroke-width="1" stroke-dasharray="2,2" opacity="0.4" />`;
  }

  const inMin = target.inMin ?? 0;
  const inMax = target.inMax ?? 1;
  const outMin = target.outMin ?? 0;
  const outMax = target.outMax ?? 1;
  const curve = target.curve || 'linear';
  const drive = target.drive ?? 0;
  const compressor = target.compressor ?? 0;

  if (target.mode === 'toggle') {
    const thresh = target.threshold ?? 0.5;
    const threshX = thresh * width;

    // Draw step path points
    const yMin = height - outMin * height;
    const yMax = height - outMax * height;

    const p1 = `0,${yMin.toFixed(1)}`;
    const p2 = `${threshX.toFixed(1)},${yMin.toFixed(1)}`;
    const p3 = `${threshX.toFixed(1)},${yMax.toFixed(1)}`;
    const p4 = `${width.toFixed(1)},${yMax.toFixed(1)}`;
    const pointsStr = `${p1} ${p2} ${p3} ${p4}`;

    return `
      <svg viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" style="background:#151517; border-radius:3px; display:block; overflow:visible;">
        ${gridLines}
        <line x1="${threshX}" y1="0" x2="${threshX}" y2="${height}" stroke="var(--accent)" stroke-width="1.5" stroke-dasharray="3,3" opacity="0.8" />
        <polyline points="${pointsStr}" stroke="var(--accent)" stroke-width="2" fill="none"/>
        <circle class="playhead" cx="-10" cy="-10" r="3.5" fill="var(--text)" stroke="var(--accent)" stroke-width="1.2" style="display: none; pointer-events: none;"/>
      </svg>
    `;
  }

  const points = [];
  for (let i = 0; i <= 20; i++) {
    const x = i / 20;
    // Map input range
    const normalized = (x - inMin) / (inMax - inMin || 1);
    const clamped = Math.max(0, Math.min(1, normalized));

    let curved = clamped;
    switch (curve) {
      case 'exponential': curved = clamped * clamped; break;
      case 'logarithmic': curved = Math.sqrt(clamped); break;
      case 's-curve': curved = 0.5 * (1 - Math.cos(clamped * Math.PI)); break;
    }

    // Apply Drive (shift)
    if (drive !== 0) {
      curved = Math.max(0, Math.min(1, curved + drive));
    }

    // Apply Compressor (compand)
    if (compressor !== 0) {
      if (compressor < 0) {
        // Compression: blend towards 0.5
        curved = curved * (1 + compressor) + 0.5 * (-compressor);
      } else {
        // Expansion: push away from 0.5
        const diff = curved - 0.5;
        const sign = diff >= 0 ? 1 : -1;
        const normDiff = Math.abs(diff) * 2;
        const exponent = 1 - compressor * 0.8;
        const expanded = Math.pow(normDiff, exponent);
        curved = 0.5 + sign * 0.5 * expanded;
      }
    }

    const y = curved * (outMax - outMin) + outMin;
    const px = x * width;
    const py = height - y * height; // invert Y since SVG 0 is top
    points.push(`${px.toFixed(1)},${py.toFixed(1)}`);
  }

  return `
    <svg viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" style="background:#151517; border-radius:3px; display:block; overflow:visible;">
      ${gridLines}
      <polyline points="${points.join(' ')}" stroke="var(--accent)" stroke-width="2" fill="none"/>
      <circle class="playhead" cx="-10" cy="-10" r="3.5" fill="var(--text)" stroke="var(--accent)" stroke-width="1.2" style="display: none; pointer-events: none;"/>
    </svg>
  `;
};

function normalizeSensorValue(ctrl, val) {
  if (typeof val !== 'number') return 0;
  if (ctrl.startsWith("sensor.orient.")) {
    const suffix = ctrl.split(".").pop();
    if (suffix === "alpha" || suffix === "yaw") {
      return Math.max(0, Math.min(360, val)) / 360;
    }
    if (suffix === "beta" || suffix === "pitch") {
      return (Math.max(-90, Math.min(90, val)) + 90) / 180;
    }
    if (suffix === "gamma" || suffix === "roll") {
      return (Math.max(-180, Math.min(180, val)) + 360) % 360 / 360;
    }
  } else if (ctrl.startsWith("sensor.motion.")) {
    const suffix = ctrl.split(".").pop();
    if (["ax", "ay", "az"].includes(suffix)) {
      return (Math.max(-20, Math.min(20, val)) + 20) / 40;
    }
    if (["gx", "gy", "gz"].includes(suffix)) {
      return (Math.max(-200, Math.min(200, val)) + 200) / 400;
    }
  }
  return val;
}

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

  // Walk every rendered per-target chip and slide its playhead along the
  // response curve. Skips chips whose target slot is empty so a stale
  // element from a previous render can't take down the live update path.
  const container = document.getElementById("map-detail-targets");
  if (!container) return;
  const targets = window.currentMappings[ctrl] || [];
  for (const chip of container.querySelectorAll(".bound-chip")) {
    const idx = parseInt(chip.dataset.targetIdx, 10);
    if (Number.isNaN(idx)) continue;
    const t = targets[idx];
    if (!t) continue;

    const normalizedValue = normalizeSensorValue(ctrl, value);

    const inMin = t.inMin ?? 0;
    const inMax = t.inMax ?? 1;
    const outMin = t.outMin ?? 0;
    const outMax = t.outMax ?? 1;
    const span = (inMax - inMin) || 1;
    let norm = (normalizedValue - inMin) / span;
    norm = Math.max(0, Math.min(1, norm));

    let curved = norm;
    switch (t.curve || "linear") {
      case "exponential": curved = norm * norm; break;
      case "logarithmic": curved = Math.sqrt(norm); break;
      case "s-curve":     curved = 0.5 * (1 - Math.cos(norm * Math.PI)); break;
    }
    const drive = t.drive ?? 0;
    const compressor = t.compressor ?? 0;
    if (drive !== 0) {
      curved = Math.max(0, Math.min(1, curved + drive));
    }
    if (compressor !== 0) {
      if (compressor < 0) {
        curved = curved * (1 + compressor) + 0.5 * (-compressor);
      } else {
        const diff = curved - 0.5;
        const sign = diff >= 0 ? 1 : -1;
        const normDiff = Math.abs(diff) * 2;
        const exponent = 1 - compressor * 0.8;
        const expanded = Math.pow(normDiff, exponent);
        curved = 0.5 + sign * 0.5 * expanded;
      }
    }
    let finalScaledValue = curved * (outMax - outMin) + outMin;
    const key = `${ctrl}::${idx}`;

    if (t.mode === 'toggle') {
      const threshold = t.threshold ?? 0.5;
      let state = window.frontendToggleStates.get(key);
      if (!state) {
        state = { lastInput: 0, active: false };
        window.frontendToggleStates.set(key, state);
      }
      const triggered = state.lastInput < threshold && normalizedValue >= threshold;
      state.lastInput = normalizedValue;
      if (triggered) {
        state.active = !state.active;
      }
      finalScaledValue = state.active ? outMax : outMin;
    }

    // Update live numeric values inside the chip
    const liveInVal = chip.querySelector(".live-in-val");
    const liveOutVal = chip.querySelector(".live-out-val");
    if (liveInVal) liveInVal.textContent = value.toFixed(3);

    if (liveOutVal) {
      liveOutVal.textContent = finalScaledValue.toFixed(3);
      liveOutVal.style.color = '#fff';
    }

    const playhead = chip.querySelector(".playhead");
    if (!playhead) continue;
    const svg = playhead.closest("svg");
    const svgWidth = svg ? (svg.viewBox.baseVal.width || 118) : 118;
    const svgHeight = svg ? (svg.viewBox.baseVal.height || 100) : 100;

    const px = (normalizedValue * svgWidth).toFixed(1);
    const py = (svgHeight - finalScaledValue * svgHeight).toFixed(1);

    playhead.setAttribute("cx", px);
    playhead.setAttribute("cy", py);
    playhead.style.display = "block";
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

window.saveMappingTargets = function(targets = null, opts = {}) {
  if (!window.selectedControl) return;
  if (typeof window.markSensorRecent === "function") {
    window.markSensorRecent(window.selectedControl);
  }
  const finalTargets = targets || window.currentMappings[window.selectedControl] || [];
  // `refresh` defaults to true so existing callers keep the source-of-truth
  // behaviour. Sliders (input event) pass `{refresh:false}` to skip the
  // post-write refetch that would rebuild the slider mid-drag and steal
  // focus; they commit the final value once on pointerup.
  const refresh = opts.refresh !== false;
  const persist = () => {
    if (refresh) {
      window.fetchMappings();
    }
  };
  window.sendWS("setMapping", { control: window.selectedControl, targets: finalTargets }, persist);
};

// Inline picker (lives inside the detail panel; replaces the old bind modal).
// State is exposed via window.pickerOpen so callers and tests can detect
// whether the picker is currently visible without poking at DOM classLists.
window.pickerOpen = false;

/**
 * Hide the inline picker. Called after a successful commit or when the user
 * cancels. Safe to invoke when already closed (no-op). Declared before
 * openPicker so callbacks wired inside openPicker can call closePicker
 * regardless of script eval order (matters for vm-based tests).
 */
window.closePicker = function() {
  const picker = document.getElementById("map-picker");
  if (picker) picker.classList.add("hidden");
  const search = document.getElementById("map-picker-search");
  if (search) search.value = "";
  window.pickerOpen = false;
};

window.openPicker = function() {
  const picker = document.getElementById("map-picker");
  const list = document.getElementById("map-picker-list");
  const search = document.getElementById("map-picker-search");

  if (!picker || !list || !search) return;

  window.pickerOpen = true;
  picker.classList.remove("hidden");
  search.value = "";
  search.focus();

  const expanded = new Set();
  renderPickerList();

  search.oninput = renderPickerList;
  search.addEventListener("keydown", (e) => {
    if (e && e.key === "Escape") window.closePicker();
  });

  const cancelBtn = document.getElementById("map-picker-cancel");
  if (cancelBtn) cancelBtn.onclick = window.closePicker;

  function renderPickerList() {
    list.innerHTML = "";
    const filter = search.value.toLowerCase().trim();
    let totalShown = 0;

    window.allTargetsRaw.forEach((track) => {
      if (track.type === "tempo") {
        if (!filter || "song tempo".includes(filter)) {
          const row = document.createElement("div");
          row.className = "picker-track";
          row.dataset.kind = "tempo";
          row.innerHTML = `<span class="picker-chev">▶</span><span class="picker-track-name">Song Tempo</span><span class="picker-kind">tempo</span>`;
          row.onclick = () => {
            window.commitBind(track);
            window.closePicker();
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
      trackRow.className = "picker-track";
      trackRow.innerHTML = `<span class="picker-chev">${isExpanded ? "▼" : "▶"}</span><span class="picker-track-name">${trackLabel}</span><span class="picker-kind">track</span>`;
      trackRow.onclick = () => {
        if (expanded.has(trackKey)) expanded.delete(trackKey);
        else expanded.add(trackKey);
        renderPickerList();
      };
      list.appendChild(trackRow);
      totalShown++;

      if (!isExpanded) return;

      (track.mixer || []).forEach((m) => {
        const lbl = m.label || m.type;
        if (filter && !lbl.toLowerCase().includes(filter)) return;
        const row = document.createElement("div");
        row.className = "picker-param picker-mixer";
        row.innerHTML = `<span class="picker-name">${lbl}</span><span class="picker-kind">mixer</span>`;
        row.onclick = () => {
          window.commitBind(m);
          window.closePicker();
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
        devRow.className = "picker-track picker-device-track";
        devRow.innerHTML = `<span class="picker-chev">${devExpanded ? "▼" : "▶"}</span><span class="picker-track-name">${devLabel}</span><span class="picker-kind">device</span>`;
        devRow.onclick = () => {
          if (expanded.has(devKey)) expanded.delete(devKey);
          else expanded.add(devKey);
          renderPickerList();
        };
        list.appendChild(devRow);
        totalShown++;

        if (!devExpanded) return;

        (dev.params || []).forEach((p) => {
          const plbl = p.label || p.type;
          if (filter && !plbl.toLowerCase().includes(filter)) return;
          const row = document.createElement("div");
          row.className = "picker-param picker-device-param";
          row.innerHTML = `<span class="picker-name">${plbl}</span><span class="picker-kind">param</span>`;
          row.onclick = () => {
            window.commitBind(p);
            window.closePicker();
          };
          list.appendChild(row);
          totalShown++;
        });
      });
    });

    if (totalShown === 0) {
      const empty = document.createElement("div");
      empty.className = "picker-empty";
      empty.textContent = "No parameters found";
      list.appendChild(empty);
    }
  }
};

window.openMidiTrackPicker = function() {
  const picker = document.getElementById("map-picker");
  const list = document.getElementById("map-picker-list");
  const search = document.getElementById("map-picker-search");

  if (!picker || !list || !search) return;

  window.pickerOpen = true;
  picker.classList.remove("hidden");
  search.value = "";
  search.focus();

  renderMidiPickerList();

  search.oninput = renderMidiPickerList;
  search.addEventListener("keydown", (e) => {
    if (e && e.key === "Escape") window.closePicker();
  });

  const cancelBtn = document.getElementById("map-picker-cancel");
  if (cancelBtn) cancelBtn.onclick = window.closePicker;

  function renderMidiPickerList() {
    list.innerHTML = "";
    const filter = search.value.toLowerCase().trim();
    let totalShown = 0;

    window.allTargetsRaw.forEach((track) => {
      if (!track.isMidi) return;

      const trackLabel = track.name || `Track ${track.trackIndex + 1}`;
      if (filter && !trackLabel.toLowerCase().includes(filter)) return;

      const trackRow = document.createElement("div");
      trackRow.className = "picker-track";
      trackRow.style.cursor = "pointer";
      trackRow.innerHTML = `<span class="picker-chev">▶</span><span class="picker-track-name">${trackLabel}</span><span class="picker-kind">midi track</span>`;
      
      trackRow.onclick = () => {
        window.closePicker();
        
        console.log(`[ableton-rc-surface] Triggering setup for M4L on MIDI track index: ${track.trackIndex}`);
        
        window.sendWS("addUdpReceiverToTrack", { trackIndex: track.trackIndex }, (res) => {
          if (res && res.result && res.result.success) {
            const newTarget = {
              type: "device_param",
              trackIndex: track.trackIndex,
              mode: "trigger_note",
              midiNote: "C3",
              midiVelocity: 100
            };
            
            const currentTargets = window.currentMappings[window.selectedControl] || [];
            const cleanTargets = currentTargets.filter(t => !(t.mode === 'trigger_note' && t.trackIndex === track.trackIndex));
            cleanTargets.push(newTarget);
            
            window.sendWS("setMapping", {
              control: window.selectedControl,
              targets: cleanTargets
            }, () => {
              if (typeof window.fetchMappings === "function") window.fetchMappings();
            });
          } else {
            alert("Erro: " + ((res && res.error) || "Não foi possível carregar o receptor MIDI na faixa.") + "\n\nCertifique-se de ter salvo o dispositivo Max 'RC-Midi-Receiver.amxd' em sua User Library.");
          }
        });
      };
      
      list.appendChild(trackRow);
      totalShown++;
    });

    if (totalShown === 0) {
      const empty = document.createElement("div");
      empty.className = "picker-empty";
      empty.textContent = "Nenhuma pista MIDI encontrada";
      list.appendChild(empty);
    }
  }
};



/**
 * Commit a binding immediately with default curve/range (linear, full range,
 * smooth=0). The detail view lets the user fine-tune everything afterwards.
 *
 * Behaviour matrix (mirrors the legacy step-2 flow):
 *   - self-bind (same target already on this control): silently no-op.
 *   - cross-control conflict (target owned by another control): surface an
 *     inline banner in the detail panel with Replace/Cancel.
 *   - clean path: append the new target, send a single setMapping, close modal.
 *
 * On replace, removeMapping for the other control MUST be sent before
 * setMapping for the current control so the server never has both bindings
 * live at the same time.
 */
window.commitBind = function(t) {
  if (!window.selectedControl) return;
  const targets = window.currentMappings[window.selectedControl] || [];

  // Self-bind: same target already on this control. Idempotent close.
  if (targets.some((tgt) => window.isSameTarget(tgt, t))) {
    window.closePicker();
    return;
  }

  const conflictControl = window.findMappingConflict(
    t,
    window.selectedControl,
    window.currentMappings,
  );
  if (conflictControl) {
    window.showConflictBanner(t, conflictControl);
    return;
  }

  doApplyBind(t);
};

/**
 * Build the inline conflict banner in the detail panel. The banner stays
 * visible until the user clicks Replace (which calls doApplyBind with the
 * conflicting control) or Cancel (which hides the banner).
 */
window.showConflictBanner = function(t, conflictControl) {
  const banner = document.getElementById("map-conflict-banner");
  const msg = document.getElementById("map-conflict-msg");
  const replace = document.getElementById("map-conflict-replace");
  const cancel = document.getElementById("map-conflict-cancel");
  if (!banner || !msg || !replace || !cancel) return;

  const friendly = (typeof window.getControlDisplayName === "function"
    ? window.getControlDisplayName(conflictControl)
    : conflictControl);
  msg.textContent =
    `Este parametro ja esta mapeado por "${friendly}". ` +
    `Remova/substitua antes de adicionar aqui.`;
  banner.classList.remove("hidden");

  replace.onclick = () => {
    banner.classList.add("hidden");
    doApplyBind(t, { replaceOtherControl: conflictControl });
  };
  cancel.onclick = () => {
    banner.classList.add("hidden");
  };
};

/**
 * Actually push the binding to local + server state. If `replaceOtherControl`
 * is provided, strip the same target from that control first and emit
 * removeMapping/setMapping in the right order to avoid a race window.
 */
function doApplyBind(t, { replaceOtherControl = null } = {}) {
  const targets = window.currentMappings[window.selectedControl] || [];

  const newTarget = {
    type: t.type,
    trackIndex: t.trackIndex,
    deviceIndex: t.deviceIndex,
    paramIndex: t.paramIndex,
    sendIndex: t.sendIndex,
    label: window.getTargetLabel(t),
    curve: 'linear',
    inMin: 0,
    inMax: 1,
    outMin: 0,
    outMax: 1,
    smooth: 0,
    takeoverMode: 'scale',
    neutralPolicy: 'release',
    neutralValue: 0,
  };

  if (replaceOtherControl) {
    const otherTargets = window.currentMappings[replaceOtherControl] || [];
    const remaining = otherTargets.filter((ot) => !window.isSameTarget(ot, t));
    if (remaining.length === 0) {
      delete window.currentMappings[replaceOtherControl];
      window.sendWS("removeMapping", { control: replaceOtherControl });
    } else {
      window.currentMappings[replaceOtherControl] = remaining;
      window.sendWS("setMapping", {
        control: replaceOtherControl,
        targets: remaining,
      });
    }
  }

  targets.push(newTarget);
  window.currentMappings[window.selectedControl] = targets;
  window.sendWS("setMapping", {
    control: window.selectedControl,
    targets,
  }, () => {
    if (typeof window.fetchMappings === "function") {
      window.fetchMappings();
    }
  });
  window.closePicker();
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
  window.commitBind(t);
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

const originalRenderMappingsTab = window.renderMappingsTab;
window.renderMappingsTab = function() {
  originalRenderMappingsTab();
  initClearCategoryControl();
};

/**
 * Wire the new category-aware clear control exactly once: a <select> of
 * categories and a single execute button that dispatches either to the
 * existing clearAllMappings() (when "All Mappings" is selected) or to
 * clearMappingsByCategory() (when a real family is selected). Repeated
 * renders never stack handlers thanks to `dataset.bound`.
 *
 * The dropdown is populated lazily on first bind — we read
 * window.allControlsGrouped at that moment so a category list added at
 * runtime (e.g. when a custom mapping template is loaded) shows up the
 * next time renderMappingsTab fires.
 */
function initClearCategoryControl() {
  const sel = document.getElementById("map-clear-category");
  const btn = document.getElementById("btn-clear");
  if (!sel || !btn) return;

  if (!sel.dataset.bound) {
    sel.dataset.bound = "true";
    const groups = (typeof window.allControlsGrouped === "object" && window.allControlsGrouped)
      ? window.allControlsGrouped
      : {};
    // Placeholder first so the very first option is always "All
    // Mappings" — append real categories in insertion order so the list
    // stays stable across renders.
    const allOpt = document.createElement("option");
    allOpt.value = "__all__";
    allOpt.textContent = "All Mappings";
    sel.appendChild(allOpt);
    for (const name of Object.keys(groups)) {
      if (name === "__all__") continue;
      const opt = document.createElement("option");
      opt.value = name;
      opt.textContent = name;
      sel.appendChild(opt);
    }
    sel.addEventListener("change", () => {
      btn.textContent = sel.value === "__all__" ? "Clear" : "Clear " + sel.value;
    });
    btn.onclick = () => {
      const groups = (typeof window.allControlsGrouped === "object" && window.allControlsGrouped)
        ? window.allControlsGrouped
        : {};
      const selVal = sel.value;
      // Empty string (pre-init render quirk in tests), "__all__", or any
      // category not present in the current group list collapses to the
      // global clearAllMappings() path. Real selectors pick their first
      // <option> on default render, so the empty-string case mainly
      // shields unit tests from FakeDocument fragility.
      const targetIsCategory = selVal && selVal !== "__all__" && Array.isArray(groups[selVal]);
      if (targetIsCategory) {
        window.clearMappingsByCategory(selVal);
      } else {
        window.clearAllMappings();
      }
    };
  }
  // Keep the button label consistent with the current selection even on
  // subsequent renders — cheap and avoids "Clear" showing next to PADS.
  if (!btn.dataset.labelBound) {
    btn.dataset.labelBound = "true";
  }
  btn.textContent = sel.value === "__all__" ? "Clear" : "Clear " + sel.value;
}

/**
 * Clear every active mapping (backend + local). The backend command
 * `clearMappings` empties `controlMappings` and rewrites mappings.json
 * to `{}`. After success we reset local state and re-render so the
 * mapped-badges/LEDs clear immediately.
 */
window.clearAllMappings = function() {
  if (typeof window.confirm === "function" && !window.confirm("Clear all mappings? This cannot be undone.")) {
    return;
  }
  window.sendWS("clearMappings", {}, (res) => {
    if (res && res.ok) {
      for (const k of Object.keys(window.currentMappings)) delete window.currentMappings[k];
      window.selectedControl = null;
      window.renderMappingsTab();
      const statusEl = document.getElementById("footer-status");
      if (statusEl) statusEl.textContent = "All mappings cleared";
    } else {
      const statusEl = document.getElementById("footer-status");
      if (statusEl) statusEl.innerHTML = '<span style="color:var(--red)">Error clearing mappings</span>';
    }
  });
};

/**
 * Clear only the mappings belonging to a single category (e.g. PADS).
 * We never call `clearMappings` here — that nukes server state for
 * unrelated controls too. Instead we walk `window.currentMappings`,
 * pick the entries whose key is listed under `categoryName` in
 * `window.allControlsGrouped`, batch-remove each through the existing
 * removeMapping transport, and refetch at the end. The backend is hit
 * sequentially because parallel removes on the same JSON file have
 * raced in the past during stress tests.
 */
window.clearMappingsByCategory = function(categoryName) {
  if (typeof categoryName !== "string" || !categoryName) return;
  const groups = (typeof window.allControlsGrouped === "object" && window.allControlsGrouped)
    ? window.allControlsGrouped
    : null;
  if (!groups || !Array.isArray(groups[categoryName])) {
    return;
  }
  const categoryCtrls = groups[categoryName];
  const ctrlsToRemove = categoryCtrls.filter((c) => {
    const t = window.currentMappings[c];
    return Array.isArray(t) && t.length > 0;
  });
  if (ctrlsToRemove.length === 0) {
    const statusEl = document.getElementById("footer-status");
    if (statusEl) statusEl.textContent = `No mappings in ${categoryName} to clear`;
    return;
  }
  if (typeof window.confirm === "function" &&
      !window.confirm(
        `Clear ${ctrlsToRemove.length} mapping${ctrlsToRemove.length === 1 ? "" : "s"} in ${categoryName}? This cannot be undone.`
      )) {
    return;
  }
  const statusEl = document.getElementById("footer-status");
  const sendOne = (i) => {
    if (i >= ctrlsToRemove.length) {
      if (statusEl) statusEl.textContent = `Cleared ${ctrlsToRemove.length} mappings in ${categoryName}`;
      window.renderMappingsTab();
      if (typeof window.fetchMappings === "function") window.fetchMappings();
      return;
    }
    const ctrl = ctrlsToRemove[i];
    window.sendWS("removeMapping", { control: ctrl }, () => {
      // Local state stays authoritative in case the server replies
      // stale under load; the post-fetch in sendOne will reconcile.
      sendOne(i + 1);
    });
  };
  sendOne(0);
};
