/**
 * GatewayBlock — global annoyance killer
 *
 * Runs on every page (except YouTube, which has its own script).
 * Handles the stuff network rules can't:
 *  - leftover empty ad containers
 *  - scroll locks left behind by removed nag overlays
 *
 * Popunder / click-hijack protection used to live here as a window.open
 * wrapper. It never worked: this file runs in Safari's isolated world,
 * whose window.open is a separate wrapper the page never calls. That
 * job moved to scripts/click-shield.js, which runs in the page's own
 * context (world: MAIN).
 */

(() => {
  "use strict";

  if (location.hostname.endsWith("youtube.com")) return;

  // -----------------------------------------------------------------
  // 1. Collapse empty ad containers left behind by network blocking
  // -----------------------------------------------------------------
  const GENERIC_AD_SELECTORS = [
    "ins.adsbygoogle",
    "[id^='div-gpt-ad']",
    "[id^='google_ads_iframe']",
    "iframe[src*='doubleclick']",
    "iframe[src*='googlesyndication']",
    "[class*='sponsored-content']",
    "[data-ad-slot]",
    "[data-ad-client]"
  ];

  function collapseAdShells() {
    for (const sel of GENERIC_AD_SELECTORS) {
      document.querySelectorAll(sel).forEach((el) => {
        el.style.setProperty("display", "none", "important");
      });
    }
  }

  // -----------------------------------------------------------------
  // 2. Scroll-lock release
  //    Some overlay/nag scripts freeze scrolling via body styles.
  //    If an overlay was removed but scrolling is still locked, free it.
  // -----------------------------------------------------------------
  function releaseScrollLock() {
    const b = document.body;
    if (!b) return;
    const cs = getComputedStyle(b);
    const overlayPresent = document.querySelector(
      "[class*='overlay'][style*='fixed'], [class*='modal'][style*='fixed']"
    );
    if (!overlayPresent && (cs.overflow === "hidden" || cs.position === "fixed")) {
      // Only touch it if it looks like a leftover lock, not site design
      if (b.style.overflow === "hidden") b.style.overflow = "";
      if (b.style.position === "fixed") b.style.position = "";
    }
  }

  function tick() {
    collapseAdShells();
    releaseScrollLock();
  }

  const observer = new MutationObserver(() => {
    if (tick._raf) return;
    tick._raf = requestAnimationFrame(() => {
      tick._raf = null;
      tick();
    });
  });

  function start() {
    observer.observe(document.documentElement, {
      childList: true,
      subtree: true
    });
    tick();
    setInterval(tick, 2000);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", start, { once: true });
  } else {
    start();
  }
})();
