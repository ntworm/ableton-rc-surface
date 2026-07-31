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
  assert.match(html, /data-page="audio"/);
  assert.match(html, /data-page="video"/);
  assert.doesNotMatch(html, /class="tab"[^>]*data-page="advanced"/);
});

test('audio and video have dedicated full pages instead of a cramped shared AVH page', () => {
  const html = read('index.html');
  assert.match(html, /class="tab"[^>]*data-page="audio"[^>]*>AUD</);
  assert.match(html, /class="tab"[^>]*data-page="video"[^>]*>VID</);
  assert.match(html, /class="page page-audio hidden"[^>]*data-page="audio"/);
  assert.match(html, /class="page page-video hidden"[^>]*data-page="video"/);
  assert.doesNotMatch(html, /data-page="media"|>AVH</);
});

test('audio surface removes noisy transient and whistle trigger channels', () => {
  const html = read('index.html');
  const app = read('app.js');
  const mapping = read('mapping-mode.js');
  for (const retired of ['sensor.audio.transient', 'sensor.audio.whistle.active']) {
    assert.doesNotMatch(html, new RegExp(`data-name=["']${retired.replaceAll('.', '\\.')}`));
    assert.doesNotMatch(mapping, new RegExp(`["']${retired.replaceAll('.', '\\.')}`));
    assert.doesNotMatch(app, new RegExp(`name:\\s*["']${retired.replaceAll('.', '\\.')}`));
  }
});

test('vision built-ins are opt-in and individual finger noise is not mappable', () => {
  const html = read('index.html');
  const app = read('app.js');
  const mapping = read('mapping-mode.js');
  // Five opt-in built-in detectors: open / fist / pinch / victory / fingers.
  // Wrist rotation rides on the Victory pose; it has no dedicated toggle
  // because the rotation is exposed as an analog value, not a gate.
  assert.equal((html.match(/data-vision-gesture=/g) || []).length, 5);
  assert.equal((html.match(/data-vision-gesture=[^>]+aria-pressed="false"/g) || []).length, 5);
  for (const retired of ['thumb', 'index', 'middle', 'ring', 'pinky']) {
    assert.doesNotMatch(mapping, new RegExp(`sensor\\.vision\\.${retired}`));
    assert.doesNotMatch(app, new RegExp(`name:\\s*['"]sensor\\.vision\\.${retired}`));
  }
});

