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
import { actualPort, actualHttpsPort, serverInstance, useHttps } from "./state.js";
import { commands } from "../live/mappings.js";
import { validateSameOrigin, authenticateRequest, checkSameOrigin, classifyRequestToken, getAdminToken, getControllerToken, sanitizeRequestUrl } from "./session-auth.js";
import { getPublicCommandsMetadata } from "./command-dispatch.js";
import { lastUpgradeRejection } from "./ws.js";
import { getLanAddresses, pickLanIps } from "../util/helpers.js";

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

/**
 * Inject server-state globals into the panel HTML so the UI renders
 * the correct phoneUrl / QR code on first paint — no WebSocket needed
 * for the initial state.
 */
async function servePanelHtml(
  reqUrl: string,
  res: http.ServerResponse,
): Promise<void> {
  const panelDir = path.join(__dirname, "static/panel");
  const htmlPath = path.join(panelDir, "index.html");
  let html: string;
  try {
    html = await fs.readFile(htmlPath, "utf8");
  } catch {
    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("panel/index.html not found\n");
    return;
  }

  const isRunning = serverInstance !== null;
  const port = actualPort;
  const httpsPort = actualHttpsPort;
  const { primary, others } = pickLanIps(getLanAddresses());
  const phoneProto = useHttps && httpsPort ? "https" : "http";
  const phonePort = useHttps && httpsPort ? httpsPort : port;
  const ctrlToken = getControllerToken();
  const adminToken = getAdminToken();
  const phoneUrl = isRunning && port !== null
    ? `${phoneProto}://${primary}:${phonePort}/?token=${ctrlToken}`
    : null;
  const statusText = isRunning
    ? port !== null
      ? `Running (HTTP: ${port}${httpsPort ? `, HTTPS: ${httpsPort}` : ""})`
      : "Running (binding...)"
    : "Stopped";

  // Inject before </head> so scripts that run on DOMContentLoaded
  // already see the correct values.
  const injection = `<script>
    window.INITIAL_IS_RUNNING = ${JSON.stringify(isRunning)};
    window.INITIAL_PORT = ${JSON.stringify(port)};
    window.INITIAL_HTTPS_PORT = ${JSON.stringify(httpsPort)};
    window.INITIAL_PHONE_URL = ${JSON.stringify(phoneUrl)};
    window.INITIAL_PRIMARY_IP = ${JSON.stringify(primary)};
    window.INITIAL_OTHER_IPS = ${JSON.stringify(others)};
    window.INITIAL_STATUS_TEXT = ${JSON.stringify(statusText)};
    window.INITIAL_ADMIN_TOKEN = ${JSON.stringify(adminToken)};
    window.INITIAL_CLIENTS = [];
  </script>`;

  html = html.replace("</head>", `${injection}\n</head>`);

  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.end(html);
}

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

  // Delegate panel/index.html to the injecting handler.
  const panelHtmlPath = path.join(__dirname, "static/panel/index.html");
  if (filePath === panelHtmlPath) {
    await servePanelHtml(reqUrl, res);
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
  // Do NOT send COOP/COEP/CORP here. This server is localhost-only and
  // those isolation headers break WebSocket upgrades and postMessage
  // communication when the panel is hosted inside Ableton Live's
  // embedded CEF/WebView on Windows.
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Content-Type", MIME_TYPES[ext] ?? "application/octet-stream");
  res.end(data);
}

/**
 * Self-contained connection diagnostic. Runs from the page context so the
 * server sees the SAME Origin header the failing requests carry, then prints
 * one copy-pasteable block: what the server saw, why the origin check decided
 * what it decided, whether the token matched, and the real WebSocket close
 * code (a destroyed socket otherwise surfaces as a bare "failed").
 */
