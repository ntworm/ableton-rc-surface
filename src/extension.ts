// ableton-rc-bridge — v3 (Etapa B: WebSocket + command registry)
//
// Etapa A: HTTP server on 127.0.0.1:OS-picked-port, /health + /state.
// Etapa B: WebSocket on the same server, JSON command dispatcher, /commands
//          list, /test interactive HTML page served by the same server.
//
// Patterns reused from the paulstretch source (proven working .ablx):
// - listen(0, "127.0.0.1") to dodge EADDRINUSE
// - module.exports = { activate } (CJS)
// - explicit step logging around every SDK call
// - stripWin32ExtPrefix before any future fs path ops (Windows quirk)
//
// Protocol: client sends {"id": "uuid", "cmd": "<name>", "args": {...}},
// server replies with {"id": "<same>", "ok": true, "result": ...} or
// {"id": "<same>", "ok": false, "error": "..."}. The id lets the client
// correlate responses with requests.

import * as http from "node:http";
import * as https from "node:https";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import selfsigned from "selfsigned";
import { networkInterfaces } from "node:os";
import { AddressInfo } from "node:net";
import { WebSocketServer, WebSocket } from "ws";
import {
  initialize,
  type ActivationContext,
} from "@ableton-extensions/sdk";

// ---------------- State ----------------

let actualPort: number | null = null;
let extensionContext: ReturnType<typeof initialize> | null = null;

// Tracked WS clients. Phones (and any other non-admin WS) get an auto-
// assigned UUID and broadcast `client_update` messages to admin sockets so
// the bundled admin UI can render the live client list.
type ClientMode = "performance" | "admin" | "mix";
interface TrackedClient {
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
  // Per-mode extension slot. Mix View uses it to remember which track
  // and device the user has expanded so the server's tiered snapshot
  // loop can spend budget on the right detail.
  mixSelection: MixSelection | null;
  // Per-client delta-diffing keys. The tiered snapshot loop compares
  // the freshly built snapshot against these before sending.
  lastMixStructureKey: string;
  lastMixMixerKey: string;
  lastMixParamsKey: string;
  ws: import("ws").WebSocket;
}
const trackedClients = new Map<string, TrackedClient>();
const adminSockets = new Set<import("ws").WebSocket>();

const CLIENT_STALE_MS = 35_000; // matches the original admin's prune window
const HISTORY_MAX = 300; // ~10s @ 30 Hz

// ---------------- Mix View state ----------------
//
// The Mix View is a strict superset on the wire and on disk. v0.3.0
// behaviour (phone WS on /ws, admin WS on /admin/ws) is preserved. The
// Mix View only adds:
//   - HTTP /mix/  -> redirect to /static/mix/  (handled in handleHttp)
//   - WS    /mix/ws -> new WebSocketServer, no auth/token in v0.3.1
//   - Server-side tiered snapshot loop reading the Live song
//   - Six command types (mix.setVolume/Pan/toggleMute/toggleSolo/SetSend/SetParam)
//   - A per-target write queue to serialise concurrent commands
//   - A panel QR code labelled "Mix" alongside the existing "Phone" QR
//
// All shapes are mirrored in static/mix/protocol.mjs (which the client
// imports). The protocol version is bumped together.

interface MixSelection {
  // The track the user has expanded. Null means "no track expanded";
  // the snapshot still includes the mixer + structure tier.
  trackId: string | null;
  // The device inside the expanded track the user has drilled into.
  // Null means "no device expanded"; the device list is still sent.
  deviceId: string | null;
}

const MIX_PROTOCOL_VERSION = 1 as const;

const CLIENT_CMD = {
  SET_VOLUME: "mix.setVolume",
  SET_PAN: "mix.setPan",
  TOGGLE_MUTE: "mix.toggleMute",
  TOGGLE_SOLO: "mix.toggleSolo",
  SET_SEND: "mix.setSend",
  SET_PARAM: "mix.setParam",
  RESCAN: "mix.rescan",
  SET_SELECTION: "mix.setSelection",
} as const;
const SERVER_MSG = {
  HELLO: "mix.hello",
  SNAPSHOT: "mix.snapshot",
  TRACKS_CHANGED: "mix.tracks_changed",
  ACK: "mix.ack",
  ERROR: "mix.error",
  CLOSE: "mix.close",
} as const;

const TRACK_TYPES = {
  REGULAR: "regular",
  GROUP: "group",
  RETURN: "return",
  MASTER: "master",
} as const;

const PARAM_KIND = {
  CONTINUOUS: "continuous",
  ENUM: "enum",
  TOGGLE: "toggle",
  DISABLED: "disabled",
} as const;

// Mix snapshot cache. The server builds the structure tier every
// STRUCTURE_TICK_MS, the mixer tier every MIXER_TICK_MS, and the params
// tier every PARAMS_TICK_MS (gated on what each client has expanded).
// Delta diffing is applied per-client: only fields that changed since
// the last send are included.
const MIX_STRUCTURE_TICK_MS = 2000;  // 0.5 Hz
const MIX_MIXER_TICK_MS = 200;        // 5 Hz
const MIX_PARAMS_TICK_MS = 500;       // 2 Hz
const MIX_MAX_PARAMS_PER_CLIENT = 256; // cap per-client per-tick param budget
const MIX_SEND_BUDGET_BYTES = 96_000; // ~96 KB per client per tick, soft cap

let mixStructureCache: MixStructureCache | null = null;
let mixStructureCacheAt = 0;
let mixStructureVersion = 0;

interface MixStructureCache {
  version: number;
  tracks: MixTrackSnapshot[];
}

interface MixTrackSnapshot {
  id: string;
  name: string;
  type: "regular" | "group" | "return" | "master";
  groupTrackId: string | null;
}

interface MixTrackDetailSnapshot extends MixTrackSnapshot {
  volume: number;       // 0..1
  pan: number;          // -1..1
  mute: boolean;
  solo: boolean;
  sends: MixSendSnapshot[];
  devices: MixDeviceSnapshot[];
}

interface MixSendSnapshot {
  id: string;
  name: string;
  level: number;        // 0..1
}

interface MixDeviceSnapshot {
  id: string;
  name: string;
  parameters: MixParamSnapshot[];
}

interface MixParamSnapshot {
  id: string;
  name: string;
  value: number;        // 0..1
  min: number;
  max: number;
  defaultValue: number | null;
  isQuantized: boolean;
  valueItems: Array<{ name: string; shortName: string }>;
  kind: "continuous" | "enum" | "toggle" | "disabled";
  isReadOnly: boolean;
  deviceName?: string;
}

const mixWriteQueues = new Map<string, Promise<void>>(); // key = writeQueueKey

// Per-client delta-diff keys live on TrackedClient (c.lastMixStructureKey,
// c.lastMixMixerKey, c.lastMixParamsKey) so they are freed automatically
// when the client disconnects.
//
// Hotfix v0.3.1.1: PARAMS_ROTATION was removed. The rotation over a
// 64-param budget caused stale values (param 0 was only re-read every
// other tick on devices with > 64 params). We now read every param up
// to MIX_MAX_PARAMS_PER_CLIENT (256) on every params tick.

// ---------------- Control Mapping Engine ----------------

interface MappingTarget {
  type: 'device_param' | 'mixer_volume' | 'mixer_pan' | 'mixer_send'
      | 'tempo' | 'track_mute' | 'track_solo' | 'track_arm';
  trackIndex?: number;
  deviceIndex?: number;
  paramIndex?: number;
  sendIndex?: number;
  label?: string; // human-readable label for UI
  outMin?: number;
  outMax?: number;
  smooth?: number;
  smoothBpmSync?: boolean;
  smoothBpmSubdivision?: number;
  curve?: 'linear' | 'exponential' | 'logarithmic' | 's-curve';
  inMin?: number;
  inMax?: number;
}

const controlMappings = new Map<string, MappingTarget[]>();
const lastMappedValues = new Map<string, number>();
const activeSmooths = new Map<string, {
  current: number;
  target: number;
  smoothFactor: number;
  apply: (val: number) => Promise<void>;
  lastTime: number;
}>();

function getTargetKey(target: MappingTarget): string {
  switch (target.type) {
    case 'tempo':
      return 'tempo';
    case 'mixer_send':
      return `mixer_send::${target.trackIndex ?? 0}::${target.sendIndex ?? 0}`;
    case 'device_param':
      return `device_param::${target.trackIndex ?? 0}::${target.deviceIndex ?? 0}::${target.paramIndex ?? 0}`;
    default:
      return `${target.type}::${target.trackIndex ?? 0}`;
  }
}

// On-demand 50 Hz smoothing loop. The timer only runs while at least one
// smooth mapping is active. When `activeSmooths` drains to zero the loop
// stops itself, so when no phone is mapped with smoothing we burn zero
// CPU on the timer tick.
let smoothInterval: NodeJS.Timeout | null = null;

function startSmoothTimer(): void {
  if (smoothInterval) return;
  smoothInterval = setInterval(async () => {
    if (activeSmooths.size === 0) {
      // Self-shutoff: nothing to interpolate, drop the timer.
      if (smoothInterval) {
        clearInterval(smoothInterval);
        smoothInterval = null;
      }
      return;
    }

    const now = Date.now();
    const promises: Promise<void>[] = [];

    for (const [key, state] of activeSmooths.entries()) {
      const dt = now - state.lastTime;
      state.lastTime = now;

      const factor = Math.max(0, Math.min(0.99, state.smoothFactor));
      const alpha = 1 - Math.pow(factor, dt / 30);

      const diff = state.target - state.current;
      if (Math.abs(diff) < 0.001) {
        state.current = state.target;
        activeSmooths.delete(key);
        lastMappedValues.set(key, state.target);
        promises.push(state.apply(state.target));
      } else {
        state.current = state.current + diff * Math.max(0.01, Math.min(1, alpha));
        lastMappedValues.set(key, state.current);
        promises.push(state.apply(state.current));
      }
    }

    await Promise.all(promises);
  }, 20); // 50 Hz updates
}

let mappingsFilePath: string | null = null;
let presetsDirPath: string | null = null;
let currentPresetName: string = "Default";

const NOTES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
function getScaleLabel(root: number, name: string): string {
  const noteName = NOTES[root] ?? "";
  return noteName ? `${noteName} ${name}` : name;
}

let playheadActive = false;
let playheadStartTime = 0;
let playheadBaseTimeMs = 0;

function broadcastPlayheadState(): void {
  const now = Date.now();
  const currentPos = playheadActive ? (playheadBaseTimeMs + (now - playheadStartTime)) : playheadBaseTimeMs;
  const payload = {
    type: "playhead_state",
    playheadActive,
    playheadTimeMs: currentPos,
  };
  const json = JSON.stringify(payload);
  for (const c of trackedClients.values()) {
    if (!c.isAdmin && c.ws.readyState === c.ws.OPEN) {
      try {
        c.ws.send(json);
      } catch {}
    }
  }
}

let lastBroadcastedState = { tempo: 0, signature: "", scale: "" };

function checkAndBroadcastLiveState(): void {
  try {
    const ctx = extensionContext;
    if (!ctx) return;
    const song = ctx.application.song;
    if (!song) return;

    const tempo = song.tempo;
    
    let signature = "4/4";
    if (song.scenes && song.scenes.length > 0 && song.scenes[0]) {
      const scene = song.scenes[0];
      signature = `${scene.signatureNumerator}/${scene.signatureDenominator}`;
    }

    const scale = getScaleLabel(song.rootNote, song.scaleName);

    if (
      tempo !== lastBroadcastedState.tempo ||
      signature !== lastBroadcastedState.signature ||
      scale !== lastBroadcastedState.scale
    ) {
      lastBroadcastedState = { tempo, signature, scale };
      const payload = { type: "live_state", tempo, signature, scale };
      const json = JSON.stringify(payload);
      for (const c of trackedClients.values()) {
        if (!c.isAdmin && c.ws.readyState === c.ws.OPEN) {
          try {
            c.ws.send(json);
          } catch {}
        }
      }
    }
  } catch (err) {
    // ignore
  }
}

async function loadMappings(): Promise<void> {
  if (!mappingsFilePath) return;
  try {
    const raw = await fs.readFile(mappingsFilePath, "utf-8");
    const obj = JSON.parse(raw) as Record<string, MappingTarget | MappingTarget[]>;
    controlMappings.clear();
    for (const [k, v] of Object.entries(obj)) {
      controlMappings.set(k, Array.isArray(v) ? v : [v]);
    }
    console.log(`[ableton-rc-bridge] loaded ${controlMappings.size} mappings from ${mappingsFilePath}`);
  } catch {
    console.log("[ableton-rc-bridge] no mappings file found, starting fresh");
  }
}

async function saveMappings(): Promise<void> {
  if (!mappingsFilePath) return;
  const obj: Record<string, MappingTarget[]> = {};
  for (const [k, v] of controlMappings.entries()) {
    obj[k] = v;
  }
  try {
    await fs.writeFile(mappingsFilePath, JSON.stringify(obj, null, 2), "utf-8");
  } catch (err) {
    console.error(`[ableton-rc-bridge] failed to save mappings: ${err instanceof Error ? err.message : String(err)}`);
  }
}

const activeApplyLocks = new Set<string>();

function applyCurve(value: number, curve?: string): number {
  switch (curve) {
    case 'exponential':
      return value * value;
    case 'logarithmic':
      return Math.sqrt(value);
    case 's-curve':
      return 0.5 * (1 - Math.cos(value * Math.PI));
    case 'linear':
    default:
      return value;
  }
}

