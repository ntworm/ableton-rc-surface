// Copyright © 2026 Gabriel Worm
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Source: https://github.com/ntworm/ableton-rc-surface
//
// The phone URL is the one address a user actually handles: it is scanned off
// a QR code, bookmarked, and pasted into chats. Carrying the controller token
// in its query string put that token into browser history, into the address
// bar of every screenshot, and into whatever the link was pasted into.
//
// The entry point now moves the token into a cookie and redirects to a clean
// URL. An explicitly presented token still wins, so old bookmarks keep working
// exactly as they did.
import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";

// Own port: see the note in server-http-phone-redirect.test.mjs.
process.env.RC_SURFACE_PORT = "16110";

if (typeof globalThis.__dirname === "undefined") {
  globalThis.__dirname = path.join(process.cwd(), "dist");
}

const {
  SESSION_COOKIE_NAME,
  readCookie,
  buildSessionCookie,
  authenticateRequest,
  classifyRequestToken,
  getControllerToken,
  getAdminToken,
} = await import("../src/server/session-auth.ts");
const { stripQueryParam } = await import("../src/util/url.ts");

// ── cookie parsing ──────────────────────────────────────────────────────────

test("readCookie finds its value among neighbours", () => {
  assert.equal(readCookie("a=1; rc_surface_token=abc; b=2", SESSION_COOKIE_NAME), "abc");
  assert.equal(readCookie("rc_surface_token=abc", SESSION_COOKIE_NAME), "abc");
  assert.equal(readCookie("  rc_surface_token = abc  ", SESSION_COOKIE_NAME), "abc");
});

test("readCookie is total on junk input", () => {
  assert.equal(readCookie(undefined, SESSION_COOKIE_NAME), null);
  assert.equal(readCookie("", SESSION_COOKIE_NAME), null);
  assert.equal(readCookie("nonsense", SESSION_COOKIE_NAME), null);
  assert.equal(readCookie("rc_surface_token=", SESSION_COOKIE_NAME), null);
  assert.equal(readCookie("other=1", SESSION_COOKIE_NAME), null);
  // A near-miss name must not match.
  assert.equal(readCookie("xrc_surface_token=abc", SESSION_COOKIE_NAME), null);
});

