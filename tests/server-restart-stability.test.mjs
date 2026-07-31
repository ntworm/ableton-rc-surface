// Copyright © 2026 Gabriel Worm
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
//
// Root cause R1 — the listen port must survive an extension restart.
//
// Field report: after restarting Ableton the phone shows "RETRY 30s" forever,
// the MAP panel says "Could not load mapping data", transport and BPM are dead,
// while camera and microphone keep working (both are browser-local).
//
// Reproduced by restarting the server: the OS-assigned port (preferredPort = 0)
// changed on every start, so an already-loaded phone page kept retrying the
// old, now-dead port until the user manually rescanned the QR code.
//
// These tests allocate their own ports. `node --test` runs test files
// concurrently and several of them start a server, so nothing here may assume
// it owns DEFAULT_PREFERRED_PORT.

import test from "node:test";
import assert from "node:assert/strict";
import * as net from "node:net";
import {
  startServer,
  stopServer,
  actualPort,
  actualHttpsPort,
  DEFAULT_PREFERRED_PORT,
} from "../src/server/state.ts";

/** Reserve, then release, an OS-assigned port so we know it is currently free. */
async function borrowFreePort() {
  const probe = net.createServer();
  await new Promise((resolve, reject) => {
    probe.once("error", reject);
    probe.listen(0, "0.0.0.0", resolve);
  });
  const { port } = probe.address();
  await new Promise((resolve) => probe.close(resolve));
  return port;
}

/** Bind a port, or return null if something else already owns it. */
async function trySquat(port) {
  const srv = net.createServer();
  try {
    await new Promise((resolve, reject) => {
      srv.once("error", reject);
      srv.listen(port, "0.0.0.0", resolve);
    });
    return srv;
  } catch {
    return null;
  }
}

test("R1: the preferred port is reclaimed across a stop/start cycle", async (t) => {
  t.after(() => { delete process.env.RC_SURFACE_PORT; });

  // `node --test` runs test files concurrently, so a port that was free a
  // moment ago can be taken before startServer() binds it. Retry with a fresh
  // port instead of letting that race fail the run.
  let port = null;
  let firstHttp = null;
  let firstHttps = null;
  for (let attempt = 0; attempt < 5; attempt++) {
    port = await borrowFreePort();
    process.env.RC_SURFACE_PORT = String(port);
    await startServer();
    firstHttp = actualPort;
    firstHttps = actualHttpsPort;
    if (firstHttp === port) break;
    // Someone else grabbed it between the probe and the bind; try again.
    await stopServer();
  }
  await stopServer();

  await startServer();
  const secondHttp = actualPort;
  const secondHttps = actualHttpsPort;
  // Probe while our server is still up: if we did NOT reclaim the port, it must
  // be because a concurrent test process holds it right now. If it is free and
  // we still moved, that is the real bug this test exists to catch.
  const httpStillFree = secondHttp === firstHttp ? null : await trySquat(firstHttp);
  if (httpStillFree) await new Promise((resolve) => httpStillFree.close(resolve));
  await stopServer();

  assert.equal(firstHttp, port, `expected to claim the preferred port ${port}, got ${firstHttp}`);
  if (secondHttp !== firstHttp) {
    assert.equal(
      httpStillFree,
      null,
      `BUG: HTTP port moved ${firstHttp} -> ${secondHttp} across a restart while ` +
        `${firstHttp} was free. Every already-open phone page is stranded on the ` +
        `old port and retries forever.`,
    );
    t.diagnostic(`port ${firstHttp} taken by a concurrent test process; got ${secondHttp}`);
    return;
  }
  assert.equal(
    secondHttps,
    firstHttps,
    `BUG: HTTPS port moved ${firstHttps} -> ${secondHttps} across a restart.`,
  );
});

test("R1: the default preferred port is a deterministic constant, never OS-assigned", () => {
  assert.equal(typeof DEFAULT_PREFERRED_PORT, "number");
  assert.notEqual(
    DEFAULT_PREFERRED_PORT,
    0,
    "port 0 means OS-assigned, which moves the server on every restart",
  );
  assert.ok(
    DEFAULT_PREFERRED_PORT > 1024 && DEFAULT_PREFERRED_PORT < 65535,
    `DEFAULT_PREFERRED_PORT must be a usable high port, got ${DEFAULT_PREFERRED_PORT}`,
  );
});

test("R1: with no RC_SURFACE_PORT override the server claims the deterministic default", async (t) => {
  const savedEnv = process.env.RC_SURFACE_PORT;
  delete process.env.RC_SURFACE_PORT;
  t.after(() => { if (savedEnv !== undefined) process.env.RC_SURFACE_PORT = savedEnv; });

  await startServer();
  const port = actualPort;
  // `node --test` runs test files concurrently and several of them start a
  // server, so the default port may legitimately be held by a sibling process.
  // Probe it while our own server is still up: if we did not get the default
  // port, binding it must fail right now — otherwise the preference is broken.
  const stillFree = port === DEFAULT_PREFERRED_PORT ? null : await trySquat(DEFAULT_PREFERRED_PORT);
  if (stillFree) await new Promise((resolve) => stillFree.close(resolve));
  await stopServer();

  if (port !== DEFAULT_PREFERRED_PORT) {
    assert.equal(
      stillFree,
      null,
      `Expected the server to claim its deterministic default port ${DEFAULT_PREFERRED_PORT}, ` +
        `got ${port} while ${DEFAULT_PREFERRED_PORT} was free`,
    );
    t.diagnostic(`port ${DEFAULT_PREFERRED_PORT} held by a concurrent test process; fell back to ${port}`);
  }
});

test("R1: a sibling extension holding the preferred port does not break startup", async (t) => {
  const port = await borrowFreePort();
  const squatter = await trySquat(port);
  assert.ok(squatter, "test setup: could not reserve a port to squat");

  process.env.RC_SURFACE_PORT = String(port);
  t.after(async () => {
    delete process.env.RC_SURFACE_PORT;
    await new Promise((resolve) => squatter.close(resolve));
  });

  // RC Setlist (or any other process) may already own the preferred port.
  // Surface must fall back to an OS-assigned port instead of failing to start.
  await startServer();
  const bound = actualPort;
  await stopServer();

  assert.ok(bound !== null, "server must still bind when the preferred port is taken");
  assert.notEqual(
    bound,
    port,
    "server must not claim a port already owned by a sibling extension",
  );
});