function applyCurveInverse(value: number, curve?: string): number {
  const clamped = Math.max(0, Math.min(1, value));
  switch (curve) {
    case 'exponential':
      return Math.sqrt(clamped);
    case 'logarithmic':
      return clamped * clamped;
    case 's-curve':
      return Math.acos(1 - 2 * clamped) / Math.PI;
    case 'linear':
    default:
      return clamped;
  }
}

async function applyMapping(clientId: string, controlName: string, value: number): Promise<void> {
  let targets = controlMappings.get(`${clientId}::${controlName}`);
  if (!targets || targets.length === 0) {
    targets = controlMappings.get(controlName);
  }
  if (!targets || targets.length === 0) return;
  
  try {
    const ctx = extensionContext;
    if (!ctx) return;
    const song = ctx.application.song;
    if (!song) return;

    await Promise.all(targets.map(async (target) => {
      const inMin = target.inMin ?? 0;
      const inMax = target.inMax ?? 1;
      let normalized = 0;
      if (Math.abs(inMax - inMin) > 0.0001) {
        normalized = (value - inMin) / (inMax - inMin);
      } else {
        normalized = value >= inMin ? 1 : 0;
      }
      normalized = Math.max(0, Math.min(1, normalized));
      const inputCurved = applyCurve(normalized, target.curve);

      const minScale = target.outMin ?? 0;
      const maxScale = target.outMax ?? 1;
      const scaledValue = minScale + inputCurved * (maxScale - minScale);
      let smoothFactor = target.smooth ?? 0;
      if (target.smoothBpmSync && song.tempo) {
        const subdivision = target.smoothBpmSubdivision ?? 1;
        const beatDurationMs = 60000 / song.tempo;
        const T = beatDurationMs * subdivision; // duration in ms to reach 99% of target value
        smoothFactor = Math.exp(-138 / T);
        smoothFactor = Math.max(0, Math.min(0.99, smoothFactor));
      }
      const key = `${clientId}::${getTargetKey(target)}`;

      const applyFn = async (scaledVal: number) => {
        switch (target.type) {
          case 'tempo': {
            song.tempo = 20 + scaledVal * 280;
            break;
          }
          case 'track_mute': {
            const t = song.tracks[target.trackIndex ?? 0];
            if (t) t.mute = scaledVal > 0.5;
            break;
          }
          case 'track_solo': {
            const t = song.tracks[target.trackIndex ?? 0];
            if (t) t.solo = scaledVal > 0.5;
            break;
          }
          case 'track_arm': {
            const t = song.tracks[target.trackIndex ?? 0];
            if (t) t.arm = scaledVal > 0.5;
            break;
          }
          case 'mixer_volume': {
            const t = song.tracks[target.trackIndex ?? 0];
            if (t && "mixer" in t) {
              const mixer = t.mixer as { volume: { min: number; max: number; setValue: (v: number) => Promise<unknown> } };
              const scaled = mixer.volume.min + scaledVal * (mixer.volume.max - mixer.volume.min);
              await mixer.volume.setValue(scaled);
            }
            break;
          }
          case 'mixer_pan': {
            const t = song.tracks[target.trackIndex ?? 0];
            if (t && "mixer" in t) {
              const mixer = t.mixer as { panning: { min: number; max: number; setValue: (v: number) => Promise<unknown> } };
              const scaled = mixer.panning.min + scaledVal * (mixer.panning.max - mixer.panning.min);
              await mixer.panning.setValue(scaled);
            }
            break;
          }
          case 'mixer_send': {
            const t = song.tracks[target.trackIndex ?? 0];
            if (t && "mixer" in t) {
              const mixer = t.mixer as { sends: Array<{ min: number; max: number; setValue: (v: number) => Promise<unknown> }> };
              const send = mixer.sends[target.sendIndex ?? 0];
              if (send) {
                const scaled = send.min + scaledVal * (send.max - send.min);
                await send.setValue(scaled);
              }
            }
            break;
          }
          case 'device_param': {
            const t = song.tracks[target.trackIndex ?? 0];
            if (t) {
              const device = t.devices[target.deviceIndex ?? 0];
              if (device) {
                const param = device.parameters[target.paramIndex ?? 0];
                if (param) {
                  const scaled = param.min + scaledVal * (param.max - param.min);
                  await param.setValue(scaled);
                }
              }
            }
            break;
          }
        }
      };

      if (smoothFactor > 0) {
        let state = activeSmooths.get(key);
        if (!state) {
          const lastVal = lastMappedValues.get(key) ?? scaledValue;
          state = {
            current: lastVal,
            target: scaledValue,
            smoothFactor,
            apply: applyFn,
            lastTime: Date.now()
          };
          activeSmooths.set(key, state);
        } else {
          state.target = scaledValue;
          state.smoothFactor = smoothFactor;
        }
      } else {
        if (activeApplyLocks.has(key)) return;
        activeApplyLocks.add(key);
        try {
          activeSmooths.delete(key);
          lastMappedValues.set(key, scaledValue);
          await applyFn(scaledValue);
        } finally {
          activeApplyLocks.add(key); // keep lock for a brief microsecond tick to prevent frame pileup
          setTimeout(() => activeApplyLocks.delete(key), 5);
        }
      }
    }));
  } catch (err) {
    console.error(`[ableton-rc-bridge] applyMapping(${controlName}) error: ${err instanceof Error ? err.message : String(err)}`);
  }
}

async function getControlValues(clientId: string): Promise<Record<string, number>> {
  const result: Record<string, number> = {};
  const ctx = extensionContext;
  if (!ctx) return result;
  const song = ctx.application.song;
  if (!song) return result;

  const activeTargets = new Map<string, MappingTarget[]>();
  for (const [key, targets] of controlMappings.entries()) {
    if (key.includes("::")) {
      const [cid, baseName] = key.split("::");
      if (cid === clientId && baseName) {
        activeTargets.set(baseName, targets);
      }
    } else {
      if (!activeTargets.has(key)) {
        activeTargets.set(key, targets);
      }
    }
  }

  const promises = Array.from(activeTargets.entries()).map(async ([controlName, targets]) => {
    if (!targets || targets.length === 0) return;
    const target = targets[0]; // sync to the first target
    if (!target) return;
    try {
      let scaledValue = 0;
      switch (target.type) {
        case 'tempo': {
          scaledValue = (song.tempo - 20) / 280;
          break;
        }
        case 'track_mute': {
          const t = song.tracks[target.trackIndex ?? 0];
          scaledValue = t && t.mute ? 1 : 0;
          break;
        }
        case 'track_solo': {
          const t = song.tracks[target.trackIndex ?? 0];
          scaledValue = t && t.solo ? 1 : 0;
          break;
        }
        case 'track_arm': {
          const t = song.tracks[target.trackIndex ?? 0];
          scaledValue = t && t.arm ? 1 : 0;
          break;
        }
        case 'mixer_volume': {
          const t = song.tracks[target.trackIndex ?? 0];
          if (t && "mixer" in t) {
            const mixer = t.mixer as any;
            const v = await mixer.volume.getValue();
            const min = mixer.volume.min;
            const max = mixer.volume.max;
            if (max > min) scaledValue = (v - min) / (max - min);
          }
          break;
        }
        case 'mixer_pan': {
          const t = song.tracks[target.trackIndex ?? 0];
          if (t && "mixer" in t) {
            const mixer = t.mixer as any;
            const v = await mixer.panning.getValue();
            const min = mixer.panning.min;
            const max = mixer.panning.max;
            if (max > min) scaledValue = (v - min) / (max - min);
          }
          break;
        }
        case 'mixer_send': {
          const t = song.tracks[target.trackIndex ?? 0];
          if (t && "mixer" in t) {
            const mixer = t.mixer as any;
            const send = mixer.sends[target.sendIndex ?? 0];
            if (send) {
              const v = await send.getValue();
              const min = send.min;
              const max = send.max;
              if (max > min) scaledValue = (v - min) / (max - min);
            }
          }
          break;
        }
        case 'device_param': {
          const t = song.tracks[target.trackIndex ?? 0];
          if (t) {
            const device = t.devices[target.deviceIndex ?? 0];
            if (device) {
              const param = device.parameters[target.paramIndex ?? 0];
              if (param) {
                const v = await param.getValue();
                const min = param.min;
                const max = param.max;
                if (max > min) scaledValue = (v - min) / (max - min);
              }
            }
          }
          break;
        }
      }

      const minScale = target.outMin ?? 0;
      const maxScale = target.outMax ?? 1;
      let rawValue = 0;
      if (Math.abs(maxScale - minScale) > 0.0001) {
        rawValue = (scaledValue - minScale) / (maxScale - minScale);
      } else {
        rawValue = minScale;
      }
      rawValue = Math.max(0, Math.min(1, rawValue));
      const inverseCurved = applyCurveInverse(rawValue, target.curve);
      
      const inMin = target.inMin ?? 0;
      const inMax = target.inMax ?? 1;
      const finalRaw = inMin + inverseCurved * (inMax - inMin);
      
      result[controlName] = Math.max(0, Math.min(1, finalRaw));
    } catch (err) {
      // ignore
    }
  });

  await Promise.all(promises);
  return result;
}

function appendHistory(c: TrackedClient, name: string, value: number, ts: number): void {
  if (!c.history) {
    c.history = {};
  }
  if (!c.history[name]) {
    c.history[name] = [];
  }
  const series = c.history[name];
  series.push([ts, value]);
  if (series.length > HISTORY_MAX) {
    series.splice(0, series.length - HISTORY_MAX);
  }
}

function broadcastToAdmins(payload: object): void {
  const json = JSON.stringify(payload);
  for (const ws of adminSockets) {
    if (ws.readyState === ws.OPEN) {
      try { ws.send(json); } catch { /* ignore */ }
    }
  }
}

