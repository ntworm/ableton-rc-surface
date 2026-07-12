// Copyright © 2026 Gabriel Worm
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Source: https://github.com/ntworm/ableton-rc-surface
//
// This file is part of Ableton RC Surface, distributed under the
// PolyForm Noncommercial License 1.0.0. You may obtain a copy of
// the License at https://polyformproject.org/licenses/noncommercial/1.0.0
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { getExtensionContext, requireCtx, requireTrack } from "../context.js";
import { trackedClients, appendHistory, pushClientUpdate } from "../server/ws.js";
import { getScaleLabel, playheadActive, playheadStartTime, playheadBaseTimeMs, setPlayheadActive, setPlayheadStartTime, setPlayheadBaseTimeMs, broadcastPlayheadState } from "./state.js";
import { pickLanIps, getLanAddresses, stripWslDrivePrefix, sanitizeFilenameComponent } from "../util/helpers.js";
import { sendMidiNote, noteNameToMidiNumber } from "./udp-midi.js";
import { oscTransport } from "./osc-transport.js";
import { computeSyncedLfoValue, computeSyncedStutterValue } from "./transport-clock.js";

export interface MappingTarget {
  type: 'device_param' | 'mixer_volume' | 'mixer_pan' | 'mixer_send'
      | 'tempo' | 'track_mute' | 'track_solo' | 'track_arm';
  trackIndex?: number;
  trackKind?: 'track' | 'return' | 'main';
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
  drive?: number;
  compressor?: number;
  mode?: 'continuous' | 'toggle' | 'trigger_note';
  threshold?: number;
  midiNote?: string;
  midiVelocity?: number;
  idleValue?: number;
}

export const controlMappings = new Map<string, MappingTarget[]>();
export const lastMappedValues = new Map<string, number>();
export const eventModesState = new Map<string, { lastInput: number; active: boolean }>();

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

/**
 * Wire the mapping/preset paths into the Live-provided storage directory.
 * Safe to call with a null/undefined storageDir (warnings + no-op).
 *
 * Ableton passes Windows-style paths like `/C:/Users/...`; the leading
 * slash before the drive letter is stripped so `path.join` produces a
 * portable absolute path. Creates the presets directory; the mappings
 * file itself is created lazily by saveMappings().
 */
export async function configureMappingStorage(
  storageDir: string | null | undefined,
): Promise<void> {
  if (!storageDir) {
    console.warn("[ableton-rc-surface] storageDirectory not available, mappings will not persist");
    return;
  }
  const cleanStorageDir = stripWslDrivePrefix(storageDir);
  setMappingsFilePath(path.join(cleanStorageDir, "mappings.json"));
  const presets = path.join(cleanStorageDir, "presets");
  setPresetsDirPath(presets);
  try {
    await fs.mkdir(presets, { recursive: true });
  } catch {
    // non-fatal: log later when saveMappings actually writes
  }
}

export function getTargetKey(target: MappingTarget): string {
  const kindPart = target.trackKind && target.trackKind !== 'track' ? `::${target.trackKind}` : '';
  switch (target.type) {
    case 'tempo':
      return 'tempo';
    case 'mixer_send':
      return `mixer_send${kindPart}::${target.trackIndex ?? 0}::${target.sendIndex ?? 0}`;
    case 'device_param':
      if (target.mode === 'trigger_note') {
        // trigger_note has its own identity: track + midiNote.
        // Including the note prevents two pads that target different notes on
        // the same MIDI track from sharing a key, and prevents a collision with
        // a genuine device_param on device 0, param 0 of the same track.
        return `trigger_note${kindPart}::${target.trackIndex ?? 0}::${target.midiNote ?? 'C3'}`;
      }
      return `device_param${kindPart}::${target.trackIndex ?? 0}::${target.deviceIndex ?? 0}::${target.paramIndex ?? 0}`;
    default:
      return `${target.type}${kindPart}::${target.trackIndex ?? 0}`;
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

/**
 * Stop the global smooth-timer interval. Idempotent: calling on an already
 * stopped timer is a no-op (does not throw, does not reset state).
 */
export function stopSmoothTimer(): void {
  if (smoothInterval === null) return;
  clearInterval(smoothInterval);
  smoothInterval = null;
}

/**
 * Report whether the global smooth-timer interval is currently scheduled.
 * Self-shutoff: returns false while no smooth mapping is active.
 */
export function isSmoothTimerRunning(): boolean {
  return smoothInterval !== null;
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
    console.log(`[ableton-rc-surface] loaded ${controlMappings.size} mappings from ${mappingsFilePath}`);
  } catch {
    console.log("[ableton-rc-surface] no mappings file found, starting fresh");
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
    console.error(`[ableton-rc-surface] failed to save mappings: ${err instanceof Error ? err.message : String(err)}`);
  }
}

const activeApplyLocks = new Set<string>();
const pendingMappedApplies = new Map<string, {
  value: number;
  apply: (val: number) => Promise<void>;
}>();

export type HostModulatorKind = "lfo" | "stutter";
export type HostModulatorSyncMode = "sync" | "free";

interface HostModulatorMorph {
  startTime: number;
  endTime: number;
  startRate: number;
  targetRate: number;
  startDepth: number;
  targetDepth: number;
  startCount: number;
  targetCount: number;
  deactivateAtEnd: boolean;
}

export interface HostModulatorState {
  clientId: string;
  name: string;
  kind: HostModulatorKind;
  active: boolean;
  rate: number;
  depth: number;
  count: number;
  syncMode: HostModulatorSyncMode;
  clockSource?: "osc" | "sdk" | "free";
  phase: number;
  // Anchor for free-mode phase calculation. Set on first tick after the
  // state is created so the host can derive phase as
  // `(now - phaseZeroMs) * freq * 2π + phase`. Avoids integrator drift
  // when a tick is dropped or delayed.
  phaseZeroMs?: number;
  lastTime: number | null;
  morph?: HostModulatorMorph;
  syncSubdivisionBeats?: number;
  phaseOffsetBeats?: number;
  swing?: number;
  shape?: "sine" | "triangle" | "ramp_up" | "ramp_down" | "square";
}

export const hostModulators = new Map<string, HostModulatorState>();

let hostModulatorInterval: NodeJS.Timeout | null = null;
// Tick fast enough to resolve the maximum LFO frequency the phone can
// request (20 Hz free / 20 Hz synced) with at least 12 samples per
// cycle so the visual / audible step is below the perceptual threshold.
// 20 Hz × 12 = 240 Hz tick → 4 ms. The old 20 ms (50 Hz) tick only
// gave ~2.5 samples per cycle at 20 Hz, which aliased badly (jitter).
const HOST_MODULATOR_INTERVAL_MS = 4;

function clamp01(value: unknown, fallback = 0): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.max(0, Math.min(1, value))
    : fallback;
}

