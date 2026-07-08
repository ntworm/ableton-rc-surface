// mock-server.js — HTTP + WebSocket server simulando extension.ts do Live
// Roda em 127.0.0.1:8080
// Serve dist/static/* via HTTP e mocka todos os commands WebSocket
// (/ws, /admin/ws)

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { WebSocket, WebSocketServer } from 'ws';

const PORT = 8080;
// STATIC_DIR = dist/ — arquivos servidos em /phone-v3/... (paths relativos nos HTMLs do worktree)
// e em /static/phone-v3/... (paths absolutos nos HTMLs comitados).
// Cria symlinks em runtime se não existirem, pra simular o que o Live Extension faz.
const DIST_DIR = path.resolve('dist');
function ensureSymlink(link, target) {
  const linkPath = path.join(DIST_DIR, link);
  try {
    if (!fs.existsSync(linkPath)) {
      fs.symlinkSync(path.join(DIST_DIR, target), linkPath, 'dir');
      console.log(`[mock] created symlink ${link} -> ${target}`);
    }
  } catch (err) {
    console.warn(`[mock] symlink ${link} failed: ${err.message}`);
  }
}
ensureSymlink('phone-v3', 'static/phone-v3');
ensureSymlink('panel', 'static/panel');
ensureSymlink('admin', 'static/admin');

// -------- HTTP --------
const mimeTypes = {
  '.html': 'text/html',
  '.js': 'application/javascript',
  '.mjs': 'application/javascript',
  '.css': 'text/css',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.json': 'application/json',
};

const server = http.createServer((req, res) => {
  let urlPath = decodeURIComponent(req.url || '/');
  // /static/* é a convenção do Live Extension. nosso mock responde igual.
  if (urlPath === '/' || urlPath === '/static') urlPath = '/static/panel/index.html';
  const filePath = path.join(DIST_DIR, urlPath);
  // segurança: previne path traversal
  if (!filePath.startsWith(DIST_DIR)) {
    res.writeHead(403); res.end('forbidden'); return;
  }
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end(`not found: ${urlPath}`);
      return;
    }
    const ext = path.extname(filePath);
    res.writeHead(200, {
      'Content-Type': mimeTypes[ext] || 'application/octet-stream',
      'Cache-Control': 'no-store',
    });
    res.end(data);
  });
});

// -------- mock state --------
const mockState = {
  mappings: new Map(), // controlName -> MappingTarget[]
  clients: new Map(),  // clientId -> { ws, displayName, lastData }
  admins: new Set(),   // admin ws sockets
  song: {
    tempo: 120,
    tracks: [
      { name: 'Kick', mute: false, solo: false, arm: false,
        mixer: { volume: 0.85, pan: 0.5, sends: [{name: 'A'}, {name: 'B'}] },
        devices: [
          { name: 'Operator', params: [
            { name: 'Macro 1', min: 0, max: 1, value: 0.3 },
            { name: 'Macro 2', min: 0, max: 1, value: 0.5 },
            { name: 'Macro 3', min: 0, max: 1, value: 0.0 },
            { name: 'Macro 4', min: 0, max: 1, value: 0.7 },
          ]},
          { name: 'Reverb', params: [
            { name: 'Decay', min: 0, max: 1, value: 0.4 },
            { name: 'Wet', min: 0, max: 1, value: 0.5 },
          ]},
        ],
      },
      { name: 'Bass', mute: false, solo: false, arm: false,
        mixer: { volume: 0.7, pan: 0.4, sends: [{name: 'A'}, {name: 'B'}] },
        devices: [
          { name: 'Wavetable', params: [
            { name: 'Position', min: 0, max: 1, value: 0.5 },
            { name: 'Wave', min: 0, max: 1, value: 0.2 },
          ]},
        ],
      },
      { name: 'Pad', mute: false, solo: false, arm: false,
        mixer: { volume: 0.5, pan: 0.6, sends: [{name: 'A'}, {name: 'B'}] },
        devices: [
          { name: 'Simpler', params: [
            { name: 'Gain', min: 0, max: 1, value: 0.7 },
            { name: 'Pan', min: 0, max: 1, value: 0.5 },
          ]},
        ],
      },
    ],
  },
};

// -------- helpers --------
function buildTargets() {
  const targets = [
    { id: 'tempo', type: 'tempo', label: `Song Tempo (${mockState.song.tempo.toFixed(1)} BPM)` },
  ];
  mockState.song.tracks.forEach((t, ti) => {
    const mixer = [
      { type: 'mixer_volume', trackIndex: ti, label: 'Volume' },
      { type: 'mixer_pan', trackIndex: ti, label: 'Pan' },
    ];
    t.mixer.sends.forEach((s, si) => {
      mixer.push({ type: 'mixer_send', trackIndex: ti, sendIndex: si, label: s.name || `Send ${si+1}` });
    });
    mixer.push({ type: 'track_mute', trackIndex: ti, label: 'Mute' });
    mixer.push({ type: 'track_solo', trackIndex: ti, label: 'Solo' });
    mixer.push({ type: 'track_arm', trackIndex: ti, label: 'Arm' });
    const devices = t.devices.map((d, di) => ({
      index: di, name: d.name,
      params: d.params.map((p, pi) => ({
        type: 'device_param', trackIndex: ti, deviceIndex: di, paramIndex: pi,
        label: p.name, min: p.min, max: p.max,
      })),
    }));
    targets.push({ trackIndex: ti, name: t.name, mute: t.mute, solo: t.solo, arm: t.arm, mixer, devices });
  });
  return targets;
}

function buildMappings() {
  const obj = {};
  for (const [k, v] of mockState.mappings.entries()) obj[k] = v;
  return { mappings: obj, total: mockState.mappings.size };
}