test("the cookie is scoped so a hostile page cannot read or reuse it", () => {
  const cookie = buildSessionCookie("deadbeef", false);
  assert.match(cookie, /^rc_surface_token=deadbeef/);
  assert.match(cookie, /HttpOnly/, "page scripts must not be able to read it");
  assert.match(cookie, /SameSite=Lax/, "blocks cross-site subresource use");
  assert.match(cookie, /Path=\//);
  assert.doesNotMatch(cookie, /Secure/, "an http LAN server cannot set a Secure cookie");

  assert.match(buildSessionCookie("deadbeef", true), /Secure/);
});

// ── authentication through the cookie ───────────────────────────────────────

function reqWith({ url = "/ws", cookie, header } = {}) {
  const headers = {};
  if (cookie) headers.cookie = cookie;
  if (header) Object.assign(headers, header);
  return { url, headers };
}

test("a cookie authenticates a request that carries no token in its URL", () => {
  const cookie = `${SESSION_COOKIE_NAME}=${getControllerToken()}`;
  assert.equal(authenticateRequest(reqWith({ cookie })), "controller");

  const adminCookie = `${SESSION_COOKIE_NAME}=${getAdminToken()}`;
  assert.equal(authenticateRequest(reqWith({ cookie: adminCookie })), "admin");
});

test("an explicit token still outranks the cookie", () => {
  // A page bookmarked with an admin token, in a browser holding a controller
  // cookie, must resolve as admin: the explicit credential is the intent.
  const cookie = `${SESSION_COOKIE_NAME}=${getControllerToken()}`;
  const req = reqWith({ url: `/ws?token=${getAdminToken()}`, cookie });
  assert.equal(authenticateRequest(req), "admin");
});

test("a stale cookie is reported as stale, not as an anonymous viewer", () => {
  const req = reqWith({ cookie: `${SESSION_COOKIE_NAME}=${"0".repeat(32)}` });
  const classification = classifyRequestToken(req);
  assert.equal(classification.role, "viewer");
  assert.equal(classification.tokenPresent, true, "the page must be told its token expired");
  assert.equal(classification.tokenValid, false);
});

// ── query-string surgery ────────────────────────────────────────────────────

test("stripQueryParam removes only the named parameter", () => {
  assert.equal(stripQueryParam("?token=abc", "token"), "");
  assert.equal(stripQueryParam("?token=abc&x=1", "token"), "?x=1");
  assert.equal(stripQueryParam("?x=1&token=abc", "token"), "?x=1");
  assert.equal(stripQueryParam("?x=1&token=abc&y=2", "token"), "?x=1&y=2");
  assert.equal(stripQueryParam("?x=1", "token"), "?x=1");
  assert.equal(stripQueryParam("", "token"), "");
  assert.equal(stripQueryParam("?token=abc#frag", "token"), "#frag");
});

// ── the redirect, end to end ────────────────────────────────────────────────

const state = await import("../src/server/state.ts");

async function withServer(fn) {
  await state.startServer();
  try {
    return await fn(state.actualPort);
  } finally {
    await state.stopServer();
  }
}

test("the phone entry point moves the token into a cookie and cleans the URL", async () => {
  await withServer(async (port) => {
    const token = getControllerToken();
    const res = await fetch(`http://127.0.0.1:${port}/?token=${token}`, { redirect: "manual" });

    assert.equal(res.status, 302);
    assert.equal(
      res.headers.get("location"),
      "/static/phone-v3/",
      "the token must not survive into the redirect target",
    );
    const setCookie = res.headers.get("set-cookie");
    assert.ok(setCookie, "the session has to be carried somehow");
    assert.equal(readCookie(setCookie.split(";")[0], SESSION_COOKIE_NAME), token);
    assert.match(setCookie, /HttpOnly/);
  });
});

test("the entry point without a token redirects untouched", async () => {
  await withServer(async (port) => {
    const res = await fetch(`http://127.0.0.1:${port}/`, { redirect: "manual" });
    assert.equal(res.status, 302);
    assert.equal(res.headers.get("location"), "/static/phone-v3/");
    assert.equal(res.headers.get("set-cookie"), null);
  });
});

test("other query parameters survive the token being stripped", async () => {
  await withServer(async (port) => {
    const res = await fetch(
      `http://127.0.0.1:${port}/?client_id=phone-7&token=${getControllerToken()}`,
      { redirect: "manual" },
    );
    assert.equal(res.headers.get("location"), "/static/phone-v3/?client_id=phone-7");
  });
});

// The whole point of the cookie is that the WebSocket upgrade carries it
// automatically — browsers attach cookies to a same-origin upgrade. If the
// server did not read it there, the phone would connect as a viewer and every
// pad, knob and transport write would be silently refused.
test("the WebSocket upgrade authenticates from the cookie alone", async () => {
  const { WebSocket } = await import("ws");
  await withServer(async (port) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, {
      headers: { Cookie: `${SESSION_COOKIE_NAME}=${getControllerToken()}` },
    });
    try {
      const hello = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("no hello within 3s")), 3000);
        ws.on("message", (data) => {
          const msg = JSON.parse(data.toString());
          if (msg.type !== "hello") return;
          clearTimeout(timer);
          resolve(msg);
        });
        ws.on("error", reject);
      });

      assert.equal(hello.role, "controller", "the cookie must grant the controller role");
      assert.equal(hello.tokenStatus, "valid");
    } finally {
      ws.close();
    }
  });
});

test("a WebSocket with no cookie and no token is still only a viewer", async () => {
  const { WebSocket } = await import("ws");
  await withServer(async (port) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    try {
      const hello = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("no hello within 3s")), 3000);
        ws.on("message", (data) => {
          const msg = JSON.parse(data.toString());
          if (msg.type !== "hello") return;
          clearTimeout(timer);
          resolve(msg);
        });
        ws.on("error", reject);
      });

      assert.equal(hello.role, "viewer");
      assert.equal(hello.tokenStatus, "none");
    } finally {
      ws.close();
    }
  });
});
