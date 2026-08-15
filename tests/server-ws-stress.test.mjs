// Copyright © 2026 Gabriel Worm
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Source: https://github.com/ntworm/ableton-rc-surface
//
// WebSocket bounds, rate-limiting & backpressure stress tests (Task 3.2 / ADR-004)

// Test files run in parallel and every one that starts a server competes
// for DEFAULT_PREFERRED_PORT; the loser silently falls back to an
// OS-assigned port, which makes the port assertions in
// server-restart-stability.test.mjs flap. This file claims its own.
process.env.RC_SURFACE_PORT = "16190";

import test from "node:test";
import assert from "node:assert/strict";
import { WebSocket } from "ws";
import { startServer, stopServer, actualPort } from "../src/server/state.ts";
import { trackedClients } from "../src/server/ws.ts";
import { getControllerToken } from "../src/server/session-auth.ts";
import { setExtensionContext, clearExtensionContext } from "../src/context.ts";
import {
  MAX_PAYLOAD_BYTES,
  MAX_CONTROLS_PER_SNAPSHOT,
  MAX_CLIENT_NAME_LENGTH,
  RATE_BURST,
  BACKPRESSURE_DROP_THRESHOLD,
  BACKPRESSURE_DISCONNECT_THRESHOLD,
  sanitizeNumber,
  sanitizeClientName,
} from "../src/server/ws-bounds.ts";
import { checkBackpressure } from "../src/server/backpressure.ts";

// ── Helpers ──────────────────────────────────────────────────────────────────

function mockExtensionContext() {
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
            mixer: {
              volume: { min: 0, max: 1, getValue: async () => 0.8 },
              panning: { min: -1, max: 1, getValue: async () => 0 },
              sends: [],
            },
            devices: [],
          },
        ],
        scenes: [{ signatureNumerator: 4, signatureDenominator: 4 }],
      },
    },
  });
}

/**
 * Open a controller WS and wait for the hello message.
 * Returns { ws, hello }.
 */
async function openControllerWs(port, clientId) {
  const token = getControllerToken();
  const url = `ws://127.0.0.1:${port}/ws?token=${token}` +
    (clientId ? `&client_id=${clientId}` : "");
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
  const hello = messages.find((m) => m && m.type === "hello") || null;
  return { ws, hello };
}

// ── Test lifecycle ───────────────────────────────────────────────────────────

test.beforeEach(async () => {
  mockExtensionContext();
  await startServer();
});

test.afterEach(async () => {
  await stopServer();
  clearExtensionContext();
});

// ── (a) Payload > 100 KiB causes disconnection ──────────────────────────────

test("payload > 100 KiB (MAX_PAYLOAD_BYTES) causes disconnection", async () => {
  const port = actualPort;
  assert.ok(port, "server must be running");
  const { ws } = await openControllerWs(port);

  const closePromise = new Promise((resolve) => {
    ws.on("close", (code, reason) => resolve({ code, reason: reason.toString() }));
    ws.on("error", () => {});
  });

  // Build a payload just over 100 KiB
  const oversized = JSON.stringify({
    type: "snapshot",
    data: { controls: [], pad: "x".repeat(MAX_PAYLOAD_BYTES + 1) },
  });

  ws.send(oversized, () => {});

  const close = await closePromise;
  // ws library closes with 1009 (message too big) or resets the connection (1006)
  assert.ok(
    close.code === 1009 || close.code === 1006,
    `expected code 1009 or 1006, got ${close.code}`,
  );
});

// ── (b) > 128 controls in snapshot is rejected ──────────────────────────────

