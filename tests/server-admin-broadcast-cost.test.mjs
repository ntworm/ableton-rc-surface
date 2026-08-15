// Copyright © 2026 Gabriel Worm
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Source: https://github.com/ntworm/ableton-rc-surface
//
// The admin feed is a monitor, and it must cost nothing while nobody is
// watching. Two guarantees are pinned here:
//
//   1. With no admin socket attached, a client_update never serialises the
//      payload. pushClientUpdate() carries the client's whole history ring and
//      is called from the snapshot path (30 Hz) and the host-modulator tick
//      (250 Hz per active LFO) — a gig with no dashboard open used to pay for
//      every one of those stringifies and throw the result away.
//   2. With an admin attached, a burst of updates for one client coalesces
//      instead of emitting one frame per producer tick.
import test from "node:test";
import assert from "node:assert/strict";
import { WebSocket } from "ws";

import {
  adminSockets,
  broadcastToAdmins,
  pushClientUpdate,
  CLIENT_UPDATE_MIN_INTERVAL_MS,
} from "../src/server/ws.ts";

function makeClient(id = "client-cost") {
  return {
    id,
    ipAddress: "127.0.0.1",
    displayName: "",
    role: "controller",
    tokenStatus: "valid",
    isAdmin: false,
    mode: "performance",
    path: "/ws",
    connectedAt: Date.now(),
    lastSeen: Date.now(),
    userAgent: "test",
    lastData: { controls: [{ name: "toggle-1", value: 0.5 }] },
    history: { "toggle-1": [[Date.now(), 0.5]] },
    historyWritten: { "toggle-1": 1 },
    adminHistoryCursor: {},
    ws: { readyState: WebSocket.OPEN, send() {} },
    rateLimiter: { tokens: 60, lastRefill: Date.now(), violations: 0 },
  };
}

test("broadcastToAdmins does not serialise the payload when no admin is listening", () => {
  adminSockets.clear();
  let serialised = 0;
  const payload = {
    type: "client_update",
    get history() {
      serialised++;
      return {};
    },
  };

  broadcastToAdmins(payload);

  assert.equal(serialised, 0, "payload must not be touched with no admin attached");
});

test("pushClientUpdate is a no-op while no admin is attached", () => {
  adminSockets.clear();
  let serialised = 0;
  const client = makeClient("client-noadmin");
  Object.defineProperty(client.history, "toggle-1", {
    enumerable: true,
    get() {
      serialised++;
      return [];
    },
  });

  for (let i = 0; i < 100; i++) pushClientUpdate(client);

  assert.equal(serialised, 0, "history must not be serialised with no admin attached");
});

test("pushClientUpdate coalesces a burst into a leading emit plus one trailing emit", async () => {
  adminSockets.clear();
  const received = [];
  const adminSocket = {
    readyState: WebSocket.OPEN,
    send(message) {
      received.push(JSON.parse(message));
    },
  };
  adminSockets.add(adminSocket);

  try {
    const client = makeClient("client-burst");
    // A quarter second of host-modulator ticks at 250 Hz.
    for (let i = 0; i < 64; i++) pushClientUpdate(client);

    assert.equal(received.length, 1, "the first update of a burst goes out immediately");

    await new Promise((resolve) => setTimeout(resolve, CLIENT_UPDATE_MIN_INTERVAL_MS + 30));

    assert.equal(received.length, 2, "the rest of the burst coalesces into one trailing emit");
    assert.equal(received[1].type, "client_update");
    assert.equal(received[1].client.client_id, "client-burst");
  } finally {
    adminSockets.clear();
  }
});

test("an immediate push (disconnect) is never held back by a pending trailing emit", async () => {
  adminSockets.clear();
  const received = [];
  adminSockets.add({
    readyState: WebSocket.OPEN,
    send(message) {
      received.push(JSON.parse(message));
    },
  });

  try {
    const client = makeClient("client-immediate");
    pushClientUpdate(client); // leading emit
    pushClientUpdate(client); // schedules a trailing emit
    assert.equal(received.length, 1);

    client.lastSeen = 0;
    pushClientUpdate(client, { immediate: true });

    assert.equal(received.length, 2, "the disconnect notice must not wait for the window");
    assert.equal(received[1].client.status, "stale");

    // The superseded trailing emit must have been cancelled, not fired late.
    await new Promise((resolve) => setTimeout(resolve, CLIENT_UPDATE_MIN_INTERVAL_MS + 30));
    assert.equal(received.length, 2, "the cancelled trailing emit must not resurface");
  } finally {
    adminSockets.clear();
  }
});
