// Copyright © 2026 Gabriel Worm
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Source: https://github.com/ntworm/ableton-rc-surface
//
// This file is part of Ableton RC Surface, distributed under the
// PolyForm Noncommercial License 1.0.0. You may obtain a copy of
// the License at https://polyformproject.org/licenses/noncommercial/1.0.0
//
// curves.ts — response shaping for a mapped value.
//
// Pure functions over a normalised 0..1 value: no Live handle, no client, no
// clock. They are the one part of the mapping pipeline that can be reasoned
// about (and tested) entirely on its own, which is why they live apart from
// the engine that calls them.
//
// applyCurve and applyCurveInverse must stay exact inverses of each other:
// the forward direction shapes what the performer sends, and the inverse is
// what lets a control pick up from the value a Live parameter already holds.

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
