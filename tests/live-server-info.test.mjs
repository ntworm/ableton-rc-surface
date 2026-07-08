import assert from "node:assert/strict";
import test from "node:test";

import { commands } from "../src/live/mappings.ts";
import { startServer, stopServer } from "../src/server/state.ts";

test("getServerInfo uses HTTPS phone URL without standalone Mix exposure", async () => {
  await startServer();
  try {
    const info = await commands.getServerInfo.handler({});

    assert.equal(info.isRunning, true);
    assert.equal(info.useHttps, true);
    assert.equal(typeof info.httpsPort, "number");
    assert.match(info.phoneUrl, new RegExp(`^https://[^:]+:${info.httpsPort}/$`));
    assert.equal(Object.hasOwn(info, "mixUrl"), false);
    assert.equal(Object.hasOwn(info, "mixQrSrc"), false);
  } finally {
    await stopServer();
  }
});