function buildServerInfo() {
  return {
    isRunning: true,
    port: PORT,
    statusText: 'Running (mock)',
    phoneUrl: `http://127.0.0.1:${PORT}/phone-v3/`,
    adminUrl: `http://127.0.0.1:${PORT}/admin/mappings.html`,
    primaryIp: '127.0.0.1',
    otherIps: [],
    useHttps: false,
  };
}

function sendResponse(ws, id, result) {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ id, ok: true, result }));
  }
}

function sendError(ws, id, message) {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ id, ok: false, error: message }));
  }
}

function broadcastToAdmins(payload) {
  const json = JSON.stringify(payload);
  for (const ws of mockState.admins) {
    if (ws.readyState === WebSocket.OPEN) {
      try { ws.send(json); } catch {}
    }
  }
}

function pushClientUpdate(client) {
  if (client.isAdmin) return;
  broadcastToAdmins({
    type: 'client_update',
    client: {
      client_id: client.id,
      display_name: client.displayName,
      last_seen: Date.now(),
      user_agent: client.userAgent || 'mock',
      status: 'active',
    },
    latest: client.lastData,
    history: client.history || [],
  });
}

// -------- command handlers --------
const handlers = {
  getServerInfo: () => buildServerInfo(),
  getTargets: () => ({ targets: buildTargets() }),
  getMappings: () => buildMappings(),
  setMapping: ({ control, target, targets }) => {
    if (!control) throw new Error('control required');
    const final = Array.isArray(targets) ? targets : (target ? [target] : []);
    mockState.mappings.set(control, final);
    return { control, targets: final, total: mockState.mappings.size };
  },
  removeMapping: ({ control }) => {
    const had = mockState.mappings.delete(control);
    return { control, removed: had, total: mockState.mappings.size };
  },
  clearMappings: () => {
    const count = mockState.mappings.size;
    mockState.mappings.clear();
    return { count };
  },
  getClients: () => {
    const arr = [];
    for (const [id, c] of mockState.clients.entries()) {
      arr.push({ id, display_name: c.displayName, status: 'active' });
    }
    return { clients: arr, total: arr.length };
  },
  getDevice: ({ trackIndex, deviceIndex }) => {
    const t = mockState.song.tracks[trackIndex];
    if (!t) throw new Error('no track');
    const d = t.devices[deviceIndex];
    if (!d) throw new Error('no device');
    return {
      name: d.name,
      parameters: d.params.map((p, i) => ({
        index: i, name: p.name, value: p.value, min: p.min, max: p.max,
        defaultValue: 0, isQuantized: false,
      })),
    };
  },
  getTrackInfo: ({ index }) => {
    const t = mockState.song.tracks[index];
    if (!t) throw new Error('no track');
    return t;
  },
  listPresets: () => ({ presets: [], total: 0 }),
  highlightControl: ({ control, durationMs }) => {
    // broadcast pra clients
    for (const c of mockState.clients.values()) {
      if (c.ws && c.ws.readyState === WebSocket.OPEN) {
        c.ws.send(JSON.stringify({ type: 'highlight', control, durationMs: durationMs || 2000 }));
      }
    }
    return { ok: true, control };
  },
};

function dispatch(ws, id, cmd, args) {
  const handler = handlers[cmd];
  if (!handler) {
    sendError(ws, id, `unknown command: ${cmd}`);
    return;
  }
  try {
    const result = handler(args || {});
    sendResponse(ws, id, result);
  } catch (err) {
    sendError(ws, id, err.message);
  }
}

// -------- WebSocket --------
const wss = new WebSocketServer({ noServer: true });
const adminWss = new WebSocketServer({ noServer: true });

server.on('upgrade', (req, socket, head) => {
  const url = req.url || '';
  if (url.startsWith('/admin/ws')) {
    adminWss.handleUpgrade(req, socket, head, ws => adminWss.emit('connection', ws, req));
  } else if (url.startsWith('/ws')) {
    wss.handleUpgrade(req, socket, head, ws => wss.emit('connection', ws, req));
  } else {
    socket.destroy();
  }
});

let nextClientId = 1;

wss.on('connection', ws => {
  const id = `mock-client-${nextClientId++}`;
  const client = {
    id, ws, isAdmin: false,
    displayName: 'Mock Phone',
    userAgent: 'mock/1.0',
    lastData: null,
    history: [],
  };
  mockState.clients.set(id, client);
  console.log(`[mock] /ws client connected: ${id}`);

  ws.on('message', raw => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }
    if (msg.id && msg.cmd) {
      dispatch(ws, msg.id, msg.cmd, msg.args);
    } else if (msg.type === 'data') {
      // telefone mandando controls
      client.lastData = msg;
      client.lastSeen = Date.now();
      pushClientUpdate(client);
    }
  });

  ws.on('close', () => {
    mockState.clients.delete(id);
    console.log(`[mock] /ws client disconnected: ${id}`);
  });
});

adminWss.on('connection', ws => {
  mockState.admins.add(ws);
  console.log(`[mock] /admin/ws connected`);

  ws.on('message', raw => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }
    if (msg.id && msg.cmd) {
      dispatch(ws, msg.id, msg.cmd, msg.args);
    }
  });

  ws.on('close', () => {
    mockState.admins.delete(ws);
    console.log(`[mock] /admin/ws disconnected`);
  });
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[mock] HTTP+WS server running at http://127.0.0.1:${PORT}`);
  console.log(`[mock] serving static from ${DIST_DIR} (with /static/ aliases)`);
  console.log(`[mock] endpoints: GET /panel/index.html, GET /phone-v3/index.html, GET /admin/mappings.html`);
  console.log(`[mock] WS endpoints: /ws (phone), /admin/ws (panel/admin)`);
});
