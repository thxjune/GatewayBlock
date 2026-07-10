/**
 * GatewayBlock — YouTube Shorts removal (isolated world)
 *
 * Owns the `data-gb-noshorts` attribute on <html>. All hiding in
 * styles/youtube-noshorts.css is scoped under that attribute, and the
 * MAIN-world pruner checks it too, so this one attribute is the single
 * live switch: the popup writes `hideShorts` to storage.local and this
 * script flips the attribute on every open tab instantly — no reload.
 *
 * Three layers, so any one alone still mostly works:
 *  1. The attribute + CSS (instant, handles ~everything).
 *  2. A MutationObserver that removes what CSS can't express —
 *     text-matched "Shorts" chips, guide entries in non-English UIs —
 *     and anything :has() misses.
 *  3. A redirect: /shorts/<id> (pasted link or SPA navigation) is
 *     rewritten to /watch?v=<id>, so Shorts open as normal videos.
 *
 * Default is ON: the attribute is set synchronously at document_start
 * (before YouTube renders anything) and only removed if storage says
 * the user turned the feature off. That ordering guarantees no flash
 * of Shorts for the default state.
 */

(() => {
  "use strict";

  const api = globalThis.browser ?? globalThis.chrome;
  const ATTR = "data-gb-noshorts";
  const root = document.documentElement;

  let enabled = true; // default ON — a missing key means ON

  // ---------------------------------------------------------------
  // Attribute control
  // ---------------------------------------------------------------
  function apply() {
    if (enabled) {
      root.setAttribute(ATTR, "");
      startObserver();
      redirectIfShorts();
    } else {
      root.removeAttribute(ATTR);
      stopObserver();
    }
  }

  // Optimistic: set before storage answers so nothing flashes.
  root.setAttribute(ATTR, "");

  api.storage.local.get("hideShorts").then((res) => {
    enabled = res.hideShorts !== false;
    apply();
  });

  api.storage.onChanged.addListener((changes, area) => {
    if (area !== "local" || !("hideShorts" in changes)) return;
    enabled = changes.hideShorts.newValue !== false;
    apply();
  });

  // ---------------------------------------------------------------
  // Redirect: open Shorts as normal watch pages (top frame only)
  // ---------------------------------------------------------------
  function redirectIfShorts() {
    if (!enabled || window !== window.top) return;
    const m = location.pathname.match(/^\/shorts\/([A-Za-z0-9_-]{5,})/);
    if (m) location.replace("/watch?v=" + m[1]);
  }

  // YouTube is a SPA — its own navigation events fire in both worlds.
  window.addEventListener("yt-navigate-start", redirectIfShorts, true);
  window.addEventListener("yt-navigate-finish", redirectIfShorts, true);

  // ---------------------------------------------------------------
  // JS fallback removal — only what CSS can't reach
  // ---------------------------------------------------------------
  // Containers that are Shorts by structure. Mirrors the CSS so pages
  // where :has() misbehaves still get cleaned.
  const REMOVE_SELECTORS = [
    "ytd-reel-shelf-renderer",
    "ytd-rich-shelf-renderer[is-shorts]",
    "ytm-shorts-lockup-view-model",
    "ytm-shorts-lockup-view-model-v2",
    "yt-tab-shape[tab-title='Shorts']"
  ];

  // "Shorts" is YouTube's brand name and stays untranslated in nearly
  // every locale, so text matching covers non-English UIs where the
  // CSS title="" hooks miss.
  const TEXT_MATCH_SELECTORS = [
    "yt-chip-cloud-chip-renderer",          // filter chips
    "ytd-guide-entry-renderer",             // left guide
    "ytd-mini-guide-entry-renderer"         // collapsed guide
  ];

  function sweep() {
    if (!enabled) return;

    for (const sel of REMOVE_SELECTORS) {
      document.querySelectorAll(sel).forEach(removeWithHusk);
    }

    for (const sel of TEXT_MATCH_SELECTORS) {
      document.querySelectorAll(sel).forEach((el) => {
        if (el.textContent.trim() === "Shorts") el.remove();
      });
    }

    // Grid/feed items whose primary link is a Short — belt and
    // suspenders with the CSS :has() rules.
    document
      .querySelectorAll(
        "ytd-rich-item-renderer a[href^='/shorts'], " +
          "ytd-video-renderer a[href^='/shorts'], " +
          "ytd-grid-video-renderer a[href^='/shorts'], " +
          "ytd-compact-video-renderer a[href^='/shorts']"
      )
      .forEach((a) => {
        const item = a.closest(
          "ytd-rich-item-renderer, ytd-video-renderer, " +
            "ytd-grid-video-renderer, ytd-compact-video-renderer"
        );
        if (item) removeWithHusk(item);
      });
  }

  // Removing a shelf can leave an empty section wrapper that still
  // takes up feed spacing — remove the husk with it.
  function removeWithHusk(el) {
    const husk = el.closest("ytd-rich-section-renderer");
    (husk || el).remove();
  }

  // ---------------------------------------------------------------
  // Observer plumbing — active only while enabled
  // ---------------------------------------------------------------
  let observer = null;
  let lastSweep = 0;
  let trailing = null;

  function scheduleSweep() {
    const wait = 150 - (performance.now() - lastSweep);
    if (wait <= 0) {
      lastSweep = performance.now();
      sweep();
    } else if (trailing === null) {
      trailing = setTimeout(() => {
        trailing = null;
        lastSweep = performance.now();
        sweep();
      }, wait);
    }
  }

  function startObserver() {
    if (observer) return;
    observer = new MutationObserver(scheduleSweep);
    const observe = () => {
      observer &&
        observer.observe(document.documentElement, {
          childList: true,
          subtree: true
        });
      sweep();
    };
    if (document.body) observe();
    else document.addEventListener("DOMContentLoaded", observe, { once: true });
  }

  function stopObserver() {
    if (!observer) return;
    observer.disconnect();
    observer = null;
    if (trailing !== null) {
      clearTimeout(trailing);
      trailing = null;
    }
  }

  // Kick things off under the optimistic default; the storage read
  // above corrects course if the user has it off.
  apply();
})();
