// Copyright © 2026 Gabriel Worm
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
//
// Root cause R2 — a stale controller token must be reported, not silently
// downgraded to "viewer".
//
// Tokens are regenerated on every extension start. A phone that reconnects
// with a bookmarked / still-open URL therefore presents a token that no longer
// matches. Today authenticateRequest() maps that to "viewer" — identical to
// "no token supplied" — so the phone connects, looks healthy, and then every
// transport / pad / knob write is rejected with no explanation.

import test from "node:test";
import assert from "node:assert/strict";
import {
  classifyRequestToken,
  getControllerToken,
  getAdminToken,
} from "../src/server/session-auth.ts";

test("R2: a token that matches nothing is flagged as stale, not a plain viewer", () => {
  const result = classifyRequestToken({
    url: "/ws?token=00000000000000000000000000000000",
    headers: {},
  });
  assert.equal(result.role, "viewer", "an unknown token must not grant privileges");
  assert.equal(result.tokenPresent, true, "the request did carry a token");
  assert.equal(
    result.tokenValid,
    false,
    "BUG: a stale token is indistinguishable from no token, so the phone " +
      "cannot tell the user their session expired",
  );
});

test("R2: no token at all is an ordinary viewer, not a stale session", () => {
  const result = classifyRequestToken({ url: "/ws", headers: {} });
  assert.equal(result.role, "viewer");
  assert.equal(result.tokenPresent, false);
  assert.equal(result.tokenValid, false);
});

test("R2: the current controller token authenticates as controller", () => {
  const result = classifyRequestToken({
    url: `/ws?token=${getControllerToken()}`,
    headers: {},
  });
  assert.equal(result.role, "controller");
  assert.equal(result.tokenPresent, true);
  assert.equal(result.tokenValid, true);
});

test("R2: the current admin token authenticates as admin", () => {
  const result = classifyRequestToken({
    url: `/admin/ws?token=${getAdminToken()}`,
    headers: {},
  });
  assert.equal(result.role, "admin");
  assert.equal(result.tokenValid, true);
});

test("R2: a stale bearer token in the Authorization header is also flagged", () => {
  const result = classifyRequestToken({
    headers: { authorization: "Bearer not-a-real-token" },
  });
  assert.equal(result.role, "viewer");
  assert.equal(result.tokenPresent, true);
  assert.equal(result.tokenValid, false);
});
