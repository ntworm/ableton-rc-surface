// Copyright © 2026 Gabriel Worm
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Source: https://github.com/ntworm/ableton-rc-surface
//
// This file is part of Ableton RC Surface, distributed under the
// PolyForm Noncommercial License 1.0.0. You may obtain a copy of
// the License at https://polyformproject.org/licenses/noncommercial/1.0.0
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';

const root = import.meta.dirname;

class FakeElement {
  constructor(id = '') {
    this.id = id;
    this.children = [];
    this.className = '';
    this.dataset = {};
    this._textContent = '';
    this.value = '';
    this.style = {};
    this.listeners = new Map();
    this.classList = {
      add: (name) => { this.className = `${this.className} ${name}`.trim(); },
      remove: (name) => { this.className = this.className.split(/\s+/).filter((x) => x !== name).join(' '); },
      contains: (name) => this.className.split(/\s+/).includes(name),
      toggle: (name, force) => {
        const active = force === undefined ? !this.classList.contains(name) : !!force;
        if (active) this.classList.add(name);
        else this.classList.remove(name);
      },
    };
  }
  get textContent() {
    if (this._textContent) return this._textContent;
    return this.children.map((c) => c.textContent).join(' ');
  }
  set textContent(val) {
    this._textContent = val;
    this.children = [];
  }
  get innerHTML() { return ''; }
  set innerHTML(val) {
    if (val === '') {
      this.children = [];
      this._textContent = '';
    }
  }
  appendChild(child) { this.children.push(child); return child; }
  addEventListener(name, fn) { this.listeners.set(name, fn); }
  setAttribute(name, value) { this[name] = value; }
  getAttribute(name) { return this[name] || null; }
  querySelectorAll() { return []; }
  closest(selector) {
    if (selector === '.map-pane-right') {
      if (!this._closestPaneRight) {
        this._closestPaneRight = new FakeElement();
        this._closestPaneRight.className = 'map-pane-right';
      }
      return this._closestPaneRight;
    }
    return null;
  }
}

function loadMappingMode(overrides = {}) {
  const ids = [
    'btn-map-mode', 'btn-map-back', 'btn-map-refresh', 'mapping-mode',
    'map-mobile-status', 'map-mobile-presets', 'map-mobile-search',
    'map-mobile-controls', 'map-mobile-detail',
  ];
  const elements = new Map(ids.map((id) => [id, new FakeElement(id)]));
  const body = new FakeElement('body');
  body.dataset.page = 'performance';
  const document = {
    readyState: 'complete',
    body,
    getElementById: (id) => elements.get(id) || null,
    createElement: (tag) => new FakeElement(tag),
    addEventListener() {},
    querySelector: (selector) => {
      const match = selector.match(/\.page\[data-page="([^"]+)"\]/);
      if (match) {
        const page = new FakeElement();
        page.className = 'page';
        page.dataset.page = match[1];
        return page;
      }
      return null;
    },
    querySelectorAll() { return []; }
  };
  const calls = [];
  const eventListeners = new Map();
  let mockMappings = { 'pad-1': [{ type: 'tempo' }] };
  function defaultSendPhoneCommand(cmd, args, cb) {
    calls.push({ cmd, args });
    if (cmd === 'setMapping') {
      mockMappings[args.control] = args.targets;
      cb({ ok: true });
      return true;
    }
    if (cmd === 'removeMapping') {
      delete mockMappings[args.control];
      cb({ ok: true });
      return true;
    }
    const fixtures = {
      getTargets: { ok: true, result: { targets: [{ type: 'tempo' }] } },
      getMappings: { ok: true, result: { mappings: mockMappings } },
      getClients: { ok: true, result: { clients: [{ client_id: 'phone-1', status: 'active' }] } },
      listPresets: { ok: true, result: { presets: ['Default', 'Gig'], current: 'Gig' } },
      getProjectConfigStatus: { ok: true, result: { report: { loaded: 1, relinked: 0, review: 0, ambiguous: 0, missing: 0 }, clientState: {} } },
      addUdpReceiverToTrack: { ok: true, result: { success: true } },
    };
    cb(fixtures[cmd] || { ok: true });
    return true;
  }
  const context = vm.createContext({
    window: {
      throttlePhoneTelemetry() {},
      setPhoneMappingModeActive() {},
      showPhonePage(page) { document.body.dataset.page = page; },
      addEventListener(name, fn) {
        if (!eventListeners.has(name)) eventListeners.set(name, []);
        eventListeners.get(name).push(fn);
      },
      dispatchEvent() {},
      sendPhoneCommand: defaultSendPhoneCommand,
      // Overrides last so callers can replace any default (including sendPhoneCommand)
      ...overrides,
    },
    document,
    CustomEvent: class CustomEvent { constructor(name, init) { this.type = name; this.detail = init?.detail; } },
    console,
  });
  context.window.window = context.window;
  context.window.document = document;
  vm.runInContext(fs.readFileSync(path.join(root, 'mapping-mode.js'), 'utf8'), context);
  return { context, document, calls, elements, eventListeners };
}

