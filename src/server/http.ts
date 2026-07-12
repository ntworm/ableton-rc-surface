// Copyright © 2026 Gabriel Worm
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Source: https://github.com/ntworm/ableton-rc-surface
//
// This file is part of Ableton RC Surface, distributed under the
// PolyForm Noncommercial License 1.0.0. You may obtain a copy of
// the License at https://polyformproject.org/licenses/noncommercial/1.0.0
import * as http from "node:http";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { actualPort } from "./state.js";
import { commands } from "../live/mappings.js";

const MIME_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".mjs": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".wasm": "application/wasm",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".map": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".ico": "image/x-icon",
};

async function serveStaticFile(
  reqUrl: string,
  res: http.ServerResponse,
): Promise<void> {
  const staticDir = path.join(__dirname, "static");
  const rawPath = reqUrl.split("?")[0] ?? "/";
  const relativePath = rawPath.startsWith("/static/")
    ? rawPath.slice("/static/".length)
    : rawPath.replace(/^\/+/, "");
  const normalized = path
    .normalize(decodeURIComponent(relativePath))
    .replace(/^[\\/]+/, "");
  let filePath = path.join(staticDir, normalized);

  if (
    !filePath.startsWith(staticDir + path.sep) &&
    filePath !== staticDir
  ) {
    res.writeHead(403, { "Content-Type": "text/plain" });
    res.end("forbidden\n");
    return;
  }

  try {
    const stat = await fs.stat(filePath);
    if (stat.isDirectory()) {
      filePath = path.join(filePath, "index.html");
    }
  } catch {
    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("not found\n");
    return;
  }

  let data: Buffer;
  try {
    data = await fs.readFile(filePath);
  } catch {
    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("not found\n");
    return;
  }
  const ext = path.extname(filePath).toLowerCase();
  res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
  res.setHeader("Cross-Origin-Embedder-Policy", "require-corp");
  res.setHeader("Cross-Origin-Resource-Policy", "same-origin");
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Content-Type", MIME_TYPES[ext] ?? "application/octet-stream");
  res.end(data);
}

const TEST_PAGE_HTML = `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<title>ableton-rc-surface / test</title>
<style>
body { font-family: -apple-system, sans-serif; background: #1e1e1e; color: #ddd; padding: 1em; }
h1 { font-size: 16px; margin-top: 0; }
h2 { font-size: 13px; margin: 1em 0 0.3em; color: #aaa; }
button { background: #2a2a2a; color: #ddd; border: 1px solid #444; padding: 6px 12px; margin: 2px; border-radius: 3px; cursor: pointer; font-size: 12px; }
button:hover { background: #3a3a3a; }
#log { background: #111; padding: 8px; font-family: monospace; font-size: 12px; max-height: 50vh; overflow-y: auto; border: 1px solid #333; white-space: pre-wrap; }
#cmd { width: 100%; box-sizing: border-box; background: #111; color: #6cf; border: 1px solid #333; padding: 6px; font-family: monospace; font-size: 12px; }
</style>
</head>
<body>
<h1>ableton-rc-surface &mdash; WebSocket test (port <span id="port">?</span>)</h1>

<h2>Quick buttons</h2>
<div>
  <button onclick="send('getState')">getState</button>
  <button onclick="send('setTempo', {tempo: 140})">setTempo 140</button>
  <button onclick="send('setTempo', {tempo: 100})">setTempo 100</button>
  <button onclick="send('setTrackMute', {index: 0, mute: true})">mute[0]</button>
  <button onclick="send('setTrackMute', {index: 0, mute: false})">unmute[0]</button>
  <button onclick="send('getDeviceParams', {trackIndex: 0, deviceIndex: 0})">getDeviceParams [0][0]</button>
  <button onclick="send('setDeviceParam', {trackIndex: 0, deviceIndex: 0, paramIndex: 0, value: 0.5})">setParam[0][0][0]=0.5</button>
  <button onclick="clear()">clear log</button>
</div>

<h2>Custom JSON</h2>
<textarea id="cmd" rows="2">{"cmd":"getState"}</textarea>
<div style="margin-top: 4px;">
  <button onclick="sendCustom()">Send custom</button>
  <button onclick="document.getElementById('cmd').value = JSON.stringify({cmd:'setDeviceParam', args:{trackIndex:0, deviceIndex:0, paramIndex:0, value:0.7}}, null, 2)">fill setDeviceParam example</button>
</div>

<pre id="log"></pre>
<script>
const port = location.port;
document.getElementById('port').textContent = port;
const log = document.getElementById('log');
function out(s) { log.textContent += s + '\\n'; log.scrollTop = log.scrollHeight; }
let id = 0;
const ws = new WebSocket('ws://127.0.0.1:' + port + '/ws');
ws.onopen = () => out('ws connected on port ' + port);
ws.onclose = () => out('ws closed');
ws.onerror = (e) => out('ws error: ' + (e && e.message ? e.message : e));
ws.onmessage = (e) => {
  try {
    const msg = JSON.parse(e.data);
    if (msg.event === 'connected') { out('server hello, commands: ' + (msg.commands || []).length); return; }
    if (msg.ok) out('RECV ok [' + msg.id + ']: ' + JSON.stringify(msg.result));
    else out('RECV err [' + msg.id + ']: ' + msg.error);
  } catch { out('RECV raw: ' + e.data); }
};
function send(cmd, args) {
  const idStr = String(++id);
  const msg = { id: idStr, cmd, args: args || {} };
  ws.send(JSON.stringify(msg));
  out('SEND [' + idStr + '] ' + cmd + ' ' + JSON.stringify(args || {}));
}
function sendCustom() {
  try {
    const msg = JSON.parse(document.getElementById('cmd').value);
    msg.id = String(++id);
    ws.send(JSON.stringify(msg));
    out('SEND [' + msg.id + '] ' + JSON.stringify(msg));
  } catch (e) {
    out('PARSE err: ' + e.message);
  }
}
function clear() { log.textContent = ''; }
</script>
</body>
</html>`;

