// Copyright © 2026 Gabriel Worm
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Source: https://github.com/ntworm/ableton-rc-surface
//
// This file is part of Ableton RC Surface, distributed under the
// PolyForm Noncommercial License 1.0.0. You may obtain a copy of
// the License at https://polyformproject.org/licenses/noncommercial/1.0.0
export function computeBeatPosition(
  currentSongTimeBeats: number,
  numerator: number
): { beat: number; bar: number; phase: number } {
  const validNumerator = (Number.isInteger(numerator) && numerator > 0) ? numerator : 4;
  const normalizedBeats = Math.max(0, currentSongTimeBeats);
  const beat = Math.floor(normalizedBeats) % validNumerator + 1;
  const bar = Math.floor(normalizedBeats / validNumerator) + 1;
  const phase = normalizedBeats % 1;
  return { beat, bar, phase };
}

export function computeSyncedLfoValue(
  shape: string,
  beats: number,
  frequencyBeats: number,
  phaseOffsetBeats: number
): number {
  // Guard against division-by-zero / NaN / negative frequency: any
  // non-finite or non-positive frequencyBeats collapses to phase 0 so
  // callers never see NaN/Infinity propagated into the LFO output.
  const safeFreq = Number.isFinite(frequencyBeats) && frequencyBeats > 0
    ? frequencyBeats
    : 1;
  const offsetBeats = beats + phaseOffsetBeats;
  const rawPhase = (offsetBeats / safeFreq) % 1;
  const phase = (rawPhase + 1) % 1; // Normalize to [0, 1)

  switch (shape) {
    case 'triangle':
      return phase < 0.5 ? 4 * phase - 1 : 3 - 4 * phase;
    case 'ramp_up':
      return 2 * phase - 1;
    case 'ramp_down':
      return 1 - 2 * phase;
    case 'square':
      return phase < 0.5 ? 1 : -1;
    case 'sine':
    default:
      return Math.sin(phase * 2 * Math.PI);
  }
}

export function computeSyncedStutterValue(
  beats: number,
  stepBeats: number,
  phaseOffsetBeats: number,
  swing: number, // 0 to 0.66
  ratchet: number // 1, 2, 3, 4
): boolean {
  const offsetBeats = beats + phaseOffsetBeats;
  const cycleBeats = 2 * stepBeats;
  const cycleTime = ((offsetBeats % cycleBeats) + cycleBeats) % cycleBeats;

  // Clamp swing to safe range
  const clampedSwing = Math.max(0, Math.min(0.66, swing));
  const split = stepBeats * (1 + clampedSwing);

  let t = 0;
  if (cycleTime < split) {
    t = cycleTime / split;
  } else {
    t = (cycleTime - split) / (cycleBeats - split);
  }

  // With t from [0, 1), check ratchet gating (gate is open for first 50% of the ratchet sub-step)
  const ratchetPhase = (t * ratchet) % 1;
  return ratchetPhase < 0.5;
}
