// Copyright © 2026 Gabriel Worm
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Source: https://github.com/ntworm/ableton-rc-surface
//
// modules/sync.js — Sync mode toggle UI for RC Surface phone client.
// Extracted from controls.js setupSyncModeUI().

(function () {
  'use strict';

  window.RCSurface = window.RCSurface || {};

  window.RCSurface.setupSync = function setupSync() {
    const btn = document.getElementById('btn-sync-mode');
    if (!btn) return;
    btn.addEventListener('click', () => {
      window.syncMode = (window.syncMode === 'sync') ? 'free' : 'sync';
      btn.textContent = window.syncMode.toUpperCase();
      btn.className = `sync-mode-btn ${window.syncMode}`;

      // Restore session BPM if toggling back to sync
      if (window.syncMode === 'sync') {
        const bpmEl = document.getElementById('live-bpm');
        if (typeof window.lastSessionBpm === 'number') {
          window.currentBpm = window.lastSessionBpm;
          if (bpmEl) bpmEl.textContent = `${window.currentBpm.toFixed(1)} BPM`;
        } else {
          window.currentBpm = 120;
          if (bpmEl) bpmEl.textContent = `120.0 BPM`;
        }
      }
      if (typeof window.emitAllModulatorStates === 'function') {
        window.emitAllModulatorStates();
      }
    });
  };
})();
