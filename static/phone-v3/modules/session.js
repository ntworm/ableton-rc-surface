// Copyright © 2026 Gabriel Worm
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Source: https://github.com/ntworm/ableton-rc-surface
//
// modules/session.js — WebSocket session management for RC Surface phone client.
// Extracted from app.js. Manages WS lifecycle, reconnect, heartbeat, and phone commands.
// Exposes window.RCSurface.initSession(options) and the sendPhoneCommand public API.

(function () {
  'use strict';

  window.RCSurface = window.RCSurface || {};

  const PING_MS = 5000;
  const HEARTBEAT_TIMEOUT_MS = 12000;

  // ── Private session state ──────────────────────────────────────────────────
  let ws = null;
  let clientId = null;
  let reconnectDelay = 1000;
  let reconnectTimer = null;
  let lastPongAt = 0;
  let mappingModeActive = false;
  let telemetryThrottleUntil = 0;

  const phoneCommandCallbacks = new Map();
  let phoneCommandSeq = 0;

  // Callbacks wired by app.js via initSession()
  let _onOpen = null;
  let _onMessage = null;
  let _onClose = null;

  // ── Internal helpers ───────────────────────────────────────────────────────

  function dispatchPhoneEvent(name, detail = {}) {
    if (typeof CustomEvent !== 'undefined' && typeof window.dispatchEvent === 'function') {
      window.dispatchEvent(new CustomEvent(name, { detail }));
    } else if (typeof window.dispatchEvent === 'function') {
      try { window.dispatchEvent({ type: name, detail }); } catch (e) {}
    }
  }

  function failPendingPhoneCommands(error) {
    for (const [id, cb] of phoneCommandCallbacks.entries()) {
      const response = { id, ok: false, error };
      try { if (typeof cb === 'function') cb(response); } catch (e) {}
      dispatchPhoneEvent('ableton-rc:phone-command-response', { id, response });
    }
    phoneCommandCallbacks.clear();
  }

  function handlePhoneCommandResponse(msg) {
    if (!msg || typeof msg.id !== 'string') return false;
    if (!msg.id.startsWith('phone-map-')) return false;
    const cb = phoneCommandCallbacks.get(msg.id);
    phoneCommandCallbacks.delete(msg.id);
    if (typeof cb === 'function') cb(msg);
    dispatchPhoneEvent('ableton-rc:phone-command-response', { id: msg.id, response: msg });
    return true;
  }

  function setStatus(text, cls) {
    const el = document.getElementById('status');
    if (!el) return;
    // Hide placeholder during handshake; show only real status
    if (cls === '' && text === '\u26A1 ...') {
      el.textContent = '';
      el.className = 'status status-empty';
      el.title = '';
      return;
    }
    el.textContent = text;
    el.className = 'status ' + (cls || '');
    el.title = cls === 'connected' ? 'Tap to rename' : '';
  }

  // A server that refuses an upgrade destroys the socket, so the browser only
  // ever reports "WebSocket connection failed" with code 1006 and no reason.
  // Ask the server directly why, and put the answer on screen — otherwise the
  // user is left with "RETRY 30s" and nothing to act on.
  let failureProbeInFlight = false;
  function probeConnectionFailure() {
    if (failureProbeInFlight || typeof fetch !== 'function') return;
    failureProbeInFlight = true;
    const search = window.location && window.location.search ? window.location.search : '';
    const token = typeof URLSearchParams !== 'undefined' ? new URLSearchParams(search).get('token') : null;
    const url = '/diag/echo' + (token ? '?token=' + encodeURIComponent(token) : '');
    // POST on purpose: browsers omit the Origin header on same-origin GETs, so
    // only a POST reproduces the header set the refused upgrade carried.
    Promise.resolve(fetch(url, {
      method: 'POST',
      cache: 'no-store',
      body: '{}',
      headers: { 'Content-Type': 'text/plain' },
    }))
      .then((res) => res.json())
      .then((info) => {
        const check = info && info.originCheck;
        if (check && check.ok === false) {
          console.error('[RC Surface] server refused this origin:', check);
          setStatus(`⚠ ORIGIN REJECTED: ${check.reason}`, 'stale');
        } else if (info && info.lastUpgradeRejection) {
          console.error('[RC Surface] last upgrade rejection:', info.lastUpgradeRejection);
        }
      })
      .catch((err) => {
        console.error('[RC Surface] connection diagnostic failed:', err);
      })
      .then(() => { failureProbeInFlight = false; });
  }

  function connect() {
    if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
    // `navigator.onLine` only reports general internet connectivity.  RC
    // Surface intentionally runs on a local LAN, so a Wi-Fi network without
    // internet can still reach the Live server.  Never gate a local WebSocket
    // attempt on this browser hint; let the socket itself determine whether
    // the host/port is reachable and use its normal bounded retry path.
    if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;

    const proto = window.location.protocol === 'https:' ? 'wss' : 'ws';
    const host = window.location.host;
    const stored = window.PhoneIdentity?.load() || null;
    const search = typeof window !== 'undefined' && window.location ? window.location.search : '';
    const token = typeof URLSearchParams !== 'undefined' ? new URLSearchParams(search).get('token') : null;
    let url = `${proto}://${host}/ws` + (stored ? `?client_id=${encodeURIComponent(stored)}` : '');
    if (token) url += (url.includes('?') ? '&' : '?') + `token=${encodeURIComponent(token)}`;

    let socket;
    try {
      socket = new WebSocket(url);
    } catch (err) {
      // Browsers can reject the constructor synchronously (for example when
      // a self-signed certificate has not been accepted yet). Treat that as
      // a normal disconnected state and schedule the same bounded retry used
      // by onclose; never dereference a half-created socket below.
      ws = null;
      window.phoneWs = null;
      console.error('[RC Surface] WebSocket instantiation error:', err);
      setStatus(`\u21bb RETRY ${(reconnectDelay / 1000).toFixed(0)}s`, 'disconnected');
      if (typeof _onClose === 'function') _onClose();
      reconnectTimer = setTimeout(connect, reconnectDelay);
      reconnectDelay = Math.min(reconnectDelay * 2, 30_000);
      return;
    }
    ws = socket;
    window.phoneWs = socket;
    setStatus('\u26A1 ...', '');

    socket.onopen = () => {
      const storedId = window.PhoneIdentity?.load() || null;
      const displayName = localStorage.getItem('ableton-rc:display_name') || '';
      socket.send(JSON.stringify({ type: 'resume', client_id: storedId || null, display_name: displayName || undefined, ts: Date.now() }));
      reconnectDelay = 1000;
      lastPongAt = Date.now();
      dispatchPhoneEvent('ableton-rc:phone-ws-open', { clientId: storedId || null });
      if (typeof _onOpen === 'function') _onOpen({ clientId: storedId });
    };

    socket.onmessage = (e) => {
      try {
        const msg = JSON.parse(e.data);
        if (handlePhoneCommandResponse(msg)) return;

        if (msg.type === 'pong') {
          const rtt = Date.now() - msg.ts;
          lastPongAt = Date.now();
          if (window.state && window.state.sensors) window.state.sensors.network.rtt = rtt;
          return;
        }

        if (msg.type === 'hello') {
          clientId = msg.client_id;
          if (window.state) window.state.role = msg.role || 'viewer';
          dispatchPhoneEvent('ableton-rc:phone-client-id', { clientId, role: msg.role || 'viewer' });
          window.PhoneIdentity?.persist(clientId);
          const name = localStorage.getItem('ableton-rc:display_name') || clientId.slice(0, 8);
          if (msg.tokenStatus === 'stale') {
            // The socket is open, but the token this page was loaded with no
            // longer exists \u2014 tokens are regenerated on every Ableton restart.
            // The session works as a viewer, so transport, pads and knobs are
            // all rejected. Say that plainly instead of showing a healthy
            // "connected" badge the user cannot act on.
            setStatus('\u26A0 SESSION EXPIRED \u2014 RESCAN QR', 'stale');
          } else {
            const roleLabel = msg.role === 'viewer' ? ' (Viewer)' : '';
            setStatus(`\u26A1 ${name}${roleLabel}`, 'connected');
          }
          const savedName = localStorage.getItem('ableton-rc:display_name');
          if (savedName && socket.readyState === WebSocket.OPEN) {
            socket.send(JSON.stringify({ type: 'set_display_name', client_id: clientId, display_name: savedName }));
          }
        }

        if (typeof _onMessage === 'function') _onMessage(msg, { clientId, ws });
      } catch (err) { /* ignore parse errors */ }
    };

    socket.onclose = () => {
      if (ws !== socket) return;
      const neverHandshook = clientId === null;
      ws = null;
      window.phoneWs = null;
      setStatus(`\u21bb RETRY ${(reconnectDelay / 1000).toFixed(0)}s`, 'disconnected');
      // Closing before a single `hello` arrived means the upgrade itself was
      // refused, not that a working session dropped. Find out why.
      if (neverHandshook) probeConnectionFailure();
      clientId = null;
      failPendingPhoneCommands('Connection closed before command response');
      if (typeof window.resetTransientControls === 'function') window.resetTransientControls();
      dispatchPhoneEvent('ableton-rc:phone-ws-close', {});
      if (typeof _onClose === 'function') _onClose();
      reconnectTimer = setTimeout(connect, reconnectDelay);
      reconnectDelay = Math.min(reconnectDelay * 2, 30_000);
    };

    socket.onerror = () => { /* onclose fires next */ };
  }

  function startHeartbeat() {
    setInterval(() => {
      if (ws && ws.readyState === WebSocket.OPEN && clientId) {
        if (lastPongAt && Date.now() - lastPongAt > HEARTBEAT_TIMEOUT_MS) {
          setStatus('\u25cf CONNECTION LOST', 'disconnected');
          ws.close();
          return;
        }
        ws.send(JSON.stringify({ type: 'ping', ts: Date.now() }));
      }
    }, PING_MS);
  }

  // ── Public window APIs (backward-compatible) ───────────────────────────────

  window.isPhoneMappingModeActive = () => mappingModeActive;
  window.setPhoneMappingModeActive = (active) => {
    mappingModeActive = !!active;
    if (!mappingModeActive) telemetryThrottleUntil = 0;
  };
  window.throttlePhoneTelemetry = (durationMs = 1500) => {
    telemetryThrottleUntil = Math.max(telemetryThrottleUntil, Date.now() + durationMs);
  };
  window.getPhoneClientId = () => clientId;
  window.sendPhoneCommand = (cmd, args = {}, cb) => {
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      const response = { ok: false, error: 'Not connected to server' };
      if (typeof cb === 'function') cb(response);
      dispatchPhoneEvent('ableton-rc:phone-command-response', { response });
      return false;
    }
    phoneCommandSeq += 1;
    const id = `phone-map-${phoneCommandSeq}`;
    if (typeof cb === 'function') phoneCommandCallbacks.set(id, cb);
    ws.send(JSON.stringify({ id, cmd, args }));
    return true;
  };

  // Internal getters for app.js sendLoop (replaces IIFE-scoped variable access)
  window.RCSurface.getMappingModeActive = () => mappingModeActive;
  window.RCSurface.getTelemetryThrottleUntil = () => telemetryThrottleUntil;
  // Backward-compat: expose setStatus and connect for attachNetwork / setupClientName
  window.RCSurface._setStatus = setStatus;
  window.RCSurface._connect = connect;

  /**
   * initSession(options) — Start the WebSocket session.
   * @param {object} [options]
   * @param {function} [options.onOpen]    called after WS opens; receives { clientId }
   * @param {function} [options.onMessage] called for each server message after pong/hello handled
   * @param {function} [options.onClose]   called after WS closes
   * @returns {{ getClientId, send, isConnected, setStatus }}
   */
  window.RCSurface.initSession = function initSession(options = {}) {
    _onOpen    = options.onOpen    || null;
    _onMessage = options.onMessage || null;
    _onClose   = options.onClose   || null;

    connect();
    startHeartbeat();

    window.addEventListener('online', () => {
      if (window.state) window.state.sensors.network.online = true;
      setStatus('\u21bb RECONNECTING', 'disconnected');
      if (!ws || ws.readyState === WebSocket.CLOSED) connect();
    });
    window.addEventListener('offline', () => {
      if (window.state) window.state.sensors.network.online = false;
      // Keep an already-open LAN socket alive.  If it is not open, retry
      // immediately; the browser's offline event is not authoritative for a
      // peer on the same local network.
      if (!ws || ws.readyState === WebSocket.CLOSED) {
        setStatus('\u21bb RETRY', 'disconnected');
        connect();
      }
    });

    return {
      getClientId:  () => clientId,
      send:         (data) => ws && ws.readyState === WebSocket.OPEN && ws.send(data),
      isConnected:  () => !!(ws && ws.readyState === WebSocket.OPEN),
      setStatus,
    };
  };
})();
