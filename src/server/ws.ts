// Copyright © 2026 Gabriel Worm
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Source: https://github.com/ntworm/ableton-rc-surface
//
// This file is part of Ableton RC Surface, distributed under the
// PolyForm Noncommercial License 1.0.0. You may obtain a copy of
// the License at https://polyformproject.org/licenses/noncommercial/1.0.0
import * as http from "node:http";
import { WebSocketServer, WebSocket } from "ws";
import { getExtensionContext } from "../context.js";
import {
  getScaleLabel,
  playheadActive,
  playheadBaseTimeMs,
  playheadStartTime,
  setPlayheadActive,
  setPlayheadBaseTimeMs,
  setPlayheadStartTime,
  broadcastPlayheadState,
} from "../live/state.js";
import {
  applyMapping,
  clearHostModulatorsForClient,
  commands,
  getControlValues,
  updateHostModulator,
} from "../live/mappings.js";
import { createClientId } from "./client-id.js";
import { oscTransport } from "../live/osc-transport.js";

export type ClientMode = "performance" | "admin";

export interface TrackedClient {
  id: string;
  ipAddress: string;
  displayName: string;
  isAdmin: boolean;
  mode: ClientMode;
  path: string;
  connectedAt: number;
  lastSeen: number;
  userAgent: string;
  lastData: Record<string, any> | null;
  history: Record<string, [number, number][]>;
  ws: WebSocket;
}

export const trackedClients = new Map<string, TrackedClient>();
export const adminSockets = new Set<WebSocket>();

export const CLIENT_STALE_MS = 35_000;
export const HISTORY_MAX = 60;

let wsServer: WebSocketServer | null = null;
let adminWsServer: WebSocketServer | null = null;

export function wssInit() {
  wsServer = new WebSocketServer({ noServer: true, perMessageDeflate: true });
  adminWsServer = new WebSocketServer({ noServer: true, perMessageDeflate: true });

  setupWssHandlers(wsServer, "/ws", "WS", false);
  setupWssHandlers(adminWsServer, "/admin/ws", "ADMIN-WS", true);

  return { wsServer, adminWsServer };
}

export function handleUpgrade(req: http.IncomingMessage, socket: any, head: Buffer) {
  const urlPath = req.url ? req.url.split("?")[0] : "";
  if (urlPath === "/ws" && wsServer) {
    wsServer.handleUpgrade(req, socket, head, (ws) => {
      wsServer!.emit("connection", ws, req);
    });
  } else if (urlPath === "/admin/ws" && adminWsServer) {
    adminWsServer.handleUpgrade(req, socket, head, (ws) => {
      adminWsServer!.emit("connection", ws, req);
    });
  } else {
    socket.destroy();
  }
}

export function stopAllWsClients(): void {
  for (const c of [...trackedClients.values()]) {
    try {
      c.ws.close(1001, "server stopping");
    } catch {
      // ignore
    }
  }
  trackedClients.clear();
  adminSockets.clear();
}

export function appendHistory(c: TrackedClient, name: string, value: number, ts: number): void {
  if (!c.history) c.history = {};
  if (!c.history[name]) c.history[name] = [];
  const series = c.history[name];
  series.push([ts, value]);
  if (series.length > HISTORY_MAX) {
    series.splice(0, series.length - HISTORY_MAX);
  }
}

export function broadcastToAdmins(payload: object): void {
  const json = JSON.stringify(payload);
  for (const ws of adminSockets) {
    if (ws.readyState === WebSocket.OPEN) {
      try {
        ws.send(json);
      } catch {
        // ignore
      }
    }
  }
}

export function pushClientUpdate(c: TrackedClient): void {
  if (c.isAdmin) return;
  const status = Date.now() - c.lastSeen < CLIENT_STALE_MS ? "active" : "stale";
  broadcastToAdmins({
    type: "client_update",
    client: {
      client_id: c.id,
      display_name: c.displayName || "",
      last_seen: c.lastSeen,
      user_agent: c.userAgent,
      status,
    },
    latest: c.lastData,
    history: c.history,
  });
}

/**
 * Close any non-admin tracked client whose connection comes from the same
 * IP as a freshly opened WebSocket. Used by both /ws and /admin/ws
 * so a flaky phone network does not leave stale duplicates connected.
 */
export function closeDuplicateIpClients(
  ipAddress: string,
  clientId: string,
  isAdmin: boolean,
): void {
  if (!ipAddress || isAdmin) return;
  for (const [existingId, existing] of trackedClients.entries()) {
    if (!existing.isAdmin && existing.ipAddress === ipAddress && existing.id !== clientId) {
      console.log(`[ableton-rc-surface] closing existing client ${existingId} due to duplicate IP ${ipAddress}`);
      try {
        existing.ws.close();
      } catch {
        // ignore
      }
      trackedClients.delete(existingId);
      pushClientUpdate({ ...existing, lastSeen: 0 });
    }
  }
}