test('mobile mapping mode loads targets, mappings, clients, and presets on open', async () => {
  const { context, calls, elements } = loadMappingMode();

  await context.window.openMobileMappingMode();

  assert.deepEqual(calls.map((c) => c.cmd), ['getTargets', 'getMappings', 'getClients', 'listPresets', 'getProjectConfigStatus']);
  assert.equal(context.window.mobileMappingState.currentMappings['pad-1'][0].type, 'tempo');
  assert.equal(context.window.mobileMappingState.currentPreset, 'Gig');
  assert.equal(elements.get('map-mobile-status').textContent, 'Loaded 1; relinked 0; review 0; missing 0');
});

test('control browser renders grouped controls and selecting one renders mapped targets', async () => {
  const { context, elements } = loadMappingMode();

  await context.window.openMobileMappingMode();
  const controls = elements.get('map-mobile-controls');
  assert.ok(controls.children.length > 0, 'expected grouped controls to render');

  const padRow = controls.children.flatMap((group) => group.children || []).find((child) => child.dataset.control === 'pad-1');
  assert.ok(padRow, 'pad-1 row must exist');
  padRow.listeners.get('click')();

  assert.equal(context.window.mobileMappingState.selectedControl, 'pad-1');
  assert.match(elements.get('map-mobile-detail').textContent, /Pad 1/);
  assert.match(elements.get('map-mobile-detail').textContent, /Song Tempo/);
});

test('removing the final target sends removeMapping', async () => {
  const { context, calls } = loadMappingMode();
  await context.window.openMobileMappingMode();
  context.window.mobileMappingState.selectedControl = 'pad-1';

  await context.window.removeMobileMappingTarget(0);

  const last = calls.at(-1);
  assert.equal(last.cmd, 'removeMapping');
  assert.equal(last.args.control, 'pad-1');
});

test('conflict replace removes the old owner before setting the new control', async () => {
  const { context, calls } = loadMappingMode();
  // Wait to let openMappingMode fetch initially
  await context.window.openMobileMappingMode();
  context.window.mobileMappingState.currentMappings = {
    'pad-1': [],
    'knob-1': [{ type: 'tempo' }],
  };
  context.window.mobileMappingState.selectedControl = 'pad-1';

  await context.window.replaceMobileMappingConflict('knob-1', { type: 'tempo' });

  const cmds = calls.slice(-2).map((c) => c.cmd);
  assert.deepEqual(cmds, ['removeMapping', 'setMapping']);
});

test('conflict banner uses friendly owner label and replace refreshes detail', async () => {
  const { context, elements } = loadMappingMode({ getPhoneClientId: () => 'phone-1' });
  await context.window.openMobileMappingMode();
  context.window.mobileMappingState.currentMappings = {
    'phone-1::pad-1': [],
    'phone-1::toggle-1': [{ type: 'tempo' }],
  };
  context.window.mobileMappingState.selectedControl = 'pad-1';

  await context.window.bindMobileTarget({ type: 'tempo' });

  const detail = elements.get('map-mobile-detail');
  const banner = detail.children.find((child) => child.className === 'map-conflict');
  assert.ok(banner, 'conflict banner should render');
  assert.match(banner.textContent, /Already mapped to LFO 1/);
  assert.doesNotMatch(banner.textContent, /phone-1::toggle-1|toggle-1/);

  const replace = banner.children.find((child) => child.textContent === 'Replace');
  assert.ok(replace, 'replace button should render');
  await replace.listeners.get('click')();

  assert.equal(context.window.mobileMappingState.pendingConflict, null);
  assert.equal(context.window.mobileMappingState.currentMappings['phone-1::toggle-1'], undefined);
  assert.equal(context.window.mobileMappingState.currentMappings['phone-1::pad-1'], undefined);
  assert.equal(context.window.mobileMappingState.currentMappings['pad-1'][0].type, 'tempo');
  assert.doesNotMatch(detail.textContent, /Already mapped/);
  assert.match(detail.textContent, /Song Tempo/);
});

