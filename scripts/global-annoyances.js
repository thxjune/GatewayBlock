/**
 * GatewayBlock — global annoyance killer
 *
 * Runs on every page (except YouTube, which has its own script).
 * Handles the stuff network rules can't:
 *  - popunder/click-hijack scripts that open windows on your first click
 *  - leftover empty ad containers
 *  - generic "please disable your ad blocker" nag overlays
 */

(() => {
  "use strict";

  if (location.hostname.endsWith("youtube.com")) return;

  // -----------------------------------------------------------------
  // 1. Popunder / click-hijack protection
  //    Many shady sites bind a one-time click listener that calls
  //    window.open(). We wrap window.open and reject calls that are
  //    (a) not triggered by a real trusted user gesture on a link, or
  //    (b) pointed at known garbage.
  // -----------------------------------------------------------------
  const realOpen = window.open.bind(window);
  let lastTrustedClick = 0;

  document.addEventListener(
    "click",
    (e) => {
      if (e.isTrusted) lastTrustedClick = Date.now();
    },
    true
  );

  window.open = function (url, ...rest) {
    const sinceClick = Date.now() - lastTrustedClick;
    const clickedRealLink =
      sinceClick < 1000 &&
      document.activeElement &&
      (document.activeElement.closest?.("a[href]") ||
        document.activeElement.tagName === "A");

    // Allow window.open only shortly after a genuine click on a link
    if (clickedRealLink || (sinceClick < 200 && url && !/^javascript:/i.test(String(url)))) {
      return realOpen(url, ...rest);
    }
    // Swallow the popup/popunder
    return null;
  };

  // -----------------------------------------------------------------
  // 2. Collapse empty ad containers left behind by network blocking
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
  // 3. Scroll-lock release
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
