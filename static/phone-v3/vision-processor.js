// Copyright © 2026 Gabriel Worm
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Source: https://github.com/ntworm/ableton-rc-surface
//
// This file is part of Ableton RC Surface, distributed under the
// PolyForm Noncommercial License 1.0.0. You may obtain a copy of
// the License at https://polyformproject.org/licenses/noncommercial/1.0.0
// vision-processor.js
// Handles dynamic script loading, webcam access, and MediaPipe Hands tracking.

(function (global) {
  'use strict';

  // 3D Euclidean distance between two MediaPipe landmarks. Used to derive
  // finger length ratios that stay stable as the hand moves closer/farther
  // from the camera.
  function dist3D(p1, p2) {
    const dx = p1.x - p2.x;
    const dy = p1.y - p2.y;
    const dz = p1.z - p2.z;
    return Math.sqrt(dx * dx + dy * dy + dz * dz);
  }

  const nowMs = () => global.performance?.now?.() ?? Date.now();

  // Resolve bundled MediaPipe assets against the page that loaded the phone
  // UI. The phone is normally served from /static/phone-v3/, but embedded
  // WebViews and redirected URLs can have a different base path. Relative
  // script URLs then fail with a misleading "Failed to load script" error.
  function resolveAssetUrl(relativeUrl) {
    try {
      const base = global.document?.baseURI || global.location?.href;
      if (base) return new URL(relativeUrl, base).href;
    } catch {
      // Keep the relative fallback for the unit-test harness and old WebViews
      // that do not expose URL/document.baseURI.
    }
    return relativeUrl;
  }

  /**
   * 1€ filter — Casiez, Roussel & Vogel, CHI 2012.
   *
   * A low-pass filter whose cutoff rises with the signal's speed. While the
   * hand is still the cutoff is low, so sensor jitter is damped hard; as the
   * hand accelerates the cutoff opens up, so the output keeps up instead of
   * smearing. A fixed smoother can only trade one for the other.
   *
   * @param minCutoff Hz. Lower = steadier when still. Raise if it feels soft.
   * @param beta      How fast the cutoff opens with speed. Higher = less lag
   *                  on quick moves, at the cost of a little jitter.
   */
  class OneEuroFilter {
    constructor({ minCutoff = 1.0, beta = 1.5, dCutoff = 1.0 } = {}) {
      this.minCutoff = minCutoff;
      this.beta = beta;
      this.dCutoff = dCutoff;
      this.reset();
    }

    reset() {
      this.lastValue = null;
      this.lastFiltered = null;
      this.lastDerivative = 0;
      this.lastTimeMs = null;
    }

    static alpha(cutoffHz, dtSeconds) {
      const tau = 1 / (2 * Math.PI * cutoffHz);
      return 1 / (1 + tau / dtSeconds);
    }

    filter(value, timeMs) {
      if (!Number.isFinite(value)) return this.lastFiltered ?? 0;
      if (this.lastTimeMs === null || this.lastFiltered === null) {
        this.lastTimeMs = timeMs;
        this.lastValue = value;
        this.lastFiltered = value;
        this.lastDerivative = 0;
        return value;
      }
      // Guard against duplicate timestamps: a zero dt would divide by zero.
      const dt = Math.max(1e-3, (timeMs - this.lastTimeMs) / 1000);
      this.lastTimeMs = timeMs;

      const derivative = (value - this.lastValue) / dt;
      const aD = OneEuroFilter.alpha(this.dCutoff, dt);
      this.lastDerivative = this.lastDerivative + aD * (derivative - this.lastDerivative);

      const cutoff = this.minCutoff + this.beta * Math.abs(this.lastDerivative);
      const a = OneEuroFilter.alpha(cutoff, dt);
      this.lastFiltered = this.lastFiltered + a * (value - this.lastFiltered);
      this.lastValue = value;
      return this.lastFiltered;
    }
  }

  function cameraCancellationError() {
    const error = new Error('Camera start was cancelled');
    error.name = 'AbortError';
    return error;
  }

  class ManagedCameraSession {
    constructor(video, options = {}) {
      this.video = video;
      this.options = options;
      this.stream = null;
      this.running = false;
      this.generation = 0;
      this.frameRequest = null;
      this.frameRequestType = null;
      this.framePending = false;
      const CameraLifecycle = global.AbletonRcCameraLifecycle?.CameraLifecycle;
      this.lifecycle = CameraLifecycle ? new CameraLifecycle({
        acquire: () => {
          if (global.location?.protocol === 'http:' && global.location?.hostname !== 'localhost' && global.location?.hostname !== '127.0.0.1') {
            throw new Error('Camera access requires HTTPS in mobile browsers. Please connect using the HTTPS URL from the panel.');
          }
          const mediaDevices = global.navigator?.mediaDevices;
          if (!mediaDevices?.getUserMedia) throw new Error('Camera capture is not supported by this browser or origin is not secure (HTTPS required)');
          return mediaDevices.getUserMedia({
            audio: false,
            video: {
              facingMode: this.options.facingMode || 'user',
              width: { ideal: this.options.width || 160 },
              height: { ideal: this.options.height || 120 },
            },
          });
        },
      }) : null;
      this.startPromise = null;
    }

    releaseStream(stream) {
      for (const track of stream?.getTracks?.() || []) track.stop();
    }

    scheduleFrame() {
      if (!this.running || this.frameRequest !== null) return;
      if (typeof this.video?.requestVideoFrameCallback === 'function') {
        this.frameRequestType = 'video';
        this.frameRequest = this.video.requestVideoFrameCallback(() => this.processFrame());
      } else if (typeof global.requestAnimationFrame === 'function') {
        this.frameRequestType = 'animation';
        this.frameRequest = global.requestAnimationFrame(() => this.processFrame());
      }
    }

    async processFrame() {
      this.frameRequest = null;
      if (!this.running || this.framePending) return this.scheduleFrame();
      this.framePending = true;
      try {
        await this.options.onFrame?.();
      } catch (error) {
        if (this.running) console.warn('Camera frame processing failed:', error);
      } finally {
        this.framePending = false;
        this.scheduleFrame();
      }
    }

    async start() {
      if (this.running && this.stream) return this.stream;
      if (this.startPromise) return this.startPromise;
      this.running = true;
      const generation = ++this.generation;
      this.startPromise = this.startInternal(generation).finally(() => {
        if (generation === this.generation) this.startPromise = null;
      });
      return this.startPromise;
    }

    async startInternal(generation) {
      const mediaDevices = global.navigator?.mediaDevices;
      if (!mediaDevices?.getUserMedia) throw new Error('Camera capture is not supported by this browser');
      const stream = this.lifecycle
        ? await this.lifecycle.start()
        : await mediaDevices.getUserMedia({
            audio: false,
            video: {
              facingMode: this.options.facingMode || 'user',
              width: { ideal: this.options.width || 160 },
              height: { ideal: this.options.height || 120 },
            },
          });
      if (!this.running || generation !== this.generation) {
        this.releaseStream(stream);
        throw cameraCancellationError();
      }
      this.stream = stream;
      this.video.muted = true;
      this.video.playsInline = true;
      this.video.srcObject = stream;
      try {
        await this.video.play?.();
      } catch (error) {
        this.stop();
        throw error;
      }
      if (!this.running || generation !== this.generation) {
        this.stop();
        throw cameraCancellationError();
      }
      this.scheduleFrame();
      return stream;
    }

    stop() {
      this.running = false;
      this.generation += 1;
      if (this.frameRequest !== null) {
        if (this.frameRequestType === 'video') this.video?.cancelVideoFrameCallback?.(this.frameRequest);
        else global.cancelAnimationFrame?.(this.frameRequest);
      }
      this.frameRequest = null;
      this.frameRequestType = null;
      this.framePending = false;
      this.startPromise = null;
      this.lifecycle?.stop();
      this.releaseStream(this.stream);
      const attachedStream = this.video?.srcObject;
      if (attachedStream && attachedStream !== this.stream) this.releaseStream(attachedStream);
      this.stream = null;
      this.video?.pause?.();
      if (this.video) {
        this.video.onloadedmetadata = null;
        this.video.srcObject = null;
      }
    }
  }

  // Pure helper: derive the 14 scalar features for one hand from its 21
  // MediaPipe landmarks. Pulled out of processResults so unit tests can
  // exercise it without spinning up MediaPipe or a canvas.
  function computeHandData(landmarks) {
    const palmSize = dist3D(landmarks[0], landmarks[9]) || 0.1;

    const rawX = (landmarks[0].x + landmarks[5].x + landmarks[17].x) / 3;
    const rawY = (landmarks[0].y + landmarks[5].y + landmarks[17].y) / 3;
    const x = parseFloat((1.0 - rawX).toFixed(3));
    const y = parseFloat((1.0 - rawY).toFixed(3));
    const z = parseFloat(Math.min(1.0, Math.max(0.0, (palmSize - 0.1) * 4.0)).toFixed(3));

    const stretch = (dist, base, span) => {
      const ratio = dist / palmSize;
      return parseFloat(Math.max(0.0, Math.min(1.0, (ratio - base) / span)).toFixed(3));
    };
    // Thumb uses tip↔wrist (same reference as the other fingers) so that
    // collapsing the tip onto the wrist also collapses the stretch to 0.
    // tip↔MCP kept the ratio high even on a closed fist because the thumb
    // MCP stays planted in the palm.
    const thumb  = stretch(dist3D(landmarks[4],  landmarks[0]),  0.55, 0.5);
    const index  = stretch(dist3D(landmarks[8],  landmarks[0]),  0.8,  0.85);
    const middle = stretch(dist3D(landmarks[12], landmarks[0]),  0.85, 0.95);
    const ring   = stretch(dist3D(landmarks[16], landmarks[0]),  0.8,  0.85);
    const pinky  = stretch(dist3D(landmarks[20], landmarks[0]),  0.75, 0.75);

    const pinchRatio = palmSize > 0 ? dist3D(landmarks[4], landmarks[8]) / palmSize : 1;
    // Analog pinch intensity: 0 when fingers are spread (ratio ~1), 1 when
    // tips touch (ratio ~0.1). The (0.60, 0.50) window maps the usable
    // pinch travel so the curve stays smooth across hand sizes.
    const pinchVal = parseFloat(Math.max(0.0, Math.min(1.0, (0.60 - pinchRatio) / 0.50)).toFixed(3));
    // Boolean gate for downstream trigger-style consumers. Threshold 0.75
    // keeps accidental near-pinches from flipping the gate.
    const pinch = pinchVal > 0.75;

    const fist    = index < 0.35 && middle < 0.35 && ring < 0.35 && pinky < 0.35;
    const victory = index > 0.65 && middle > 0.65 && ring < 0.35 && pinky < 0.35;
    const open    = thumb > 0.65 && index > 0.65 && middle > 0.65 && ring > 0.65 && pinky > 0.65;
    // Wrist rotation reading from the palm base anchors (MCP joints).
    // We use the index MCP (landmark 5) and pinky MCP (landmark 17)
    // because fingertips collapse during a Victory pose — the thumb and
    // pinky tips fold onto the palm when the user is making a V, so
    // their angle would oscillate wildly. The MCPs are anchored in the
    // palm skeleton and stay put through the whole gesture.
    //
    // The vector index_MCP → pinky_MCP lies horizontal when the palm is
    // flat; atan2(dy, dx) measures how far that vector has rotated. We
    // normalize the [-π/2, π/2] atan2 range into [0, 1] so 0.5 sits at
    // the horizontal neutral and the value drifts toward 0.0 or 1.0 as
    // the wrist pronates / supinates.
    //
    // MediaPipe's y axis grows downward, so dy=index_MCP.y−pinky_MCP.y
    // is positive when the index MCP sits below the pinky MCP on the
    // image (palm tilted so the thumb side drops).
    //
    // The reading is computed unconditionally every frame; the app.js
    // pipeline latches it onto the wire only while the Victory pose is
    // active and pins it back to 0.5 otherwise.
    let rotateVal;
    {
      const dy = landmarks[5].y - landmarks[17].y;
      const dx = landmarks[17].x - landmarks[5].x;
      const angle = Math.atan2(dy, dx);
      const normalized = angle / (Math.PI / 2);
      rotateVal = parseFloat(Math.max(0, Math.min(1, normalized * 0.5 + 0.5)).toFixed(3));
    }

    let fingers = 0;
    if (thumb  > 0.65) fingers++;
    if (index  > 0.65) fingers++;
    if (middle > 0.65) fingers++;
    if (ring   > 0.65) fingers++;
    if (pinky  > 0.65) fingers++;
    // Normalized finger count travels on the wire as 0.0–1.0 so the same
    // channel can be mapped to any continuous parameter (filter cutoff,
    // send level, etc) without the caller needing to know the 0–5 range.
    // The PC panel multiplies back by 5 for display purposes.
    const fingersNorm = parseFloat((fingers / 5).toFixed(3));

    return { x, y, z, thumb, index, middle, ring, pinky, fist, pinch, pinchVal, victory, open, rotateVal, fingers: fingersNorm };
  }

  class VisionProcessor {
    constructor() {
      this.video = null;
      this.canvas = null;
      this.ctx = null;
      this.hands = null;
      this.camera = null;
      this.onHandUpdate = null; // Callback: (data) => {}
      this.onColorUpdate = null; // Callback: (data) => {}
      this.onGesture = null; // Callback: ({name, confidence}) => {}
      this.onGestureProgress = null; // Callback: ({name, confidence, accepted}) => {}
      this.onVisionStatus = null; // Callback: (visionStatus) => {}
      this.active = false;
      this.wasHandPresent = false;
      // Observable pipeline state. "Camera shows video" and "MediaPipe is
      // actually running" are independent: the preview can look perfect while
      // inference is dead. Each stage is tracked separately so the UI can say
      // which one failed instead of silently showing a live preview forever.
      //   idle → starting → waiting-hand ⇄ hand-detected
      //                          ↘ error
      this.visionStatus = {
        stage: 'idle',
        cameraActive: false,
        mediapipeLoaded: false,
        framesSent: 0,
        resultsReceived: 0,
        lastError: null,
      };
      const safe = global.SafeInputLayer;
      // Spatial tracking was retired: x/y/z no longer exist and there is
      // no need for an inertial prediction buffer. Static hand-shape
      // gestures are detected directly from MediaPipe landmarks.
      this.gestures = safe ? new safe.GestureLibrary() : null;
      this.gestureLearnName = null;
      this.gestureTestName = null;
      this.gestureLearnFrames = [];
      this.colorSampleIntervalMs = 120;
      this.lastColorSampleAt = -Infinity;
      this.lastGestureProgressAt = -Infinity;
      // MediaPipe confidence threshold; default to medium (0.5). The UI
      // confidence selector calls setConfidence() before the camera
      // starts, so the first hands.send already uses the chosen preset.
      this.confidence = 0.5;
      // One filter per position axis. Jitter on a still hand is what made
      // mapped parameters buzz; raw frames on a fast hand are what made them
      // jump. The 1€ filter is the standard answer to both at once.
      this.positionFilters = {
        x: new OneEuroFilter(),
        y: new OneEuroFilter(),
        // Depth is the noisiest channel (it is derived from palm size), so it
        // gets a lower floor and opens a little more reluctantly.
        z: new OneEuroFilter({ minCutoff: 0.8, beta: 1.0 }),
      };
    }

    /** Smooth the hand position in place. Returns the same shape it was given. */
    filterHandPosition(data, timeMs) {
      if (!data) return data;
      data.x = this.positionFilters.x.filter(data.x, timeMs);
      data.y = this.positionFilters.y.filter(data.y, timeMs);
      data.z = this.positionFilters.z.filter(data.z, timeMs);
      return data;
    }

    /** Merge a patch into visionStatus and publish it to the UI. */
    setVisionStatus(patch) {
      Object.assign(this.visionStatus, patch);
      if (typeof this.onVisionStatus === 'function') {
        try { this.onVisionStatus(this.visionStatus); } catch (e) { /* UI must never break the pipeline */ }
      }
    }

    // Map the three UI presets to MediaPipe's minDetection / minTracking
    // confidence values. The medium default is the library default; the
    // low preset exists for the worm's low-light performance setup where
    // MediaPipe otherwise refuses to detect any hand.
    /**
     * Detection and tracking want opposite things. Detection decides whether a
     * hand is there at all, so it should stay strict or the model latches onto
     * background clutter. Tracking only decides whether to keep following a
     * hand it already found, so it should be forgiving — a hand smeared by
     * fast motion still scores poorly for a frame or two. Driving both from
     * one preset meant CONF=High dropped the hand exactly when moving quickly.
     */
    trackingConfidenceFor(detectionConfidence) {
      return Math.max(0.1, Math.min(detectionConfidence - 0.15, detectionConfidence * 0.5));
    }

    setConfidence(preset) {
      const table = { low: 0.2, medium: 0.5, high: 0.7 };
      this.confidence = table[preset] ?? 0.5;
      if (this.hands) {
        this.hands.setOptions({
          minDetectionConfidence: this.confidence,
          minTrackingConfidence: this.trackingConfidenceFor(this.confidence),
        });
      }
      return this.confidence;
    }

    setGestureOptions(options = {}) {
      if (!this.gestures) return;
      if (Number.isFinite(options.threshold)) this.gestures.threshold = Math.max(0.01, Number(options.threshold));
      if (Number.isFinite(options.ambiguityMargin)) this.gestures.ambiguityMargin = Math.max(0, Number(options.ambiguityMargin));
      if (Number.isFinite(options.minimumConfidence)) this.gestures.minimumConfidence = Math.max(0, Math.min(1, Number(options.minimumConfidence)));
      if (Number.isFinite(options.holdMs)) this.gestures.holdMs = Math.max(0, Number(options.holdMs));
      if (Number.isFinite(options.releaseMs)) this.gestures.releaseMs = Math.max(0, Number(options.releaseMs));
      if (Number.isFinite(options.captureStabilityThreshold)) {
        this.gestures.captureStabilityThreshold = Math.max(0.01, Number(options.captureStabilityThreshold));
      }
    }

    beginGestureLearn(name) {
      if (!name || typeof name !== 'string') throw new Error('Gesture name is required');
      this.clearGestureHistory();
      this.gestureLearnName = name.trim();
      this.gestureLearnFrames = [];
    }

    clearGestureHistory() {
      this.gestures?.resetRecognition?.();
      this.lastGestureProgressAt = -Infinity;
    }

    finishGestureLearn() {
      const name = this.gestureLearnName;
      const frames = this.gestureLearnFrames;
      this.gestureLearnName = null;
      this.gestureLearnFrames = [];
      if (!name || frames.length < 5 || !this.gestures) return 0;
      return this.gestures.learn(name, frames);
    }

    gestureSampleCount(name) {
      return this.gestures?.sampleCount(name) || 0;
    }

    gestureKind(name) {
      return this.gestures?.kind(name) || null;
    }

    removeLastGestureTake(name) {
      return this.gestures?.removeLast(name) || 0;
    }

    deleteGesture(name) {
      return this.gestures?.delete(name) || false;
    }

    beginGestureTest(name) {
      this.clearGestureHistory();
      this.gestureTestName = typeof name === 'string' ? name : null;
    }

    endGestureTest() {
      this.gestureTestName = null;
      this.clearGestureHistory();
    }

    recognizeGesture(descriptor, timestamp = Date.now(), targetName = null) {
      return this.gestures?.recognize(descriptor, timestamp, targetName) || null;
    }

    processHandData(rawData, timestamp = Date.now(), landmarks = null) {
      if (!rawData) return null;
      // No spatial tracker / calibrator: preserve the direct normalized
      // X/Y/palm-size-depth controls without prediction or 3D calibration.
      const output = {
        ...rawData,
        x: Math.max(0, Math.min(1, Number(rawData.x) || 0)),
        y: Math.max(0, Math.min(1, Number(rawData.y) || 0)),
        z: Math.max(0, Math.min(1, Number(rawData.z) || 0)),
        active: true,
        observed: true,
        projected: false,
        trackingState: 'active',
        confidence: rawData.confidence ?? 1,
      };
      const descriptor = global.SafeInputLayer?.normalizeHandPose?.(landmarks) || [];
      if (this.gestureLearnName && descriptor.length) {
        this.gestureLearnFrames.push(descriptor);
      } else if (descriptor.length) {
        const evaluation = this.gestures?.evaluate(descriptor, this.gestureTestName);
        if (evaluation && this.onGestureProgress
          && (evaluation.accepted || timestamp - this.lastGestureProgressAt >= 100)) {
          this.lastGestureProgressAt = timestamp;
          this.onGestureProgress(evaluation);
        }
        const match = this.recognizeGesture(descriptor, timestamp, this.gestureTestName);
        if (match && this.onGesture) this.onGesture(match);
      }
      return output;
    }

    processMissing(timestamp = Date.now()) {
      // Spatial tracking was retired, so the inertial predictor is gone.
      // Mark the gesture library as having seen a missing frame so its
      // hold/release logic can reset, but emit nothing on the wire.
      this.gestures?.recognize(null, timestamp, this.gestureTestName);
      return null;
    }

    exportSafetyConfig() {
      return {
        version: 2,
        confidence: this.confidence,
        gestureOptions: this.gestures ? {
          threshold: this.gestures.threshold,
          ambiguityMargin: this.gestures.ambiguityMargin,
          minimumConfidence: this.gestures.minimumConfidence,
          captureStabilityThreshold: this.gestures.captureStabilityThreshold,
          holdMs: this.gestures.holdMs,
          releaseMs: this.gestures.releaseMs,
        } : {},
        gestures: this.gestures?.toJSON() || { version: 8, templates: [] },
      };
    }

    importSafetyConfig(config) {
      const safe = global.SafeInputLayer;
      if (!safe || !config) return;
      this.confidence = Number.isFinite(config.confidence) ? config.confidence : 0.5;
      this.gestures = safe.GestureLibrary.fromJSON(config.gestures, config.gestureOptions || {});
    }

    async loadDependencies() {
      if (global.Hands && global.Camera) return;

      const loadScript = (url) => {
        return new Promise((resolve, reject) => {
          const s = document.createElement('script');
          s.src = resolveAssetUrl(url);
          s.onload = resolve;
          s.onerror = (e) => reject(new Error(`Failed to load script: ${url}`));
          document.head.appendChild(s);
        });
      };

      try {
        await loadScript('vendor/mediapipe/camera_utils/camera_utils.js');
        await loadScript('vendor/mediapipe/hands/hands.js');
      } catch (err) {
        console.error('Failed to load MediaPipe:', err);
        throw err;
      }
    }

    async start(videoElement, canvasElement) {
      if (this.active) return;
      this.active = true;
      this.lastColorSampleAt = -Infinity;
      this.setVisionStatus({
        stage: 'starting',
        cameraActive: false,
        mediapipeLoaded: false,
        framesSent: 0,
        resultsReceived: 0,
        lastError: null,
      });

      this.video = videoElement;
      this.canvas = canvasElement;
      if (this.canvas) {
        this.ctx = this.canvas.getContext('2d');
      }

      try {
        const hasNativeCapture = Boolean(global.navigator?.mediaDevices?.getUserMedia);
        const cameraOptions = {
          onFrame: async () => {
            if (this.active && this.ctx && this.canvas && this.video && this.video.readyState >= 2) {
              this.ctx.save();
              this.ctx.drawImage(this.video, 0, 0, this.canvas.width, this.canvas.height);
              this.ctx.restore();
            }
            if (this.active && this.hands) {
              this.lastSendTime = nowMs();
              try {
                await this.hands.send({ image: this.video });
                this.setVisionStatus({ framesSent: this.visionStatus.framesSent + 1 });
              } catch (err) {
                // Do NOT let this bubble into the camera loop's generic
                // console.warn. A failing inference used to be invisible: the
                // preview kept rendering and the user was told nothing.
                const detail = err && err.message ? err.message : String(err);
                console.error('[RC Surface] MediaPipe inference failed:', detail);
                this.setVisionStatus({ stage: 'error', lastError: detail });
              }
            }
          },
          // 160x120 left a fast-moving hand as a handful of blurred pixels,
          // which is why tracking dropped it mid-gesture. 320x240 is four
          // times the pixels and still cheap for modelComplexity 0.
          width: 320,
          height: 240,
        };
        const startCamera = async (CameraController) => {
          if (!this.camera) this.camera = new CameraController(this.video, cameraOptions);
          const camera = this.camera;
          const previousAlert = global.alert;
          if (typeof previousAlert === 'function') global.alert = () => {};
          try {
            await camera.start();
            if (!this.active || this.camera !== camera) {
              camera.stop();
              throw cameraCancellationError();
            }
          } finally {
            if (typeof previousAlert === 'function') global.alert = previousAlert;
          }
        };

        // Acquire the native stream directly inside the user's tap. On a
        // first visit MediaPipe still needs to load; waiting for it first can
        // lose the browser's transient activation and leave CAMERA OFF.
        if (hasNativeCapture) {
          await startCamera(ManagedCameraSession);
          this.setVisionStatus({ cameraActive: true });
        }

        await this.loadDependencies();
        if (!this.active) throw cameraCancellationError();
        this.setVisionStatus({ mediapipeLoaded: true });

        if (!this.hands) {
          this.hands = new global.Hands({
            locateFile: (file) => resolveAssetUrl(`vendor/mediapipe/hands/${file}`)
          });

          this.hands.setOptions({
            maxNumHands: 1,
            modelComplexity: 0,
            minDetectionConfidence: this.confidence,
            minTrackingConfidence: this.trackingConfidenceFor(this.confidence),
          });

          this.hands.onResults((results) => {
            this.processResults(results);
          });
        }

        // Tests and very old browsers without native mediaDevices keep the
        // bundled camera_utils fallback, after its constructor has loaded.
        if (!hasNativeCapture) {
          await startCamera(global.Camera);
          this.setVisionStatus({ cameraActive: true });
        }
        this.setVisionStatus({ stage: 'waiting-hand' });
      } catch (error) {
        const detail = error && error.message ? error.message : String(error);
        this.stop();
        if (!error || error.name !== 'AbortError') {
          this.setVisionStatus({ stage: 'error', lastError: detail });
        }
        throw error;
      }
    }

    stop() {
      this.active = false;
      this.setVisionStatus({ stage: 'idle', cameraActive: false, mediapipeLoaded: false });
      if (this.camera) {
        this.camera.stop();
        this.camera = null;
      }
      if (this.hands) {
        this.hands.close();
        this.hands = null;
      }
      // Drop filter history: resuming later must not ease out of a stale
      // position recorded before the camera was switched off.
      for (const filter of Object.values(this.positionFilters)) filter.reset();
      if (this.ctx && this.canvas) {
        this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
      }
      this.video = null;
      this.canvas = null;
      this.ctx = null;
    }

    processResults(results, frameTimestamp = nowMs()) {
      if (!this.active) return;
      if (this.lastSendTime) {
        const latency = nowMs() - this.lastSendTime;
        this.lastSendTime = null;
        if (typeof window !== 'undefined' && window.state && window.state.sensors && window.state.sensors.network) {
          window.state.sensors.network.mpLatency = Math.round(latency);
        }
      }

      // Rendering is optional.  Detection and wire-control updates must keep
      // running even when a WebView cannot create a 2D canvas context (for
      // example with hardware acceleration disabled).  Previously all hand
      // processing lived inside this block, so the camera could be visible
      // while every vision mapping stayed permanently inactive.
      const canRender = Boolean(this.ctx && this.canvas);
      if (canRender) {
        this.ctx.save();
        this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);

        // Draw video frame
        if (results.image) {
          this.ctx.drawImage(results.image, 0, 0, this.canvas.width, this.canvas.height);
        }

        if (this.onColorUpdate && frameTimestamp - this.lastColorSampleAt >= this.colorSampleIntervalMs) {
          const avgColor = this.calculateAverageColor();
          this.onColorUpdate(avgColor);
          this.lastColorSampleAt = frameTimestamp;
        }
      }

      const sawHand = Boolean(results.multiHandLandmarks && results.multiHandLandmarks.length > 0);
      // Results arriving at all proves the pipeline is alive; whether a hand is
      // present is a separate fact. Keeping them distinct is what lets the UI
      // say "waiting for hand" instead of leaving the user guessing.
      this.setVisionStatus({
        resultsReceived: this.visionStatus.resultsReceived + 1,
        stage: sawHand ? 'hand-detected' : 'waiting-hand',
        lastError: null,
      });

      let handData = null;
      if (sawHand) {
        if (!this.wasHandPresent) {
          // Re-entry! Hack the filters to pretend the time difference was only 33ms,
          // and reset the derivative to 0 so they don't open up and snap.
          const fakeLastTime = frameTimestamp - 33;
          for (const filter of Object.values(this.positionFilters)) {
            if (filter.lastTimeMs !== null) {
              filter.lastTimeMs = fakeLastTime;
              filter.lastDerivative = 0;
            }
          }
        }
        this.wasHandPresent = true;
        const landmarks = results.multiHandLandmarks[0];
        if (canRender) this.drawLandmarks(landmarks);
        // Filter the position before anything downstream reads it, so the
        // gesture layer, the HUD and the wire all see the same steady value.
        const raw = this.filterHandPosition(computeHandData(landmarks), frameTimestamp);
        handData = this.processHandData(raw, frameTimestamp, landmarks);
      } else {
        this.wasHandPresent = false;
        handData = this.processMissing(frameTimestamp);
      }

      if (this.onHandUpdate) {
        this.onHandUpdate(handData);
      }
      if (canRender) this.ctx.restore();
    }

    calculateAverageColor() {
      if (!this.ctx || !this.canvas) return { r: 0, g: 0, b: 0 };
      
      const width = this.canvas.width;
      const height = this.canvas.height;
      let imgData;
      try {
        imgData = this.ctx.getImageData(0, 0, width, height);
      } catch (e) {
        return { r: 0, g: 0, b: 0 };
      }
      
      const data = imgData.data;
      let rSum = 0, gSum = 0, bSum = 0, count = 0;
      
      const step = 16; 
      for (let y = 0; y < height; y += step) {
        for (let x = 0; x < width; x += step) {
          const idx = (y * width + x) * 4;
          rSum += data[idx];
          gSum += data[idx + 1];
          bSum += data[idx + 2];
          count++;
        }
      }
      
      if (count === 0) return { r: 0, g: 0, b: 0 };
      
      return {
        r: parseFloat((rSum / count / 255).toFixed(3)),
        g: parseFloat((gSum / count / 255).toFixed(3)),
        b: parseFloat((bSum / count / 255).toFixed(3))
      };
    }

    drawLandmarks(landmarks) {
      this.ctx.fillStyle = '#ff9f0a';
      this.ctx.strokeStyle = '#ffffff';
      this.ctx.lineWidth = 2;

      // Draw connection lines
      const connections = [
        [0, 1], [1, 2], [2, 3], [3, 4], // thumb
        [0, 5], [5, 6], [6, 7], [7, 8], // index
        [5, 9], [9, 10], [10, 11], [11, 12], // middle
        [9, 13], [13, 14], [14, 15], [15, 16], // ring
        [13, 17], [0, 17], [17, 18], [18, 19], [19, 20] // pinky
      ];

      connections.forEach(([s, e]) => {
        const startPoint = landmarks[s];
        const endPoint = landmarks[e];
        this.ctx.beginPath();
        this.ctx.moveTo(startPoint.x * this.canvas.width, startPoint.y * this.canvas.height);
        this.ctx.lineTo(endPoint.x * this.canvas.width, endPoint.y * this.canvas.height);
        this.ctx.stroke();
      });

      // Draw dots
      landmarks.forEach((lm) => {
        this.ctx.beginPath();
        this.ctx.arc(lm.x * this.canvas.width, lm.y * this.canvas.height, 4, 0, 2 * Math.PI);
        this.ctx.fill();
      });
    }
  }

  global.OneEuroFilter = OneEuroFilter;
  global.ManagedCameraSession = ManagedCameraSession;
  global.VisionProcessor = VisionProcessor;
  global.dist3D = dist3D;
  global.computeHandData = computeHandData;

})(typeof window !== 'undefined' ? window : globalThis);
