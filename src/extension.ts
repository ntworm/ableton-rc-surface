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
interface TrackedClient {
  id: string;
  displayName: string;
  isAdmin: boolean;
  path: string;
  connectedAt: number;
  lastSeen: number;
  userAgent: string;
  lastData: Record<string, any> | null;
  history: Record<string, [number, number][]>;
  ws: import("ws").WebSocket;
}
const trackedClients = new Map<string, TrackedClient>();
const adminSockets = new Set<import("ws").WebSocket>();

const CLIENT_STALE_MS = 35_000; // matches the original admin's prune window
const HISTORY_MAX = 300; // ~10s @ 30 Hz

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

let smoothInterval: NodeJS.Timeout | null = null;

function startSmoothTimer(): void {
  if (smoothInterval) return;
  smoothInterval = setInterval(async () => {
    if (activeSmooths.size === 0) return;
    
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
      const minScale = target.outMin ?? 0;
      const maxScale = target.outMax ?? 1;
      const scaledValue = minScale + value * (maxScale - minScale);
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
      result[controlName] = Math.max(0, Math.min(1, rawValue));
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
  const proto = useHttps ? "https" : "http";
  const url = `${proto}://127.0.0.1:${port}/static/admin/mappings.html`;

  try {
    await context.ui.showModalDialog(url, 920, 640);
  } catch (err) {
    console.error(`[ableton-rc-bridge] showMappingDialog error: ${err}`);
  }
}

// Module-level handle to the running server so we can stop/restart it from
// menu commands. set in startServer, cleared in stopServer.
let serverInstance: http.Server | https.Server | null = null;
let useHttps = false;
let httpsOptions: { key: Buffer; cert: Buffer } | null = null;

async function loadCerts(): Promise<void> {
  const possiblePaths = [
    path.join(__dirname, "..", ".certs"),
    path.join(__dirname, ".certs"),
    "c:\\Users\\Usuario\\repos\\ableton-extensions\\source-repos\\ableton-rc-extension\\.certs",
  ];
  for (const dir of possiblePaths) {
    try {
      const keyPath = path.join(dir, "ableton-rc-server.key");
      const certPath = path.join(dir, "ableton-rc-server.crt");
      const key = await fs.readFile(keyPath);
      const cert = await fs.readFile(certPath);
      httpsOptions = { key, cert };
      useHttps = true;
      console.log(`[ableton-rc-bridge] loaded HTTPS certs from ${dir}`);
      return;
    } catch {
      // try next
    }
  }
  console.log("[ableton-rc-bridge] HTTPS certs not found, running on plain HTTP");
  useHttps = false;
  httpsOptions = null;
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
    let srv: http.Server | https.Server;
    if (useHttps && httpsOptions) {
      srv = https.createServer(httpsOptions, async (req, res) => {
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
    } else {
      srv = http.createServer(async (req, res) => {
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
    }

    const wsServer = new WebSocketServer({
      noServer: true,
      perMessageDeflate: false,
    });
    const adminWsServer = new WebSocketServer({
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
          path,
          connectedAt: Date.now(),
          lastSeen: Date.now(),
          userAgent: req.headers["user-agent"] ?? "unknown",
          lastData: null,
          history: {},
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
                    const alphaVal = Math.max(0, Math.min(360, orient.alpha)) / 360;
                    appendHistory(info, "sensor.orient.alpha", alphaVal, receivedAt);
                    void applyMapping(info.id, "sensor.orient.alpha", alphaVal);
                  }
                  if (typeof orient.beta === "number") {
                    const betaVal = (Math.max(-180, Math.min(180, orient.beta)) + 180) / 360;
                    appendHistory(info, "sensor.orient.beta", betaVal, receivedAt);
                    void applyMapping(info.id, "sensor.orient.beta", betaVal);
                  }
                  if (typeof orient.gamma === "number") {
                    const gammaVal = (Math.max(-90, Math.min(90, orient.gamma)) + 90) / 180;
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

    srv.on("upgrade", (req, socket, head) => {
      const urlPath = req.url ? req.url.split("?")[0] : "";
      if (urlPath === "/ws") {
        wsServer.handleUpgrade(req, socket, head, (ws) => {
          wsServer.emit("connection", ws, req);
        });
      } else if (urlPath === "/admin/ws") {
        adminWsServer.handleUpgrade(req, socket, head, (ws) => {
          adminWsServer.emit("connection", ws, req);
        });
      } else {
        socket.destroy();
      }
    });

    srv.on("error", (err) => {
      console.error(`[ableton-rc-bridge] server error: ${err.message}`);
      serverInstance = null;
      actualPort = null;
      reject(err);
    });

    srv.listen(0, "0.0.0.0", () => {
      const addr = srv.address() as AddressInfo | null;
      if (!addr) {
        reject(new Error("server.address() returned null"));
        return;
      }
      actualPort = addr.port;
      serverInstance = srv;
      const ips = getLanAddresses();
      const proto = useHttps ? "https" : "http";
      console.log(
        `[ableton-rc-bridge] ${proto.toUpperCase()}+WS listening on ${proto}://0.0.0.0:${actualPort} (ws path: /ws, test page: /test)`,
      );
      for (const ip of ips) {
        console.log(`[ableton-rc-bridge]   LAN URL: ${proto}://${ip}:${actualPort}/`);
      }
      if (ips.length === 0) {
        console.warn(
          "[ableton-rc-bridge] no LAN interfaces found; phone cannot reach this host until it does",
        );
      }
      resolve();
    });
  });
}

// Stop the server and drop all WS clients. Idempotent.
async function stopServer(): Promise<void> {
  const srv = serverInstance;
  if (!srv) return;
  serverInstance = null;
  actualPort = null;
  // Close every tracked WS so phones/admins see the disconnect promptly.
  for (const c of [...trackedClients.values()]) {
    try { c.ws.close(1001, "server stopping"); } catch { /* ignore */ }
  }
  trackedClients.clear();
  adminSockets.clear();
  await new Promise<void>((resolve) => {
    srv.close(() => {
      console.log("[ableton-rc-bridge] server stopped");
      resolve();
    });
  });
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
  const { primary, others } = pickLanIps(getLanAddresses());
  const proto = useHttps ? "https" : "http";
  const wsProto = useHttps ? "wss" : "ws";
  const phoneUrl = isRunning && port !== null ? `${proto}://${primary}:${port}/` : null;
  const adminUrl = isRunning && port !== null ? `${proto}://${primary}:${port}/static/admin/` : null;
  const qrSrc = phoneUrl
    ? `https://api.qrserver.com/v1/create-qr-code/?size=160x160&data=${encodeURIComponent(phoneUrl)}`
    : "";
  const statusText = isRunning
    ? port !== null
      ? `Running on port ${port}`
      : "Running (binding...)"
    : "Stopped";
  const startBtn = !isRunning
    ? `<button class="btn primary" data-action="start">Start</button>`
    : "";
  const stopBtn = isRunning
    ? `<button class="btn" data-action="stop">Stop</button>`
    : "";
  const restartBtn = isRunning
    ? `<button class="btn" data-action="restart">Restart</button>`
    : "";
  const clients = [...trackedClients.values()].filter((c) => !c.isAdmin);
  const initialClientsJson = JSON.stringify(
    clients.map((c) => ({
      type: "client_update",
      client: {
        client_id: c.id,
        last_seen: c.lastSeen,
        user_agent: c.userAgent,
        status: Date.now() - c.lastSeen < CLIENT_STALE_MS ? "active" : "stale",
      },
      latest: c.lastData,
      history: c.history,
    }))
  );
  const clientListHtml =
    clients.length === 0
      ? `<li class="empty">No phones connected</li>`
      : clients
          .map((c) => {
            const ageSec =
              c.lastSeen > 0 ? Math.round((Date.now() - c.lastSeen) / 1000) : "?";
            const status = c.lastSeen > 0 && ageSec !== "?" && ageSec < 35 ? "active" : "stale";
            const ua = (c.userAgent || "?").slice(0, 36);
            return `<li class="client ${status}">
              <span class="dot"></span>
              <span class="cid">${c.id.slice(0, 8)}</span>
              <span class="ua">${ua}</span>
              <span class="age">${ageSec}s</span>
            </li>`;
          })
          .join("");
  const otherRows = others
    .map(
      (ip) =>
        `<li><code>${proto}://${ip}:${port}/</code></li>`,
    )
    .join("");
  const html = `<!DOCTYPE html>
<html><head><meta charset="utf-8"><style>
*,*::before,*::after{box-sizing:border-box}*{margin:0}
:root{--bg:hsl(0,0%,21%);--text:hsl(0,0%,71%);--text2:hsl(0,0%,41%);--ctrl:hsl(0,0%,16%);--border:hsl(0,0%,7%);--input:hsl(0,0%,12%);--accent:hsl(31,100%,67%);--fg:hsl(0,0%,7%);--ok:hsl(120,55%,55%)}
html{background:var(--bg);color:var(--text);font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;font-size:12px;height:100%}
body{padding:1em;height:100%;display:flex;flex-direction:column;gap:0.5em;overflow:auto}
h1{font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:0.5px;margin:0}
h2{font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:0.5px;color:var(--text2);margin:0.4em 0 0.2em}
.row{display:flex;align-items:center;gap:0.5em;flex-wrap:wrap}
.status{display:inline-flex;align-items:center;gap:0.5em;padding:0.3em 0.6em;background:var(--input);border-radius:4px;font-family:monospace}
.dot{width:8px;height:8px;border-radius:50%;background:${isRunning ? "var(--ok)" : "var(--text2)"};flex-shrink:0}
.qr{background:white;padding:6px;border-radius:4px;display:flex;flex-direction:column;align-items:center;gap:2px;flex-shrink:0}
.qr img{display:block;width:140px;height:140px}
.qr-label{color:var(--text2);font-size:9px;text-transform:uppercase}
.url{display:inline-block;color:var(--accent);text-decoration:none;font-family:monospace;font-size:11.5px;padding:2px 4px;border-radius:2px;word-break:break-all}
.url:hover{background:var(--input);text-decoration:underline}
.copy{background:var(--ctrl);color:var(--text);border:1px solid var(--border);height:20px;padding:0 0.6em;border-radius:0.7em;cursor:pointer;font-size:10px;flex-shrink:0}
.copy:active{background:var(--accent);color:var(--fg)}
.copy.copied{background:var(--accent);color:var(--fg)}
.clients{list-style:none;padding:0;margin:0;max-height:120px;overflow-y:auto}
.clients li{display:flex;align-items:center;gap:0.4em;padding:0.15em 0;font-family:monospace;font-size:11px}
.clients .empty{color:var(--text2);font-style:italic}
.clients .dot{width:6px;height:6px}
.clients .stale .dot{background:var(--text2)}
.clients .cid{color:var(--text)}
.clients .ua{color:var(--text2);flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.clients .age{color:var(--text2);font-size:10px}
.section{background:var(--input);padding:0.5em 0.7em;border-radius:4px}
.actions{display:flex;gap:0.4em;justify-content:flex-end;margin-top:auto;flex-wrap:wrap}
.btn{font-size:0.95rem;background:var(--ctrl);color:var(--text);border:1px solid var(--border);height:24px;padding:0 1.1em;border-radius:1em;cursor:pointer;user-select:none}
.btn:active{background:var(--accent);color:var(--fg)}
.btn.primary{background:var(--accent);color:var(--fg);border-color:var(--accent)}
</style></head>
<body>
<h1>RC Bridge &mdash; Panel</h1>
<div class="section">
  <h2>Server</h2>
  <div class="row">
    <span class="status"><span class="dot"></span><span>${statusText}</span></span>
  </div>
  ${phoneUrl ? `<div class="row" style="margin-top:0.4em">
    <div class="qr"><img src="${qrSrc}" alt="QR"><span class="qr-label">Phone QR</span></div>
    <div style="flex:1;min-width:0">
      <div class="row"><a class="url" href="${phoneUrl}" target="_blank">${phoneUrl}</a><button class="copy" data-url="${phoneUrl}">Copy</button></div>
      <div class="row" style="margin-top:0.3em"><a class="url" href="${adminUrl}" target="_blank">${adminUrl}</a><button class="copy" data-url="${adminUrl}">Copy</button></div>
    </div>
  </div>` : `<p style="color:var(--text2);font-size:11px;margin:0.4em 0 0">Start the server to get a QR code and LAN URLs.</p>`}
</div>
<div class="section">
  <h2>Connected phones (<span id="client-count">${clients.length}</span>)</h2>
  <ul id="clients-list" class="clients">${clientListHtml}</ul>
</div>
${others.length > 0 && port !== null ? `<div class="section"><h2>Other interfaces</h2><ul class="clients">${otherRows}</ul></div>` : ""}
<div class="section">
  <h2>Mappings (<span id="mapping-count">${controlMappings.size}</span>)</h2>
  <p style="color:var(--text2);font-size:11px;margin:0.2em 0">${controlMappings.size > 0 ? Array.from(controlMappings.entries()).map(([k,v]) => `${k} → [${v.map(x => x.label || x.type).join(', ')}]`).join(', ') : 'No mappings configured'}</p>
</div>
<div class="actions">
  ${startBtn}
  ${stopBtn}
  ${restartBtn}
  <button class="btn primary" data-action="mappings">Mappings</button>
  <button class="btn" data-action="refresh">Refresh</button>
  <button class="btn" data-action="close">Close</button>
</div>
<script>
function send(v){const m={method:"close_and_send",params:[v]};if(window.webkit?.messageHandlers?.live)window.webkit.messageHandlers.live.postMessage(m);else if(window.chrome?.webview)window.chrome.webview.postMessage(m);}
function copy(text, btn){
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(text).then(() => { btn.textContent = 'Copied!'; btn.classList.add('copied'); setTimeout(() => { btn.textContent = 'Copy'; btn.classList.remove('copied'); }, 1200); }).catch(() => fallback(text, btn));
  } else { fallback(text, btn); }
}
function fallback(text, btn){
  const ta = document.createElement('textarea');
  ta.value = text; ta.style.position='fixed'; ta.style.opacity='0';
  document.body.appendChild(ta); ta.select();
  try { document.execCommand('copy'); btn.textContent = 'Copied!'; btn.classList.add('copied'); setTimeout(() => { btn.textContent = 'Copy'; btn.classList.remove('copied'); }, 1200); } catch {}
  document.body.removeChild(ta);
}
document.querySelectorAll('button[data-action]').forEach(b => {
  b.addEventListener('click', () => send(b.dataset.action));
});
document.querySelectorAll('button.copy').forEach(b => {
  b.addEventListener('click', () => copy(b.dataset.url, b));
});

// Real-time client updates
const port = ${port};
const initialClients = ${initialClientsJson};
const clientsMap = new Map(initialClients.map(c => [c.client.client_id, c]));

function updateClientsUI() {
  const listEl = document.getElementById('clients-list');
  const countEl = document.getElementById('client-count');
  if (!listEl) return;
  
  const clients = Array.from(clientsMap.values());
  const activeClients = clients.filter(c => c.client && c.client.status !== 'stale');
  
  if (countEl) countEl.textContent = activeClients.length;
  
  if (activeClients.length === 0) {
    listEl.innerHTML = '<li class="empty">No phones connected</li>';
    return;
  }
  
  listEl.innerHTML = activeClients.map(c => {
    const ageSec = c.client.last_seen > 0 ? Math.round((Date.now() - c.client.last_seen) / 1000) : "?";
    const status = c.client.status || "active";
    const ua = (c.client.user_agent || "?").slice(0, 36);
    return '<li class="client ' + status + '">' +
      '<span class="dot"></span>' +
      '<span class="cid">' + c.client.client_id.slice(0, 8) + '</span>' +
      '<span class="ua">' + ua + '</span>' +
      '<span class="age">' + ageSec + 's</span>' +
    '</li>';
  }).join("");
}

function connectWS() {
  if (!port) return;
  const wsUrl = "${wsProto}://127.0.0.1:" + port + "/admin/ws";
  const ws = new WebSocket(wsUrl);
  ws.onmessage = (e) => {
    try {
      const msg = JSON.parse(e.data);
      if (msg.type === 'client_update') {
        if (msg.client && msg.client.client_id) {
          if (msg.client.status === 'stale') {
            clientsMap.delete(msg.client.client_id);
          } else {
            clientsMap.set(msg.client.client_id, msg);
          }
          updateClientsUI();
        }
      }
    } catch(err) {}
  };
  ws.onclose = () => {
    setTimeout(connectWS, 2000);
  };
  ws.onerror = () => {
    ws.close();
  };
}

if (port) {
  connectWS();
}

setInterval(updateClientsUI, 2000);
</script>
</body></html>`;
  return await context.ui.showModalDialog(`data:text/html,${encodeURIComponent(html)}`, 580, 680);
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

  console.log("[ableton-rc-bridge] activate() done; awaiting requests");
}

module.exports = { activate };
