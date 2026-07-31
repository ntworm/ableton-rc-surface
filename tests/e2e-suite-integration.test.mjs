// Copyright © 2026 Gabriel Worm
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Source: https://github.com/ntworm/ableton-rc-surface
//
// End-to-End Suite Integration Tests for RC Surface & RC Mixer (Task 6.3 / ADR-004)

import test from "node:test";
import assert from "node:assert/strict";
import WebSocket from "ws";
import { startServer, stopServer, actualPort } from "../src/server/state.ts";
import { getControllerToken, getAdminToken } from "../src/server/session-auth.ts";
import { setExtensionContext, clearExtensionContext } from "../src/context.ts";

test.beforeEach(() => {
  setExtensionContext({
    application: {
      song: {
        tempo: 120,
        rootNote: 0,
        scaleName: "Major",
        tracks: [
          {
            name: "Track 1",
            mute: false,
            arm: false,
            solo: false,
            constructor: { name: "MidiTrack" },
            devices: [],
          },
        ],
        scenes: [],
      },
    },
  });
});

test.afterEach(() => {
  clearExtensionContext();
});

async function openTestWs(url) {
  const ws = new WebSocket(url);
  const messages = [];
  ws.on("message", (d) => {
    try { messages.push(JSON.parse(d.toString())); } catch {}
  });
  await new Promise((resolve, reject) => {
    ws.on("open", resolve);
    ws.on("error", reject);
  });
  const start = Date.now();
  while (!messages.some((m) => m && m.type === "hello") && Date.now() - start < 1000) {
    await new Promise((r) => setTimeout(r, 10));
  }
  const helloMsg = messages.find((m) => m && m.type === "hello") || null;
  return { ws, helloMsg, messages };
}

test("E2E Suite: Full lifecycle connection, authentication, command dispatch and teardown", async () => {
  await startServer();
  try {
    const port = actualPort;
    assert.ok(port, "server port must be bound");

    const controllerToken = getControllerToken();
    const adminToken = getAdminToken();

    // 1. Controller WS connection
    const ctrlConn = await openTestWs(`ws://127.0.0.1:${port}/ws?token=${controllerToken}`);
    assert.ok(ctrlConn.helloMsg, "controller must receive hello message");
    assert.equal(ctrlConn.helloMsg.role, "controller", "controller role must be verified");

    // Execute state read command
    const statePromise = new Promise((resolve) => {
      const handler = (d) => {
        const msg = JSON.parse(d.toString());
        if (msg.id === "e2e-cmd-state") {
          ctrlConn.ws.off("message", handler);
          resolve(msg);
        }
      };
      ctrlConn.ws.on("message", handler);
    });
    ctrlConn.ws.send(JSON.stringify({ id: "e2e-cmd-state", cmd: "getState", args: {} }));
    const stateRes = await statePromise;
    assert.equal(stateRes.ok, true, "getState must return ok:true for controller");

    // 2. Admin WS connection
    const adminConn = await openTestWs(`ws://127.0.0.1:${port}/admin/ws?token=${adminToken}`);
    assert.ok(adminConn.helloMsg, "admin must receive hello message");
    assert.equal(adminConn.helloMsg.role, "admin", "admin role must be verified");

    // Clean close
    ctrlConn.ws.close();
    adminConn.ws.close();
  } finally {
    await stopServer();
  }
});
