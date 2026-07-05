/**
 * GatewayBlock — YouTube video ad neutralizer
 *
 * Strategy (in order of preference):
 *  1. Click the Skip button the instant it exists.
 *  2. If the ad is unskippable: mute it, crank playback to 16x,
 *     and seek to the end of the ad so it finishes in ~1 frame.
 *  3. Close overlay/banner ads inside the player.
 *  4. Detect YouTube's anti-adblock enforcement dialog, remove it,
 *     and resume playback.
 *
 * While the JS works, youtube-hide.css blacks out the ad frame the
 * instant the player gains the `ad-showing` class, so the ad is never
 * visible even if a tick arrives a beat late.
 *
 * The user's real volume/mute/speed settings are saved when an ad
 * starts and restored the moment it ends, so the actual video
 * (e.g. the Gateway Tapes) plays back exactly as before.
 */

(() => {
  "use strict";

  // ---------------------------------------------------------------
  // Selectors — YouTube changes these periodically. If ads start
  // slipping through, this block is the first place to update.
  // ---------------------------------------------------------------
  const SKIP_BUTTON_SELECTORS = [
    ".ytp-skip-ad-button",
    ".ytp-ad-skip-button",
    ".ytp-ad-skip-button-modern",
    ".ytp-ad-skip-button-container button",
    "button[class*='skip-button']",
    "button[id^='skip-button']"
  ];

  const OVERLAY_CLOSE_SELECTORS = [
    ".ytp-ad-overlay-close-button",
    ".ytp-ad-overlay-close-container"
  ];

  const AD_STATE_CLASSES = ["ad-showing", "ad-interrupting"];

  const ENFORCEMENT_SELECTORS = [
    "ytd-enforcement-message-view-model",
    "tp-yt-paper-dialog:has(ytd-enforcement-message-view-model)",
    "#error-screen ytd-enforcement-message-view-model"
  ];

  // ---------------------------------------------------------------
  // State
  // ---------------------------------------------------------------
  let savedState = null;     // user's volume/muted/rate before ad
  let adActive = false;

  const getPlayer = () =>
    document.querySelector(".html5-video-player");

  const getVideo = () =>
    document.querySelector(".html5-video-player video.html5-main-video") ||
    document.querySelector("video.html5-main-video") ||
    document.querySelector("video");

  const playerShowsAd = (player) =>
    !!player && AD_STATE_CLASSES.some((c) => player.classList.contains(c));

  // ---------------------------------------------------------------
  // Ad handling
  // ---------------------------------------------------------------
  function clickSkipIfPresent() {
    for (const sel of SKIP_BUTTON_SELECTORS) {
      const btn = document.querySelector(sel);
      if (btn && btn.offsetParent !== null) {
        btn.click();
        return true;
      }
      // Some skip buttons render but report offsetParent null inside
      // the player chrome — click anyway as a fallback.
      if (btn) {
        btn.click();
        return true;
      }
    }
    return false;
  }

  function closeOverlays() {
    for (const sel of OVERLAY_CLOSE_SELECTORS) {
      const btn = document.querySelector(sel);
      if (btn) btn.click();
    }
  }

  function fastForwardAd(video) {
    if (!video) return;
    try {
      video.muted = true;
      video.playbackRate = 16;
      // Seek to the end of the ad clip so it completes immediately.
      if (isFinite(video.duration) && video.duration > 0) {
        video.currentTime = Math.max(0, video.duration - 0.1);
      }
      if (video.paused) {
        const p = video.play();
        if (p && p.catch) p.catch(() => {});
      }
    } catch (_) {
      /* seeking can throw mid-transition; the next tick retries */
    }
  }

  function onAdStart(video) {
    if (adActive) return;
    adActive = true;
    if (video && !savedState) {
      savedState = {
        muted: video.muted,
        volume: video.volume,
        rate: video.playbackRate
      };
    }
    // Silence the ad in the same tick it's detected, on the skip path
    // too — not only when fast-forwarding.
    if (video) {
      try {
        video.muted = true;
      } catch (_) {}
    }
  }

  function onAdEnd(video) {
    if (!adActive) return;
    adActive = false;
    if (video && savedState) {
      try {
        video.muted = savedState.muted;
        video.volume = savedState.volume;
        video.playbackRate = savedState.rate || 1;
      } catch (_) {}
    }
    savedState = null;
  }

  // ---------------------------------------------------------------
  // Anti-adblock enforcement dialog handling
  // ---------------------------------------------------------------
  function killEnforcementDialog() {
    let found = false;
    for (const sel of ENFORCEMENT_SELECTORS) {
      let nodes = [];
      try {
        nodes = document.querySelectorAll(sel);
      } catch (_) {
        continue; // :has() may be unsupported in older Safari
      }
      nodes.forEach((n) => {
        const dialog = n.closest("tp-yt-paper-dialog") || n;
        dialog.remove();
        found = true;
      });
    }
    if (found) {
      // Remove the backdrop scrim and resume playback
      document
        .querySelectorAll("tp-yt-iron-overlay-backdrop")
        .forEach((b) => b.remove());
      const video = getVideo();
      if (video && video.paused) {
        const p = video.play();
        if (p && p.catch) p.catch(() => {});
      }
    }
  }

  // ---------------------------------------------------------------
  // Main tick — runs on mutations + a safety interval
  // ---------------------------------------------------------------
  function tick() {
    const player = getPlayer();
    const video = getVideo();

    bindVideoEvents(video);
    killEnforcementDialog();
    closeOverlays();

    if (playerShowsAd(player)) {
      onAdStart(video);
      const skipped = clickSkipIfPresent();
      if (!skipped) fastForwardAd(video);
    } else {
      onAdEnd(video);
    }
  }

  // Throttle mutation storms to ~one tick per 16ms. Deliberately NOT
  // requestAnimationFrame: Safari throttles rAF (and long timers) in
  // unfocused windows, which delayed skips whenever the video sat on a
  // secondary monitor. MutationObserver callbacks are microtasks and
  // run at full speed regardless of focus, so tick synchronously when
  // enough time has passed and only defer the trailing edge.
  let lastTick = 0;
  let trailing = null;
  function scheduleTick() {
    const wait = 16 - (performance.now() - lastTick);
    if (wait <= 0) {
      lastTick = performance.now();
      tick();
    } else if (trailing === null) {
      trailing = setTimeout(() => {
        trailing = null;
        lastTick = performance.now();
        tick();
      }, wait);
    }
  }

  // Media events keep firing during playback even in unfocused
  // windows, so they drive ticks when DOM mutations alone are late.
  // YouTube swaps the <video> element on some navigations — rebind
  // whenever tick() sees a new one.
  let boundVideo = null;
  function bindVideoEvents(video) {
    if (!video || video === boundVideo) return;
    boundVideo = video;
    for (const ev of ["loadeddata", "durationchange", "playing", "timeupdate"]) {
      video.addEventListener(ev, scheduleTick, true);
    }
  }

  function start() {
    const observer = new MutationObserver(scheduleTick);
    observer.observe(document.documentElement, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["class"]
    });

    // Safety net: some ad states change without a class mutation we see
    setInterval(tick, 500);

    // YouTube is a single-page app — re-check on internal navigation
    window.addEventListener("yt-navigate-finish", scheduleTick, true);
    window.addEventListener("yt-page-data-updated", scheduleTick, true);

    tick();
  }

  if (document.documentElement) {
    start();
  } else {
    document.addEventListener("DOMContentLoaded", start, { once: true });
  }
})();