function clampMorphMs(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.max(0, Math.min(30_000, value))
    : 0;
}

function applyHostModulatorMorph(state: HostModulatorState, now: number): boolean {
  const morph = state.morph;
  if (!morph) return true;

  const duration = Math.max(1, morph.endTime - morph.startTime);
  const progress = Math.max(0, Math.min(1, (now - morph.startTime) / duration));
  state.rate = morph.startRate + (morph.targetRate - morph.startRate) * progress;
  state.depth = morph.startDepth + (morph.targetDepth - morph.startDepth) * progress;
  state.count = morph.startCount + (morph.targetCount - morph.startCount) * progress;

  if (progress < 1) return true;

  state.rate = morph.targetRate;
  state.depth = morph.targetDepth;
  state.count = morph.targetCount;
  delete state.morph;

  if (!morph.deactivateAtEnd) return true;
  state.active = false;
  return false;
}

function hostModulatorKey(clientId: string, name: string): string {
  return `${clientId}::${name}`;
}

function isHostModulatorName(kind: HostModulatorKind, name: string): boolean {
  if (kind === "lfo") return /^toggle-\d+$/.test(name);
  return /^button-\d+$/.test(name);
}

export function startHostModulatorLoop(): void {
  if (hostModulatorInterval !== null) return;
  hostModulatorInterval = setInterval(() => {
    void tickHostModulators(Date.now());
  }, HOST_MODULATOR_INTERVAL_MS);
}

export function stopHostModulatorLoop(): void {
  if (hostModulatorInterval === null) return;
  clearInterval(hostModulatorInterval);
  hostModulatorInterval = null;
}

export function isHostModulatorLoopRunning(): boolean {
  return hostModulatorInterval !== null;
}

function maybeStopHostModulatorLoop(): void {
  if (hostModulators.size === 0) stopHostModulatorLoop();
}

function getHostModulatorFrequencyHz(state: HostModulatorState, tempo: number): number {
  if (state.kind === "lfo") {
    if (state.syncMode === "sync") {
      const subdivisions = [4, 2, 1, 0.5, 0.25, 0.125, 0.0625];
      const subdiv = subdivisions[Math.floor(state.rate * (subdivisions.length - 0.01))] ?? 1;
      return Math.min(20, (tempo / 60) / subdiv);
    }
    return 0.1 + state.rate * 19.9;
  }

  let baseFreqHz: number;
  if (state.syncMode === "sync") {
    const subdivisions = [1, 0.5, 0.25, 0.125, 0.0625, 0.03125];
    const subdiv = subdivisions[Math.floor(state.rate * (subdivisions.length - 0.01))] ?? 1;
    baseFreqHz = (tempo / 60) / subdiv;
  } else {
    baseFreqHz = 1 + state.rate * 19;
  }
  const ratchetLevels = [1, 2, 3, 4];
  const ratchet = ratchetLevels[Math.floor(state.count * (ratchetLevels.length - 0.01))] ?? 1;
  return Math.min(15, baseFreqHz * ratchet);
}