function pushClientUpdate(c: TrackedClient): void {
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

// ---------------- Command registry ----------------

type Args = Record<string, unknown>;

interface CommandSpec {
  description: string;
  handler: (args: Args) => Promise<unknown>;
}

function requireCtx() {
  if (!extensionContext) throw new Error("extension context not ready");
  const song = extensionContext.application.song;
  if (!song) throw new Error("no song loaded");
  return { context: extensionContext, song };
}

function requireTrack(song: ReturnType<typeof requireCtx>["song"], index: unknown) {
  if (typeof index !== "number" || !Number.isInteger(index) || index < 0 || index >= song.tracks.length) {
    throw new Error(`invalid track index: ${String(index)} (have ${song.tracks.length} tracks)`);
  }
  const track = song.tracks[index];
  if (!track) throw new Error(`no track at index ${index}`);
  return track;
}

const commands: Record<string, CommandSpec> = {
  getServerInfo: {
    description: "Get server state, LAN URLs, cert info, etc.",
    handler: async () => {
      const isRunning = serverInstance !== null;
      const port = actualPort;
      const httpsPort = actualHttpsPort;
      const { primary, others } = pickLanIps(getLanAddresses());
      const phoneProto = useHttps && httpsPort ? "https" : "http";
      const phonePort = useHttps && httpsPort ? httpsPort : port;
      const phoneUrl = isRunning && port !== null ? `${phoneProto}://${primary}:${phonePort}/` : null;
      const mixUrl = isRunning && port !== null ? `${phoneProto}://${primary}:${phonePort}/mix/` : null;
      const adminUrl = isRunning && port !== null ? `http://127.0.0.1:${port}/static/admin/` : null;
      const qrSrc = phoneUrl
        ? `https://api.qrserver.com/v1/create-qr-code/?size=140x140&data=${encodeURIComponent(phoneUrl)}`
        : "";
      const mixQrSrc = mixUrl
        ? `https://api.qrserver.com/v1/create-qr-code/?size=140x140&data=${encodeURIComponent(mixUrl)}`
        : "";
      const statusText = isRunning
        ? port !== null
          ? `Running (HTTP: ${port}${httpsPort ? `, HTTPS: ${httpsPort}` : ""})`
          : "Running (binding...)"
        : "Stopped";
      return {
        isRunning,
        port,
        httpsPort,
        useHttps,
        primaryIp: primary,
        otherIps: others,
        phoneUrl,
        mixUrl,
        adminUrl,
        qrSrc,
        mixQrSrc,
        statusText,
      };
    }
  },

  getClients: {
    description: "List all connected non-admin clients.",
    handler: async () => {
      const list = [];
      for (const c of trackedClients.values()) {
        if (!c.isAdmin) {
          list.push({
            client_id: c.id,
            display_name: c.displayName || "",
            user_agent: c.userAgent,
            status: Date.now() - c.lastSeen < CLIENT_STALE_MS ? "active" : "stale",
          });
        }
      }
      return { clients: list };
    }
  },

  getState: {
    description: "Return current Live state (tempo, tracks, scenes, scale, track metadata).",
    handler: async () => {
      const { song } = requireCtx();
      const tracks = song.tracks.map((t, i) => {
        const mixer = "mixer" in t ? t.mixer : undefined;
        return {
          index: i,
          name: t.name,
          type: t.constructor.name,
          mute: t.mute,
          arm: t.arm,
          solo: t.solo,
        };
      });
      return {
        tempo: song.tempo,
        trackCount: song.tracks.length,
        sceneCount: song.scenes.length,
        rootNote: song.rootNote,
        scaleName: song.scaleName,
        tracks,
      };
    },
  },

  setPlayhead: {
    description: "Set playhead state and position. Args: {active?: boolean, timeMs?: number}",
    handler: async (args) => {
      const active = args["active"];
      const timeMs = args["timeMs"];
      
      if (active !== undefined && typeof active !== "boolean") {
        throw new Error("active must be a boolean");
      }
      if (timeMs !== undefined && (typeof timeMs !== "number" || timeMs < 0)) {
        throw new Error("timeMs must be a non-negative number");
      }
      
      const now = Date.now();
      
      if (active !== undefined) {
        if (active && !playheadActive) {
          playheadStartTime = now;
          playheadActive = true;
        } else if (!active && playheadActive) {
          playheadBaseTimeMs = timeMs ?? (playheadBaseTimeMs + (now - playheadStartTime));
          playheadActive = false;
        }

        // Trigger haptic feedback on state change (gentle when playing, heavy when stopped)
        const hapticPayload = JSON.stringify({
          type: "haptic_vibrate",
          pattern: active ? "gentle" : "heavy",
        });
        for (const c of trackedClients.values()) {
          if (!c.isAdmin && c.ws.readyState === c.ws.OPEN) {
            try { c.ws.send(hapticPayload); } catch {}
          }
        }
      }
      
      if (timeMs !== undefined) {
        if (playheadActive) {
          playheadStartTime = now;
          playheadBaseTimeMs = timeMs;
        } else {
          playheadBaseTimeMs = timeMs;
        }
      }
      
      broadcastPlayheadState();
      
      const currentPos = playheadActive ? (playheadBaseTimeMs + (Date.now() - playheadStartTime)) : playheadBaseTimeMs;
      return { playheadActive, playheadTimeMs: currentPos };
    },
  },

  triggerHaptic: {
    description: "Trigger haptic feedback on a client phone. Args: {clientId?: string, pattern?: string}",
    handler: async (args) => {
      const clientId = args["clientId"];
      const pattern = args["pattern"] || "standard";
      const payload = {
        type: "haptic_vibrate",
        pattern,
      };
      const json = JSON.stringify(payload);
      if (clientId && typeof clientId === "string") {
        const client = trackedClients.get(clientId);
        if (client && !client.isAdmin && client.ws.readyState === client.ws.OPEN) {
          try { client.ws.send(json); } catch {}
        }
      } else {
        for (const c of trackedClients.values()) {
          if (!c.isAdmin && c.ws.readyState === c.ws.OPEN) {
            try { c.ws.send(json); } catch {}
          }
        }
      }
      return { success: true, pattern };
    },
  },

  setTempo: {
    description: "Set song tempo in BPM. Args: {tempo: number}",
    handler: async (args) => {
      const { song } = requireCtx();
      const tempo = args["tempo"];
      if (typeof tempo !== "number" || tempo <= 0 || tempo > 1000) {
        throw new Error(`tempo must be a positive number, got: ${String(tempo)}`);
      }
      song.tempo = tempo;
      return { tempo: song.tempo };
    },
  },

  setTrackMute: {
    description: "Mute or unmute a track. Args: {index: number, mute: boolean}",
    handler: async (args) => {
      const { song } = requireCtx();
      const track = requireTrack(song, args["index"]);
      const mute = args["mute"];
      if (typeof mute !== "boolean") {
        throw new Error(`mute must be boolean, got: ${typeof mute}`);
      }
      track.mute = mute;
      return { index: args["index"], mute: track.mute };
    },
  },

  setTrackVolume: {
    description: "Set track mixer volume. Args: {index: number, volume: number (0.0 - 1.0)}",
    handler: async (args) => {
      const { song } = requireCtx();
      const track = requireTrack(song, args["index"]);
      const volume = args["volume"];
      if (typeof volume !== "number" || volume < 0 || volume > 1) {
        throw new Error(`volume must be 0.0 - 1.0, got: ${String(volume)}`);
      }
      const mixer = "mixer" in track ? track.mixer : undefined;
      if (!mixer || !("volume" in mixer)) {
        throw new Error(`track at index ${args["index"]} has no mixer.volume`);
      }
      const volParam = (mixer as { volume: { setValue: (v: number) => Promise<unknown> } }).volume;
      await volParam.setValue(volume);
      return { index: args["index"], volume };
    },
  },

  getDeviceParams: {
    description: "List parameters of a device. Args: {trackIndex: number, deviceIndex: number}. Returns: {name, parameters: [{index, name, value, min, max, defaultValue, isQuantized}]}",
    handler: async (args) => {
      const { song } = requireCtx();
      const track = requireTrack(song, args["trackIndex"]);
      const deviceIndex = args["deviceIndex"];
      if (typeof deviceIndex !== "number" || deviceIndex < 0) {
        throw new Error(`deviceIndex must be a non-negative number, got: ${String(deviceIndex)}`);
      }
      const devices = track.devices;
      if (deviceIndex >= devices.length) {
        throw new Error(`deviceIndex ${deviceIndex} out of range; track has ${devices.length} devices`);
      }
      const device = devices[deviceIndex];
      if (!device) throw new Error(`no device at index ${deviceIndex}`);
      const params = await Promise.all(
        device.parameters.map(async (p, i) => ({
          index: i,
          name: p.name,
          value: await p.getValue(),
          min: p.min,
          max: p.max,
          defaultValue: p.defaultValue,
          isQuantized: p.isQuantized,
          valueItems: p.valueItems.map((vi) => ({ name: vi.name, shortName: vi.shortName })),
        })),
      );
      return { name: device.name, parameters: params };
    },
  },

  setDeviceParam: {
    description: "Set a device parameter value. Args: {trackIndex, deviceIndex, paramIndex, value}. The ableton-rc primitive: every pad/knob/fader ultimately maps to this.",
    handler: async (args) => {
      const { song } = requireCtx();
      const track = requireTrack(song, args["trackIndex"]);
      const deviceIndex = args["deviceIndex"];
      const paramIndex = args["paramIndex"];
      const value = args["value"];
      if (typeof deviceIndex !== "number" || deviceIndex < 0) {
        throw new Error(`deviceIndex must be non-negative, got: ${String(deviceIndex)}`);
      }
      if (typeof paramIndex !== "number" || paramIndex < 0) {
        throw new Error(`paramIndex must be non-negative, got: ${String(paramIndex)}`);
      }
      if (typeof value !== "number") {
        throw new Error(`value must be a number, got: ${typeof value}`);
      }
      const devices = track.devices;
      if (deviceIndex >= devices.length) {
        throw new Error(`deviceIndex ${deviceIndex} out of range; track has ${devices.length} devices`);
      }
      const device = devices[deviceIndex];
      if (!device) throw new Error(`no device at index ${deviceIndex}`);
      if (paramIndex >= device.parameters.length) {
        throw new Error(`paramIndex ${paramIndex} out of range; device has ${device.parameters.length} parameters`);
      }
      const param = device.parameters[paramIndex];
      if (!param) throw new Error(`no parameter at index ${paramIndex}`);
      // Clamp to min/max to avoid out-of-range rejections.
      const clamped = Math.max(param.min, Math.min(param.max, value));
      await param.setValue(clamped);
      return { trackIndex: args["trackIndex"], deviceIndex, paramIndex, value: clamped };
    },
  },

  getTargets: {
    description: "List all mappable targets: tracks with mixer params + devices with params.",
    handler: async () => {
      const { song } = requireCtx();
      const targets: any[] = [];
      // Song-level
      targets.push({ id: 'tempo', type: 'tempo', label: `Song Tempo (${song.tempo.toFixed(1)} BPM)` });
      // Tracks
      for (let ti = 0; ti < song.tracks.length; ti++) {
        const track = song.tracks[ti];
        if (!track) continue;
        const tName = track.name || `Track ${ti + 1}`;
        const trackTargets: any[] = [];
        // Mixer
        if ("mixer" in track) {
          const mixer = track.mixer as any;
          trackTargets.push({ type: 'mixer_volume', trackIndex: ti, label: 'Volume' });
          trackTargets.push({ type: 'mixer_pan', trackIndex: ti, label: 'Pan' });
          if (mixer.sends) {
            for (let si = 0; si < mixer.sends.length; si++) {
              const sendParam = mixer.sends[si];
              trackTargets.push({ type: 'mixer_send', trackIndex: ti, sendIndex: si, label: sendParam?.name || `Send ${si + 1}` });
            }
          }
        }
        trackTargets.push({ type: 'track_mute', trackIndex: ti, label: 'Mute' });
        trackTargets.push({ type: 'track_solo', trackIndex: ti, label: 'Solo' });
        trackTargets.push({ type: 'track_arm', trackIndex: ti, label: 'Arm' });
        // Devices
        const devicesList: any[] = [];
        for (let di = 0; di < track.devices.length; di++) {
          const device = track.devices[di];
          if (!device) continue;
          const params: any[] = [];
          for (let pi = 0; pi < device.parameters.length; pi++) {
            const p = device.parameters[pi];
            if (!p) continue;
            params.push({ type: 'device_param', trackIndex: ti, deviceIndex: di, paramIndex: pi, label: p.name, min: p.min, max: p.max });
          }
          devicesList.push({ index: di, name: device.name, params });
        }
        targets.push({ trackIndex: ti, name: tName, mute: track.mute, solo: track.solo, arm: track.arm, mixer: trackTargets, devices: devicesList });
      }
      return { targets };
    },
  },

  setMapping: {
    description: "Map a phone control to Ableton targets. Args: {control: string, target?: MappingTarget, targets?: MappingTarget[]}",
    handler: async (args) => {
      const control = args["control"];
      const target = args["target"] as MappingTarget | undefined;
      const targets = args["targets"] as MappingTarget[] | undefined;
      if (typeof control !== "string" || !control) throw new Error("control must be a non-empty string");
      
      let finalTargets: MappingTarget[] = [];
      if (Array.isArray(targets)) {
        finalTargets = targets;
      } else if (target && typeof target === "object" && target.type) {
        finalTargets = [target];
      } else {
        throw new Error("either target or targets must be specified");
      }
      
      controlMappings.set(control, finalTargets);
      await saveMappings();
      return { control, targets: finalTargets, total: controlMappings.size };
    },
  },

  removeMapping: {
    description: "Remove a mapping. Args: {control: string}",
    handler: async (args) => {
      const control = args["control"];
      if (typeof control !== "string") throw new Error("control must be a string");
      const had = controlMappings.delete(String(control));
      await saveMappings();
      return { control, removed: had, total: controlMappings.size };
    },
  },

  highlightControl: {
    description: "Highlight a specific control on the connected phone for discovery. Args: {control: string, durationMs: number}",
    handler: async (args) => {
      const control = args["control"] as string;
      const durationMs = (args["durationMs"] as number) || 2000;
      for (const client of trackedClients.values()) {
        if (client.isAdmin) continue;
        try {
          client.ws.send(JSON.stringify({
            type: 'highlight',
            control,
            durationMs
          }));
        } catch {}
      }
      return { ok: true, control, durationMs };
    }
  },

  getMappings: {
    description: "Return all active mappings.",
    handler: async () => {
      const obj: Record<string, MappingTarget[]> = {};
      for (const [k, v] of controlMappings.entries()) obj[k] = v;
      return { mappings: obj, total: controlMappings.size };
    },
  },

  clearMappings: {
    description: "Clear all mappings.",
    handler: async () => {
      const count = controlMappings.size;
      controlMappings.clear();
      await saveMappings();
      return { cleared: count };
    },
  },

  listPresets: {
    description: "List all saved mapping presets.",
    handler: async () => {
      if (!presetsDirPath) return { presets: [], current: currentPresetName };
      try {
        await fs.mkdir(presetsDirPath, { recursive: true });
        const files = await fs.readdir(presetsDirPath);
        const presets = files
          .filter(f => f.endsWith(".json"))
          .map(f => f.slice(0, -5));
        return { presets, current: currentPresetName };
      } catch (err) {
        return { presets: [], current: currentPresetName };
      }
    }
  },

  savePreset: {
    description: "Save current mappings as a named preset. Args: {name: string}",
    handler: async (args) => {
      const name = args["name"];
      if (typeof name !== "string" || !name) throw new Error("preset name must be a non-empty string");
      if (!presetsDirPath) throw new Error("storage directory not ready");
      
      const cleanName = name.replace(/[^a-zA-Z0-9_\-]/g, "_");
      const filePath = path.join(presetsDirPath, `${cleanName}.json`);
      
      const obj: Record<string, MappingTarget[]> = {};
      for (const [k, v] of controlMappings.entries()) obj[k] = v;
      
      await fs.mkdir(presetsDirPath, { recursive: true });
      await fs.writeFile(filePath, JSON.stringify(obj, null, 2), "utf-8");
      currentPresetName = cleanName;
      return { success: true, name: cleanName };
    }
  },

  loadPreset: {
    description: "Load a named mapping preset. Args: {name: string}",
    handler: async (args) => {
      const name = args["name"];
      if (typeof name !== "string" || !name) throw new Error("preset name must be a non-empty string");
      if (!presetsDirPath) throw new Error("storage directory not ready");
      
      const cleanName = name.replace(/[^a-zA-Z0-9_\-]/g, "_");
      const filePath = path.join(presetsDirPath, `${cleanName}.json`);
      
      const raw = await fs.readFile(filePath, "utf-8");
      const obj = JSON.parse(raw) as Record<string, MappingTarget | MappingTarget[]>;
      controlMappings.clear();
      for (const [k, v] of Object.entries(obj)) {
        controlMappings.set(k, Array.isArray(v) ? v : [v]);
      }
      currentPresetName = cleanName;
      
      if (mappingsFilePath) {
        const activeObj: Record<string, MappingTarget[]> = {};
        for (const [k, v] of controlMappings.entries()) activeObj[k] = v;
        await fs.writeFile(mappingsFilePath, JSON.stringify(activeObj, null, 2), "utf-8");
      }
      
      return { success: true, name: cleanName, mappingsCount: controlMappings.size };
    }
  },

  deletePreset: {
    description: "Delete a named mapping preset. Args: {name: string}",
    handler: async (args) => {
      const name = args["name"];
      if (typeof name !== "string" || !name) throw new Error("preset name must be a non-empty string");
      if (!presetsDirPath) throw new Error("storage directory not ready");
      
      const cleanName = name.replace(/[^a-zA-Z0-9_\-]/g, "_");
      const filePath = path.join(presetsDirPath, `${cleanName}.json`);
      try {
        await fs.unlink(filePath);
      } catch (err) {}
      if (currentPresetName === cleanName) {
        currentPresetName = "Default";
      }
      return { success: true, name: cleanName };
    }
  },
};

// ---------------- Mix View WebSocket handler ----------------
//
// The Mix View shares the same HTTP server and the same tracking
// machinery as the legacy /ws and /admin/ws sockets, but it runs its
// own message protocol and gets fed by the server-side tiered snapshot
// loop instead of accepting snapshots from the client.
//
// The handler below is intentionally minimal: it tracks the client,
// sends a hello message, dispatches incoming JSON to `mixDispatch`,
// and cleans up on close. The snapshot loop and command handlers are
// defined further down, gated on the existence of at least one mix
// client so we burn zero CPU when nobody is connected.

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

    // Close any duplicate active connection for this clientId
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
      // Kick the snapshot loop immediately so a freshly connected
      // client doesn't have to wait up to MIX_STRUCTURE_TICK_MS.
      void mixStructureTick().then(mixBroadcastStructure);
      void mixMixerTick().then(mixBroadcastMixer);
    }

    // Send a hello with the protocol version and the supported commands
    // list. We do not block on Live state here; the first snapshot will
    // arrive from the tiered loop within MIX_STRUCTURE_TICK_MS.
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
            structure: MIX_STRUCTURE_TICK_MS,
            mixer: MIX_MIXER_TICK_MS,
            params: MIX_PARAMS_TICK_MS,
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
      // Drop any per-client delta cache.
      trackMixClientDisconnected();
    });

    ws.on("error", (err) => {
      console.error(
        `[ableton-rc-bridge] ${label} id=${clientId} error: ${err.message}`,
      );
    });
  });
}

