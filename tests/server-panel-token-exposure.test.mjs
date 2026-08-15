// Copyright © 2026 Gabriel Worm
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Source: https://github.com/ntworm/ableton-rc-surface
//
// The panel page is rendered with BOTH session tokens inlined into its <head>
// so it can paint the phone URL and the QR code without a round trip. That
// makes it the single most sensitive response the server produces.
//
// The server binds 0.0.0.0 (the phone has to reach it) and the Same-Origin
// check deliberately passes requests with no Origin header, because curl, the
// CLI and Live's own WebView all send none. Together those two facts meant a
// plain `GET /static/panel/index.html` from any device on the same network
// returned 200 with the admin token in the body — and the admin token opens
// /admin/ws and the /test command console.
//
// The real load presents the token: src/ui/panel.ts opens
// `http://127.0.0.1:<port>/static/panel/index.html?token=<adminToken>`.
import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";

// Own port: see the note in server-http-phone-redirect.test.mjs.
process.env.RC_SURFACE_PORT = "16120";

// The bundle defines __dirname; running the sources under tsx does not.
if (typeof globalThis.__dirname === "undefined") {
  globalThis.__dirname = path.join(process.cwd(), "dist");
}

const state = await import("../src/server/state.ts");
const { getAdminToken, getControllerToken } = await import("../src/server/session-auth.ts");

async function withServer(fn) {
  await state.startServer();
  try {
    return await fn(state.actualPort);
  } finally {
    await state.stopServer();
  }
}

test("the panel page refuses to render without an admin token", async () => {
  await withServer(async (port) => {
    const res = await fetch(`http://127.0.0.1:${port}/static/panel/index.html`);
    const body = await res.text();

    assert.equal(res.status, 403, "an unauthenticated LAN GET must not receive the panel");
    assert.ok(
      !body.includes(getAdminToken()),
      "the admin token must never appear in an unauthenticated response",
    );
    assert.ok(
      !body.includes(getControllerToken()),
      "the controller token must never appear in an unauthenticated response",
    );
  });
});

test("a stale or controller token is not enough to render the panel", async () => {
  await withServer(async (port) => {
    for (const token of [getControllerToken(), "0".repeat(32)]) {
      const res = await fetch(
        `http://127.0.0.1:${port}/static/panel/index.html?token=${token}`,
      );
      const body = await res.text();
      assert.equal(res.status, 403);
      assert.ok(!body.includes(getAdminToken()));
    }
  });
});

test("the panel still renders for the admin token Live itself passes", async () => {
  await withServer(async (port) => {
    // Exactly the URL shape built in src/ui/panel.ts.
    const res = await fetch(
      `http://127.0.0.1:${port}/static/panel/index.html?token=${getAdminToken()}`,
    );
    const body = await res.text();

    assert.equal(res.status, 200, "the in-Live panel load must keep working");
    assert.match(body, /window\.INITIAL_ADMIN_TOKEN/);
    assert.ok(body.includes(getAdminToken()), "the panel needs its own token to reach /admin/ws");
  });
});

test("panel sub-resources stay public so the gated page can still style itself", async () => {
  await withServer(async (port) => {
    // The <link> and <script> tags resolve without the query string, so
    // gating them by token would leave the panel unstyled and inert.
    for (const asset of ["style.css", "app.js"]) {
      const res = await fetch(`http://127.0.0.1:${port}/static/panel/${asset}`);
      const body = await res.text();
      assert.equal(res.status, 200, `${asset} must remain reachable`);
      assert.ok(!body.includes(getAdminToken()), `${asset} must not carry a token`);
    }
  });
});
