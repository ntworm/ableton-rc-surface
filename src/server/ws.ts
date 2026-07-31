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
  getProjectConfigStatus,
  handleClientDisconnect,
  updateHostModulator,
} from "../live/mappings.js";
import { createClientId } from "./client-id.js";
import { oscTransport } from "../live/osc-transport.js";
import { authenticateRequest, checkSameOrigin, classifyRequestToken, validateSameOrigin, type SessionRole } from "./session-auth.js";
import { dispatchCommand, isRoleAuthorized, type CommandEnvelope } from "./command-dispatch.js";
import {
  PER_MESSAGE_DEFLATE,
  MAX_PAYLOAD_BYTES,
  MAX_CLIENT_NAME_LENGTH,
  MAX_CONTROLS_PER_SNAPSHOT,
  HISTORY_RING_SIZE,
  sanitizeNumber,
  sanitizeClientName,
  isValidControlName,
  boundSnapshotControls,
  createRateLimiter,
  consumeToken,
  type RateLimiterState,
} from "./ws-bounds.js";
import { sendWithBackpressure } from "./backpressure.js";
import { getQueryParam } from "../util/url.js";

export type ClientMode = "performance" | "admin";

/**
 * Why a session has the role it has.
 *  - "valid": the presented token matched a currently-issued token.
 *  - "stale": a token was presented but no longer matches — almost always a
 *    page left open across an Ableton restart, which regenerates tokens.
 *  - "none": no token was presented at all (an ordinary viewer).
 */
export type TokenStatus = "valid" | "stale" | "none";

export interface TrackedClient {
  id: string;
  ipAddress: string;
  displayName: string;
  role: SessionRole;
  tokenStatus: TokenStatus;
  isAdmin: boolean;
  mode: ClientMode;
  path: string;
  connectedAt: number;
  lastSeen: number;
  userAgent: string;
  lastData: Record<string, any> | null;
  history: Record<string, [number, number][]>;
  ws: WebSocket;
  rateLimiter: RateLimiterState;
}

export const trackedClients = new Map<string, TrackedClient>();
export const adminSockets = new Set<WebSocket>();

export const CLIENT_STALE_MS = 35_000;
export const HISTORY_MAX = HISTORY_RING_SIZE;

let wsServer: WebSocketServer | null = null;
let adminWsServer: WebSocketServer | null = null;

export function wssInit() {
  wsServer = new WebSocketServer({
    noServer: true,
    perMessageDeflate: PER_MESSAGE_DEFLATE,
    maxPayload: MAX_PAYLOAD_BYTES,
  });
  adminWsServer = new WebSocketServer({
    noServer: true,
    perMessageDeflate: PER_MESSAGE_DEFLATE,
    maxPayload: MAX_PAYLOAD_BYTES,
  });

  setupWssHandlers(wsServer, "/ws", "WS", false);
  setupWssHandlers(adminWsServer, "/admin/ws", "ADMIN-WS", true);

  return { wsServer, adminWsServer };
}

/**
 * Last reason an upgrade was refused, for /diag. A destroyed socket gives the
 * browser only "WebSocket connection failed" with no close code, so without
 * this the cause is invisible from the client side.
 */
export let lastUpgradeRejection: { at: number; path: string; reason: string; detail: string } | null = null;

function refuseUpgrade(socket: any, path: string, reason: string, detail: string): void {
  lastUpgradeRejection = { at: Date.now(), path, reason, detail };
  console.warn(`[ableton-rc-surface] WS upgrade refused path=${path} reason=${reason} ${detail}`);
  socket.destroy();
}

export function handleUpgrade(req: http.IncomingMessage, socket: any, head: Buffer) {
  const urlPath = (req.url ? req.url.split("?")[0] : "") ?? "";
  const origin = checkSameOrigin(req);
  if (!origin.ok) {
    refuseUpgrade(
      socket,
      urlPath,
      `origin-${origin.reason}`,
      `origin=${origin.originValue ?? "<none>"} host=${origin.hostValue ?? "<none>"} ` +
        `originPort=${origin.originPort ?? "-"} hostPort=${origin.hostPort ?? "-"}`,
    );
    return;
  }
  if (urlPath === "/ws") {
    if (!wsServer) {
      // The HTTP server is still serving pages while the WebSocket server is
      // gone — every upgrade dies silently and the phone retries forever.
      refuseUpgrade(socket, urlPath, "ws-server-not-initialised", "wssInit() has not run or the server was stopped");
      return;
    }
    wsServer.handleUpgrade(req, socket, head, (ws) => {
      wsServer!.emit("connection", ws, req);
    });
  } else if (urlPath === "/admin/ws") {
    if (!adminWsServer) {
      refuseUpgrade(socket, urlPath, "admin-ws-server-not-initialised", "wssInit() has not run or the server was stopped");
      return;
    }
    const role = authenticateRequest(req);
    if (role !== "admin") {
      refuseUpgrade(socket, urlPath, "admin-role-required", `resolved role=${role}`);
      return;
    }
    adminWsServer.handleUpgrade(req, socket, head, (ws) => {
      adminWsServer!.emit("connection", ws, req);
    });
  } else {
    refuseUpgrade(socket, urlPath, "unknown-upgrade-path", "expected /ws or /admin/ws");
  }
}

