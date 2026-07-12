// Copyright © 2026 Gabriel Worm
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Source: https://github.com/ntworm/ableton-rc-surface
//
// This file is part of Ableton RC Surface, distributed under the
// PolyForm Noncommercial License 1.0.0. You may obtain a copy of
// the License at https://polyformproject.org/licenses/noncommercial/1.0.0
// Spawn multiple LFO+stutter fakes from a single process (no extra node)
//
// Usage:
//   node scripts/stress/fake-phone-multi.mjs --host <ip> --port <port> --duration-ms <ms>
//
// Sends N modulator messages per tick (instead of one), simulating N controls active.
// Useful to test how the server handles many concurrent modulators from one client.

import { WebSocket } from "ws";
import { argv, exit } from "node:process";

function parseArgs() {
  const args = {
    host: "192.168.100.2",
    port: 59065,
    secure: true,
    durationMs: 15000,
    nLfos: 4,
    lfoRate: 8,
    lfoDepth: 0.7,
    nStutters: 4,
    stutterRate: 4,
    stutterCount: 4,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    if (a === "--host") args.host = next();
    else if (a === "--port") args.port = +next();
    else if (a === "--insecure") args.secure = false;
    else if (a === "--duration-ms") args.durationMs = +next();
    else if (a === "--n-lfos") args.nLfos = +next();
    else if (a === "--n-stutters") args.nStutters = +next();
    else if (a === "--lfo-rate") args.lfoRate = +next();
    else if (a === "--lfo-depth") args.lfoDepth = +next();
    else if (a === "--stutter-rate") args.stutterRate = +next();
    else if (a === "--stutter-count") args.stutterCount = +next();
    else if (a === "--help" || a === "-h") {
      console.error("see header comment"); exit(0);
    }
  }
  return args;
}

const args = parseArgs();
const proto = args.secure ? "wss" : "ws";
const url = `${proto}://${args.host}:${args.port}/ws`;
const clientId = `multi-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;

const start = Date.now();
function log(...m) {
  const t = ((Date.now() - start) / 1000).toFixed(3);
  console.log(`[t=${t}s]`, ...m);
}

const ws = new WebSocket(url, { rejectUnauthorized: false });

ws.on("open", () => {
  log("OPEN", url, "lfos=", args.nLfos, "stutters=", args.nStutters);
  ws.send(JSON.stringify({
    type: "resume",
    client_id: clientId,
    display_name: "multi-tester",
    ts: Date.now(),
  }));
  // Send modulator ON for all lfos
  for (let i = 1; i <= args.nLfos; i++) {
    const mod = {
      kind: "lfo",
      name: `toggle-${i}`,
      active: true,
      rate: args.lfoRate,
      depth: args.lfoDepth,
      shape: ["sine", "triangle", "ramp_up", "square"][i % 4],
    };
    ws.send(JSON.stringify({
      type: "modulator",
      client_id: clientId,
      ts: Date.now(),
      modulator: mod,
    }));
  }
  // And all stutters
  for (let i = 1; i <= args.nStutters; i++) {
    const mod = {
      kind: "stutter",
      name: `button-${i}`,
      active: true,
      rate: args.stutterRate,
      count: args.stutterCount,
    };
    ws.send(JSON.stringify({
      type: "modulator",
      client_id: clientId,
      ts: Date.now(),
      modulator: mod,
    }));
  }
});

ws.on("error", (e) => log("ERROR", e.message));
ws.on("close", (c, r) => log("CLOSE", c, r?.toString() ?? ""));

setTimeout(() => {
  log("DURATION_REACHED");
  if (ws.readyState === WebSocket.OPEN) ws.close();
  setTimeout(() => process.exit(0), 200);
}, args.durationMs);
