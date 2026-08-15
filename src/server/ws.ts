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
  HISTORY_RING_SIZE,
  RATE_BURST,
  RATE_SUSTAINED_PER_SEC,
  sanitizeNumber,
  sanitizeClientName,
  isValidControlName,
  boundSnapshotControls,
  createRateLimiter,
  consumeToken,
  takeRateLimitNotice,
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
  /**
   * Monotonic count of samples ever appended per control. The ring buffer
   * above rotates, so its length cannot be used to work out what an admin has
   * already seen — after a rotation the length is unchanged while the contents
   * moved. This counter never rewinds, so the delta is always exact.
   */
  historyWritten: Record<string, number>;
  /** Per-control sample totals already broadcast to admins. */
  adminHistoryCursor: Record<string, number>;
  ws: WebSocket;
  rateLimiter: RateLimiterState;
  /** Throttle state for the admin client_update feed. Lazily created. */
  adminUpdateGate?: { lastAt: number; timer: NodeJS.Timeout | null };
}

export const trackedClients = new Map<string, TrackedClient>();
export const adminSockets = new Set<WebSocket>();

/**
 * Aggregate rate-limit pressure, for /diag. Deliberately a total and a client
 * count rather than a per-client breakdown: /diag answers without a token, so
 * it must not enumerate who is on the network.
 */
export function getRateLimitDiagnostics(): { clients: number; totalViolations: number } {
  let totalViolations = 0;
  for (const c of trackedClients.values()) totalViolations += c.rateLimiter.violations;
  return { clients: trackedClients.size, totalViolations };
}

export const CLIENT_STALE_MS = 35_000;
export const HISTORY_MAX = HISTORY_RING_SIZE;

/**
 * Close code for a socket that lost its client_id to a newer connection.
 *
 * The client uses it to tell "the session moved elsewhere" apart from "the
 * link dropped": the first must not be retried, the second must.
 */
export const SESSION_REPLACED_CODE = 4009;

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
    clearClientUpdateGate(c);
    try {
      c.ws.terminate();
    } catch {
      // ignore
    }
  }
  resetSurfaceState();
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

// ── Shared control surface ───────────────────────────────────────────────────
//
// Every connected client is a view onto ONE surface, not a surface of its own.
// A move made on any of them belongs to all of them, the way a fader on a
// physical mixer looks the same to everyone standing at it.

/** The surface's current value for each control. */
export const surfaceControlValues = new Map<string, number>();

/** Smallest change worth telling the other views about. */
const SURFACE_SYNC_EPSILON = 0.0005;

/**
 * One frame of coalescing. Phones restate their whole control set at 30 Hz, so
 * changes are gathered and sent once per frame instead of one message per
 * control per snapshot.
 */
export const CONTROL_SYNC_INTERVAL_MS = 33;

interface PendingSurfaceChange {
  value: number;
  /** Who moved it — they must not be sent their own move back. */
  origin: string;
}

const pendingSurfaceChanges = new Map<string, PendingSurfaceChange>();
let surfaceSyncTimer: NodeJS.Timeout | null = null;

/**
 * Sensor readings are a property of the device that produced them: my phone's
 * tilt, my camera's hand position. They are not part of the shared surface and
 * fanning them out would be both meaningless and a flood.
 */
function isSharedSurfaceControl(name: string): boolean {
  return !name.startsWith("sensor.");
}

function otherClientsConnected(): boolean {
  let performers = 0;
  for (const c of trackedClients.values()) {
    if (c.isAdmin) continue;
    performers += 1;
    if (performers > 1) return true;
  }
  return false;
}

/**
 * Record a control's new value on the surface and queue it for the other
 * views. Values that did not move are dropped here: a phone restates its whole
 * control set every frame whether or not anything changed.
 */
export function recordSurfaceValue(origin: string, name: string, value: number): void {
  if (!isSharedSurfaceControl(name)) return;
  const previous = surfaceControlValues.get(name);
  if (previous !== undefined && Math.abs(previous - value) < SURFACE_SYNC_EPSILON) return;
  surfaceControlValues.set(name, value);

  // Nobody else is looking; the surface state is still worth keeping for
  // whoever connects next, but there is nothing to send.
  if (!otherClientsConnected()) return;

  pendingSurfaceChanges.set(name, { value, origin });
  if (surfaceSyncTimer) return;
  surfaceSyncTimer = setTimeout(flushSurfaceSync, CONTROL_SYNC_INTERVAL_MS);
  surfaceSyncTimer.unref?.();
}

function flushSurfaceSync(): void {
  surfaceSyncTimer = null;
  if (pendingSurfaceChanges.size === 0) return;
  const changes = [...pendingSurfaceChanges.entries()];
  pendingSurfaceChanges.clear();

  for (const c of trackedClients.values()) {
    if (c.isAdmin || c.ws.readyState !== WebSocket.OPEN) continue;
    const controls: Record<string, number> = {};
    let any = false;
    for (const [name, change] of changes) {
      // Never hand a client its own move back: the echo arrives while the
      // finger is still on the control and fights it.
      if (change.origin === c.id) continue;
      controls[name] = change.value;
      any = true;
    }
    if (!any) continue;
    sendWithBackpressure(c.ws, JSON.stringify({ type: "control_sync", controls }), "telemetry");
  }
}

