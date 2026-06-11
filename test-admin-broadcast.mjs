// test-admin-broadcast.mjs — verify the admin <-> phone broadcast loop
// usage: node test-admin-broadcast.mjs <port>
//
// 1. Open an admin WS at /admin/ws and collect messages.
// 2. Open a phone WS at /ws, wait for the broadcast, then send a data msg.
// 3. Verify the admin sees:
//    - a client_update for the phone (on connect)
//    - a client_update for the phone (on data, with .latest)
//    - a client_update marking the phone stale (on disconnect)

const port = process.argv[2];
if (!port) {
  console.error("usage: node test-admin-broadcast.mjs <port>");
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

let base = `ws://127.0.0.1:${port}`;
const adminMessages = [];
let phoneWs = null;
let resolveAllDone;
const allDone = new Promise((r) => (resolveAllDone = r));

function open(path) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${base}${path}`);
    ws.onopen = () => resolve(ws);
    ws.onerror = (e) => reject(new Error(`open ${path} failed: ${e.message || e}`));
  });
}

(async () => {
  const proto = await detectProtocol(port);
  base = `${proto}://127.0.0.1:${port}`;
  console.log(`[test] connecting to admin ws at ${base}/admin/ws`);
  const adminWs = await open("/admin/ws");
  adminWs.onmessage = (e) => {
    const msg = JSON.parse(e.data);
    adminMessages.push(msg);
    console.log(`[admin <-] ${JSON.stringify(msg).slice(0, 200)}`);
  };
  adminWs.onclose = () => console.log(`[admin] closed`);

  // Wait a beat so admin gets its hello
  await new Promise((r) => setTimeout(r, 200));

  console.log(`[test] connecting to phone ws at ${base}/ws`);
  phoneWs = await open("/ws");
  phoneWs.onopen = () => console.log(`[phone] connected`);

  // Wait for connect broadcast
  await new Promise((r) => setTimeout(r, 200));
  console.log(`[test] phone sends data: {type: "data", sensors: {acc: [0.1, 0.2, 0.3]}}`);
  phoneWs.send(JSON.stringify({ type: "data", sensors: { acc: [0.1, 0.2, 0.3] } }));
  await new Promise((r) => setTimeout(r, 200));

  console.log(`[test] phone sends ping: {type: "ping", ts: ...}`);
  phoneWs.send(JSON.stringify({ type: "ping", ts: Date.now() }));
  await new Promise((r) => setTimeout(r, 200));

  console.log(`[test] phone sends our protocol: {id, cmd: "getState", args: {}}`);
  phoneWs.send(JSON.stringify({ id: "x1", cmd: "getState", args: {} }));
  await new Promise((r) => setTimeout(r, 400));

  console.log(`[test] phone disconnects`);
  phoneWs.close();
  await new Promise((r) => setTimeout(r, 300));

  console.log(`[test] admin disconnects`);
  adminWs.close();
  await new Promise((r) => setTimeout(r, 100));

  // Validate
  console.log(`\n[result] admin received ${adminMessages.length} messages`);
  const clientUpdates = adminMessages.filter((m) => m.type === "client_update");
  console.log(`[result] client_update count: ${clientUpdates.length}`);
  for (const cu of clientUpdates) {
    const status = cu.client?.status ?? "?";
    const id = cu.client?.client_id?.slice(0, 8) ?? "?";
    const hasLatest = cu.latest != null;
    console.log(`  - id=${id} status=${status} latest=${hasLatest ? "yes" : "no"}`);
  }

  // Expect at least 3 client_updates: phone connect, phone data (with latest), phone stale (on close)
  const connect = clientUpdates.find(
    (c) => c.client?.status === "active" && c.latest == null,
  );
  const withData = clientUpdates.find(
    (c) => c.client?.status === "active" && c.latest != null,
  );
  const stale = clientUpdates.find((c) => c.client?.status === "stale");

  let failures = 0;
  if (!connect) { console.error(`[FAIL] no "phone connect" update (active, no latest)`); failures++; }
  if (!withData) { console.error(`[FAIL] no "phone data" update (active, with latest)`); failures++; }
  if (!stale) { console.error(`[FAIL] no "phone stale" update on disconnect`); failures++; }

  if (failures === 0) {
    console.log(`\n[PASS] all broadcast scenarios verified`);
    process.exit(0);
  } else {
    console.log(`\n[FAIL] ${failures} scenario(s) missing`);
    process.exit(1);
  }
})().catch((e) => {
  console.error(`[ERR] ${e.message}`);
  process.exit(1);
});