test("snapshot with > 128 controls is rejected (no state mutation)", async () => {
  const port = actualPort;
  const { ws } = await openControllerWs(port);

  const controls = [];
  for (let i = 0; i < MAX_CONTROLS_PER_SNAPSHOT + 1; i++) {
    controls.push({ name: `ctrl${i}`, value: 0.5 });
  }

  ws.send(
    JSON.stringify({
      type: "snapshot",
      display_name: "overflow-client",
      data: { controls },
    }),
  );

  await new Promise((r) => setTimeout(r, 150));

  // The snapshot should have been rejected — no history should be recorded
  const client = Array.from(trackedClients.values()).find((c) => !c.isAdmin);
  assert.ok(client, "client should be tracked");
  const historyKeys = Object.keys(client.history);
  assert.equal(
    historyKeys.length,
    0,
    `snapshot with ${MAX_CONTROLS_PER_SNAPSHOT + 1} controls must be rejected entirely`,
  );

  ws.close();
});

// ── (c) Client display name > 64 Unicode chars is truncated ─────────────────

test("client display_name > 64 Unicode characters is truncated", async () => {
  const port = actualPort;
  const { ws } = await openControllerWs(port);

  // Use emoji (multi-byte) to verify Unicode code-point counting
  const longName = "🎹".repeat(MAX_CLIENT_NAME_LENGTH + 10);
  ws.send(JSON.stringify({ type: "set_display_name", display_name: longName }));

  await new Promise((r) => setTimeout(r, 100));

  const client = Array.from(trackedClients.values()).find((c) => !c.isAdmin);
  assert.ok(client, "client should be tracked");
  const namePoints = Array.from(client.displayName);
  assert.ok(
    namePoints.length <= MAX_CLIENT_NAME_LENGTH,
    `display name must be ≤ ${MAX_CLIENT_NAME_LENGTH} code points, got ${namePoints.length}`,
  );

  ws.close();
});

// ── (d) NaN / Infinity values are sanitized ─────────────────────────────────

test("NaN and Infinity control values are sanitized to 0", async () => {
  // Unit test the sanitizer directly
  assert.equal(sanitizeNumber(NaN), 0, "NaN → 0");
  assert.equal(sanitizeNumber(Infinity), 0, "Infinity → 0");
  assert.equal(sanitizeNumber(-Infinity), 0, "-Infinity → 0");
  assert.equal(sanitizeNumber(0.75), 0.75, "valid number passes through");
  assert.equal(sanitizeNumber("hello"), 0, "non-number → 0");

  // Integration: send a control with NaN value through WS
  const port = actualPort;
  const { ws } = await openControllerWs(port);

  ws.send(
    JSON.stringify({
      type: "control",
      control: { name: "testKnob", value: null }, // JSON has no NaN; null triggers non-number path
    }),
  );

  await new Promise((r) => setTimeout(r, 100));

  // The control handler should have treated the non-finite value safely
  const client = Array.from(trackedClients.values()).find((c) => !c.isAdmin);
  assert.ok(client, "client should be tracked");

  ws.close();
});

// ── (e) 10,000 rapid messages activate rate limiting ─────────────────────────

test("10,000 rapid messages activate rate limiting", async () => {
  const port = actualPort;
  const { ws } = await openControllerWs(port);

  const msg = JSON.stringify({ type: "ping", ts: 1 });

  // Fire 10,000 messages as fast as possible
  let sent = 0;
  for (let i = 0; i < 10_000; i++) {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(msg);
      sent++;
    }
  }

  // Give the server time to process
  await new Promise((r) => setTimeout(r, 500));

  // The client's rate limiter should have recorded violations.
  // We check the client's rateLimiter state.
  const client = Array.from(trackedClients.values()).find((c) => !c.isAdmin);
  assert.ok(client, "client should still be tracked");
  assert.ok(
    client.rateLimiter.violations > 0,
    `rate limiter should have violations after 10k messages, got ${client.rateLimiter.violations}`,
  );
  assert.ok(sent >= 10_000, "should have sent all 10k messages client-side");

  ws.close();
});

// ── (f) Backpressure: bufferedAmount thresholds ──────────────────────────────

