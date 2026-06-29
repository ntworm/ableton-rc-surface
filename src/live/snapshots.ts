import { getExtensionContext } from "../context.js";
import { trackedClients, SERVER_MSG, safeReadMixer, TrackedClient } from "../server/ws.js";
import { clamp01, clampN11, isArrayLike } from "../util/helpers.js";

export interface MixTrackSnapshot {
  id: string;
  name: string;
  type: "regular" | "group" | "return" | "master";
  groupTrackId: string | null;
}

export interface MixStructureCache {
  version: number;
  tracks: MixTrackSnapshot[];
}

export interface MixSendSnapshot {
  id: string;
  name: string;
  level: number;
}

export interface MixParamSnapshot {
  id: string;
  name: string;
  value: number;
  min: number;
  max: number;
  defaultValue: number | null;
  isQuantized: boolean;
  valueItems: Array<{ name: string; shortName: string }>;
  kind: "continuous" | "enum" | "toggle" | "disabled";
  isReadOnly: boolean;
  deviceName?: string;
}

export interface MixDeviceSnapshot {
  id: string;
  name: string;
  parameters: MixParamSnapshot[];
}

export interface MixMixerCache {
  byTrackId: Map<string, { volume: number; pan: number; mute: boolean; solo: boolean; sends: MixSendSnapshot[] }>;
}

export const MIX_STRUCTURE_TICK_MS = 2000;
export const MIX_MIXER_TICK_MS = 200;
export const MIX_PARAMS_TICK_MS = 500;
export const MIX_MAX_PARAMS_PER_CLIENT = 256;

export let mixStructureCache: MixStructureCache | null = null;
export let mixStructureCacheAt = 0;
export let mixStructureVersion = 0;
export let mixMixerCache: MixMixerCache | null = null;
export let mixClientsActive = 0;
export let mixSnapshotLoopStarted = false;

let mixStructureInterval: NodeJS.Timeout | null = null;
let mixMixerInterval: NodeJS.Timeout | null = null;
let mixParamsInterval: NodeJS.Timeout | null = null;

export function clearMixStructureCache() {
  mixStructureCache = null;
  mixStructureVersion += 1;
}

export function trackMixClientConnected(): void {
  mixClientsActive += 1;
}

export function trackMixClientDisconnected(): void {
  mixClientsActive = Math.max(0, mixClientsActive - 1);
}

export function mixClientsPresent(): boolean {
  return mixClientsActive > 0;
}

function trackIdFor(type: "regular" | "group" | "return" | "master", index: number): string {
  if (type === "master") return "mix:main";
  if (type === "return") return `mix:return:${index}`;
  return `mix:track:${index}`;
}

async function readTrackVolume(mixer: Record<string, any> | null): Promise<{ value: number; ok: boolean }> {
  if (!mixer) return { value: 0, ok: false };
  const v = mixer.volume;
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

async function readTrackPan(mixer: Record<string, any> | null): Promise<{ value: number; ok: boolean }> {
  if (!mixer) return { value: 0, ok: false };
  const p = mixer.panning;
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

async function readTrackSends(track: any, trackId: string): Promise<MixSendSnapshot[]> {
  const mixer = safeReadMixer(track);
  if (!mixer) return [];
  const sends = mixer.sends;
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
      } catch {}
    }
  }
  return out;
}

