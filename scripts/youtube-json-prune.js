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

  // ===================================================================
  // SHORTS PRUNING — separate from the ad logic above. Removes Shorts
  // shelves/items from feed, search, and guide payloads so the UI never
  // builds them. Gated at prune time on the <html data-gb-noshorts>
  // attribute, which scripts/youtube-noshorts.js (isolated world) sets
  // from the hideShorts setting — so the popup toggle governs this
  // layer too. Ad pruning above is NEVER affected by that attribute.
  // ===================================================================

  function shortsEnabled() {
    const el = document.documentElement;
    return !!el && el.hasAttribute("data-gb-noshorts");
  }

  // An innertube list item that IS Shorts content, in any of the
  // shapes YouTube currently ships them.
  function isShortsItem(item) {
    if (!item || typeof item !== "object") return false;
    if (
      hasOwn.call(item, "reelShelfRenderer") ||
      hasOwn.call(item, "reelItemRenderer") ||
      hasOwn.call(item, "shortsLockupViewModel") ||
      hasOwn.call(item, "shortsLockupViewModelV2")
    ) {
      return true;
    }
    // richShelfRenderer is also used for non-Shorts shelves — only a
    // shelf marked Shorts (icon) or containing reel items counts.
    if (item.richShelfRenderer && isShortsShelf(item.richShelfRenderer)) {
      return true;
    }
    // Feed sections/items wrap their real content one level down.
    if (item.richSectionRenderer && isShortsItem(item.richSectionRenderer.content)) {
      return true;
    }
    if (item.richItemRenderer && isShortsItem(item.richItemRenderer.content)) {
      return true;
    }
    // Search results occasionally ship Shorts as plain videoRenderers
    // whose click target is the reel player.
    if (
      item.videoRenderer &&
      item.videoRenderer.navigationEndpoint &&
      item.videoRenderer.navigationEndpoint.reelWatchEndpoint
    ) {
      return true;
    }
    // The guide's Shorts entry (left sidebar data).
    if (
      item.guideEntryRenderer &&
      item.guideEntryRenderer.icon &&
      typeof item.guideEntryRenderer.icon.iconType === "string" &&
      item.guideEntryRenderer.icon.iconType.indexOf("SHORTS") !== -1
    ) {
      return true;
    }
    return false;
  }

  function isShortsShelf(shelf) {
    if (shelf.icon && typeof shelf.icon.iconType === "string" &&
        shelf.icon.iconType.indexOf("SHORTS") !== -1) {
      return true;
    }
    return Array.isArray(shelf.contents) && shelf.contents.some(isShortsItem);
  }

  // Walk the payload; drop Shorts items out of every array in place.
  function pruneShortsDeep(node) {
    if (Array.isArray(node)) {
      for (let i = node.length - 1; i >= 0; i--) {
        if (isShortsItem(node[i])) {
          node.splice(i, 1);
        } else {
          pruneShortsDeep(node[i]);
        }
      }
    } else if (node && typeof node === "object") {
      for (const key in node) {
        const v = node[key];
        if (v && typeof v === "object") pruneShortsDeep(v);
      }
    }
    return node;
  }

  // Only walk payloads that are plausibly YouTube UI data — every
  // innertube response carries responseContext; initial data carries
  // contents. Anything else is left completely alone.
  function looksLikeBrowseData(obj) {
    return (
      obj &&
      typeof obj === "object" &&
      (hasOwn.call(obj, "responseContext") ||
        hasOwn.call(obj, "contents") ||
        hasOwn.call(obj, "onResponseReceivedActions") ||
        hasOwn.call(obj, "onResponseReceivedCommands") ||
        hasOwn.call(obj, "onResponseReceivedEndpoints"))
    );
  }

  // Single funnel used by every interception point below: ads always,
  // Shorts only while the toggle is on.
  function processData(obj) {
    if (looksLikePlayerData(obj)) pruneObject(obj);
    if (shortsEnabled() && looksLikeBrowseData(obj)) pruneShortsDeep(obj);
    return obj;
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
          value = processData(v);
        }
      });
    } catch (_) {
      /* already defined non-configurable — JSON.parse hook still covers SPA loads */
    }
  }
  trapInitial("ytInitialPlayerResponse");
  // ytInitialData is the feed/search bootstrap — it's where Shorts
  // shelves live on a cold page load. processData only touches it for
  // Shorts (it never matches the ad-side looksLikePlayerData check).
  trapInitial("ytInitialData");

  // -----------------------------------------------------------------
  // 2. JSON.parse — covers XHR/text-based parsing paths.
  // -----------------------------------------------------------------
  const nativeParse = JSON.parse;
  JSON.parse = function (text, reviver) {
    return processData(nativeParse.call(this, text, reviver));
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
    return nativeJson.call(this).then(processData);
  };
})();
