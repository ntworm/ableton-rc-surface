// Copyright © 2026 Gabriel Worm
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Source: https://github.com/ntworm/ableton-rc-surface
//
// modules/layout.js — Tab navigation and page-switching logic
// Extracted from controls.js bootstrapControls → setupTabs().
// Exposes window.RCSurface.setupLayout() called by controls.js.

(function () {
  'use strict';

  window.RCSurface = window.RCSurface || {};

  /**
   * setupLayout — Wire up the top tab bar so clicking a tab switches
   * the visible page. Exposes window.showPhonePage(page) for external callers.
   */
  window.RCSurface.setupLayout = function setupLayout() {
    const DEFAULT_PAGE = 'performance';

    function show(requested) {
      const pages = Array.from(document.querySelectorAll('.page'));
      // "mapping" is a pseudo-page: the MAP overlay sets it and then re-shows
      // the page underneath. It has no .page element of its own, so restoring
      // it on a later load — where that compensation never runs — used to hide
      // every real page and leave a black screen. Only ever switch to a page
      // that actually exists.
      const isRealPage = pages.some((p) => p.dataset.page === requested);
      const page = isRealPage || pages.length === 0 ? requested : DEFAULT_PAGE;

      document.body.dataset.page = page;
      pages.forEach((p) => {
        p.classList.toggle('hidden', p.dataset.page !== page);
      });
      document.querySelectorAll('.tabs .tab').forEach((t) => {
        const active = t.dataset.page === page;
        t.classList.toggle('on', active);
        t.setAttribute('aria-selected', active ? 'true' : 'false');
      });
      // Never persist a pseudo-page: that is what poisoned the next session.
      if (isRealPage && typeof window.sendPhoneCommand === 'function') {
        window.sendPhoneCommand('saveProjectClientState', { pages: { activePage: page } });
      }
      window.dispatchEvent(new CustomEvent('ableton-rc:page-change', {
        detail: { page },
      }));
      setTimeout(() => window.dispatchEvent(new Event('resize')), 100);
    }

    window.showPhonePage = show;

    document.querySelectorAll('.tabs .tab').forEach((t) => {
      t.addEventListener('click', () => show(t.dataset.page));
    });

    show('performance');
  };
})();
