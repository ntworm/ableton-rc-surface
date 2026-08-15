// Copyright © 2026 Gabriel Worm
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Source: https://github.com/ntworm/ableton-rc-surface
//
// A phone's client_id lives in localStorage and a cookie, so every tab of the
// same origin claims the same one. The server keeps one socket per id, which
// means two open tabs evict each other — and a tab told only "closed"
// reconnects a second later and evicts the one that replaced it. The two then
// trade the session back and forth for as long as both stay open, each swap
// dropping the connection for a moment.
//
// The close now carries a code that says *why*, so the displaced tab can stop
// instead of retrying into a tug of war.
process.env.RC_SURFACE_PORT = "16220";

import test from "node:test";
import assert from "node:assert/strict";
import { WebSocket } from "ws";
import path from "node:path";

if (typeof globalThis.__dirname === "undefined") {
  globalThis.__dirname = path.join(process.cwd(), "dist");
}

const serverState = await import("../src/server/state.ts");
const { getControllerToken } = await import("../src/server/session-auth.ts");
const { SESSION_REPLACED_CODE } = await import("../src/server/ws.ts");

const CLIENT_ID = "11111111-2222-4333-8444-555555555555";
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function openPhone(port, clientId = CLIENT_ID) {
  const ws = new WebSocket(
    `ws://127.0.0.1:${port}/ws?token=${getControllerToken()}&client_id=${clientId}`,
  );
  const closed = new Promise((resolve) => {
    ws.on("close", (code, reason) => resolve({ code, reason: reason.toString() }));
  });
  const hello = new Promise((resolve, reject) => {
    ws.on("message", (data) => {
      const msg = JSON.parse(data.toString());
      if (msg.type === "hello") resolve(msg);
    });
    ws.once("error", reject);
  });
  return { ws, closed, hello };
}

test("the displaced tab is told its session was replaced, not merely closed", async () => {
  await serverState.startServer();
  const port = serverState.actualPort;
  try {
    const first = openPhone(port);
    await first.hello;

    const second = openPhone(port);
    await second.hello;

    const { code, reason } = await first.closed;
    assert.equal(
      code,
      SESSION_REPLACED_CODE,
      "a bare close is indistinguishable from a dropped link, and gets retried",
    );
    assert.match(reason, /replaced/i);

    second.ws.close();
  } finally {
    await serverState.stopServer();
  }
});

test("a different client_id is left alone", async () => {
  await serverState.startServer();
  const port = serverState.actualPort;
  try {
    const phone = openPhone(port, CLIENT_ID);
    await phone.hello;

    const laptop = openPhone(port, "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee");
    await laptop.hello;
    await sleep(150);

    assert.equal(
      phone.ws.readyState,
      WebSocket.OPEN,
      "two different devices are two views on the surface, not a conflict",
    );

    phone.ws.close();
    laptop.ws.close();
  } finally {
    await serverState.stopServer();
  }
});