/** Drop the surface state. Used when the server stops. */
export function resetSurfaceState(): void {
  if (surfaceSyncTimer) {
    clearTimeout(surfaceSyncTimer);
    surfaceSyncTimer = null;
  }
  pendingSurfaceChanges.clear();
  surfaceControlValues.clear();
}

export function appendHistory(c: TrackedClient, name: string, value: number, ts: number): void {
  if (!c.history) c.history = {};
  if (!c.history[name]) c.history[name] = [];
  const series = c.history[name];
  series.push([ts, value]);
  if (series.length > HISTORY_MAX) {
    series.splice(0, series.length - HISTORY_MAX);
  }
  if (!c.historyWritten) c.historyWritten = {};
  c.historyWritten[name] = (c.historyWritten[name] ?? 0) + 1;
}

export function broadcastToAdmins(payload: object): void {
  // Serialising first and looking for a listener afterwards meant every
  // client_update paid for a full JSON.stringify of the client's history ring
  // even during a gig with no dashboard open — on the host-modulator path that
  // is 250 stringifies a second, per active LFO, thrown straight away.
  if (adminSockets.size === 0) return;
  const json = JSON.stringify(payload);
  for (const ws of adminSockets) {
    if (ws.readyState === WebSocket.OPEN) {
      sendWithBackpressure(ws, json, "critical");
    }
  }
}

/**
 * Minimum spacing between client_update broadcasts for the same client.
 * The admin dashboard is a monitor, not an audio path: 20 Hz is past what it
 * can render, while the producers behind it run at 30 Hz (snapshots) and
 * 250 Hz (host modulators).
 */
export const CLIENT_UPDATE_MIN_INTERVAL_MS = 50;

/**
 * Build the history portion of a client_update.
 *
 * A full send carries every ring for every control — with a dashboard open at
 * 20 Hz that is the same ~100 KB of mostly-unchanged samples over and over,
 * enough on its own to push a client past the backpressure drop threshold.
 * After the first send an admin already holds the rings, so only the samples
 * it has not seen go on the wire.
 *
 * `history` (full) and `historyDelta` (incremental) are separate fields so a
 * receiver can tell "here is everything" from "add these": the panel and the
 * mappings dashboard both key off which one is present.
 */
function buildHistoryPayload(c: TrackedClient, full: boolean): Record<string, unknown> {
  if (!c.historyWritten) c.historyWritten = {};
  if (!c.adminHistoryCursor) c.adminHistoryCursor = {};

  if (full) {
    c.adminHistoryCursor = { ...c.historyWritten };
    return { history: c.history };
  }

  const delta: Record<string, [number, number][]> = {};
  for (const [name, written] of Object.entries(c.historyWritten)) {
    const seen = c.adminHistoryCursor[name] ?? 0;
    const pending = written - seen;
    if (pending <= 0) continue;
    const series = c.history[name] ?? [];
    // The ring may have dropped samples the admin never saw. Sending what
    // survives is the honest best effort; the gap is older than the ring.
    delta[name] = pending >= series.length ? series.slice() : series.slice(-pending);
    c.adminHistoryCursor[name] = written;
  }
  return { historyDelta: delta };
}

function emitClientUpdate(c: TrackedClient, full = false): void {
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
    ...buildHistoryPayload(c, full),
  });
}

export function clearClientUpdateGate(c: TrackedClient): void {
  if (c.adminUpdateGate?.timer) clearTimeout(c.adminUpdateGate.timer);
  delete c.adminUpdateGate;
}

/**
 * Notify admin dashboards that a client's state moved.
 *
 * Leading-edge throttled: the first update of a burst goes out at once (a
 * connect, a name change and a disconnect must never wait), the rest coalesce
 * into one trailing emit per window so the newest state is still delivered.
 * The throttle state lives on the client so it dies with the session — no
 * registry to drain, no gate outliving the socket it was gating.
 *
 * `immediate` bypasses the throttle for state that must not be coalesced away
 * — currently the disconnect notice. `full` sends the complete history rings
 * instead of a delta, and implies `immediate`: it happens when a dashboard
 * connects and has nothing to draw until it lands.
 */
