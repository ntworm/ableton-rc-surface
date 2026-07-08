import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const root = import.meta.dirname;
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');

function cssBlock(css, selector) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = css.match(new RegExp(`${escaped}\\s*\\{([^}]*)\\}`, 'm'));
  return match ? match[1] : '';
}

test('phone navigation keeps performance pages and removes ADV from the tab bar', () => {
  const html = read('index.html');

  assert.match(html, /data-page="performance"/);
  assert.match(html, /data-page="mixer"/);
  assert.match(html, /data-page="snapshots"/);
  assert.match(html, /data-page="sensors"/);
  assert.match(html, /data-page="media"/);
  assert.doesNotMatch(html, /class="tab"[^>]*data-page="advanced"/);
});

test('phone header exposes stage mode and MIX no longer exposes performance/debug mode', () => {
  const html = read('index.html');
  const app = read('app.js');

  assert.match(html, /id="btn-stage-mode"/);
  assert.doesNotMatch(html, /id="btn-mixer-mode"/);
  assert.doesNotMatch(app, /setupMixerMode/);
  assert.doesNotMatch(app, /ableton-rc:mixer-mode/);
});

test('performance UTIL column exposes snapshot and off controls', () => {
  const html = read('index.html');
  const css = read('style.css');
  const token = (...codes) => String.fromCharCode(...codes);
  const removedPerfControls = [
    token(114, 105, 98, 98, 111, 110, 45, 49),
    token(114, 105, 98, 98, 111, 110, 45, 50),
    token(82, 49),
    token(82, 50),
  ];

  assert.match(html, /class="section-title">UTIL<\/span>/);
  assert.match(html, /id="btn-perf-snapshot-capture"/);
  assert.match(html, /id="btn-perf-off"/);
  assert.equal((html.match(/data-perf-snapshot-slot="/g) || []).length, 4);
  assert.match(css, /\.grid-util-perf/);
  assert.match(css, /\.perf-util-btn/);

  for (const token of removedPerfControls) {
    assert.doesNotMatch(html, new RegExp(token));
    assert.doesNotMatch(css, new RegExp(token));
  }
});

test('performance mode states color rings without replacing family fill feedback', () => {
  const css = read('style.css');
  const modeSelectors = [
    '.toggle.on',
    '.toggle.burst',
    '.button.pressed',
    '.button.burst',
  ];

  for (const selector of modeSelectors) {
    const block = cssBlock(css, selector);
    assert.notEqual(block, '', `${selector} must exist`);
    assert.doesNotMatch(block, /\bbackground(?:-color)?\s*:/,
      `${selector} must not paint the control interior`);
  }

  for (const selector of ['.pad.active', '.pad.latched', '.pad.toggled', '.pad.burst']) {
    const block = cssBlock(css, selector);
    assert.notEqual(block, '', `${selector} must exist`);
    assert.match(block, /--pad-fill-color/,
      `${selector} must keep value-driven pad fill instead of a mode-colored interior`);
  }
});

test('pads are neutral at rest and fill internally from drag intensity', () => {
  const css = read('style.css');
  const controls = read('controls.js');
  const padBlock = cssBlock(css, '.pad');

  assert.notEqual(padBlock, '', '.pad must exist');
  assert.doesNotMatch(padBlock, /rgba\(10,\s*132,\s*255/,
    'idle pads must not be permanently blue');
  assert.match(controls, /--pad-fill-alpha/);
  assert.match(controls, /--pad-fill-color/);
  assert.doesNotMatch(controls, /showToggled\(value\s*\|\|\s*1\)/,
    'mode C must not draw zero-value pads as full intensity');
});

test('AVH exposes live vision readouts and keeps advanced mode buttons out of the HUD preview', () => {
  const html = read('index.html');
  const app = read('app.js');
  const css = read('style.css');

  assert.match(html, /id="vision-card-position"/);
  assert.match(html, /id="vision-card-gesture"/);
  assert.match(html, /id="vision-card-color"/);
  assert.match(app, /vision-card-position/);
  assert.match(app, /vision-card-gesture/);
  assert.match(app, /vision-card-color/);

  const modesBlock = cssBlock(css, '.vision-modes-grid');
  assert.match(modesBlock, /\bdisplay\s*:\s*none\b/);
});

test('audio and camera inputs are explicit user actions, never restored automatically', () => {
  const app = read('app.js');

  assert.doesNotMatch(app, /ableton-rc:audio_enabled/);
  assert.doesNotMatch(app, /ableton-rc:vision_enabled/);
});

test('stage mode keeps safe margins, compact camera HUD, and centered mix faders', () => {
  const css = read('style.css');

  assert.match(cssBlock(css, 'body.stage-mode .page'), /safe-area-inset/);
  assert.match(cssBlock(css, '.vision-hud-container'), /\bwidth:\s*14[0-9]px\b/);
  assert.match(cssBlock(css, 'body.stage-mode .fader'), /justify-content:\s*center/);
});

test('Sensors page adds visual indicators for orientation and motion readings', () => {
  const html = read('index.html');
  const app = read('app.js');
  const css = read('style.css');

  assert.match(html, /data-sensor-orbit="ori\.alpha"/);
  assert.match(html, /data-sensor-bar="aig\.x"/);
  assert.match(app, /function setSensorVisual/);
  assert.match(cssBlock(css, '.sensor-orbit i'), /--sensor-angle/);
  assert.match(cssBlock(css, '.sensor-axis-track i'), /--sensor-level/);
});

test('camera HUD is draggable and can be minimized without closing camera input', () => {
  const app = read('app.js');
  const css = read('style.css');

  assert.match(app, /function setupVisionHudControls/);
  assert.match(app, /data-vision-hud-dragging/);
  assert.match(app, /vision-hud-minimized/);
  assert.match(app, /lastTapAt/);
  assert.match(app, /pointerdown/);
  assert.match(app, /pointermove/);
  assert.match(cssBlock(css, '.vision-hud-container'), /pointer-events:\s*auto/);
  assert.match(cssBlock(css, '.vision-hud-container.minimized'), /\bheight:\s*24px\b/);
});

test('Performance animation loop resyncs on page changes and avoids hidden-page DOM churn', () => {
  const controls = read('controls.js');

  assert.match(controls, /ableton-rc:page-change/);
  assert.match(controls, /performanceVisible/);
  assert.match(controls, /lastFrameTime\s*=\s*performance\.now\(\)/);
});

test('phone app exposes a command bridge over the existing WebSocket', () => {
  const app = read('app.js');

  assert.match(app, /const phoneCommandCallbacks = new Map\(\)/);
  assert.match(app, /window\.sendPhoneCommand\s*=\s*function/);
  assert.match(app, /phone-map-/);
  assert.match(app, /handlePhoneCommandResponse/);
  assert.match(app, /ableton-rc:phone-command-response/);
  assert.doesNotMatch(read('index.html'), /new WebSocket[^<]*mapping/i);
});

test('phone app exposes WebSocket lifecycle events for mapping mode', () => {
  const app = read('app.js');

  assert.match(app, /ableton-rc:phone-ws-open/);
  assert.match(app, /ableton-rc:phone-ws-close/);
  assert.match(app, /ableton-rc:phone-client-id/);
});

test('phone command bridge fails pending callbacks when WebSocket closes', () => {
  const app = read('app.js');

  assert.match(app, /function failPendingPhoneCommands/);
  assert.match(app, /phoneCommandCallbacks\.clear\(\)/);
  assert.match(app, /failPendingPhoneCommands\('Connection closed before command response'\)/);
});

test('phone header includes MAP control beside BPM and loads mapping-mode script', () => {
  const html = read('index.html');

  assert.match(html, /id="btn-map-mode"/);
  assert.match(html, /class="ablt-map-btn"/);
  assert.match(html, /id="mapping-mode"/);
  assert.match(html, /data-page="mapping"/);
  assert.match(html, /<script src="mapping-mode\.js"><\/script>/);
});

test('controls exposes showPhonePage for non-tab overlays', () => {
  const controls = read('controls.js');

  assert.match(controls, /window\.showPhonePage\s*=\s*show/);
});

test('mapping-mode toggles dataset page and active class', () => {
  const js = read('mapping-mode.js');

  assert.match(js, /previousPage/);
  assert.match(js, /setPhoneMappingModeActive\(true\)/);
  assert.match(js, /showPhonePage\('mapping'\)/);
  assert.match(js, /showPhonePage\(previousPage\)/);
});

test('mapping mode is a fixed full-viewport overlay, not a body layout class', () => {
  const css = read('style.css');
  const overlayBlock = cssBlock(css, '#mapping-mode');

  assert.doesNotMatch(css, /^\s*\.mapping-mode\s*\{/m,
    'the generic .mapping-mode selector must not turn body.mapping-mode into a grid');
  assert.match(overlayBlock, /position:\s*fixed/);
  assert.match(overlayBlock, /inset:\s*0/);
  assert.match(overlayBlock, /100dvw/);
  assert.match(overlayBlock, /100dvh/);
  assert.match(overlayBlock, /z-index:\s*3000/);
});

test('TRN button and transport overlay exist in markup', () => {
  const html = read('index.html');
  assert.match(html, /id="btn-trn-mode"/);
  assert.match(html, /id="transport-lite-overlay"/);
  assert.match(html, /id="btn-trn-play"/);
  assert.match(html, /id="btn-trn-stop"/);
  assert.match(html, /id="btn-trn-prev"/);
  assert.match(html, /id="btn-trn-next"/);
  assert.match(html, /id="btn-trn-refresh"/);
  assert.match(html, /id="locator-search"/);
  assert.match(html, /id="locator-list"/);
});

test('controls.js setupTransportLiteUI handles getTransportLiteState and unwraps result', () => {
  const controls = read('controls.js');
  assert.match(controls, /setupTransportLiteUI/);
  assert.match(controls, /'getTransportLiteState'/);
  assert.match(controls, /res\.result\s*\|\|\s*res/);
  assert.match(controls, /updateTransportLocators/);
  assert.match(controls, /updateOscStatus/);
});

test('app.js handles incoming transport_state and beat messages', () => {
  const app = read('app.js');
  assert.match(app, /msg\.type\s*===\s*'transport_state'/);
  assert.match(app, /msg\.type\s*===\s*'beat'/);
  assert.match(app, /triggerMetronomePulse/);
  assert.match(app, /updateTransportLocators/);
  assert.match(app, /updateOscStatus/);
});

test('Sync Settings overlay markup and buttons exist in index.html', () => {
  const html = read('index.html');
  assert.match(html, /id="btn-sync-settings"/);
  assert.match(html, /id="sync-settings-overlay"/);
  assert.match(html, /id="btn-sync-settings-close"/);
  assert.match(html, /id="select-clock-source"/);
  assert.match(html, /id="lfo-rate-grid"/);
  assert.match(html, /id="lfo-shape-grid"/);
  assert.match(html, /id="lfo-phase-offset"/);
  assert.match(html, /id="stutter-rate-grid"/);
  assert.match(html, /id="stutter-swing"/);
  assert.match(html, /id="stutter-phase-offset"/);
});

test('Sync Settings rate grids include Auto pin mode for per-control synced rates', () => {
  const html = read('index.html');
  const controls = read('controls.js');
  assert.match(html, /id="lfo-rate-grid"[\s\S]*data-val="auto"[\s\S]*Auto/);
  assert.match(html, /id="stutter-rate-grid"[\s\S]*data-val="auto"[\s\S]*Auto/);
  assert.match(controls, /lfoSubdivisionPinned:\s*false/);
  assert.match(controls, /stutterSubdivisionPinned:\s*false/);
});

test('controls.js loads and updates window.syncSettings, and integrates with LFO/Stutter state messages', () => {
  const controls = read('controls.js');
  assert.match(controls, /setupSyncSettingsUI/);
  assert.match(controls, /window\.syncSettings\s*=/);
  assert.match(controls, /'ableton-rc:sync_settings'/);
  assert.match(controls, /clockSource:\s*window\.syncSettings\.clockSource/);
  assert.match(controls, /syncSubdivisionBeats:\s*window\.syncSettings\.lfoSubdivision/);
  assert.match(controls, /phaseOffsetBeats:\s*window\.syncSettings\.lfoPhaseOffset/);
  assert.match(controls, /shape:\s*window\.syncSettings\.lfoShape/);
  assert.match(controls, /syncSubdivisionBeats:\s*window\.syncSettings\.stutterSubdivision/);
  assert.match(controls, /phaseOffsetBeats:\s*window\.syncSettings\.stutterPhaseOffset/);
  assert.match(controls, /swing:\s*window\.syncSettings\.stutterSwing/);
});

test('controls.js renders local LFO feedback with the selected shape', () => {
  const controls = read('controls.js');
  assert.match(controls, /function computeLfoWaveValue/);
  assert.match(controls, /computeLfoWaveValue\(window\.syncSettings\.lfoShape,\s*state\.phase\)/);
  assert.doesNotMatch(controls, /0\.5\s*\+\s*Math\.sin\(state\.phase\)\s*\*\s*0\.5\s*\*\s*state\.depth/);
});

test('app.js forwards deep sync modulator fields to the WebSocket payload', () => {
  const app = read('app.js');
  assert.match(app, /clockSource:[^\n]*modulator\.clockSource/);
  assert.match(app, /syncSubdivisionBeats:[^\n]*modulator\.syncSubdivisionBeats/);
  assert.match(app, /phaseOffsetBeats:[^\n]*modulator\.phaseOffsetBeats/);
  assert.match(app, /shape:[^\n]*modulator\.shape/);
  assert.match(app, /swing:[^\n]*modulator\.swing/);
});

test('mapping-mode.js target picker exposes Selected in Live helper and supports hierarchical filtering', () => {
  const js = read('mapping-mode.js');
  assert.match(js, /btnUseSelected/);
  assert.match(js, /'Selected in Live'/);
  assert.match(js, /'getTransportLiteState'/);
  assert.match(js, /selectedTrackIndex/);
  assert.match(js, /selectedDeviceIndex/);
  assert.match(js, /cleanFilter\.includes\('\s*>\s*'\)/);
  assert.match(js, /filterTrack\s*=/);
  assert.match(js, /filterDevice\s*=/);
});

test('mapping-mode.js fixes: trackKind-aware targetLabel/isSameTarget, picker awaits bind, and conflict remains visible', () => {
  const js = read('mapping-mode.js');

  // isSameTarget compares trackKind
  assert.match(js, /const aKind = a\.trackKind \|\| 'track'/);
  assert.match(js, /const bKind = b\.trackKind \|\| 'track'/);
  assert.match(js, /if \(aKind !== bKind\) return false/);

  // targetLabel uses trackKind
  assert.match(js, /const targetKind = target\.trackKind \|\| 'track'/);
  assert.match(js, /item\.trackKind\s*\|\|\s*'track'\)\s*===\s*targetKind/);

  // createPickerRow awaits bindMobileTarget and conditionally closes picker
  assert.match(js, /row\.addEventListener\('click',\s*async\s*\(\)\s*=>/);
  assert.match(js, /const success = await bindMobileTarget\(target\)/);
  assert.match(js, /if \(success\) \{/);
  assert.match(js, /closePicker\(\)/);

  // bindMobileTarget returns boolean (true/false)
  assert.match(js, /async function bindMobileTarget\(target\)\s*\{/);
  assert.match(js, /return false;/);
  assert.match(js, /return true;/);

  // saveTargetsForSelected does rollback and sets error status
  assert.match(js, /const prevTargets = state\.currentMappings\[key\]/);
  assert.match(js, /if \(prevTargets === undefined\)/);
  assert.match(js, /state\.currentMappings\[key\] = prevTargets/);
  assert.match(js, /setStatus\(response\?\.error \|\| 'Failed to save mapping target\.', 'error'\)/);
});

test('controls.js / index.html / app.js / mapping-mode.js new features: header transport, double-click resets, and conflict picker closure', () => {
  const html = read('index.html');
  const controls = read('controls.js');
  const app = read('app.js');
  const mappingMode = read('mapping-mode.js');

  // Header transport buttons markup
  assert.match(html, /id="btn-header-prev"/);
  assert.match(html, /id="btn-header-play"/);
  assert.match(html, /id="btn-header-next"/);

  // Controls.js dblclick reset event bindings
  assert.match(controls, /const resetInput = \(inputEl, valEl, defaultVal, key\) =>/);
  assert.match(controls, /inputEl\.addEventListener\('dblclick'/);
  assert.match(controls, /valEl\.addEventListener\('dblclick'/);
  assert.match(controls, /resetInput\(lfoPhaseInput, lfoPhaseVal, 0\.0, 'lfoPhaseOffset'\)/);
  assert.match(controls, /resetInput\(stutterSwingInput, stutterSwingVal, 0\.0, 'stutterSwing'\)/);
  assert.match(controls, /resetInput\(stutterPhaseInput, stutterPhaseVal, 0\.0, 'stutterPhaseOffset'\)/);

  // App.js updates header play state
  assert.match(app, /window\.updateHeaderPlayState\(state\.isPlaying\)/);

  // Mapping mode sets pickerMode to null on conflict to show details pane UI
  assert.match(mappingMode, /state\.pendingConflict = \{ owner: conflict, target: normalized \};/);
  assert.match(mappingMode, /state\.pickerMode = null;/);
});