// ---------------- Mix View command handlers ----------------
//
// Each command is validated (mirror of static/mix/protocol.mjs so the
// server never has to round-trip to the JS file at runtime), then
// dispatched to a typed handler. The handler resolves the Mix ID to
// an SDK handle, schedules the write through `mixApplyWrite` (which
// serialises per-target-key), and returns a result that becomes the
// mix.ack or mix.error response.
//
// All writes go through `mixApplyWrite` so two concurrent commands
// that target the same handle (e.g. two phones both nudging the
// same fader) do not interleave their SDK calls.

type MixParsedId = {
  kind: "track" | "device" | "parameter" | "send";
  type: "regular" | "group" | "return" | "master";
  trackIndex: number;
  deviceIndex: number | null;
  paramIndex: number | null;
  sendIndex: number | null;
};

function mixParseId(id: unknown): MixParsedId | null {
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

function mixWriteQueueKeyFor(parsed: MixParsedId): string {
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

const MIX_WRITE_TIMEOUT_MS = 1000;

async function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return await new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout: ${label}`)), ms);
    p.then(
      (v) => { clearTimeout(timer); resolve(v); },
      (e) => { clearTimeout(timer); reject(e); },
    );
  });
}

async function mixApplyWrite(key: string, fn: () => Promise<void>, label: string): Promise<void> {
  const prev = mixWriteQueues.get(key) ?? Promise.resolve();
  const next = prev.then(() => withTimeout(fn(), MIX_WRITE_TIMEOUT_MS, label)).catch((err) => {
    console.error(`[ableton-rc-bridge] mix write ${key} failed: ${err instanceof Error ? err.message : String(err)}`);
  });
  mixWriteQueues.set(key, next);
  await next;
}

interface MixResolveOk<T> { ok: true; value: T; }
interface MixResolveErr { ok: false; reason: string; }
type MixResolve<T> = MixResolveOk<T> | MixResolveErr;

function mixOk(): MixResolveOk<void> { return { ok: true, value: undefined }; }
function mixOkWith<T>(value: T): MixResolveOk<T> { return { ok: true, value }; }
function mixErr(reason: string): MixResolveErr { return { ok: false, reason }; }

function getSongSafely(): { tracks: ArrayLike<unknown>; returnTracks: ArrayLike<unknown>; mainTrack: unknown; mainTrackAvailable: boolean } | null {
  const ctx = extensionContext;
  if (!ctx) return null;
  const song = (ctx as { application?: { song?: { tracks?: unknown; returnTracks?: unknown; masterTrack?: unknown; mainTrack?: unknown } } }).application?.song;
  if (!song) return null;
  return {
    tracks: isArrayLike(song.tracks) ? (song.tracks as ArrayLike<unknown>) : [],
    returnTracks: isArrayLike(song.returnTracks) ? (song.returnTracks as ArrayLike<unknown>) : [],
    mainTrack: (song as { masterTrack?: unknown }).masterTrack ?? (song as { mainTrack?: unknown }).mainTrack ?? null,
    mainTrackAvailable: Boolean((song as { masterTrack?: unknown; mainTrack?: unknown }).masterTrack ?? (song as { mainTrack?: unknown }).mainTrack),
  };
}

function mixResolveTrack(parsed: MixParsedId): { kind: "regular" | "group" | "return" | "master"; index: number; obj: unknown } | null {
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

async function mixSetVolume(parsed: MixParsedId, value: number): Promise<MixResolve<void>> {
  const r = mixResolveTrack(parsed);
  if (!r) return mixErr("not_found");
  if (r.kind === "return") return mixErr("unsupported_target");
  const mixer = safeReadMixer(r.obj as AnyTrack);
  if (!mixer) return mixErr("not_found");
  const v = (mixer as { volume?: { setValue?: (v: number) => Promise<unknown>; min?: unknown; max?: unknown } }).volume;
  if (!v || typeof v.setValue !== "function") return mixErr("not_found");
  try {
    const min = typeof v.min === "number" ? v.min : 0;
    const max = typeof v.max === "number" ? v.max : 1;
    const scaled = min + clamp01(value) * (max - min);
    await v.setValue(scaled);
    return mixOk();
  } catch (e) {
    return mixErr(`sdk_error: ${e instanceof Error ? e.message : String(e)}`);
  }
}

async function mixSetPan(parsed: MixParsedId, value: number): Promise<MixResolve<void>> {
  const r = mixResolveTrack(parsed);
  if (!r) return mixErr("not_found");
  if (r.kind === "return") return mixErr("unsupported_target");
  const mixer = safeReadMixer(r.obj as AnyTrack);
  if (!mixer) return mixErr("not_found");
  const p = (mixer as { panning?: { setValue?: (v: number) => Promise<unknown>; min?: unknown; max?: unknown } }).panning;
  if (!p || typeof p.setValue !== "function") return mixErr("not_found");
  try {
    const min = typeof p.min === "number" ? p.min : -1;
    const max = typeof p.max === "number" ? p.max : 1;
    const wire = clampN11(value);
    const scaled = min + ((wire + 1) / 2) * (max - min);
    await p.setValue(scaled);
    return mixOk();
  } catch (e) {
    return mixErr(`sdk_error: ${e instanceof Error ? e.message : String(e)}`);
  }
}

async function mixToggleMute(parsed: MixParsedId): Promise<MixResolve<{ mute: boolean }>> {
  const r = mixResolveTrack(parsed);
  if (!r) return mixErr("not_found");
  if (r.kind === "return") return mixErr("unsupported_target");
  const t = r.obj as { mute?: unknown };
  const next = !(t.mute === true);
  try {
    (t as { mute?: boolean }).mute = next;
    return mixOkWith({ mute: next });
  } catch (e) {
    return mixErr(`sdk_error: ${e instanceof Error ? e.message : String(e)}`);
  }
}

async function mixToggleSolo(parsed: MixParsedId): Promise<MixResolve<{ solo: boolean }>> {
  const r = mixResolveTrack(parsed);
  if (!r) return mixErr("not_found");
  if (r.kind === "return" || r.kind === "master") return mixErr("unsupported_target");
  const t = r.obj as { solo?: unknown };
  const next = !(t.solo === true);
  try {
    (t as { solo?: boolean }).solo = next;
    return mixOkWith({ solo: next });
  } catch (e) {
    return mixErr(`sdk_error: ${e instanceof Error ? e.message : String(e)}`);
  }
}

async function mixSetSend(parsed: MixParsedId, value: number): Promise<MixResolve<void>> {
  if (parsed.kind !== "send" || parsed.sendIndex === null) return mixErr("not_found");
  const r = mixResolveTrack(parsed);
  if (!r) return mixErr("not_found");
  if (r.kind === "master") return mixErr("unsupported_target");
  const mixer = safeReadMixer(r.obj as AnyTrack);
  if (!mixer) return mixErr("not_found");
  const sends = (mixer as { sends?: Array<{ setValue?: (v: number) => Promise<unknown>; min?: unknown; max?: unknown }> }).sends;
  if (!Array.isArray(sends)) return mixErr("not_found");
  const send = sends[parsed.sendIndex];
  if (!send || typeof send.setValue !== "function") return mixErr("not_found");
  try {
    const min = typeof send.min === "number" ? send.min : 0;
    const max = typeof send.max === "number" ? send.max : 1;
    const scaled = min + clamp01(value) * (max - min);
    await send.setValue(scaled);
    return mixOk();
  } catch (e) {
    return mixErr(`sdk_error: ${e instanceof Error ? e.message : String(e)}`);
  }
}

async function mixSetParam(parsed: MixParsedId, value: number): Promise<MixResolve<void>> {
  if (parsed.kind !== "parameter" || parsed.deviceIndex === null || parsed.paramIndex === null) {
    return mixErr("not_found");
  }
  const r = mixResolveTrack(parsed);
  if (!r) return mixErr("not_found");
  if (r.kind === "return") return mixErr("unsupported_target");
  const t = r.obj as { devices?: Array<{ parameters?: Array<{ setValue?: (v: number) => Promise<unknown>; min?: unknown; max?: unknown }> }> };
  if (!Array.isArray(t.devices)) return mixErr("not_found");
  const device = t.devices[parsed.deviceIndex];
  if (!device || !Array.isArray(device.parameters)) return mixErr("not_found");
  const param = device.parameters[parsed.paramIndex];
  if (!param || typeof param.setValue !== "function") return mixErr("not_found");
  try {
    const min = typeof param.min === "number" ? param.min : 0;
    const max = typeof param.max === "number" ? param.max : 1;
    const scaled = min + clamp01(value) * (max - min);
    await param.setValue(scaled);
    return mixOk();
  } catch (e) {
    return mixErr(`sdk_error: ${e instanceof Error ? e.message : String(e)}`);
  }
}

// ---------------- WebSocket dispatcher ----------------

// Tolerant dispatcher: accepts arbitrary JSON shapes from clients that use
// their own protocol (the phone sends `{type:"ping"}`, the admin sends
// `{type:"register", ...}`). Only respond when the message matches our
// `{id, cmd, args}` shape; otherwise log the unknown message and move on.
// This keeps both the bundled phone-v3 PWA and the bundled admin UI
// connected without us having to implement either's protocol.
function dispatch(ws: WebSocket, raw: string): void {
  let msg: Record<string, unknown>;
  try {
    msg = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    console.log(`[ableton-rc-bridge] ws: non-JSON message (${raw.length} bytes) ignored`);
    return;
  }
  if (typeof msg["cmd"] !== "string") {
    // Foreign protocol (phone ping, admin register, etc.) — log and stay quiet.
    const kind = typeof msg["type"] === "string" ? msg["type"] : "unknown";
    console.log(`[ableton-rc-bridge] ws: foreign msg type="${kind}" ignored`);
    return;
  }
  const cmd = msg["cmd"];
  const id = msg["id"];
  const args = (msg["args"] ?? {}) as Args;
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

// ---------------- Interactive test page ----------------

const TEST_PAGE_HTML = `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<title>ableton-rc-bridge / test</title>
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
<h1>ableton-rc-bridge &mdash; WebSocket test (port <span id="port">?</span>)</h1>

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

// ---------------- Mix View dispatch and snapshot loop ----------------
//
// `mixDispatch` accepts JSON messages from /mix/ws clients. The full
// command set is implemented in a later commit; this stub keeps the
// skeleton compilable and answers unknown types with mix.error so the
// client can surface the failure.

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
    mixStructureCache = null;
    mixStructureVersion += 1;
    if (ws.readyState === ws.OPEN) {
      ws.send(JSON.stringify({ type: SERVER_MSG.ACK, refId, ok: true }));
    }
    return;
  }
  if (cmdType === CLIENT_CMD.SET_SELECTION) {
    // Lightweight selection hint: which track/device the user has
    // expanded. Drives the params tier budget allocation.
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
  if (cmdType === "mix.setSelection") {
    // Duplicate handler removed; the canonical handler is the one
    // above that uses CLIENT_CMD.SET_SELECTION. Keeping the
    // constant-driven handler means renaming the command in one
    // place is enough.
  }

  // The remaining command types all target a specific SDK handle.
  const targetId = msg["targetId"];
  const parsed = mixParseId(targetId);
  if (!parsed) {
    sendMixError(ws, refId, "invalid_target_id");
    return;
  }
  const value = typeof msg["value"] === "number" ? msg["value"] : NaN;

  let handlerResult: MixResolve<unknown> | null = null;
  try {
    switch (cmdType) {
      case CLIENT_CMD.SET_VOLUME: {
        if (!Number.isFinite(value) || value < 0 || value > 1) { sendMixError(ws, refId, "bad_value"); return; }
        if (parsed.type === "return") { sendMixError(ws, refId, "unsupported_target"); return; }
        const res = await mixApplyWrite_(mixWriteQueueKeyFor(parsed), () => mixSetVolume(parsed, value), "setVolume");
        handlerResult = res as MixResolve<unknown>;
        break;
      }
      case CLIENT_CMD.SET_PAN: {
        if (!Number.isFinite(value) || value < -1 || value > 1) { sendMixError(ws, refId, "bad_value"); return; }
        if (parsed.type === "return") { sendMixError(ws, refId, "unsupported_target"); return; }
        const res = await mixApplyWrite_(mixWriteQueueKeyFor(parsed), () => mixSetPan(parsed, value), "setPan");
        handlerResult = res as MixResolve<unknown>;
        break;
      }
      case CLIENT_CMD.TOGGLE_MUTE: {
        if (parsed.type === "return") { sendMixError(ws, refId, "unsupported_target"); return; }
        const res = await mixApplyWrite_(mixWriteQueueKeyFor(parsed), () => mixToggleMute(parsed), "toggleMute");
        handlerResult = res as MixResolve<unknown>;
        break;
      }
      case CLIENT_CMD.TOGGLE_SOLO: {
        if (parsed.type === "return" || parsed.type === "master") { sendMixError(ws, refId, "unsupported_target"); return; }
        const res = await mixApplyWrite_(mixWriteQueueKeyFor(parsed), () => mixToggleSolo(parsed), "toggleSolo");
        handlerResult = res as MixResolve<unknown>;
        break;
      }
      case CLIENT_CMD.SET_SEND: {
        if (!Number.isFinite(value) || value < 0 || value > 1) { sendMixError(ws, refId, "bad_value"); return; }
        if (parsed.type === "master") { sendMixError(ws, refId, "unsupported_target"); return; }
        const res = await mixApplyWrite_(mixWriteQueueKeyFor(parsed), () => mixSetSend(parsed, value), "setSend");
        handlerResult = res as MixResolve<unknown>;
        break;
      }
      case CLIENT_CMD.SET_PARAM: {
        if (!Number.isFinite(value) || value < 0 || value > 1) { sendMixError(ws, refId, "bad_value"); return; }
        const res = await mixApplyWrite_(mixWriteQueueKeyFor(parsed), () => mixSetParam(parsed, value), "setParam");
        handlerResult = res as MixResolve<unknown>;
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
      ws.send(JSON.stringify({ type: SERVER_MSG.ACK, refId, ok: true, result: handlerResult.value }));
    }
  } else {
    sendMixError(ws, refId, handlerResult.reason);
  }
}

function sendMixError(ws: WebSocket, refId: string | null, reason: string): void {
  if (ws.readyState !== ws.OPEN) return;
  ws.send(JSON.stringify({ type: SERVER_MSG.ERROR, refId, reason }));
}

async function mixApplyWrite_<T>(key: string, fn: () => Promise<MixResolve<T>>, label: string): Promise<MixResolve<T>> {
  let result: MixResolve<T> = mixErr("no_result");
  const prev = mixWriteQueues.get(key) ?? Promise.resolve();
  const next = prev.then(async () => {
    try {
      result = await withTimeout(fn(), MIX_WRITE_TIMEOUT_MS, label);
    } catch (e) {
      result = mixErr(`sdk_error: ${e instanceof Error ? e.message : String(e)}`);
    }
  });
  mixWriteQueues.set(key, next);
  await next;
  return result;
}

// ---------------- Mix View: server-side readers ----------------
//
// These helpers read the Live song. Every call is wrapped in try/catch:
// the SDK can throw or return undefined for fields that the user has
// not configured in a particular Live set. We never let a single bad
// track crash the whole snapshot tick.

type AnyTrack = {
  name?: unknown;
  mute?: unknown;
  solo?: unknown;
  arm?: unknown;
  devices?: unknown;
  mixer?: unknown;
  groupTrack?: unknown;
  isGroupTrack?: unknown;
};

function clamp01(v: number): number {
  if (!Number.isFinite(v)) return 0;
  if (v <= 0) return 0;
  if (v >= 1) return 1;
  return v;
}

function clampN11(v: number): number {
  if (!Number.isFinite(v)) return 0;
  if (v <= -1) return -1;
  if (v >= 1) return 1;
  return v;
}

function trackIdFor(type: "regular" | "group" | "return" | "master", index: number): string {
  if (type === "master") return "mix:main";
  if (type === "return") return `mix:return:${index}`;
  return `mix:track:${index}`;
}

function trackTypeFor(track: AnyTrack | null | undefined, _kind: "regular" | "return" | "master"): "regular" | "group" | "return" | "master" {
  if (_kind === "master") return "master";
  if (_kind === "return") return "return";
  if (track && typeof track === "object" && (track as { isGroupTrack?: unknown }).isGroupTrack === true) {
    return "group";
  }
  return "regular";
}

function safeReadMixer(track: AnyTrack | null | undefined): Record<string, unknown> | null {
  if (!track || typeof track !== "object") return null;
  const mixer = (track as { mixer?: unknown }).mixer;
  if (!mixer || typeof mixer !== "object") return null;
  return mixer as Record<string, unknown>;
}

async function readTrackVolume(mixer: Record<string, unknown> | null): Promise<{ value: number; ok: boolean }> {
  if (!mixer) return { value: 0, ok: false };
  const v = (mixer as { volume?: { getValue?: () => Promise<unknown>; min?: unknown; max?: unknown } }).volume;
  if (!v || typeof v.getValue !== "function") return { value: 0, ok: false };
  try {
    const raw = await v.getValue();
    const min = typeof v.min === "number" ? v.min : 0;
    const max = typeof v.max === "number" ? v.max : 1;
    if (!Number.isFinite(raw as number) || max <= min) return { value: 0, ok: false };
    return { value: clamp01(((raw as number) - min) / (max - min)), ok: true };
  } catch {
    return { value: 0, ok: false };
  }
}

async function readTrackPan(mixer: Record<string, unknown> | null): Promise<{ value: number; ok: boolean }> {
  if (!mixer) return { value: 0, ok: false };
  const p = (mixer as { panning?: { getValue?: () => Promise<unknown>; min?: unknown; max?: unknown } }).panning;
  if (!p || typeof p.getValue !== "function") return { value: 0, ok: false };
  try {
    const raw = await p.getValue();
    const min = typeof p.min === "number" ? p.min : -1;
    const max = typeof p.max === "number" ? p.max : 1;
    if (!Number.isFinite(raw as number) || max <= min) return { value: 0, ok: false };
    return { value: clampN11(((raw as number) - min) / (max - min) * 2 - 1), ok: true };
  } catch {
    return { value: 0, ok: false };
  }
}

async function readTrackSends(track: AnyTrack | null | undefined, trackId: string): Promise<MixSendSnapshot[]> {
  const mixer = safeReadMixer(track);
  if (!mixer) return [];
  const sends = (mixer as { sends?: Array<{ name?: unknown; getValue?: () => Promise<unknown>; min?: unknown; max?: unknown }> }).sends;
  if (!Array.isArray(sends)) return [];
  const out: MixSendSnapshot[] = [];
  for (let i = 0; i < sends.length; i++) {
    const send = sends[i];
    if (!send || typeof send !== "object") continue;
    const name = typeof send.name === "string" ? send.name : `Send ${i + 1}`;
    let level = 0;
    if (typeof send.getValue === "function") {
      try {
        const raw = await send.getValue();
        const min = typeof send.min === "number" ? send.min : 0;
        const max = typeof send.max === "number" ? send.max : 1;
        if (Number.isFinite(raw as number) && max > min) {
          level = clamp01(((raw as number) - min) / (max - min));
          out.push({ id: `${trackId}:send:${i}`, name, level });
        }
      } catch {
        // ignore
      }
    }
  }
  return out;
}

async function readDevicesList(track: AnyTrack | null | undefined, trackId: string): Promise<MixDeviceSnapshot[]> {
  if (!track || typeof track !== "object") return [];
  const devices = (track as { devices?: Array<{ name?: unknown; parameters?: unknown }> }).devices;
  if (!Array.isArray(devices)) return [];
  const out: MixDeviceSnapshot[] = [];
  for (let di = 0; di < devices.length; di++) {
    const d = devices[di];
    if (!d || typeof d !== "object") continue;
    const name = typeof d.name === "string" ? d.name : `Device ${di + 1}`;
    out.push({
      id: `${trackId}:dev:${di}`,
      name,
      parameters: readDeviceParameters(d.parameters, `${trackId}:dev:${di}`),
    });
  }
  return out;
}

function readDeviceParameters(parameters: unknown, deviceId: string): MixParamSnapshot[] {
  if (!Array.isArray(parameters)) return [];
  const out: MixParamSnapshot[] = [];
  for (let pi = 0; pi < parameters.length; pi++) {
    const p = parameters[pi];
    if (!p || typeof p !== "object") continue;
    const min = typeof (p as { min?: unknown }).min === "number" ? (p as { min: number }).min : 0;
    const max = typeof (p as { max?: unknown }).max === "number" ? (p as { max: number }).max : 1;
    const valueRaw = (p as { value?: unknown }).value;
    const value = typeof valueRaw === "number" ? valueRaw : 0;
    const name = typeof (p as { name?: unknown }).name === "string" ? (p as { name: string }).name : `Param ${pi + 1}`;
    const isQuantized = (p as { isQuantized?: unknown }).isQuantized === true;
    const valueItems = Array.isArray((p as { valueItems?: unknown }).valueItems)
      ? ((p as { valueItems: Array<{ name?: unknown; shortName?: unknown }> }).valueItems).map((vi) => ({
          name: typeof vi.name === "string" ? vi.name : "",
          shortName: typeof vi.shortName === "string" ? vi.shortName : "",
        }))
      : [];
    const defaultValueRaw = (p as { defaultValue?: unknown }).defaultValue;
    const defaultValue = typeof defaultValueRaw === "number" ? defaultValueRaw : null;
    const isReadOnly = typeof (p as { setValue?: unknown }).setValue !== "function";
    const wire = max > min ? clamp01((value - min) / (max - min)) : 0;
    out.push({
      id: `${deviceId}:par:${pi}`,
      name,
      value: wire,
      min,
      max,
      defaultValue,
      isQuantized,
      valueItems,
      kind: pickParamKind(isQuantized, valueItems, isReadOnly),
      isReadOnly,
    });
  }
  return out;
}

function pickParamKind(
  isQuantized: boolean,
  valueItems: Array<{ name: string; shortName: string }>,
  isReadOnly: boolean,
): "continuous" | "enum" | "toggle" | "disabled" {
  if (isReadOnly) return "disabled";
  if (isQuantized) {
    if (valueItems.length > 1) return "enum";
    if (valueItems.length === 1) return "toggle";
    return "continuous";
  }
  return "continuous";
}

// ---------------- Mix View: tiered snapshot loop ----------------

let mixClientsActive = 0;

function trackMixClientConnected(): void {
  mixClientsActive += 1;
}

function trackMixClientDisconnected(): void {
  mixClientsActive = Math.max(0, mixClientsActive - 1);
}

function mixClientsPresent(): boolean {
  return mixClientsActive > 0;
}

// Accept array-like SDK objects that have `.length` and indexed access
// but may not satisfy `Array.isArray` (Proxies, host objects). This is
// what the legacy `getTargets` handler relies on (it does `for (let
// ti = 0; ti < song.tracks.length; ti++)`), and the Mix View must
// not disagree with that pattern.
function isArrayLike(o: unknown): o is { length: number; [n: number]: unknown } {
  if (!o || typeof o !== "object") return false;
  const l = (o as { length?: unknown }).length;
  return typeof l === "number" && Number.isFinite(l) && l >= 0;
}

async function readAllRegularTracks(): Promise<Array<{ track: unknown; index: number }>> {
  const ctx = extensionContext;
  if (!ctx) {
    console.log("[ableton-rc-bridge] mix: readAllRegularTracks: no extension context");
    return [];
  }
  const app = (ctx as { application?: { song?: { tracks?: unknown } } }).application;
  if (!app) {
    console.log("[ableton-rc-bridge] mix: readAllRegularTracks: no application");
    return [];
  }
  const song = app.song;
  if (!song) {
    console.log("[ableton-rc-bridge] mix: readAllRegularTracks: no song");
    return [];
  }
  const tracks = song.tracks;
  if (!isArrayLike(tracks)) {
    console.log(`[ableton-rc-bridge] mix: readAllRegularTracks: tracks is not array-like (type=${typeof tracks})`);
    return [];
  }
  const out: Array<{ track: unknown; index: number }> = [];
  for (let i = 0; i < tracks.length; i++) {
    const t = tracks[i];
    if (!t) continue;
    out.push({ track: t, index: i });
  }
  console.log(`[ableton-rc-bridge] mix: readAllRegularTracks: ${out.length} regular tracks`);
  return out;
}

async function readReturnTracks(): Promise<Array<{ track: unknown; index: number }>> {
  const ctx = extensionContext;
  if (!ctx) return [];
  const app = (ctx as { application?: { song?: { returnTracks?: unknown } } }).application;
  if (!app) return [];
  const song = app.song;
  if (!song) return [];
  const rs = song.returnTracks;
  if (!isArrayLike(rs)) {
    console.log(`[ableton-rc-bridge] mix: readReturnTracks: returnTracks is not array-like (type=${typeof rs})`);
    return [];
  }
  const out: Array<{ track: unknown; index: number }> = [];
  for (let i = 0; i < rs.length; i++) {
    const t = rs[i];
    if (!t) continue;
    out.push({ track: t, index: i });
  }
  console.log(`[ableton-rc-bridge] mix: readReturnTracks: ${out.length} return tracks`);
  return out;
}

async function readMainTrack(): Promise<unknown | null> {
  const ctx = extensionContext;
  if (!ctx) return null;
  const app = (ctx as { application?: { song?: { masterTrack?: unknown; mainTrack?: unknown } } }).application;
  if (!app) return null;
  const song = app.song;
  if (!song) return null;
  const t = (song as { masterTrack?: unknown }).masterTrack ?? (song as { mainTrack?: unknown }).mainTrack ?? null;
  return t;
}

async function mixStructureTick(): Promise<void> {
  if (!mixClientsPresent()) return;
  const regulars = await readAllRegularTracks();
  const returns = await readReturnTracks();
  const main = await readMainTrack();

  const groupIndices = new Set<number>();
  for (const { track, index } of regulars) {
    if (!track || typeof track !== "object") continue;
    if ((track as { isGroupTrack?: unknown }).isGroupTrack === true) {
      groupIndices.add(index);
    }
  }

  const tracks: MixTrackSnapshot[] = [];
  for (const { track, index } of regulars) {
    const name = typeof (track as { name?: unknown }).name === "string"
      ? ((track as { name: string }).name)
      : `Track ${index + 1}`;
    const type: "regular" | "group" = groupIndices.has(index) ? "group" : "regular";
    tracks.push({ id: trackIdFor(type, index), name, type, groupTrackId: null });
  }
  for (let i = 0; i < returns.length; i++) {
    const r = returns[i];
    if (!r) continue;
    const name = typeof (r.track as { name?: unknown }).name === "string"
      ? ((r.track as { name: string }).name)
      : `Return ${i + 1}`;
    tracks.push({ id: trackIdFor("return", i), name, type: "return", groupTrackId: null });
  }
  if (main) {
    const name = typeof (main as { name?: unknown }).name === "string"
      ? ((main as { name: string }).name)
      : "Master";
    tracks.push({ id: trackIdFor("master", 0), name, type: "master", groupTrackId: null });
  }

  // Backfill groupTrackId by walking the regulars.
  for (let i = 0; i < regulars.length; i++) {
    const entry = regulars[i];
    if (!entry) continue;
    const t = entry.track as { groupTrack?: unknown } | null;
    if (!t || typeof t !== "object") continue;
    const parent = t.groupTrack;
    if (!parent || typeof parent !== "object") continue;
    for (let j = 0; j < regulars.length; j++) {
      const other = regulars[j];
      if (!other) continue;
      if (other.track === parent) {
        const child = tracks[i];
        if (child) child.groupTrackId = trackIdFor(groupIndices.has(j) ? "group" : "regular", j);
        break;
      }
    }
  }

  const next: MixStructureCache = { version: mixStructureVersion + 1, tracks };
  if (mixStructureDeltaHasChanged(mixStructureCache, next)) {
    mixStructureCache = next;
    mixStructureVersion = next.version;
    mixStructureCacheAt = Date.now();
  }
}

interface MixMixerCache {
  byTrackId: Map<string, { volume: number; pan: number; mute: boolean; solo: boolean; sends: MixSendSnapshot[] }>;
}

let mixMixerCache: MixMixerCache | null = null;

async function mixMixerTick(): Promise<void> {
  if (!mixClientsPresent()) return;
  if (!mixStructureCache) {
    await mixStructureTick();
    if (!mixStructureCache) return;
  }
  const regulars = await readAllRegularTracks();
  const returns = await readReturnTracks();
  const main = await readMainTrack();

  const next: MixMixerCache = { byTrackId: new Map() };
  const tasks: Array<Promise<void>> = [];

  for (let i = 0; i < regulars.length; i++) {
    const entry = regulars[i];
    if (!entry) continue;
    const id = trackIdFor("regular", i);
    tasks.push((async () => {
      const mixer = safeReadMixer(entry.track as AnyTrack);
      const [volRes, panRes, sends] = await Promise.all([
        readTrackVolume(mixer),
        readTrackPan(mixer),
        readTrackSends(entry.track as AnyTrack, id),
      ]);
      const t = entry.track as { mute?: unknown; solo?: unknown };
      next.byTrackId.set(id, {
        volume: volRes.value,
        pan: panRes.value,
        mute: t.mute === true,
        solo: t.solo === true,
        sends,
      });
    })());
  }

  for (let i = 0; i < returns.length; i++) {
    const r = returns[i];
    if (!r) continue;
    const id = trackIdFor("return", i);
    tasks.push((async () => {
      const [volRes, panRes, sends] = await Promise.all([
        readTrackVolume(safeReadMixer(r.track as AnyTrack)),
        readTrackPan(safeReadMixer(r.track as AnyTrack)),
        readTrackSends(r.track as AnyTrack, id),
      ]);
      const t = r.track as { mute?: unknown; solo?: unknown };
      next.byTrackId.set(id, {
        volume: volRes.value,
        pan: panRes.value,
        mute: t.mute === true,
        solo: t.solo === true,
        sends,
      });
    })());
  }

  if (main) {
    const id = trackIdFor("master", 0);
    tasks.push((async () => {
      const [volRes, panRes, sends] = await Promise.all([
        readTrackVolume(safeReadMixer(main as AnyTrack)),
        readTrackPan(safeReadMixer(main as AnyTrack)),
        readTrackSends(main as AnyTrack, id),
      ]);
      next.byTrackId.set(id, {
        volume: volRes.value,
        pan: panRes.value,
        mute: false,
        solo: false,
        sends,
      });
    })());
  }

  await Promise.all(tasks);
  mixMixerCache = next;
}

async function readSelectedParams(
  track: AnyTrack | null,
  trackId: string,
  paramBudget: number,
): Promise<MixParamSnapshot[]> {
  if (!track || typeof track !== "object") return [];
  const devices = (track as { devices?: unknown }).devices;
  if (!Array.isArray(devices) || devices.length === 0) return [];

  // Hotfix v0.3.1.1: read ALL params (up to paramBudget) every
  // tick instead of rotating through a slice. The rotation
  // caused stale values: a device with 80 params had its first
  // 64 sent on ticks N, N+2, N+4... and its second 64 on ticks
  // N+1, N+3... so a change to param 0 was only reflected every
  // 2 ticks, and a change to params 0..63 simultaneously was
  // invisible until the rotation wrapped. With per-tick full
  // reads, every change is visible within MIX_PARAMS_TICK_MS.
  type Ref = { di: number; p: unknown; pi: number };
  const refs: Ref[] = [];
  for (let di = 0; di < devices.length; di++) {
    const d = devices[di];
    if (!d || typeof d !== "object") continue;
    const params = (d as { parameters?: unknown }).parameters;
    if (!Array.isArray(params)) continue;
    for (let pi = 0; pi < params.length; pi++) {
      const p = params[pi];
      if (!p || typeof p !== "object") continue;
      refs.push({ di, p, pi });
    }
  }
  const cap = Math.min(refs.length, paramBudget);
  const out: MixParamSnapshot[] = [];
  for (let i = 0; i < cap; i++) {
    const ref = refs[i];
    if (!ref) continue;
    const { di, p, pi } = ref;
    const d = devices[di];
    const min = typeof (p as { min?: unknown }).min === "number" ? (p as { min: number }).min : 0;
    const max = typeof (p as { max?: unknown }).max === "number" ? (p as { max: number }).max : 1;
    let wire = 0;
    if (typeof (p as { getValue?: () => Promise<unknown> }).getValue === "function") {
      try {
        const raw = await (p as { getValue: () => Promise<unknown> }).getValue();
        if (Number.isFinite(raw as number) && max > min) {
          wire = clamp01(((raw as number) - min) / (max - min));
        }
      } catch {
        // ignore
      }
    }
    const name = typeof (p as { name?: unknown }).name === "string" ? (p as { name: string }).name : `Param ${pi + 1}`;
    const isQuantized = (p as { isQuantized?: unknown }).isQuantized === true;
    const valueItems = Array.isArray((p as { valueItems?: unknown }).valueItems)
      ? ((p as { valueItems: Array<{ name?: unknown; shortName?: unknown }> }).valueItems).map((vi) => ({
          name: typeof vi.name === "string" ? vi.name : "",
          shortName: typeof vi.shortName === "string" ? vi.shortName : "",
        }))
      : [];
    const defaultValueRaw = (p as { defaultValue?: unknown }).defaultValue;
    const defaultValue = typeof defaultValueRaw === "number" ? defaultValueRaw : null;
    const isReadOnly = typeof (p as { setValue?: unknown }).setValue !== "function";
    const deviceId = `${trackId}:dev:${di}`;
    const deviceName = typeof (d as { name?: unknown }).name === "string" ? (d as { name: string }).name : `Device ${di + 1}`;
    out.push({
      id: `${deviceId}:par:${pi}`,
      name,
      value: wire,
      min,
      max,
      defaultValue,
      isQuantized,
      valueItems,
      kind: pickParamKind(isQuantized, valueItems, isReadOnly),
      isReadOnly,
      deviceName,
    });
  }
  return out;
}

function mixClientSnapshotKey(snapshot: unknown): string {
  try {
    return JSON.stringify(snapshot);
  } catch {
    return "";
  }
}

async function mixParamsTick(): Promise<void> {
  if (!mixClientsPresent()) return;
  const clients = Array.from(trackedClients.values()).filter((c) => c.mode === "mix" && c.mixSelection);
  if (clients.length === 0) return;

  for (const c of clients) {
    if (!c.mixSelection) continue;
    const trackId = c.mixSelection.trackId;
    if (!trackId) continue;

    let trackObj: unknown = null;
    if (trackId === "mix:main") {
      trackObj = await readMainTrack();
    } else if (trackId.startsWith("mix:return:")) {
      const idx = Number(trackId.slice("mix:return:".length));
      const rs = await readReturnTracks();
      trackObj = rs[idx]?.track ?? null;
    } else if (trackId.startsWith("mix:track:")) {
      const idx = Number(trackId.slice("mix:track:".length));
      const regs = await readAllRegularTracks();
      trackObj = regs[idx]?.track ?? null;
    }
    if (!trackObj) continue;

    const parameters = await readSelectedParams(trackObj as AnyTrack, trackId, MIX_MAX_PARAMS_PER_CLIENT);

    if (parameters.length === 0) continue;

    const payload = {
      type: SERVER_MSG.SNAPSHOT,
      tier: "params",
      trackId,
      version: mixStructureVersion,
      ts: Date.now(),
      parameters,
    };
    const key = mixClientSnapshotKey(payload);
    if (key === c.lastMixParamsKey) continue;
    c.lastMixParamsKey = key;
    if (c.ws.readyState === c.ws.OPEN) {
      try {
        c.ws.send(JSON.stringify(payload));
      } catch {
        // ignore
      }
    }
  }
}

function mixStructureDeltaHasChanged(prev: MixStructureCache | null, next: MixStructureCache): boolean {
  if (!prev) return true;
  if (prev.tracks.length !== next.tracks.length) return true;
  for (let i = 0; i < prev.tracks.length; i++) {
    const a = prev.tracks[i];
    const b = next.tracks[i];
    if (!a || !b) return true;
    if (a.id !== b.id || a.name !== b.name || a.type !== b.type || a.groupTrackId !== b.groupTrackId) {
      return true;
    }
  }
  return false;
}

function mixBroadcastStructure(): void {
  if (!mixStructureCache) return;
  let sent = 0;
  for (const c of trackedClients.values()) {
    if (c.mode !== "mix") continue;
    const key = mixClientSnapshotKey(mixStructureCache);
    if (key === c.lastMixStructureKey) continue;
    c.lastMixStructureKey = key;
    if (c.ws.readyState === c.ws.OPEN) {
      try {
        c.ws.send(JSON.stringify({
          type: SERVER_MSG.SNAPSHOT,
          tier: "structure",
          version: mixStructureCache.version,
          ts: Date.now(),
          tracks: mixStructureCache.tracks,
        }));
        sent++;
      } catch {
        // ignore
      }
    }
  }
  if (sent > 0) {
    console.log(`[ableton-rc-bridge] mix: broadcast structure v${mixStructureCache.version} to ${sent} client(s) (${mixStructureCache.tracks.length} tracks)`);
  }
}

function mixBroadcastMixer(): void {
  if (!mixMixerCache || !mixStructureCache) return;
  let sent = 0;
  for (const c of trackedClients.values()) {
    if (c.mode !== "mix") continue;
    const tracks: Array<Record<string, unknown>> = [];
    for (const s of mixStructureCache.tracks) {
      const m = mixMixerCache.byTrackId.get(s.id);
      if (!m) continue;
      tracks.push({
        id: s.id,
        volume: m.volume,
        pan: m.pan,
        mute: m.mute,
        solo: m.solo,
        sends: m.sends,
      });
    }
    const payload = {
      type: SERVER_MSG.SNAPSHOT,
      tier: "mixer",
      version: mixStructureCache.version,
      ts: Date.now(),
      tracks,
    };
    const key = mixClientSnapshotKey(payload);
    if (key === c.lastMixMixerKey) continue;
    c.lastMixMixerKey = key;
    if (c.ws.readyState === c.ws.OPEN) {
      try {
        c.ws.send(JSON.stringify(payload));
        sent++;
      } catch {
        // ignore
      }
    }
  }
  if (sent > 0) {
    console.log(`[ableton-rc-bridge] mix: broadcast mixer to ${sent} client(s) (${mixStructureCache.tracks.length} tracks)`);
  }
}

// Server-side tiered snapshot loop. Self-gates on the number of
// connected mix clients so we burn zero CPU when nobody is listening.
let mixSnapshotLoopStarted = false;
let mixStructureInterval: NodeJS.Timeout | null = null;
let mixMixerInterval: NodeJS.Timeout | null = null;
let mixParamsInterval: NodeJS.Timeout | null = null;

function startMixSnapshotLoop(): void {
  if (mixSnapshotLoopStarted) return;
  mixSnapshotLoopStarted = true;
  mixStructureInterval = setInterval(() => {
    void mixStructureTick().then(mixBroadcastStructure);
  }, MIX_STRUCTURE_TICK_MS);
  mixMixerInterval = setInterval(() => {
    void mixMixerTick().then(mixBroadcastMixer);
  }, MIX_MIXER_TICK_MS);
  mixParamsInterval = setInterval(() => {
    void mixParamsTick();
  }, MIX_PARAMS_TICK_MS);
}

// ---------------- HTTP handlers ----------------

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
  // Strip the leading /static/ so the URL path is relative to staticDir.
  // /static/phone-v3/style.css  ->  phone-v3/style.css  ->  dist/static/phone-v3/style.css
  const relativePath = rawPath.startsWith("/static/")
    ? rawPath.slice("/static/".length)
    : rawPath.replace(/^\/+/, "");
  const normalized = path
    .normalize(decodeURIComponent(relativePath))
    .replace(/^[\\/]+/, "");
  let filePath = path.join(staticDir, normalized);
  // Reject path-traversal: filePath must be inside staticDir.
  if (
    !filePath.startsWith(staticDir + path.sep) &&
    filePath !== staticDir
  ) {
    res.writeHead(403, { "Content-Type": "text/plain" });
    res.end("forbidden\n");
    return;
  }
  // If the path resolves to a directory, try serving its index.html.
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
  // COOP/COEP for SharedArrayBuffer / cross-origin isolation.
  res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
  res.setHeader("Cross-Origin-Embedder-Policy", "require-corp");
  res.setHeader("Cross-Origin-Resource-Policy", "same-origin");
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Content-Type", MIME_TYPES[ext] ?? "application/octet-stream");
  res.end(data);
}

async function handleHttp(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const ts = new Date().toISOString();
  console.log(`[${ts}] ${req.method} ${req.url}`);

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
      message: "ableton-rc-bridge: hello from inside Live. Etapa B OK.",
      commands: Object.keys(commands),
    }));
    return;
  }

  // Root: redirect to the bundled PWA.
  if (req.url === "/" || req.url === "/index.html") {
    res.writeHead(302, { Location: "/static/phone-v3/" });
    res.end();
    return;
  }

  // Mix View: redirect to its bundled PWA. The WebSocket is on /mix/ws.
  // v0.3.1: no auth, no token. The HTTPS model + the URL alone are the
  // gating signal, the same way the existing phone view is gated.
  if (req.url === "/mix" || req.url === "/mix/") {
    res.writeHead(302, { Location: "/static/mix/" });
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

  // Serve the bundled PWA from dist/static/...
  if (req.url?.startsWith("/static/")) {
    await serveStaticFile(req.url, res);
    return;
  }

  res.writeHead(404, { "Content-Type": "text/plain" });
  res.end("not found. try /, /health, /commands, /test, or /ws (WebSocket)\n");
}