function setupWssHandlers(wss: WebSocketServer, path: string, label: string, isAdmin: boolean): void {
  wss.on("connection", (ws: WebSocket, req) => {
    const ts = new Date().toISOString();
    let queryClientId: string | null = null;
    try {
      if (req.url) {
        const urlObj = new URL(req.url, "http://localhost");
        queryClientId = urlObj.searchParams.get("client_id");
      }
    } catch {
      // ignore
    }

    const clientId = createClientId(queryClientId);
    const ipAddress = req.socket.remoteAddress || "";

    const existing = trackedClients.get(clientId);
    if (existing && existing.ws !== ws) {
      try {
        console.log(`[ableton-rc-surface] closing existing duplicate connection for client ${clientId}`);
        existing.ws.close();
      } catch {
        // ignore
      }
      trackedClients.delete(clientId);
    }

    closeDuplicateIpClients(ipAddress, clientId, isAdmin);

    const info: TrackedClient = {
      id: clientId,
      ipAddress,
      displayName: "",
      isAdmin,
      mode: isAdmin ? "admin" : "performance",
      path,
      connectedAt: Date.now(),
      lastSeen: Date.now(),
      userAgent: String(req.headers["user-agent"] ?? "unknown"),
      lastData: null,
      history: {},
      ws,
    };
    trackedClients.set(clientId, info);
    if (isAdmin) adminSockets.add(ws);

    console.log(
      `[${ts}] [ableton-rc-surface] ${label} connected id=${clientId} ua=${info.userAgent.slice(0, 60)}`,
    );

    void sendHello(ws, clientId, path, isAdmin);

    if (isAdmin) {
      let sent = 0;
      for (const c of trackedClients.values()) {
        if (c.isAdmin) continue;
        pushClientUpdate(c);
        sent++;
      }
      console.log(`[ableton-rc-surface] admin ${clientId} sent ${sent} existing client snapshot`);
    } else {
      pushClientUpdate(info);
    }

    ws.on("message", (data) => {
      info.lastSeen = Date.now();
      const raw = data.toString();
      const typed = handleTypedPhoneMessage(ws, info, raw);
      if (typed.error) {
        // Log JSON parse failures from the typed-message path explicitly
        // (previously swallowed silently).
        console.error(
          `[ableton-rc-surface] ${label} id=${clientId} typed-msg JSON parse error:`,
          typed.error instanceof Error ? typed.error.message : String(typed.error),
        );
        return;
      }
      if (typed.handled) {
        // Type-tagged message was fully handled (e.g. ping, snapshot,
        // control, modulator). Don't re-dispatch to the command-envelope
        // path, and only push client_update when the type actually
        // mutates observable client state.
        if (typed.pushClientUpdate) pushClientUpdate(info);
        return;
      }
      // Not a typed message — try as a legacy command envelope.
      dispatch(ws, raw);
      pushClientUpdate(info);
    });

    ws.on("close", () => {
      console.log(`[ableton-rc-surface] ${label} id=${clientId} disconnected`);
      if (isAdmin) adminSockets.delete(ws);
      if (!isAdmin) clearHostModulatorsForClient(clientId);
      info.lastSeen = 0;
      pushClientUpdate(info);
      const current = trackedClients.get(clientId);
      if (current && current.ws === ws) {
        trackedClients.delete(clientId);
      }
    });

    ws.on("error", (err) => {
      console.error(`[ableton-rc-surface] ${label} id=${clientId} error: ${err.message}`);
    });
  });
}

async function sendHello(ws: WebSocket, clientId: string, path: string, isAdmin: boolean): Promise<void> {
  let initTempo = 120;
  let initSig = "4/4";
  let initScale = "--";
  let initValues: Record<string, number> = {};
  try {
    const extensionContext = getExtensionContext();
    const song = extensionContext?.application.song;
    if (song) {
      initTempo = song.tempo;
      initScale = getScaleLabel(song.rootNote, song.scaleName);
      if (song.scenes && song.scenes.length > 0 && song.scenes[0]) {
        const scene = song.scenes[0];
        initSig = `${scene.signatureNumerator}/${scene.signatureDenominator}`;
      }
    }
    if (!isAdmin) {
      initValues = await getControlValues(clientId);
    }
  } catch {
    // ignore; hello still carries safe defaults
  }

  if (ws.readyState === WebSocket.OPEN) {
    const now = Date.now();
    const currentPos = playheadActive ? playheadBaseTimeMs + (now - playheadStartTime) : playheadBaseTimeMs;
    ws.send(
      JSON.stringify({
        type: "hello",
        client_id: clientId,
        path,
        commands: Object.keys(commands),
        tempo: initTempo,
        signature: initSig,
        scale: initScale,
        playheadActive,
        playheadTimeMs: currentPos,
        values: initValues,
      }),
    );
    if (!isAdmin) {
      ws.send(
        JSON.stringify({
          type: "transport_state",
          state: oscTransport.state,
        }),
      );
    }
  }
}