const DIAG_PAGE_HTML = `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>RC Surface — connection diagnostic</title>
<style>
body { font-family: -apple-system, system-ui, sans-serif; background: #111; color: #ddd; padding: 12px; }
h1 { font-size: 15px; margin: 0 0 8px; }
button { background: #2a2a2a; color: #ddd; border: 1px solid #555; padding: 10px 16px; border-radius: 4px; font-size: 14px; }
pre { background: #000; border: 1px solid #333; padding: 10px; font-size: 11px; white-space: pre-wrap; word-break: break-all; }
.ok { color: #30d158; } .bad { color: #ff453a; }
</style>
</head>
<body>
<h1>RC Surface — connection diagnostic</h1>
<p id="verdict">Running…</p>
<button onclick="navigator.clipboard && navigator.clipboard.writeText(document.getElementById('out').textContent)">Copy report</button>
<pre id="out">…</pre>
<script>
const out = document.getElementById('out');
const verdict = document.getElementById('verdict');
const report = { pageUrl: location.href, pageOrigin: location.origin, navigatorOnLine: navigator.onLine };

function show() { out.textContent = JSON.stringify(report, null, 2); }

function wsProbe(token) {
  return new Promise((resolve) => {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const url = proto + '://' + location.host + '/ws' + (token ? '?token=' + encodeURIComponent(token) : '');
    const result = { url: url.replace(/token=[^&]+/, 'token=[REDACTED]'), opened: false };
    let ws;
    try { ws = new WebSocket(url); }
    catch (e) { result.constructorError = String(e && e.message || e); return resolve(result); }
    const timer = setTimeout(() => { result.timedOut = true; try { ws.close(); } catch (e) {} resolve(result); }, 8000);
    ws.onopen = () => { result.opened = true; };
    ws.onmessage = (e) => {
      try {
        const m = JSON.parse(e.data);
        if (m.type === 'hello') {
          result.helloRole = m.role;
          result.helloTokenStatus = m.tokenStatus;
          clearTimeout(timer);
          try { ws.close(); } catch (err) {}
          resolve(result);
        }
      } catch (err) {}
    };
    ws.onerror = () => { result.errorEvent = true; };
    ws.onclose = (e) => {
      result.closeCode = e.code; result.closeReason = e.reason; result.wasClean = e.wasClean;
      clearTimeout(timer); resolve(result);
    };
  });
}

(async () => {
  const token = new URLSearchParams(location.search).get('token');
  report.tokenSuppliedToDiagPage = Boolean(token);
  try {
    // POST on purpose: browsers omit the Origin header on same-origin GETs, so
    // only a POST reproduces the header set that /log and the WS upgrade send.
    const r = await fetch('/diag/echo' + (token ? '?token=' + encodeURIComponent(token) : ''), {
      method: 'POST', cache: 'no-store', body: '{}', headers: { 'Content-Type': 'text/plain' },
    });
    report.serverEcho = await r.json();
  } catch (e) {
    report.serverEchoError = String(e && e.message || e);
  }
  show();
  report.webSocketProbe = await wsProbe(token);
  show();
  const okWs = report.webSocketProbe.opened && report.webSocketProbe.helloRole;
  const okOrigin = report.serverEcho && report.serverEcho.originCheck && report.serverEcho.originCheck.ok;
  verdict.innerHTML = okWs
    ? '<span class="ok">WebSocket OK — role ' + report.webSocketProbe.helloRole + ', token ' + report.webSocketProbe.helloTokenStatus + '</span>'
    : '<span class="bad">WebSocket FAILED. originCheck=' + (okOrigin ? 'ok' : (report.serverEcho && report.serverEcho.originCheck ? report.serverEcho.originCheck.reason : 'unknown')) + '</span>';
})();
</script>
</body>
</html>`;

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
  console.log(`[${ts}] ${req.method} ${sanitizeRequestUrl(req.url)}`);

  const rawDiagPath = req.url ? req.url.split("?")[0] : "";

  // /diag is deliberately exempt from the origin gate: it exists to explain
  // why other requests are being refused, so gating it would hide the answer.
  // It never returns tokens — only whether a presented token matched.
  if (rawDiagPath === "/diag") {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
    res.end(DIAG_PAGE_HTML);
    return;
  }
  if (rawDiagPath === "/diag/echo") {
    const origin = checkSameOrigin(req);
    const token = classifyRequestToken(req);
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
    res.end(JSON.stringify({
      serverTime: ts,
      seenByServer: {
        method: req.method,
        url: sanitizeRequestUrl(req.url),
        origin: origin.originValue,
        host: origin.hostValue,
        userAgent: req.headers["user-agent"] ?? null,
        encrypted: Boolean((req.socket as { encrypted?: boolean } | undefined)?.encrypted),
        remoteAddress: req.socket?.remoteAddress ?? null,
      },
      originCheck: origin,
      tokenCheck: { role: token.role, tokenPresent: token.tokenPresent, tokenValid: token.tokenValid },
      serverPorts: { http: actualPort, https: actualHttpsPort, useHttps },
      lastUpgradeRejection,
    }, null, 2));
    return;
  }

  const originCheck = checkSameOrigin(req);
  if (!originCheck.ok) {
    console.warn(
      `[ableton-rc-surface] 403 ${req.method} ${sanitizeRequestUrl(req.url)} ` +
        `reason=${originCheck.reason} origin=${originCheck.originValue ?? "<none>"} ` +
        `host=${originCheck.hostValue ?? "<none>"} ` +
        `originPort=${originCheck.originPort ?? "-"} hostPort=${originCheck.hostPort ?? "-"}`,
    );
    res.writeHead(403, { "Content-Type": "text/plain" });
    res.end(`Forbidden: Same-Origin violation (${originCheck.reason})\n`);
    return;
  }

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

  const rawPath = req.url ? req.url.split("?")[0] : "";

  if (rawPath === "/health") {
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

  if (rawPath === "/" || rawPath === "/index.html") {
    // Preserve the original query string (especially ?token=) so the phone
    // client retains the controller token and connects with controller role.
    // Without this, the WS session defaults to viewer and live-write commands
    // (transport, pads, knobs) are rejected as Unauthorized.
    const qs = req.url ? req.url.slice(rawPath.length) : "";
    res.writeHead(302, { Location: `/static/phone-v3/${qs}` });
    res.end();
    return;
  }

  if (rawPath === "/commands") {
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify(getPublicCommandsMetadata()));
    return;
  }

  if (rawPath === "/test") {
    const role = authenticateRequest(req);
    if (role !== "admin") {
      res.writeHead(403, { "Content-Type": "text/plain" });
      res.end("Forbidden: admin role required\n");
      return;
    }
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