// ---------------- Activate ----------------

const SCOPES = [
  "MidiTrack",
  "AudioTrack",
  "MidiClip",
  "AudioClip",
  "ClipSlot",
  "Scene",
] as const;

function getLanAddresses(): string[] {
  const interfaces = networkInterfaces();
  const out: string[] = [];
  for (const addrs of Object.values(interfaces)) {
    if (!addrs) continue;
    for (const addr of addrs) {
      if (addr.family === "IPv4" && !addr.internal) {
        out.push(addr.address);
      }
    }
  }
  return out;
}

// Keep only RFC1918 private addresses (10/8, 172.16/12, 192.168/16). Drops
// Docker bridges (172.17-30.x), Tailscale/WARP public IPs, link-local, etc.
function isRfc1918(ip: string): boolean {
  const m = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(ip);
  if (!m) return false;
  const a = Number(m[1]);
  const b = Number(m[2]);
  return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}

// Filter to RFC1918 and pick the most useful primary. Preference: 192.168
// (most common home router default), then 10/8, then 172.16/12.
function pickLanIps(ips: string[]): { primary: string; others: string[] } {
  const rfc = ips.filter(isRfc1918);
  if (rfc.length === 0) {
    return { primary: ips[0] ?? "127.0.0.1", others: [] };
  }
  const rank = (ip: string): number => {
    if (ip.startsWith("192.168.")) return 0;
    if (ip.startsWith("10.")) return 1;
    return 2; // 172.16-31
  };
  const sorted = [...rfc].sort((a, b) => rank(a) - rank(b));
  const primary = sorted[0];
  if (!primary) return { primary: "127.0.0.1", others: [] };
  return { primary, others: sorted.slice(1) };
}