test('binding a picked target sends setMapping with existing targets preserved', async () => {
  const { context, calls } = loadMappingMode();
  await context.window.openMobileMappingMode();
  context.window.mobileMappingState.selectedControl = 'pad-1';

  await context.window.bindMobileTarget({ type: 'mixer_volume', trackIndex: 0, label: 'Volume' });

  const setMappingCall = calls.find((c) => c.cmd === 'setMapping');
  assert.ok(setMappingCall, 'should have sent setMapping command');
  assert.equal(setMappingCall.args.control, 'pad-1');
  assert.equal(setMappingCall.args.targets.length, 2);
  assert.equal(setMappingCall.args.targets[1].type, 'mixer_volume');
  assert.equal(setMappingCall.args.targets[1].neutralPolicy, 'release');
});

test('editing target fields saves complete mapping payload', async () => {
  const { context, calls } = loadMappingMode();
  await context.window.openMobileMappingMode();
  context.window.mobileMappingState.selectedControl = 'pad-1';
  context.window.mobileMappingState.selectedTargetIndex = 0;

  await context.window.updateMobileTargetField('mode', 'toggle');
  await context.window.updateMobileTargetField('threshold', 0.42);
  await context.window.updateMobileTargetField('smooth', 0.25);
  await context.window.updateMobileTargetField('curve', 's-curve');
  await context.window.updateMobileTargetField('outMin', 0.2);
  await context.window.updateMobileTargetField('outMax', 0.8);

  const last = calls.filter((c) => c.cmd === 'setMapping').at(-1);
  const target = last.args.targets[0];
  assert.equal(target.mode, 'toggle');
  assert.equal(target.threshold, 0.42);
  assert.equal(target.smooth, 0.25);
  assert.equal(target.curve, 's-curve');
  assert.equal(target.outMin, 0.2);
  assert.equal(target.outMax, 0.8);
});

test('valid MIDI note edits persist without refresh', async () => {
  const { context, calls } = loadMappingMode();
  context.window.mobileMappingState.selectedControl = 'pad-1';
  context.window.mobileMappingState.currentMappings = {
    'pad-1': [{ type: 'device_param', trackIndex: 0, mode: 'trigger_note', midiNote: 'C3', midiVelocity: 100 }],
  };

  await context.window.updateMobileTargetField('midiNote', 'C7', { refresh: false });

  const last = calls.filter((c) => c.cmd === 'setMapping').at(-1);
  assert.equal(last.args.targets[0].midiNote, 'C7');
});

test('preset actions call backend preset commands', async () => {
  const { context, calls } = loadMappingMode();
  await context.window.openMobileMappingMode();

  await context.window.saveMobileMappingPreset('Set_A');
  await context.window.loadMobileMappingPreset('Gig');
  await context.window.deleteMobileMappingPreset('Gig');

  const cmds = calls.filter((c) => ['savePreset', 'loadPreset', 'deletePreset'].includes(c.cmd)).map((c) => c.cmd);
  assert.deepEqual(cmds, ['savePreset', 'loadPreset', 'deletePreset']);
  const saveCall = calls.find((c) => c.cmd === 'savePreset');
  assert.equal(saveCall.args.name, 'Set_A');
});

test('trigger note installs receiver before saving trigger target', async () => {
  const { context, calls } = loadMappingMode();
  context.window.mobileMappingState.selectedControl = 'pad-1';

  await context.window.createMobileTriggerNoteTarget({ trackIndex: 4, name: 'MIDI Track', isMidi: true });

  const addReceiverCall = calls.find((c) => c.cmd === 'addUdpReceiverToTrack');
  assert.ok(addReceiverCall, 'should have sent addUdpReceiverToTrack command');
  assert.equal(addReceiverCall.args.trackIndex, 4);

  const setMappingCall = calls.filter((c) => c.cmd === 'setMapping').at(-1);
  assert.ok(setMappingCall, 'should have sent setMapping command');
  assert.equal(setMappingCall.args.targets.at(-1).mode, 'trigger_note');
  assert.equal(setMappingCall.args.targets.at(-1).midiNote, 'C3');
});

