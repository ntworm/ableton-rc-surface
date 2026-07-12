// Copyright © 2026 Gabriel Worm
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Source: https://github.com/ntworm/ableton-rc-surface
//
// This file is part of Ableton RC Surface, distributed under the
// PolyForm Noncommercial License 1.0.0. You may obtain a copy of
// the License at https://polyformproject.org/licenses/noncommercial/1.0.0
// Fake phone client — pure WebSocket (no browser, no playwright).
//
// Protocol matches static/phone-v3/app.js (v3):
//   connect:    wss://<host>/ws
//   first msg:  { type: 'resume', client_id, display_name, ts }
//   control:    { type: 'control',  client_id, ts, control: { name, value? } }
//   modulator:  { type: 'modulator', client_id, ts, modulator: { kind, name, active, rate?, depth?, count?, shape? } }
//   ping:       { type: 'ping', ts: Date.now() }
//   pong:       { type: 'pong', ts: <echo> } (from server)
//
// Usage:
//   node scripts/stress/fake-phone-headless.mjs --host 192.168.100.2 --port 59065
//   node scripts/stress/fake-phone-headless.mjs --lfo toggle-1 --rate 16 --depth 1 --duration 10
//
// Logs go to stdout (caller pipes to file for analysis).

import { WebSocket } from "ws";
import { argv, exit } from "node:process";

function parseArgs() {
  const args = {
    host: "127.0.0.1",
    port: 59065,
    secure: true,
    clientId: null,
    displayName: "fake-headless",
    pingMs: 5000,
    // Default: just connect, send resume, ping forever.
    lfo: null,
    stutter: null,
    durationMs: 0, // 0 = forever
    logPath: null,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    if (a === "--host") args.host = next();
    else if (a === "--port") args.port = +next();
    else if (a === "--insecure") args.secure = false;
    else if (a === "--client-id") args.clientId = next();
    else if (a === "--display-name") args.displayName = next();
    else if (a === "--ping-ms") args.pingMs = +next();
    else if (a === "--lfo") args.lfo = { name: next() };
    else if (a === "--stutter") args.stutter = { name: next() };
    else if (a === "--rate") {
      const v = +next();
      if (args.lfo) args.lfo.rate = v;
      if (args.stutter) args.stutter.rate = v;
    }
    else if (a === "--depth") {
      const v = +next();
      if (args.lfo) args.lfo.depth = v;
    }
    else if (a === "--count") {
      const v = +next();
      if (args.stutter) args.stutter.count = v;
    }
    else if (a === "--shape") {
      if (args.lfo) args.lfo.shape = next();
    }
    else if (a === "--duration-ms") args.durationMs = +next();
    else if (a === "--log") args.logPath = next();
    else if (a === "--help" || a === "-h") {
      console.error("see header comment");
      exit(0);
    }
  }
  return args;
}

const args = parseArgs();
const proto = args.secure ? "wss" : "ws";
const url = `${proto}://${args.host}:${args.port}/ws`;

const clientId = args.clientId || `fake-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

const start = Date.now();
const events = []; // [{ t, type, ... }] for post-mortem analysis

function log(...m) {
  const line = `[t=${((Date.now() - start) / 1000).toFixed(3)}s] ${m.join(" ")}`;
  console.log(line);
  events.push(line);
}

const ws = new WebSocket(url, { rejectUnauthorized: false });

let pingTimer = null;
let modulatorTimer = null;
let durationTimer = null;
let connected = false;

ws.on("open", () => {
  connected = true;
  log("WS_OPEN", url);
  ws.send(JSON.stringify({
    type: "resume",
    client_id: clientId,
    display_name: args.displayName,
    ts: Date.now(),
  }));

  // heartbeat ping
  pingTimer = setInterval(() => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: "ping", ts: Date.now() }));
    }
  }, args.pingMs);

  // If a modulator is configured, send it
  if (args.lfo || args.stutter) {
    const mod = args.lfo
      ? {
          kind: "lfo",
          name: args.lfo.name,
          active: true,
          rate: args.lfo.rate ?? 1,
          depth: args.lfo.depth ?? 0.5,
          shape: args.lfo.shape ?? "sine",
        }
      : {
          kind: "stutter",
          name: args.stutter.name,
          active: true,
          rate: args.stutter.rate ?? 1,
          count: args.stutter.count ?? 4,
        };
    log("MODULATOR_ON", JSON.stringify(mod));
    ws.send(JSON.stringify({
      type: "modulator",
      client_id: clientId,
      ts: Date.now(),
      modulator: mod,
    }));
    // keep sending the active modulator state at 30Hz (matches phone tick)
    modulatorTimer = setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({
          type: "modulator",
          client_id: clientId,
          ts: Date.now(),
          modulator: mod,
        }));
      }
    }, 33);
  }
});

ws.on("message", (data) => {
  let msg;
  try {
    msg = JSON.parse(data.toString());
  } catch (e) {
    log("WS_MSG_PARSE_FAIL", data.toString().slice(0, 100));
    return;
  }
  if (msg.type === "pong") {
    const rtt = Date.now() - msg.ts;
    log("PONG_RTT_MS", rtt);
  } else if (msg.type === "transport_state" || msg.type === "live_state" || msg.type === "hello") {
    log("WS_MSG", msg.type, "keys:", Object.keys(msg).slice(0, 6).join(","));
  } else if (msg.type) {
    // quiet default for unknown types
  }
});

ws.on("close", (code, reason) => {
  log("WS_CLOSE", code, reason?.toString() ?? "");
  cleanup();
});

ws.on("error", (err) => {
  log("WS_ERROR", err.message);
});

function cleanup() {
  if (pingTimer) clearInterval(pingTimer);
  if (modulatorTimer) clearInterval(modulatorTimer);
  if (durationTimer) clearTimeout(durationTimer);
  setTimeout(() => process.exit(0), 100);
}

if (args.durationMs > 0) {
  durationTimer = setTimeout(() => {
    log("DURATION_REACHED");
    if (ws.readyState === WebSocket.OPEN) ws.close();
    cleanup();
  }, args.durationMs);
}

// Trap exit signals so we always log WS_CLOSE cleanly
process.on("SIGINT", () => { log("SIGINT"); ws.close(); cleanup(); });
process.on("SIGTERM", () => { log("SIGTERM"); ws.close(); cleanup(); });