export function stopAllWsClients(): void {
  if (pendingBroadcastTimeout) {
    clearTimeout(pendingBroadcastTimeout);
    pendingBroadcastTimeout = null;
  }
  for (const c of [...trackedClients.values()]) {
    try {
      c.ws.terminate();
    } catch {
      // ignore
    }
  }
  trackedClients.clear();
  adminSockets.clear();
  if (wsServer) {
    try {
      wsServer.clients.forEach((client) => client.terminate());
      wsServer.close();
    } catch {
      // ignore
    }
    wsServer = null;
  }
  if (adminWsServer) {
    try {
      adminWsServer.clients.forEach((client) => client.terminate());
      adminWsServer.close();
    } catch {
      // ignore
    }
    adminWsServer = null;
  }
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
      sendWithBackpressure(ws, json, "critical");
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
 * (REMOVED) IP-based deduplication was removed per ADR-004.
 * Identity is now `client_id` + session (WebSocket instance).
 * Two devices behind the same NAT coexist without confusion.
 * A reconnecting phone replaces only its own prior session
 * (matched by client_id in setupWssHandlers).
 *
 * Kept as a no-op export for backward compatibility with tests
 * referencing this function.
 */
export function closeDuplicateIpClients(
  _ipAddress: string,
  _clientId: string,
  _isAdmin: boolean,
): void {
  // no-op: identity is client_id + session, not IP
}

function setupWssHandlers(wss: WebSocketServer, path: string, label: string, isAdminPath: boolean): void {
  wss.on("connection", (ws: WebSocket, req) => {
    if (!validateSameOrigin(req)) {
      ws.close(4003, "Forbidden: Same-Origin violation");
      return;
    }
    const classification = classifyRequestToken(req);
    const role = classification.role;
    if (isAdminPath && role !== "admin") {
      ws.close(4003, "Forbidden: admin role required");
      return;
    }
    const tokenStatus: TokenStatus = classification.tokenValid
      ? "valid"
      : classification.tokenPresent
        ? "stale"
        : "none";
    const isAdmin = role === "admin";
    const ts = new Date().toISOString();
    // getQueryParam, not `new URL`: Live's extension host has no URL global,
    // so this used to throw and every reconnect was handed a brand-new id.
    const queryClientId: string | null = getQueryParam(req.url, "client_id");

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

    // IP-based deduplication removed per ADR-004; identity is client_id + session.

    const info: TrackedClient = {
      id: clientId,
      ipAddress,
      displayName: "",
      role,
      tokenStatus,
      isAdmin,
      mode: isAdmin ? "admin" : "performance",
      path,
      connectedAt: Date.now(),
      lastSeen: Date.now(),
      userAgent: String(req.headers["user-agent"] ?? "unknown"),
      lastData: null,
      history: {},
      ws,
      rateLimiter: createRateLimiter(),
    };
    trackedClients.set(clientId, info);
    if (isAdmin) adminSockets.add(ws);

    console.log(
      `[${ts}] [ableton-rc-surface] ${label} connected id=${clientId} role=${role} token=${tokenStatus} ua=${info.userAgent.slice(0, 60)}`,
    );
    if (tokenStatus === "stale") {
      console.warn(
        `[ableton-rc-surface] ${label} id=${clientId} presented an expired token — ` +
          `the client is almost certainly a page left open across a restart. ` +
          `It is connected as viewer and all live-write commands will be rejected.`,
      );
    }

    void sendHello(ws, info, path);

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
      // ── Rate limiting (ADR-004) ──
      if (!consumeToken(info.rateLimiter)) {
        // Silently drop rate-limited messages. On excessive violations
        // the client would be disconnected by backpressure anyway.
        return;
      }
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
      dispatch(ws, info, raw);
      pushClientUpdate(info);
    });

    ws.on("close", () => {
      console.log(`[ableton-rc-surface] ${label} id=${clientId} disconnected`);
      if (isAdmin) adminSockets.delete(ws);
      if (!isAdmin) {
        clearHostModulatorsForClient(clientId);
        void handleClientDisconnect(clientId);
      }
      info.lastSeen = 0;
      pushClientUpdate(info);
      const current = trackedClients.get(clientId);
      if (current && current.ws === ws) {
        trackedClients.delete(clientId);
      }
    });

    ws.on("error", (err) => {
      console.error(`[ableton-rc-surface] ${label} id=${clientId} error: ${err.message}`);
      try {
        ws.terminate();
      } catch {
        // ignore
      }
    });
  });
}