test('vision performance layout fits one screen with compact controls and fixed gestures', () => {
  const html = read('index.html');
  const app = read('app.js');
  const css = read('style.css');
  assert.match(html, /class="vision-command-bar"/);
  assert.match(html, /class="[^"]*vision-performance-console[^"]*"/);
  assert.match(html, /class="[^"]*vision-console-main[^"]*"/);
  assert.match(html, /class="[^"]*vision-pose-grid[^"]*"/);
  assert.match(html, /class="[^"]*vision-signal-strip[^"]*"/);
  assert.match(html, /class="vision-camera-stage"/);
  assert.match(html, /class="vision-slot-retake"/);
  assert.match(html, /class="vision-slot-delete"/);
  assert.match(html, /id="vision-recognition-preset"/);
  assert.match(html, /id="vision-canvas" width="320" height="240"/);
  for (const axis of ['x', 'y', 'z']) {
    assert.match(html, new RegExp(`data-name="sensor\\.vision\\.${axis}"`));
  }
  assert.equal((html.match(/<span>GESTURE [123]<\/span>/g) || []).length, 3);
  assert.doesNotMatch(html, /vision-slot-name|Name gesture|Gesture slot [123] name/);
  assert.doesNotMatch(app, /vision-slot-name|Name this gesture slot/);
  assert.doesNotMatch(html, /id="vision-gesture-(?:sensitivity|tolerance)"[^>]+type="range"/);
  assert.doesNotMatch(app, /vision-hud-position|data-vision-hud-dragging|lastTapAt/);
  assert.match(cssBlock(css, '.vision-camera-stage'), /aspect-ratio:\s*4\s*\/\s*3/);
  assert.match(cssBlock(css, '.vision-camera-stage'), /height:\s*96px/);
  assert.match(cssBlock(css, '.vision-camera-stage'), /max-height:\s*100%/);
  assert.doesNotMatch(cssBlock(css, '.vision-camera-stage'), /height:\s*auto/);
  assert.match(cssBlock(css, '.vision-hud-container'), /position:\s*absolute/);
  assert.match(cssBlock(css, '.media-card-vision'), /height:\s*100%/);
  assert.match(cssBlock(css, '.media-card-vision'), /min-height:\s*0/);
  assert.match(css, /\.page-video\s*\{[^}]*overflow:\s*hidden/);
  assert.match(cssBlock(css, '.vision-console-main'), /grid-template-columns:/);
  assert.match(cssBlock(css, '.vision-pose-grid'), /grid-template-columns:\s*repeat\(3,/);
  assert.match(cssBlock(css, '.vision-signal-strip'), /grid-template-columns:/);
  assert.match(cssBlock(css, '.vision-axis-chips'), /grid-template-columns:\s*repeat\(4,/);
  assert.match(cssBlock(css, '.vision-gesture-list'), /grid-template-columns:\s*repeat\(5,/);
  assert.doesNotMatch(cssBlock(css, '.vision-sensor-deck'), /grid-template-rows:\s*auto\s+1fr/);
  assert.match(css, /\.vision-gesture-studio\s*\{[^}]*flex:\s*1\s+1\s+0/);
  assert.match(cssBlock(css, '.vision-gesture-slots'), /flex:\s*1/);
  assert.match(cssBlock(css, '.vision-slot-actions'), /grid-template-columns:\s*repeat\(2,/);
  assert.match(cssBlock(css, '.vision-slot-actions button'), /min-height:\s*3[4-9]px/);
  assert.match(css, /@media \(max-height: 430px\)[\s\S]*\.vision-sensor-deck \.vision-readout-card em\s*\{\s*display:\s*none/);
});

test('camera is a fixed non-interactive thumbnail that cannot cover the signal strip', () => {
  const html = read('index.html');
  const app = read('app.js');
  const css = read('style.css');
  const cameraMarkup = html.match(/<aside class="vision-camera-stage"[^>]*>/)?.[0] || '';
  const cameraCss = cssBlock(css, '.vision-camera-stage');
  assert.match(cameraMarkup, /aria-label="Camera preview status"/);
  assert.doesNotMatch(cameraMarkup, /\brole=|\btabindex=|aria-expanded/);
  assert.doesNotMatch(app, /cameraPreviewExpanded|setCameraPreviewExpanded|camera-expanded|aria-expanded|Tap to expand|Tap to close/);
  assert.match(cssBlock(css, '.vision-workspace'), /grid-template-columns:\s*minmax\(112px,\s*136px\)\s+minmax\(0,\s*1fr\)/);
  assert.match(cameraCss, /position:\s*relative/);
  assert.match(cameraCss, /width:\s*128px/);
  assert.match(cameraCss, /max-width:\s*100%/);
  assert.match(cameraCss, /height:\s*96px/);
  assert.match(cameraCss, /max-height:\s*100%/);
  assert.match(cameraCss, /align-self:\s*start/);
  assert.doesNotMatch(cameraCss, /height:\s*auto|cursor:\s*zoom|transition:/);
  assert.equal(cssBlock(css, '.vision-camera-stage.camera-expanded'), '');
  assert.doesNotMatch(cssBlock(css, '.vision-camera-toggle .switch-rail'), /transform:/);
  assert.match(cssBlock(css, '.vision-camera-toggle .switch-rail'), /flex:\s*0\s+0\s+3[0-6]px/);
  assert.match(cssBlock(css, '.vision-camera-stage .hud-stats'), /display:\s*none/);
  assert.doesNotMatch(app, /vision-hud-position|data-vision-hud-dragging/);
});

test('camera failures stay inline, explain busy hardware, and can be retried cleanly', () => {
  const html = read('index.html');
  const app = read('app.js');
  assert.match(html, /class="vision-camera-error"/);
  assert.match(app, /NotReadableError/);
  assert.match(app, /CAMERA BUSY/);
  assert.match(app, /err\?\.message/);
  assert.match(app, /replace\(\/\\s\+\/g,\s*' '\)/);
  assert.match(app, /slice\(0,\s*120\)/);
  assert.match(app, /chk\.disabled\s*=\s*true/);
  assert.match(app, /finally\s*\{\s*chk\.disabled\s*=\s*false/);
  assert.match(app, /pagehide/);
  assert.doesNotMatch(app, /alert\(/);
});

test('vision confidence selector exposes three low-light presets', () => {
  const html = read('index.html');
  const app = read('app.js');
  const vp = read('vision-processor.js');
  // The selector must exist and offer three named presets that map to
  // distinct MediaPipe confidence values (low-light support).
  assert.match(html, /id="vision-confidence"/);
  for (const value of ['low', 'medium', 'high']) {
    const pattern = new RegExp(`<option[^>]*value=["']${value}["']`, 'i');
    assert.match(html, pattern, `expected option value="${value}" in vision-confidence selector`);
  }
  // app.js must wire the selector to visionProcessor.setConfidence().
  assert.match(app, /setConfidence/);
  assert.match(app, /vision-confidence/);
  // vision-processor.js translates the chosen preset into MediaPipe
  // setOptions({ minDetectionConfidence, minTrackingConfidence }).
  assert.match(vp, /minDetectionConfidence/);
  assert.match(vp, /minTrackingConfidence/);
  // The numeric thresholds the worm asked for: Low 0.2, Medium 0.5, High 0.7.
  assert.match(vp, /\b0\.2\b/);
  assert.match(vp, /\b0\.5\b/);
  assert.match(vp, /\b0\.7\b/);
});

test('3D calibration assets are removed (spatial tracking was retired)', () => {
  const html = read('index.html');
  const app = read('app.js');
  const css = read('style.css');
  // The CAL 3D button, the calibration guide status block, and the
  // safe-input-layer helpers for spatial calibration/tracking/guide
  // should all be gone now that the worm retired spatial tracking.
  assert.doesNotMatch(html, /id="btn-vision-calibrate"/);
  assert.doesNotMatch(html, /id="vision-calibration-title"/);
  assert.doesNotMatch(html, /id="vision-calibration-detail"/);
  assert.doesNotMatch(app, /SpatialCalibration/);
  assert.doesNotMatch(app, /SpatialTracker/);
  assert.doesNotMatch(app, /getCalibrationGuide/);
  assert.doesNotMatch(css, /\.vision-calibration-status/);
});

test('vision hand frames render readouts once without duplicate label writes', () => {
  const app = read('app.js');
  const start = app.indexOf('function applyHandReading(data)');
  const end = app.indexOf('function markHandLost()', start);
  const applyHandReading = app.slice(start, end);
  assert.equal((applyHandReading.match(/renderVisionReadouts\(\)/g) || []).length, 1);
  assert.doesNotMatch(applyHandReading, /lbl[XYZG][^\n]*textContent/);
});

test('gesture TEST arms a static pose and exits with persistent success feedback', () => {
  const app = read('app.js');
  const stopVision = app.slice(app.indexOf('const stopVision ='), app.indexOf('chk.addEventListener', app.indexOf('const stopVision =')));
  assert.match(app, /beginGestureTest/);
  assert.match(app, /TEST PASSED/);
  assert.match(app, /visionGestureTestSlot\s*=\s*null/);
  assert.match(app, /HOLD THE LEARNED POSE/);
  assert.match(stopVision, /stopGestureTest\(\)/);
});

test('gesture TEST displays continuous confidence without sending a partial match to Live', () => {
  const app = read('app.js');
  const progressStart = app.indexOf('visionProcessor.onGestureProgress');
  const progressEnd = app.indexOf('visionProcessor.onGesture =', progressStart);
  const progressHandler = app.slice(progressStart, progressEnd);
  assert.ok(progressStart >= 0, 'missing learned-gesture progress handler');
  assert.match(progressHandler, /confidence/);
  assert.match(progressHandler, /%/);
  assert.match(progressHandler, /visionGestureTestSlot/);
  assert.doesNotMatch(progressHandler, /window\.onControl/);
});

test('gesture recognition presets use practical confidence gates while preserving strict modes', () => {
  const app = read('app.js');
  assert.match(app, /precision:\s*\{[^}]*minimumConfidence:\s*0\.66/);
  assert.match(app, /balanced:\s*\{[^}]*minimumConfidence:\s*0\.52/);
  assert.match(app, /flexible:\s*\{[^}]*minimumConfidence:\s*0\.44/);
  assert.match(app, /balanced:\s*\{[^}]*captureStabilityThreshold:\s*0\.10/);
});

test('gesture TEST tells the recognizer which numbered slot is being validated', () => {
  const app = read('app.js');
  const stopStart = app.indexOf('const stopGestureTest =');
  const stopEnd = app.indexOf('const removeStoredTake', stopStart);
  const stopHandler = app.slice(stopStart, stopEnd);
  assert.match(app, /beginGestureTest\?\.\(slot\.name\)/);
  assert.match(stopHandler, /endGestureTest/);
});

test('learned gesture cards expose only the simplified static POSE model', () => {
  const app = read('app.js');
  assert.match(app, /gestureKindFor/);
  assert.match(app, /POSE/);
  assert.doesNotMatch(app, /perform one MOTION/);
});

test('gesture destructive actions explain last-take versus all-takes behavior', () => {
  const html = read('index.html');
  assert.equal((html.match(/>REMOVE LAST</g) || []).length, 3);
  assert.equal((html.match(/>CLEAR ALL</g) || []).length, 3);
  assert.doesNotMatch(html, />RETAKE<|>DELETE</);
});

test('legacy gesture outlier repair is reflected in slot counts before camera start', () => {
  const app = read('app.js');
  assert.match(app, /GestureLibrary\?\.fromJSON/);
  assert.match(app, /visionSafetyConfig\.gestures\s*=\s*migrateGestureConfig/);
  assert.match(app, /restoredGestures\s*=\s*migrateGestureConfig/);
});

test('phone header exposes stage mode and MIX no longer exposes performance/debug mode', () => {
  const html = read('index.html');
  const app = read('app.js');

  assert.match(html, /id="btn-stage-mode"/);
  assert.doesNotMatch(html, /id="btn-mixer-mode"/);
  assert.doesNotMatch(app, /setupMixerMode/);
  assert.doesNotMatch(app, /ableton-rc:mixer-mode/);
});

test('stage button uses the restored direct fullscreen toggle', () => {
  const html = read('index.html');
  const controls = read('controls.js');
  const start = controls.indexOf('function setupStageModeUI()');
  const end = controls.indexOf('// ---- Physics & Modulators', start);
  const stage = controls.slice(start, end);

  assert.doesNotMatch(html, /stage-mode-controller\.js/);
  assert.match(stage, /render\(true\);[\s\S]*document\.documentElement[\s\S]*requestFullscreen\(\)/);
  assert.match(stage, /render\(false\);[\s\S]*document\.exitFullscreen\(\)/);
  assert.doesNotMatch(stage, /ENTER…|EXIT…|RETRY|navigationUI|setInterval/);
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

test('Video exposes live vision readouts and keeps advanced mode buttons out of the HUD preview', () => {
  const html = read('index.html');
  const app = read('app.js');
  const css = read('style.css');

  // Direct camera X/Y/Z remain useful mapping controls even though guided
  // calibration and predicted 3D spatial tracking are retired.
  assert.doesNotMatch(html, /id="vision-card-position"/);
  assert.match(html, /id="vision-value-x"/);
  assert.match(html, /id="vision-value-y"/);
  assert.match(html, /id="vision-value-z"/);
  assert.match(html, /id="vision-card-gesture"/);
  assert.match(html, /id="vision-card-color"/);
  assert.match(app, /vision-card-gesture/);
  assert.match(app, /vision-value-\$\{channel\}/);

  const modesBlock = cssBlock(css, '.vision-modes-grid');
  assert.match(modesBlock, /\bdisplay\s*:\s*none\b/);
});

test('audio and camera inputs are explicit user actions, never restored automatically', () => {
  const app = read('app.js');

  assert.doesNotMatch(app, /ableton-rc:audio_enabled/);
  assert.doesNotMatch(app, /ableton-rc:vision_enabled/);
});

test('stage mode keeps safe margins, a horizontal camera stage, and centered mix faders', () => {
  const css = read('style.css');

  assert.match(cssBlock(css, 'body.stage-mode .page'), /safe-area-inset/);
  assert.match(cssBlock(css, '.vision-camera-stage'), /aspect-ratio:\s*4\s*\/\s*3/);
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

test('camera preview stays in the Vision grid without drag state', () => {
  const html = read('index.html');
  const app = read('app.js');
  const css = read('style.css');

  assert.match(html, /class="vision-camera-stage"/);
  assert.match(html, /class="vision-camera-sidebar"/);
  assert.match(html, /id="vision-hud"/);
  assert.doesNotMatch(app, /setupVisionHudControls|data-vision-hud-dragging|vision-hud-minimized|lastTapAt/);
  assert.match(cssBlock(css, '.media-card-vision'), /position:\s*relative/);
  assert.match(cssBlock(css, '.vision-camera-stage'), /position:\s*relative/);
  // The sidebar wrapper now holds the grid position; the stage itself is
  // a normal child of the sidebar.
  assert.match(cssBlock(css, '.vision-camera-sidebar'), /grid-column:\s*1/);
  assert.match(cssBlock(css, '.vision-hud-container'), /position:\s*absolute/);
});

test('Performance animation loop resyncs on page changes and avoids hidden-page DOM churn', () => {
  const controls = read('controls.js');

  assert.match(controls, /ableton-rc:page-change/);
  assert.match(controls, /performanceVisible/);
  assert.match(controls, /lastFrameTime\s*=\s*performance\.now\(\)/);
});

test('phone app exposes a command bridge over the existing WebSocket', () => {
  const session = read('modules/session.js');

  // Session bridge moved to modules/session.js
  assert.match(session, /const phoneCommandCallbacks = new Map\(\)/);
  assert.match(session, /window\.sendPhoneCommand/);
  assert.match(session, /phone-map-/);
  assert.match(session, /handlePhoneCommandResponse/);
  assert.match(session, /ableton-rc:phone-command-response/);
  assert.doesNotMatch(read('index.html'), /new WebSocket[^<]*mapping/i);
});

test('phone app exposes WebSocket lifecycle events for mapping mode', () => {
  const session = read('modules/session.js');

  // Lifecycle events moved to modules/session.js
  assert.match(session, /ableton-rc:phone-ws-open/);
  assert.match(session, /ableton-rc:phone-ws-close/);
  assert.match(session, /ableton-rc:phone-client-id/);
});

test('phone command bridge fails pending callbacks when WebSocket closes', () => {
  const session = read('modules/session.js');

  // failPendingPhoneCommands moved to modules/session.js
  assert.match(session, /function failPendingPhoneCommands/);
  assert.match(session, /phoneCommandCallbacks\.clear\(\)/);
  // app.js initSession onClose path triggers fail via session.js internals
  assert.match(read('app.js'), /initSession/);
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
  const layout = read('modules/layout.js');

  // Layout logic extracted to modules/layout.js:
  assert.match(layout, /window\.showPhonePage\s*=\s*show/);
  // controls.js still references the module:
  assert.match(controls, /setupLayout/);
});

test('mapping-mode toggles dataset page and active class', () => {
  const js = read('mapping-mode.js');

  assert.match(js, /previousPage/);
  assert.match(js, /setPhoneMappingModeActive\(true\)/);
  // MAP is an overlay, not a page: it marks the body directly. Routing it
  // through showPhonePage() made the layout persist "mapping" as the active
  // page, and restoring that on the next load hid every real page — the app
  // opened on a black screen until a tab was tapped.
  assert.match(js, /document\.body\.dataset\.page = 'mapping'/);
  assert.doesNotMatch(js, /showPhonePage\('mapping'\)/,
    'the MAP overlay must not go through the page router');
  // Closing MAP does return to a real page, and that one is routed normally.
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
  const transport = read('modules/transport.js');
  assert.match(controls, /setupTransportLiteUI/);
  // Logic extracted to modules/transport.js:
  assert.match(transport, /'getTransportLiteState'/);
  assert.match(transport, /res\.result\s*\|\|\s*res/);
  assert.match(transport, /updateTransportLocators/);
  assert.match(transport, /updateOscStatus/);
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