interface TypedMessageResult {
  handled: boolean;
  // True when the type-tagged message should also push a client_update
  // to the admin socket. Snapshot/control/set_display_name push; the
  // high-frequency types (modulator/ping/toggle_play) do not.
  pushClientUpdate: boolean;
  error?: unknown;
}

function handleTypedPhoneMessage(ws: WebSocket, info: TrackedClient, raw: string): TypedMessageResult {
  let parsed: Record<string, any>;
  try {
    parsed = JSON.parse(raw) as Record<string, any>;
  } catch (err) {
    return { handled: false, pushClientUpdate: false, error: err };
  }
  const t = parsed["type"];
  if (t === "snapshot") {
    const snapDisplayName = parsed["display_name"];
    if (typeof snapDisplayName === "string" && snapDisplayName !== info.displayName) {
      info.displayName = snapDisplayName;
    }
    const snapData = parsed["data"] as Record<string, any> | undefined;
    if (snapData) {
      handleSnapshot(info, snapData);
    }
    return { handled: true, pushClientUpdate: true };
  } else if (t === "control") {
    handleControl(info, parsed["control"], Date.now());
    return { handled: true, pushClientUpdate: true };
  } else if (t === "modulator") {
    updateHostModulator(info.id, (parsed["modulator"] ?? {}) as Record<string, any>);
    info.lastData = parsed;
    return { handled: true, pushClientUpdate: false };
  } else if (t === "ping") {
    try {
      ws.send(JSON.stringify({ type: "pong", ts: parsed["ts"] || Date.now() }));
    } catch {
      // ignore
    }
    return { handled: true, pushClientUpdate: false };
  } else if (t === "toggle_play") {
    togglePlayhead();
    return { handled: true, pushClientUpdate: false };
  } else if (t === "set_display_name") {
    const newName = parsed["display_name"];
    if (typeof newName === "string") {
      info.displayName = newName;
      return { handled: true, pushClientUpdate: true };
    }
    return { handled: true, pushClientUpdate: false };
  } else {
    info.lastData = parsed;
    // Foreign typed message (no recognized `type` tag) — let dispatch()
    // decide whether it is a JSON `cmd` command or just unknown.
    return { handled: false, pushClientUpdate: true };
  }
}

function handleControl(info: TrackedClient, ctrl: any, receivedAt: number): void {
  if (!ctrl || typeof ctrl !== "object" || typeof ctrl.name !== "string") return;
  const name = ctrl.name;
  if (typeof ctrl.x === "number" && typeof ctrl.y === "number") {
    appendHistory(info, `${name}.x`, ctrl.x, receivedAt);
    appendHistory(info, `${name}.y`, ctrl.y, receivedAt);
    void applyMapping(info.id, `${name}.x`, ctrl.x);
    void applyMapping(info.id, `${name}.y`, ctrl.y);
  } else if (typeof ctrl.value === "number") {
    appendHistory(info, name, ctrl.value, receivedAt);
    void applyMapping(info.id, name, ctrl.value);
  }
}