async function showInfoDialog(
  context: ReturnType<typeof initialize>,
  message: string,
): Promise<void> {
  const safe = message
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
  const html = `<!DOCTYPE html>
<html><head><style>
*,*::before,*::after{box-sizing:border-box}*{margin:0}
:root{--bg:hsl(0,0%,21%);--text:hsl(0,0%,71%);--ctrl:hsl(0,0%,16%);--border:hsl(0,0%,7%);--accent:hsl(31,100%,67%)}
html{background:var(--bg);color:var(--text);font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;font-size:12px;height:100%}
body{padding:1.5em;height:100%;display:flex;flex-direction:column;justify-content:center;align-items:center;gap:1em}
p{text-align:center;line-height:1.5}
.actions{display:flex;justify-content:flex-end;width:100%}
.btn{font-size:1rem;background:var(--ctrl);color:var(--text);border:1px solid var(--border);height:24px;padding:0 1.5em;border-radius:1em;cursor:pointer}
.btn:active{background:var(--accent);color:hsl(0,0%,7%)}
</style></head>
<body>
<p>${safe}</p>
<div class="actions">
  <button class="btn" onclick="send('ok')">OK</button>
</div>
<script>function send(v){const m={method:"close_and_send",params:[v]};if(window.webkit?.messageHandlers?.live)window.webkit.messageHandlers.live.postMessage(m);else if(window.chrome?.webview)window.chrome.webview.postMessage(m);}</script>
</body></html>`;
  await context.ui.showModalDialog(`data:text/html,${encodeURIComponent(html)}`, 380, 180);
}

