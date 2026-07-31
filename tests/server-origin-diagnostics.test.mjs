// Copyright © 2026 Gabriel Worm
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
//
// Field evidence: on the user's machine the phone page LOADS over
// https://IP:8731, but POST /log answers 403 and every wss:// upgrade fails
// with no close code. Those are exactly the two request kinds that carry an
// `Origin` header, and 403 on /log can only come from validateSameOrigin().
//
// So the origin check is rejecting something — but a plain
// Origin: https://IP:8731 + Host: IP:8731 passes when reasoned about on paper.
// The check therefore has to report WHY it rejected, and what it actually saw,
// instead of collapsing every path into a bare `false`.

import test from "node:test";
import assert from "node:assert/strict";
import { checkSameOrigin, validateSameOrigin } from "../src/server/session-auth.ts";

test("D1: a matching LAN https origin is accepted and says so", () => {
  const result = checkSameOrigin({
    headers: { origin: "https://192.168.100.2:8731", host: "192.168.100.2:8731" },
    socket: { encrypted: true },
  });
  assert.equal(result.ok, true, `unexpectedly rejected: ${JSON.stringify(result)}`);
  assert.equal(result.reason, "exact-host-match");
  assert.equal(result.originValue, "https://192.168.100.2:8731");
  assert.equal(result.hostValue, "192.168.100.2:8731");
  assert.equal(result.originPort, "8731");
  assert.equal(result.hostPort, "8731");
});

test("D1: a port mismatch reports the two ports it compared", () => {
  const result = checkSameOrigin({
    headers: { origin: "https://192.168.100.2:8731", host: "192.168.100.2:8730" },
    socket: { encrypted: true },
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "port-mismatch");
  assert.equal(result.originPort, "8731");
  assert.equal(result.hostPort, "8730");
});

test("D1: a browser-extension origin is named for its scheme, not a bogus port mismatch", () => {
  const result = checkSameOrigin({
    headers: {
      origin: "chrome-extension://abcdefghijklmnop",
      host: "192.168.100.2:8731",
    },
    socket: { encrypted: true },
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "non-http-origin-scheme");
  assert.equal(result.originValue, "chrome-extension://abcdefghijklmnop");
});

test("D1: a different LAN host on the same port is a hostname mismatch", () => {
  const result = checkSameOrigin({
    headers: { origin: "https://192.168.100.9:8731", host: "192.168.100.2:8731" },
    socket: { encrypted: true },
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "hostname-mismatch");
});

test("D1: a missing Host header is reported distinctly", () => {
  const result = checkSameOrigin({
    headers: { origin: "https://192.168.100.2:8731" },
    socket: { encrypted: true },
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "no-host-header");
});

test("D1: an unparseable Origin is reported distinctly", () => {
  const result = checkSameOrigin({
    headers: { origin: "!!not a url!!", host: "192.168.100.2:8731" },
    socket: { encrypted: true },
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "origin-unparseable");
});

test("D1: no Origin header at all is accepted (top-level navigation, curl)", () => {
  const result = checkSameOrigin({ headers: { host: "192.168.100.2:8731" } });
  assert.equal(result.ok, true);
  assert.equal(result.reason, "no-origin-header");
});

test("D1: Live's embedded WebView 'null' origin is accepted", () => {
  const result = checkSameOrigin({
    headers: { origin: "null", host: "127.0.0.1:8730" },
  });
  assert.equal(result.ok, true);
  assert.equal(result.reason, "null-origin");
});

test("D1: validateSameOrigin keeps its boolean contract on top of the detailed check", () => {
  assert.equal(
    validateSameOrigin({
      headers: { origin: "https://192.168.100.2:8731", host: "192.168.100.2:8731" },
      socket: { encrypted: true },
    }),
    true,
  );
  assert.equal(
    validateSameOrigin({
      headers: { origin: "http://evil.example", host: "192.168.100.2:8731" },
      socket: { encrypted: true },
    }),
    false,
  );
});
