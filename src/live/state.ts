// Copyright © 2026 Gabriel Worm
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Source: https://github.com/ntworm/ableton-rc-surface
//
// This file is part of Ableton RC Surface, distributed under the
// PolyForm Noncommercial License 1.0.0. You may obtain a copy of
// the License at https://polyformproject.org/licenses/noncommercial/1.0.0
import { WebSocket } from "ws";
import { getExtensionContext } from "../context.js";
import { trackedClients } from "../server/ws.js";

export let playheadActive = false;
export let playheadStartTime = 0;
export let playheadBaseTimeMs = 0;
type LiveStateSnapshot = {
  tempo: number;
  signature: string;
  scale: string;
  scaleMode: boolean;
  scaleName: string;
  rootNote: number;
  scaleIntervals: number[];
};

export let lastBroadcastedState: LiveStateSnapshot = {
  tempo: 0,
  signature: "",
  scale: "",
  scaleMode: false,
  scaleName: "",
  rootNote: 0,
  scaleIntervals: [],
};

export function setPlayheadActive(val: boolean) { playheadActive = val; }
export function setPlayheadStartTime(val: number) { playheadStartTime = val; }
export function setPlayheadBaseTimeMs(val: number) { playheadBaseTimeMs = val; }

export const NOTES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];

export function getScaleLabel(root: number, name: string): string {
  const noteName = NOTES[root] ?? "";
  return noteName ? `${noteName} ${name}` : name;
}

/**
 * Build the live-state payload from a song snapshot. Pure function — no
 * network, no global state — so it can be unit-tested without an extension
 * context.
 *
 * Live scale metadata: emits the raw scale props (`scaleMode`, `scaleName`,
 * `rootNote`, `scaleIntervals`) in addition to the derived `scale` label.
 * The payload shape is otherwise unchanged.
 */
export function computeLiveStatePayload(song: {
  tempo: number;
  scenes?: { signatureNumerator: number; signatureDenominator: number }[];
  scaleMode: boolean;
  scaleName: string;
  rootNote: number;
  scaleIntervals: number[];
}): {
  type: "live_state";
  tempo: number;
  signature: string;
  scale: string;
  scaleMode: boolean;
  scaleName: string;
  rootNote: number;
  scaleIntervals: number[];
} {
  const signature =
    song.scenes && song.scenes.length > 0 && song.scenes[0]
      ? `${song.scenes[0].signatureNumerator}/${song.scenes[0].signatureDenominator}`
      : "4/4";

  return {
    type: "live_state",
    tempo: song.tempo,
    signature,
    scale: getScaleLabel(song.rootNote, song.scaleName),
    scaleMode: song.scaleMode,
    scaleName: song.scaleName,
    rootNote: song.rootNote,
    scaleIntervals: song.scaleIntervals,
  };
}

export function broadcastPlayheadState(): void {
  const now = Date.now();
  const currentPos = playheadActive ? (playheadBaseTimeMs + (now - playheadStartTime)) : playheadBaseTimeMs;
  const payload = {
    type: "playhead_state",
    playheadActive,
    playheadTimeMs: currentPos,
  };
  const json = JSON.stringify(payload);
  for (const c of trackedClients.values()) {
    if (!c.isAdmin && c.ws.readyState === WebSocket.OPEN) {
      try {
        c.ws.send(json);
      } catch {}
    }
  }
}

export function checkAndBroadcastLiveState(): void {
  try {
    const extensionContext = getExtensionContext();
    if (!extensionContext) return;
    const song = extensionContext.application.song;
    if (!song) return;

    const payload = computeLiveStatePayload(song);

    // Compare against the last broadcast. We check tempo/signature/scale
    // (the cached fields) plus the raw scale props so that a scale change
    // (root note, scale name, interval set, mode toggle) always fires the
    // broadcast even when tempo and signature are unchanged.
    const last = lastBroadcastedState;
    const scaleChanged =
      payload.scaleMode !== last.scaleMode ||
      payload.scaleName !== last.scaleName ||
      payload.rootNote !== last.rootNote ||
      (payload.scaleIntervals.length !== last.scaleIntervals.length ||
        payload.scaleIntervals.some((v, i) => v !== last.scaleIntervals[i]));

    if (
      payload.tempo !== last.tempo ||
      payload.signature !== last.signature ||
      payload.scale !== last.scale ||
      scaleChanged
    ) {
      lastBroadcastedState = {
        tempo: payload.tempo,
        signature: payload.signature,
        scale: payload.scale,
        scaleMode: payload.scaleMode,
        scaleName: payload.scaleName,
        rootNote: payload.rootNote,
        scaleIntervals: payload.scaleIntervals,
      };
      const json = JSON.stringify(payload);
      for (const c of trackedClients.values()) {
        if (!c.isAdmin && c.ws.readyState === WebSocket.OPEN) {
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

let liveStateBroadcastHandle: NodeJS.Timeout | null = null;

/**
 * Start the periodic live-state broadcast loop. Idempotent: a second call
 * while the loop is already running is a no-op. Default tick is 500ms for
 * The previous 1s cadence introduced a perceptible lag when Live state
 * metadata changed.
 */
export function startLiveStateBroadcastLoop(intervalMs: number = 500): void {
  if (liveStateBroadcastHandle !== null) return;
  liveStateBroadcastHandle = setInterval(checkAndBroadcastLiveState, intervalMs);
}

/**
 * Stop the periodic live-state broadcast loop. Idempotent: calling on an
 * already-stopped loop is a no-op.
 */
export function stopLiveStateBroadcastLoop(): void {
  if (liveStateBroadcastHandle === null) return;
  clearInterval(liveStateBroadcastHandle);
  liveStateBroadcastHandle = null;
}

/**
 * Report whether the live-state broadcast loop is currently scheduled.
 */
export function isLiveStateBroadcastLoopRunning(): boolean {
  return liveStateBroadcastHandle !== null;
}
