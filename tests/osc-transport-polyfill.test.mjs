// Copyright © 2026 Gabriel Worm
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Source: https://github.com/ntworm/ableton-rc-surface
//
// This file is part of Ableton RC Surface, distributed under the
// PolyForm Noncommercial License 1.0.0. You may obtain a copy of
// the License at https://polyformproject.org/licenses/noncommercial/1.0.0
import assert from "node:assert/strict";
import test from "node:test";

test("OSCTransport installs TextEncoder/TextDecoder for Ableton ExtensionHost", async () => {
  const originalEncoder = globalThis.TextEncoder;
  const originalDecoder = globalThis.TextDecoder;
  delete globalThis.TextEncoder;
  delete globalThis.TextDecoder;

  try {
    const mod = await import(`../src/live/osc-transport.ts?polyfill=${Date.now()}`);
    assert.equal(typeof globalThis.TextEncoder, "function");
    assert.equal(typeof globalThis.TextDecoder, "function");

    const transport = new mod.OSCTransport();
    let sent = false;
    transport.client = {
      send(buffer, _port, _host, cb) {
        sent = (Buffer.isBuffer(buffer) || ArrayBuffer.isView(buffer)) && (buffer.byteLength > 0 || (buffer && buffer.length > 0));
        cb?.(null);
      },
    };

    transport.state.available = true;
    transport.send("/live/song/get/tempo");
    assert.equal(sent, true);
    assert.equal(transport.state.error, null);
  } finally {
    if (originalEncoder) globalThis.TextEncoder = originalEncoder;
    else delete globalThis.TextEncoder;
    if (originalDecoder) globalThis.TextDecoder = originalDecoder;
    else delete globalThis.TextDecoder;
  }
});
