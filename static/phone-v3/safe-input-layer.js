// Copyright © 2026 Gabriel Worm
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Shared browser-side safety primitives for audio, motion and single-hand vision.

(function (global) {
  'use strict';

  const clamp = (value, min = 0, max = 1) => Math.max(min, Math.min(max, value));
  const distance3 = (a, b) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);

  class SafeSignal {
    constructor(options = {}) {
      this.neutral = clamp(options.neutral ?? 0);
      this.holdMs = Math.max(0, options.holdMs ?? 120);
      this.releaseMs = Math.max(1, options.releaseMs ?? 280);
      this.outlierDelta = Math.max(0, options.outlierDelta ?? 0.65);
      this.deadzone = Math.max(0, options.deadzone ?? 0.002);
      this.attack = clamp(options.attack ?? 0.65);
      this.release = clamp(options.release ?? 0.22);
      this.recovery = clamp(options.recovery ?? 0.18);
      this.value = this.neutral;
      this.lastRaw = null;
      this.lastTimestamp = 0;
      this.lostAt = null;
      this.lostFrom = this.neutral;
      this.state = 'idle';
      this.pendingOutlier = null;
    }

    ingest(rawValue, timestamp = Date.now(), confidence = 1) {
      const raw = clamp(Number.isFinite(rawValue) ? rawValue : this.neutral);
      if (!Number.isFinite(confidence) || confidence < 0.2) {
        this.state = 'unstable';
        return this.snapshot();
      }
      if (this.lostAt === null && this.lastRaw !== null && Math.abs(raw - this.lastRaw) > this.outlierDelta) {
        const confirmationTolerance = Math.max(this.deadzone * 2, this.outlierDelta * 0.15);
        if (this.pendingOutlier === null || Math.abs(raw - this.pendingOutlier) > confirmationTolerance) {
          this.pendingOutlier = raw;
          this.state = 'unstable';
          return this.snapshot();
        }
        this.pendingOutlier = null;
      } else {
        this.pendingOutlier = null;
      }
      const recovering = this.lostAt !== null;
      this.lostAt = null;
      if (this.lastRaw === null) {
        this.value = raw;
      } else if (Math.abs(raw - this.value) > this.deadzone) {
        const alpha = recovering ? this.recovery : raw > this.value ? this.attack : this.release;
        this.value += (raw - this.value) * alpha;
      }
      this.lastRaw = raw;
      this.lastTimestamp = timestamp;
      this.state = recovering && Math.abs(raw - this.value) > this.deadzone ? 'recovering' : 'active';
      return this.snapshot();
    }

    markLost(timestamp = Date.now()) {
      if (this.lostAt === null) {
        this.lostAt = timestamp;
        this.lostFrom = this.value;
      }
      this.state = 'lost';
      return this.snapshot();
    }

    tick(timestamp = Date.now()) {
      if (this.lostAt === null) return this.snapshot();
      const elapsed = Math.max(0, timestamp - this.lostAt);
      if (elapsed <= this.holdMs) {
        this.state = 'lost';
      } else {
        const progress = clamp((elapsed - this.holdMs) / this.releaseMs);
        this.value = this.lostFrom + (this.neutral - this.lostFrom) * progress;
        this.state = progress < 1 ? 'decaying' : 'idle';
      }
      return this.snapshot();
    }

    snapshot() {
      return { value: clamp(this.value), state: this.state, timestamp: this.lastTimestamp };
    }
  }


  // MCP landmarks (5, 9, 13, 17) form the palm base — averaging distances
  // from the wrist to each MCP is more rotation/scale-robust than the
  // previous (palmWidth + palmLength) / 2 heuristic.
  const MCP_LANDMARKS = [5, 9, 13, 17];

  // Per-landmark weight for the descriptor distance. The wrist is excluded
  // from the comparison (always zero after translation), MCPs anchor the
  // shape, PIPs describe intermediate flexion, and fingertips are the
  // noisiest landmarks so they carry the least weight.
  // 21 landmarks × 2 coords = 42; index 0..1 is wrist (excluded).
  const LANDMARK_WEIGHTS = (() => {
    const weights = new Array(42);
    for (let landmark = 0; landmark < 21; landmark += 1) {
      const isWrist = landmark === 0;
      const isMcp = MCP_LANDMARKS.includes(landmark);
      const isTip = [4, 8, 12, 16, 20].includes(landmark);
      // Treat everything not wrist/mcp/tip as PIP/DIP/intermediate.
      const w = isWrist ? 0 : isMcp ? 1.0 : isTip ? 0.4 : 0.7;
      weights[landmark * 2] = w;
      weights[landmark * 2 + 1] = w;
    }
    return weights;
  })();
  const LANDMARK_WEIGHT_SUM = LANDMARK_WEIGHTS.reduce((s, w) => s + w, 0);

  function normalizeHandPose(landmarks) {
    if (!Array.isArray(landmarks) || landmarks.length !== 21
      || landmarks.some((point) => !Number.isFinite(point?.x)
        || !Number.isFinite(point?.y))) return [];
    const wrist = landmarks[0];
    // Robust scale: mean of wrist→MCP distances across the four fingers.
    // Less sensitive to perspective than (palmWidth + palmLength) / 2.
    let scaleSum = 0;
    for (const mcp of MCP_LANDMARKS) {
      scaleSum += Math.hypot(landmarks[mcp].x - wrist.x, landmarks[mcp].y - wrist.y);
    }
    const scale = scaleSum / MCP_LANDMARKS.length;
    if (scale < 1e-6) return [];
    const descriptor = new Array(42);
    for (let i = 0; i < 21; i += 1) {
      descriptor[i * 2] = (landmarks[i].x - wrist.x) / scale;
      descriptor[i * 2 + 1] = (landmarks[i].y - wrist.y) / scale;
    }
    // Canonical rotation: align the wrist→middle-MCP vector with +X axis.
    // This makes the descriptor invariant to planar hand rotation by
    // construction, replacing the previous 7-discrete-angle brute search.
    const mcpIndex = 9 * 2;
    const angle = Math.atan2(descriptor[mcpIndex + 1], descriptor[mcpIndex]);
    const c = Math.cos(-angle);
    const s = Math.sin(-angle);
    for (let i = 0; i < 21; i += 1) {
      const x = descriptor[i * 2];
      const y = descriptor[i * 2 + 1];
      descriptor[i * 2] = x * c - y * s;
      descriptor[i * 2 + 1] = x * s + y * c;
    }
    return descriptor;
  }

  function directPoseDistance(a, b) {
    if (!validDescriptor(a) || !validDescriptor(b)) return Infinity;
    let weightedSquared = 0;
    for (let index = 0; index < a.length; index += 1) {
      const w = LANDMARK_WEIGHTS[index];
      if (w === 0) continue;
      const diff = a[index] - b[index];
      weightedSquared += w * diff * diff;
    }
    return Math.sqrt(weightedSquared / LANDMARK_WEIGHT_SUM);
  }

  // poseDistance is now identical to directPoseDistance because the
  // descriptor is already canonically aligned during normalization.
  // Kept as a named function for backward compatibility with callers
  // that import the symbol.
  function poseDistance(a, b) {
    return directPoseDistance(a, b);
  }

  function median(values) {
    const sorted = values.slice().sort((a, b) => a - b);
    return sorted[Math.floor(sorted.length / 2)];
  }

  function medianDescriptor(frames) {
    return Array.from({ length: 42 }, (_, index) => median(frames.map((frame) => frame[index])));
  }

  function validDescriptor(descriptor) {
    return Array.isArray(descriptor) && descriptor.length === 42 && descriptor.every(Number.isFinite);
  }

  class GestureLibrary {
    constructor(options = {}) {
      this.threshold = Math.max(0.01, options.threshold ?? 0.18);
      this.ambiguityMargin = Math.max(0, options.ambiguityMargin ?? 0.02);
      this.minimumConfidence = clamp(options.minimumConfidence ?? 0.45);
      this.captureStabilityThreshold = Math.max(0.01, options.captureStabilityThreshold ?? 0.08);
      this.holdMs = Math.max(0, options.holdMs ?? 160);
      this.releaseMs = Math.max(0, options.releaseMs ?? 180);
      this.templates = new Map();
      this.incompatibleNames = [];
      this.resetRecognition();
    }

    resetRecognition() {
      this.candidateName = null;
      this.candidateSince = null;
      this.activeName = null;
      this.releaseSince = null;
    }

    learn(name, frames) {
      if (!name || !Array.isArray(frames) || frames.length < 5 || !frames.every(validDescriptor)) {
        throw new Error('Hold the pose still until capture completes');
      }
      const descriptor = medianDescriptor(frames);
      const worstDistance = Math.max(...frames.map((frame) => poseDistance(frame, descriptor)));
      if (worstDistance > this.captureStabilityThreshold) {
        throw new Error('Hold the pose still until capture completes');
      }
      const samples = this.templates.get(name) || [];
      if (samples.length < 3) samples.push(descriptor);
      this.templates.set(name, samples.slice(0, 3));
      return this.sampleCount(name);
    }

    sampleCount(name) {
      return this.templates.get(name)?.length || 0;
    }

    kind(name) {
      return this.sampleCount(name) ? 'pose' : null;
    }

    removeLast(name) {
      const samples = this.templates.get(name) || [];
      samples.pop();
      if (samples.length) this.templates.set(name, samples);
      else this.templates.delete(name);
      this.resetRecognition();
      return samples.length;
    }

    delete(name) {
      this.resetRecognition();
      return this.templates.delete(name);
    }

    getIncompatibleNames() {
      return this.incompatibleNames.slice();
    }

    evaluate(descriptor, targetName = null) {
      if (!validDescriptor(descriptor)) return null;
      const scores = [];
      for (const [name, samples] of this.templates) {
        if (targetName && name !== targetName) continue;
        if (samples.length !== 3) continue;
        const score = median(samples.map((sample) => poseDistance(descriptor, sample)));
        scores.push({ name, score });
      }
      scores.sort((a, b) => a.score - b.score);
      const best = scores[0];
      if (!best) return null;
      const ambiguous = !targetName && Boolean(scores[1]
        && scores[1].score - best.score < this.ambiguityMargin);
      const confidence = clamp(1 - best.score / Math.max(0.0001, this.threshold * 1.5));
      const accepted = best.score <= this.threshold && confidence >= this.minimumConfidence && !ambiguous;
      return {
        name: best.name,
        score: best.score,
        confidence,
        accepted,
        ambiguous,
        candidates: scores.map(({ name, score }) => ({
          name,
          score,
          confidence: clamp(1 - score / Math.max(0.0001, this.threshold * 1.5)),
        })),
      };
    }

    recognize(descriptor, timestamp = Date.now(), targetName = null) {
      const evaluation = this.evaluate(descriptor, targetName);
      if (!evaluation?.accepted) {
        this.candidateName = null;
        this.candidateSince = null;
        if (this.activeName) {
          if (this.releaseSince === null) this.releaseSince = timestamp;
          else if (timestamp - this.releaseSince >= this.releaseMs) {
            this.activeName = null;
            this.releaseSince = null;
          }
        }
        return null;
      }

      this.releaseSince = null;
      if (this.activeName) return null;
      if (this.candidateName !== evaluation.name) {
        this.candidateName = evaluation.name;
        this.candidateSince = timestamp;
        if (this.holdMs > 0) return null;
      }
      if (timestamp - this.candidateSince < this.holdMs) return null;
      this.activeName = evaluation.name;
      this.candidateName = null;
      this.candidateSince = null;
      return { name: evaluation.name, confidence: evaluation.confidence, score: evaluation.score };
    }

    toJSON() {
      return {
        version: 8,
        templates: Array.from(this.templates, ([name, samples]) => ({ name, kind: 'pose', samples })),
      };
    }

    static fromJSON(data, options = {}) {
      const library = new GestureLibrary(options);
      if (Number(data?.version) !== 8) {
        library.incompatibleNames = (data?.templates || [])
          .map((template) => template?.name)
          .filter((name) => typeof name === 'string');
        return library;
      }
      for (const template of data?.templates || []) {
        if (typeof template?.name !== 'string' || !Array.isArray(template.samples)) continue;
        const samples = template.samples.slice(0, 3).filter(validDescriptor);
        if (samples.length) library.templates.set(template.name, samples);
      }
      return library;
    }
  }

  global.SafeInputLayer = {
    SafeSignal,
    GestureLibrary,
    normalizeHandPose,
    poseDistance,
  };
})(typeof window !== 'undefined' ? window : globalThis);
