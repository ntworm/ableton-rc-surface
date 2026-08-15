// Copyright © 2026 Gabriel Worm
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Source: https://github.com/ntworm/ableton-rc-surface
//
// client_update used to carry every history ring for every control on every
// send. With a dashboard open that is ~100 KB of mostly-unchanged samples at
// 20 Hz — enough on its own to push the socket past the backpressure drop
// threshold, which then starts discarding the telemetry it is drowning in.
//
// The rings now go out in full once, when a dashboard connects, and as a
// delta after that. The delta is keyed off a monotonic per-control counter,
// not off array length: the ring rotates, so after a rotation the length is
// unchanged while the contents moved underneath.
import test from "node:test";
import assert from "node:assert/strict";
import { WebSocket } from "ws";

import {
  adminSockets,
  appendHistory,
  pushClientUpdate,
  HISTORY_MAX,
} from "../src/server/ws.ts";

function makeClient(id = "client-delta") {
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
    lastData: null,
    history: {},
    historyWritten: {},
    adminHistoryCursor: {},
    ws: { readyState: WebSocket.OPEN, send() {} },
    rateLimiter: { tokens: 60, lastRefill: Date.now(), violations: 0, lastNoticeAt: 0, noticedViolations: 0 },
  };
}

function attachAdmin(received) {
  adminSockets.clear();
  adminSockets.add({
    readyState: WebSocket.OPEN,
    send(message) {
      received.push(JSON.parse(message));
    },
  });
}

/** Push past the throttle window so each call actually emits. */
function pushNow(client) {
  if (client.adminUpdateGate) client.adminUpdateGate.lastAt = 0;
  pushClientUpdate(client);
}

test("the first update after an admin connects carries the full rings", () => {
  const received = [];
  attachAdmin(received);
  try {
    const client = makeClient();
    for (let i = 0; i < 5; i++) appendHistory(client, "pad-1", i / 10, 1000 + i);

    pushClientUpdate(client, { full: true });

    assert.equal(received.length, 1);
    assert.ok(received[0].history, "a fresh dashboard needs everything");
    assert.equal(received[0].history["pad-1"].length, 5);
    assert.equal(received[0].historyDelta, undefined);
  } finally {
    adminSockets.clear();
  }
});

test("later updates carry only samples the admin has not seen", () => {
  const received = [];
  attachAdmin(received);
  try {
    const client = makeClient();
    for (let i = 0; i < 5; i++) appendHistory(client, "pad-1", i / 10, 1000 + i);
    pushClientUpdate(client, { full: true });

    appendHistory(client, "pad-1", 0.9, 2000);
    appendHistory(client, "pad-1", 1.0, 2001);
    pushNow(client);

    const update = received[1];
    assert.equal(update.history, undefined, "the rings are not resent");
    assert.deepEqual(update.historyDelta, { "pad-1": [[2000, 0.9], [2001, 1]] });
  } finally {
    adminSockets.clear();
  }
});

test("a control that did not move contributes nothing to the delta", () => {
  const received = [];
  attachAdmin(received);
  try {
    const client = makeClient();
    appendHistory(client, "pad-1", 0.5, 1000);
    appendHistory(client, "knob-1", 0.5, 1000);
    pushClientUpdate(client, { full: true });

    appendHistory(client, "pad-1", 0.7, 2000);
    pushNow(client);

    assert.deepEqual(Object.keys(received[1].historyDelta), ["pad-1"]);
  } finally {
    adminSockets.clear();
  }
});

test("a rotated ring does not silently swallow the samples that pushed it round", () => {
  const received = [];
  attachAdmin(received);
  try {
    const client = makeClient();
    // Fill the ring exactly, then send it.
    for (let i = 0; i < HISTORY_MAX; i++) appendHistory(client, "pad-1", i / 1000, i);
    pushClientUpdate(client, { full: true });
    assert.equal(received[0].history["pad-1"].length, HISTORY_MAX);

    // Three more samples: the ring stays HISTORY_MAX long but its contents
    // shifted. A length-based cursor would report "nothing new" here.
    for (let i = 0; i < 3; i++) appendHistory(client, "pad-1", 0.9, 9000 + i);
    pushNow(client);

    const delta = received[1].historyDelta["pad-1"];
    assert.equal(delta.length, 3, "the three newest samples must still be delivered");
    assert.deepEqual(delta.map(([ts]) => ts), [9000, 9001, 9002]);
  } finally {
    adminSockets.clear();
  }
});

test("a gap longer than the ring degrades to whatever the ring still holds", () => {
  const received = [];
  attachAdmin(received);
  try {
    const client = makeClient();
    appendHistory(client, "pad-1", 0, 0);
    pushClientUpdate(client, { full: true });

    // Far more samples than the ring can hold arrive before the next push.
    for (let i = 0; i < HISTORY_MAX * 3; i++) appendHistory(client, i / 1000, 0.5, i);
    for (let i = 0; i < HISTORY_MAX * 3; i++) appendHistory(client, "pad-1", 0.5, 5000 + i);
    pushNow(client);

    const delta = received[1].historyDelta["pad-1"];
    assert.equal(delta.length, HISTORY_MAX, "cannot send more than the ring kept");
    assert.equal(delta[delta.length - 1][0], 5000 + HISTORY_MAX * 3 - 1, "the newest sample is present");
  } finally {
    adminSockets.clear();
  }
});

test("a second dashboard connecting re-sends the full rings", () => {
  const received = [];
  attachAdmin(received);
  try {
    const client = makeClient();
    for (let i = 0; i < 4; i++) appendHistory(client, "pad-1", i / 10, i);
    pushClientUpdate(client, { full: true });
    appendHistory(client, "pad-1", 0.9, 500);
    pushNow(client);
    assert.ok(received[1].historyDelta);

    // What setupWssHandlers does when an admin socket opens.
    pushClientUpdate(client, { full: true });

    assert.ok(received[2].history, "the new dashboard holds no rings yet");
    assert.equal(received[2].history["pad-1"].length, 5);
  } finally {
    adminSockets.clear();
  }
});