async function applyHostGeneratedControl(
  clientId: string,
  name: string,
  value: number,
  timestamp: number,
  isDeactivated?: boolean,
): Promise<void> {
  const client = trackedClients.get(clientId);
  if (client) {
    appendHistory(client, name, value, timestamp);
    const lastData = client.lastData && typeof client.lastData === "object"
      ? client.lastData
      : { controls: [] };
    const controls = Array.isArray(lastData["controls"]) ? lastData["controls"] as any[] : [];
    const existing = controls.find((ctrl) => ctrl && ctrl.name === name);
    if (existing) {
      existing.value = value;
    } else {
      controls.push({ name, value });
    }
    lastData["controls"] = controls;
    client.lastData = lastData;
  }
  await applyMapping(clientId, name, value, isDeactivated);
  if (client) pushClientUpdate(client);
}

export function updateHostModulator(clientId: string, payload: Record<string, any>): void {
  if (!clientId || !payload || typeof payload !== "object") return;
  const kind = payload["kind"];
  const name = payload["name"];
  if ((kind !== "lfo" && kind !== "stutter") || typeof name !== "string") return;
  if (!isHostModulatorName(kind, name)) return;

  const key = hostModulatorKey(clientId, name);
  const active = !!payload["active"];
  const existing = hostModulators.get(key);
  const morphMs = clampMorphMs(payload["morphMs"]);
  const morphStart = existing?.lastTime ?? Date.now();
  if (existing) applyHostModulatorMorph(existing, morphStart);

  const targetRate = clamp01(payload["rate"], existing?.rate ?? (kind === "lfo" ? 0.5 : 0.1));
  const targetDepth = clamp01(payload["depth"], existing?.depth ?? 0.5);
  const targetCount = clamp01(payload["count"], existing?.count ?? 0);
  const syncMode = payload["syncMode"] === "free" ? "free" : "sync";

  if (!active) {
    if (existing && morphMs > 0) {
      existing.syncMode = syncMode;
      existing.morph = {
        startTime: morphStart,
        endTime: morphStart + morphMs,
        startRate: existing.rate,
        targetRate,
        startDepth: existing.depth,
        targetDepth,
        startCount: existing.count,
        targetCount,
        deactivateAtEnd: true,
      };
      startHostModulatorLoop();
      return;
    }
    hostModulators.delete(key);
    void applyHostGeneratedControl(clientId, name, 0, Date.now(), true);
    maybeStopHostModulatorLoop();
    return;
  }

  const state: HostModulatorState = existing ?? {
    clientId,
    name,
    kind,
    active: true,
    rate: targetRate,
    depth: targetDepth,
    count: targetCount,
    syncMode,
    // Initial phase offset. LFO defaults to -π/2 (so cos-style starts
    // at the bottom of the wave; the host adds +π/2 inside the
    // tick). Stutter defaults to 0 (gate open on the first tick). The
    // sync-mode path overwrites this from the beat clock on every
    // tick, so the initial value is only relevant in free mode.
    phase: kind === "lfo" ? -Math.PI / 2 : 0,
    lastTime: null,
  };
  state.active = true;
  state.syncMode = syncMode;

  const allowedSubdivisions = new Set([4, 2, 1, 0.5, 0.25, 0.125, 0.0625, 0.03125]);
  if (payload["syncSubdivisionBeats"] !== undefined) {
    const val = Number(payload["syncSubdivisionBeats"]);
    if (allowedSubdivisions.has(val)) {
      state.syncSubdivisionBeats = val;
    }
  }
  if (payload["phaseOffsetBeats"] !== undefined) {
    const val = Number(payload["phaseOffsetBeats"]);
    if (Number.isFinite(val)) {
      state.phaseOffsetBeats = Math.max(-16, Math.min(16, val));
    }
  }
  if (payload["swing"] !== undefined) {
    const val = Number(payload["swing"]);
    if (Number.isFinite(val)) {
      state.swing = Math.max(0, Math.min(0.66, val));
    }
  }
  const allowedShapes = new Set(["sine", "triangle", "ramp_up", "ramp_down", "square"]);
  if (payload["shape"] !== undefined) {
    const val = String(payload["shape"]);
    if (allowedShapes.has(val)) {
      state.shape = val as any;
    }
  }

  if (payload["clockSource"] !== undefined) {
    const val = String(payload["clockSource"]);
    if (val === "osc" || val === "sdk" || val === "free") {
      state.clockSource = val;
    }
  }

  if (morphMs > 0) {
    state.morph = {
      startTime: morphStart,
      endTime: morphStart + morphMs,
      startRate: state.rate,
      targetRate,
      startDepth: state.depth,
      targetDepth,
      startCount: state.count,
      targetCount,
      deactivateAtEnd: false,
    };
  } else {
    state.rate = targetRate;
    state.depth = targetDepth;
    state.count = targetCount;
    delete state.morph;
  }

  hostModulators.set(key, state);
  startHostModulatorLoop();
}

