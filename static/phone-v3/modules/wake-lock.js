// Copyright © 2026 Gabriel Worm
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Source: https://github.com/ntworm/ableton-rc-surface
//
// modules/wake-lock.js — Wake Lock & Toast notifications for RC Surface phone client.
// Extracted from app.js.

(function () {
  'use strict';

  window.RCSurface = window.RCSurface || {};

  let wakeLock = null;

  async function requestWakeLock() {
    if (typeof navigator === 'undefined' || !navigator.wakeLock || typeof navigator.wakeLock.request !== 'function') {
      return null;
    }
    try {
      wakeLock = await navigator.wakeLock.request('screen');
      console.log('Wake Lock is active');
      return wakeLock;
    } catch (err) {
      console.error(`Wake Lock failed: ${err?.name}, ${err?.message}`);
      return null;
    }
  }

  let wakeLockInitialized = false;

  function setupWakeLock() {
    if (typeof window === 'undefined' || typeof document === 'undefined') return;
    if (wakeLockInitialized) return;
    wakeLockInitialized = true;

    const requestWakeLockOnce = async () => {
      await requestWakeLock();
      document.removeEventListener('touchstart', requestWakeLockOnce);
      document.removeEventListener('mousedown', requestWakeLockOnce);
    };
    document.addEventListener('touchstart', requestWakeLockOnce, { passive: true });
    document.addEventListener('mousedown', requestWakeLockOnce, { passive: true });

    document.addEventListener('visibilitychange', async () => {
      if (wakeLock !== null && document.visibilityState === 'visible') {
        await requestWakeLock();
      }
    });
  }

  function showToast(message, type = 'info') {
    if (typeof document === 'undefined' || typeof document.createElement !== 'function') {
      console.log(`[Toast] [${type}] ${message}`);
      return;
    }
    let toastContainer = document.getElementById('toast-container');
    if (!toastContainer) {
      toastContainer = document.createElement('div');
      toastContainer.id = 'toast-container';
      toastContainer.style.position = 'fixed';
      toastContainer.style.top = '70px';
      toastContainer.style.left = '50%';
      toastContainer.style.transform = 'translateX(-50%)';
      toastContainer.style.zIndex = '9999';
      toastContainer.style.display = 'flex';
      toastContainer.style.flexDirection = 'column';
      toastContainer.style.gap = '8px';
      toastContainer.style.pointerEvents = 'none';
      document.body.appendChild(toastContainer);
    }

    const toast = document.createElement('div');
    toast.className = `toast toast-${type}`;
    toast.textContent = message;
    toast.style.padding = '6px 12px';
    toast.style.borderRadius = '4px';
    toast.style.fontSize = '10px';
    toast.style.fontWeight = 'bold';
    toast.style.color = '#fff';
    toast.style.boxShadow = '0 2px 8px rgba(0,0,0,0.5)';
    toast.style.opacity = '0';
    toast.style.transition = 'opacity 0.2s ease, transform 0.2s ease';
    toast.style.transform = 'translateY(5px)';

    if (type === 'error') {
      toast.style.background = '#ff4a4a';
    } else if (type === 'warning') {
      toast.style.background = '#ffaa00';
    } else if (type === 'success') {
      toast.style.background = '#00c853';
    } else {
      toast.style.background = '#00e5ff';
    }

    toastContainer.appendChild(toast);

    toast.offsetHeight;
    toast.style.opacity = '1';
    toast.style.transform = 'translateY(0)';

    setTimeout(() => {
      toast.style.opacity = '0';
      toast.style.transform = 'translateY(-5px)';
      setTimeout(() => {
        toast.remove();
      }, 200);
    }, 2000);
  }

  // Public API
  window.showToast = showToast;
  window.RCSurface.showToast = showToast;
  window.RCSurface.requestWakeLock = requestWakeLock;
  window.RCSurface.setupWakeLock = setupWakeLock;
})();
