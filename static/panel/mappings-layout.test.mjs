// Copyright © 2026 Gabriel Worm
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
//
// The Ableton panel's Mappings tab pinned its control list to a hard 220px.
// Control names are long ("Hand Victory Rotate", "Audio Whistle Bend") and the
// list truncates with an ellipsis, while the detail pane next to it sits empty
// until a control is picked. The toolbar above the list (PRJ↑ PRJ↓ ↶, the
// category select and Clear) is laid out in a single non-wrapping row, so at
// that width its controls are clipped off the edge.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const css = fs.readFileSync(path.join(import.meta.dirname, 'style.css'), 'utf8');

function cssBlock(selector) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = new RegExp(`(^|\\})\\s*${escaped}\\s*\\{([^}]*)\\}`, 'm').exec(css);
  assert.ok(match, `selector ${selector} must exist in panel style.css`);
  return match[2];
}

test('panel mappings list is not pinned to a fixed narrow width', () => {
  const block = cssBlock('.map-left');
  assert.doesNotMatch(
    block,
    /width\s*:\s*220px/,
    'a hard 220px is what truncates long control names and clips the toolbar',
  );
  assert.doesNotMatch(
    block,
    /flex-shrink\s*:\s*0/,
    'the list must be allowed to share the pane, not held rigid',
  );
});

test('panel mappings list has a usable minimum and can grow with the panel', () => {
  const block = cssBlock('.map-left');
  const min = /min-width\s*:\s*(\d+)px/.exec(block);
  assert.ok(min, '.map-left must declare a min-width');
  assert.ok(
    Number(min[1]) >= 240,
    `min-width must leave room for long control names, got ${min[1]}px`,
  );
  assert.match(
    block,
    /flex\s*:/,
    '.map-left must use a flex basis so it grows when the panel is widened',
  );
});

test('panel mappings toolbar wraps instead of clipping its buttons', () => {
  const block = cssBlock('.map-search');
  assert.match(
    block,
    /flex-wrap\s*:\s*wrap/,
    'without wrapping, the category select and Clear button run off the edge',
  );
});
