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

    return { x, y, z, thumb, index, middle, ring, pinky, fist, pinch, pinchVal, victory, open, fingers: fingersNorm };
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
      this.active = false;
    }

    async loadDependencies() {
      if (global.Hands && global.Camera) return;

      const loadScript = (url) => {
        return new Promise((resolve, reject) => {
          const s = document.createElement('script');
          s.src = url;
          s.crossOrigin = 'anonymous';
          s.onload = resolve;
          s.onerror = (e) => reject(new Error(`Failed to load script: ${url}`));
          document.head.appendChild(s);
        });
      };

      try {
        await loadScript('https://cdn.jsdelivr.net/npm/@mediapipe/camera_utils/camera_utils.js');
        await loadScript('https://cdn.jsdelivr.net/npm/@mediapipe/hands/hands.js');
      } catch (err) {
        console.error('Failed to load MediaPipe:', err);
        throw err;
      }
    }

    async start(videoElement, canvasElement) {
      if (this.active) return;
      this.active = true;

      this.video = videoElement;
      this.canvas = canvasElement;
      if (this.canvas) {
        this.ctx = this.canvas.getContext('2d');
      }

      await this.loadDependencies();

      if (!this.hands) {
        this.hands = new global.Hands({
          locateFile: (file) => `https://cdn.jsdelivr.net/npm/@mediapipe/hands/${file}`
        });

        this.hands.setOptions({
          maxNumHands: 1,
          modelComplexity: 0,
          minDetectionConfidence: 0.5,
          minTrackingConfidence: 0.5
        });

        this.hands.onResults((results) => {
          this.processResults(results);
        });
      }

      if (!this.camera) {
        // No FPS cap: send every camera frame to MediaPipe. MediaPipe
        // returns results asynchronously and handles its own backpressure;
        // the previous 12 FPS cap (85ms) throttled good devices and made
        // single-hand tracking feel sluggish on stage.
        this.camera = new global.Camera(this.video, {
          onFrame: async () => {
            if (this.active && this.hands) {
              this.lastSendTime = performance.now();
              await this.hands.send({ image: this.video });
            }
          },
          width: 160,
          height: 120
        });
      }

      await this.camera.start();
    }

    stop() {
      this.active = false;
      if (this.camera) {
        this.camera.stop();
        this.camera = null;
      }
      if (this.hands) {
        this.hands.close();
        this.hands = null;
      }
      if (this.ctx && this.canvas) {
        this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
      }
      this.video = null;
      this.canvas = null;
      this.ctx = null;
    }

    processResults(results) {
      if (!this.active) return;
      if (this.lastSendTime) {
        const latency = performance.now() - this.lastSendTime;
        this.lastSendTime = null;
        if (typeof window !== 'undefined' && window.state && window.state.sensors && window.state.sensors.network) {
          window.state.sensors.network.mpLatency = Math.round(latency);
        }
      }

      if (this.ctx && this.canvas) {
        this.ctx.save();
        this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);

        // Draw video frame
        if (results.image) {
          this.ctx.drawImage(results.image, 0, 0, this.canvas.width, this.canvas.height);
        }

        if (this.onColorUpdate) {
          const avgColor = this.calculateAverageColor();
          this.onColorUpdate(avgColor);
        }

        let handData = null;
        if (results.multiHandLandmarks && results.multiHandLandmarks.length > 0) {
          const landmarks = results.multiHandLandmarks[0];
          this.drawLandmarks(landmarks);
          handData = { active: true, ...computeHandData(landmarks) };
        }

        if (this.onHandUpdate) {
          this.onHandUpdate(handData);
        }
        this.ctx.restore();
      }
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

  global.VisionProcessor = VisionProcessor;
  global.dist3D = dist3D;
  global.computeHandData = computeHandData;

})(typeof window !== 'undefined' ? window : globalThis);
