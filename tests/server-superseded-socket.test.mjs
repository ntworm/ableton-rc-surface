// Copyright © 2026 Gabriel Worm
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Source: https://github.com/ntworm/ableton-rc-surface
//
// A phone keeps its client_id across reconnects (localStorage + cookie, shared
// by every tab of the same origin). When it reconnects, the server closes the
// previous socket for that id — and the OLD socket's close handler then runs
// *after* the new session is already live and tracked.
//
// That handler used to tear down state by client_id unconditionally: it killed
// the running LFOs, ran the safe-loss release ramp over the mappings, and told
// every dashboard the client had gone stale. All of it aimed at a client_id
// that was, at that moment, connected and playing on a newer socket.
//
// The visible symptom was the panel's performance card blinking out and back
// (it deletes any client it is told is stale) while modulators died underneath.
// The guarded delete two lines below was already asking the right question —
// "am I still the current socket?" — the rest of the handler just never asked it.
process.env.RC_SURFACE_PORT = "16200";
let nextSessionPort = 16200;

import test from "node:test";
import assert from "node:assert/strict";
import { WebSocket } from "ws";
import path from "node:path";

if (typeof globalThis.__dirname === "undefined") {
  globalThis.__dirname = path.join(process.cwd(), "dist");
}

const serverState = await import("../src/server/state.ts");
const { getControllerToken, getAdminToken } = await import("../src/server/session-auth.ts");
const { trackedClients } = await import("../src/server/ws.ts");
const { hostModulators, controlMappings, stopHostModulatorLoop } = await import(
  "../src/live/mappings.ts"
);
const { setExtensionContext, clearExtensionContext } = await import("../src/context.ts");

const CLIENT_ID = "11111111-2222-4333-8444-555555555555";

function waitFor(ws, predicate, timeoutMs = 3000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timed out waiting for message")), timeoutMs);
    ws.on("message", (data) => {
      let msg;
      try {
        msg = JSON.parse(data.toString());
      } catch {
        return;
      }
      if (!predicate(msg)) return;
      clearTimeout(timer);
      resolve(msg);
    });
    ws.on("error", reject);
  });
}

function open(ws) {
  return new Promise((resolve, reject) => {
    ws.once("open", resolve);
    ws.once("error", reject);
  });
}

/**
 * Open a phone socket and hand back its hello.
 *
 * The waiter is armed before the open is awaited: the server sends hello the
 * moment the connection is up, and a listener attached after that point misses
 * it entirely.
 */
async function openPhone(port) {
  const ws = new WebSocket(phoneUrl(port));
  const hello = waitFor(ws, (m) => m.type === "hello");
  try {
    await open(ws);
    await hello;
  } catch (err) {
    // Both waiters observe the same socket error. Drain the hello waiter so a
    // failed connect cannot escape as an unhandled rejection after the test.
    await hello.catch(() => undefined);
    throw err;
  }
  return ws;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function withSession(fn) {
  // Windows may briefly reject a new client connection to the same endpoint
  // after the preceding WebSocket session closes. Give each test its own
  // HTTP/HTTPS pair while keeping the whole file in a reserved port range.
  process.env.RC_SURFACE_PORT = String(nextSessionPort);
  nextSessionPort += 2;
  await serverState.startServer();
  const port = serverState.actualPort;
  const admin = new WebSocket(`ws://127.0.0.1:${port}/admin/ws?token=${getAdminToken()}`);
  const adminMessages = [];
  admin.on("message", (data) => {
    try {
      adminMessages.push(JSON.parse(data.toString()));
    } catch {
      /* ignore */
    }
  });
  await open(admin);
  await sleep(50);
  adminMessages.length = 0;

  try {
    return await fn({ port, admin, adminMessages });
  } finally {
    if (admin.readyState === WebSocket.OPEN) admin.close();
    stopHostModulatorLoop();
    hostModulators.clear();
    controlMappings.clear();
    clearExtensionContext();
    await serverState.stopServer();
  }
}

function phoneUrl(port) {
  return `ws://127.0.0.1:${port}/ws?token=${getControllerToken()}&client_id=${CLIENT_ID}`;
}

test("a superseded socket does not report its client as gone", async () => {
  await withSession(async ({ port, adminMessages }) => {
    const first = await openPhone(port);
    await sleep(50);
    adminMessages.length = 0;

    // The same phone reconnects — a second tab, a page reload, a dropped
    // wifi frame. The server closes `first` in favour of `second`.
    const second = await openPhone(port);
    await sleep(200); // let the superseded close handler run

    const staleNotices = adminMessages.filter(
      (m) => m.type === "client_update" && m.client.client_id === CLIENT_ID && m.client.status === "stale",
    );
    assert.equal(
      staleNotices.length,
      0,
      "the client is connected on a newer socket; announcing it stale makes every " +
        "dashboard drop it and blink",
    );
    assert.ok(trackedClients.has(CLIENT_ID), "the live session must stay tracked");

    second.close();
  });
});

test("a superseded socket does not kill the new session's modulators", async () => {
  await withSession(async ({ port }) => {
    setExtensionContext({
      application: {
        song: { tempo: 120, tracks: [{ devices: [{ parameters: [{ min: 0, max: 1, setValue() {} }] }] }] },
      },
    });
    controlMappings.set("toggle-1", [
      { type: "device_param", trackIndex: 0, deviceIndex: 0, paramIndex: 0 },
    ]);

    const first = await openPhone(port);

    // The phone turns an LFO on, then reconnects.
    first.send(
      JSON.stringify({
        type: "modulator",
        client_id: CLIENT_ID,
        modulator: { kind: "lfo", name: "toggle-1", active: true, rate: 0.5, depth: 1, syncMode: "free" },
      }),
    );
    await sleep(80);
    assert.equal(hostModulators.size, 1, "precondition: the LFO is running");

    const second = await openPhone(port);
    await sleep(200);

    assert.equal(
      hostModulators.size,
      1,
      "the reconnecting phone owns this modulator; the socket it replaced must not stop it",
    );

    second.close();
  });
});

test("a genuine disconnect still reports the client as gone", async () => {
  await withSession(async ({ port, adminMessages }) => {
    const only = await openPhone(port);
    await sleep(50);
    adminMessages.length = 0;

    only.close();
    await sleep(200);

    const staleNotices = adminMessages.filter(
      (m) => m.type === "client_update" && m.client.client_id === CLIENT_ID && m.client.status === "stale",
    );
    assert.equal(staleNotices.length, 1, "a real disconnect must still be announced exactly once");
    assert.ok(!trackedClients.has(CLIENT_ID), "and the client must be dropped");
  });
});