test('phone mappings are saved globally and legacy client-scoped keys are removed', async () => {
  const { context, calls } = loadMappingMode({ getPhoneClientId: () => 'phone-1' });
  await context.window.openMobileMappingMode();
  context.window.mobileMappingState.selectedControl = 'pad-1';

  // Bind a new target – should use phone-1::pad-1 as the setMapping key
  context.window.mobileMappingState.currentMappings['phone-1::pad-1'] = [{ type: 'mixer_volume', trackIndex: 0 }];
  delete context.window.mobileMappingState.currentMappings['pad-1'];
  await context.window.updateMobileTargetField('takeoverMode', 'pickup');

  const setCall = calls.find((c) => c.cmd === 'setMapping');
  assert.ok(setCall, 'global mapping should have been saved');
  assert.equal(setCall.args.control, 'pad-1');
  assert.equal(setCall.args.targets[0].takeoverMode, 'pickup');

  // Remove the final target – should use phone-1::pad-1 as the removeMapping key
  const removeCall = calls.find((c) => c.cmd === 'removeMapping' && c.args.control === 'phone-1::pad-1');
  assert.ok(removeCall, 'legacy client mapping should have been removed');
  assert.equal(removeCall.args.control, 'phone-1::pad-1');
});

test('removing a legacy phone mapping deletes its client-scoped key', async () => {
  const { context, calls } = loadMappingMode({ getPhoneClientId: () => 'phone-1' });
  await context.window.openMobileMappingMode();
  context.window.mobileMappingState.selectedControl = 'knob-1';
  context.window.mobileMappingState.currentMappings = {
    'phone-1::knob-1': [{ type: 'tempo' }],
  };

  await context.window.removeMobileMappingTarget(0);

  assert.ok(calls.some((call) => call.cmd === 'removeMapping' && call.args.control === 'phone-1::knob-1'));
  assert.equal(context.window.mobileMappingState.currentMappings['phone-1::knob-1'], undefined);
});

test('btn-map-refresh triggers a full data reload', async () => {
  const { context, calls, elements } = loadMappingMode();
  await context.window.openMobileMappingMode();
  const beforeCount = calls.length;

  // Fire the registered click listener directly (FakeElement.listeners is a Map of name -> fn)
  const refreshBtn = elements.get('btn-map-refresh');
  const handler = refreshBtn.listeners.get('click');
  assert.ok(handler, 'refresh button should have a click listener');
  await handler();

  assert.ok(
    calls.slice(beforeCount).some((c) => c.cmd === 'getMappings'),
    'refresh click should trigger getMappings',
  );
});

test('trigger note install failure keeps picker open and does not send setMapping', async () => {
  const { context, calls, elements } = loadMappingMode({
    sendPhoneCommand(cmd, args, cb) {
      calls.push({ cmd, args });
      if (cmd === 'addUdpReceiverToTrack') {
        cb({ ok: false, error: 'No device slot' });
        return true;
      }
      cb({ ok: true });
      return true;
    },
  });
  context.window.mobileMappingState.selectedControl = 'pad-1';

  const result = await context.window.createMobileTriggerNoteTarget({ trackIndex: 2, name: 'MIDI Track', isMidi: true });

  assert.strictEqual(result, false, 'should return false on install failure');
  assert.ok(!calls.some((c) => c.cmd === 'setMapping'), 'setMapping must NOT be called after a failed install');
  assert.equal(elements.get('map-mobile-status').textContent, 'Não consegui inserir automaticamente. Coloque manualmente RC-Midi-Receiver.amxd nesta track e tente novamente.');
});

