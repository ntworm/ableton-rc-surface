// Copyright © 2026 Gabriel Worm
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// One retryable owner for a browser MediaStream acquisition.

(function (global) {
  'use strict';

  function stopStream(stream) {
    for (const track of stream?.getTracks?.() || []) track.stop();
  }

  function cancelledError() {
    const error = new Error('Camera start cancelled');
    error.name = 'AbortError';
    return error;
  }

  class CameraLifecycle {
    constructor({ acquire }) {
      if (typeof acquire !== 'function') throw new TypeError('Camera acquire function is required');
      this.acquire = acquire;
      this.state = 'off';
      this.stream = null;
      this.startPromise = null;
      this.generation = 0;
    }

    start() {
      if (this.state === 'running' && this.stream) return Promise.resolve(this.stream);
      if (this.state === 'starting' && this.startPromise) return this.startPromise;

      const generation = ++this.generation;
      this.state = 'starting';
      // Invoke getUserMedia synchronously in the Camera click call stack.
      // Deferring acquire() to a microtask can lose transient user activation
      // on mobile browsers before the permission request is made.
      let acquisition;
      try {
        acquisition = this.acquire();
      } catch (error) {
        this.state = 'error';
        return Promise.reject(error);
      }
      this.startPromise = Promise.resolve(acquisition)
        .then((stream) => {
          if (generation !== this.generation) {
            stopStream(stream);
            throw cancelledError();
          }
          this.stream = stream;
          this.state = 'running';
          return stream;
        })
        .catch((error) => {
          if (generation === this.generation) {
            this.stream = null;
            this.state = error?.name === 'AbortError' ? 'off' : 'error';
          }
          throw error;
        })
        .finally(() => {
          if (generation === this.generation) this.startPromise = null;
        });
      return this.startPromise;
    }

    stop() {
      this.generation += 1;
      this.state = 'stopping';
      stopStream(this.stream);
      this.stream = null;
      this.startPromise = null;
      this.state = 'off';
    }
  }

  const api = { CameraLifecycle, stopStream };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  global.AbletonRcCameraLifecycle = api;
})(typeof window !== 'undefined' ? window : globalThis);