async function sendHello(ws: WebSocket, info: TrackedClient, path: string): Promise<void> {
  const clientId = info.id;
  const isAdmin = info.isAdmin;
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
      try {
        initValues = await Promise.race([
          getControlValues(clientId),
          new Promise<Record<string, number>>((resolve) =>
            setTimeout(() => resolve({}), 1000),
          ),
        ]);
      } catch {
        initValues = {};
      }
    }
  } catch {
    // ignore; hello still carries safe defaults
  }

  if (ws.readyState === WebSocket.OPEN) {
    const now = Date.now();
    const currentPos = playheadActive ? playheadBaseTimeMs + (now - playheadStartTime) : playheadBaseTimeMs;
    sendWithBackpressure(
      ws,
      JSON.stringify({
        type: "hello",
        client_id: clientId,
        role: info.role,
        tokenStatus: info.tokenStatus,
        path,
        commands: Object.keys(commands),
        tempo: initTempo,
        signature: initSig,
        scale: initScale,
        playheadActive,
        playheadTimeMs: currentPos,
        values: initValues,
        projectConfig: getProjectConfigStatus(),
      }),
      "critical",
    );
    if (!isAdmin) {
      sendWithBackpressure(
        ws,
        JSON.stringify({
          type: "transport_state",
          state: oscTransport.state,
        }),
        "critical",
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
    if (!isRoleAuthorized(info.role, "live-write")) {
      return { handled: true, pushClientUpdate: false };
    }
    const snapDisplayName = parsed["display_name"];
    if (typeof snapDisplayName === "string" && snapDisplayName !== info.displayName) {
      info.displayName = sanitizeClientName(snapDisplayName);
    }
    const snapData = parsed["data"] as Record<string, any> | undefined;
    if (snapData) {
      // Validate controls count per ADR-004
      const rawControls = (snapData["controls"] ?? []) as unknown[];
      const bounded = boundSnapshotControls(rawControls);
      if (bounded === null) {
        // Too many controls — reject the snapshot
        return { handled: true, pushClientUpdate: false };
      }
      snapData["controls"] = bounded;
      handleSnapshot(info, snapData);
    }
    return { handled: true, pushClientUpdate: true };
  } else if (t === "control") {
    if (!isRoleAuthorized(info.role, "live-write")) {
      return { handled: true, pushClientUpdate: false };
    }
    handleControl(info, parsed["control"], Date.now());
    return { handled: true, pushClientUpdate: true };
  } else if (t === "modulator") {
    if (!isRoleAuthorized(info.role, "live-write")) {
      return { handled: true, pushClientUpdate: false };
    }
    updateHostModulator(info.id, (parsed["modulator"] ?? {}) as Record<string, any>);
    info.lastData = parsed;
    return { handled: true, pushClientUpdate: false };
  } else if (t === "ping") {
    sendWithBackpressure(ws, JSON.stringify({ type: "pong", ts: parsed["ts"] || Date.now() }), "critical");
    return { handled: true, pushClientUpdate: false };
  } else if (t === "toggle_play") {
    if (!isRoleAuthorized(info.role, "live-write")) {
      return { handled: true, pushClientUpdate: false };
    }
    togglePlayhead();
    return { handled: true, pushClientUpdate: false };
  } else if (t === "set_display_name") {
    const newName = parsed["display_name"];
    if (typeof newName === "string") {
      info.displayName = sanitizeClientName(newName);
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
  if (!ctrl || typeof ctrl !== "object" || !isValidControlName(ctrl.name)) return;
  const name: string = ctrl.name;
  // `lost: true` means the client has no real reading for this control right
  // now (hand out of frame, sensor denied). The value carried alongside it is
  // meaningless — applyMapping resolves what to do from the target's Safe loss
  // policy instead of trusting it.
  const lost = ctrl.lost === true;
  if (typeof ctrl.x === "number" && typeof ctrl.y === "number") {
    const sx = sanitizeNumber(ctrl.x);
    const sy = sanitizeNumber(ctrl.y);
    appendHistory(info, `${name}.x`, sx, receivedAt);
    appendHistory(info, `${name}.y`, sy, receivedAt);
    void applyMapping(info.id, `${name}.x`, sx, lost);
    void applyMapping(info.id, `${name}.y`, sy, lost);
  } else if (typeof ctrl.value === "number") {
    const sv = sanitizeNumber(ctrl.value);
    appendHistory(info, name, sv, receivedAt);
    void applyMapping(info.id, name, sv, lost);
  }
}

function handleSnapshot(info: TrackedClient, snapData: Record<string, any>): void {
  info.lastData = snapData;
  const receivedAt = Date.now();
  const controls = (snapData["controls"] ?? []) as any[];
  const controlNames = new Set<string>();
  for (const ctrl of controls) {
    if (ctrl && typeof ctrl.name === "string") {
      if (typeof ctrl.x === "number" && typeof ctrl.y === "number") {
        controlNames.add(`${ctrl.name}.x`);
        controlNames.add(`${ctrl.name}.y`);
      } else {
        controlNames.add(ctrl.name);
      }
    }
    handleControl(info, ctrl, receivedAt);
  }

  const orient = snapData["orient"];
  if (orient && typeof orient === "object") {
    if (typeof orient.alpha === "number" && !controlNames.has("sensor.orient.alpha")) {
      const alphaVal = Math.max(0, Math.min(360, orient.alpha)) / 360;
      appendHistory(info, "sensor.orient.alpha", alphaVal, receivedAt);
      void applyMapping(info.id, "sensor.orient.alpha", alphaVal);
    }
    if (typeof orient.beta === "number" && !controlNames.has("sensor.orient.beta")) {
      const betaVal = (Math.max(-90, Math.min(90, orient.beta)) + 90) / 180;
      appendHistory(info, "sensor.orient.beta", betaVal, receivedAt);
      void applyMapping(info.id, "sensor.orient.beta", betaVal);
    }
    if (typeof orient.gamma === "number" && !controlNames.has("sensor.orient.gamma")) {
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

    if (motion.ax !== undefined && !controlNames.has("sensor.motion.ax")) {
      const val = mapAccel(motion.ax);
      appendHistory(info, "sensor.motion.ax", val, receivedAt);
      void applyMapping(info.id, "sensor.motion.ax", val);
    }
    if (motion.ay !== undefined && !controlNames.has("sensor.motion.ay")) {
      const val = mapAccel(motion.ay);
      appendHistory(info, "sensor.motion.ay", val, receivedAt);
      void applyMapping(info.id, "sensor.motion.ay", val);
    }
    if (motion.az !== undefined && !controlNames.has("sensor.motion.az")) {
      const val = mapAccel(motion.az);
      appendHistory(info, "sensor.motion.az", val, receivedAt);
      void applyMapping(info.id, "sensor.motion.az", val);
    }
    if (motion.gx !== undefined && !controlNames.has("sensor.motion.gx")) {
      const val = mapGyro(motion.gx);
      appendHistory(info, "sensor.motion.gx", val, receivedAt);
      void applyMapping(info.id, "sensor.motion.gx", val);
    }
    if (motion.gy !== undefined && !controlNames.has("sensor.motion.gy")) {
      const val = mapGyro(motion.gy);
      appendHistory(info, "sensor.motion.gy", val, receivedAt);
      void applyMapping(info.id, "sensor.motion.gy", val);
    }
    if (motion.gz !== undefined && !controlNames.has("sensor.motion.gz")) {
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
    oscTransport.stopPlayback();
  } else {
    setPlayheadStartTime(now);
    setPlayheadActive(true);
    oscTransport.play();
  }
  broadcastPlayheadState();
}

export function isCommandEnvelope(
  msg: Record<string, unknown>,
): msg is Record<string, unknown> & { cmd: string } {
  return typeof msg["cmd"] === "string";
}

function dispatch(ws: WebSocket, info: TrackedClient, raw: string): void {
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
  const envelope: CommandEnvelope = {
    id: typeof msg["id"] === "string" ? msg["id"] : undefined,
    cmd: String(msg["cmd"]),
    args: (msg["args"] ?? {}) as Record<string, unknown>,
  };

  dispatchCommand(info.role, envelope)
    .then((result) => {
      sendWithBackpressure(ws, JSON.stringify(result), "critical");
    })
    .catch((err) => {
      const id = envelope.id;
      const detail = err instanceof Error ? err.message : String(err);
      sendWithBackpressure(ws, JSON.stringify({ id, ok: false, error: detail }), "critical");
      console.error(`[ableton-rc-surface] cmd ${envelope.cmd} failed: ${detail}`);
    });
}

let lastBroadcastTime = 0;
let pendingBroadcastTimeout: NodeJS.Timeout | null = null;
const THROTTLE_MS = 100;

oscTransport.on("update", (state) => {
  if (typeof state.isPlaying === "boolean" && state.isPlaying !== playheadActive) {
    setPlayheadActive(state.isPlaying);
    if (state.isPlaying) {
      setPlayheadStartTime(Date.now());
    }
    broadcastPlayheadState();
  }

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
        sendWithBackpressure(c.ws, payload, "telemetry");
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
      sendWithBackpressure(c.ws, payload, "telemetry");
    }
  }
});