export async function tickHostModulators(now: number = Date.now()): Promise<void> {
  if (hostModulators.size === 0) {
    maybeStopHostModulatorLoop();
    return;
  }

  const song = getExtensionContext()?.application.song;
  const tempo = typeof song?.tempo === "number" ? song.tempo : 120;
  const applies: Promise<void>[] = [];

  for (const [key, state] of hostModulators.entries()) {
    if (!applyHostModulatorMorph(state, now)) {
      hostModulators.delete(key);
      applies.push(applyHostGeneratedControl(state.clientId, state.name, 0, now, true));
      continue;
    }

    // Phase-as-function-of-time. Computing the phase from absolute `now`
    // (instead of accumulating `state.phase += freq*dt`) keeps the
    // signal beat-locked: if a tick is delayed or dropped, the next
    // tick reads the right phase for that instant. Accumulator-based
    // phase drifts whenever dt is wrong (variable setInterval firing,
    // GC pauses, event loop blocking).
    const dt = state.lastTime === null ? 0 : Math.max(0, now - state.lastTime) / 1000;
    state.lastTime = now;

    const source = state.clockSource || "osc";
    let beats = 0;
    let useSynced = false;

    if (state.syncMode === "sync") {
      if (source === "osc" && oscTransport.state.available && oscTransport.state.connected && oscTransport.state.isPlaying) {
        const elapsedMs = now - oscTransport.lastSongTimeUpdateAt;
        beats = oscTransport.state.currentSongTimeBeats + (elapsedMs / 1000) * (tempo / 60);
        useSynced = true;
      } else if (source === "sdk" && playheadActive) {
        const playheadTimeMs = playheadBaseTimeMs + (now - playheadStartTime);
        beats = (playheadTimeMs / 1000) * (tempo / 60);
        useSynced = true;
      }
    }

    if (useSynced) {
      if (state.kind === "lfo") {
        const shape = state.shape || "sine";
        const subdivisions = [4, 2, 1, 0.5, 0.25, 0.125, 0.0625];
        const subdiv = state.syncSubdivisionBeats ?? (subdivisions[Math.floor(state.rate * (subdivisions.length - 0.01))] ?? 1);
        const phaseOffset = state.phaseOffsetBeats ?? 0;

        const lfoVal = computeSyncedLfoValue(shape, beats, subdiv, phaseOffset);
        const value = 0.5 + lfoVal * 0.5 * state.depth;

        state.phase = ((beats + phaseOffset) / subdiv * 2 * Math.PI) % (2 * Math.PI);
        applies.push(applyHostGeneratedControl(state.clientId, state.name, value, now));
      } else {
        const subdivisions = [1, 0.5, 0.25, 0.125, 0.0625, 0.03125];
        const subdiv = state.syncSubdivisionBeats ?? (subdivisions[Math.floor(state.rate * (subdivisions.length - 0.01))] ?? 1);
        const phaseOffset = state.phaseOffsetBeats ?? 0;
        const swing = state.swing ?? 0;
        const ratchetLevels = [1, 2, 3, 4];
        const ratchet = ratchetLevels[Math.floor(state.count * (ratchetLevels.length - 0.01))] ?? 1;

        const isGateOpen = computeSyncedStutterValue(beats, subdiv, phaseOffset, swing, ratchet);
        const value = isGateOpen ? 1 : 0;

        state.phase = ((beats + phaseOffset) / (subdiv / ratchet) * 2 * Math.PI) % (2 * Math.PI);
        applies.push(applyHostGeneratedControl(state.clientId, state.name, value, now));
      }
    } else {
      // Free mode: derive phase from absolute time so jitter/drift is
      // bounded to the tick quantization, not the integrator error.
      const freqHz = getHostModulatorFrequencyHz(state, tempo);
      if (state.kind === "lfo") {
        // Phase zero is anchored at state.phaseZeroMs so user-initiated
        // bursts all start at a predictable point. The actual phase
        // value is read here on every tick from absolute time, not
        // accumulated, so a missed tick does not cause drift.
        if (state.phaseZeroMs === undefined) state.phaseZeroMs = now;
        const elapsedSec = (now - state.phaseZeroMs) / 1000;
        // `state.phase` is the initial offset (-π/2 by default for
        // LFO). With this offset the first tick yields phase = -π/2,
        // which computeSyncedLfoValue maps to sin(-π/2) = -1 → output
        // 0.5 - 0.5*depth. This matches the pre-refactor integrator
        // design's first-tick output, so the test suite and the user
        // see no visible behaviour change. Without the offset the
        // LFO would start at value 0.5 (sine at 0), which differs.
        const phaseRad = 2 * Math.PI * freqHz * elapsedSec + state.phase;
        const shape = state.shape || "sine";
        const normalizedPhase = ((phaseRad / (2 * Math.PI)) % 1 + 1) % 1;
        const lfoVal = computeSyncedLfoValue(shape, normalizedPhase, 1.0, 0.0);
        const value = 0.5 + lfoVal * 0.5 * state.depth;
        applies.push(applyHostGeneratedControl(state.clientId, state.name, value, now));
      } else {
        if (state.phaseZeroMs === undefined) state.phaseZeroMs = now;
        const elapsedSec = (now - state.phaseZeroMs) / 1000;
        const phaseRad = 2 * Math.PI * freqHz * elapsedSec + state.phase;
        // Stutter: phase < π → gate open, else closed. Same gate
        // condition as before but anchored to absolute time so the
        // pulse pattern does not shift when ticks are dropped.
        const normalizedPhase = ((phaseRad % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
        const value = normalizedPhase < Math.PI ? 1 : 0;
        applies.push(applyHostGeneratedControl(state.clientId, state.name, value, now));
      }
      // dt kept for backwards-compat / debug (not used for free phase).
      void dt;
    }
  }

  await Promise.all(applies);
  maybeStopHostModulatorLoop();
}

export function clearHostModulatorsForClient(clientId: string): void {
  for (const [key, state] of [...hostModulators.entries()]) {
    if (state.clientId !== clientId) continue;
    hostModulators.delete(key);
    void applyHostGeneratedControl(clientId, state.name, 0, Date.now());
  }
  maybeStopHostModulatorLoop();
}

async function applyMappedValue(
  key: string,
  value: number,
  apply: (val: number) => Promise<void>,
): Promise<void> {
  if (activeApplyLocks.has(key)) {
    pendingMappedApplies.set(key, { value, apply });
    return;
  }

  activeApplyLocks.add(key);
  let nextValue = value;
  let nextApply = apply;
  try {
    while (true) {
      activeSmooths.delete(key);
      lastMappedValues.set(key, nextValue);
      await nextApply(nextValue);

      const pending = pendingMappedApplies.get(key);
      if (!pending) break;
      pendingMappedApplies.delete(key);
      nextValue = pending.value;
      nextApply = pending.apply;
    }
  } finally {
    activeApplyLocks.delete(key);
  }
}

export function applyCurve(value: number, curve?: string, drive = 0, compressor = 0): number {
  if (!Number.isFinite(value)) return 0;
  let val = value;
  switch (curve) {
    case 'exponential':
      val = value * value;
      break;
    case 'logarithmic':
      val = Math.sqrt(Math.max(0, value));
      break;
    case 's-curve':
      val = 0.5 * (1 - Math.cos(value * Math.PI));
      break;
    case 'linear':
    default:
      val = value;
      break;
  }

  // Apply Drive (shift)
  if (drive !== 0) {
    val = Math.max(0, Math.min(1, val + drive));
  }

  // Apply Compressor (compand). Clamp compressor to [-0.99, 0.99] so
  // 1 + compressor can never hit 0 and the expansion exponent stays
  // numerically safe.
  if (compressor !== 0) {
    const safeCompressor = Math.max(-0.99, Math.min(0.99, compressor));
    if (safeCompressor < 0) {
      // Compression: blend towards 0.5
      val = val * (1 + safeCompressor) + 0.5 * (-safeCompressor);
    } else {
      // Expansion: push away from 0.5
      const diff = val - 0.5;
      const sign = diff >= 0 ? 1 : -1;
      const normDiff = Math.abs(diff) * 2;
      const exponent = 1 - safeCompressor * 0.8;
      const expanded = normDiff === 0 ? 0 : Math.pow(normDiff, exponent);
      val = 0.5 + sign * 0.5 * expanded;
    }
  }

  return val;
}

export function applyCurveInverse(value: number, curve?: string, drive = 0, compressor = 0): number {
  if (!Number.isFinite(value)) return 0;
  let val = Math.max(0, Math.min(1, value));

  // Invert Compressor (compand). Clamp compressor so the inverse math
  // stays numerically safe (1 + compressor cannot hit 0; exponent cannot
  // be zero or negative for the power to remain defined).
  if (compressor !== 0) {
    const safeCompressor = Math.max(-0.99, Math.min(0.99, compressor));
    if (safeCompressor < 0) {
      const denom = 1 + safeCompressor;
      val = (val - 0.5 * (-safeCompressor)) / denom;
    } else {
      const diff = val - 0.5;
      const sign = diff >= 0 ? 1 : -1;
      const normDiff = Math.abs(diff) * 2;
      const exponent = 1 - safeCompressor * 0.8;
      if (exponent > 0.001 && normDiff > 0) {
        const baseVal = Math.pow(normDiff, 1 / exponent);
        val = 0.5 + sign * 0.5 * baseVal;
      }
    }
    val = Math.max(0, Math.min(1, val));
  }

  // Invert Drive (shift)
  if (drive !== 0) {
    val = Math.max(0, Math.min(1, val - drive));
  }

  // Invert Curve
  switch (curve) {
    case 'exponential':
      return Math.sqrt(Math.max(0, val));
    case 'logarithmic':
      return val * val;
    case 's-curve':
      return Math.acos(Math.max(-1, Math.min(1, 1 - 2 * val))) / Math.PI;
    case 'linear':
    default:
      return val;
  }
}

export async function applyMapping(clientId: string, controlName: string, value: number, isDeactivated?: boolean): Promise<void> {
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
      const inputCurved = applyCurve(normalized, target.curve, target.drive, target.compressor);

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
      // For trigger_note the modeState must be per-control, not just per-target,
      // because multiple controls can send different notes to the same MIDI track.
      // Including controlName in the key prevents cross-control state sharing.
      const key = target.mode === 'trigger_note'
        ? `${clientId}::${controlName}::${getTargetKey(target)}`
        : `${clientId}::${getTargetKey(target)}`;

      let modeState = eventModesState.get(key);
      if (!modeState) {
        modeState = { lastInput: 0, active: false };
        eventModesState.set(key, modeState);
      }

      let finalScaledValue = scaledValue;
      if (isDeactivated && target.idleValue !== undefined && target.idleValue !== null) {
        finalScaledValue = target.idleValue;
      }
      let skipApply = false;

      if (target.mode === 'trigger_note') {
        const threshold = target.threshold ?? 0.5;
        const isPressed = value >= threshold;
        const wasPressed = modeState.lastInput >= threshold;
        modeState.lastInput = value;

        const midiNum = noteNameToMidiNumber(target.midiNote ?? "C3");
        const velocity = target.midiVelocity ?? 100;

        if (isPressed && !wasPressed) {
          sendMidiNote(0x90, midiNum, velocity);
        } else if (!isPressed && wasPressed) {
          sendMidiNote(0x80, midiNum, 0);
        }
        skipApply = true;
      } else if (target.mode === 'toggle') {
        const threshold = target.threshold ?? 0.5;
        const triggered = modeState.lastInput < threshold && value >= threshold;
        modeState.lastInput = value;

        if (triggered) {
          modeState.active = !modeState.active;
        }
        finalScaledValue = modeState.active ? (target.outMax ?? 1) : (target.outMin ?? 0);
      }

      if (skipApply) {
        lastMappedValues.set(key, value);
        return;
      }

      const applyFn = async (scaledVal: number) => {
        const getTrack = () => {
          const kind = target.trackKind;
          const idx = target.trackIndex ?? 0;
          if (kind === 'return') {
            return song.returnTracks[idx];
          } else if (kind === 'main') {
            return song.mainTrack;
          } else {
            return song.tracks[idx];
          }
        };
        switch (target.type) {
          case 'tempo': {
            song.tempo = 20 + scaledVal * 280;
            break;
          }
          case 'track_mute': {
            const t = getTrack();
            if (t) t.mute = scaledVal > 0.5;
            break;
          }
          case 'track_solo': {
            const t = getTrack();
            if (t) t.solo = scaledVal > 0.5;
            break;
          }
          case 'track_arm': {
            const t = getTrack();
            if (t && "arm" in t) (t as any).arm = scaledVal > 0.5;
            break;
          }
          case 'mixer_volume': {
            const t = getTrack();
            if (t && "mixer" in t) {
              const mixer = t.mixer as any;
              const scaled = mixer.volume.min + scaledVal * (mixer.volume.max - mixer.volume.min);
              await mixer.volume.setValue(scaled);
            }
            break;
          }
          case 'mixer_pan': {
            const t = getTrack();
            if (t && "mixer" in t) {
              const mixer = t.mixer as any;
              const scaled = mixer.panning.min + scaledVal * (mixer.panning.max - mixer.panning.min);
              await mixer.panning.setValue(scaled);
            }
            break;
          }
          case 'mixer_send': {
            const t = getTrack();
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
            const t = getTrack();
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
          const lastVal = lastMappedValues.get(key) ?? finalScaledValue;
          state = {
            current: lastVal,
            target: finalScaledValue,
            smoothFactor,
            apply: applyFn,
            lastTime: Date.now()
          };
          activeSmooths.set(key, state);
        } else {
          state.target = finalScaledValue;
          state.smoothFactor = smoothFactor;
        }
      } else {
        await applyMappedValue(key, finalScaledValue, applyFn);
      }
    }));
  } catch (err) {
    console.error(`[ableton-rc-surface] applyMapping(${controlName}) error: ${err instanceof Error ? err.message : String(err)}`);
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
      const getTrack = () => {
        const kind = target.trackKind;
        const idx = target.trackIndex ?? 0;
        if (kind === 'return') {
          return song.returnTracks[idx];
        } else if (kind === 'main') {
          return song.mainTrack;
        } else {
          return song.tracks[idx];
        }
      };
      switch (target.type) {
        case 'tempo': {
          scaledValue = (song.tempo - 20) / 280;
          break;
        }
        case 'track_mute': {
          const t = getTrack();
          scaledValue = t && t.mute ? 1 : 0;
          break;
        }
        case 'track_solo': {
          const t = getTrack();
          scaledValue = t && t.solo ? 1 : 0;
          break;
        }
        case 'track_arm': {
          const t = getTrack();
          scaledValue = t && t.arm ? 1 : 0;
          break;
        }
        case 'mixer_volume': {
          const t = getTrack();
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
          const t = getTrack();
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
          const t = getTrack();
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
          const t = getTrack();
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
      const inverseCurved = applyCurveInverse(rawValue, target.curve, target.drive, target.compressor);
      
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
  getTransportLiteState: {
    description: "Get current Transport Lite state from AbletonOSC",
    handler: async () => {
      return oscTransport.state;
    }
  },
  refreshTransportLocators: {
    description: "Refresh locator list from AbletonOSC",
    handler: async () => {
      oscTransport.refreshLocators();
      return { ok: true };
    }
  },
  transportPlay: {
    description: "Start playback via AbletonOSC",
    handler: async () => {
      oscTransport.play();
      return { ok: true };
    }
  },
  transportStop: {
    description: "Stop playback via AbletonOSC",
    handler: async () => {
      oscTransport.stopPlayback();
      return { ok: true };
    }
  },
  transportToggle: {
    description: "Toggle playback via AbletonOSC",
    handler: async () => {
      oscTransport.toggle();
      return { ok: true };
    }
  },
  transportPrevLocator: {
    description: "Jump to previous locator",
    handler: async () => {
      oscTransport.prevLocator();
      return { ok: true };
    }
  },
  transportNextLocator: {
    description: "Jump to next locator",
    handler: async () => {
      oscTransport.nextLocator();
      return { ok: true };
    }
  },
  transportJumpToLocator: {
    description: "Jump to a specific locator",
    handler: async (args) => {
      const indexOrName = args["indexOrName"];
      if (indexOrName !== undefined && indexOrName !== null) {
        oscTransport.jumpToLocator(indexOrName);
      }
      return { ok: true };
    }
  },
  getSelectedLiveContext: {
    description: "Get currently selected track and device from Ableton Live",
    handler: async () => {
      const { song } = requireCtx();
      const trackIndex = oscTransport.state.selectedTrackIndex;
      const deviceIndex = oscTransport.state.selectedDeviceIndex;
      let trackName = "";
      let deviceName = "";
      if (trackIndex !== null && trackIndex >= 0 && trackIndex < song.tracks.length) {
        const track = song.tracks[trackIndex];
        if (track) {
          trackName = track.name;
          if (deviceIndex !== null && deviceIndex >= 0 && deviceIndex < track.devices.length) {
            const device = track.devices[deviceIndex];
            if (device) {
              deviceName = device.name;
            }
          }
        }
      }
      return {
        selectedTrackIndex: trackIndex,
        selectedDeviceIndex: deviceIndex,
        trackName,
        deviceName
      };
    }
  },
  getServerInfo: {
    description: "Get server state, LAN URLs, cert info, etc.",
    handler: async () => {
      const serverState = await import("../server/state.js");
      const cpuUtil = await import("../util/cpu.js");
      const isRunning = serverState.serverInstance !== null;
      const port = serverState.actualPort;
      const httpsPort = serverState.actualHttpsPort;
      const { primary, others } = pickLanIps(getLanAddresses());
      const phoneProto = serverState.useHttps && httpsPort ? "https" : "http";
      const phonePort = serverState.useHttps && httpsPort ? httpsPort : port;
      const adminProto = serverState.useHttps && httpsPort ? "https" : "http";
      const adminPort = serverState.useHttps && httpsPort ? httpsPort : port;
      const phoneUrl = isRunning && port !== null ? `${phoneProto}://${primary}:${phonePort}/` : null;
      const adminUrl = isRunning && port !== null ? `${adminProto}://127.0.0.1:${adminPort}/static/admin/` : null;
      const statusText = isRunning
        ? port !== null
          ? `Running (HTTP: ${port}${httpsPort ? `, HTTPS: ${httpsPort}` : ""})`
          : "Running (binding...)"
        : "Stopped";
      const cpuUsage = Math.round(cpuUtil.sampleCpuUsagePercent() * 100);
      return {
        isRunning,
        port,
        httpsPort,
        useHttps: serverState.useHttps,
        primaryIp: primary,
        otherIps: others,
        phoneUrl,
        adminUrl,
        statusText,
        cpuUsage,
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



  setTempo: {
    description: "Set song tempo in BPM. Args: {tempo: number}",
    handler: async (args) => {
      const { song } = requireCtx();
      const tempo = args["tempo"];
      if (typeof tempo !== "number" || !Number.isFinite(tempo) || tempo <= 0 || tempo > 1000) {
        throw new Error(`tempo must be a positive finite number, got: ${String(tempo)}`);
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
      if (typeof value !== "number" || !Number.isFinite(value)) {
        throw new Error(`value must be a finite number, got: ${String(value)}`);
      }
      const clamped = Math.max(param.min, Math.min(param.max, value));
      await param.setValue(clamped);
      return { trackIndex: args["trackIndex"], deviceIndex, paramIndex, value: clamped };
    },
  },

  addUdpReceiverToTrack: {
    description: "Refresh the RC-Midi-Receiver Max device on a track.",
    handler: async (args) => {
      const trackIndex = args["trackIndex"];
      if (typeof trackIndex !== "number") throw new Error("trackIndex must be a number");
      const { song } = requireCtx();
      const track = requireTrack(song, trackIndex);

      const existingDevice = track.devices.find(d => d.name === "RC-Midi-Receiver" || d.name === "RC-Midi-Receiver.amxd");
      if (existingDevice) {
        return { success: true, existing: true, inserted: false, receiverName: existingDevice.name };
      }

      try {
        await track.insertDevice("RC-Midi-Receiver", 0);
        return { success: true, inserted: true, existing: false, receiverName: "RC-Midi-Receiver" };
      } catch (err1) {
        try {
          await track.insertDevice("RC-Midi-Receiver.amxd", 0);
          return { success: true, inserted: true, existing: false, receiverName: "RC-Midi-Receiver.amxd" };
        } catch (err2) {
          throw new Error(`Failed to insert. Tried 'RC-Midi-Receiver' (Error: ${err1 instanceof Error ? err1.message : String(err1)}) and 'RC-Midi-Receiver.amxd' (Error: ${err2 instanceof Error ? err2.message : String(err2)})`);
        }
      }
    }
  },

  getTargets: {
    description: "List all mappable targets: tracks with mixer params + devices with params.",
    handler: async () => {
      const { song } = requireCtx();
      const targets: any[] = [];
      targets.push({ id: 'tempo', type: 'tempo', label: `Song Tempo (${song.tempo.toFixed(1)} BPM)` });

      const buildTrackData = (track: any, ti: number, trackKind: 'track' | 'return' | 'main') => {
        if (!track) return null;
        const tName = track.name || (trackKind === 'main' ? 'Master' : `${trackKind === 'return' ? 'Return' : 'Track'} ${ti + 1}`);
        const trackTargets: any[] = [];
        if ("mixer" in track) {
          const mixer = track.mixer as any;
          trackTargets.push({ type: 'mixer_volume', trackIndex: ti, trackKind, label: 'Volume' });
          trackTargets.push({ type: 'mixer_pan', trackIndex: ti, trackKind, label: 'Pan' });
          if (mixer.sends) {
            for (let si = 0; si < mixer.sends.length; si++) {
              const sendParam = mixer.sends[si];
              trackTargets.push({ type: 'mixer_send', trackIndex: ti, trackKind, sendIndex: si, label: sendParam?.name || `Send ${si + 1}` });
            }
          }
        }
        trackTargets.push({ type: 'track_mute', trackIndex: ti, trackKind, label: 'Mute' });
        trackTargets.push({ type: 'track_solo', trackIndex: ti, trackKind, label: 'Solo' });
        if (trackKind === 'track') {
          trackTargets.push({ type: 'track_arm', trackIndex: ti, trackKind, label: 'Arm' });
        }
        
        const devicesList: any[] = [];
        for (let di = 0; di < track.devices.length; di++) {
          const device = track.devices[di];
          if (!device) continue;
          const params: any[] = [];
          for (let pi = 0; pi < device.parameters.length; pi++) {
            const p = device.parameters[pi];
            if (!p) continue;
            params.push({ type: 'device_param', trackIndex: ti, trackKind, deviceIndex: di, paramIndex: pi, label: p.name, min: p.min, max: p.max });
          }
          devicesList.push({ index: di, name: device.name, params });
        }
        return {
          trackIndex: ti,
          trackKind,
          name: tName,
          isMidi: track.constructor.name === "MidiTrack",
          mute: trackKind === 'main' ? false : track.mute,
          solo: trackKind === 'main' ? false : track.solo,
          arm: trackKind === 'track' ? track.arm : false,
          mixer: trackTargets,
          devices: devicesList
        };
      };

      for (let ti = 0; ti < song.tracks.length; ti++) {
        const data = buildTrackData(song.tracks[ti], ti, 'track');
        if (data) targets.push(data);
      }
      const returnTracks = song.returnTracks || [];
      for (let ti = 0; ti < returnTracks.length; ti++) {
        const data = buildTrackData(returnTracks[ti], ti, 'return');
        if (data) targets.push(data);
      }
      const mainTrack = song.mainTrack;
      if (mainTrack) {
        const data = buildTrackData(mainTrack, 0, 'main');
        if (data) targets.push(data);
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
      // Clear derived state so future mappings don't inherit stale data
      // (e.g. a new trigger_note binding could otherwise re-fire a
      // toggle that was left active by the previous mapping).
      lastMappedValues.clear();
      eventModesState.clear();
      for (const [key, state] of [...activeSmooths.entries()]) {
        activeSmooths.delete(key);
        try { await state.apply(0); } catch {}
      }
      for (const [key, state] of [...hostModulators.entries()]) {
        hostModulators.delete(key);
        try { await applyHostGeneratedControl(state.clientId, state.name, 0, Date.now(), true); } catch {}
      }
      maybeStopHostModulatorLoop();
      await saveMappings();
      return { cleared: count };
    }
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

      const cleanName = sanitizeFilenameComponent(name);
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

      const cleanName = sanitizeFilenameComponent(name);
      const filePath = path.join(presetsDirPath, `${cleanName}.json`);

      const raw = await fs.readFile(filePath, "utf-8");
      const obj = JSON.parse(raw) as Record<string, MappingTarget | MappingTarget[]>;
      controlMappings.clear();
      // Reset derived state so the new preset starts from a clean slate.
      // Without this, modulators/smooths/eventModes from the old preset
      // continue running against (now missing) target keys.
      lastMappedValues.clear();
      eventModesState.clear();
      for (const [key, state] of [...activeSmooths.entries()]) {
        activeSmooths.delete(key);
        try { await state.apply(0); } catch {}
      }
      for (const [key, state] of [...hostModulators.entries()]) {
        hostModulators.delete(key);
        try { await applyHostGeneratedControl(state.clientId, state.name, 0, Date.now(), true); } catch {}
      }
      maybeStopHostModulatorLoop();
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

      const cleanName = sanitizeFilenameComponent(name);
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