test('trigger_note does not conflict with device_param on track 0 / device 0 / param 0', async () => {
  const { context } = loadMappingMode();
  await context.window.openMobileMappingMode();

  // Existing device_param mapping on track 0, device 0, param 0
  context.window.mobileMappingState.currentMappings['pad-1'] = [
    { type: 'device_param', trackIndex: 0, deviceIndex: 0, paramIndex: 0 },
  ];
  // Select pad-2 and try to bind a trigger_note on the same track (track 0)
  context.window.mobileMappingState.selectedControl = 'pad-2';

  const conflict = context.window.mobileMappingState;
  // bindMobileTarget detects conflicts before saving; we test isSameTarget indirectly via findConflict
  // by reading pendingConflict after a bind attempt
  const triggerTarget = { type: 'device_param', mode: 'trigger_note', trackIndex: 0, midiNote: 'C3', label: 'MIDI C3' };
  await context.window.bindMobileTarget(triggerTarget);

  assert.equal(
    context.window.mobileMappingState.pendingConflict,
    null,
    'trigger_note should NOT conflict with a regular device_param on the same slot',
  );
});

test('pad-1 and pad-2 trigger_note on same MIDI track with different notes do not conflict', async () => {
  const { context } = loadMappingMode();
  await context.window.openMobileMappingMode();

  // pad-1 already has C3 on track 0
  context.window.mobileMappingState.currentMappings['pad-1'] = [
    { type: 'device_param', mode: 'trigger_note', trackIndex: 0, midiNote: 'C3' },
  ];
  // pad-2 wants D3 on track 0 — different note, must not conflict
  context.window.mobileMappingState.selectedControl = 'pad-2';
  const d3Target = { type: 'device_param', mode: 'trigger_note', trackIndex: 0, midiNote: 'D3', label: 'MIDI D3' };
  await context.window.bindMobileTarget(d3Target);

  assert.equal(
    context.window.mobileMappingState.pendingConflict,
    null,
    'D3 on pad-2 should not conflict with C3 on pad-1 (different notes)',
  );
});

test('findConflict treats a legacy selectedClient key as the current control owner', async () => {
  const { context } = loadMappingMode({ getPhoneClientId: () => 'phone-1' });
  await context.window.openMobileMappingMode();
  context.window.mobileMappingState.selectedControl = 'pad-1';
  // Simulate: the mapping already exists under the scoped key from a previous save
  context.window.mobileMappingState.currentMappings['phone-1::pad-1'] = [
    { type: 'mixer_volume', trackIndex: 2 },
  ];

  // Binding the same target again must NOT open a conflict dialog
  await context.window.bindMobileTarget({ type: 'mixer_volume', trackIndex: 2, label: 'Volume' });

  assert.equal(
    context.window.mobileMappingState.pendingConflict,
    null,
    'rebinding own scoped key must not produce a false conflict',
  );
});

test('MAP mode selects real control via data-name', async () => {
  const { context, eventListeners } = loadMappingMode();
  await context.window.openMobileMappingMode();

  const target = new FakeElement('div');
  target.setAttribute('data-name', 'knob-2');
  target.closest = (sel) => {
    if (sel === '[data-name]') return target;
    if (sel === '#mapping-mode') return null;
    if (sel === '.tabs') return null;
    return null;
  };

  const event = {
    target,
    preventDefault() {},
    stopPropagation() {},
  };

  const listeners = eventListeners.get('click') || [];
  assert.ok(listeners.length > 0, 'should have registered window click listener');
  for (const fn of listeners) {
    fn(event);
  }

  assert.equal(context.window.mobileMappingState.selectedControl, 'knob-2');
});

