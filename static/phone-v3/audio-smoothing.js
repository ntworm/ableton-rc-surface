// Copyright © 2026 Gabriel Worm
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Source: https://github.com/ntworm/ableton-rc-surface
//
// This file is part of Ableton RC Surface, distributed under the
// PolyForm Noncommercial License 1.0.0. You may obtain a copy of
// the License at https://polyformproject.org/licenses/noncommercial/1.0.0
/**
 * audio-smoothing.js — adaptive low-pass filter for audio signals.
 *
 * Two pure functions exposed via `window.AudioSmoothing`:
 *   - smoothAudioValue(prev, raw)         // adaptive-alpha smoothing for any signal
 *   - gainSmoothedRms(prev, raw, alpha, gain=RMS_GAIN) // RMS-specific: amplify + clamp + smooth
 *
 * Why adaptive alpha:
 *   A fixed-alpha smoothing treats quiet and loud signals identically. The
 *   dominant complaint at rest is RMS jitter from background noise. Weighting
 *   the previous sample more heavily when raw is small fixes that without
 *   slowing down transients.
 *   Formula: `alpha = 0.08 + min(0.5, raw * 2)`
 *     raw = 0.0   → alpha = 0.08  (retain 92% — anti-jitter)
 *     raw = 0.25  → alpha = 0.58  (retain 42% — transients pass)
 *     raw ≥ 0.25  → alpha = 0.58  (clamped)
 *
 * Why RMS-specific gain:
 *   Phone mics deliver raw RMS in the 0.01–0.05 range for everyday signals.
 *   The admin bar clamps at 1.0 but the perceptually useful range is 0.0–0.3.
 *   A 3× input gain brings "speech level" up to 0.15–0.45 — readable on the
 *   bar and useful for mapping — while still clamping saturated peaks at 1.0.
 *   Gain affects only the signal fed into the smoother; the alpha curve is
 *   computed from the *raw* value, not the amplified one, so noise suppression
 *   at silence is unchanged.
 *
 * Loaded as a plain <script> before app.js. Exposes
 * `window.AudioSmoothing.{smoothAudioValue, gainSmoothedRms}`.
 */

(function (root) {
  const RMS_GAIN = 3;

  /**
   * Single-step adaptive smoothing for one audio sample.
   * @param {number} prev - previous smoothed value (start at 0)
   * @param {number} raw  - raw sample from analyser (expected 0..1)
   * @returns {number}    - new smoothed value
   */
  function smoothAudioValue(prev, raw) {
    const alpha = 0.08 + Math.min(0.5, raw * 2);
    return prev * (1 - alpha) + raw * alpha;
  }

  /**
   * RMS-specific: apply input gain, clamp saturated peaks, then smooth.
   * Alpha is computed from the raw value, not the gained one, so silence
   * still benefits from adaptive noise suppression.
   * @param {number} prev         - previous smoothed value (start at 0)
   * @param {number} raw          - raw RMS from analyser (expected 0..1)
   * @param {number} alpha        - smoothing factor (caller usually computes via smoothAudioValue's formula)
   * @param {number} [gain=RMS_GAIN] - input gain multiplier; values <= 0 are ignored
   * @returns {number}            - new smoothed value, clamped to [0, 1]
   */
  function gainSmoothedRms(prev, raw, alpha, gain) {
    const g = gain > 0 ? gain : RMS_GAIN;
    const amplified = raw * g;
    const clamped = amplified > 1 ? 1 : amplified;
    return prev * (1 - alpha) + clamped * alpha;
  }

  root.AudioSmoothing = {
    smoothAudioValue,
    gainSmoothedRms,
    RMS_GAIN,
  };
})(typeof window !== 'undefined' ? window : globalThis);