export function pickParamKind(
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

export async function readAllRegularTracks(): Promise<Array<{ track: any; index: number }>> {
  const extensionContext = getExtensionContext();
  if (!extensionContext) return [];
  const song = extensionContext.application.song;
  if (!song) return [];
  const tracks = song.tracks;
  if (!isArrayLike(tracks)) return [];
  const out: Array<{ track: any; index: number }> = [];
  for (let i = 0; i < tracks.length; i++) {
    const t = tracks[i];
    if (!t) continue;
    out.push({ track: t, index: i });
  }
  return out;
}

export async function readReturnTracks(): Promise<Array<{ track: any; index: number }>> {
  const extensionContext = getExtensionContext();
  if (!extensionContext) return [];
  const song = extensionContext.application.song;
  if (!song) return [];
  const rs = song.returnTracks;
  if (!isArrayLike(rs)) return [];
  const out: Array<{ track: any; index: number }> = [];
  for (let i = 0; i < rs.length; i++) {
    const t = rs[i];
    if (!t) continue;
    out.push({ track: t, index: i });
  }
  return out;
}

export async function readMainTrack(): Promise<any | null> {
  const extensionContext = getExtensionContext();
  if (!extensionContext) return null;
  const song = extensionContext.application.song;
  if (!song) return null;
  return (song as any).masterTrack ?? song.mainTrack ?? null;
}

export async function mixStructureTick(): Promise<void> {
  if (!mixClientsPresent()) return;
  const regulars = await readAllRegularTracks();
  const returns = await readReturnTracks();
  const main = await readMainTrack();

  const groupIndices = new Set<number>();
  for (const { track, index } of regulars) {
    if (track && track.isGroupTrack === true) {
      groupIndices.add(index);
    }
  }

  const tracks: MixTrackSnapshot[] = [];
  for (const { track, index } of regulars) {
    const name = typeof track.name === "string" ? track.name : `Track ${index + 1}`;
    const type: "regular" | "group" = groupIndices.has(index) ? "group" : "regular";
    tracks.push({ id: trackIdFor(type, index), name, type, groupTrackId: null });
  }
  for (let i = 0; i < returns.length; i++) {
    const r = returns[i];
    if (!r) continue;
    const name = typeof r.track.name === "string" ? r.track.name : `Return ${i + 1}`;
    tracks.push({ id: trackIdFor("return", i), name, type: "return", groupTrackId: null });
  }
  if (main) {
    const name = typeof main.name === "string" ? main.name : "Master";
    tracks.push({ id: trackIdFor("master", 0), name, type: "master", groupTrackId: null });
  }

  for (let i = 0; i < regulars.length; i++) {
    const entry = regulars[i];
    if (!entry) continue;
    const t = entry.track;
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

export async function mixMixerTick(): Promise<void> {
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
      const mixer = safeReadMixer(entry.track);
      const [volRes, panRes, sends] = await Promise.all([
        readTrackVolume(mixer),
        readTrackPan(mixer),
        readTrackSends(entry.track, id),
      ]);
      const t = entry.track;
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
        readTrackVolume(safeReadMixer(r.track)),
        readTrackPan(safeReadMixer(r.track)),
        readTrackSends(r.track, id),
      ]);
      const t = r.track;
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
        readTrackVolume(safeReadMixer(main)),
        readTrackPan(safeReadMixer(main)),
        readTrackSends(main, id),
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

export function mixClientSnapshotKey(snapshot: unknown): string {
  try {
    return JSON.stringify(snapshot);
  } catch {
    return "";
  }
}

async function readSelectedParams(
  track: any,
  trackId: string,
  paramBudget: number,
): Promise<MixParamSnapshot[]> {
  if (!track || typeof track !== "object") return [];
  const devices = track.devices;
  if (!Array.isArray(devices) || devices.length === 0) return [];

  type Ref = { di: number; p: any; pi: number };
  const refs: Ref[] = [];
  for (let di = 0; di < devices.length; di++) {
    const d = devices[di];
    if (!d || typeof d !== "object") continue;
    const params = d.parameters;
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
    const min = typeof p.min === "number" ? p.min : 0;
    const max = typeof p.max === "number" ? p.max : 1;
    let wire = 0;
    if (typeof p.getValue === "function") {
      try {
        const raw = await p.getValue();
        if (Number.isFinite(raw as number) && max > min) {
          wire = clamp01(((raw as number) - min) / (max - min));
        }
      } catch {}
    }
    const name = typeof p.name === "string" ? p.name : `Param ${pi + 1}`;
    const isQuantized = p.isQuantized === true;
    const valueItems = Array.isArray(p.valueItems)
      ? p.valueItems.map((vi: any) => ({
          name: typeof vi.name === "string" ? vi.name : "",
          shortName: typeof vi.shortName === "string" ? vi.shortName : "",
        }))
      : [];
    const defaultValue = typeof p.defaultValue === "number" ? p.defaultValue : null;
    const isReadOnly = typeof p.setValue !== "function";
    const deviceId = `${trackId}:dev:${di}`;
    const deviceName = typeof d.name === "string" ? d.name : `Device ${di + 1}`;
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

async function mixParamsTick(): Promise<void> {
  if (!mixClientsPresent()) return;
  const clients = Array.from(trackedClients.values()).filter((c) => c.mode === "mix" && c.mixSelection);
  if (clients.length === 0) return;

  for (const c of clients) {
    if (!c.mixSelection) continue;
    const trackId = c.mixSelection.trackId;
    if (!trackId) continue;

    let trackObj: any = null;
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

    const parameters = await readSelectedParams(trackObj, trackId, MIX_MAX_PARAMS_PER_CLIENT);

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
      } catch {}
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

export function mixBroadcastStructure(): void {
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
      } catch {}
    }
  }
  if (sent > 0) {
    console.log(`[ableton-rc-bridge] mix: broadcast structure v${mixStructureCache.version} to ${sent} client(s) (${mixStructureCache.tracks.length} tracks)`);
  }
}

export function mixBroadcastMixer(): void {
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
      } catch {}
    }
  }
  if (sent > 0) {
    console.log(`[ableton-rc-bridge] mix: broadcast mixer to ${sent} client(s) (${mixStructureCache.tracks.length} tracks)`);
  }
}

export function startMixSnapshotLoop(): void {
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

export function stopMixSnapshotLoop(): void {
  if (mixStructureInterval) { clearInterval(mixStructureInterval); mixStructureInterval = null; }
  if (mixMixerInterval)     { clearInterval(mixMixerInterval);     mixMixerInterval = null; }
  if (mixParamsInterval)    { clearInterval(mixParamsInterval);    mixParamsInterval = null; }
  mixSnapshotLoopStarted = false;
  mixStructureCache = null;
  mixMixerCache = null;
  mixClientsActive = 0;
}
