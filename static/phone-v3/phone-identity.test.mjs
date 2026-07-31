// Copyright © 2026 Gabriel Worm
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

const source = fs.readFileSync(path.join(import.meta.dirname, 'phone-identity.js'), 'utf8');

function load({ cookie = '', stored = null } = {}) {
  const writes = [];
  const document = {
    get cookie() { return cookie; },
    set cookie(value) { writes.push(value); cookie = value; },
  };
  const localStorage = {
    getItem: () => stored,
    setItem: (_key, value) => { stored = value; },
  };
  const window = {};
  vm.runInNewContext(source, { window, document, localStorage, encodeURIComponent, decodeURIComponent });
  return { api: window.PhoneIdentity, writes, stored: () => stored };
}

test('port-independent cookie wins over per-origin local storage', () => {
  const id = 'd7b61620-d590-4bb2-aac1-dad15db25a86';
  const { api } = load({ cookie: `ableton_rc_client_id=${id}`, stored: 'old-port-id' });
  assert.equal(api.load(), id);
});

test('a server-issued UUID is persisted to both cookie and local storage', () => {
  const id = 'd7b61620-d590-4bb2-aac1-dad15db25a86';
  const state = load();
  assert.equal(state.api.persist(id), id);
  assert.equal(state.stored(), id);
  assert.match(state.writes.at(-1), /ableton_rc_client_id=d7b61620/);
  assert.match(state.writes.at(-1), /SameSite=Strict/);
});

test('invalid client IDs are ignored', () => {
  const state = load({ cookie: 'ableton_rc_client_id=not-a-uuid', stored: 'also-bad' });
  assert.equal(state.api.load(), null);
  assert.equal(state.api.persist('../bad'), null);
});

test('phone connection has a heartbeat deadline and immediate online/offline handling', () => {
  // Heartbeat and online/offline handling moved to modules/session.js
  const session = fs.readFileSync(path.join(import.meta.dirname, 'modules/session.js'), 'utf8');
  assert.match(session, /HEARTBEAT_TIMEOUT_MS/);
  assert.match(session, /Date\.now\(\) - lastPongAt > HEARTBEAT_TIMEOUT_MS/);
  assert.match(session, /addEventListener\(['"]offline['"]/);
  assert.match(session, /addEventListener\(['"]online['"]/);
  assert.match(session, /CONNECTION LOST/);
});
