// vision-processor.js
// Handles dynamic script loading, webcam access, and MediaPipe Hands tracking.

(function (global) {
  'use strict';

  class VisionProcessor {
    constructor() {
      this.video = null;
      this.canvas = null;
      this.ctx = null;
      this.hands = null;
      this.camera = null;
      this.onHandUpdate = null; // Callback: (data) => {}
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
          modelComplexity: 1,
          minDetectionConfidence: 0.5,
          minTrackingConfidence: 0.5
        });

        this.hands.onResults((results) => {
          this.processResults(results);
        });
      }

      if (!this.camera) {
        this.camera = new global.Camera(this.video, {
          onFrame: async () => {
            if (this.active && this.hands) {
              await this.hands.send({ image: this.video });
            }
          },
          width: 320,
          height: 240
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

      if (this.ctx && this.canvas) {
        this.ctx.save();
        this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
        
        // Draw video frame
        if (results.image) {
          this.ctx.drawImage(results.image, 0, 0, this.canvas.width, this.canvas.height);
        }

        if (results.multiHandLandmarks && results.multiHandLandmarks.length > 0) {
          const landmarks = results.multiHandLandmarks[0];
          this.drawLandmarks(landmarks);

          // 1. Center of hand (average of wrist 0, index mcp 5, pinky mcp 17)
          const wrist = landmarks[0];
          const indexMcp = landmarks[5];
          const pinkyMcp = landmarks[17];
          
          const x = (wrist.x + indexMcp.x + pinkyMcp.x) / 3;
          const y = (wrist.y + indexMcp.y + pinkyMcp.y) / 3;

          // 2. Depth/Z-scale (using the distance between wrist and middle finger mcp/tip)
          const middleMcp = landmarks[9];
          const dx = wrist.x - middleMcp.x;
          const dy = wrist.y - middleMcp.y;
          const dz = wrist.z - middleMcp.z;
          const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
          const z = Math.min(1.0, Math.max(0.0, (dist - 0.1) * 3.0));

          // 3. Fist detection (distance from tips of fingers 8, 12, 16, 20 to wrist)
          const tips = [8, 12, 16, 20];
          let closeTipsCount = 0;
          tips.forEach((tIdx) => {
            const tip = landmarks[tIdx];
            const tDx = wrist.x - tip.x;
            const tDy = wrist.y - tip.y;
            const tDist = Math.sqrt(tDx * tDx + tDy * tDy);
            if (tDist < dist * 1.5) {
              closeTipsCount++;
            }
          });
          const isFist = closeTipsCount >= 3;

          if (this.onHandUpdate) {
            this.onHandUpdate({
              x: parseFloat((1.0 - x).toFixed(3)),
              y: parseFloat((1.0 - y).toFixed(3)),
              z: parseFloat(z.toFixed(3)),
              isFist
            });
          }
        }
        this.ctx.restore();
      }
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

})(typeof window !== 'undefined' ? window : globalThis);
