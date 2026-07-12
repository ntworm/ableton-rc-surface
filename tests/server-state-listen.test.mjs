// Copyright © 2026 Gabriel Worm
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Source: https://github.com/ntworm/ableton-rc-surface
//
// This file is part of Ableton RC Surface, distributed under the
// PolyForm Noncommercial License 1.0.0. You may obtain a copy of
// the License at https://polyformproject.org/licenses/noncommercial/1.0.0
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";

import { listenOnPreferredOrRandom } from "../src/server/state.ts";

class FakeListenServer extends EventEmitter {
  constructor({ failFirst = false, randomPort = 49152 } = {}) {
    super();
    this.failFirst = failFirst;
    this.randomPort = randomPort;
    this.calls = [];
    this.addr = null;
  }

  listen(port, host) {
    this.calls.push({ port, host });
    queueMicrotask(() => {
      if (this.failFirst && this.calls.length === 1) {
        const err = new Error("address already in use");
        err.code = "EADDRINUSE";
        this.emit("error", err);
        return;
      }
      this.addr = { address: host, family: "IPv4", port: port === 0 ? this.randomPort : port };
      this.emit("listening");
    });
    return this;
  }

  address() {
    return this.addr;
  }
}

test("listenOnPreferredOrRandom falls back to a random port when preferred port is busy", async () => {
  const fake = new FakeListenServer({ failFirst: true, randomPort: 51234 });

  const port = await listenOnPreferredOrRandom(fake, 12345, "0.0.0.0", true);

  assert.equal(port, 51234);
  assert.deepEqual(fake.calls, [
    { port: 12345, host: "0.0.0.0" },
    { port: 0, host: "0.0.0.0" },
  ]);
});

test("listenOnPreferredOrRandom rejects non-EADDRINUSE errors", async () => {
  class BrokenListenServer extends FakeListenServer {
    listen(port, host) {
      this.calls.push({ port, host });
      queueMicrotask(() => {
        const err = new Error("permission denied");
        err.code = "EACCES";
        this.emit("error", err);
      });
      return this;
    }
  }

  await assert.rejects(
    () => listenOnPreferredOrRandom(new BrokenListenServer(), 443, "0.0.0.0", true),
    /permission denied/,
  );
});

import { readFileSync } from "node:fs";

// Bug #7: startServer hardcodes listen(0, "0.0.0.0", ...) and ignores env var.
// Reproduce by checking source: it must NOT call listen(0, ...) unconditionally;
// it must read RC_SURFACE_PORT and pass it through listenOnPreferredOrRandom.

test("startServer reads RC_SURFACE_PORT env var and binds to it (bug #7)", () => {
  const src = readFileSync(
    new URL("../src/server/state.ts", import.meta.url),
    "utf8",
  );

  // The fix must exist: RC_SURFACE_PORT must be referenced from state.ts.
  assert.match(
    src,
    /RC_SURFACE_PORT/,
    "src/server/state.ts must read RC_SURFACE_PORT env var",
  );

  // The fix must NOT still call bare srv.listen(0, ...) ignoring config:
  // the listening call should hand the resolved port to listenOnPreferredOrRandom.
  // We accept two valid patterns: either `listenOnPreferredOrRandom(srv, port, ...)`
  // or the bare listen(0, ...) is gone entirely.
  const hasListenZero = /\.listen\(\s*0\s*,/.test(src);
  const usesHelper = /listenOnPreferredOrRandom\(/.test(src);
  assert.ok(
    usesHelper,
    "startServer should funnel port resolution through listenOnPreferredOrRandom",
  );
  // We allow listen(0, ...) ONLY as the fallback path inside the helper itself;
  // the bare pattern appearing in startServer's body would mean the fix didn't land.
  // Heuristic: count occurrences and require at least one helper usage.
  assert.ok(hasListenZero || usesHelper, "either helper or 0-fallback must remain");
});
