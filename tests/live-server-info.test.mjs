// Copyright © 2026 Gabriel Worm
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Source: https://github.com/ntworm/ableton-rc-surface
//
// This file is part of Ableton RC Surface, distributed under the
// PolyForm Noncommercial License 1.0.0. You may obtain a copy of
// the License at https://polyformproject.org/licenses/noncommercial/1.0.0
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