async function showNetworkDialog(
  // REPLACED by showPanelDialog
): Promise<void> { return; }

async function showMappingDialog(
  context: ReturnType<typeof initialize>,
): Promise<void> {
  const port = actualPort ?? 0;
  if (!port) {
    console.error("[ableton-rc-bridge] showMappingDialog: server not running, cannot open dialog");
    return;
  }
  const url = `http://127.0.0.1:${port}/static/admin/mappings.html`;

  try {
    await context.ui.showModalDialog(url, 920, 640);
  } catch (err) {
    console.error(`[ableton-rc-bridge] showMappingDialog error: ${err}`);
  }
}

// Module-level handle to the running server so we can stop/restart it from
// menu commands. set in startServer, cleared in stopServer.
let serverInstance: http.Server | null = null;
let httpsServerInstance: https.Server | null = null;
let actualHttpsPort: number | null = null;
let useHttps = false;
let httpsOptions: { key: Buffer; cert: Buffer } | null = null;

// Certs are stored inside the Live extension's persistent storage directory
// (one folder per Live install, survives restarts) under `certs/`. The keys
// are generated at first run via the `selfsigned` package and re-used on
// every subsequent run, so the user's phone can pin the cert after one
// install. No developer paths, no bundled keys in the .ablx.
async function loadCerts(): Promise<void> {
  const storageDir = extensionContext?.environment?.storageDirectory;
  if (!storageDir) {
    // No persistent storage. Generate ephemeral certs so the server can
    // still serve HTTPS for the current session; the user's phone will
    // need to re-accept the cert next launch.
    console.warn("[ableton-rc-bridge] storageDirectory unavailable, generating ephemeral HTTPS certs (will not persist)");
    try {
      const pems = await selfsigned.generate(
        [{ name: "commonName", value: "ableton-rc-bridge.local" }],
        {
          algorithm: "sha256",
          keySize: 2048,
          extensions: [
            { name: "basicConstraints", cA: false },
            {
              name: "keyUsage",
              digitalSignature: true,
              keyEncipherment: true,
            },
            {
              name: "subjectAltName",
              altNames: [
                { type: 2, value: "localhost" },
                { type: 7, ip: "127.0.0.1" },
              ],
            },
          ],
        },
      );
      httpsOptions = {
        key: Buffer.from(pems.private, "utf8"),
        cert: Buffer.from(pems.cert, "utf8"),
      };
      useHttps = true;
    } catch (err) {
      console.error(`[ableton-rc-bridge] ephemeral selfsigned generation failed: ${err instanceof Error ? err.message : String(err)}; falling back to HTTP`);
      useHttps = false;
      httpsOptions = null;
    }
    return;
  }

  // Clean Ableton's drive-letter quirk: storageDirectory on Windows is
  // /C:/Users/...; strip the leading slash so path.join works portably.
  const cleanStorageDir = storageDir.replace(/^\/([a-zA-Z]):/, "$1:");
  const certDir = path.join(cleanStorageDir, "certs");
  const keyPath = path.join(certDir, "ableton-rc-server.key");
  const certPath = path.join(certDir, "ableton-rc-server.crt");

  try {
    const [key, cert] = await Promise.all([
      fs.readFile(keyPath),
      fs.readFile(certPath),
    ]);
    httpsOptions = { key, cert };
    useHttps = true;
    console.log(`[ableton-rc-bridge] loaded HTTPS certs from ${certDir}`);
    return;
  } catch {
    // Files don't exist (or unreadable) -- generate fresh and persist.
  }

  try {
    await fs.mkdir(certDir, { recursive: true });
    const pems = await selfsigned.generate(
      [{ name: "commonName", value: "ableton-rc-bridge.local" }],
      {
        algorithm: "sha256",
        keySize: 2048,
        extensions: [
          { name: "basicConstraints", cA: false },
          {
            name: "keyUsage",
            digitalSignature: true,
            keyEncipherment: true,
          },
          {
            name: "subjectAltName",
            altNames: [
              { type: 2, value: "localhost" },
              { type: 7, ip: "127.0.0.1" },
            ],
          },
        ],
      },
    );
    await Promise.all([
      fs.writeFile(keyPath, pems.private, { mode: 0o600 }),
      fs.writeFile(certPath, pems.cert, { mode: 0o600 }),
    ]);
    httpsOptions = {
      key: Buffer.from(pems.private, "utf8"),
      cert: Buffer.from(pems.cert, "utf8"),
    };
    useHttps = true;
    console.log(`[ableton-rc-bridge] generated and saved new HTTPS certs to ${certDir}`);
  } catch (err) {
    console.error(`[ableton-rc-bridge] could not generate/persist HTTPS certs: ${err instanceof Error ? err.message : String(err)}; falling back to HTTP (camera/mic will not work on phone)`);
    useHttps = false;
    httpsOptions = null;
  }
}