test("backpressure: > 512 KiB bufferedAmount drops telemetry", () => {
  // Mock a WebSocket with high bufferedAmount
  const fakeWs = {
    readyState: WebSocket.OPEN,
    bufferedAmount: BACKPRESSURE_DROP_THRESHOLD + 1,
    close: () => {},
    send: () => {},
  };

  const allowed = checkBackpressure(fakeWs, "telemetry");
  assert.equal(allowed, false, "telemetry should be dropped above 512 KiB");

  const criticalAllowed = checkBackpressure(fakeWs, "critical");
  assert.equal(criticalAllowed, true, "critical messages should still pass at 512 KiB");
});

test("backpressure: > 2 MiB bufferedAmount disconnects", () => {
  let closeCalled = false;
  let closeCode = 0;

  const fakeWs = {
    readyState: WebSocket.OPEN,
    bufferedAmount: BACKPRESSURE_DISCONNECT_THRESHOLD + 1,
    close: (code, _reason) => {
      closeCalled = true;
      closeCode = code;
    },
    send: () => {},
  };

  const allowed = checkBackpressure(fakeWs, "critical");
  assert.equal(allowed, false, "even critical messages should fail above 2 MiB");
  assert.equal(closeCalled, true, "close() must be called on slow client");
  assert.equal(closeCode, 4008, "close code should be 4008");
});

// ── (g) Two devices on same NAT coexist ──────────────────────────────────────

test("two devices behind same NAT coexist without session confusion", async () => {
  const port = actualPort;

  // Open two separate connections with different client_ids from "same IP"
  // (in tests both come from 127.0.0.1)
  const { ws: ws1, hello: hello1 } = await openControllerWs(port, "device-alpha");
  const { ws: ws2, hello: hello2 } = await openControllerWs(port, "device-beta");

  assert.equal(hello1.client_id, "device-alpha");
  assert.equal(hello2.client_id, "device-beta");

  // Both should be tracked simultaneously
  assert.ok(trackedClients.has("device-alpha"), "device-alpha must be tracked");
  assert.ok(trackedClients.has("device-beta"), "device-beta must be tracked");

  // Send different values from each device
  ws1.send(JSON.stringify({ type: "control", control: { name: "fader1", value: 0.25 } }));
  ws2.send(JSON.stringify({ type: "control", control: { name: "fader1", value: 0.75 } }));

  await new Promise((r) => setTimeout(r, 150));

  const clientAlpha = trackedClients.get("device-alpha");
  const clientBeta = trackedClients.get("device-beta");

  assert.ok(clientAlpha, "device-alpha still tracked after both send");
  assert.ok(clientBeta, "device-beta still tracked after both send");

  // Each client has its own history — no cross-contamination
  const alphaHistory = clientAlpha.history["fader1"];
  const betaHistory = clientBeta.history["fader1"];

  assert.ok(alphaHistory, "device-alpha should have fader1 history");
  assert.ok(betaHistory, "device-beta should have fader1 history");

  // The last recorded value for each should be their own
  const alphaLastValue = alphaHistory[alphaHistory.length - 1][1];
  const betaLastValue = betaHistory[betaHistory.length - 1][1];

  assert.equal(alphaLastValue, 0.25, "device-alpha fader1 value should be 0.25");
  assert.equal(betaLastValue, 0.75, "device-beta fader1 value should be 0.75");

  ws1.close();
  ws2.close();
});

// ── Extra: sanitizeClientName unit tests ─────────────────────────────────────

test("sanitizeClientName truncates at 64 Unicode code points", () => {
  const long = "A".repeat(100);
  const result = sanitizeClientName(long);
  assert.equal(result.length, MAX_CLIENT_NAME_LENGTH);

  const emoji = "🎵".repeat(70);
  const emojiResult = sanitizeClientName(emoji);
  assert.equal(Array.from(emojiResult).length, MAX_CLIENT_NAME_LENGTH);

  assert.equal(sanitizeClientName(42), "");
  assert.equal(sanitizeClientName(null), "");
  assert.equal(sanitizeClientName("ok"), "ok");
});