export async function handleHttp(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const ts = new Date().toISOString();
  console.log(`[${ts}] ${req.method} ${req.url}`);

  if (req.method === "POST" && req.url === "/log") {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c as Buffer));
    req.on("end", () => {
      try {
        const body = Buffer.concat(chunks).toString("utf-8");
        const payload = JSON.parse(body) as { level?: string; parts?: unknown[]; url?: string };
        const level = typeof payload.level === "string" ? payload.level : "log";
        const url = typeof payload.url === "string" ? payload.url : "";
        const parts = Array.isArray(payload.parts)
          ? payload.parts.map((p) => (typeof p === "string" ? p : JSON.stringify(p)))
          : [];
        
        const clientUrlBase = url ? ` (${url.split("/").pop()})` : "";
        const msg = `[WebView ${level}]${clientUrlBase} ${parts.join(" ")}`;
        if (level === "error") console.error(msg);
        else if (level === "warn") console.warn(msg);
        else console.log(msg);
      } catch (e) {
        console.warn("[WebView logs] malformed /log payload:", e);
      }
      res.writeHead(204);
      res.end();
    });
    req.on("error", () => {
      res.writeHead(400);
      res.end();
    });
    return;
  }

  if (req.method !== "GET") {
    res.writeHead(405, { "Content-Type": "text/plain" });
    res.end("method not allowed\n");
    return;
  }

  if (req.url === "/health") {
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({
      ok: true,
      ts,
      port: actualPort,
      message: "ableton-rc-surface: hello from inside Live. Etapa B OK.",
      commands: Object.keys(commands),
    }));
    return;
  }

  if (req.url === "/" || req.url === "/index.html") {
    res.writeHead(302, { Location: "/static/phone-v3/" });
    res.end();
    return;
  }

  if (req.url === "/commands") {
    const list: Record<string, { description: string }> = {};
    for (const [name, spec] of Object.entries(commands)) {
      list[name] = { description: spec.description };
    }
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify(list));
    return;
  }

  if (req.url === "/test") {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(TEST_PAGE_HTML);
    return;
  }

  if (req.url?.startsWith("/static/")) {
    await serveStaticFile(req.url, res);
    return;
  }

  res.writeHead(404, { "Content-Type": "text/plain" });
  res.end("not found. try /, /health, /commands, /test, or /ws (WebSocket)\n");
}