function handleSnapshot(info: TrackedClient, snapData: Record<string, any>): void {
  info.lastData = snapData;
  const receivedAt = Date.now();
  const controls = (snapData["controls"] ?? []) as any[];
  for (const ctrl of controls) {
    handleControl(info, ctrl, receivedAt);
  }

  const orient = snapData["orient"];
  if (orient && typeof orient === "object") {
    if (typeof orient.alpha === "number") {
      const alphaVal = Math.max(0, Math.min(360, orient.alpha)) / 360;
      appendHistory(info, "sensor.orient.alpha", alphaVal, receivedAt);
      void applyMapping(info.id, "sensor.orient.alpha", alphaVal);
    }
    if (typeof orient.beta === "number") {
      const betaVal = (Math.max(-90, Math.min(90, orient.beta)) + 90) / 180;
      appendHistory(info, "sensor.orient.beta", betaVal, receivedAt);
      void applyMapping(info.id, "sensor.orient.beta", betaVal);
    }
    if (typeof orient.gamma === "number") {
      const gammaVal = ((Math.max(-180, Math.min(180, orient.gamma)) + 180) / 360);
      appendHistory(info, "sensor.orient.gamma", gammaVal, receivedAt);
      void applyMapping(info.id, "sensor.orient.gamma", gammaVal);
    }
  }

  const motion = snapData["motion"];
  if (motion && typeof motion === "object") {
    const mapAccel = (v: any) => {
      const num = typeof v === "number" ? v : 0;
      const clamped = Math.max(-20, Math.min(20, num));
      return (clamped + 20) / 40;
    };
    const mapGyro = (v: any) => {
      const num = typeof v === "number" ? v : 0;
      const clamped = Math.max(-200, Math.min(200, num));
      return (clamped + 200) / 400;
    };

    if (motion.ax !== undefined) {
      const val = mapAccel(motion.ax);
      appendHistory(info, "sensor.motion.ax", val, receivedAt);
      void applyMapping(info.id, "sensor.motion.ax", val);
    }
    if (motion.ay !== undefined) {
      const val = mapAccel(motion.ay);
      appendHistory(info, "sensor.motion.ay", val, receivedAt);
      void applyMapping(info.id, "sensor.motion.ay", val);
    }
    if (motion.az !== undefined) {
      const val = mapAccel(motion.az);
      appendHistory(info, "sensor.motion.az", val, receivedAt);
      void applyMapping(info.id, "sensor.motion.az", val);
    }
    if (motion.gx !== undefined) {
      const val = mapGyro(motion.gx);
      appendHistory(info, "sensor.motion.gx", val, receivedAt);
      void applyMapping(info.id, "sensor.motion.gx", val);
    }
    if (motion.gy !== undefined) {
      const val = mapGyro(motion.gy);
      appendHistory(info, "sensor.motion.gy", val, receivedAt);
      void applyMapping(info.id, "sensor.motion.gy", val);
    }
    if (motion.gz !== undefined) {
      const val = mapGyro(motion.gz);
      appendHistory(info, "sensor.motion.gz", val, receivedAt);
      void applyMapping(info.id, "sensor.motion.gz", val);
    }
  }
}

function togglePlayhead(): void {
  const now = Date.now();
  if (playheadActive) {
    setPlayheadBaseTimeMs(playheadBaseTimeMs + (now - playheadStartTime));
    setPlayheadActive(false);
  } else {
    setPlayheadStartTime(now);
    setPlayheadActive(true);
  }
  broadcastPlayheadState();
}

export function isCommandEnvelope(
  msg: Record<string, unknown>,
): msg is Record<string, unknown> & { cmd: string } {
  return typeof msg["cmd"] === "string";
}

function dispatch(ws: WebSocket, raw: string): void {
  let msg: Record<string, unknown>;
  try {
    msg = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    console.log(`[ableton-rc-surface] ws: non-JSON message (${raw.length} bytes) ignored`);
    return;
  }
  if (!isCommandEnvelope(msg)) {
    if (typeof msg["type"] !== "string") {
      console.log(`[ableton-rc-surface] ws: foreign msg type="unknown" ignored`);
    }
    return;
  }
  const cmd = msg["cmd"];
  const id = msg["id"];
  const args = (msg["args"] ?? {}) as any;
  const spec = commands[cmd];
  if (!spec) {
    const known = Object.keys(commands).join(", ");
    ws.send(JSON.stringify({ id, ok: false, error: `unknown cmd: ${cmd}. known: ${known}` }));
    return;
  }
  spec.handler(args)
    .then((result) => {
      ws.send(JSON.stringify({ id, ok: true, result }));
    })
    .catch((err) => {
      const detail =
        err === undefined
          ? "<undefined>"
          : err instanceof Error
            ? err.message
            : JSON.stringify(err);
      ws.send(JSON.stringify({ id, ok: false, error: detail }));
      console.error(`[ableton-rc-surface] cmd ${cmd} failed: ${detail}`);
    });
}

let lastBroadcastTime = 0;
let pendingBroadcastTimeout: NodeJS.Timeout | null = null;
const THROTTLE_MS = 100;

oscTransport.on("update", (state) => {
  const now = Date.now();
  
  const performBroadcast = () => {
    lastBroadcastTime = Date.now();
    pendingBroadcastTimeout = null;
    const payload = JSON.stringify({
      type: "transport_state",
      state
    });
    for (const c of trackedClients.values()) {
      if (!c.isAdmin && c.ws.readyState === WebSocket.OPEN) {
        try {
          c.ws.send(payload);
        } catch {}
      }
    }
  };

  if (now - lastBroadcastTime >= THROTTLE_MS) {
    if (pendingBroadcastTimeout) {
      clearTimeout(pendingBroadcastTimeout);
      pendingBroadcastTimeout = null;
    }
    performBroadcast();
  } else {
    if (!pendingBroadcastTimeout) {
      pendingBroadcastTimeout = setTimeout(performBroadcast, THROTTLE_MS - (now - lastBroadcastTime));
    }
  }
});

oscTransport.on("beat", (val) => {
  const payload = JSON.stringify({
    type: "beat",
    beat: val
  });
  for (const c of trackedClients.values()) {
    if (!c.isAdmin && c.ws.readyState === WebSocket.OPEN) {
      try {
        c.ws.send(payload);
      } catch {}
    }
  }
});
