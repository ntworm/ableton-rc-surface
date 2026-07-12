// Copyright © 2026 Gabriel Worm
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Source: https://github.com/ntworm/ableton-rc-surface
//
// This file is part of Ableton RC Surface, distributed under the
// PolyForm Noncommercial License 1.0.0. You may obtain a copy of
// the License at https://polyformproject.org/licenses/noncommercial/1.0.0
//
// audio-processor.js
//
// Microphone capture + analysis on the main thread (requestAnimationFrame).
// The DSP path (AnalyserNode → RMS → YIN pitch → envelope → transient →
// BPM → whistle gate) runs on the UI thread. This is the original
// pre-AudioWorklet implementation, restored because the AudioWorklet
// migration (commit 9f44000) introduced a TDZ `const sampleRate =
// sampleRate` bug that took the processor down after a couple of audio
// quanta on Samsung S25F. Reverting here while keeping the AGC fix
// from commit e44e859 (autoGainControl: false) so mic input still
// gets through mobile browser AGC.
//
// Public API and the onAnalysisUpdate payload shape are unchanged:
// every `sensor.audio.*` control is still emitted through the same
// fields (rms, pitch, midiNote, bpm, clarity, whistleActive,
// whistleBend, envelope, transient, gate).

(function (global) {
  'use strict';

  class AudioProcessor {
    constructor() {
      this.audioContext = null;
      this.analyser = null;
      this.stream = null;
      this.animationId = null;
      this.onAnalysisUpdate = null; // (pitch, midiNote, rms, bpm, clarity, whistle*, envelope, transient, gate)
      this.sampleBuffer = null;

      // Pitch detection state.
      this.lastPitch = 0;
      this.lastMidiNote = 0;
      this.lastClarity = 0;

      // Envelope follower state — asymmetric attack/release.
      this.envelope = 0;
      this.lastRms = 0;

      // Onset / beat detection.
      this.onsetThreshold = 0.08;
      this.lastOnset = 0;
      this.beatIntervals = [];
      this.estimatedBpm = 0;
    }

    async start() {
      if (this.audioContext) return;

      try {
        const AudioCtx = global.AudioContext || global.webkitAudioContext;
        if (!AudioCtx) throw new Error('Web Audio API is not available in this browser');
        this.audioContext = new AudioCtx();

        // Disable auto-gain-control specifically. Mobile browsers default AGC
        // to true on getUserMedia, which compresses voice into a narrow band and
        // effectively floors the RMS — users report "it doesn't pick up anything".
        // echoCancellation/noiseSuppression stay default (true) to avoid feedback.
        this.stream = await global.navigator.mediaDevices.getUserMedia({
          audio: {
            echoCancellation: true,
            noiseSuppression: true,
            autoGainControl: false,
            channelCount: 1,
          },
          video: false,
        });
        const source = this.audioContext.createMediaStreamSource(this.stream);

        this.analyser = this.audioContext.createAnalyser();
        this.analyser.fftSize = 2048;
        this.sampleBuffer = new Float32Array(this.analyser.fftSize);

        source.connect(this.analyser);

        if (this.audioContext.state === 'suspended') {
          await this.audioContext.resume();
        }

        this._startAnalysisLoop();
      } catch (err) {
        console.error('AudioProcessor start failed:', err);
        this.stop();
        throw err;
      }
    }

    stop() {
      if (this.animationId) {
        global.cancelAnimationFrame(this.animationId);
        this.animationId = null;
      }
      if (this.stream) {
        this.stream.getTracks().forEach((track) => track.stop());
        this.stream = null;
      }
      if (this.audioContext) {
        this.audioContext.close().catch(() => {});
        this.audioContext = null;
      }
      this.analyser = null;
      this.sampleBuffer = null;
    }

    _startAnalysisLoop() {
      let frameCount = 0;
      const analyze = () => {
        if (!this.analyser) return;

        this.analyser.getFloatTimeDomainData(this.sampleBuffer);

        // 1. RMS (volume envelope).
        const rms = this._calculateRMS(this.sampleBuffer);

        // 2. YIN pitch detection — throttle to every 3rd frame and downsample
        //    by 4 to keep CPU reasonable on phones.
        let pitch = this.lastPitch;
        let midiNote = this.lastMidiNote;
        let clarity = this.lastClarity;
        frameCount++;

        if (rms > 0.01) {
          if (frameCount % 3 === 0) {
            const downsampled = this._downsample(this.sampleBuffer, 4);
            const res = this._detectPitchYIN(
              downsampled,
              this.audioContext.sampleRate / 4
            );
            if (res.pitch > 0 && res.pitch < 5000) {
              pitch = res.pitch;
              midiNote = this._hzToMidi(pitch);
              clarity = res.clarity;
            } else {
              pitch = 0;
              clarity = 0;
            }
            this.lastPitch = pitch;
            this.lastMidiNote = midiNote;
            this.lastClarity = clarity;
          }
        } else {
          pitch = 0;
          midiNote = 0;
          clarity = 0;
          this.lastPitch = 0;
          this.lastMidiNote = 0;
          this.lastClarity = 0;
        }

        // 3. Whistle detection.
        let whistleActive = 0;
        let whistleBend = 0.5; // neutral pitch bend on the 0..1 scale.
        if (rms > 0.02 && pitch > 150 && pitch < 3000 && clarity > 0.65) {
          whistleActive = 1;
          const midiCont = 69 + 12 * Math.log2(pitch / 440);
          const diff = midiCont - Math.round(midiCont);
          whistleBend = parseFloat((diff + 0.5).toFixed(3));
        }

        // 4. Advanced envelope follower — asymmetric attack/release.
        if (rms > this.envelope) {
          this.envelope = this.envelope * 0.2 + rms * 0.8;
        } else {
          this.envelope = this.envelope * 0.85 + rms * 0.15;
        }
        const envelopeVal = parseFloat(this.envelope.toFixed(3));

        // 5. Transient / onset strength (instant increase in RMS, scaled).
        const rmsDiff = rms - this.lastRms;
        const transientVal = parseFloat(
          Math.min(1.0, Math.max(0.0, rmsDiff) * 8.0).toFixed(3)
        );

        // 6. Gate active.
        const gateVal = rms > 0.015 ? 1 : 0;

        // 7. Onset / BPM detection (debounced, sliding window of 5 intervals).
        this._detectOnsets(rms);

        this.lastRms = rms;

        if (this.onAnalysisUpdate) {
          this.onAnalysisUpdate({
            pitch: parseFloat(pitch.toFixed(1)),
            midiNote,
            rms: parseFloat(rms.toFixed(3)),
            bpm: this.estimatedBpm,
            clarity: parseFloat(clarity.toFixed(3)),
            whistleActive,
            whistleBend,
            envelope: envelopeVal,
            transient: transientVal,
            gate: gateVal,
          });
        }

        this.animationId = global.requestAnimationFrame(analyze);
      };

      this.animationId = global.requestAnimationFrame(analyze);
    }

    _calculateRMS(buffer) {
      let sum = 0;
      for (let i = 0; i < buffer.length; i++) {
        const v = buffer[i];
        sum += v * v;
      }
      return Math.sqrt(sum / buffer.length);
    }

    _downsample(buffer, factor) {
      const newLen = Math.floor(buffer.length / factor);
      const res = new Float32Array(newLen);
      for (let i = 0; i < newLen; i++) {
        res[i] = buffer[i * factor];
      }
      return res;
    }

    _detectPitchYIN(buffer, sampleRate) {
      // Half-buffer window — saves ~75% of YIN cost vs full window.
      const W = Math.floor(buffer.length / 2);
      const threshold = 0.15;
      const d = new Float32Array(W);

      // Step 1: difference function.
      for (let tau = 0; tau < W; tau++) {
        let sum = 0;
        for (let j = 0; j < W; j++) {
          const diff = buffer[j] - buffer[j + tau];
          sum += diff * diff;
        }
        d[tau] = sum;
      }

      // Step 2: cumulative mean normalized difference.
      const dPrime = new Float32Array(W);
      dPrime[0] = 1;
      let runningSum = 0;
      for (let tau = 1; tau < W; tau++) {
        runningSum += d[tau];
        dPrime[tau] = (d[tau] * tau) / runningSum;
      }

      // Step 3: absolute threshold / first local minimum.
      let period = -1;
      let minDPrimeVal = 1.0;
      for (let tau = 2; tau < W; tau++) {
        if (dPrime[tau] < threshold) {
          while (tau + 1 < W && dPrime[tau + 1] < dPrime[tau]) {
            tau++;
          }
          period = tau;
          minDPrimeVal = dPrime[tau];
          break;
        }
      }

      if (period === -1) {
        // No clear threshold crossing — fall back to the global minimum so
        // we still report a candidate rather than zero. Quiet signals end up
        // near 0 Hz which the caller already rejects (< 20 Hz).
        let minVal = 1e9;
        for (let tau = 2; tau < W; tau++) {
          if (dPrime[tau] < minVal) {
            minVal = dPrime[tau];
            period = tau;
          }
        }
        minDPrimeVal = minVal;
      }

      let finalPitch = period > 0 ? sampleRate / period : 0;

      // Step 4: parabolic interpolation around the picked minimum.
      if (period > 0 && period < W - 1) {
        const alpha = dPrime[period - 1];
        const beta = dPrime[period];
        const gamma = dPrime[period + 1];
        const denom = alpha - 2 * beta + gamma;
        if (Math.abs(denom) > 0.0001) {
          const pBetter = period + 0.5 * (alpha - gamma) / denom;
          finalPitch = sampleRate / pBetter;
        }
      }

      const clarity = Math.max(0.0, Math.min(1.0, 1.0 - minDPrimeVal));
      return { pitch: finalPitch, clarity };
    }

    _hzToMidi(hz) {
      if (!hz || hz < 20 || hz > 20000) return 0;
      return Math.round(69 + 12 * Math.log2(hz / 440));
    }

    _detectOnsets(rms) {
      const now = (global.performance && global.performance.now)
        ? global.performance.now()
        : Date.now();
      const diff = rms - this.lastRms;
      // Note: lastRms is updated by the caller (analyze loop) — this method
      // only reads the diff to decide if a transient just landed.
      if (diff > this.onsetThreshold && now - this.lastOnset > 250) {
        const interval = now - this.lastOnset;
        this.lastOnset = now;

        if (interval > 300 && interval < 1500) {
          this.beatIntervals.push(interval);
          if (this.beatIntervals.length > 5) {
            this.beatIntervals.shift();
          }
          const avgInterval =
            this.beatIntervals.reduce((s, v) => s + v, 0) /
            this.beatIntervals.length;
          this.estimatedBpm = Math.round(60000 / avgInterval);
        }
      }
    }
  }

  global.AudioProcessor = AudioProcessor;

})(typeof window !== 'undefined' ? window : globalThis);