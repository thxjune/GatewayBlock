/**
 * GatewayBlock — YouTube ad data pruner (MAIN world)
 *
 * Runs in the page's own JavaScript context at document_start, before
 * any YouTube code. Instead of reacting to ads after they start (the
 * skipper's job), this removes the ad data from YouTube's API responses
 * before the player ever reads them — the same technique uBlock
 * Origin's `json-prune` scriptlet uses. The player believes the video
 * has no ads, so nothing loads, plays, or flashes.
 *
 * Three interception points, because ad data arrives three ways:
 *  1. `window.ytInitialPlayerResponse` — inline JSON on first page load.
 *  2. `JSON.parse` — SPA navigations that parse fetched text.
 *  3. `Response.prototype.json` — fetch() responses parsed natively.
 *
 * youtube-adblock.js (isolated world) stays as a fallback for anything
 * that slips through, e.g. experiments where YouTube stitches the ad
 * into the video stream server-side.
 */

(() => {
  "use strict";

  // Ad payload keys, pruned wherever they appear. Kept in one list so
  // new keys (YouTube renames these occasionally) are a one-line fix.
  const AD_KEYS = [
    "adPlacements",
    "adSlots",
    "playerAds",
    "adBreakHeartbeatParams"
  ];

  const hasOwn = Object.prototype.hasOwnProperty;

  function pruneObject(obj) {
    if (!obj || typeof obj !== "object") return obj;

    for (const key of AD_KEYS) {
      if (hasOwn.call(obj, key)) {
        try {
          delete obj[key];
        } catch (_) {}
      }
    }

    // Player data sometimes arrives nested (watch-page navigation
    // responses wrap it in `playerResponse`).
    if (obj.playerResponse && typeof obj.playerResponse === "object") {
      pruneObject(obj.playerResponse);
    }

    return obj;
  }

  // Cheap check so we don't touch unrelated JSON: only objects that
  // look like YouTube player/navigation payloads get pruned.
  function looksLikePlayerData(obj) {
    return (
      obj &&
      typeof obj === "object" &&
      (hasOwn.call(obj, "playabilityStatus") ||
        hasOwn.call(obj, "videoDetails") ||
        hasOwn.call(obj, "playerResponse") ||
        AD_KEYS.some((k) => hasOwn.call(obj, k)))
    );
  }

  // -----------------------------------------------------------------
  // 1. Inline bootstrap data: YouTube assigns
  //    `var ytInitialPlayerResponse = {...}` in an inline <script>,
  //    which never goes through JSON.parse. Trap the assignment.
  // -----------------------------------------------------------------
  function trapInitial(name) {
    let value;
    try {
      Object.defineProperty(window, name, {
        configurable: true,
        get() {
          return value;
        },
        set(v) {
          value = looksLikePlayerData(v) ? pruneObject(v) : v;
        }
      });
    } catch (_) {
      /* already defined non-configurable — JSON.parse hook still covers SPA loads */
    }
  }
  trapInitial("ytInitialPlayerResponse");

  // -----------------------------------------------------------------
  // 2. JSON.parse — covers XHR/text-based parsing paths.
  // -----------------------------------------------------------------
  const nativeParse = JSON.parse;
  JSON.parse = function (text, reviver) {
    const result = nativeParse.call(this, text, reviver);
    return looksLikePlayerData(result) ? pruneObject(result) : result;
  };
  // Some YouTube code checks for native functions; keep the toString
  // honest enough not to advertise the wrap.
  try {
    Object.defineProperty(JSON.parse, "name", { value: "parse" });
  } catch (_) {}

  // -----------------------------------------------------------------
  // 3. Response.prototype.json — covers fetch() responses parsed
  //    natively (these bypass the page's JSON.parse).
  // -----------------------------------------------------------------
  const nativeJson = Response.prototype.json;
  Response.prototype.json = function () {
    return nativeJson.call(this).then((result) =>
      looksLikePlayerData(result) ? pruneObject(result) : result
    );
  };
})();
