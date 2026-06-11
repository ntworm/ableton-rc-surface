// audio-processor.js
// Handles Web Audio Analyser, RMS envelope follower, and YIN pitch detection.

(function (global) {
  'use strict';

  class AudioProcessor {
    constructor() {
      this.audioContext = null;
      this.analyser = null;
      this.stream = null;
      this.animationId = null;
      this.onAnalysisUpdate = null; // Callback for live values: (pitch, midiNote, rms, bpm)
      this.sampleBuffer = null;

      // Onset/beat detection variables
      this.lastRms = 0;
      this.lastOnset = 0;
      this.onsetThreshold = 0.08;
      this.beatIntervals = [];
      this.estimatedBpm = 0;
    }

    async start() {
      if (this.audioContext) return;

      try {
        const AudioCtx = global.AudioContext || global.webkitAudioContext;
        this.audioContext = new AudioCtx();
        
        this.stream = await global.navigator.mediaDevices.getUserMedia({ audio: true, video: false });
        const source = this.audioContext.createMediaStreamSource(this.stream);
        
        this.analyser = this.audioContext.createAnalyser();
        this.analyser.fftSize = 2048;
        this.sampleBuffer = new Float32Array(this.analyser.fftSize);
        
        source.connect(this.analyser);
        
        if (this.audioContext.state === 'suspended') {
          await this.audioContext.resume();
        }

        this.startAnalysisLoop();
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
        this.stream.getTracks().forEach(track => track.stop());
        this.stream = null;
      }
      if (this.audioContext) {
        this.audioContext.close();
        this.audioContext = null;
      }
      this.analyser = null;
    }

    startAnalysisLoop() {
      const analyze = () => {
        if (!this.analyser) return;

        this.analyser.getFloatTimeDomainData(this.sampleBuffer);
        
        // 1. Calculate RMS (Volume Envelope)
        const rms = this.calculateRMS(this.sampleBuffer);

        // 2. Detect Pitch (YIN)
        let pitch = 0;
        let midiNote = 0;
        if (rms > 0.01) { // Only detect pitch if signal is present
          pitch = this.detectPitchYIN(this.sampleBuffer, this.audioContext.sampleRate);
          if (pitch > 0 && pitch < 5000) {
            midiNote = this.hzToMidi(pitch);
          } else {
            pitch = 0;
          }
        }

        // 3. Simple Onset/Beat detection
        this.detectOnsets(rms);

        if (this.onAnalysisUpdate) {
          this.onAnalysisUpdate({
            pitch: parseFloat(pitch.toFixed(1)),
            midiNote,
            rms: parseFloat(rms.toFixed(3)),
            bpm: this.estimatedBpm
          });
        }

        this.animationId = global.requestAnimationFrame(analyze);
      };

      this.animationId = global.requestAnimationFrame(analyze);
    }

    calculateRMS(buffer) {
      let sum = 0;
      for (let i = 0; i < buffer.length; i++) {
        sum += buffer[i] * buffer[i];
      }
      return Math.sqrt(sum / buffer.length);
    }

    detectPitchYIN(buffer, sampleRate) {
      const W = buffer.length / 2; // Half buffer window
      const threshold = 0.15;
      const d = new Float32Array(W);

      // Step 1: Difference
      for (let tau = 0; tau < W; tau++) {
        let sum = 0;
        for (let j = 0; j < W; j++) {
          const diff = buffer[j] - buffer[j + tau];
          sum += diff * diff;
        }
        d[tau] = sum;
      }

      // Step 2: Cumulative mean normalized difference
      const dPrime = new Float32Array(W);
      dPrime[0] = 1;
      let runningSum = 0;
      for (let tau = 1; tau < W; tau++) {
        runningSum += d[tau];
        dPrime[tau] = d[tau] / ((1 / tau) * runningSum);
      }

      // Step 3: Absolute threshold / local minima
      let period = -1;
      for (let tau = 2; tau < W; tau++) {
        if (dPrime[tau] < threshold) {
          while (tau + 1 < W && dPrime[tau + 1] < dPrime[tau]) {
            tau++;
          }
          period = tau;
          break;
        }
      }

      if (period === -1) {
        let minVal = 1e9;
        for (let tau = 2; tau < W; tau++) {
          if (dPrime[tau] < minVal) {
            minVal = dPrime[tau];
            period = tau;
          }
        }
      }

      // Step 4: Parabolic interpolation
      if (period > 0 && period < W - 1) {
        const alpha = dPrime[period - 1];
        const beta = dPrime[period];
        const gamma = dPrime[period + 1];
        const denom = alpha - 2 * beta + gamma;
        if (Math.abs(denom) > 0.0001) {
          const pBetter = period + 0.5 * (alpha - gamma) / denom;
          return sampleRate / pBetter;
        }
      }

      return period > 0 ? sampleRate / period : 0;
    }

    hzToMidi(hz) {
      if (!hz || hz < 20 || hz > 20000) return 0;
      return Math.round(69 + 12 * Math.log2(hz / 440));
    }

    detectOnsets(rms) {
      const now = performance.now();
      const diff = rms - this.lastRms;
      this.lastRms = rms;

      // Check if transient onset spike occurs
      if (diff > this.onsetThreshold && now - this.lastOnset > 250) { // 250ms debounce
        const interval = now - this.lastOnset;
        this.lastOnset = now;

        if (interval > 300 && interval < 1500) { // Limit intervals between 40-200 BPM
          this.beatIntervals.push(interval);
          if (this.beatIntervals.length > 5) {
            this.beatIntervals.shift();
          }

          // Compute average beat interval
          const avgInterval = this.beatIntervals.reduce((sum, val) => sum + val, 0) / this.beatIntervals.length;
          this.estimatedBpm = Math.round(60000 / avgInterval);
        }
      }
    }
  }

  global.AudioProcessor = AudioProcessor;

})(typeof window !== 'undefined' ? window : globalThis);
