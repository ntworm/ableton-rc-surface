// Copyright © 2026 Gabriel Worm
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Source: https://github.com/ntworm/ableton-rc-surface
//
// This file is part of Ableton RC Surface, distributed under the
// PolyForm Noncommercial License 1.0.0. You may obtain a copy of
// the License at https://polyformproject.org/licenses/noncommercial/1.0.0
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import test from "node:test";
import { WebSocket } from "ws";

import {
  playheadActive,
  playheadBaseTimeMs,
  setPlayheadActive,
  setPlayheadBaseTimeMs,
  setPlayheadStartTime,
} from "../src/live/state.ts";
import { startServer, stopServer } from "../src/server/state.ts";

const root = path.resolve(import.meta.dirname, "..");

function read(rel) {
  return fs.readFileSync(path.join(root, rel), "utf8");
}

function requestStatus(url) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, (res) => {
      res.resume();
      res.on("end", () => resolve(res.statusCode));
    });
    req.on("error", reject);
  });
}

function waitForMessage(ws, predicate) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error("timed out waiting for WebSocket message"));
    }, 2000);
    const onMessage = (data) => {
      let msg;
      try {
        msg = JSON.parse(data.toString());
      } catch {
        return;
      }
      if (!predicate(msg)) return;
      cleanup();
      resolve(msg);
    };
    const cleanup = () => {
      clearTimeout(timer);
      ws.off("message", onMessage);
    };
    ws.on("message", onMessage);
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

test("standalone Mix route and files are removed while the phone MIX tab remains", async () => {
  assert.equal(fs.existsSync(path.join(root, "static", "mix")), false);
  assert.equal(fs.existsSync(path.join(root, "src", "live", "snapshots.ts")), false);
  assert.equal(fs.existsSync(path.join(root, "src", "server", "mix-protocol.ts")), false);

  const packageJson = JSON.parse(read("package.json"));
  assert.doesNotMatch(packageJson.scripts["test:static"], /static\/mix|static\\mix/);

  const phoneHtml = read("static/phone-v3/index.html");
  assert.match(phoneHtml, /data-page="mixer"[^>]*>MIX</);

  await startServer();
  try {
    const serverState = await import("../src/server/state.ts");
    const status = await requestStatus(`http://127.0.0.1:${serverState.actualPort}/mix/`);
    assert.equal(status, 404);
  } finally {
    await stopServer();
  }
});

test("getServerInfo exposes only local phone/admin URLs and no legacy QR fields", async () => {
  await startServer();
  try {
    const { commands } = await import("../src/live/mappings.ts");
    const info = await commands.getServerInfo.handler({});

    assert.equal(info.isRunning, true);
    assert.match(info.phoneUrl, new RegExp(`^https://[^:]+:${info.httpsPort}/$`));
    assert.match(info.adminUrl, new RegExp(`^https://127\\.0\\.0\\.1:${info.httpsPort}/static/admin/$`));
    assert.equal(Object.hasOwn(info, "mixUrl"), false);
    assert.equal(Object.hasOwn(info, "mixQrSrc"), false);
    assert.equal(Object.hasOwn(info, "qrSrc"), false);
  } finally {
    await stopServer();
  }
});

test("phone toggle_play toggles the shared playhead state and broadcasts it", async () => {
  setPlayheadActive(false);
  setPlayheadBaseTimeMs(0);
  setPlayheadStartTime(0);

  await startServer();
  let ws;
  try {
    const serverState = await import("../src/server/state.ts");
    ws = new WebSocket(`ws://127.0.0.1:${serverState.actualPort}/ws`);
    const helloPromise = waitForMessage(ws, (msg) => msg.type === "hello");
    await new Promise((resolve, reject) => {
      ws.once("open", resolve);
      ws.once("error", reject);
    });
    await helloPromise;

    const startedPromise = waitForMessage(ws, (msg) => msg.type === "playhead_state");
    ws.send(JSON.stringify({ type: "toggle_play" }));
    const started = await startedPromise;
    assert.equal(started.playheadActive, true);
    assert.equal(playheadActive, true);

    const stoppedPromise = waitForMessage(
      ws,
      (msg) => msg.type === "playhead_state" && msg.playheadActive === false,
    );
    ws.send(JSON.stringify({ type: "toggle_play" }));
    const stopped = await stoppedPromise;
    assert.equal(stopped.playheadActive, false);
    assert.equal(playheadActive, false);
    assert.equal(typeof playheadBaseTimeMs, "number");
  } finally {
    if (ws && ws.readyState === WebSocket.OPEN) ws.close();
    await stopServer();
  }
});

test("phone control messages update mapped-control history without waiting for a snapshot", async () => {
  await startServer();
  let ws;
  try {
    const serverState = await import("../src/server/state.ts");
    const { trackedClients } = await import("../src/server/ws.ts");
    ws = new WebSocket(`ws://127.0.0.1:${serverState.actualPort}/ws`);
    const helloPromise = waitForMessage(ws, (msg) => msg.type === "hello");
    await new Promise((resolve, reject) => {
      ws.once("open", resolve);
      ws.once("error", reject);
    });
    const hello = await helloPromise;

    ws.send(JSON.stringify({
      type: "control",
      client_id: hello.client_id,
      ts: Date.now(),
      control: { name: "button-1", value: 0.75 },
    }));
    await new Promise((resolve) => setTimeout(resolve, 50));

    const client = trackedClients.get(hello.client_id);
    assert.ok(client, "expected control message client to stay tracked");
    assert.equal(client.history["button-1"]?.at(-1)?.[1], 0.75);
  } finally {
    if (ws && ws.readyState === WebSocket.OPEN) ws.close();
    await stopServer();
  }
});

