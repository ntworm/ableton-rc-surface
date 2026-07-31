// Copyright © 2026 Gabriel Worm
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Source: https://github.com/ntworm/ableton-rc-surface
//
// Tests for root-cause H1: HTTP redirect at "/" must preserve the ?token= query
// string so the phone client lands on /static/phone-v3/?token=CTRL_TOKEN
// and connects to WS with controller role (not viewer).
//
// RED tests: these will FAIL until the fix is applied to http.ts.

import test from "node:test";
import assert from "node:assert/strict";
import * as http from "node:http";
import { startServer, stopServer, actualPort } from "../src/server/state.ts";
import { getControllerToken, getAdminToken } from "../src/server/session-auth.ts";

/** Minimal helper: GET a path and return { statusCode, location, body }. */
async function httpGet(port, path) {
  return new Promise((resolve, reject) => {
    const req = http.get(
      { host: "127.0.0.1", port, path },
      (res) => {
        let body = "";
        res.on("data", (chunk) => { body += chunk; });
        res.on("end", () =>
          resolve({
            statusCode: res.statusCode,
            location: res.headers["location"] ?? null,
            body,
          })
        );
      }
    );
    req.on("error", reject);
    req.setTimeout(3000, () => { req.destroy(); reject(new Error("timeout")); });
  });
}

// ------------------------------------------------------------------
// Lifecycle: start server before tests, stop after all tests
// ------------------------------------------------------------------
let port = null;

test.before(async () => {
  await startServer();
  port = actualPort;
});

test.after(async () => {
  await stopServer();
});

// ------------------------------------------------------------------
// H1 — Redirect at "/" MUST preserve ?token= query string
// ------------------------------------------------------------------

test("H1: GET / without token redirects to /static/phone-v3/ (baseline)", async () => {
  const { statusCode, location } = await httpGet(port, "/");
  assert.equal(statusCode, 302, `Expected 302, got ${statusCode}`);
  // Without a token, the location must still point to phone-v3
  assert.ok(
    location?.includes("/static/phone-v3/"),
    `Location must include /static/phone-v3/, got: ${location}`
  );
});

test("H1 RED: GET /?token=CTRL_TOKEN MUST redirect to /static/phone-v3/?token=CTRL_TOKEN", async () => {
  const ctrlToken = getControllerToken();
  const { statusCode, location } = await httpGet(port, `/?token=${ctrlToken}`);
  assert.equal(statusCode, 302, `Expected 302, got ${statusCode}`);
  assert.ok(
    location?.includes(`token=${ctrlToken}`),
    `BUG CONFIRMED: Redirect at / drops ?token= query string.\n` +
    `Expected location containing token=${ctrlToken}\n` +
    `Actual location: ${location}\n` +
    `This means phone connects as viewer and transport commands are rejected.`
  );
});

test("H1 RED: GET /?token=ADMIN_TOKEN MUST redirect preserving admin token", async () => {
  const adminToken = getAdminToken();
  const { statusCode, location } = await httpGet(port, `/?token=${adminToken}`);
  assert.equal(statusCode, 302, `Expected 302, got ${statusCode}`);
  assert.ok(
    location?.includes(`token=${adminToken}`),
    `BUG: Redirect at / drops admin token from query string.\nGot location: ${location}`
  );
});

test("H1 RED: GET /?token=X&client_id=Y MUST redirect preserving all query params", async () => {
  const ctrlToken = getControllerToken();
  const { statusCode, location } = await httpGet(port, `/?token=${ctrlToken}&client_id=test-id`);
  assert.equal(statusCode, 302, `Expected 302, got ${statusCode}`);
  // The full query string must be forwarded to the phone-v3 page
  assert.ok(
    location?.includes(`token=${ctrlToken}`),
    `BUG: Redirect drops token from multi-param query string.\nGot: ${location}`
  );
});

test("H1: GET /index.html without token also redirects to /static/phone-v3/", async () => {
  const { statusCode, location } = await httpGet(port, "/index.html");
  assert.equal(statusCode, 302, `Expected 302, got ${statusCode}`);
  assert.ok(
    location?.includes("/static/phone-v3/"),
    `Expected /static/phone-v3/ redirect, got: ${location}`
  );
});

test("H1 RED: GET /index.html?token=CTRL_TOKEN MUST redirect preserving token", async () => {
  const ctrlToken = getControllerToken();
  const { statusCode, location } = await httpGet(port, `/index.html?token=${ctrlToken}`);
  assert.equal(statusCode, 302, `Expected 302, got ${statusCode}`);
  assert.ok(
    location?.includes(`token=${ctrlToken}`),
    `BUG: /index.html?token= redirect drops token.\nGot: ${location}`
  );
});
