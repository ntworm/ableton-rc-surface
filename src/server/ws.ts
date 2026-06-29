import * as http from "node:http";
import { WebSocketServer, WebSocket } from "ws";
import { getExtensionContext, requireCtx } from "../context.js";
import { actualPort, actualHttpsPort, useHttps } from "./state.js";
import { getScaleLabel, playheadActive, playheadStartTime, playheadBaseTimeMs, broadcastPlayheadState } from "../live/state.js";
import { commands, getControlValues, applyMapping } from "../live/mappings.js";
import { mixBroadcastMixer, mixBroadcastStructure, mixMixerTick, mixStructureTick, mixClientsActive, trackMixClientConnected, trackMixClientDisconnected } from "../live/snapshots.js";
import { withTimeout, clamp01, clampN11, isArrayLike } from "../util/helpers.js";

export type ClientMode = "performance" | "admin" | "mix";

export interface MixSelection {
  trackId: string | null;
  deviceId: string | null;
}

export interface TrackedClient {
  id: string;
  displayName: string;
  isAdmin: boolean;
  mode: ClientMode;
  path: string;
  connectedAt: number;
  lastSeen: number;
  userAgent: string;
  lastData: Record<string, any> | null;
  history: Record<string, [number, number][]>;
  mixSelection: MixSelection | null;
  lastMixStructureKey: string;
  lastMixMixerKey: string;
  lastMixParamsKey: string;
  ws: WebSocket;
}

export const trackedClients = new Map<string, TrackedClient>();
export const adminSockets = new Set<WebSocket>();

export const CLIENT_STALE_MS = 35_000;
export const HISTORY_MAX = 300;

export const MIX_PROTOCOL_VERSION = 1;

export const CLIENT_CMD = {
  SET_VOLUME: "mix.setVolume",
  SET_PAN: "mix.setPan",
  TOGGLE_MUTE: "mix.toggleMute",
  TOGGLE_SOLO: "mix.toggleSolo",
  SET_SEND: "mix.setSend",
  SET_PARAM: "mix.setParam",
  RESCAN: "mix.rescan",
  SET_SELECTION: "mix.setSelection",
} as const;

export const SERVER_MSG = {
  HELLO: "mix.hello",
  SNAPSHOT: "mix.snapshot",
  TRACKS_CHANGED: "mix.tracks_changed",
  ACK: "mix.ack",
  ERROR: "mix.error",
  CLOSE: "mix.close",
} as const;

export const TRACK_TYPES = {
  REGULAR: "regular",
  GROUP: "group",
  RETURN: "return",
  MASTER: "master",
} as const;

export const PARAM_KIND = {
  CONTINUOUS: "continuous",
  ENUM: "enum",
  TOGGLE: "toggle",
  DISABLED: "disabled",
} as const;

export const mixWriteQueues = new Map<string, Promise<void>>();
const MIX_WRITE_TIMEOUT_MS = 1000;

let wsServer: WebSocketServer | null = null;
let adminWsServer: WebSocketServer | null = null;
let mixWsServer: WebSocketServer | null = null;

export function wssInit() {
  wsServer = new WebSocketServer({ noServer: true, perMessageDeflate: false });
  adminWsServer = new WebSocketServer({ noServer: true, perMessageDeflate: false });
  mixWsServer = new WebSocketServer({ noServer: true, perMessageDeflate: false });

  setupWssHandlers(wsServer, "/ws", "WS", false);
  setupWssHandlers(adminWsServer, "/admin/ws", "ADMIN-WS", true);
  setupMixWssHandlers(mixWsServer, "/mix/ws", "MIX-WS");

  return { wsServer, adminWsServer, mixWsServer };
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
  } else if (urlPath === "/mix/ws" && mixWsServer) {
    mixWsServer.handleUpgrade(req, socket, head, (ws) => {
      mixWsServer!.emit("connection", ws, req);
    });
  } else {
    socket.destroy();
  }
}