test('picker Bind to renders Track > Device > Parameter hierarchy instead of flat list', async () => {
  const richTargets = [
    { id: 'tempo', type: 'tempo', label: 'Song Tempo' },
    {
      trackIndex: 0,
      trackKind: 'track',
      name: 'Track 1: Bass',
      isMidi: true,
      mixer: [{ type: 'mixer_volume', trackIndex: 0, trackKind: 'track', label: 'Volume' }],
      devices: [{
        index: 0,
        name: 'Auto Filter',
        params: [{ type: 'device_param', trackIndex: 0, trackKind: 'track', deviceIndex: 0, paramIndex: 0, label: 'Freq' }]
      }]
    },
    {
      trackIndex: 0,
      trackKind: 'return',
      name: 'Return A: Delay',
      isMidi: false,
      mixer: [{ type: 'mixer_volume', trackIndex: 0, trackKind: 'return', label: 'Volume' }],
      devices: []
    }
  ];

  const { context, elements } = loadMappingMode({
    sendPhoneCommand(cmd, args, cb) {
      if (cmd === 'getTargets') {
        cb({ ok: true, result: { targets: richTargets } });
        return true;
      }
      const fixtures = {
        getMappings: { ok: true, result: { mappings: {} } },
        getClients: { ok: true, result: { clients: [] } },
        listPresets: { ok: true, result: { presets: ['Default'], current: 'Default' } },
      };
      cb(fixtures[cmd] || { ok: true });
      return true;
    }
  });

  await context.window.openMobileMappingMode();
  
  // Click pad-1 to select it
  const controls = elements.get('map-mobile-controls');
  const padRow = controls.children.flatMap((group) => group.children || []).find((child) => child.dataset.control === 'pad-1');
  assert.ok(padRow, 'pad-1 row must exist');
  padRow.listeners.get('click')();

  // Find and click the Bind button
  const detailEl = elements.get('map-mobile-detail');
  const actions = detailEl.children.find(c => c.className === 'map-detail-actions');
  assert.ok(actions, 'actions wrapper should exist');
  const bindBtn = actions.children.find(c => c.textContent === 'Bind');
  assert.ok(bindBtn, 'Bind button should exist');
  bindBtn.listeners.get('click')();

  const tree = detailEl.children.find(c => c.className === 'map-picker-tree');
  assert.ok(tree, 'should render map-picker-tree');

  const groups = tree.children.filter(c => c.className === 'map-picker-group');
  assert.ok(groups.length >= 2, 'should render picker groups');

  const trackBlock = groups.flatMap(g => g.children).find(c => c.className === 'map-picker-track-block');
  assert.ok(trackBlock, 'should render track block');

  const trackHeader = trackBlock.children.find(c => c.className.includes('map-picker-track-header'));
  assert.ok(trackHeader.textContent.includes('Track 1: Bass'), 'track header should include track name');

  const trackContent = trackBlock.children.find(c => c.className.includes('map-picker-track-content'));
  assert.ok(trackContent, 'should render track content wrapper');

  const deviceBlock = trackContent.children.find(c => c.className.includes('map-picker-device-block'));
  assert.ok(deviceBlock, 'should render device block');

  const devHeader = deviceBlock.children.find(c => c.className.includes('map-picker-device-header'));
  assert.ok(devHeader.textContent.includes('Auto Filter'), 'device header should include device name');
});

test('binding a duplicate mapping target sets status to error and does not add targets', async () => {
  const { context, elements } = loadMappingMode();
  await context.window.openMobileMappingMode();
  context.window.mobileMappingState.selectedControl = 'pad-1';
  
  // Set current mappings to have a tempo mapping already
  context.window.mobileMappingState.currentMappings = {
    'pad-1': [{ type: 'tempo' }]
  };

  await context.window.bindMobileTarget({ type: 'tempo' });

  assert.equal(elements.get('map-mobile-status').textContent, 'Este parâmetro já está mapeado para este controle.');
  assert.equal(elements.get('map-mobile-status').dataset.kind, 'error');
});

test('binding a device_param target', async () => {
  const { context, calls } = loadMappingMode();
  await context.window.openMobileMappingMode();
  context.window.mobileMappingState.selectedControl = 'pad-1';

  await context.window.bindMobileTarget({
    type: 'device_param',
    trackIndex: 0,
    trackKind: 'track',
    deviceIndex: 0,
    paramIndex: 0,
    label: 'Pitch'
  });

  const setMappingCall = calls.find((c) => c.cmd === 'setMapping');
  assert.ok(setMappingCall, 'should call setMapping');
  assert.equal(setMappingCall.args.targets.length, 2);
  const target = setMappingCall.args.targets[1];
  assert.equal(target.type, 'device_param');
  assert.equal(target.trackIndex, 0);
  assert.equal(target.trackKind, 'track');
  assert.equal(target.deviceIndex, 0);
  assert.equal(target.paramIndex, 0);
  assert.equal(target.curve, 'linear');
});

// ── Root cause R3 ───────────────────────────────────────────────────────────
// "Could not load mapping data" collapses five independent commands into one
// opaque string. In the field this hid the real cause (an expired session /
// dead port), so the panel could not tell the user what to do.

