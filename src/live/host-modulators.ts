// Copyright © 2026 Gabriel Worm
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Source: https://github.com/ntworm/ableton-rc-surface
//
// This file is part of Ableton RC Surface, distributed under the
// PolyForm Noncommercial License 1.0.0. You may obtain a copy of
// the License at https://polyformproject.org/licenses/noncommercial/1.0.0
//
// host-modulators.ts — the LFO / stutter motor.
//
// The phone sends a modulator's *configuration* once (shape, rate, depth,
// sync) and then goes quiet; the host generates the signal from there. That
// keeps a 20 Hz LFO off the radio link entirely, and it keeps the modulation
// running when the phone's browser throttles its timers in the background.
//
// Phase is always derived from absolute time rather than accumulated per
// tick, so a delayed or dropped tick reads the correct phase for the instant
// it eventually runs instead of drifting.
//
// Depends on the mapping engine one way only: this module calls applyMapping,
// nothing in mappings.ts calls back into here.
import { getExtensionContext } from "../context.js";
import { trackedClients, appendHistory, pushClientUpdate } from "../server/ws.js";
import { playheadActive, playheadStartTime, playheadBaseTimeMs } from "./state.js";
import { oscTransport } from "./osc-transport.js";
import { computeSyncedLfoValue, computeSyncedStutterValue } from "./transport-clock.js";
import { applyMapping } from "./mappings.js";

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
  /** Last value actually pushed to Live, for redundant-write suppression. */
  lastWrittenValue?: number;
}

/**
 * Smallest change worth a write to Live.
 *
 * The motor ticks at 250 Hz because a 20 Hz LFO needs that to stay smooth —
 * that part is right and stays. What was wrong is that every tick wrote,
 * whatever the value was doing. A stutter gate holds 1 for its whole open
 * phase and was written 250 times a second to say "still 1"; a slow LFO moves
 * ~0.0001 per tick and was written just as often.
 *
 * Below this delta the write cannot change what anyone hears or sees, so
 * skipping it is lossless. A 20 Hz LFO at full depth moves ~0.25 per tick and
 * is completely unaffected: it still writes on every single tick.
 */
const HOST_MODULATOR_WRITE_EPSILON = 0.0005;

/**
 * Whether this tick's value is worth sending to Live, updating the
 * bookkeeping when it is. The first value after activation always writes.
 */
function shouldWriteHostValue(state: HostModulatorState, value: number): boolean {
  const previous = state.lastWrittenValue;
  if (previous !== undefined && Math.abs(value - previous) < HOST_MODULATOR_WRITE_EPSILON) {
    return false;
  }
  state.lastWrittenValue = value;
  return true;
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
    // Only the timestamp is carried forward: both branches below derive phase
    // from absolute time, so there is no delta to integrate.
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
        if (shouldWriteHostValue(state, value)) {
          applies.push(applyHostGeneratedControl(state.clientId, state.name, value, now));
        }
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
        if (shouldWriteHostValue(state, value)) {
          applies.push(applyHostGeneratedControl(state.clientId, state.name, value, now));
        }
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
        if (shouldWriteHostValue(state, value)) {
          applies.push(applyHostGeneratedControl(state.clientId, state.name, value, now));
        }
      } else {
        if (state.phaseZeroMs === undefined) state.phaseZeroMs = now;
        const elapsedSec = (now - state.phaseZeroMs) / 1000;
        const phaseRad = 2 * Math.PI * freqHz * elapsedSec + state.phase;
        // Stutter: phase < π → gate open, else closed. Same gate
        // condition as before but anchored to absolute time so the
        // pulse pattern does not shift when ticks are dropped.
        const normalizedPhase = ((phaseRad % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
        const value = normalizedPhase < Math.PI ? 1 : 0;
        if (shouldWriteHostValue(state, value)) {
          applies.push(applyHostGeneratedControl(state.clientId, state.name, value, now));
        }
      }
    }
  }

  await Promise.all(applies);
  maybeStopHostModulatorLoop();
}

/**
 * Shut every modulator down and park its target at 0.
 *
 * Used when the mapping set is replaced wholesale (clearing all mappings,
 * loading a preset): a modulator left running would keep driving a target key
 * that the new set no longer defines, which reads as a parameter moving on its
 * own with nothing on screen to explain it.
 */
export async function stopAllHostModulators(): Promise<void> {
  for (const [key, state] of [...hostModulators.entries()]) {
    hostModulators.delete(key);
    try {
      await applyHostGeneratedControl(state.clientId, state.name, 0, Date.now(), true);
    } catch {
      // A target that no longer resolves is exactly what we are clearing.
    }
  }
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
