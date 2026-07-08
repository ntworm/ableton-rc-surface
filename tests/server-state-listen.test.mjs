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
