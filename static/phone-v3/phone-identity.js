// Copyright © 2026 Gabriel Worm
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Stable phone identity shared by every localhost/LAN port for this host.
(function (global) {
  'use strict';

  const COOKIE = 'ableton_rc_client_id';
  const STORAGE = 'ableton-rc:client_id';
  const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

  function valid(value) {
    return typeof value === 'string' && UUID.test(value);
  }

  function cookieValue() {
    const prefix = `${COOKIE}=`;
    for (const item of String(document.cookie || '').split(';')) {
      const part = item.trim();
      if (part.startsWith(prefix)) return decodeURIComponent(part.slice(prefix.length));
    }
    return null;
  }

  function persist(value) {
    if (!valid(value)) return null;
    try { localStorage.setItem(STORAGE, value); } catch {}
    document.cookie = `${COOKIE}=${encodeURIComponent(value)}; Path=/; Max-Age=31536000; SameSite=Strict`;
    return value;
  }

  function load() {
    const fromCookie = cookieValue();
    if (valid(fromCookie)) {
      try { localStorage.setItem(STORAGE, fromCookie); } catch {}
      return fromCookie;
    }
    let fromStorage = null;
    try { fromStorage = localStorage.getItem(STORAGE); } catch {}
    return valid(fromStorage) ? persist(fromStorage) : null;
  }

  global.PhoneIdentity = { load, persist, valid };
})(window);
