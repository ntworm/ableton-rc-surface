// Copyright © 2026 Gabriel Worm
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
//
// Root cause R2 (wire half) — the `hello` frame must tell the phone whether the
// token it presented is still valid, so a reconnect after an Ableton restart
// can say "session expired, rescan the QR" instead of silently becoming a
// viewer whose transport and pad writes are all rejected.

import test from "node:test";
import assert from "node:assert/strict";
import { WebSocket } from "ws";
import { startServer, stopServer, actualPort } from "../src/server/state.ts";
import { getControllerToken } from "../src/server/session-auth.ts";

function hello(query) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${actualPort}/ws${query}`);
    const timer = setTimeout(() => {
      ws.terminate();
      reject(new Error("timed out waiting for hello"));
    }, 5000);
    ws.on("message", (raw) => {
      const msg = JSON.parse(raw.toString());
      if (msg.type !== "hello") return;
      clearTimeout(timer);
      ws.close();
      resolve(msg);
    });
    ws.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

test.before(async () => { await startServer(); });
test.after(async () => { await stopServer(); });

test("R2: hello reports tokenStatus 'stale' for a token that no longer matches", async () => {
  const msg = await hello("?token=00000000000000000000000000000000");
  assert.equal(msg.role, "viewer");
  assert.equal(
    msg.tokenStatus,
    "stale",
    "BUG: the phone cannot distinguish an expired session from an ordinary " +
      "viewer, so it shows a healthy status while every write is rejected",
  );
});

test("R2: hello reports tokenStatus 'none' when no token was supplied", async () => {
  const msg = await hello("");
  assert.equal(msg.role, "viewer");
  assert.equal(msg.tokenStatus, "none");
});

test("R2: hello reports tokenStatus 'valid' for the current controller token", async () => {
  const msg = await hello(`?token=${getControllerToken()}`);
  assert.equal(msg.role, "controller");
  assert.equal(msg.tokenStatus, "valid");
});
