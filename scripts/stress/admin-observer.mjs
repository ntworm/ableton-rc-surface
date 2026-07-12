// Copyright © 2026 Gabriel Worm
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Source: https://github.com/ntworm/ableton-rc-surface
//
// This file is part of Ableton RC Surface, distributed under the
// PolyForm Noncommercial License 1.0.0. You may obtain a copy of
// the License at https://polyformproject.org/licenses/noncommercial/1.0.0
// admin-observer — connects to /admin/ws and prints what the server broadcasts.
//
// Usage:
//   node scripts/stress/admin-observer.mjs --host <ip> --port <port> --duration-ms <ms>
//   node scripts/stress/admin-observer.mjs --host 192.168.100.2 --port 59065 --duration-ms 30000

import { WebSocket } from "ws";
import { argv, exit } from "node:process";

function parseArgs() {
  const args = {
    host: "127.0.0.1",
    port: 59065,
    secure: true,
    durationMs: 10000,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    if (a === "--host") args.host = next();
    else if (a === "--port") args.port = +next();
    else if (a === "--insecure") args.secure = false;
    else if (a === "--duration-ms") args.durationMs = +next();
    else if (a === "--help" || a === "-h") {
      console.error("see header comment"); exit(0);
    }
  }
  return args;
}

const args = parseArgs();
const proto = args.secure ? "wss" : "ws";
const url = `${proto}://${args.host}:${args.port}/admin/ws`;

const start = Date.now();
const ws = new WebSocket(url, { rejectUnauthorized: false });

const counts = { client_update: 0, hello: 0, transport_state: 0, live_state: 0, playhead_state: 0, other: 0 };
let lastClientUpdate = null;

function log(...m) {
  const t = ((Date.now() - start) / 1000).toFixed(3);
  console.log(`[t=${t}s]`, ...m);
}

ws.on("open", () => log("ADMIN_OPEN", url));

ws.on("message", (data) => {
  let msg;
  try { msg = JSON.parse(data.toString()); } catch { return; }
  if (!msg.type) return;

  if (msg.type === "client_update") {
    counts.client_update++;
    const client = msg.client || {};
    const lastData = msg.latest || {};
    const histLen = Object.values(msg.history || {}).reduce((s, a) => s + (a?.length || 0), 0);
    log("client_update:",
      "id=", client.client_id?.slice(0, 12),
      "name=", client.display_name,
      "status=", client.status,
      "lastData.kind=", lastData.type || "none",
      "history total entries=", histLen,
    );
    lastClientUpdate = msg;
  } else if (msg.type === "hello") {
    counts.hello++;
    log("hello from peer (skip)", msg.client_id?.slice(0,12));
  } else if (msg.type === "transport_state") {
    counts.transport_state++;
    log("transport_state", "playing=", msg.state?.isPlaying, "tempo=", msg.state?.tempo);
  } else if (msg.type === "live_state") {
    counts.live_state++;
    log("live_state tempo=", msg.tempo, "scale=", msg.scale);
  } else if (msg.type === "playhead_state") {
    counts.playhead_state++;
    log("playhead active=", msg.playheadActive, "ms=", msg.playheadTimeMs);
  } else {
    counts.other++;
    log("other:", msg.type, Object.keys(msg).slice(0,4).join(","));
  }
});

ws.on("close", () => {
  log("ADMIN_CLOSE", JSON.stringify(counts));
  process.exit(0);
});
ws.on("error", (err) => log("ADMIN_ERROR", err.message));

setTimeout(() => {
  log("DURATION_REACHED — closing");
  if (ws.readyState === WebSocket.OPEN) ws.close();
}, args.durationMs);
