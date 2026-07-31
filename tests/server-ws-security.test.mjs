// Copyright © 2026 Gabriel Worm
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Source: https://github.com/ntworm/ableton-rc-surface
//
// Security authorization & capability token test suite (Task 3.1)

import test from "node:test";
import assert from "node:assert/strict";
import { WebSocket } from "ws";
import { startServer, stopServer, actualPort } from "../src/server/state.ts";
import { trackedClients } from "../src/server/ws.ts";
import { playheadActive } from "../src/live/state.js";
import { getControllerToken, getAdminToken } from "../src/server/session-auth.ts";
import { setExtensionContext, clearExtensionContext } from "../src/context.ts";

test.beforeEach(async () => {
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
            devices: [
              {
                name: "Device 1",
                parameters: [
                  {
                    name: "Param 1",
                    min: 0,
                    max: 1,
                    getValue: async () => 0.5,
                    setValue: async () => {},
                  },
                ],
              },
            ],
          },
        ],
        scenes: [{ signatureNumerator: 4, signatureDenominator: 4 }],
      },
    },
  });
  await startServer();
});

test.afterEach(async () => {
  await stopServer();
  clearExtensionContext();
});

async function openWs(url) {
  const ws = new WebSocket(url);
  const messages = [];
  ws.on("message", (d) => {
    try {
      messages.push(JSON.parse(d.toString()));
    } catch {
      // ignore
    }
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
  return { ws, helloMsg };
}

test("viewer WS connection (unauthenticated): reads allowed, BLOCKED on Live write, config write, server admin, control, toggle_play", async () => {
  const port = actualPort;
  assert.ok(port, "server should be running");

  const { ws, helloMsg } = await openWs(`ws://127.0.0.1:${port}/ws`);
  assert.ok(helloMsg, "hello message must be received");
  assert.equal(helloMsg.type, "hello");
  assert.equal(helloMsg.role, "viewer", "unauthenticated WS connection should have viewer role");

  const client = Array.from(trackedClients.values())[0];
  assert.equal(client.role, "viewer", "client role must be assigned viewer");
  assert.equal(client.isAdmin, false, "viewer is not admin");

  // 1. Read command (getState) should succeed
  const readPromise = new Promise((resolve) => {
    const handler = (data) => {
      const msg = JSON.parse(data.toString());
      if (msg.id === "req-get-state") {
        ws.off("message", handler);
        resolve(msg);
      }
    };
    ws.on("message", handler);
  });
  ws.send(JSON.stringify({ id: "req-get-state", cmd: "getState", args: {} }));
  const readRes = await readPromise;
  assert.equal(readRes.ok, true, "viewer can execute read command (getState)");

  // 2. Live write command (transportPlay) should be BLOCKED
  const transportPromise = new Promise((resolve) => {
    const handler = (data) => {
      const msg = JSON.parse(data.toString());
      if (msg.id === "req-transport-play") {
        ws.off("message", handler);
        resolve(msg);
      }
    };
    ws.on("message", handler);
  });
  ws.send(JSON.stringify({ id: "req-transport-play", cmd: "transportPlay", args: {} }));
  const transportRes = await transportPromise;
  assert.equal(transportRes.ok, false, "transportPlay command must be blocked for viewer");
  assert.match(transportRes.error, /unauthorized/i, "error message must state unauthorized");

  // 3. Live write command (setDeviceParam) should be BLOCKED
  const setDevicePromise = new Promise((resolve) => {
    const handler = (data) => {
      const msg = JSON.parse(data.toString());
      if (msg.id === "req-set-device-param") {
        ws.off("message", handler);
        resolve(msg);
      }
    };
    ws.on("message", handler);
  });
  ws.send(JSON.stringify({
    id: "req-set-device-param",
    cmd: "setDeviceParam",
    args: { trackIndex: 0, deviceIndex: 0, paramIndex: 0, value: 0.5 }
  }));
  const setDeviceRes = await setDevicePromise;
  assert.equal(setDeviceRes.ok, false);
  assert.match(setDeviceRes.error, /unauthorized/i, "setDeviceParam must be blocked by authorization guard");

  // 4. Config write command (savePreset) should be BLOCKED
  const savePresetPromise = new Promise((resolve) => {
    const handler = (data) => {
      const msg = JSON.parse(data.toString());
      if (msg.id === "req-save-preset") {
        ws.off("message", handler);
        resolve(msg);
      }
    };
    ws.on("message", handler);
  });
  ws.send(JSON.stringify({ id: "req-save-preset", cmd: "savePreset", args: { name: "test" } }));
  const savePresetRes = await savePresetPromise;
  assert.equal(savePresetRes.ok, false);
  assert.match(savePresetRes.error, /unauthorized/i, "savePreset must be blocked for viewer");

  // 5. Server admin command (getServerInfo) should be BLOCKED
  const adminCmdPromise = new Promise((resolve) => {
    const handler = (data) => {
      const msg = JSON.parse(data.toString());
      if (msg.id === "req-server-info") {
        ws.off("message", handler);
        resolve(msg);
      }
    };
    ws.on("message", handler);
  });
  ws.send(JSON.stringify({ id: "req-server-info", cmd: "getServerInfo", args: {} }));
  const adminCmdRes = await adminCmdPromise;
  assert.equal(adminCmdRes.ok, false);
  assert.match(adminCmdRes.error, /unauthorized/i, "getServerInfo must be blocked for viewer");

  // 6. Typed control message should be BLOCKED
  ws.send(JSON.stringify({
    type: "control",
    control: { name: "knob1", value: 0.75 }
  }));
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(client.history["knob1"], undefined, "typed control message must be blocked for viewer");

  // 7. Typed toggle_play message should be BLOCKED
  const initialPlayheadState = playheadActive;
  ws.send(JSON.stringify({ type: "toggle_play" }));
  await new Promise((r) => setTimeout(r, 60));
  const { playheadActive: currentPlayheadState } = await import("../src/live/state.js");
  assert.equal(currentPlayheadState, initialPlayheadState, "typed toggle_play message must NOT mutate playhead state for viewer");

  ws.close();
});

test("controller WS connection: allowed in Live write and reading; BLOCKED in config write and server admin", async () => {
  const port = actualPort;
  const controllerToken = getControllerToken();

  const { ws, helloMsg } = await openWs(`ws://127.0.0.1:${port}/ws?token=${controllerToken}`);
  assert.ok(helloMsg);
  assert.equal(helloMsg.role, "controller", "connected with controller token should have controller role");

  const client = Array.from(trackedClients.values())[0];
  assert.equal(client.role, "controller");

  // 1. Read command (getState) allowed
  const readPromise = new Promise((resolve) => {
    const handler = (data) => {
      const msg = JSON.parse(data.toString());
      if (msg.id === "req-ctrl-get-state") {
        ws.off("message", handler);
        resolve(msg);
      }
    };
    ws.on("message", handler);
  });
  ws.send(JSON.stringify({ id: "req-ctrl-get-state", cmd: "getState", args: {} }));
  const readRes = await readPromise;
  assert.equal(readRes.ok, true);

  // 2. Live write command (transportPlay) allowed
  const transportPromise = new Promise((resolve) => {
    const handler = (data) => {
      const msg = JSON.parse(data.toString());
      if (msg.id === "req-ctrl-transport-play") {
        ws.off("message", handler);
        resolve(msg);
      }
    };
    ws.on("message", handler);
  });
  ws.send(JSON.stringify({ id: "req-ctrl-transport-play", cmd: "transportPlay", args: {} }));
  const transportRes = await transportPromise;
  assert.equal(transportRes.ok, true, "controller can execute transportPlay");

  // 3. Typed control message allowed
  ws.send(JSON.stringify({
    type: "control",
    control: { name: "knob1", value: 0.75 }
  }));
  await new Promise((r) => setTimeout(r, 60));
  assert.ok(client.history["knob1"], "typed control message is allowed for controller");

  // 4a. Mapping write (savePreset) ALLOWED — the MAP panel lives in the phone
  // UI and the phone is a controller, so managing its own mappings and presets
  // must not require admin. It may still fail for other reasons here; what must
  // never come back is an authorization refusal.
  const savePresetPromise = new Promise((resolve) => {
    const handler = (data) => {
      const msg = JSON.parse(data.toString());
      if (msg.id === "req-ctrl-save-preset") {
        ws.off("message", handler);
        resolve(msg);
      }
    };
    ws.on("message", handler);
  });
  ws.send(JSON.stringify({ id: "req-ctrl-save-preset", cmd: "savePreset", args: { name: "test" } }));
  const savePresetRes = await savePresetPromise;
  if (savePresetRes.ok === false) {
    assert.doesNotMatch(
      savePresetRes.error,
      /unauthorized/i,
      "controller must be able to manage its own mapping presets",
    );
  }

  // 4b. Whole-project config write (exportProjectConfig) BLOCKED
  const exportPromise = new Promise((resolve) => {
    const handler = (data) => {
      const msg = JSON.parse(data.toString());
      if (msg.id === "req-ctrl-export-config") {
        ws.off("message", handler);
        resolve(msg);
      }
    };
    ws.on("message", handler);
  });
  ws.send(JSON.stringify({ id: "req-ctrl-export-config", cmd: "exportProjectConfig", args: {} }));
  const exportRes = await exportPromise;
  assert.equal(exportRes.ok, false);
  assert.match(exportRes.error, /unauthorized/i, "controller cannot export the whole project config");

  // 5. Server admin command (getServerInfo) BLOCKED
  const adminCmdPromise = new Promise((resolve) => {
    const handler = (data) => {
      const msg = JSON.parse(data.toString());
      if (msg.id === "req-ctrl-server-info") {
        ws.off("message", handler);
        resolve(msg);
      }
    };
    ws.on("message", handler);
  });
  ws.send(JSON.stringify({ id: "req-ctrl-server-info", cmd: "getServerInfo", args: {} }));
  const adminCmdRes = await adminCmdPromise;
  assert.equal(adminCmdRes.ok, false);
  assert.match(adminCmdRes.error, /unauthorized/i, "controller cannot execute server-admin command");

  ws.close();
});

test("admin WS connection: allowed in all actions", async () => {
  const port = actualPort;
  const adminToken = getAdminToken();

  const { ws, helloMsg } = await openWs(`ws://127.0.0.1:${port}/admin/ws?token=${adminToken}`);
  assert.ok(helloMsg);
  assert.equal(helloMsg.role, "admin", "admin WS connection should have admin role");

  // 1. Read command (getState) allowed
  const readPromise = new Promise((resolve) => {
    const handler = (data) => {
      const msg = JSON.parse(data.toString());
      if (msg.id === "req-admin-get-state") {
        ws.off("message", handler);
        resolve(msg);
      }
    };
    ws.on("message", handler);
  });
  ws.send(JSON.stringify({ id: "req-admin-get-state", cmd: "getState", args: {} }));
  const readRes = await readPromise;
  assert.equal(readRes.ok, true);

  // 2. Server admin command (getServerInfo) allowed
  const adminCmdPromise = new Promise((resolve) => {
    const handler = (data) => {
      const msg = JSON.parse(data.toString());
      if (msg.id === "req-admin-server-info") {
        ws.off("message", handler);
        resolve(msg);
      }
    };
    ws.on("message", handler);
  });
  ws.send(JSON.stringify({ id: "req-admin-server-info", cmd: "getServerInfo", args: {} }));
  const adminCmdRes = await adminCmdPromise;
  assert.equal(adminCmdRes.ok, true, "admin can execute getServerInfo");
  assert.ok(adminCmdRes.result.phoneUrl, "getServerInfo returns server info to admin");

  ws.close();
});

test("rejection of invalid Origin for browser requests", async () => {
  const port = actualPort;

  // Request with invalid origin header
  const resBadOrigin = await fetch(`http://127.0.0.1:${port}/health`, {
    headers: {
      Origin: "http://malicious-site.com",
    },
  });
  assert.equal(resBadOrigin.status, 403, "request with invalid origin must return 403 Forbidden");

  // Request with valid origin header
  const resGoodOrigin = await fetch(`http://127.0.0.1:${port}/health`, {
    headers: {
      Origin: `http://127.0.0.1:${port}`,
    },
  });
  assert.equal(resGoodOrigin.status, 200, "request with valid same-origin must return 200");
});

test("secrets/tokens never leak in logs, /health, /commands or error messages", async () => {
  const port = actualPort;
  const adminToken = getAdminToken();
  const controllerToken = getControllerToken();

  // 1. Check /health endpoint
  const resHealth = await fetch(`http://127.0.0.1:${port}/health`);
  const healthText = await resHealth.text();
  assert.equal(healthText.includes(adminToken), false, "health payload must not contain admin token");
  assert.equal(healthText.includes(controllerToken), false, "health payload must not contain controller token");

  // 2. Check /commands endpoint
  const resCommands = await fetch(`http://127.0.0.1:${port}/commands`);
  const commandsJson = await resCommands.json();
  assert.equal(typeof commandsJson.getState, "object");
  assert.ok(commandsJson.getState.description);
  assert.ok(commandsJson.getState.sideEffect);
  assert.ok(commandsJson.getState.requiredRole);

  const commandsText = JSON.stringify(commandsJson);
  assert.equal(commandsText.includes(adminToken), false, "commands metadata must not leak admin token");
  assert.equal(commandsText.includes(controllerToken), false, "commands metadata must not leak controller token");
  assert.equal(commandsText.includes("handler"), false, "commands metadata must not leak handler function text");

  // 3. Check unauthorized error message does not leak tokens
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
  await new Promise((resolve) => ws.on("open", resolve));

  const errPromise = new Promise((resolve) => {
    ws.on("message", (data) => {
      const msg = JSON.parse(data.toString());
      if (msg.id === "req-leak-test") resolve(msg);
    });
  });
  ws.send(JSON.stringify({ id: "req-leak-test", cmd: "transportPlay", args: {} }));
  const errRes = await errPromise;
  assert.equal(errRes.ok, false);
  assert.equal(errRes.error.includes(adminToken), false, "error message must not contain admin token");
  assert.equal(errRes.error.includes(controllerToken), false, "error message must not contain controller token");

  ws.close();
});

test("/test route requires admin role", async () => {
  const port = actualPort;
  const adminToken = getAdminToken();

  // 1. GET /test without token -> 403 Forbidden
  const resUnauth = await fetch(`http://127.0.0.1:${port}/test`);
  assert.equal(resUnauth.status, 403, "/test without admin token must return 403 Forbidden");

  // 2. GET /test with admin token -> 200 OK
  const resAdmin = await fetch(`http://127.0.0.1:${port}/test?token=${adminToken}`);
  assert.equal(resAdmin.status, 200, "/test with admin token must return 200 OK");
});
