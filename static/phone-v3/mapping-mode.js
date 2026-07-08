(function () {
  'use strict';

  const state = {
    open: false,
    previousPage: 'performance',
    loaded: false,
    allTargets: [],
    currentMappings: {},
    clients: [],
    presets: [],
    currentPreset: 'Default',
    selectedControl: null,
    selectedTargetIndex: 0,
    busy: false,
    error: '',
    pickerMode: null,
    pickerFilter: '',
    pendingConflict: null,
  };

  function $(id) {
    return document.getElementById(id);
  }

  function setStatus(text, kind = '') {
    const el = $('map-mobile-status');
    if (el) {
      el.textContent = text;
      el.dataset.kind = kind;
    }
    const inlineEl = document.querySelector('.map-detail-status');
    if (inlineEl) {
      inlineEl.textContent = text;
      inlineEl.dataset.kind = kind;
    }
  }

  const CONTROL_GROUPS = [
    { group: 'Pads', items: Array.from({ length: 12 }, (_, i) => `pad-${i + 1}`) },
    { group: 'XY Pads', items: ['xy-1.x', 'xy-1.y', 'xy-2.x', 'xy-2.y'] },
    { group: 'LFOs', items: ['toggle-1', 'toggle-2', 'toggle-3', 'toggle-4'] },
    { group: 'Stutters', items: ['button-1', 'button-2', 'button-3', 'button-4'] },
    { group: 'Knobs', items: Array.from({ length: 6 }, (_, i) => `knob-${i + 1}`) },
    { group: 'Faders', items: Array.from({ length: 6 }, (_, i) => `fader-${i + 1}`) },
    { group: 'Sensors: Orientation + Motion', items: [
      'sensor.orient.alpha', 'sensor.orient.beta', 'sensor.orient.gamma',
      'sensor.motion.ax', 'sensor.motion.ay', 'sensor.motion.az',
      'sensor.motion.gx', 'sensor.motion.gy', 'sensor.motion.gz',
    ] },
    { group: 'Sensors: Audio', items: [
      'sensor.audio.rms', 'sensor.audio.pitch', 'sensor.audio.bpm',
      'sensor.audio.note', 'sensor.audio.clarity',
      'sensor.audio.whistle.active', 'sensor.audio.whistle.bend',
      'sensor.audio.envelope', 'sensor.audio.transient', 'sensor.audio.gate',
    ] },
    { group: 'Sensors: Vision', items: [
      'sensor.vision.active', 'sensor.vision.x', 'sensor.vision.y', 'sensor.vision.z',
      'sensor.vision.fist', 'sensor.vision.pinch', 'sensor.vision.victory',
      'sensor.vision.open', 'sensor.vision.thumb', 'sensor.vision.index',
      'sensor.vision.middle', 'sensor.vision.ring', 'sensor.vision.pinky',
      'sensor.vision.fingers', 'sensor.vision.color.r',
      'sensor.vision.color.g', 'sensor.vision.color.b',
    ] },
  ];

  function rawControlName(name) {
    return String(name || '').split('::').pop();
  }

  function controlLabel(name) {
    const raw = rawControlName(name);
    if (raw === 'xy-1.x') return 'XY 1 - X Axis (Horizontal)';
    if (raw === 'xy-1.y') return 'XY 1 - Y Axis (Vertical)';
    if (raw === 'xy-2.x') return 'XY 2 - X Axis (Horizontal)';
    if (raw === 'xy-2.y') return 'XY 2 - Y Axis (Vertical)';
    const pad = raw.match(/^pad-(\d+)$/);
    if (pad) return `Pad ${pad[1]}`;
    const knob = raw.match(/^knob-(\d+)$/);
    if (knob) return `Knob ${knob[1]}`;
    const fader = raw.match(/^fader-(\d+)$/);
    if (fader) return `Fader ${fader[1]}`;
    const lfo = raw.match(/^toggle-(\d+)$/);
    if (lfo) return `LFO ${lfo[1]}`;
    const stutter = raw.match(/^button-(\d+)$/);
    if (stutter) return `Stutter ${stutter[1]}`;
    return raw.replace(/^sensor\./, '').replace(/\./g, ' ');
  }

  function mappingKey(control) {
    if (state.selectedClient) return `${state.selectedClient}::${control}`;
    return control;
  }

  function targetsForControl(control) {
    const clientKey = state.selectedClient ? `${state.selectedClient}::${control}` : null;
    if (clientKey && state.currentMappings[clientKey]) return state.currentMappings[clientKey];
    return state.currentMappings[control] || [];
  }

  function targetLabel(target) {
    if (!target) return '';
    if (target.type === 'tempo') return 'Song Tempo';
    const targetKind = target.trackKind || 'track';
    const track = state.allTargets.find((item) => item.trackIndex === target.trackIndex && (item.trackKind || 'track') === targetKind);
    const trackName = track ? track.name : `Track ${(target.trackIndex ?? 0) + 1}`;
    if (target.mode === 'trigger_note') return `${trackName} -> Trigger ${target.midiNote || 'C3'}`;
    if (target.type === 'mixer_volume') return `${trackName} -> Volume`;
    if (target.type === 'mixer_pan') return `${trackName} -> Pan`;
    if (target.type === 'mixer_send') return `${trackName} -> Send ${(target.sendIndex ?? 0) + 1}`;
    if (target.type === 'track_mute') return `${trackName} -> Mute`;
    if (target.type === 'track_solo') return `${trackName} -> Solo`;
    if (target.type === 'track_arm') return `${trackName} -> Arm`;
    if (target.type === 'device_param') {
      const device = track && track.devices ? track.devices.find((d) => d.index === target.deviceIndex) : null;
      const param = device && device.params ? device.params[target.paramIndex] : null;
      return `${trackName} -> ${device ? device.name : `Device ${target.deviceIndex}`} -> ${param ? param.label : `P${target.paramIndex}`}`;
    }
    return target.type;
  }

  function isSameTarget(a, b) {
    if (!a || !b || a.type !== b.type) return false;
    const aKind = a.trackKind || 'track';
    const bKind = b.trackKind || 'track';
    if (aKind !== bKind) return false;
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
  }

  function findConflict(target) {
    const selectedKey = mappingKey(state.selectedControl);
    for (const [control, targets] of Object.entries(state.currentMappings)) {
      if (control === state.selectedControl || control === selectedKey) continue;
      if (!Array.isArray(targets)) continue;
      if (targets.some((candidate) => isSameTarget(candidate, target))) return control;
    }
    return null;
  }

  async function saveTargetsForSelected(targets, refresh = true) {
    if (!state.selectedControl) return { ok: false, error: 'No selected control' };
    const key = mappingKey(state.selectedControl);
    const prevTargets = state.currentMappings[key] ? [...state.currentMappings[key]] : undefined;
    const finalTargets = Array.isArray(targets) ? targets : [];
    state.currentMappings[key] = finalTargets;
    const response = await command('setMapping', { control: key, targets: finalTargets });
    if (response && response.ok !== false) {
      if (refresh) await loadMobileMappingData();
    } else {
      if (prevTargets === undefined) {
        delete state.currentMappings[key];
      } else {
        state.currentMappings[key] = prevTargets;
      }
      setStatus(response?.error || 'Failed to save mapping target.', 'error');
    }
    return response;
  }

  async function removeMobileMappingTarget(index) {
    if (!state.selectedControl) return;
    const key = mappingKey(state.selectedControl);
    const targets = targetsForControl(state.selectedControl).slice();
    targets.splice(index, 1);
    if (targets.length === 0) {
      delete state.currentMappings[key];
      delete state.currentMappings[state.selectedControl];
      await command('removeMapping', { control: key });
      if (key !== state.selectedControl) {
        await command('removeMapping', { control: state.selectedControl });
      }
      renderAll();
      return;
    }
    await saveTargetsForSelected(targets);
  }

  async function clearSelectedMobileControl() {
    if (!state.selectedControl) return;
    const key = mappingKey(state.selectedControl);
    delete state.currentMappings[key];
    delete state.currentMappings[state.selectedControl];
    await command('removeMapping', { control: key });
    if (key !== state.selectedControl) {
      await command('removeMapping', { control: state.selectedControl });
    }
    renderAll();
  }

  async function clearMobileMappingCategory(groupName) {
    const group = CONTROL_GROUPS.find((candidate) => candidate.group === groupName);
    if (!group) return;
    for (const control of group.items) {
      const key = mappingKey(control);
      if (state.currentMappings[key] || state.currentMappings[control]) {
        delete state.currentMappings[key];
        delete state.currentMappings[control];
        await command('removeMapping', { control: key });
        if (key !== control) {
          await command('removeMapping', { control: control });
        }
      }
    }
    renderAll();
  }

  async function replaceMobileMappingConflict(oldControl, target) {
    const oldTargets = (state.currentMappings[oldControl] || []).filter((candidate) => !isSameTarget(candidate, target));
    let response;
    if (oldTargets.length === 0) {
      delete state.currentMappings[oldControl];
      response = await command('removeMapping', { control: oldControl });
    } else {
      state.currentMappings[oldControl] = oldTargets;
      response = await command('setMapping', { control: oldControl, targets: oldTargets });
    }
    if (response && response.ok === false) {
      setStatus(response.error || 'Failed to replace existing mapping.', 'error');
      return response;
    }
    const current = targetsForControl(state.selectedControl).slice();
    current.push(target);
    return saveTargetsForSelected(current, false);
  }

  function selectedTarget() {
    const targets = targetsForControl(state.selectedControl);
    return targets[state.selectedTargetIndex] || null;
  }

  function normalizeMidiNote(value) {
    const text = String(value || '').trim().toUpperCase();
    if (/^[A-G]#?-?\d+$/.test(text) || /^\d+$/.test(text)) return text;
    return null;
  }

  async function updateMobileTargetField(field, value, opts = {}) {
    if (!state.selectedControl) return;
    const targets = targetsForControl(state.selectedControl).slice();
    const target = { ...(targets[state.selectedTargetIndex] || {}) };
    if (field === 'midiNote') {
      const note = normalizeMidiNote(value);
      if (!note) return;
      target[field] = note;
    } else if (field === 'midiVelocity') {
      target[field] = Math.max(1, Math.min(127, Math.round(Number(value) || 1)));
    } else if (['inMin', 'inMax', 'outMin', 'outMax', 'threshold', 'drive', 'compressor', 'smooth', 'idleValue'].includes(field)) {
      target[field] = Number(value);
    } else {
      target[field] = value;
    }
    targets[state.selectedTargetIndex] = target;
    if (window.currentControlMappings && state.selectedControl) {
      window.currentControlMappings[state.selectedControl] = targets;
    }
    await saveTargetsForSelected(targets, opts.refresh !== false);
  }

  function openTargetPicker() {
    state.pickerMode = 'target';
    renderDetail();
  }

  function closePicker() {
    state.pickerMode = null;
    state.pendingConflict = null;
    renderDetail();
  }

  function flattenTargets() {
    const out = [{ type: 'tempo', label: 'Song Tempo' }];
    for (const track of state.allTargets) {
      if (track.type === 'tempo') continue;
      for (const mixer of track.mixer || []) out.push(mixer);
      for (const device of track.devices || []) {
        for (const param of device.params || []) out.push(param);
      }
    }
    return out;
  }

  async function bindMobileTarget(target) {
    if (!state.selectedControl) return false;
    const normalized = { ...target };
    delete normalized.label;
    const conflict = findConflict(normalized);
    if (conflict) {
      state.pendingConflict = { owner: conflict, target: normalized };
      state.pickerMode = null;
      renderDetail();
      return false;
    }
    const targets = targetsForControl(state.selectedControl).slice();
    if (targets.some((candidate) => isSameTarget(candidate, normalized))) {
      setStatus('Este parâmetro já está mapeado para este controle.', 'error');
      return false;
    }
    targets.push({ curve: 'linear', inMin: 0, inMax: 1, outMin: 0, outMax: 1, ...normalized });
    const response = await saveTargetsForSelected(targets);
    if (response && response.ok !== false) {
      return true;
    }
    return false;
  }

  window.updateMobileTargetField = updateMobileTargetField;
  window.bindMobileTarget = bindMobileTarget;
  window.removeMobileMappingTarget = removeMobileMappingTarget;
  window.clearSelectedMobileControl = clearSelectedMobileControl;
  window.clearMobileMappingCategory = clearMobileMappingCategory;
  window.replaceMobileMappingConflict = replaceMobileMappingConflict;

  async function saveMobileMappingPreset(name) {
    const clean = String(name || '').trim().replace(/[^a-zA-Z0-9_-]/g, '_');
    if (!clean) return;
    const response = await command('savePreset', { name: clean });
    if (response.ok) await loadMobileMappingData();
    else setStatus(response.error || 'Could not save preset', 'error');
  }

  async function loadMobileMappingPreset(name) {
    if (!name) return;
    const response = await command('loadPreset', { name });
    if (response.ok) await loadMobileMappingData();
    else setStatus(response.error || 'Could not load preset', 'error');
  }

  async function deleteMobileMappingPreset(name) {
    if (!name || name === 'Default') return;
    const response = await command('deletePreset', { name });
    if (response.ok) await loadMobileMappingData();
    else setStatus(response.error || 'Could not delete preset', 'error');
  }

  async function createMobileTriggerNoteTarget(track) {
    if (!state.selectedControl || !track || typeof track.trackIndex !== 'number') return false;
    state.busy = true;
    renderDetail();
    const install = await command('addUdpReceiverToTrack', { trackIndex: track.trackIndex });
    state.busy = false;
    if (!install.ok || !install.result || !install.result.success) {
      setStatus('Não consegui inserir automaticamente. Coloque manualmente RC-Midi-Receiver.amxd nesta track e tente novamente.', 'error');
      renderDetail();
      return false;
    }
    const targets = targetsForControl(state.selectedControl)
      .filter((target) => !(target.mode === 'trigger_note' && target.trackIndex === track.trackIndex));
    targets.push({
      type: 'device_param',
      trackIndex: track.trackIndex,
      mode: 'trigger_note',
      midiNote: 'C3',
      midiVelocity: 100,
    });
    await saveTargetsForSelected(targets);
  }

  function openMidiTrackPicker() {
    state.pickerMode = 'midi';
    renderDetail();
  }

  window.createMobileTriggerNoteTarget = createMobileTriggerNoteTarget;
  window.saveMobileMappingPreset = saveMobileMappingPreset;
  window.loadMobileMappingPreset = loadMobileMappingPreset;
  window.deleteMobileMappingPreset = deleteMobileMappingPreset;

  function command(cmd, args = {}) {
    return new Promise((resolve) => {
      if (typeof window.sendPhoneCommand !== 'function') {
        resolve({ ok: false, error: 'Phone command bridge is not ready' });
        return;
      }
      window.sendPhoneCommand(cmd, args, resolve);
    });
  }

  function normalizeMappings(raw) {
    const out = {};
    for (const [key, value] of Object.entries(raw || {})) {
      out[key] = Array.isArray(value) ? value : [value];
    }
    return out;
  }

  async function loadMobileMappingData() {
    state.busy = true;
    state.error = '';
    setStatus('Loading...', 'loading');
    if (typeof window.throttlePhoneTelemetry === 'function') {
      window.throttlePhoneTelemetry(2000);
    }

    const [targets, mappings, clients, presets] = await Promise.all([
      command('getTargets'),
      command('getMappings'),
      command('getClients'),
      command('listPresets'),
    ]);

    if (!targets.ok || !mappings.ok || !clients.ok || !presets.ok) {
      state.busy = false;
      state.error = 'Could not load mapping data';
      setStatus(state.error, 'error');
      renderAll();
      return;
    }

    state.allTargets = targets.result.targets || [];
    state.currentMappings = normalizeMappings(mappings.result.mappings || {});
    state.clients = clients.result.clients || [];
    state.presets = presets.result.presets || [];
    state.currentPreset = presets.result.current || 'Default';
    state.loaded = true;
    state.busy = false;
    setStatus('Loaded', 'ok');
    renderAll();
  }

  function openMappingMode() {
    if (state.open) return;
    state.previousPage = document.body.dataset.page || 'performance';
    state.open = true;
    // Initialise selectedClient eagerly so getActiveMappingKey() is correct from the first load.
    if (!state.selectedClient && typeof window.getPhoneClientId === 'function') {
      state.selectedClient = window.getPhoneClientId() || null;
    }
    document.body.classList.add('mapping-mode');
    const btn = $('btn-map-mode');
    if (btn) {
      btn.classList.add('on');
      btn.setAttribute('aria-pressed', 'true');
    }
    if (typeof window.setPhoneMappingModeActive === 'function') {
      window.setPhoneMappingModeActive(true);
    }
    if (typeof window.showPhonePage === 'function') {
      window.showPhonePage('mapping');
    } else {
      document.body.dataset.page = 'mapping';
    }
    // Restore the visibility of the previous page so user sees real interface
    const prevPageEl = document.querySelector(`.page[data-page="${state.previousPage}"]`);
    if (prevPageEl) prevPageEl.classList.remove('hidden');

    const overlay = $('mapping-mode');
    if (overlay) overlay.classList.remove('hidden');
    setStatus('Loading...', 'loading');
    if (typeof setTimeout === 'function' && typeof window !== 'undefined' && typeof window.dispatchEvent === 'function') {
      setTimeout(() => window.dispatchEvent(new Event('resize')), 150);
    }
    return loadMobileMappingData();
  }

  function updatePageControlHighlights() {
    document.querySelectorAll('[data-name].selected-control').forEach((el) => {
      el.classList.remove('selected-control');
    });
    if (state.selectedControl) {
      const base = state.selectedControl.split('.')[0];
      const el = document.querySelector(`[data-name="${base}"]`);
      if (el) {
        el.classList.add('selected-control');
      }
    }
  }

  function renderAll() {
    renderPresets();
    renderControls();
    renderDetail();
    updatePageControlHighlights();
  }
  function closeMappingMode() {
    if (!state.open) return;
    state.open = false;
    document.body.classList.remove('mapping-mode');
    const btn = $('btn-map-mode');
    if (btn) {
      btn.classList.remove('on');
      btn.setAttribute('aria-pressed', 'false');
    }
    if (typeof window.setPhoneMappingModeActive === 'function') {
      window.setPhoneMappingModeActive(false);
    }
    const overlay = $('mapping-mode');
    if (overlay) overlay.classList.add('hidden');
    const previousPage = state.previousPage || 'performance';
    if (typeof window.showPhonePage === 'function') {
      window.showPhonePage(previousPage);
    }
    document.querySelectorAll('[data-name].selected-control').forEach((el) => {
      el.classList.remove('selected-control');
    });
    if (typeof setTimeout === 'function' && typeof window !== 'undefined' && typeof window.dispatchEvent === 'function') {
      setTimeout(() => window.dispatchEvent(new Event('resize')), 150);
    }
  }
  function renderPresets() {
    const el = $('map-mobile-presets');
    if (!el) return;
    el.innerHTML = '';
    const select = document.createElement('select');
    select.className = 'map-preset-select';
    for (const preset of state.presets) {
      const option = document.createElement('option');
      option.value = preset;
      option.textContent = preset;
      option.selected = preset === state.currentPreset;
      select.appendChild(option);
    }
    select.addEventListener('change', () => loadMobileMappingPreset(select.value));
    el.appendChild(select);

    const name = document.createElement('input');
    name.className = 'map-preset-name';
    name.type = 'text';
    name.setAttribute('aria-label', 'Preset name');
    name.autocapitalize = 'none';
    el.appendChild(name);

    const save = document.createElement('button');
    save.type = 'button';
    save.textContent = 'Save';
    save.addEventListener('click', () => saveMobileMappingPreset(name.value));
    el.appendChild(save);

    const del = document.createElement('button');
    del.type = 'button';
    del.textContent = 'Delete';
    del.addEventListener('click', () => {
      if (window.confirm && !window.confirm(`Delete preset "${select.value}"?`)) return;
      deleteMobileMappingPreset(select.value);
    });
    el.appendChild(del);
  }

  function renderControls() {
    const el = $('map-mobile-controls');
    if (!el) return;
    el.innerHTML = '';
    const filter = (($('map-mobile-search') && $('map-mobile-search').value) || '').trim().toLowerCase();

    for (const group of CONTROL_GROUPS) {
      const matches = group.items.filter((name) => !filter || name.toLowerCase().includes(filter) || controlLabel(name).toLowerCase().includes(filter));
      if (matches.length === 0) continue;
      const groupEl = document.createElement('section');
      groupEl.className = 'map-control-group';
      const head = document.createElement('h3');
      head.textContent = group.group;
      groupEl.appendChild(head);
      for (const name of matches) {
        const row = document.createElement('button');
        row.type = 'button';
        row.className = 'map-control-row';
        row.dataset.control = name;
        row.classList.toggle('selected', state.selectedControl === name);
        const targets = targetsForControl(name);
        row.textContent = `${controlLabel(name)} ${targets.length ? `(${targets.length})` : ''}`;
        row.addEventListener('click', () => {
          state.selectedControl = name;
          state.selectedTargetIndex = 0;
          renderAll();
        });
        groupEl.appendChild(row);
      }
      el.appendChild(groupEl);
    }
  }

  function renderPresetsInline(container) {
    container.innerHTML = '';
    const select = document.createElement('select');
    select.className = 'map-preset-select';
    for (const preset of state.presets) {
      const option = document.createElement('option');
      option.value = preset;
      option.textContent = preset;
      option.selected = preset === state.currentPreset;
      select.appendChild(option);
    }
    select.addEventListener('change', () => loadMobileMappingPreset(select.value));
    container.appendChild(select);

    const name = document.createElement('input');
    name.className = 'map-preset-name';
    name.type = 'text';
    name.placeholder = 'New Preset...';
    name.setAttribute('aria-label', 'Preset name');
    name.autocapitalize = 'none';
    container.appendChild(name);

    const save = document.createElement('button');
    save.type = 'button';
    save.className = 'map-mini-btn';
    save.textContent = 'Save';
    save.addEventListener('click', () => {
      saveMobileMappingPreset(name.value);
      name.value = '';
    });
    container.appendChild(save);

    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'map-mini-btn';
    del.textContent = 'Delete';
    del.addEventListener('click', () => {
      if (window.confirm && !window.confirm(`Delete preset "${select.value}"?`)) return;
      deleteMobileMappingPreset(select.value);
    });
    container.appendChild(del);
  }

  function renderDetail() {
    const el = $('map-mobile-detail');
    if (!el) return;
    el.innerHTML = '';
    
    // Toggle details pane visibility based on selectedControl
    const pane = el.closest('.map-pane-right');
    if (pane) {
      if (state.selectedControl) {
        pane.classList.remove('hidden');
      } else {
        pane.classList.add('hidden');
      }
    }

    if (state.pickerMode === 'target') {
      renderTargetPicker(el);
      return;
    }
    if (state.pickerMode === 'midi') {
      renderMidiPicker(el);
      return;
    }
    if (!state.selectedControl) {
      el.textContent = 'Select a control';
      return;
    }

    // Status and refresh row
    const statusRow = document.createElement('div');
    statusRow.className = 'map-detail-header-row';
    const statusEl = document.createElement('div');
    statusEl.className = 'map-detail-status';
    const originalStatus = $('map-mobile-status');
    statusEl.textContent = originalStatus ? originalStatus.textContent : 'Ready';
    statusEl.dataset.kind = originalStatus ? originalStatus.dataset.kind : '';
    statusRow.appendChild(statusEl);

    const refreshBtn = document.createElement('button');
    refreshBtn.type = 'button';
    refreshBtn.className = 'map-mini-btn';
    refreshBtn.textContent = 'Refresh';
    refreshBtn.addEventListener('click', loadMobileMappingData);
    statusRow.appendChild(refreshBtn);
    el.appendChild(statusRow);

    // Presets inline
    const presetsRow = document.createElement('div');
    presetsRow.className = 'map-detail-presets-row';
    renderPresetsInline(presetsRow);
    el.appendChild(presetsRow);

    const title = document.createElement('h2');
    title.className = 'map-detail-title';
    title.textContent = controlLabel(state.selectedControl);

    const deselectBtn = document.createElement('button');
    deselectBtn.type = 'button';
    deselectBtn.className = 'map-mini-btn';
    deselectBtn.textContent = 'Close';
    deselectBtn.style.float = 'right';
    deselectBtn.addEventListener('click', () => {
      state.selectedControl = null;
      renderAll();
    });
    title.appendChild(deselectBtn);
    el.appendChild(title);

    if (state.selectedControl && (state.selectedControl.startsWith('xy-1.') || state.selectedControl.startsWith('xy-2.'))) {
      const base = state.selectedControl.split('.')[0];
      const activeAxis = state.selectedControl.split('.')[1] || 'x';

      const axisSelector = document.createElement('div');
      axisSelector.className = 'map-xy-axis-selector';

      const btnX = document.createElement('button');
      btnX.type = 'button';
      btnX.className = `map-axis-tab${activeAxis === 'x' ? ' active' : ''}`;
      btnX.textContent = 'X Axis (Horizontal)';
      btnX.addEventListener('click', () => {
        state.selectedControl = `${base}.x`;
        state.selectedTargetIndex = 0;
        renderAll();
      });

      const btnY = document.createElement('button');
      btnY.type = 'button';
      btnY.className = `map-axis-tab${activeAxis === 'y' ? ' active' : ''}`;
      btnY.textContent = 'Y Axis (Vertical)';
      btnY.addEventListener('click', () => {
        state.selectedControl = `${base}.y`;
        state.selectedTargetIndex = 0;
        renderAll();
      });

      axisSelector.appendChild(btnX);
      axisSelector.appendChild(btnY);
      el.appendChild(axisSelector);
    }

    if (state.pendingConflict) {
      const banner = document.createElement('div');
      banner.className = 'map-conflict';
      banner.textContent = `Already mapped to ${controlLabel(state.pendingConflict.owner)}`;
      const replace = document.createElement('button');
      replace.type = 'button';
      replace.textContent = 'Replace';
      replace.addEventListener('click', async () => {
        const conflict = state.pendingConflict;
        if (!conflict) return;
        replace.disabled = true;
        setStatus(`Replacing ${controlLabel(conflict.owner)}...`, 'loading');
        const response = await replaceMobileMappingConflict(conflict.owner, conflict.target);
        if (response && response.ok === false) {
          replace.disabled = false;
          renderDetail();
          return;
        }
        state.pendingConflict = null;
        state.selectedTargetIndex = Math.max(0, targetsForControl(state.selectedControl).length - 1);
        setStatus(`Replaced mapping from ${controlLabel(conflict.owner)}.`, 'ok');
        renderAll();
      });
      const cancel = document.createElement('button');
      cancel.type = 'button';
      cancel.textContent = 'Cancel';
      cancel.addEventListener('click', () => { state.pendingConflict = null; renderDetail(); });
      banner.appendChild(replace);
      banner.appendChild(cancel);
      el.appendChild(banner);
    }

    const targets = targetsForControl(state.selectedControl);
    const list = document.createElement('div');
    list.className = 'map-bound-list';
    for (let i = 0; i < targets.length; i += 1) {
      const row = document.createElement('button');
      row.type = 'button';
      row.className = 'map-bound-target';
      row.dataset.targetIndex = String(i);
      row.classList.toggle('selected', i === state.selectedTargetIndex);
      row.textContent = targetLabel(targets[i]);
      row.addEventListener('click', () => {
        state.selectedTargetIndex = i;
        renderDetail();
      });
      list.appendChild(row);
    }
    el.appendChild(list);

    if (targets[state.selectedTargetIndex]) {
      renderTargetEditor(el, targets[state.selectedTargetIndex]);
    }

    const actions = document.createElement('div');
    actions.className = 'map-detail-actions';
    const bind = document.createElement('button');
    bind.type = 'button';
    bind.textContent = 'Bind';
    bind.addEventListener('click', openTargetPicker);
    actions.appendChild(bind);

    const trigger = document.createElement('button');
    trigger.type = 'button';
    trigger.textContent = 'Trigger Note';
    trigger.addEventListener('click', openMidiTrackPicker);
    actions.appendChild(trigger);

    // If there are mapped targets, show the Delete and Clear All options!
    if (targets.length > 0) {
      const unbind = document.createElement('button');
      unbind.type = 'button';
      unbind.className = 'map-action-danger';
      unbind.textContent = 'Unbind Target';
      unbind.addEventListener('click', async () => {
        if (window.confirm && !window.confirm('Remove this mapping?')) return;
        await removeMobileMappingTarget(state.selectedTargetIndex);
        state.selectedTargetIndex = 0;
        renderDetail();
      });
      actions.appendChild(unbind);

      const clearAll = document.createElement('button');
      clearAll.type = 'button';
      clearAll.className = 'map-action-danger';
      clearAll.textContent = 'Clear All';
      clearAll.addEventListener('click', async () => {
        if (window.confirm && !window.confirm('Clear all mappings for this control?')) return;
        await clearSelectedMobileControl();
        state.selectedTargetIndex = 0;
        renderDetail();
      });
      actions.appendChild(clearAll);
    }

    el.appendChild(actions);
  }

  function renderMidiPicker(container) {
    container.innerHTML = '';
    const head = document.createElement('div');
    head.className = 'map-picker-head';
    const back = document.createElement('button');
    back.type = 'button';
    back.textContent = 'Back';
    back.addEventListener('click', closePicker);
    head.appendChild(back);
    const title = document.createElement('strong');
    title.textContent = 'Pick MIDI Track';
    head.appendChild(title);
    container.appendChild(head);

    const statusRow = document.createElement('div');
    statusRow.className = 'map-detail-header-row';
    const statusEl = document.createElement('div');
    statusEl.className = 'map-detail-status';
    const originalStatus = $('map-mobile-status');
    statusEl.textContent = originalStatus ? originalStatus.textContent : 'Ready';
    statusEl.dataset.kind = originalStatus ? originalStatus.dataset.kind : '';
    statusRow.appendChild(statusEl);
    container.appendChild(statusRow);

    const list = document.createElement('div');
    list.className = 'map-picker-list';
    for (const track of state.allTargets.filter((item) => item.isMidi)) {
      const row = document.createElement('button');
      row.type = 'button';
      row.className = 'map-picker-row';
      row.disabled = state.busy;
      row.textContent = state.busy ? 'Installing...' : (track.name || `Track ${track.trackIndex + 1}`);
      row.addEventListener('click', async () => {
        const result = await createMobileTriggerNoteTarget(track);
        // Only close the picker on success; on failure the error is shown inside the detail pane.
        if (result !== false) closePicker();
      });
      list.appendChild(row);
    }
    container.appendChild(list);
  }

  function addEditorSelect(container, label, field, value, options) {
    const wrap = document.createElement('label');
    wrap.className = 'map-editor-field';
    const span = document.createElement('span');
    span.textContent = label;
    const select = document.createElement('select');
    for (const option of options) {
      const item = document.createElement('option');
      item.value = option;
      item.textContent = option;
      item.selected = option === value;
      select.appendChild(item);
    }
    select.addEventListener('change', () => updateMobileTargetField(field, select.value));
    wrap.appendChild(span);
    wrap.appendChild(select);
    container.appendChild(wrap);
  }

  function addEditorNumber(container, label, field, value, min, max, step) {
    const wrap = document.createElement('label');
    wrap.className = 'map-editor-field';
    const span = document.createElement('span');
    span.textContent = label;
    const input = document.createElement('input');
    input.type = 'number';
    input.inputMode = 'decimal';
    input.min = String(min);
    input.max = String(max);
    input.step = String(step);
    input.value = String(value);
    input.addEventListener('input', () => updateMobileTargetField(field, input.value, { refresh: false }));
    input.addEventListener('change', () => updateMobileTargetField(field, input.value));
    wrap.appendChild(span);
    wrap.appendChild(input);
    container.appendChild(wrap);
  }

  let activeAnimationId = null;

  function getActiveTarget() {
    if (!state.selectedControl) return null;
    const targets = targetsForControl(state.selectedControl);
    return targets[state.selectedTargetIndex] || null;
  }

  function startCanvasAnimation(canvas, readoutEl) {
    if (activeAnimationId) {
      cancelAnimationFrame(activeAnimationId);
      activeAnimationId = null;
    }

    if (typeof canvas.getContext !== 'function') return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const run = () => {
      if (!state.open || !state.selectedControl || state.pickerMode) {
        activeAnimationId = null;
        return;
      }

      const activeTarget = getActiveTarget();
      if (!activeTarget) {
        activeAnimationId = null;
        return;
      }

      const rawVal = window.currentControlStates ? (window.currentControlStates[state.selectedControl] ?? 0.5) : 0.5;
      drawCurve(canvas, ctx, activeTarget, rawVal, readoutEl);
      activeAnimationId = requestAnimationFrame(run);
    };

    activeAnimationId = requestAnimationFrame(run);
  }

  function drawCurve(canvas, ctx, target, currentInput, readoutEl) {
    const w = canvas.width;
    const h = canvas.height;

    ctx.fillStyle = '#0d0d0f';
    ctx.fillRect(0, 0, w, h);

    ctx.strokeStyle = '#1a1a1c';
    ctx.lineWidth = 1;
    for (let i = 0.25; i < 1; i += 0.25) {
      ctx.beginPath();
      ctx.moveTo(i * w, 0);
      ctx.lineTo(i * w, h);
      ctx.stroke();

      ctx.beginPath();
      ctx.moveTo(0, i * h);
      ctx.lineTo(w, i * h);
      ctx.stroke();
    }

    const curve = target.curve || 'linear';
    const drive = target.drive ?? 0;
    const compressor = target.compressor ?? 0;
    const inMin = target.inMin ?? 0;
    const inMax = target.inMax ?? 1;
    const outMin = target.outMin ?? 0;
    const outMax = target.outMax ?? 1;

    const applyCurveLocal = (val) => {
      let v = val;
      if (curve === 'exponential') {
        v = val * val;
      } else if (curve === 'logarithmic') {
        v = Math.sqrt(val);
      } else if (curve === 's-curve') {
        v = 0.5 * (1 - Math.cos(val * Math.PI));
      }

      if (drive !== 0) {
        v = Math.max(0, Math.min(1, v + drive));
      }

      if (compressor !== 0) {
        if (compressor < 0) {
          v = v * (1 + compressor) + 0.5 * (-compressor);
        } else {
          const diff = v - 0.5;
          const sign = diff >= 0 ? 1 : -1;
          const normDiff = Math.abs(diff) * 2;
          const exponent = 1 - compressor * 0.8;
          const expanded = Math.pow(normDiff, exponent);
          v = 0.5 + sign * 0.5 * expanded;
        }
      }
      return v;
    };

    ctx.strokeStyle = '#007aff';
    ctx.lineWidth = 2.5;
    ctx.beginPath();

    const steps = 60;
    for (let i = 0; i <= steps; i++) {
      const pct = i / steps;
      let norm = 0;
      if (inMax > inMin) {
        norm = Math.max(0, Math.min(1, (pct - inMin) / (inMax - inMin)));
      } else {
        norm = pct >= inMin ? 1 : 0;
      }
      const curved = applyCurveLocal(norm);
      const yVal = outMin + curved * (outMax - outMin);
      const cx = pct * w;
      const cy = (1 - yVal) * h;
      if (i === 0) ctx.moveTo(cx, cy);
      else ctx.lineTo(cx, cy);
    }
    ctx.stroke();

    let normalizedInput = 0;
    if (inMax > inMin) {
      normalizedInput = Math.max(0, Math.min(1, (currentInput - inMin) / (inMax - inMin)));
    } else {
      normalizedInput = currentInput >= inMin ? 1 : 0;
    }
    const curvedInput = applyCurveLocal(normalizedInput);
    const scaledOutput = outMin + curvedInput * (outMax - outMin);

    const dotX = currentInput * w;
    const dotY = (1 - scaledOutput) * h;

    ctx.fillStyle = 'rgba(255, 149, 0, 0.35)';
    ctx.beginPath();
    ctx.arc(dotX, dotY, 7, 0, Math.PI * 2);
    ctx.fill();

    ctx.fillStyle = '#ff9500';
    ctx.beginPath();
    ctx.arc(dotX, dotY, 4, 0, Math.PI * 2);
    ctx.fill();

    if (readoutEl) {
      readoutEl.textContent = `In: ${currentInput.toFixed(2)} | Out: ${scaledOutput.toFixed(2)}`;
    }
  }

  function addEditorSlider(container, labelText, field, value, min, max, step) {
    const wrap = document.createElement('div');
    wrap.className = 'map-editor-slider-wrap';

    const labelRow = document.createElement('div');
    labelRow.className = 'map-editor-slider-label-row';

    const label = document.createElement('span');
    label.className = 'map-editor-slider-label';
    label.textContent = labelText;

    const valEl = document.createElement('span');
    valEl.className = 'map-editor-slider-value';
    valEl.textContent = value.toFixed(2);

    labelRow.appendChild(label);
    labelRow.appendChild(valEl);
    wrap.appendChild(labelRow);

    const input = document.createElement('input');
    input.type = 'range';
    input.min = String(min);
    input.max = String(max);
    input.step = String(step);
    input.value = String(value);
    input.className = 'map-editor-slider-input';

    input.addEventListener('input', () => {
      valEl.textContent = Number(input.value).toFixed(2);
      updateMobileTargetField(field, input.value, { refresh: false });
    });
    input.addEventListener('change', () => {
      updateMobileTargetField(field, input.value);
    });

    wrap.appendChild(input);
    container.appendChild(wrap);
  }

  function renderTargetEditor(container, target) {
    if (!target) return;

    const editor = document.createElement('div');
    editor.className = 'map-target-editor-rich';

    const selectRow = document.createElement('div');
    selectRow.className = 'map-editor-row-selects';
    addEditorSelect(selectRow, 'Mode', 'mode', target.mode || 'continuous', ['continuous', 'toggle', 'trigger_note']);
    addEditorSelect(selectRow, 'Curve', 'curve', target.curve || 'linear', ['linear', 'exponential', 'logarithmic', 's-curve']);
    editor.appendChild(selectRow);

    const canvasWrap = document.createElement('div');
    canvasWrap.className = 'map-curve-canvas-wrap';
    const canvas = document.createElement('canvas');
    canvas.width = 180;
    canvas.height = 180;
    canvas.className = 'map-curve-canvas';
    canvasWrap.appendChild(canvas);
    
    const readout = document.createElement('div');
    readout.className = 'map-curve-readout';
    readout.textContent = 'In: 0.00 | Out: 0.00';
    canvasWrap.appendChild(readout);
    editor.appendChild(canvasWrap);

    const slidersGrid = document.createElement('div');
    slidersGrid.className = 'map-editor-sliders-grid';

    addEditorSlider(slidersGrid, 'In Min', 'inMin', target.inMin ?? 0, 0, 1, 0.01);
    addEditorSlider(slidersGrid, 'In Max', 'inMax', target.inMax ?? 1, 0, 1, 0.01);
    addEditorSlider(slidersGrid, 'Out Min', 'outMin', target.outMin ?? 0, 0, 1, 0.01);
    addEditorSlider(slidersGrid, 'Out Max', 'outMax', target.outMax ?? 1, 0, 1, 0.01);
    addEditorSlider(slidersGrid, 'Idle Val', 'idleValue', target.idleValue ?? 0, 0, 1, 0.01);
    addEditorSlider(slidersGrid, 'Drive', 'drive', target.drive ?? 0, -1, 1, 0.01);
    addEditorSlider(slidersGrid, 'Comp', 'compressor', target.compressor ?? 0, -1, 1, 0.01);
    addEditorSlider(slidersGrid, 'Smooth', 'smooth', target.smooth ?? 0, 0, 1, 0.01);

    if ((target.mode || 'continuous') !== 'continuous') {
      addEditorSlider(slidersGrid, 'Threshold', 'threshold', target.threshold ?? 0.5, 0, 1, 0.01);
    }

    editor.appendChild(slidersGrid);

    if ((target.mode || 'continuous') === 'trigger_note') {
      const midiWrap = document.createElement('div');
      midiWrap.className = 'map-editor-midi-wrap';
      addMidiNoteEditor(midiWrap, target);
      editor.appendChild(midiWrap);
    }

    container.appendChild(editor);
    startCanvasAnimation(canvas, readout);
  }

  function addMidiNoteEditor(container, target) {
    const noteWrap = document.createElement('div');
    noteWrap.className = 'map-editor-field-midi-note';
    
    const label = document.createElement('span');
    label.className = 'map-editor-field-label';
    label.textContent = 'MIDI Note';
    noteWrap.appendChild(label);

    const selectRow = document.createElement('div');
    selectRow.className = 'map-midi-note-select-row';

    const currentNote = target.midiNote || 'C3';
    const match = currentNote.trim().toUpperCase().match(/^([A-G]#?)(-?\d+)$/);
    const currentPitch = match ? match[1] : 'C';
    const currentOctave = match ? match[2] : '3';

    const pitchSelect = document.createElement('select');
    pitchSelect.className = 'map-midi-pitch-select';
    const pitches = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
    for (const p of pitches) {
      const opt = document.createElement('option');
      opt.value = p;
      opt.textContent = p;
      opt.selected = p === currentPitch;
      pitchSelect.appendChild(opt);
    }
    selectRow.appendChild(pitchSelect);

    const octaveSelect = document.createElement('select');
    octaveSelect.className = 'map-midi-octave-select';
    const octaves = ['-2', '-1', '0', '1', '2', '3', '4', '5', '6', '7', '8'];
    for (const o of octaves) {
      const opt = document.createElement('option');
      opt.value = o;
      opt.textContent = o;
      opt.selected = o === currentOctave;
      octaveSelect.appendChild(opt);
    }
    selectRow.appendChild(octaveSelect);

    const updateNote = () => {
      const newNote = pitchSelect.value + octaveSelect.value;
      updateMobileTargetField('midiNote', newNote);
    };

    pitchSelect.addEventListener('change', updateNote);
    octaveSelect.addEventListener('change', updateNote);

    noteWrap.appendChild(selectRow);
    container.appendChild(noteWrap);

    addEditorNumber(container, 'Velocity', 'midiVelocity', target.midiVelocity ?? 100, 1, 127, 1);
  }

  function renderTargetPicker(container) {
    container.innerHTML = '';
    const head = document.createElement('div');
    head.className = 'map-picker-head';
    const back = document.createElement('button');
    back.type = 'button';
    back.className = 'map-mini-btn';
    back.textContent = 'Back';
    back.addEventListener('click', closePicker);
    head.appendChild(back);
    const title = document.createElement('strong');
    title.textContent = 'Pick Target';
    head.appendChild(title);
    container.appendChild(head);

    const statusRow = document.createElement('div');
    statusRow.className = 'map-detail-header-row';
    const statusEl = document.createElement('div');
    statusEl.className = 'map-detail-status';
    const originalStatus = $('map-mobile-status');
    statusEl.textContent = originalStatus ? originalStatus.textContent : 'Ready';
    statusEl.dataset.kind = originalStatus ? originalStatus.dataset.kind : '';
    statusRow.appendChild(statusEl);
    container.appendChild(statusRow);

    const searchWrap = document.createElement('div');
    searchWrap.className = 'map-picker-search-wrap';
    searchWrap.style.display = 'flex';
    searchWrap.style.gap = '6px';
    searchWrap.style.alignItems = 'center';

    const searchInput = document.createElement('input');
    searchInput.type = 'search';
    searchInput.placeholder = 'Filter targets...';
    searchInput.className = 'map-picker-search';
    searchInput.style.flex = '1';
    searchInput.value = state.pickerFilter || '';
    searchWrap.appendChild(searchInput);

    const btnUseSelected = document.createElement('button');
    btnUseSelected.type = 'button';
    btnUseSelected.className = 'map-mini-btn';
    btnUseSelected.textContent = 'Selected in Live';
    btnUseSelected.style.whiteSpace = 'nowrap';
    btnUseSelected.style.height = '28px';
    btnUseSelected.style.fontSize = '10px';
    btnUseSelected.style.padding = '0 6px';
    btnUseSelected.style.margin = '0';

    btnUseSelected.addEventListener('click', async () => {
      const res = await command('getTransportLiteState');
      if (res && res.ok !== false) {
        const trnState = res.result || res;
        if (trnState.connected && trnState.selectedTrackIndex !== undefined) {
          const trackIdx = trnState.selectedTrackIndex;
          const deviceIdx = trnState.selectedDeviceIndex;
          
          const track = state.allTargets.find(t => t.trackIndex === trackIdx);
          if (track) {
            const trackName = track.name || `Track ${trackIdx + 1}`;
            let filterText = trackName;
            
            if (deviceIdx !== undefined && track.devices) {
              const device = track.devices.find(d => d.index === deviceIdx);
              if (device) {
                filterText = `${trackName} > ${device.name}`;
              }
            }
            
            searchInput.value = filterText;
            state.pickerFilter = filterText;
            doRenderTree();
          } else {
            setStatus(`Track index ${trackIdx} not found in options`, 'error');
          }
        } else {
          setStatus('AbletonOSC is not connected or selection info unavailable', 'error');
        }
      } else {
        setStatus('Failed to fetch host selection state', 'error');
      }
    });

    searchWrap.appendChild(btnUseSelected);
    container.appendChild(searchWrap);

    const treeContainer = document.createElement('div');
    treeContainer.className = 'map-picker-tree';
    container.appendChild(treeContainer);

    const doRenderTree = () => {
      treeContainer.innerHTML = '';
      const filter = searchInput.value.trim().toLowerCase();

      // Group: Song / Main / Master
      const tempoTarget = { type: 'tempo', label: 'Song Tempo' };
      const showTempo = !filter || 'song tempo'.includes(filter) || 'tempo'.includes(filter);
      const mainTrackData = state.allTargets.find(t => t.trackKind === 'main');
      
      const songItems = [];
      if (showTempo) {
        songItems.push({ label: 'Tempo', target: tempoTarget });
      }
      if (mainTrackData) {
        for (const mixer of mainTrackData.mixer || []) {
          if (!filter || mixer.label.toLowerCase().includes(filter)) {
            songItems.push({ label: `Mixer > ${mixer.label}`, target: mixer });
          }
        }
        for (const device of mainTrackData.devices || []) {
          for (const param of device.params || []) {
            if (!filter || device.name.toLowerCase().includes(filter) || param.label.toLowerCase().includes(filter)) {
              songItems.push({ label: `${device.name} > ${param.label}`, target: param });
            }
          }
        }
      }

      if (songItems.length > 0) {
        const groupEl = document.createElement('div');
        groupEl.className = 'map-picker-group';
        const groupTitle = document.createElement('h4');
        groupTitle.textContent = 'Song / Main / Master';
        groupEl.appendChild(groupTitle);
        for (const item of songItems) {
          groupEl.appendChild(createPickerRow(item.label, item.target));
        }
        treeContainer.appendChild(groupEl);
      }

      // Normal Tracks
      const normalTracks = state.allTargets.filter(t => t.trackKind === 'track');
      renderTrackGroup('Tracks', normalTracks, filter, treeContainer);

      // Return Tracks
      const returnTracks = state.allTargets.filter(t => t.trackKind === 'return');
      renderTrackGroup('Return Tracks', returnTracks, filter, treeContainer);
    };

    searchInput.addEventListener('input', () => {
      state.pickerFilter = searchInput.value;
      doRenderTree();
    });

    doRenderTree();
  }

  function createPickerRow(labelText, target) {
    const row = document.createElement('button');
    row.type = 'button';
    row.className = 'map-picker-row';
    row.textContent = labelText;
    row.addEventListener('click', async () => {
      const success = await bindMobileTarget(target);
      if (success) {
        closePicker();
      }
    });
    return row;
  }

  function renderTrackGroup(groupTitleText, tracks, filter, parentContainer) {
    const trackBlocks = [];
    
    let filterTrack = null;
    let filterDevice = null;
    const cleanFilter = filter.trim().toLowerCase();
    if (cleanFilter.includes(' > ')) {
      const parts = cleanFilter.split(' > ');
      filterTrack = parts[0].trim();
      filterDevice = parts[1].trim();
    }
    
    const isFiltered = cleanFilter.length > 0;

    for (const track of tracks) {
      const trackName = track.name || `Track ${track.trackIndex + 1}`;
      const trackMatchedMixer = [];
      const trackMatchedDevices = [];

      for (const mixer of track.mixer || []) {
        let matches = false;
        if (filterTrack) {
          matches = trackName.toLowerCase() === filterTrack;
        } else {
          matches = !filter || mixer.label.toLowerCase().includes(cleanFilter) || trackName.toLowerCase().includes(cleanFilter);
        }
        if (matches) {
          trackMatchedMixer.push(mixer);
        }
      }

      for (const device of track.devices || []) {
        const matchedParams = [];
        for (const param of device.params || []) {
          let matches = false;
          if (filterTrack && filterDevice) {
            matches = trackName.toLowerCase() === filterTrack && device.name.toLowerCase() === filterDevice;
          } else if (filterTrack) {
            matches = trackName.toLowerCase() === filterTrack;
          } else {
            matches = !filter || param.label.toLowerCase().includes(cleanFilter) || device.name.toLowerCase().includes(cleanFilter) || trackName.toLowerCase().includes(cleanFilter);
          }
          if (matches) {
            matchedParams.push(param);
          }
        }
        if (matchedParams.length > 0 || (!filter && device.params?.length === 0)) {
          trackMatchedDevices.push({ name: device.name, params: matchedParams });
        }
      }

      if (trackMatchedMixer.length > 0 || trackMatchedDevices.length > 0) {
        const trackBlock = document.createElement('div');
        trackBlock.className = 'map-picker-track-block';
        
        const trackHeader = document.createElement('div');
        trackHeader.className = 'map-picker-track-header';
        trackHeader.style.cursor = 'pointer';
        
        const trackContent = document.createElement('div');
        trackContent.className = 'map-picker-track-content';
        
        const trackExpanded = isFiltered;
        trackContent.classList.toggle('hidden', !trackExpanded);
        
        const trackIndicator = document.createElement('span');
        trackIndicator.className = 'map-picker-indicator';
        trackIndicator.textContent = trackExpanded ? '▼ ' : '▶ ';
        trackHeader.appendChild(trackIndicator);
        
        const trackTitleSpan = document.createElement('span');
        trackTitleSpan.textContent = trackName;
        trackHeader.appendChild(trackTitleSpan);
        
        trackHeader.addEventListener('click', () => {
          const isHidden = trackContent.classList.contains('hidden');
          trackContent.classList.toggle('hidden', !isHidden);
          trackIndicator.textContent = isHidden ? '▼ ' : '▶ ';
        });
        
        trackBlock.appendChild(trackHeader);

        if (trackMatchedMixer.length > 0) {
          const mixerSection = document.createElement('div');
          mixerSection.className = 'map-picker-track-section';
          for (const mixer of trackMatchedMixer) {
            mixerSection.appendChild(createPickerRow(`Mixer > ${mixer.label}`, mixer));
          }
          trackContent.appendChild(mixerSection);
        }

        if (trackMatchedDevices.length > 0) {
          for (const dev of trackMatchedDevices) {
            const devBlock = document.createElement('div');
            devBlock.className = 'map-picker-device-block';
            
            const devHeader = document.createElement('div');
            devHeader.className = 'map-picker-device-header';
            devHeader.style.cursor = 'pointer';
            
            const devContent = document.createElement('div');
            devContent.className = 'map-picker-device-content';
            
            const devExpanded = isFiltered;
            devContent.classList.toggle('hidden', !devExpanded);
            
            const devIndicator = document.createElement('span');
            devIndicator.className = 'map-picker-indicator';
            devIndicator.textContent = devExpanded ? '▼ ' : '▶ ';
            devHeader.appendChild(devIndicator);
            
            const devTitleSpan = document.createElement('span');
            devTitleSpan.textContent = dev.name;
            devHeader.appendChild(devTitleSpan);
            
            devHeader.addEventListener('click', (e) => {
              e.stopPropagation();
              const isHidden = devContent.classList.contains('hidden');
              devContent.classList.toggle('hidden', !isHidden);
              devIndicator.textContent = isHidden ? '▼ ' : '▶ ';
            });
            
            devBlock.appendChild(devHeader);

            const paramsSection = document.createElement('div');
            paramsSection.className = 'map-picker-device-section';
            for (const param of dev.params) {
              paramsSection.appendChild(createPickerRow(param.label, param));
            }
            devContent.appendChild(paramsSection);
            devBlock.appendChild(devContent);
            trackContent.appendChild(devBlock);
          }
        }
        trackBlock.appendChild(trackContent);
        trackBlocks.push(trackBlock);
      }
    }

    if (trackBlocks.length > 0) {
      const groupEl = document.createElement('div');
      groupEl.className = 'map-picker-group';
      const title = document.createElement('h4');
      title.textContent = groupTitleText;
      groupEl.appendChild(title);
      for (const block of trackBlocks) {
        groupEl.appendChild(block);
      }
      parentContainer.appendChild(groupEl);
    }
  }

  window.mobileMappingState = state;
  window.openMobileMappingMode = openMappingMode;
  window.closeMobileMappingMode = closeMappingMode;
  window.loadMobileMappingData = loadMobileMappingData;

  function init() {
    const btn = $('btn-map-mode');
    const back = $('btn-map-back');
    const refresh = $('btn-map-refresh');
    if (btn) btn.addEventListener('click', () => state.open ? closeMappingMode() : openMappingMode());
    if (back) {
      back.addEventListener('click', () => {
        if (state.selectedControl) {
          state.selectedControl = null;
          renderAll();
        } else {
          closeMappingMode();
        }
      });
    }
    if (refresh) refresh.addEventListener('click', loadMobileMappingData);

    const search = $('map-mobile-search');
    if (search) search.addEventListener('input', renderControls);

    // Event interception for mapping selection
    const handleIntercept = (e) => {
      if (!state.open) return;
      if (e.target.closest('#mapping-mode')) return;
      if (e.target.closest('.tabs')) return;

      const target = e.target.closest('[data-name]');
      if (target) {
        e.preventDefault();
        e.stopPropagation();

        let controlName = target.getAttribute('data-name');
        if (controlName) {
          if (controlName === 'xy-1' || controlName === 'xy-2') {
            controlName = controlName + '.x';
          }
          state.selectedControl = controlName;
          state.selectedTargetIndex = 0;
          renderAll();
        }
      }
    };

    window.addEventListener('touchstart', handleIntercept, { capture: true, passive: false });
    window.addEventListener('mousedown', handleIntercept, { capture: true });
    window.addEventListener('click', handleIntercept, { capture: true });

    window.addEventListener('ableton-rc:phone-ws-open', () => {
      if (state.open) loadMobileMappingData();
    });
    window.addEventListener('ableton-rc:phone-client-id', (event) => {
      state.selectedClient = event.detail && event.detail.clientId ? event.detail.clientId : state.selectedClient;
    });
    window.addEventListener('ableton-rc:phone-ws-close', () => {
      if (state.open) setStatus('Disconnected', 'error');
    });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
