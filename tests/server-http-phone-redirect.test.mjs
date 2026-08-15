// Copyright © 2026 Gabriel Worm
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Source: https://github.com/ntworm/ableton-rc-surface
//
// Root cause H1: the redirect at "/" used to drop the ?token= query string, so
// the phone landed on /static/phone-v3/ with no credential, connected as a
// viewer, and every transport, pad and knob write was refused — with nothing
// on screen to say why.
//
// The guarantee these tests protect is that guarantee: **the session survives
// the redirect**. It is no longer carried in the query string. The token is
// moved into an HttpOnly cookie and the URL is cleaned, because "/" is the
// address that gets scanned off a QR code, bookmarked and pasted into chats —
// a token there lives on in browser history and in every screenshot of the
// address bar. See tests/server-session-cookie.test.mjs for the cookie itself.

import test from "node:test";
import assert from "node:assert/strict";
import * as http from "node:http";
import path from "node:path";

// Test files run in parallel, and every one of them that starts a server
// competes for DEFAULT_PREFERRED_PORT. Losing that race is harmless here but
// makes server-restart-stability's port assertions flap, so this file claims
// its own port and leaves the default to the tests that care about it.
process.env.RC_SURFACE_PORT = "16100";

// The bundle defines __dirname; running the sources under tsx does not, and
// static file serving needs it.
if (typeof globalThis.__dirname === "undefined") {
  globalThis.__dirname = path.join(process.cwd(), "dist");
}

// Namespace, not a destructure: `actualPort` is an `export let` live binding
// that is still null at import time and only gets its value once the server
// binds. Destructuring it here would freeze that null.
const serverState = await import("../src/server/state.ts");
const { startServer, stopServer } = serverState;
const {
  getControllerToken,
  getAdminToken,
  readCookie,
  SESSION_COOKIE_NAME,
} = await import("../src/server/session-auth.ts");

/** Minimal helper: GET a path and return { statusCode, location, setCookie, body }. */
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
            setCookie: res.headers["set-cookie"] ?? null,
            body,
          })
        );
      }
    );
    req.on("error", reject);
    req.setTimeout(3000, () => { req.destroy(); reject(new Error("timeout")); });
  });
}

/** The token the browser will present on every later request, or null. */
function carriedToken(setCookie) {
  if (!setCookie) return null;
  const header = Array.isArray(setCookie) ? setCookie.join("; ") : setCookie;
  return readCookie(header.split(";")[0], SESSION_COOKIE_NAME);
}

// ------------------------------------------------------------------
// Lifecycle: start server before tests, stop after all tests
// ------------------------------------------------------------------
let port = null;

test.before(async () => {
  await startServer();
  port = serverState.actualPort;
});

test.after(async () => {
  await stopServer();
});

// ------------------------------------------------------------------
// H1 — the session must survive the redirect at "/"
// ------------------------------------------------------------------

test("H1: GET / without token redirects to /static/phone-v3/ (baseline)", async () => {
  const { statusCode, location, setCookie } = await httpGet(port, "/");
  assert.equal(statusCode, 302, `Expected 302, got ${statusCode}`);
  assert.ok(
    location?.includes("/static/phone-v3/"),
    `Location must include /static/phone-v3/, got: ${location}`
  );
  assert.equal(setCookie, null, "there is no session to carry");
});

test("H1: GET /?token=CTRL_TOKEN carries the controller session past the redirect", async () => {
  const ctrlToken = getControllerToken();
  const { statusCode, location, setCookie } = await httpGet(port, `/?token=${ctrlToken}`);
  assert.equal(statusCode, 302, `Expected 302, got ${statusCode}`);
  assert.equal(
    carriedToken(setCookie),
    ctrlToken,
    `REGRESSION: the redirect at / lost the controller session.\n` +
    `Set-Cookie: ${setCookie}\n` +
    `Without it the phone connects as viewer and transport commands are rejected.`
  );
  assert.ok(
    !location?.includes("token="),
    `the phone URL must come out clean, got: ${location}`
  );
});

test("H1: GET /?token=ADMIN_TOKEN carries the admin session past the redirect", async () => {
  const adminToken = getAdminToken();
  const { statusCode, setCookie } = await httpGet(port, `/?token=${adminToken}`);
  assert.equal(statusCode, 302, `Expected 302, got ${statusCode}`);
  assert.equal(carriedToken(setCookie), adminToken);
});

test("H1: GET /?token=X&client_id=Y keeps the session and the other parameters", async () => {
  const ctrlToken = getControllerToken();
  const { statusCode, location, setCookie } = await httpGet(
    port,
    `/?token=${ctrlToken}&client_id=test-id`
  );
  assert.equal(statusCode, 302, `Expected 302, got ${statusCode}`);
  assert.equal(carriedToken(setCookie), ctrlToken);
  assert.ok(
    location?.includes("client_id=test-id"),
    `client_id resumes the phone's prior session and must survive, got: ${location}`
  );
  assert.ok(!location?.includes("token="), `got: ${location}`);
});

test("H1: GET /index.html without token also redirects to /static/phone-v3/", async () => {
  const { statusCode, location } = await httpGet(port, "/index.html");
  assert.equal(statusCode, 302, `Expected 302, got ${statusCode}`);
  assert.ok(
    location?.includes("/static/phone-v3/"),
    `Expected /static/phone-v3/ redirect, got: ${location}`
  );
});

test("H1: GET /index.html?token=CTRL_TOKEN carries the session too", async () => {
  const ctrlToken = getControllerToken();
  const { statusCode, location, setCookie } = await httpGet(
    port,
    `/index.html?token=${ctrlToken}`
  );
  assert.equal(statusCode, 302, `Expected 302, got ${statusCode}`);
  assert.equal(carriedToken(setCookie), ctrlToken);
  assert.ok(!location?.includes("token="), `got: ${location}`);
});

test("H1: an already-bookmarked URL with the token still works untouched", async () => {
  // extractToken checks the query first, so a page opened straight at
  // /static/phone-v3/?token=... — every link shared before this change —
  // authenticates exactly as it always did.
  const ctrlToken = getControllerToken();
  const { statusCode } = await httpGet(port, `/static/phone-v3/?token=${ctrlToken}`);
  assert.equal(statusCode, 200, "old links must not break");
});