test('mapping load names the failing command and preserves its real error', async () => {
  const { context, elements } = loadMappingMode({
    sendPhoneCommand(cmd, args, cb) {
      if (cmd === 'getTargets') {
        cb({ ok: false, error: 'extension context not ready' });
        return true;
      }
      cb({ ok: true, result: { targets: [], mappings: {}, clients: [], presets: [], current: 'Default' } });
      return true;
    },
  });

  await context.window.openMobileMappingMode();

  const status = elements.get('map-mobile-status').textContent;
  assert.match(status, /getTargets/, `status must name the failing command, got: ${status}`);
  assert.match(status, /extension context not ready/, `status must keep the server error, got: ${status}`);
  assert.match(context.window.mobileMappingState.error, /getTargets/);
});

test('mapping load reports every failing command, not only the first', async () => {
  const { context, elements } = loadMappingMode({
    sendPhoneCommand(cmd, args, cb) {
      if (cmd === 'getTargets' || cmd === 'listPresets') {
        cb({ ok: false, error: 'Not connected to server' });
        return true;
      }
      cb({ ok: true, result: { mappings: {}, clients: [] } });
      return true;
    },
  });

  await context.window.openMobileMappingMode();

  const status = elements.get('map-mobile-status').textContent;
  assert.match(status, /getTargets/, `got: ${status}`);
  assert.match(status, /listPresets/, `got: ${status}`);
});

test('mapping panel explains a dropped connection instead of the bare word Disconnected', async () => {
  const { context, elements, eventListeners } = loadMappingMode();
  await context.window.openMobileMappingMode();

  for (const fn of eventListeners.get('ableton-rc:phone-ws-close') || []) fn({});

  const status = elements.get('map-mobile-status').textContent;
  assert.doesNotMatch(
    status,
    /^Disconnected$/,
    'a bare "Disconnected" gives the user nothing to act on',
  );
  assert.match(status, /reconnect/i, `got: ${status}`);
});

test('mapping panel reloads its data when the socket comes back', async () => {
  const { context, calls, eventListeners } = loadMappingMode();
  await context.window.openMobileMappingMode();
  const before = calls.length;

  for (const fn of eventListeners.get('ableton-rc:phone-ws-open') || []) fn({});
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.ok(calls.length > before, 'reopening the socket must refresh mapping data');
});

// The phone MAP panel could only clear one control or one category. Wiping a
// whole set meant tapping through every group, so a global clear was missing.
test('mapping panel exposes a global clear that wipes every mapping at once', async () => {
  const { context, calls } = loadMappingMode({ confirm: () => true });
  await context.window.openMobileMappingMode();

  assert.equal(
    typeof context.window.clearAllMobileMappings,
    'function',
    'the phone MAP panel must offer a global clear',
  );

  const before = calls.length;
  await context.window.clearAllMobileMappings();

  const issued = calls.slice(before).map((c) => c.cmd);
  assert.ok(issued.includes('clearMappings'), `expected clearMappings, got ${issued.join(', ')}`);
  assert.equal(
    issued.filter((c) => c === 'clearMappings').length,
    1,
    'a global clear must issue exactly one clearMappings command',
  );
  // Compare keys, not the object: it is built inside the vm realm, so its
  // prototype differs from this realm's and deepStrictEqual would reject it.
  assert.deepEqual(
    Object.keys(context.window.mobileMappingState.currentMappings),
    [],
    'local mapping state must be emptied too',
  );
});

test('global clear is abandoned when the user cancels the confirmation', async () => {
  const { context, calls } = loadMappingMode({ confirm: () => false });
  await context.window.openMobileMappingMode();

  const before = calls.length;
  await context.window.clearAllMobileMappings();

  const issued = calls.slice(before).map((c) => c.cmd);
  assert.equal(
    issued.includes('clearMappings'),
    false,
    'cancelling must not wipe anything',
  );
});

test('the MAP presets row renders a Clear All button', async () => {
  const { context, elements } = loadMappingMode({ confirm: () => true });
  await context.window.openMobileMappingMode();

  const presets = elements.get('map-mobile-presets');
  const labels = presets.children.map((c) => c.textContent);
  assert.ok(
    labels.some((l) => /clear all/i.test(l || '')),
    `expected a Clear All button, got: ${labels.join(' | ')}`,
  );
});
