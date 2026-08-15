// Copyright © 2026 Gabriel Worm
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Source: https://github.com/ntworm/ableton-rc-surface
//
// One surface, many views.
//
// Two phones (or a phone and a laptop) are two windows onto the *same* control
// surface, not two independent surfaces. Moving fader-1 on one has to show up
// on the other, the way it would if both performers had a hand on the same
// physical mixer. Before this, each browser kept its own control state and
// nobody told anybody: you moved a fader on the phone and the laptop sat still.
//
// Two things must not happen. A client must never be sent its own move back —
// the echo fights the finger that is still on the control. And sensor streams
// must never fan out: my phone's tilt is not your phone's tilt.
process.env.RC_SURFACE_PORT = "16210";

import test from "node:test";
import assert from "node:assert/strict";
import { WebSocket } from "ws";
import path from "node:path";

if (typeof globalThis.__dirname === "undefined") {
  globalThis.__dirname = path.join(process.cwd(), "dist");
}

const serverState = await import("../src/server/state.ts");
const { getControllerToken } = await import("../src/server/session-auth.ts");

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function open(ws) {
  return new Promise((resolve, reject) => {
    ws.once("open", resolve);
    ws.once("error", reject);
  });
}

/** Open a phone socket, collecting everything it is sent. */
async function openPhone(port, clientId) {
  const ws = new WebSocket(
    `ws://127.0.0.1:${port}/ws?token=${getControllerToken()}&client_id=${clientId}`,
  );
  const received = [];
  let helloResolve;
  const hello = new Promise((resolve) => {
    helloResolve = resolve;
  });
  ws.on("message", (data) => {
    let msg;
    try {
      msg = JSON.parse(data.toString());
    } catch {
      return;
    }
    received.push(msg);
    if (msg.type === "hello") helloResolve(msg);
  });
  await open(ws);
  await hello;
  return { ws, received };
}

function syncedControls(received) {
  const merged = {};
  for (const msg of received) {
    if (msg.type !== "control_sync") continue;
    Object.assign(merged, msg.controls);
  }
  return merged;
}

const PHONE = "11111111-2222-4333-8444-555555555555";
const LAPTOP = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";

async function withTwoClients(fn) {
  await serverState.startServer();
  const port = serverState.actualPort;
  const a = await openPhone(port, PHONE);
  const b = await openPhone(port, LAPTOP);
  await sleep(60);
  a.received.length = 0;
  b.received.length = 0;
  try {
    return await fn({ a, b });
  } finally {
    for (const c of [a, b]) if (c.ws.readyState === WebSocket.OPEN) c.ws.close();
    await serverState.stopServer();
  }
}

function snapshot(clientId, controls) {
  return JSON.stringify({
    type: "snapshot",
    client_id: clientId,
    ts: Date.now(),
    data: { controls },
  });
}

test("a fader moved on one client reaches the other", async () => {
  await withTwoClients(async ({ a, b }) => {
    a.ws.send(snapshot(PHONE, [{ name: "fader-1", value: 0 }]));
    await sleep(150);

    assert.equal(
      syncedControls(b.received)["fader-1"],
      0,
      "the other view must follow the surface",
    );
  });
});

test("a client is never sent its own move back", async () => {
  await withTwoClients(async ({ a, b }) => {
    a.ws.send(snapshot(PHONE, [{ name: "fader-1", value: 0.75 }]));
    await sleep(150);

    assert.equal(
      Object.prototype.hasOwnProperty.call(syncedControls(a.received), "fader-1"),
      false,
      "echoing a move back fights the finger still holding the control",
    );
    assert.equal(syncedControls(b.received)["fader-1"], 0.75);
  });
});

test("either client can drive the same control", async () => {
  await withTwoClients(async ({ a, b }) => {
    a.ws.send(snapshot(PHONE, [{ name: "knob-2", value: 0.2 }]));
    await sleep(120);
    b.received.length = 0;

    // The second performer takes over the same control. Last mover wins, and
    // the first one sees it move under them — same as two hands on one mixer.
    b.ws.send(snapshot(LAPTOP, [{ name: "knob-2", value: 0.9 }]));
    await sleep(150);

    assert.equal(syncedControls(a.received)["knob-2"], 0.9);
  });
});

test("an XY pad syncs both axes", async () => {
  await withTwoClients(async ({ a, b }) => {
    a.ws.send(snapshot(PHONE, [{ name: "xy-1", x: 0.25, y: 0.6 }]));
    await sleep(150);

    const synced = syncedControls(b.received);
    assert.equal(synced["xy-1.x"], 0.25);
    assert.equal(synced["xy-1.y"], 0.6);
  });
});

test("sensor streams never fan out", async () => {
  await withTwoClients(async ({ a, b }) => {
    a.ws.send(
      snapshot(PHONE, [
        { name: "sensor.orient.alpha", value: 0.4 },
        { name: "sensor.vision.x", value: 0.8 },
        { name: "fader-3", value: 0.5 },
      ]),
    );
    await sleep(150);

    const synced = syncedControls(b.received);
    assert.equal(synced["fader-3"], 0.5, "real controls still travel");
    assert.equal(
      Object.keys(synced).some((k) => k.startsWith("sensor.")),
      false,
      "one phone's tilt is not another phone's tilt",
    );
  });
});

test("an unchanged value is not re-broadcast", async () => {
  await withTwoClients(async ({ a, b }) => {
    a.ws.send(snapshot(PHONE, [{ name: "pad-1", value: 1 }]));
    await sleep(120);
    b.received.length = 0;

    // The phone keeps sending its snapshot at 30 Hz whether or not anything
    // moved. Restating a value nobody changed must not put it on the wire.
    for (let i = 0; i < 5; i++) {
      a.ws.send(snapshot(PHONE, [{ name: "pad-1", value: 1 }]));
      await sleep(20);
    }
    await sleep(120);

    assert.equal(
      b.received.filter((m) => m.type === "control_sync").length,
      0,
      "only changes belong on the wire",
    );
  });
});

test("a lone client costs nothing", async () => {
  await serverState.startServer();
  const port = serverState.actualPort;
  const only = await openPhone(port, PHONE);
  await sleep(60);
  only.received.length = 0;
  try {
    only.ws.send(snapshot(PHONE, [{ name: "fader-1", value: 0.3 }]));
    await sleep(150);
    assert.equal(
      only.received.filter((m) => m.type === "control_sync").length,
      0,
      "with nobody else connected there is nothing to synchronise",
    );
  } finally {
    only.ws.close();
    await serverState.stopServer();
  }
});
