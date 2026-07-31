// Copyright © 2026 Gabriel Worm
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
//
// ROOT CAUSE R6 — the Ableton extension runtime does not expose the WHATWG
// `URL` constructor, and every request-path parser depended on it.
//
// Field evidence from the user's browser console:
//   {originValue: 'https://192.168.100.2:8731',
//    hostValue:   '192.168.100.2:8731',
//    originPort: null, hostPort: null, ok: false, ...}
//
// Ports null + host present + a valid https origin can only be produced by the
// `origin-unparseable` branch, i.e. `new URL(origin)` threw. A spec-compliant
// URL cannot throw on that string, so the constructor itself was missing.
//
// Consequences, all matching the report exactly:
//   - requests WITH an Origin header (POST /log, the wss:// upgrade) are 403'd
//     or destroyed, while plain navigations and <script src> — which send no
//     Origin — keep working, so the page loads and camera/mic look fine;
//   - token parsing silently yields null, so every client is a viewer and all
//     transport / BPM / pad writes are rejected;
//   - client_id parsing silently yields null, so sessions never resume.
//
// Node has a global URL, which is exactly why this never reproduced locally.

import test from "node:test";
import assert from "node:assert/strict";
import {
  checkSameOrigin,
  classifyRequestToken,
  getControllerToken,
  getAdminToken,
} from "../src/server/session-auth.ts";
import { parseOrigin, getQueryParam } from "../src/util/url.ts";

/** Run fn in a runtime that has no global URL, like Live's extension host. */
function withoutGlobalURL(fn) {
  const saved = Object.getOwnPropertyDescriptor(globalThis, "URL");
  Object.defineProperty(globalThis, "URL", {
    value: undefined,
    configurable: true,
    writable: true,
  });
  try {
    return fn();
  } finally {
    if (saved) Object.defineProperty(globalThis, "URL", saved);
    else delete globalThis.URL;
  }
}

test("R6: the same-origin check accepts a matching LAN origin with no URL global", () => {
  const result = withoutGlobalURL(() =>
    checkSameOrigin({
      headers: { origin: "https://192.168.100.2:8731", host: "192.168.100.2:8731" },
      socket: { encrypted: true },
    }),
  );
  assert.equal(
    result.ok,
    true,
    `BUG CONFIRMED: origin rejected without a URL global — ${JSON.stringify(result)}`,
  );
  assert.equal(result.reason, "exact-host-match");
  assert.equal(result.originPort, "8731");
  assert.equal(result.hostPort, "8731");
});

test("R6: the same-origin check still rejects a foreign origin with no URL global", () => {
  const result = withoutGlobalURL(() =>
    checkSameOrigin({
      headers: { origin: "https://192.168.100.9:8731", host: "192.168.100.2:8731" },
      socket: { encrypted: true },
    }),
  );
  assert.equal(result.ok, false);
  assert.equal(result.reason, "hostname-mismatch");
});

test("R6: the controller token is recognised with no URL global", () => {
  const result = withoutGlobalURL(() =>
    classifyRequestToken({ url: `/ws?token=${getControllerToken()}`, headers: {} }),
  );
  assert.equal(
    result.role,
    "controller",
    "BUG CONFIRMED: token parsing collapses to viewer without a URL global",
  );
  assert.equal(result.tokenValid, true);
});

test("R6: the admin token is recognised with no URL global", () => {
  const result = withoutGlobalURL(() =>
    classifyRequestToken({ url: `/admin/ws?token=${getAdminToken()}`, headers: {} }),
  );
  assert.equal(result.role, "admin");
});

test("R6: parseOrigin handles scheme, host, port and IPv6 without the URL global", () => {
  const cases = [
    ["https://192.168.100.2:8731", { protocol: "https:", hostname: "192.168.100.2", port: "8731" }],
    ["http://localhost:8730", { protocol: "http:", hostname: "localhost", port: "8730" }],
    ["https://example.com", { protocol: "https:", hostname: "example.com", port: "" }],
    ["http://127.0.0.1", { protocol: "http:", hostname: "127.0.0.1", port: "" }],
    ["https://[::1]:8731", { protocol: "https:", hostname: "[::1]", port: "8731" }],
  ];
  withoutGlobalURL(() => {
    for (const [input, expected] of cases) {
      const parsed = parseOrigin(input);
      assert.ok(parsed, `failed to parse ${input}`);
      assert.equal(parsed.protocol, expected.protocol, input);
      assert.equal(parsed.hostname, expected.hostname, input);
      assert.equal(parsed.port, expected.port, input);
    }
    assert.equal(parseOrigin("chrome-extension://abc").protocol, "chrome-extension:");
    assert.equal(parseOrigin("!!not a url!!"), null);
  });
});

test("R6: getQueryParam reads params without the URL global", () => {
  withoutGlobalURL(() => {
    assert.equal(getQueryParam("/ws?token=abc123", "token"), "abc123");
    assert.equal(getQueryParam("/ws?client_id=x&token=abc", "token"), "abc");
    assert.equal(getQueryParam("/ws?token=a%20b", "token"), "a b");
    assert.equal(getQueryParam("/ws", "token"), null);
    assert.equal(getQueryParam("/ws?token=", "token"), "");
    assert.equal(getQueryParam("/ws?other=1", "token"), null);
    assert.equal(getQueryParam("/ws?token=abc#frag", "token"), "abc");
  });
});