export function pushClientUpdate(
  c: TrackedClient,
  options: { immediate?: boolean; full?: boolean } = {},
): void {
  if (c.isAdmin) return;
  if (adminSockets.size === 0) return;

  let gate = c.adminUpdateGate;
  if (!gate) {
    gate = { lastAt: 0, timer: null };
    c.adminUpdateGate = gate;
  }

  const full = options.full === true;
  const now = Date.now();
  const elapsed = now - gate.lastAt;
  if (full || options.immediate || elapsed >= CLIENT_UPDATE_MIN_INTERVAL_MS) {
    if (gate.timer) {
      clearTimeout(gate.timer);
      gate.timer = null;
    }
    gate.lastAt = now;
    emitClientUpdate(c, full);
    return;
  }

  // A trailing emit is already scheduled; it will pick up the newest state.
  if (gate.timer) return;
  gate.timer = setTimeout(() => {
    gate.timer = null;
    gate.lastAt = Date.now();
    emitClientUpdate(c);
  }, CLIENT_UPDATE_MIN_INTERVAL_MS - elapsed);
  gate.timer.unref?.();
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
        // Say *why* it is being closed. A phone's client_id lives in
        // localStorage and a cookie, so every tab of the same origin claims the
        // same one — and a tab that is merely told "closed" reconnects a second
        // later, evicts the tab that replaced it, and the two trade the session
        // back and forth for as long as both stay open.
        existing.ws.close(SESSION_REPLACED_CODE, "session replaced by a newer connection");
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
      historyWritten: {},
      adminHistoryCursor: {},
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
        // A dashboard that just connected holds no rings yet, so this one
        // has to carry them in full; everything after it is a delta.
        pushClientUpdate(c, { full: true });
        sent++;
      }
      console.log(`[ableton-rc-surface] admin ${clientId} sent ${sent} existing client snapshot`);
    } else {
      pushClientUpdate(info, { full: true });
    }

    ws.on("message", (data) => {
      info.lastSeen = Date.now();
      // ── Rate limiting (ADR-004) ──
      if (!consumeToken(info.rateLimiter)) {
        // A dropped message gets no reply, so an over-budget client used to
        // see nothing at all — the control simply stopped responding. Say so,
        // at most once a second, so the cause is nameable from the phone and
        // from the log.
        const notice = takeRateLimitNotice(info.rateLimiter);
        if (notice) {
          console.warn(
            `[ableton-rc-surface] ${label} id=${clientId} rate-limited: ` +
              `${notice.dropped} message(s) dropped in the last second ` +
              `(limit ${RATE_SUSTAINED_PER_SEC}/s, burst ${RATE_BURST})`,
          );
          sendWithBackpressure(
            ws,
            JSON.stringify({
              type: "rate_limited",
              dropped: notice.dropped,
              limitPerSec: RATE_SUSTAINED_PER_SEC,
              burst: RATE_BURST,
            }),
            "critical",
          );
        }
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
      // Not a typed message — try as a legacy command envelope. It is already
      // parsed; re-parsing the same string was pure duplicate work.
      dispatch(ws, info, typed.parsed);
      pushClientUpdate(info);
    });

    ws.on("close", () => {
      console.log(`[ableton-rc-surface] ${label} id=${clientId} disconnected`);
      // Per-socket bookkeeping always runs, superseded or not.
      if (isAdmin) adminSockets.delete(ws);
      clearClientUpdateGate(info);

      // A phone keeps its client_id across reconnects — it lives in
      // localStorage and a cookie, shared by every tab of the same origin — so
      // the socket closing here may already have been replaced by a newer one
      // for the same id. That replacement is precisely what closed it.
      //
      // Everything below tears down state *by client_id*, so running it for a
      // superseded socket aims at the live session: it stops the modulators the
      // performer is currently playing, runs the safe-loss release ramp over
      // their mappings, and tells every dashboard the client is gone — which
      // makes the panel drop it and blink back a moment later.
      const current = trackedClients.get(clientId);
      if (current && current.ws !== ws) {
        console.log(
          `[ableton-rc-surface] ${label} id=${clientId} was superseded by a newer socket; ` +
            `leaving the live session alone`,
        );
        return;
      }

      if (!isAdmin) {
        clearHostModulatorsForClient(clientId);
        void handleClientDisconnect(clientId);
      }
      info.lastSeen = 0;
      // A disconnect must not be coalesced away behind a pending trailing emit.
      pushClientUpdate(info, { immediate: true });
      trackedClients.delete(clientId);
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
  // The parsed message, handed to the command-envelope path so it does not
  // parse the same string a second time. Absent only when parsing failed.
  parsed?: Record<string, any>;
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
    return { handled: false, pushClientUpdate: true, parsed };
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
    if (!lost) {
      recordSurfaceValue(info.id, `${name}.x`, sx);
      recordSurfaceValue(info.id, `${name}.y`, sy);
    }
    void applyMapping(info.id, `${name}.x`, sx, lost);
    void applyMapping(info.id, `${name}.y`, sy, lost);
  } else if (typeof ctrl.value === "number") {
    const sv = sanitizeNumber(ctrl.value);
    appendHistory(info, name, sv, receivedAt);
    // A `lost` reading carries a placeholder, not a measurement — publishing it
    // to the other views would show them a position nobody is holding.
    if (!lost) recordSurfaceValue(info.id, name, sv);
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

function dispatch(ws: WebSocket, info: TrackedClient, msg: Record<string, unknown> | undefined): void {
  if (!msg) return;
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
