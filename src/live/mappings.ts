import * as fs from "node:fs/promises";
import * as path from "node:path";
import { getExtensionContext, requireCtx, requireTrack } from "../context.js";
import { trackedClients, appendHistory } from "../server/ws.js";
import { getScaleLabel, playheadActive, playheadStartTime, playheadBaseTimeMs, setPlayheadActive, setPlayheadStartTime, setPlayheadBaseTimeMs, broadcastPlayheadState } from "./state.js";
import { pickLanIps, getLanAddresses, showInfoDialog } from "../util/helpers.js";

export interface MappingTarget {
  type: 'device_param' | 'mixer_volume' | 'mixer_pan' | 'mixer_send'
      | 'tempo' | 'track_mute' | 'track_solo' | 'track_arm';
  trackIndex?: number;
  deviceIndex?: number;
  paramIndex?: number;
  sendIndex?: number;
  label?: string;
  outMin?: number;
  outMax?: number;
  smooth?: number;
  smoothBpmSync?: boolean;
  smoothBpmSubdivision?: number;
  curve?: 'linear' | 'exponential' | 'logarithmic' | 's-curve';
  inMin?: number;
  inMax?: number;
}

export const controlMappings = new Map<string, MappingTarget[]>();
export const lastMappedValues = new Map<string, number>();

export interface SmoothState {
  current: number;
  target: number;
  smoothFactor: number;
  apply: (val: number) => Promise<void>;
  lastTime: number;
}

export const activeSmooths = new Map<string, SmoothState>();

let smoothInterval: NodeJS.Timeout | null = null;

export let mappingsFilePath: string | null = null;
export let presetsDirPath: string | null = null;
export let currentPresetName: string = "Default";

export function setMappingsFilePath(p: string | null) { mappingsFilePath = p; }
export function setPresetsDirPath(p: string | null) { presetsDirPath = p; }

export function getTargetKey(target: MappingTarget): string {
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

export function startSmoothTimer(): void {
  if (smoothInterval) return;
  smoothInterval = setInterval(async () => {
    if (activeSmooths.size === 0) {
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
  }, 20);
}

export async function loadMappings(): Promise<void> {
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

export async function saveMappings(): Promise<void> {
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

export function applyCurve(value: number, curve?: string): number {
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

export function applyCurveInverse(value: number, curve?: string): number {
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

export async function applyMapping(clientId: string, controlName: string, value: number): Promise<void> {
  let targets = controlMappings.get(`${clientId}::${controlName}`);
  if (!targets || targets.length === 0) {
    targets = controlMappings.get(controlName);
  }
  if (!targets || targets.length === 0) return;
  
  try {
    const extensionContext = getExtensionContext();
    if (!extensionContext) return;
    const song = extensionContext.application.song;
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
        const T = beatDurationMs * subdivision;
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
              const mixer = t.mixer as any;
              const scaled = mixer.volume.min + scaledVal * (mixer.volume.max - mixer.volume.min);
              await mixer.volume.setValue(scaled);
            }
            break;
          }
          case 'mixer_pan': {
            const t = song.tracks[target.trackIndex ?? 0];
            if (t && "mixer" in t) {
              const mixer = t.mixer as any;
              const scaled = mixer.panning.min + scaledVal * (mixer.panning.max - mixer.panning.min);
              await mixer.panning.setValue(scaled);
            }
            break;
          }
          case 'mixer_send': {
            const t = song.tracks[target.trackIndex ?? 0];
            if (t && "mixer" in t) {
              const mixer = t.mixer as any;
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
          activeApplyLocks.add(key);
          setTimeout(() => activeApplyLocks.delete(key), 5);
        }
      }
    }));
  } catch (err) {
    console.error(`[ableton-rc-bridge] applyMapping(${controlName}) error: ${err instanceof Error ? err.message : String(err)}`);
  }
}

export async function getControlValues(clientId: string): Promise<Record<string, number>> {
  const result: Record<string, number> = {};
  const extensionContext = getExtensionContext();
  if (!extensionContext) return result;
  const song = extensionContext.application.song;
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
    const target = targets[0];
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

export type CommandSpec = {
  description: string;
  handler: (args: Record<string, any>) => Promise<any>;
};

export const commands: Record<string, CommandSpec> = {
  getServerInfo: {
    description: "Get server state, LAN URLs, cert info, etc.",
    handler: async () => {
      const serverState = await import("../server/state.js");
      const isRunning = serverState.serverInstance !== null;
      const port = serverState.actualPort;
      const httpsPort = serverState.actualHttpsPort;
      const { primary, others } = pickLanIps(getLanAddresses());
      const phoneProto = "http";
      const phonePort = port;
      const adminProto = serverState.useHttps && httpsPort ? "https" : "http";
      const adminPort = serverState.useHttps && httpsPort ? httpsPort : port;
      const phoneUrl = isRunning && port !== null ? `${phoneProto}://${primary}:${phonePort}/` : null;
      const mixUrl = isRunning && port !== null ? `${phoneProto}://${primary}:${phonePort}/mix/` : null;
      const adminUrl = isRunning && port !== null ? `${adminProto}://127.0.0.1:${adminPort}/static/admin/` : null;
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
        useHttps: serverState.useHttps,
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
      const { CLIENT_STALE_MS } = await import("../server/ws.js");
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
          setPlayheadStartTime(now);
          setPlayheadActive(true);
        } else if (!active && playheadActive) {
          setPlayheadBaseTimeMs(timeMs ?? (playheadBaseTimeMs + (now - playheadStartTime)));
          setPlayheadActive(false);
        }

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
          setPlayheadStartTime(now);
          setPlayheadBaseTimeMs(timeMs);
        } else {
          setPlayheadBaseTimeMs(timeMs);
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
      const volParam = (mixer as any).volume;
      await volParam.setValue(volume);
      return { index: args["index"], volume };
    },
  },

  getDeviceParams: {
    description: "List parameters of a device. Args: {trackIndex: number, deviceIndex: number}.",
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
    description: "Set a device parameter value. Args: {trackIndex, deviceIndex, paramIndex, value}.",
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
      targets.push({ id: 'tempo', type: 'tempo', label: `Song Tempo (${song.tempo.toFixed(1)} BPM)` });
      for (let ti = 0; ti < song.tracks.length; ti++) {
        const track = song.tracks[ti];
        if (!track) continue;
        const tName = track.name || `Track ${ti + 1}`;
        const trackTargets: any[] = [];
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
