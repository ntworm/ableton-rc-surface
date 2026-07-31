// Copyright © 2026 Gabriel Worm
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Source: https://github.com/ntworm/ableton-rc-surface
//
// Tests for Same-Origin port matching rejection (Task 3.1 / P1.2)

import test from "node:test";
import assert from "node:assert/strict";
import { validateSameOrigin } from "../src/server/session-auth.ts";

test("Surface validateSameOrigin: Rejects localhost Origin on a different port", () => {
  const req = {
    headers: {
      origin: "http://localhost:8080",
      host: "localhost:51070",
    },
  };
  assert.equal(validateSameOrigin(req), false, "Origin on port 8080 MUST be rejected when Host is on port 51070");
});

test("Surface validateSameOrigin: Accepts localhost Origin when port matches Host", () => {
  const req = {
    headers: {
      origin: "http://localhost:51070",
      host: "localhost:51070",
    },
  };
  assert.equal(validateSameOrigin(req), true, "Origin on matching port MUST be accepted");
});

test("Surface validateSameOrigin: Rejects a same-host Origin on the implicit port 80", () => {
  // A page served by any other daemon on the same machine/LAN address (router
  // UI, dev server, another extension) must not be able to drive Live just
  // because it shares the hostname.
  const req = {
    headers: {
      origin: "http://192.168.1.5",
      host: "192.168.1.5:52877",
    },
  };
  assert.equal(
    validateSameOrigin(req),
    false,
    "Origin on implicit port 80 MUST be rejected when Host is on port 52877",
  );
});

test("Surface validateSameOrigin: Rejects a same-host https Origin on the implicit port 443", () => {
  const req = {
    headers: {
      origin: "https://192.168.1.5",
      host: "192.168.1.5:52877",
    },
  };
  assert.equal(
    validateSameOrigin(req),
    false,
    "Origin on implicit port 443 MUST be rejected when Host is on port 52877",
  );
});

test("Surface validateSameOrigin: Accepts 127.0.0.1 Origin when port matches localhost Host", () => {
  const req = {
    headers: {
      origin: "http://127.0.0.1:51070",
      host: "localhost:51070",
    },
  };
  assert.equal(validateSameOrigin(req), true, "127.0.0.1 Origin matching port MUST be accepted");
});
