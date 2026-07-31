// Copyright © 2026 Gabriel Worm
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
//
// ROOT CAUSE C1 — the app opens on a fully black page.
//
// Every call to show() persists the page as activePage, including the
// pseudo-page "mapping" that the MAP overlay sets. "mapping" has no
// .page[data-page="mapping"] element: openMappingMode() compensates by
// un-hiding the previous page right after. On the NEXT page load the saved
// state is restored with showPhonePage('mapping'), that compensation never
// runs, and show() hides every real page — a black screen until the user
// taps a tab.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';

const source = fs.readFileSync(path.join(import.meta.dirname, 'modules/layout.js'), 'utf8');

function loadLayout() {
  const pages = ['performance', 'mix', 'snapshots', 'sensors', 'audio', 'vision'].map((name) => ({
    dataset: { page: name },
    hidden: false,
    classList: {
      toggle(cls, on) { if (cls === 'hidden') this.owner.hidden = !!on; },
    },
  }));
  for (const p of pages) p.classList.owner = p;

  const tabs = pages.map((p) => ({
    dataset: { page: p.dataset.page },
    classList: { toggle() {} },
    setAttribute() {},
    addEventListener() {},
  }));

  const saved = [];
  const body = { dataset: {} };
  const context = {
    window: null,
    document: {
      body,
      querySelectorAll: (sel) => (sel === '.page' ? pages : tabs),
    },
    CustomEvent: class { constructor(t, i) { this.type = t; this.detail = i?.detail; } },
    Event: class { constructor(t) { this.type = t; } },
    setTimeout: () => 1,
    console,
  };
  context.window = context;
  context.globalThis = context;
  context.dispatchEvent = () => {};
  context.sendPhoneCommand = (cmd, args) => { saved.push({ cmd, args }); return true; };
  vm.runInNewContext(source, context, { filename: 'layout.js' });
  context.RCSurface.setupLayout();
  return { context, pages, body, saved };
}

test('C1: startup shows the performance page', () => {
  const { pages, body } = loadLayout();
  assert.equal(body.dataset.page, 'performance');
  const visible = pages.filter((p) => !p.hidden).map((p) => p.dataset.page);
  assert.deepEqual(visible, ['performance']);
});

test('C1: restoring a persisted "mapping" page must not blank every page', () => {
  const { context, pages, body } = loadLayout();

  // This is exactly what app.js does with clientState.pages.activePage.
  context.showPhonePage('mapping');

  const visible = pages.filter((p) => !p.hidden).map((p) => p.dataset.page);
  assert.ok(
    visible.length > 0,
    'BUG CONFIRMED: restoring the MAP pseudo-page hides every real page, ' +
      'so the app opens on a black screen until a tab is tapped',
  );
  assert.equal(body.dataset.page, 'performance', 'should fall back to a real page');
});

test('C1: the MAP pseudo-page is never persisted as the active page', () => {
  const { context, saved } = loadLayout();
  saved.length = 0;

  context.showPhonePage('mapping');

  const persistedPages = saved
    .filter((s) => s.cmd === 'saveProjectClientState')
    .map((s) => s.args?.pages?.activePage);
  assert.equal(
    persistedPages.includes('mapping'),
    false,
    'persisting a pseudo-page is what poisons the next session',
  );
});

test('C1: a real page still switches and is still persisted', () => {
  const { context, pages, body, saved } = loadLayout();
  saved.length = 0;

  context.showPhonePage('vision');

  assert.equal(body.dataset.page, 'vision');
  assert.deepEqual(pages.filter((p) => !p.hidden).map((p) => p.dataset.page), ['vision']);
  assert.equal(
    saved.some((s) => s.cmd === 'saveProjectClientState' && s.args?.pages?.activePage === 'vision'),
    true,
  );
});
