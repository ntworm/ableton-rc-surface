// test-commands.mjs — exercise all Etapa B commands end-to-end
// usage: node test-commands.mjs <port>
//
// Connects to ws://127.0.0.1:<port>/ws, sends each registered command,
// prints result or error. Exit 0 = all OK, 1 = any failed.

const port = process.argv[2];
if (!port) {
  console.error("usage: node test-commands.mjs <port>");
  console.error("  find port in ExtensionHost.txt:  search for 'HTTP+WS listening on http://127.0.0.1:XXXXX'");
  process.exit(2);
}

process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";

async function detectProtocol(port) {
  try {
    const controller = new AbortController();
    const id = setTimeout(() => controller.abort(), 1000);
    const res = await fetch(`https://127.0.0.1:${port}/health`, { signal: controller.signal });
    clearTimeout(id);
    if (res.ok) return "wss";
  } catch (err) {
    // try fallback
  }
  return "ws";
}

const tests = [
  { name: "getState",          args: {} },
  { name: "getDeviceParams",   args: { trackIndex: 0, deviceIndex: 0 } },
  { name: "setTempo",          args: { tempo: 140 } },
  { name: "setTempo",          args: { tempo: 120 } },
  { name: "setTrackVolume",    args: { index: 0, volume: 0.5 } },
  { name: "setTrackVolume",    args: { index: 0, volume: 0.85 } },
  { name: "setTrackMute",      args: { index: 0, mute: true } },
  { name: "setTrackMute",      args: { index: 0, mute: false } },
  { name: "setDeviceParam",    args: { trackIndex: 0, deviceIndex: 0, paramIndex: 0, value: 0.5 } },
];

(async () => {
  const proto = await detectProtocol(port);
  const url = `${proto}://127.0.0.1:${port}/ws`;

  const ws = new WebSocket(url);
  let seq = 0;
  let pending = new Map(); // id -> test
  let failures = 0;

  ws.addEventListener("open", () => {
    console.log(`[OK] WebSocket connected: ${url}\n`);
  });

  ws.addEventListener("error", (e) => {
    console.error(`[ERR] WebSocket error: ${e.message || e}`);
    process.exit(1);
  });

  ws.addEventListener("close", () => {
    if (pending.size > 0) {
      console.error(`[ERR] WebSocket closed with ${pending.size} tests pending`);
      process.exit(1);
    }
    console.log(`\n[${failures === 0 ? "PASS" : "FAIL"}] ${tests.length - failures}/${tests.length} commands OK`);
    process.exit(failures === 0 ? 0 : 1);
  });

  ws.addEventListener("message", (e) => {
    let msg;
    try { msg = JSON.parse(e.data); } catch { return; }

    if (msg.type === "hello" || msg.event === "connected") {
      console.log(`[OK] server hello, ${msg.commands.length} commands available: ${msg.commands.join(", ")}\n`);
      runNext();
      return;
    }

    const t = pending.get(String(msg.id));
    if (!t) return;
    pending.delete(String(msg.id));

    if (msg.ok) {
      const summary = JSON.stringify(msg.result);
      const truncated = summary.length > 200 ? summary.slice(0, 200) + "..." : summary;
      console.log(`[OK]   ${t.name.padEnd(20)} id=${msg.id}  ${truncated}`);
    } else {
      failures++;
      console.error(`[FAIL] ${t.name.padEnd(20)} id=${msg.id}  ${msg.error}`);
    }

    if (pending.size === 0) {
      setTimeout(() => ws.close(), 200);
    } else {
      setTimeout(runNext, 80);
    }
  });

  function runNext() {
    const t = tests[seq];
    if (!t) return;
    seq++;
    const id = String(seq);
    pending.set(id, t);
    const msg = { id, cmd: t.name, args: t.args };
    ws.send(JSON.stringify(msg));
  }
})();