test("phone modulator messages do not push redundant client updates", async () => {
  await startServer();
  let phoneWs;
  let adminWs;
  try {
    const serverState = await import("../src/server/state.ts");
    phoneWs = new WebSocket(`ws://127.0.0.1:${serverState.actualPort}/ws`);
    const phoneHelloPromise = waitForMessage(phoneWs, (msg) => msg.type === "hello");
    await new Promise((resolve, reject) => {
      phoneWs.once("open", resolve);
      phoneWs.once("error", reject);
    });
    const phoneHello = await phoneHelloPromise;

    adminWs = new WebSocket(`ws://127.0.0.1:${serverState.actualPort}/admin/ws`);
    const adminHelloPromise = waitForMessage(adminWs, (msg) => msg.type === "hello");
    const adminMessages = [];
    adminWs.on("message", (data) => {
      try {
        adminMessages.push(JSON.parse(data.toString()));
      } catch {
        // ignore
      }
    });
    await new Promise((resolve, reject) => {
      adminWs.once("open", resolve);
      adminWs.once("error", reject);
    });
    await adminHelloPromise;
    await sleep(50);
    adminMessages.length = 0;

    phoneWs.send(JSON.stringify({
      type: "modulator",
      client_id: phoneHello.client_id,
      ts: Date.now(),
      modulator: { kind: "lfo", name: "not-toggle", active: true },
    }));
    await sleep(80);

    assert.equal(
      adminMessages.some((msg) => msg.type === "client_update"),
      false,
      "modulator envelopes should not broadcast redundant client_update payloads",
    );
  } finally {
    if (phoneWs && phoneWs.readyState === WebSocket.OPEN) phoneWs.close();
    if (adminWs && adminWs.readyState === WebSocket.OPEN) adminWs.close();
    await stopServer();
  }
});

test("release docs and control catalogs use current names only", () => {
  const packageJson = JSON.parse(read("package.json"));
  const version = packageJson.version;
  const releaseDocs = [
    "README.md",
    "docs/INSTALL.md",
    "docs/TESTER-GUIDE.md",
  ];
  for (const rel of releaseDocs) {
    const text = read(rel);
    assert.doesNotMatch(text, /0\.5\.1|Ableton-RC-Surface-0\.5\.1|Ableton-RC-Bridge-0\.5\.1/);
    assert.match(text, new RegExp(version.replaceAll(".", "\\.")));
  }

  const panelApp = read("static/panel/app.js");
  const adminCore = read("static/admin/mappings-core.js");
  const userGuide = read("docs/USER-GUIDE.md");
  for (const text of [panelApp, adminCore, userGuide]) {
    assert.doesNotMatch(text, /sensor\.orient\.fused/);
    assert.doesNotMatch(text, /sensor\.motion\.aig/);
    assert.doesNotMatch(text, /sensor\.vision\.gesture/);
    assert.doesNotMatch(text, /sensor\.vision\.\{x,y,z,gesture,color\}/);
    assert.doesNotMatch(text, /sensor\.motion\.\{x,y,z,x2,y2,z2\}/);
  }

  const removedPerfPatterns = [
    new RegExp('rib' + 'bon', 'i'),
    // Control names removed in v0.5.8 ('R1', 'R2', 'EXPR') were uppercase
    // labels in the PERF tab. Match them case-sensitively so legitimate
    // JS-variable names like `var r2` in inline scripts are not flagged.
    new RegExp('\\b' + 'R' + '1\\b'),
    new RegExp('\\b' + 'R' + '2\\b'),
    new RegExp('\\b' + 'EX' + 'PR\\b'),
  ];
  const removedPerfFiles = [
    "README.md",
    "docs/README.md",
    "docs/CUSTOMIZATION.md",
    "docs/USER-GUIDE.md",
    "docs/INSTALL.md",
    "docs/index.html",
    "static/phone-v3/index.html",
    "static/phone-v3/style.css",
    "static/phone-v3/controls.js",
    "static/panel/app.js",
    "static/admin/mappings-core.js",
  ];
  for (const rel of removedPerfFiles) {
    const text = read(rel);
    for (const pattern of removedPerfPatterns) {
      assert.doesNotMatch(text, pattern, `${rel} still references a removed PERF control`);
    }
  }
});

test("source no longer references external QR generation or stale sensor fusion copy", () => {
  // docs/blog/* is gitignored (intentionally private drafts), so we only
  // assert against files that ship with the public repo.
  const files = [
    "src/live/mappings.ts",
  ];
  for (const rel of files) {
    const text = read(rel);
    assert.doesNotMatch(text, /api\.qrserver\.com|Madgwick|sensor fusion/);
  }
});