// Start the HTTP+WS server. Resolves with the bound port. Idempotent: no-op
// if a server is already running.
async function startServer(): Promise<void> {
  if (serverInstance !== null) {
    console.log("[ableton-rc-bridge] startServer: already running");
    return;
  }
  await loadCerts();
  await new Promise<void>((resolve, reject) => {
    const srv = http.createServer(async (req, res) => {
      try {
        await handleHttp(req, res);
      } catch (err) {
        const detail = err instanceof Error ? err.message : String(err);
        console.error(`[ableton-rc-bridge] http error: ${detail}`);
        if (!res.headersSent) {
          res.writeHead(500, { "Content-Type": "text/plain" });
          res.end(`server error: ${detail}\n`);
        }
      }
    });

    let httpsSrv: https.Server | null = null;
    if (useHttps && httpsOptions) {
      httpsSrv = https.createServer(httpsOptions, async (req, res) => {
        try {
          await handleHttp(req, res);
        } catch (err) {
          const detail = err instanceof Error ? err.message : String(err);
          console.error(`[ableton-rc-bridge] https error: ${detail}`);
          if (!res.headersSent) {
            res.writeHead(500, { "Content-Type": "text/plain" });
            res.end(`server error: ${detail}\n`);
          }
        }
      });
    }

    const wsServer = new WebSocketServer({
      noServer: true,
      perMessageDeflate: false,
    });
    const adminWsServer = new WebSocketServer({
      noServer: true,
      perMessageDeflate: false,
    });
    const mixWsServer = new WebSocketServer({
      noServer: true,
      perMessageDeflate: false,
    });

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

        // Close any duplicate active connection for this clientId
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
        // PWA expects {type:"hello", client_id} on connect. If we send
        // {event:"connected", clientId} instead, the phone never sets its
        // clientId, sendLoop never fires, and the admin never sees the phone.
        void (async () => {
          let initTempo = 120;
          let initSig = "4/4";
          let initScale = "--";
          let initValues: Record<string, number> = {};
          try {
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
              // Capture display name from snapshot if present
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
                      // Apply mapping for XY controls
                      void applyMapping(info.id, `${name}.x`, ctrl.x);
                      void applyMapping(info.id, `${name}.y`, ctrl.y);
                    } else if (typeof ctrl.value === "number") {
                      appendHistory(info, name, ctrl.value, receivedAt);
                      // Apply mapping for value controls
                      void applyMapping(info.id, name, ctrl.value);
                    }
                  }
                }

                // Process orientation sensors
                const orient = snapData["orient"];
                if (orient && typeof orient === "object") {
                  if (typeof orient.alpha === "number") {
                    // alpha is 0..360, calibrated to 180 at center
                    const alphaVal = Math.max(0, Math.min(360, orient.alpha)) / 360;
                    appendHistory(info, "sensor.orient.alpha", alphaVal, receivedAt);
                    void applyMapping(info.id, "sensor.orient.alpha", alphaVal);
                  }
                  if (typeof orient.beta === "number") {
                    // Pitch goes from -90 to 90 degrees in both relative-matrix and Madgwick modes
                    const betaVal = (Math.max(-90, Math.min(90, orient.beta)) + 90) / 180;
                    appendHistory(info, "sensor.orient.beta", betaVal, receivedAt);
                    void applyMapping(info.id, "sensor.orient.beta", betaVal);
                  }
                  if (typeof orient.gamma === "number") {
                    // Roll goes from -180 to 180 degrees in both relative-matrix and Madgwick modes
                    const gammaVal = (Math.max(-180, Math.min(180, orient.gamma)) + 180) / 360;
                    appendHistory(info, "sensor.orient.gamma", gammaVal, receivedAt);
                    void applyMapping(info.id, "sensor.orient.gamma", gammaVal);
                  }
                }

                // Process motion sensors
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
              // mark_seen
            } else if (t === "toggle_play") {
              if (playheadActive) {
                playheadBaseTimeMs += (Date.now() - playheadStartTime);
                playheadActive = false;
              } else {
                playheadStartTime = Date.now();
                playheadActive = true;
              }
              broadcastPlayheadState();
            } else if (t === "set_display_name") {
              const newName = parsed["display_name"];
              if (typeof newName === "string") {
                info.displayName = newName;
                pushClientUpdate(info);
                console.log(`[ableton-rc-bridge] client ${clientId} renamed to "${newName}"`);
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

    setupWssHandlers(wsServer, "/ws", "WS", false);
    setupWssHandlers(adminWsServer, "/admin/ws", "ADMIN-WS", true);
    setupMixWssHandlers(mixWsServer, "/mix/ws", "MIX-WS");

    const handleUpgrade = (req: http.IncomingMessage, socket: any, head: Buffer) => {
      const urlPath = req.url ? req.url.split("?")[0] : "";
      if (urlPath === "/ws") {
        wsServer.handleUpgrade(req, socket, head, (ws) => {
          wsServer.emit("connection", ws, req);
        });
      } else if (urlPath === "/admin/ws") {
        adminWsServer.handleUpgrade(req, socket, head, (ws) => {
          adminWsServer.emit("connection", ws, req);
        });
      } else if (urlPath === "/mix/ws") {
        mixWsServer.handleUpgrade(req, socket, head, (ws) => {
          mixWsServer.emit("connection", ws, req);
        });
      } else {
        socket.destroy();
      }
    };

    srv.on("upgrade", handleUpgrade);
    if (httpsSrv) {
      httpsSrv.on("upgrade", handleUpgrade);
    }

    const handleError = (err: any) => {
      console.error(`[ableton-rc-bridge] server error: ${err.message}`);
      serverInstance = null;
      httpsServerInstance = null;
      actualPort = null;
      actualHttpsPort = null;
      reject(err);
    };

    srv.on("error", handleError);
    if (httpsSrv) {
      httpsSrv.on("error", handleError);
    }

    srv.listen(0, "0.0.0.0", () => {
      const addr = srv.address() as AddressInfo | null;
      if (!addr) {
        reject(new Error("server.address() returned null"));
        return;
      }
      actualPort = addr.port;
      serverInstance = srv;

      if (httpsSrv) {
        // Try to listen on actualPort + 1 first, or fallback to random free port
        const targetHttpsPort = actualPort + 1;
        httpsSrv.listen(targetHttpsPort, "0.0.0.0", () => {
          const httpsAddr = httpsSrv!.address() as AddressInfo | null;
          if (httpsAddr) {
            actualHttpsPort = httpsAddr.port;
            httpsServerInstance = httpsSrv;
            printListenInfo();
            resolve();
          } else {
            reject(new Error("httpsServer.address() returned null"));
          }
        });
        
        httpsSrv.on("error", (err: any) => {
          if ((err as any).code === "EADDRINUSE") {
            httpsSrv!.listen(0, "0.0.0.0", () => {
              const httpsAddr = httpsSrv!.address() as AddressInfo | null;
              if (httpsAddr) {
                actualHttpsPort = httpsAddr.port;
                httpsServerInstance = httpsSrv;
                printListenInfo();
                resolve();
              }
            });
          } else {
            handleError(err);
          }
        });
      } else {
        printListenInfo();
        resolve();
      }
    });

    function printListenInfo(): void {
      const ips = getLanAddresses();
      console.log(`[ableton-rc-bridge] HTTP listening on http://0.0.0.0:${actualPort}`);
      if (actualHttpsPort) {
        console.log(`[ableton-rc-bridge] HTTPS listening on https://0.0.0.0:${actualHttpsPort}`);
      }
      for (const ip of ips) {
        console.log(`[ableton-rc-bridge]   Local Mappings URL: http://${ip}:${actualPort}/static/admin/mappings.html`);
        if (actualHttpsPort) {
          console.log(`[ableton-rc-bridge]   LAN phone URL: https://${ip}:${actualHttpsPort}/`);
        } else {
          console.log(`[ableton-rc-bridge]   LAN phone URL: http://${ip}:${actualPort}/`);
        }
      }
    }
  });
}

// Stop the server and drop all WS clients. Idempotent.
async function stopServer(): Promise<void> {
  const srv = serverInstance;
  const httpsSrv = httpsServerInstance;
  if (!srv && !httpsSrv) return;
  serverInstance = null;
  httpsServerInstance = null;
  actualPort = null;
  actualHttpsPort = null;

  // Tear down the mix snapshot loop so a subsequent startServer
  // re-initialises the intervals. The mixSnapshotLoopStarted flag
  // is the gate that startMixSnapshotLoop() checks, so resetting
  // it here re-arms the loop.
  if (mixStructureInterval) { clearInterval(mixStructureInterval); mixStructureInterval = null; }
  if (mixMixerInterval)     { clearInterval(mixMixerInterval);     mixMixerInterval = null; }
  if (mixParamsInterval)    { clearInterval(mixParamsInterval);    mixParamsInterval = null; }
  mixSnapshotLoopStarted = false;
  mixStructureCache = null;
  mixMixerCache = null;
  mixClientsActive = 0;
  mixWriteQueues.clear();
  // Close every tracked WS so phones/admins see the disconnect promptly.
  for (const c of [...trackedClients.values()]) {
    try { c.ws.close(1001, "server stopping"); } catch { /* ignore */ }
  }
  trackedClients.clear();
  adminSockets.clear();

  const promises: Promise<void>[] = [];
  if (srv) {
    promises.push(new Promise<void>((resolve) => {
      srv.close(() => resolve());
    }));
  }
  if (httpsSrv) {
    promises.push(new Promise<void>((resolve) => {
      httpsSrv.close(() => resolve());
    }));
  }
  await Promise.all(promises);
  console.log("[ableton-rc-bridge] server stopped");
}

async function showServerControlDialog(
  // STUB_REMOVED
): Promise<string> { return "close"; }
void showServerControlDialog; // silence unused

async function showPanelDialog(
  context: ReturnType<typeof initialize>,
): Promise<string> {
  const isRunning = serverInstance !== null;
  const port = actualPort;

  if (isRunning && port !== null) {
    // Servido por HTTP real para evitar problemas de cross-origin WebSocket no WebKit
    const url = `http://127.0.0.1:${port}/static/panel/index.html`;
    return await context.ui.showModalDialog(url, 720, 700);
  }

  // Fallback para data: URI se o servidor estiver parado (para poder mostrar o botão Start)
  const panelDir = path.join(__dirname, "static/panel");
  let html = "";
  try {
    html = await fs.readFile(path.join(panelDir, "index.html"), "utf8");
    const css = await fs.readFile(path.join(panelDir, "style.css"), "utf8");
    const js = await fs.readFile(path.join(panelDir, "app.js"), "utf8");
    const qrJs = await fs.readFile(path.join(panelDir, "qrcode.js"), "utf8");

    // Substitui arquivos estáticos locais por inlines
    html = html.replace('<link rel="stylesheet" href="style.css">', `<style>${css}</style>`);
    html = html.replace('<script src="qrcode.js"></script>', `<script>${qrJs}</script>`);
    html = html.replace('<script src="app.js"></script>', `<script>${js}</script>`);

    // Injeta variáveis iniciais no estado parado
    const injection = `
      <script>
        window.INITIAL_PORT = null;
        window.INITIAL_IS_RUNNING = false;
        window.INITIAL_CLIENTS = [];
      </script>
    `;
    html = html.replace('<body>', `<body>${injection}`);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    html = `<!DOCTYPE html><html><body style="background:#1c1c1e;color:#fff;padding:20px;font-family:sans-serif"><h3>Failed to load panel files: ${detail}</h3></body></html>`;
  }

  return await context.ui.showModalDialog(`data:text/html,${encodeURIComponent(html)}`, 720, 700);
}

function activate(activation: ActivationContext): void {
  extensionContext = initialize(activation, "1.0.0");
  const context = extensionContext;

  // Top-level safety nets so a stray rejection / exception doesn't kill the
  // whole Extension Host (which is what the user is seeing as
  // "Extension Host Has Stopped Running").
  process.on("uncaughtException", (err) => {
    console.error(
      `[ableton-rc-bridge] uncaughtException: ${err && err.stack ? err.stack : String(err)}`,
    );
  });
  process.on("unhandledRejection", (reason) => {
    const detail = reason instanceof Error ? reason.stack : String(reason);
    console.error(`[ableton-rc-bridge] unhandledRejection: ${detail}`);
  });

  // Duplicate dead server code removed. active server is started via startServer()

  // Single unified panel: status + QR + LAN URLs + connected phones + Start/Stop/Restart.
  void context.commands.registerCommand("abletonRcBridge.panel", async () => {
    for (let turn = 0; turn < 24; turn++) {
      let action: string;
      try {
        action = await showPanelDialog(context);
      } catch (err) {
        const detail = err instanceof Error ? err.message : String(err);
        console.error(`[ableton-rc-bridge] panel dialog error: ${detail}`);
        return;
      }
      if (action === "close" || !action) return;
      try {
        if (action === "start" && serverInstance === null) {
          await startServer();
        } else if (action === "stop" && serverInstance !== null) {
          await stopServer();
        } else if (action === "restart") {
          await stopServer();
          await startServer();
        } else if (action === "mappings") {
          await showMappingDialog(context);
        }
      } catch (err) {
        const detail = err instanceof Error ? err.message : String(err);
        console.error(`[ableton-rc-bridge] panel action "${action}" failed: ${detail}`);
        await showInfoDialog(context, `Action failed: ${detail}`);
        return;
      }
    }
  });
  void context.ui.registerContextMenuAction(
    "Scene",
    "RC Bridge: Panel",
    "abletonRcBridge.panel",
  );
  for (const scope of SCOPES) {
    if (scope === "Scene") continue;
    void context.ui.registerContextMenuAction(
      scope,
      "RC Bridge: Panel",
      "abletonRcBridge.panel",
    );
  }

  // Bind on 0.0.0.0 so the phone on the LAN can reach the bridge too.
  // (127.0.0.1 would only allow loopback, breaking the use case.)
  const storageDir = context.environment.storageDirectory;
  if (storageDir) {
    const cleanStorageDir = storageDir.replace(/^\/([a-zA-Z]):/, '$1:');
    mappingsFilePath = path.join(cleanStorageDir, "mappings.json");
    presetsDirPath = path.join(cleanStorageDir, "presets");
    fs.mkdir(presetsDirPath, { recursive: true }).catch(() => {});
    
    loadMappings().catch((err) => {
      console.error(`[ableton-rc-bridge] loadMappings failed: ${err instanceof Error ? err.message : String(err)}`);
    });
  } else {
    console.warn("[ableton-rc-bridge] storageDirectory not available, mappings will not persist");
  }

  startServer().catch((err) => {
    console.error(`[ableton-rc-bridge] initial startServer failed: ${err.message}`);
  });

  // Start the 1-second live state broadcast check interval
  setInterval(checkAndBroadcastLiveState, 1000);

  startSmoothTimer();
  startMixSnapshotLoop();

  console.log("[ableton-rc-bridge] activate() done; awaiting requests");
}

module.exports = { activate };
