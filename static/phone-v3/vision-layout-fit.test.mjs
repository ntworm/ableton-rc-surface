// Copyright © 2026 Gabriel Worm
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Source: https://github.com/ntworm/ableton-rc-surface
//
// Structural assertions for the redesigned Vision page layout.
//
// These tests guard the layout contract that keeps the page usable on a
// phone held sideways: the three learned-pose slots are the highest
// priority, the camera and its controls are second, and everything else
// (detectors, readouts) compresses or hides when space is tight.
//
// They assert structural CSS properties — not pixel measurements — so they
// protect against the class of bug that produced the original overlap
// (text escaping its row, secondary sections stealing height) without
// being brittle to minor spacing tweaks.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const read = (file) => fs.readFileSync(path.join(import.meta.dirname, file), 'utf8');

function cssBlock(css, selector) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = css.match(new RegExp(`${escaped}\\s*\\{([^}]*)\\}`, 'm'));
  return match ? match[1] : '';
}

test('the pose slots get all leftover height — studio is the first grid row', () => {
  const css = read('style.css');
  const column = cssBlock(css, '.vision-right-column');

  assert.match(column, /display:\s*grid/, 'right column uses grid for row priority');
  assert.match(
    column,
    /grid-template-rows:\s*minmax\(0,\s*1fr\)\s+auto\s+auto/,
    'studio (1fr) first, detectors (auto) second, readouts (auto) third',
  );
  assert.match(column, /min-height:\s*0/);
  assert.match(column, /overflow:\s*hidden/);
});

test('a slot is contained and cannot spill out of its row', () => {
  const css = read('style.css');
  const slot = cssBlock(css, '.vision-gesture-slot');

  assert.match(slot, /overflow:\s*hidden/, 'nothing may draw outside the slot');
  assert.match(slot, /min-width:\s*0/);
  assert.match(slot, /min-height:\s*0/);
  assert.match(slot, /display:\s*flex/, 'slot uses flex for horizontal row layout');
});

test('the slot status truncates and cannot overflow', () => {
  const css = read('style.css');
  const status = cssBlock(css, '.vision-slot-status');

  assert.match(status, /white-space:\s*nowrap/);
  assert.match(status, /overflow:\s*hidden/);
  assert.match(status, /text-overflow:\s*ellipsis/);
});

test('the secondary sections cannot squeeze the slots out', () => {
  const css = read('style.css');

  assert.match(cssBlock(css, '.vision-detector-section'), /overflow:\s*hidden/);
  assert.match(cssBlock(css, '.vision-signal-strip'), /overflow:\s*hidden/);
  assert.match(cssBlock(css, '.vision-sensor-deck .vision-readout-card'), /min-height:\s*0/);
  assert.match(cssBlock(css, '.vision-sensor-deck .vision-readout-card'), /overflow:\s*hidden/);
});

test('the three slots share the studio evenly', () => {
  const css = read('style.css');
  for (const selector of ['.vision-gesture-slots', '.vision-pose-grid']) {
    const block = cssBlock(css, selector);
    assert.match(
      block,
      /grid-template-rows:\s*repeat\(3,\s*minmax\(0,\s*1fr\)\)/,
      `${selector} must give each slot an equal, shrinkable row`,
    );
  }
});

test('the four slot actions are arranged in a 2x2 grid to maximize touch targets', () => {
  const css = read('style.css');
  const actions = cssBlock(css, '.vision-slot-actions');

  assert.match(actions, /grid-template-columns:\s*repeat\(2,/);
  assert.match(actions, /grid-template-rows:\s*repeat\(2,/);
  assert.match(actions, /min-width:\s*0/);
});

test('labels are what gets dropped when the screen is short, never the controls', () => {
  const css = read('style.css');
  const shortScreen = css.match(/@media \(max-height: 460px\)\s*\{([\s\S]*?)\n\}/);

  assert.ok(shortScreen, 'a short-screen rule must exist');
  assert.match(shortScreen[1], /\.vision-readout-card em\s*\{\s*display:\s*none/);
  assert.doesNotMatch(
    shortScreen[1],
    /vision-slot-actions/,
    'the slot action buttons must survive every breakpoint',
  );
});

test('the page itself still refuses to scroll', () => {
  const css = read('style.css');
  assert.match(css, /\.page-video\s*\{[^}]*overflow:\s*hidden/);
  assert.match(cssBlock(css, '.vision-workspace'), /overflow:\s*hidden/);
});

test('the camera and its controls are still in the left column', () => {
  const html = read('index.html');
  assert.match(html, /<div class="vision-left-column">[\s\S]*vision-command-bar/);
  assert.match(html, /<div class="vision-left-column">[\s\S]*vision-camera-stage/);
  assert.match(html, /id="chk-vision-enable"/);
  assert.match(html, /id="vision-confidence"/);
  assert.match(html, /id="vision-recognition-preset"/);
  assert.equal((html.match(/class="vision-gesture-slot"/g) || []).length, 3);
});

test('gesture studio comes before detectors in the right column', () => {
  const html = read('index.html');
  const studioPos = html.indexOf('vision-gesture-studio');
  const detectorPos = html.indexOf('vision-detector-section');
  assert.ok(studioPos > 0, 'gesture studio must exist');
  assert.ok(detectorPos > 0, 'detector section must exist');
  assert.ok(
    studioPos < detectorPos,
    'gesture studio must come before detector section in DOM order',
  );
});
