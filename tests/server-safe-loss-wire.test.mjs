// Copyright © 2026 Gabriel Worm
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
//
// B2, wire half — a control marked `lost: true` must reach applyMapping as a
// deactivation so the target's Safe loss policy decides the value, instead of
// the placeholder number the client sent being applied literally.

// Test files run in parallel and every one that starts a server competes
// for DEFAULT_PREFERRED_PORT; the loser silently falls back to an
// OS-assigned port, which makes the port assertions in
// server-restart-stability.test.mjs flap. This file claims its own.
process.env.RC_SURFACE_PORT = "16170";

import test from "node:test";
import assert from "node:assert/strict";
import { WebSocket } from "ws";
import { startServer, stopServer, actualPort } from "../src/server/state.ts";
import { getControllerToken } from "../src/server/session-auth.ts";
import {
  activeSmooths,
  controlMappings,
  eventModesState,
  lastMappedValues,
  stopSmoothTimer,
} from "../src/live/mappings.ts";
import { clearExtensionContext, setExtensionContext } from "../src/context.ts";

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

function connect() {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${actualPort}/ws?token=${getControllerToken()}`);
    const timer = setTimeout(() => { ws.terminate(); reject(new Error("hello timeout")); }, 5000);
    ws.on("message", (raw) => {
      const msg = JSON.parse(raw.toString());
      if (msg.type !== "hello") return;
      clearTimeout(timer);
      resolve({ ws, role: msg.role });
    });
    ws.on("error", (err) => { clearTimeout(timer); reject(err); });
  });
}

let param;

test.before(async () => {
  param = {
    name: "Dry/Wet", min: 0, max: 1, value: 0,
    setValue: async (v) => { param.value = v; },
  };
  controlMappings.clear();
  lastMappedValues.clear();
  activeSmooths.clear();
  eventModesState.clear();
  setExtensionContext({
    application: { song: { tempo: 120, tracks: [{ devices: [{ parameters: [param] }] }] } },
  });
  controlMappings.set("sensor.vision.x", [
    { type: "device_param", trackIndex: 0, deviceIndex: 0, paramIndex: 0, neutralPolicy: "center" },
  ]);
  await startServer();
});

test.after(async () => {
  stopSmoothTimer();
  clearExtensionContext();
  await stopServer();
});

test("B2 wire: a control flagged lost applies the Safe loss policy, not the sent value", async () => {
  const { ws, role } = await connect();
  assert.equal(role, "controller");

  ws.send(JSON.stringify({ type: "control", control: { name: "sensor.vision.x", value: 0.9 } }));
  await wait(150);
  assert.ok(Math.abs(param.value - 0.9) < 0.02, `live reading should apply, got ${param.value}`);

  // The client has no reading; the 0 it carries is a placeholder only.
  ws.send(JSON.stringify({
    type: "control",
    control: { name: "sensor.vision.x", value: 0, lost: true },
  }));
  await wait(150);

  assert.ok(
    Math.abs(param.value - 0.5) < 0.02,
    `BUG: Safe loss 'center' should park the parameter at 0.5, got ${param.value} ` +
      `(the placeholder 0 was applied literally)`,
  );

  ws.close();
});