export function stopAllWsClients(): void {
  for (const c of [...trackedClients.values()]) {
    try { c.ws.close(1001, "server stopping"); } catch { /* ignore */ }
  }
  trackedClients.clear();
  adminSockets.clear();
  mixWriteQueues.clear();
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
    if (ws.readyState === ws.OPEN) {
      try { ws.send(json); } catch { /* ignore */ }
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

function setupWssHandlers(wss: WebSocketServer, path: string, label: string, isAdmin: boolean): void {
  wss.on("connection", (ws: WebSocket, req) => {
    const ts = new Date().toISOString();
    let queryClientId: string | null = null;
    try {
      if (req.url) {
        const urlObj = new URL(req.url, "http://localhost");
        queryClientId = urlObj.searchParams.get("client_id");
      }
    } catch {}

    const cryptoObj = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
    const clientId =
      queryClientId ??
      (typeof cryptoObj?.randomUUID === "function" ? cryptoObj.randomUUID() : null) ??
      `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}${Math.random().toString(36).slice(2, 10)}`;

    const existing = trackedClients.get(clientId);
    if (existing && existing.ws !== ws) {
      try {
        console.log(`[ableton-rc-bridge] closing existing duplicate connection for client ${clientId}`);
        existing.ws.close();
      } catch {}
      trackedClients.delete(clientId);
    }

    const info: TrackedClient = {
      id: clientId,
      displayName: "",
      isAdmin,
      mode: isAdmin ? "admin" : "performance",
      path,
      connectedAt: Date.now(),
      lastSeen: Date.now(),
      userAgent: req.headers["user-agent"] ?? "unknown",
      lastData: null,
      history: {},
      mixSelection: null,
      lastMixStructureKey: "",
      lastMixMixerKey: "",
      lastMixParamsKey: "",
      ws,
    };
    trackedClients.set(clientId, info);
    if (isAdmin) adminSockets.add(ws);

    console.log(
      `[${ts}] [ableton-rc-bridge] ${label} connected id=${clientId} ua=${info.userAgent.slice(0, 60)}`,
    );

    void (async () => {
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
      } catch {}

      if (ws.readyState === ws.OPEN) {
        const now = Date.now();
        const currentPos = playheadActive ? (playheadBaseTimeMs + (now - playheadStartTime)) : playheadBaseTimeMs;
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
      }
    })();

    if (isAdmin) {
      let sent = 0;
      for (const c of trackedClients.values()) {
        if (c.isAdmin) continue;
        pushClientUpdate(c);
        sent++;
      }
      console.log(
        `[ableton-rc-bridge] admin ${clientId} sent ${sent} existing client snapshot`,
      );
    } else {
      pushClientUpdate(info);
    }

    ws.on("message", (data) => {
      info.lastSeen = Date.now();
      const raw = data.toString();
      try {
        const parsed = JSON.parse(raw) as Record<string, any>;
        const t = parsed["type"];
        if (t === "snapshot") {
          const snapDisplayName = parsed["display_name"];
          if (typeof snapDisplayName === "string" && snapDisplayName !== info.displayName) {
            info.displayName = snapDisplayName;
          }
          const snapData = parsed["data"] as Record<string, any> | undefined;
          if (snapData) {
            info.lastData = snapData;
            const receivedAt = Date.now();
            const controls = (snapData["controls"] ?? []) as any[];
            for (const ctrl of controls) {
              if (ctrl && typeof ctrl === "object" && typeof ctrl.name === "string") {
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
                const gammaVal = (Math.max(-180, Math.min(180, orient.gamma)) + 360) % 360 / 360;
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
        } else if (t === "ping") {
          // ping received, stays active
        } else if (t === "toggle_play") {
          const mainState = require("./state.js"); // lazy import to avoid circular dependency
          // Playhead toggled handled in extension.ts or mappings
        } else if (t === "set_display_name") {
          const newName = parsed["display_name"];
          if (typeof newName === "string") {
            info.displayName = newName;
            pushClientUpdate(info);
          }
        } else {
          info.lastData = parsed;
        }
      } catch { /* ignore non-JSON */ }
      dispatch(ws, raw);
      pushClientUpdate(info);
    });

    ws.on("close", () => {
      console.log(`[ableton-rc-bridge] ${label} id=${clientId} disconnected`);
      if (isAdmin) adminSockets.delete(ws);
      info.lastSeen = 0;
      pushClientUpdate(info);
      const current = trackedClients.get(clientId);
      if (current && current.ws === ws) {
        trackedClients.delete(clientId);
      }
    });

    ws.on("error", (err) => {
      console.error(
        `[ableton-rc-bridge] ${label} id=${clientId} error: ${err.message}`,
      );
    });
  });
}

function dispatch(ws: WebSocket, raw: string): void {
  let msg: Record<string, unknown>;
  try {
    msg = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    console.log(`[ableton-rc-bridge] ws: non-JSON message (${raw.length} bytes) ignored`);
    return;
  }
  if (typeof msg["cmd"] !== "string") {
    const kind = typeof msg["type"] === "string" ? msg["type"] : "unknown";
    console.log(`[ableton-rc-bridge] ws: foreign msg type="${kind}" ignored`);
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
      console.error(`[ableton-rc-bridge] cmd ${cmd} failed: ${detail}`);
    });
}

function setupMixWssHandlers(wss: WebSocketServer, path: string, label: string): void {
  wss.on("connection", (ws: WebSocket, req) => {
    const ts = new Date().toISOString();
    let queryClientId: string | null = null;
    try {
      if (req.url) {
        const urlObj = new URL(req.url, "http://localhost");
        queryClientId = urlObj.searchParams.get("client_id");
      }
    } catch {}

    const cryptoObj = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
    const clientId =
      queryClientId ??
      (typeof cryptoObj?.randomUUID === "function" ? cryptoObj.randomUUID() : null) ??
      `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}${Math.random().toString(36).slice(2, 10)}`;

    const existing = trackedClients.get(clientId);
    if (existing && existing.ws !== ws) {
      try {
        console.log(`[ableton-rc-bridge] closing existing duplicate connection for client ${clientId}`);
        existing.ws.close();
      } catch {}
      trackedClients.delete(clientId);
    }

    const info: TrackedClient = {
      id: clientId,
      displayName: "Mix",
      isAdmin: false,
      mode: "mix",
      path,
      connectedAt: Date.now(),
      lastSeen: Date.now(),
      userAgent: req.headers["user-agent"] ?? "unknown",
      lastData: null,
      history: {},
      mixSelection: { trackId: null, deviceId: null },
      lastMixStructureKey: "",
      lastMixMixerKey: "",
      lastMixParamsKey: "",
      ws,
    };
    trackedClients.set(clientId, info);
    trackMixClientConnected();

    console.log(
      `[${ts}] [ableton-rc-bridge] ${label} connected id=${clientId} ua=${info.userAgent.slice(0, 60)}`,
    );
    if (label === "MIX-WS") {
      void mixStructureTick().then(mixBroadcastStructure);
      void mixMixerTick().then(mixBroadcastMixer);
    }

    if (ws.readyState === ws.OPEN) {
      ws.send(
        JSON.stringify({
          type: SERVER_MSG.HELLO,
          client_id: clientId,
          path,
          mode: "mix",
          protocolVersion: MIX_PROTOCOL_VERSION,
          commands: [
            CLIENT_CMD.SET_VOLUME,
            CLIENT_CMD.SET_PAN,
            CLIENT_CMD.TOGGLE_MUTE,
            CLIENT_CMD.TOGGLE_SOLO,
            CLIENT_CMD.SET_SEND,
            CLIENT_CMD.SET_PARAM,
            CLIENT_CMD.RESCAN,
          ],
          tiers: {
            structure: 2000,
            mixer: 200,
            params: 500,
          },
        }),
      );
    }
    pushClientUpdate(info);

    ws.on("message", (data) => {
      info.lastSeen = Date.now();
      const raw = data.toString();
      void mixDispatch(ws, info, raw);
      pushClientUpdate(info);
    });

    ws.on("close", () => {
      console.log(`[ableton-rc-bridge] ${label} id=${clientId} disconnected`);
      info.lastSeen = 0;
      pushClientUpdate(info);
      const current = trackedClients.get(clientId);
      if (current && current.ws === ws) {
        trackedClients.delete(clientId);
      }
      trackMixClientDisconnected();
    });

    ws.on("error", (err) => {
      console.error(
        `[ableton-rc-bridge] ${label} id=${clientId} error: ${err.message}`,
      );
    });
  });
}

export type MixParsedId = {
  kind: "track" | "device" | "parameter" | "send";
  type: "regular" | "group" | "return" | "master";
  trackIndex: number;
  deviceIndex: number | null;
  paramIndex: number | null;
  sendIndex: number | null;
};

export function mixParseId(id: unknown): MixParsedId | null {
  if (typeof id !== "string" || !id) return null;
  const parts = id.split(":");
  if (parts[0] !== "mix" || parts.length < 2) return null;
  const out: MixParsedId = {
    kind: "track", type: "regular",
    trackIndex: 0, deviceIndex: null, paramIndex: null, sendIndex: null,
  };
  if (parts[1] === "main") {
    out.type = "master";
    out.trackIndex = 0;
    if (parts.length === 2) return out;
    return mixParseSubSegments(parts, 2, out);
  }
  if (parts[1] === "track" || parts[1] === "return") {
    out.type = parts[1] === "return" ? "return" : "regular";
    const idx = Number(parts[2]);
    if (!Number.isInteger(idx) || idx < 0) return null;
    out.trackIndex = idx;
    if (parts.length === 3) return out;
    return mixParseSubSegments(parts, 3, out);
  }
  return null;
}

function mixParseSubSegments(parts: string[], start: number, out: MixParsedId): MixParsedId | null {
  let i = start;
  while (i < parts.length) {
    const seg = parts[i];
    const val = Number(parts[i + 1]);
    if (!Number.isInteger(val) || val < 0) return null;
    if (seg === "dev") {
      if (out.deviceIndex !== null) return null;
      out.kind = "device";
      out.deviceIndex = val;
      i += 2;
    } else if (seg === "par") {
      if (out.paramIndex !== null) return null;
      out.kind = "parameter";
      out.paramIndex = val;
      i += 2;
    } else if (seg === "send") {
      if (out.sendIndex !== null) return null;
      out.kind = "send";
      out.sendIndex = val;
      i += 2;
    } else {
      return null;
    }
  }
  return out;
}

export function mixWriteQueueKeyFor(parsed: MixParsedId): string {
  switch (parsed.kind) {
    case "track":
      if (parsed.type === "master") return "mix:main:volume";
      return `track:${parsed.type}:${parsed.trackIndex}`;
    case "send":
      return `send:${parsed.type}:${parsed.trackIndex}:${parsed.sendIndex ?? 0}`;
    case "parameter":
      return `param:${parsed.type}:${parsed.trackIndex}:${parsed.deviceIndex ?? 0}:${parsed.paramIndex ?? 0}`;
    default:
      return `unknown:${Date.now()}:${Math.random()}`;
  }
}

async function mixDispatch(ws: WebSocket, info: TrackedClient, raw: string): Promise<void> {
  let msg: Record<string, unknown>;
  try {
    msg = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    if (ws.readyState === ws.OPEN) {
      ws.send(JSON.stringify({ type: SERVER_MSG.ERROR, refId: null, reason: "invalid_json" }));
    }
    return;
  }
  const refId = typeof msg["refId"] === "string" ? (msg["refId"] as string) : null;
  const cmdType = typeof msg["type"] === "string" ? (msg["type"] as string) : null;
  if (!cmdType) {
    sendMixError(ws, refId, "missing_type");
    return;
  }
  if (cmdType === CLIENT_CMD.RESCAN) {
    const snaps = await import("../live/snapshots.js");
    snaps.clearMixStructureCache();
    if (ws.readyState === ws.OPEN) {
      ws.send(JSON.stringify({ type: SERVER_MSG.ACK, refId, ok: true }));
    }
    return;
  }
  if (cmdType === CLIENT_CMD.SET_SELECTION) {
    const sel = msg["selection"];
    if (sel && typeof sel === "object") {
      const s = sel as { trackId?: unknown; deviceId?: unknown };
      if (info.mixSelection) {
        if (typeof s.trackId === "string" || s.trackId === null) {
          info.mixSelection.trackId = typeof s.trackId === "string" ? s.trackId : null;
        }
        if (typeof s.deviceId === "string" || s.deviceId === null) {
          info.mixSelection.deviceId = typeof s.deviceId === "string" ? s.deviceId : null;
        }
      }
    }
    if (ws.readyState === ws.OPEN) {
      ws.send(JSON.stringify({ type: SERVER_MSG.ACK, refId, ok: true }));
    }
    return;
  }

  const targetId = msg["targetId"];
  const parsed = mixParseId(targetId);
  if (!parsed) {
    sendMixError(ws, refId, "invalid_target_id");
    return;
  }
  const value = typeof msg["value"] === "number" ? msg["value"] : NaN;

  let handlerResult: any = null;
  try {
    switch (cmdType) {
      case CLIENT_CMD.SET_VOLUME: {
        if (!Number.isFinite(value) || value < 0 || value > 1) { sendMixError(ws, refId, "bad_value"); return; }
        if (parsed.type === "return") { sendMixError(ws, refId, "unsupported_target"); return; }
        const res = await mixApplyWrite_(mixWriteQueueKeyFor(parsed), () => mixSetVolume(parsed, value), "setVolume");
        handlerResult = res;
        break;
      }
      case CLIENT_CMD.SET_PAN: {
        if (!Number.isFinite(value) || value < -1 || value > 1) { sendMixError(ws, refId, "bad_value"); return; }
        if (parsed.type === "return") { sendMixError(ws, refId, "unsupported_target"); return; }
        const res = await mixApplyWrite_(mixWriteQueueKeyFor(parsed), () => mixSetPan(parsed, value), "setPan");
        handlerResult = res;
        break;
      }
      case CLIENT_CMD.TOGGLE_MUTE: {
        if (parsed.type === "return") { sendMixError(ws, refId, "unsupported_target"); return; }
        const res = await mixApplyWrite_(mixWriteQueueKeyFor(parsed), () => mixToggleMute(parsed), "toggleMute");
        handlerResult = res;
        break;
      }
      case CLIENT_CMD.TOGGLE_SOLO: {
        if (parsed.type === "return" || parsed.type === "master") { sendMixError(ws, refId, "unsupported_target"); return; }
        const res = await mixApplyWrite_(mixWriteQueueKeyFor(parsed), () => mixToggleSolo(parsed), "toggleSolo");
        handlerResult = res;
        break;
      }
      case CLIENT_CMD.SET_SEND: {
        if (!Number.isFinite(value) || value < 0 || value > 1) { sendMixError(ws, refId, "bad_value"); return; }
        if (parsed.type === "master") { sendMixError(ws, refId, "unsupported_target"); return; }
        const res = await mixApplyWrite_(mixWriteQueueKeyFor(parsed), () => mixSetSend(parsed, value), "setSend");
        handlerResult = res;
        break;
      }
      case CLIENT_CMD.SET_PARAM: {
        if (!Number.isFinite(value) || value < 0 || value > 1) { sendMixError(ws, refId, "bad_value"); return; }
        const res = await mixApplyWrite_(mixWriteQueueKeyFor(parsed), () => mixSetParam(parsed, value), "setParam");
        handlerResult = res;
        break;
      }
      default:
        sendMixError(ws, refId, `unknown_command: ${cmdType}`);
        return;
    }
  } catch (e) {
    sendMixError(ws, refId, `dispatch_error: ${e instanceof Error ? e.message : String(e)}`);
    return;
  }

  if (!handlerResult) {
    sendMixError(ws, refId, "no_result");
    return;
  }
  if (handlerResult.ok) {
    if (ws.readyState === ws.OPEN) {
      ws.send(JSON.stringify({ type: SERVER_MSG.ACK, refId, ok: true, result: handlerResult.result }));
    }
  } else {
    sendMixError(ws, refId, handlerResult.reason);
  }
}

function sendMixError(ws: WebSocket, refId: string | null, reason: string): void {
  if (ws.readyState !== ws.OPEN) return;
  ws.send(JSON.stringify({ type: SERVER_MSG.ERROR, refId, reason }));
}

async function mixApplyWrite_<T>(key: string, fn: () => Promise<any>, label: string): Promise<any> {
  let result: any = { ok: false, reason: "no_result" };
  const prev = mixWriteQueues.get(key) ?? Promise.resolve();
  const next = prev.then(async () => {
    try {
      result = await withTimeout(fn(), MIX_WRITE_TIMEOUT_MS, label);
    } catch (e) {
      result = { ok: false, reason: `sdk_error: ${e instanceof Error ? e.message : String(e)}` };
    }
  });
  mixWriteQueues.set(key, next);
  await next;
  return result;
}

export function getSongSafely(): { tracks: ArrayLike<unknown>; returnTracks: ArrayLike<unknown>; mainTrack: unknown; mainTrackAvailable: boolean } | null {
  const extensionContext = getExtensionContext();
  if (!extensionContext) return null;
  const song = (extensionContext as any).application?.song;
  if (!song) return null;
  return {
    tracks: isArrayLike(song.tracks) ? (song.tracks as ArrayLike<unknown>) : [],
    returnTracks: isArrayLike(song.returnTracks) ? (song.returnTracks as ArrayLike<unknown>) : [],
    mainTrack: song.masterTrack ?? song.mainTrack ?? null,
    mainTrackAvailable: Boolean(song.masterTrack ?? song.mainTrack),
  };
}

export function mixResolveTrack(parsed: MixParsedId): { kind: "regular" | "group" | "return" | "master"; index: number; obj: any } | null {
  const song = getSongSafely();
  if (!song) return null;
  if (parsed.type === "master") {
    return song.mainTrackAvailable ? { kind: "master", index: 0, obj: song.mainTrack } : null;
  }
  if (parsed.type === "return") {
    const t = song.returnTracks[parsed.trackIndex];
    if (!t) return null;
    return { kind: "return", index: parsed.trackIndex, obj: t };
  }
  const t = song.tracks[parsed.trackIndex];
  if (!t) return null;
  return { kind: parsed.type, index: parsed.trackIndex, obj: t };
}

async function mixSetVolume(parsed: MixParsedId, value: number): Promise<any> {
  const r = mixResolveTrack(parsed);
  if (!r) return { ok: false, reason: "not_found" };
  if (r.kind === "return") return { ok: false, reason: "unsupported_target" };
  const mixer = safeReadMixer(r.obj);
  if (!mixer) return { ok: false, reason: "not_found" };
  const v = mixer.volume;
  if (!v || typeof v.setValue !== "function") return { ok: false, reason: "not_found" };
  try {
    const min = typeof v.min === "number" ? v.min : 0;
    const max = typeof v.max === "number" ? v.max : 1;
    const scaled = min + clamp01(value) * (max - min);
    await v.setValue(scaled);
    return { ok: true };
  } catch (e) {
    return { ok: false, reason: `sdk_error: ${e instanceof Error ? e.message : String(e)}` };
  }
}

async function mixSetPan(parsed: MixParsedId, value: number): Promise<any> {
  const r = mixResolveTrack(parsed);
  if (!r) return { ok: false, reason: "not_found" };
  if (r.kind === "return") return { ok: false, reason: "unsupported_target" };
  const mixer = safeReadMixer(r.obj);
  if (!mixer) return { ok: false, reason: "not_found" };
  const p = mixer.panning;
  if (!p || typeof p.setValue !== "function") return { ok: false, reason: "not_found" };
  try {
    const min = typeof p.min === "number" ? p.min : -1;
    const max = typeof p.max === "number" ? p.max : 1;
    const wire = clampN11(value);
    const scaled = min + ((wire + 1) / 2) * (max - min);
    await p.setValue(scaled);
    return { ok: true };
  } catch (e) {
    return { ok: false, reason: `sdk_error: ${e instanceof Error ? e.message : String(e)}` };
  }
}

async function mixToggleMute(parsed: MixParsedId): Promise<any> {
  const r = mixResolveTrack(parsed);
  if (!r) return { ok: false, reason: "not_found" };
  if (r.kind === "return") return { ok: false, reason: "unsupported_target" };
  const t = r.obj;
  const next = !(t.mute === true);
  try {
    t.mute = next;
    return { ok: true, result: { mute: next } };
  } catch (e) {
    return { ok: false, reason: `sdk_error: ${e instanceof Error ? e.message : String(e)}` };
  }
}

async function mixToggleSolo(parsed: MixParsedId): Promise<any> {
  const r = mixResolveTrack(parsed);
  if (!r) return { ok: false, reason: "not_found" };
  if (r.kind === "return" || r.kind === "master") return { ok: false, reason: "unsupported_target" };
  const t = r.obj;
  const next = !(t.solo === true);
  try {
    t.solo = next;
    return { ok: true, result: { solo: next } };
  } catch (e) {
    return { ok: false, reason: `sdk_error: ${e instanceof Error ? e.message : String(e)}` };
  }
}

async function mixSetSend(parsed: MixParsedId, value: number): Promise<any> {
  if (parsed.kind !== "send" || parsed.sendIndex === null) return { ok: false, reason: "not_found" };
  const r = mixResolveTrack(parsed);
  if (!r) return { ok: false, reason: "not_found" };
  if (r.kind === "master") return { ok: false, reason: "unsupported_target" };
  const mixer = safeReadMixer(r.obj);
  if (!mixer) return { ok: false, reason: "not_found" };
  const sends = mixer.sends;
  if (!Array.isArray(sends)) return { ok: false, reason: "not_found" };
  const send = sends[parsed.sendIndex];
  if (!send || typeof send.setValue !== "function") return { ok: false, reason: "not_found" };
  try {
    const min = typeof send.min === "number" ? send.min : 0;
    const max = typeof send.max === "number" ? send.max : 1;
    const scaled = min + clamp01(value) * (max - min);
    await send.setValue(scaled);
    return { ok: true };
  } catch (e) {
    return { ok: false, reason: `sdk_error: ${e instanceof Error ? e.message : String(e)}` };
  }
}

async function mixSetParam(parsed: MixParsedId, value: number): Promise<any> {
  if (parsed.kind !== "parameter" || parsed.deviceIndex === null || parsed.paramIndex === null) {
    return { ok: false, reason: "not_found" };
  }
  const r = mixResolveTrack(parsed);
  if (!r) return { ok: false, reason: "not_found" };
  if (r.kind === "return") return { ok: false, reason: "unsupported_target" };
  const t = r.obj;
  if (!Array.isArray(t.devices)) return { ok: false, reason: "not_found" };
  const device = t.devices[parsed.deviceIndex];
  if (!device || !Array.isArray(device.parameters)) return { ok: false, reason: "not_found" };
  const param = device.parameters[parsed.paramIndex];
  if (!param || typeof param.setValue !== "function") return { ok: false, reason: "not_found" };
  try {
    const min = typeof param.min === "number" ? param.min : 0;
    const max = typeof param.max === "number" ? param.max : 1;
    const scaled = min + clamp01(value) * (max - min);
    await param.setValue(scaled);
    return { ok: true };
  } catch (e) {
    return { ok: false, reason: `sdk_error: ${e instanceof Error ? e.message : String(e)}` };
  }
}

export function safeReadMixer(track: any): Record<string, any> | null {
  if (!track || typeof track !== "object") return null;
  const mixer = track.mixer;
  if (!mixer || typeof mixer !== "object") return null;
  return mixer;
}
