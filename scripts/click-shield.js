/**
 * GatewayBlock — click shield (MAIN world, every frame, document_start)
 *
 * Kills "first click opens an ad" hijacks: the click on Play (or any
 * menu item) that opens a popunder, swaps the tab to an ad URL, or lands
 * on an invisible layer sitting over the player. This runs in the page's
 * own JS context — the earlier isolated-world window.open wrapper never
 * touched the page's window.open, which is why those still got through.
 *
 * Layers (each one alone stops most tags; together they cover the
 * mechanisms seen in the wild):
 *
 *  1. Ad-tag neutralizer — script elements that carry a data-zone
 *     attribute or a known onclick-tag filename (Monetag/PropellerAds
 *     tag.min.js, vignette.min.js …) get their type flipped to
 *     text/plain the moment `src` is assigned, so they never run.
 *  2. Click bookkeeping — every trusted pointer/click is classified
 *     (real link, real control, ghost overlay, over the player) and
 *     remembered for a few seconds. All later decisions key off it.
 *  3. Redirect gate — the Navigation API `navigate` event cancels
 *     script-driven cross-site navigations that follow a click on
 *     something that is not a visible link to that destination.
 *     (WebKit's `userInitiated` flag is true for anything inside a
 *     click handler, so it cannot be used as the discriminator.)
 *  4. window.open policy — non-configurable override on window and
 *     Window.prototype, plus same-origin frame windows reached through
 *     contentWindow / frames[] (the classic iframe.contentWindow.open
 *     escape). Same-URL opens (the "keep the page in a new tab" trick)
 *     and cross-site opens from generic clicks return null.
 *  5. Anchor/form guards — detached or invisible cross-site anchors
 *     clicked programmatically (.click(), dispatchEvent) are dropped,
 *     hidden cross-site forms with target=_blank don't submit, and a
 *     link whose href was swapped to an ad between mousedown and click
 *     is restored before the browser follows it.
 *  6. Overlay handling — an invisible cross-site <a> covering the
 *     player is neutralized on sight (pointer-events: none) and the
 *     click is replayed on the element underneath. Invisible <div>
 *     layers are handled adaptively: if a hijack fired during the click
 *     the layer is neutralized and the click replayed; otherwise it is
 *     left alone (some real players use a transparent click catcher).
 *  7. Player-iframe sandbox — third-party player iframes (allowfullscreen,
 *     /embed/ paths, …) get a sandbox without allow-popups or
 *     allow-top-navigation before their document is created. A frame
 *     navigating `top` never fires the parent's navigate event, so this
 *     is the only reliable defense for hijacks living inside the embed.
 *     Well-known embeds (YouTube, Vimeo, Twitch, Stripe …) are exempt.
 *
 * Settings come in through attributes the isolated-world bridge sets on
 * <html>: data-gb-shield="off" pauses everything on this site,
 * data-gb-sandbox="off" disables layer 7. Stats go out the same way:
 * data-gb-blocked (count) and data-gb-hostile (a hijack was seen).
 * Add data-gb-debug to <html> to get console.debug traces.
 */

(() => {
  "use strict";

  const MARK = Symbol.for("gatewayblock.shield");
  if (window[MARK]) return;
  try {
    Object.defineProperty(window, MARK, { value: true, enumerable: false, configurable: false, writable: false });
  } catch (_) {
    return;
  }
  if (/(^|\.)youtube\.com$/.test(location.hostname)) return;

  const now = () => Date.now();
  const html = () => document.documentElement;
  const shieldOff = () => {
    const r = html();
    return !!r && r.getAttribute("data-gb-shield") === "off";
  };
  const sandboxOff = () => {
    const r = html();
    return shieldOff() || (!!r && r.getAttribute("data-gb-sandbox") === "off");
  };
  const debugOn = () => {
    const r = html();
    return !!r && r.hasAttribute("data-gb-debug");
  };
  const dbg = (...a) => {
    if (debugOn()) console.debug("[GatewayBlock shield]", ...a);
  };

  // -----------------------------------------------------------------
  // Site helpers
  // -----------------------------------------------------------------
  const TWO_LEVEL = new Set([
    "co.uk", "org.uk", "ac.uk", "gov.uk", "me.uk", "net.uk", "com.au", "net.au", "org.au", "co.nz",
    "co.jp", "ne.jp", "or.jp", "com.br", "com.mx", "com.ar", "com.co", "com.pe", "com.tr", "com.sg",
    "com.hk", "com.tw", "co.kr", "co.in", "co.za", "com.ng", "com.eg", "com.sa", "com.pk", "com.bd",
    "com.ph", "com.vn", "co.id", "com.my", "com.ua", "com.pl", "com.cn", "com.ru"
  ]);
  function siteOf(host) {
    host = String(host || "").toLowerCase().replace(/\.$/, "");
    if (!host || /^[\d.]+$/.test(host) || host.includes(":") || !host.includes(".")) return host;
    const labels = host.split(".");
    const n = TWO_LEVEL.has(labels.slice(-2).join(".")) ? 3 : 2;
    return labels.slice(-n).join(".");
  }
  const MY_SITE = siteOf(location.hostname);
  const hostIn = (host, list) => list.some((h) => host === h || host.endsWith("." + h));

  function resolveURL(u) {
    try {
      if (u == null) return null;
      const s = String(u).trim();
      if (!s) return null;
      return new URL(s, location.href);
    } catch (_) {
      return null;
    }
  }
  const isHttp = (url) => !!url && (url.protocol === "http:" || url.protocol === "https:");
  const isSameSite = (url) => !!url && (!isHttp(url) || siteOf(url.hostname) === MY_SITE);
  const isBlankish = (url) => !url || url.protocol === "about:" || url.protocol === "javascript:";
  const sameURLAsPage = (url) => {
    if (!url) return false;
    const a = url.href.replace(/#.*$/, "");
    const b = location.href.replace(/#.*$/, "");
    return a === b;
  };

  // Destinations a script may legitimately send you to after a click on
  // a real button (sign-in, checkout, share). Never applied to clicks on
  // the player or on invisible layers.
  const TRUSTED_DESTS = [
    "google.com", "apple.com", "microsoft.com", "microsoftonline.com", "live.com", "github.com",
    "x.com", "twitter.com", "facebook.com", "instagram.com", "threads.net", "discord.com",
    "auth0.com", "okta.com", "paypal.com", "stripe.com", "shopify.com", "shop.app", "amazon.com",
    "linkedin.com", "reddit.com", "pinterest.com", "t.me", "telegram.org", "whatsapp.com",
    "zoom.us", "slack.com", "spotify.com", "tumblr.com", "tiktok.com", "youtube.com", "twitch.tv",
    "kick.com", "bsky.app", "medium.com", "notion.so", "canva.com", "figma.com", "dropbox.com",
    "cloudflare.com", "hcaptcha.com", "recaptcha.net", "wistia.com", "vimeo.com", "dailymotion.com",
    "soundcloud.com", "patreon.com", "substack.com", "steampowered.com", "epicgames.com",
    "playstation.com", "xbox.com", "wikipedia.org", "stackoverflow.com", "klarna.com", "affirm.com",
    "afterpay.com", "adyen.com", "checkout.com", "braintreegateway.com", "squareup.com", "gumroad.com",
    "lemonsqueezy.com", "paddle.com", "eventbrite.com", "ticketmaster.com", "booking.com", "airbnb.com"
  ];

  // Embeds that are never sandboxed (they need popups / top navigation
  // for real features and never hijack).
  const EMBED_ALLOW = [
    "youtube.com", "youtube-nocookie.com", "google.com", "gstatic.com", "googleapis.com",
    "vimeo.com", "twitch.tv", "dailymotion.com", "spotify.com", "scdn.co", "soundcloud.com",
    "wistia.com", "wistia.net", "vidyard.com", "loom.com", "streamable.com", "kick.com",
    "tiktok.com", "instagram.com", "facebook.com", "x.com", "twitter.com", "apple.com",
    "cloudflare.com", "cloudflarestream.com", "videodelivery.net", "mediadelivery.net",
    "b-cdn.net", "jwplayer.com", "jwpcdn.com", "brightcove.net", "brightcove.com", "mux.com",
    "vidstack.io", "stripe.com", "paypal.com", "hcaptcha.com", "recaptcha.net", "discord.com",
    "reddit.com", "redditmedia.com", "github.com", "codepen.io", "codesandbox.io", "jsfiddle.net",
    "stackblitz.com", "figma.com", "canva.com", "notion.so", "giphy.com", "imgur.com", "embedly.com",
    "bandcamp.com", "mixcloud.com", "ted.com", "archive.org", "amazon.com", "primevideo.com",
    "netflix.com", "hulu.com", "disneyplus.com", "max.com", "peacocktv.com", "paramountplus.com",
    "crunchyroll.com", "plex.tv", "nebula.tv", "floatplane.com", "rumble.com", "odysee.com",
    "zoom.us", "microsoft.com", "office.com", "sharepoint.com", "disqus.com", "intercom.io",
    "intercomcdn.com", "crisp.chat", "tawk.to", "zendesk.com", "hubspot.com", "drift.com",
    "livechatinc.com", "klarna.com", "adyen.com", "braintreegateway.com", "squareup.com",
    "shopify.com", "shop.app", "typeform.com", "calendly.com", "airtable.com", "docs.google.com"
  ];

  // Known onclick-tag signatures (file names; domains rotate weekly).
  const TAG_SRC_RE = /\/(tag|vignette|in-page-push|ipp|pop(?:under|up)?|onclick[a-z]*)\.min\.js(?:$|[?#])|\/afu\.php\?|\/popunder[^/]*\.js/i;
  // Sites whose own code checks a localStorage flag before loading the tag.
  const SITE_KILL_SWITCHES = { "cinejoy.pk": ["addies"], "cinejoy.to": ["addies"] };

  // -----------------------------------------------------------------
  // State
  // -----------------------------------------------------------------
  const S = { lastClick: null, lastDown: null, hostile: false, blocked: 0 };
  const OURS = new WeakSet(); // synthetic events we dispatched ourselves
  const NEUTRALIZED = new WeakSet();
  const SANDBOXED = new WeakSet();

  try {
    if (sessionStorage.getItem("gb.hostile") === "1") S.hostile = true;
  } catch (_) {}

  function publish() {
    const r = html();
    if (!r) return;
    try {
      r.setAttribute("data-gb-blocked", String(S.blocked));
      if (S.hostile) r.setAttribute("data-gb-hostile", "");
    } catch (_) {}
  }
  const HOSTILE_MSG = "gatewayblock:hostile";
  function markHostile() {
    if (S.hostile) return;
    S.hostile = true;
    try {
      sessionStorage.setItem("gb.hostile", "1");
    } catch (_) {}
  }
  function noteBlocked(kind, what) {
    S.blocked++;
    markHostile();
    publish();
    dbg("blocked", kind, what ? String(what).slice(0, 160) : "");
    // A hijack inside an embed can still navigate `top` (the parent never
    // sees a navigate event for it), so tell the top page to harden.
    try {
      if (window !== window.top) window.top.postMessage(HOSTILE_MSG, "*");
      else hardenFrames();
    } catch (_) {}
  }
  window.addEventListener("message", (e) => {
    if (e.data !== HOSTILE_MSG || window !== window.top) return;
    markHostile();
    publish();
    hardenFrames();
  });
  publish();

  // -----------------------------------------------------------------
  // Visibility / geometry helpers
  // -----------------------------------------------------------------
  function alphaOf(color) {
    if (!color || color === "transparent") return 0;
    const m = /rgba?\(\s*[\d.]+\s*,\s*[\d.]+\s*,\s*[\d.]+\s*(?:,\s*([\d.]+)\s*)?\)/.exec(color);
    if (m) return m[1] === undefined ? 1 : parseFloat(m[1]);
    return 1;
  }
  const CONTENT_SEL = "img,svg,video,canvas,picture,iframe,input,button,select,textarea,object,embed,audio";
  // "Ghost": something you can't see at all — no paint, no text, no media.
  function isGhost(el, cs) {
    try {
      if (el.matches && el.matches(CONTENT_SEL)) return false; // media/inputs are visible by nature
      cs = cs || getComputedStyle(el);
      if (cs.visibility === "hidden") return true;
      if (parseFloat(cs.opacity) < 0.05) return true;
      if (alphaOf(cs.backgroundColor) > 0.02) return false;
      if (cs.backgroundImage && cs.backgroundImage !== "none") return false;
      if (parseFloat(cs.borderTopWidth) > 0 && alphaOf(cs.borderTopColor) > 0.02) return false;
      if (parseFloat(cs.outlineWidth) > 0 && cs.outlineStyle !== "none") return false;
      if (el.textContent && el.textContent.trim().length > 0) return false;
      if (el.querySelector(CONTENT_SEL)) return false;
      return true;
    } catch (_) {
      return false;
    }
  }
  function overlapRatio(a, b) {
    const w = Math.max(0, Math.min(a.right, b.right) - Math.max(a.left, b.left));
    const h = Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top));
    const areaB = Math.max(1, b.width * b.height);
    return (w * h) / areaB;
  }

  // Players in this document: <video> and player-ish iframes.
  function isPlayerIframe(f) {
    if (!(f instanceof HTMLIFrameElement)) return false;
    const src = resolveURL(f.getAttribute("src"));
    if (f.hasAttribute("allowfullscreen") || f.hasAttribute("webkitallowfullscreen")) return true;
    const allow = (f.getAttribute("allow") || "").toLowerCase();
    if (/fullscreen|autoplay|picture-in-picture|encrypted-media/.test(allow)) return true;
    if (src && isHttp(src) && /\/(embed|e|v|player|play|stream|video|watch)(\/|$)|\.m3u8/i.test(src.pathname)) return true;
    return false;
  }
  function players() {
    const out = [];
    try {
      const els = document.querySelectorAll("video, iframe");
      for (const el of els) {
        if (el.tagName === "IFRAME" && !isPlayerIframe(el)) continue;
        const rect = el.getBoundingClientRect();
        if (rect.width < 120 || rect.height < 70) continue;
        out.push({ el, rect });
      }
    } catch (_) {}
    return out;
  }
  function pointOverPlayer(x, y, list) {
    return (list || players()).some(({ rect }) => x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom);
  }

  // A positioned, invisible layer big enough to be sitting over the
  // player or most of the page.
  function isGhostOverlay(el, list) {
    try {
      if (!(el instanceof Element) || el === document.body || el === html()) return false;
      const cs = getComputedStyle(el);
      if (cs.position !== "absolute" && cs.position !== "fixed" && cs.position !== "sticky") return false;
      if (cs.pointerEvents === "none") return false;
      const r = el.getBoundingClientRect();
      if (r.width < 100 || r.height < 60) return false;
      const bigViewport = r.width * r.height >= 0.4 * innerWidth * innerHeight;
      const bigPlayer = (list || players()).some((p) => !el.contains(p.el) && overlapRatio(r, p.rect) >= 0.5);
      if (!bigViewport && !bigPlayer) return false;
      return isGhost(el, cs);
    } catch (_) {
      return false;
    }
  }
  function isGhostCrossSiteAnchor(el) {
    if (!(el instanceof HTMLAnchorElement) || !el.hasAttribute("href")) return false;
    const href = resolveURL(el.getAttribute("href"));
    if (!isHttp(href) || isSameSite(href)) return false;
    const r = el.getBoundingClientRect();
    if (r.width < 20 || r.height < 20) return false;
    return isGhost(el);
  }

  function neutralize(el, why) {
    if (NEUTRALIZED.has(el)) return;
    NEUTRALIZED.add(el);
    try {
      el.style.setProperty("pointer-events", "none", "important");
      el.setAttribute("data-gb-neutralized", why || "");
    } catch (_) {}
    dbg("neutralized overlay", why, el);
  }

  // -----------------------------------------------------------------
  // 1. Ad-tag neutralizer
  // -----------------------------------------------------------------
  function isAdTagScript(s, src) {
    try {
      if (!(s instanceof HTMLScriptElement)) return false;
      if (s.hasAttribute("data-zone") || s.hasAttribute("data-zoneid")) return true;
      const url = resolveURL(src != null ? src : s.getAttribute("src"));
      if (!isHttp(url)) return false;
      if (isSameSite(url)) return false;
      return TAG_SRC_RE.test(url.pathname + url.search);
    } catch (_) {
      return false;
    }
  }
  function disarmScript(s) {
    try {
      s.type = "text/plain";
      s.setAttribute("data-gb-neutralized", "ad-tag");
    } catch (_) {}
    noteBlocked("ad-tag", s.getAttribute("src") || "(data-zone script)");
  }
  (function patchScriptSrc() {
    const proto = HTMLScriptElement.prototype;
    const desc = Object.getOwnPropertyDescriptor(proto, "src");
    if (desc && desc.set) {
      Object.defineProperty(proto, "src", {
        configurable: true,
        enumerable: desc.enumerable,
        get: desc.get,
        set(v) {
          if (!shieldOff() && isAdTagScript(this, v)) disarmScript(this);
          return desc.set.call(this, v);
        }
      });
    }
    const realSetAttribute = Element.prototype.setAttribute;
    Element.prototype.setAttribute = function (name, value) {
      if (this instanceof HTMLScriptElement && String(name).toLowerCase() === "src" && !shieldOff() && isAdTagScript(this, value)) {
        disarmScript(this);
      }
      return realSetAttribute.call(this, name, value);
    };
    // Scripts fully built before insertion (src + data-zone set first).
    const guardInsert = (obj, method) => {
      const real = obj[method];
      if (typeof real !== "function") return;
      obj[method] = function (...args) {
        if (!shieldOff()) {
          for (const a of args) {
            if (a instanceof HTMLScriptElement && !a.hasAttribute("data-gb-neutralized") && isAdTagScript(a)) disarmScript(a);
          }
        }
        return real.apply(this, args);
      };
    };
    for (const m of ["appendChild", "insertBefore", "replaceChild"]) guardInsert(Node.prototype, m);
    for (const m of ["append", "prepend", "before", "after", "replaceWith"]) guardInsert(Element.prototype, m);
  })();

  // Site-specific: flip the page's own "no ads" flag before its inline
  // code reads it.
  try {
    const keys = SITE_KILL_SWITCHES[MY_SITE];
    if (keys && window === window.top) for (const k of keys) localStorage.setItem(k, "false");
  } catch (_) {}

  // -----------------------------------------------------------------
  // 2. Click bookkeeping
  // -----------------------------------------------------------------
  const CONTROL_SEL =
    'button, input, select, textarea, summary, label, [role="button"], [role="link"], [role="menuitem"], [role="menuitemcheckbox"], [role="menuitemradio"], [role="tab"], [role="option"], [role="checkbox"], [role="switch"], [contenteditable=""], [contenteditable="true"]';

  function classify(e) {
    const path = typeof e.composedPath === "function" ? e.composedPath() : [];
    const first = path[0] instanceof Element ? path[0] : e.target instanceof Element ? e.target : null;
    const c = {
      t: now(),
      x: Math.round(e.clientX || 0),
      y: Math.round(e.clientY || 0),
      el: first,
      kind: "other",
      href: null,
      anchor: null,
      ghost: false,
      overlay: null,
      overPlayer: false
    };
    if (!first) return c;
    const list = players();
    for (const n of path) {
      if (!(n instanceof Element)) break;
      if (n === document.body || n === html()) break;
      if (n instanceof HTMLAnchorElement && n.hasAttribute("href")) {
        c.kind = "link";
        c.anchor = n;
        c.href = resolveURL(n.getAttribute("href"));
        break;
      }
      if (n.matches && n.matches(CONTROL_SEL)) {
        c.kind = "control";
        break;
      }
    }
    for (const n of path) {
      if (!(n instanceof Element)) break;
      if (n === document.body || n === html()) break;
      if (isGhostCrossSiteAnchor(n) || isGhostOverlay(n, list)) {
        c.overlay = n;
        c.ghost = true;
        break;
      }
    }
    if (!c.ghost && first && c.kind !== "link" && c.kind !== "control" && isGhost(first)) c.ghost = true;
    c.overPlayer = pointOverPlayer(c.x, c.y, list);
    return c;
  }

  const recentClick = (ms) => S.lastClick && now() - S.lastClick.t <= ms;

  // Anchor href snapshot for swap detection.
  let armed = null;
  function onPointerDown(e) {
    if (!e.isTrusted || shieldOff()) return;
    if (e.type === "mousedown" && "PointerEvent" in window) return; // pointerdown already handled it
    const c = classify(e);
    S.lastClick = c;
    S.lastDown = c;
    armed = c.anchor ? { el: c.anchor, href: c.anchor.getAttribute("href") } : null;
  }

  function replayBelow(c) {
    try {
      const below = document.elementFromPoint(c.x, c.y);
      if (!below || below === c.overlay || (c.overlay && c.overlay.contains(below))) return;
      const ev = new MouseEvent("click", {
        bubbles: true,
        cancelable: true,
        composed: true,
        clientX: c.x,
        clientY: c.y,
        button: 0,
        view: window
      });
      OURS.add(ev);
      dbg("replaying click on", below);
      below.dispatchEvent(ev);
    } catch (_) {}
  }

  function onClickCapture(e) {
    if (shieldOff()) return;

    if (!e.isTrusted) {
      if (OURS.has(e)) return;
      // Synthetic click on a cross-site anchor: only real, visible links
      // that the user could have clicked themselves get through.
      const path = typeof e.composedPath === "function" ? e.composedPath() : [];
      for (const n of path) {
        if (!(n instanceof Element)) break;
        if (n instanceof HTMLAnchorElement && n.hasAttribute("href")) {
          const href = resolveURL(n.getAttribute("href"));
          if (isHttp(href) && !isSameSite(href) && (!n.isConnected || isGhost(n) || S.hostile || !recentClick(1200))) {
            e.preventDefault();
            e.stopImmediatePropagation();
            noteBlocked("synthetic-anchor-click", href.href);
          }
          break;
        }
      }
      return;
    }

    const c = classify(e);
    const down = S.lastDown;
    S.lastClick = c;

    // A ghost layer slid under the pointer between mousedown and click
    // (the browser then retargets the click to a common ancestor, so the
    // real button never hears it). Neutralize the layer and replay.
    if (down && now() - down.t < 1500 && down.el) {
      let top = null;
      try {
        top = document.elementFromPoint(c.x, c.y);
      } catch (_) {}
      if (top && top !== down.el && !top.contains(down.el) && !down.el.contains(top) && !NEUTRALIZED.has(top) && (isGhostCrossSiteAnchor(top) || isGhostOverlay(top))) {
        e.preventDefault();
        e.stopImmediatePropagation();
        neutralize(top, "late-layer");
        noteBlocked("late-layer", top.tagName);
        replayBelow({ ...c, overlay: top });
        return;
      }
    }

    // Link href swapped between mousedown and click → restore it.
    if (c.anchor && armed && armed.el === c.anchor) {
      const nowHref = c.anchor.getAttribute("href");
      if (nowHref !== armed.href) {
        const swapped = resolveURL(nowHref);
        if (isHttp(swapped) && !isSameSite(swapped)) {
          c.anchor.setAttribute("href", armed.href == null ? "" : armed.href);
          c.href = resolveURL(armed.href);
          noteBlocked("href-swap", swapped.href);
        }
      }
    }
    armed = null;

    if (c.overlay) {
      if (isGhostCrossSiteAnchor(c.overlay)) {
        // Invisible cross-site link over the player: never legitimate.
        e.preventDefault();
        e.stopImmediatePropagation();
        neutralize(c.overlay, "ghost-anchor");
        noteBlocked("ghost-anchor", c.href && c.href.href);
        replayBelow(c);
        return;
      }
      // Invisible layer: let the click run, then check whether a hijack
      // fired during it. If so, remove the layer and replay the click.
      const before = S.blocked;
      const overlay = c.overlay;
      setTimeout(() => {
        if (S.blocked > before) {
          neutralize(overlay, "hijack-layer");
          replayBelow(c);
        }
      }, 0);
    }
  }

  window.addEventListener("pointerdown", onPointerDown, true);
  window.addEventListener("mousedown", onPointerDown, true);
  window.addEventListener("touchstart", onPointerDown, true);
  window.addEventListener("click", onClickCapture, true);
  window.addEventListener("auxclick", (e) => { if (e.isTrusted && !shieldOff()) S.lastClick = classify(e); }, true);

  // -----------------------------------------------------------------
  // 3. Redirect gate (Navigation API)
  // -----------------------------------------------------------------
  // Should a script-driven jump to `dest` be allowed given the last click?
  function allowCrossSite(dest, kindOfThing) {
    const c = S.lastClick;
    const windowMs = S.hostile ? 6000 : 2500;
    if (!c || now() - c.t > windowMs) return true; // no click context: SSO redirects etc.
    if (c.ghost || c.overPlayer) return false;
    if (c.kind === "link" && c.href && isHttp(c.href) && siteOf(c.href.hostname) === siteOf(dest.hostname)) return true;
    if (hostIn(dest.hostname, TRUSTED_DESTS)) return true;
    if (c.kind === "control" && !S.hostile && players().length === 0) return true;
    dbg("deny", kindOfThing, dest.href, "after click kind=" + c.kind);
    return false;
  }

  if (typeof navigation !== "undefined" && navigation && typeof navigation.addEventListener === "function") {
    navigation.addEventListener("navigate", (e) => {
      try {
        if (shieldOff()) return;
        if (e.navigationType === "traverse" || e.navigationType === "reload") return;
        if (!e.cancelable) return;
        const dest = resolveURL(e.destination && e.destination.url);
        if (!isHttp(dest) || isSameSite(dest)) return;
        if (allowCrossSite(dest, "navigate")) return;
        e.preventDefault();
        noteBlocked("redirect", dest.href);
      } catch (_) {}
    });
  }

  // -----------------------------------------------------------------
  // 4. window.open policy
  // -----------------------------------------------------------------
  function decideOpen(url) {
    if (shieldOff()) return true;
    const dest = resolveURL(url);
    const c = S.lastClick;
    const recent = c && now() - c.t <= 1200;
    if (!recent) {
      // Delayed popup: only trusted destinations from a real control on a
      // page that has not misbehaved.
      return !!(c && now() - c.t <= 5000 && !S.hostile && c.kind !== "other" && !c.ghost && !c.overPlayer && isHttp(dest) && hostIn(dest.hostname, TRUSTED_DESTS));
    }
    if (c.ghost || c.overPlayer) return false;
    if (isBlankish(dest)) return c.kind !== "other" && !S.hostile;
    if (dest.protocol === "blob:" || dest.protocol === "data:") return c.kind !== "other";
    if (!isHttp(dest)) return true; // mailto:, tel:, custom schemes
    if (sameURLAsPage(dest)) return false; // popunder "keep this page open" trick
    if (isSameSite(dest)) return c.kind !== "other";
    if (c.kind === "link" && c.href && isHttp(c.href) && siteOf(c.href.hostname) === siteOf(dest.hostname)) return true;
    if (hostIn(dest.hostname, TRUSTED_DESTS)) return c.kind !== "other";
    return false;
  }
  function guardOpen(realOpen) {
    return function open(url, target, features) {
      if (decideOpen(url)) return realOpen.call(this === undefined ? window : this, url, target, features);
      noteBlocked("popup", url);
      return null;
    };
  }
  // Accessor with a no-op setter: page code that does `window.open = fn`
  // (analytics wrappers do) neither replaces the guard nor throws in
  // strict mode, which a non-writable data property would.
  function lockDown(obj, name, value) {
    try {
      Object.defineProperty(obj, name, {
        get() {
          return value;
        },
        set() {},
        configurable: false,
        enumerable: true
      });
      return true;
    } catch (_) {
      try {
        obj[name] = value;
      } catch (__) {}
      return false;
    }
  }
  function installOpen(win) {
    try {
      if (win[MARK]) return;
    } catch (_) {
      return; // cross-origin window
    }
    try {
      const real = win.open;
      if (typeof real !== "function") return;
      const guarded = guardOpen(real);
      lockDown(win, "open", guarded);
      Object.defineProperty(win, MARK, { value: true, enumerable: false, configurable: false, writable: false });
    } catch (_) {}
  }
  (function patchOpen() {
    const realOpen = window.open;
    lockDown(window, "open", guardOpen(realOpen));
    try {
      const protoDesc = Object.getOwnPropertyDescriptor(Window.prototype, "open");
      if (protoDesc && typeof protoDesc.value === "function") lockDown(Window.prototype, "open", guardOpen(protoDesc.value));
    } catch (_) {}

    // Same-origin frames reached synchronously after insertion.
    const cw = Object.getOwnPropertyDescriptor(HTMLIFrameElement.prototype, "contentWindow");
    if (cw && cw.get) {
      Object.defineProperty(HTMLIFrameElement.prototype, "contentWindow", {
        configurable: true,
        enumerable: cw.enumerable,
        get() {
          const w = cw.get.call(this);
          if (w) installOpen(w);
          return w;
        }
      });
    }
    const cd = Object.getOwnPropertyDescriptor(HTMLIFrameElement.prototype, "contentDocument");
    if (cd && cd.get) {
      Object.defineProperty(HTMLIFrameElement.prototype, "contentDocument", {
        configurable: true,
        enumerable: cd.enumerable,
        get() {
          const d = cd.get.call(this);
          try {
            if (d && d.defaultView) installOpen(d.defaultView);
          } catch (_) {}
          return d;
        }
      });
    }
    const fr = Object.getOwnPropertyDescriptor(HTMLFrameElement.prototype, "contentWindow");
    if (fr && fr.get) {
      Object.defineProperty(HTMLFrameElement.prototype, "contentWindow", {
        configurable: true,
        enumerable: fr.enumerable,
        get() {
          const w = fr.get.call(this);
          if (w) installOpen(w);
          return w;
        }
      });
    }
  })();

  // -----------------------------------------------------------------
  // 5. Anchor / form guards
  // -----------------------------------------------------------------
  function anchorClickAllowed(a) {
    const href = resolveURL(a.getAttribute("href"));
    if (!isHttp(href) || isSameSite(href)) return true;
    if (!a.isConnected || isGhost(a)) return false;
    const c = S.lastClick;
    if (!c || now() - c.t > 1200) return false;
    if (c.ghost || c.overPlayer || S.hostile) return false;
    return c.kind !== "other";
  }
  (function patchClick() {
    const realClick = HTMLElement.prototype.click;
    HTMLElement.prototype.click = function () {
      if (!shieldOff() && this instanceof HTMLAnchorElement && this.hasAttribute("href") && !anchorClickAllowed(this)) {
        noteBlocked("anchor.click()", this.getAttribute("href"));
        return;
      }
      return realClick.apply(this, arguments);
    };
    const realDispatch = EventTarget.prototype.dispatchEvent;
    EventTarget.prototype.dispatchEvent = function (ev) {
      try {
        if (
          !shieldOff() &&
          ev &&
          ev.type === "click" &&
          !OURS.has(ev) &&
          this instanceof HTMLAnchorElement &&
          this.hasAttribute("href") &&
          !this.isConnected &&
          !anchorClickAllowed(this)
        ) {
          noteBlocked("dispatchEvent(click)", this.getAttribute("href"));
          return true;
        }
      } catch (_) {}
      return realDispatch.call(this, ev);
    };
  })();

  function formAllowed(form) {
    try {
      const action = resolveURL(form.getAttribute("action") || location.href);
      if (!isHttp(action) || isSameSite(action)) return true;
      const target = (form.getAttribute("target") || "").toLowerCase();
      const popup = target === "_blank" || (target && target !== "_self" && target !== "_parent" && target !== "_top");
      if (!form.isConnected || isGhost(form)) return false;
      if (popup) return !!(S.lastClick && now() - S.lastClick.t <= 1200 && S.lastClick.kind !== "other" && !S.lastClick.ghost && !S.lastClick.overPlayer && !S.hostile);
      return allowCrossSite(action, "form");
    } catch (_) {
      return true;
    }
  }
  (function patchForms() {
    const proto = HTMLFormElement.prototype;
    for (const m of ["submit", "requestSubmit"]) {
      const real = proto[m];
      if (typeof real !== "function") continue;
      proto[m] = function () {
        if (!shieldOff() && !formAllowed(this)) {
          noteBlocked("form." + m, this.getAttribute("action"));
          return;
        }
        return real.apply(this, arguments);
      };
    }
    window.addEventListener(
      "submit",
      (e) => {
        if (shieldOff()) return;
        const f = e.target;
        if (f instanceof HTMLFormElement && !formAllowed(f)) {
          e.preventDefault();
          e.stopImmediatePropagation();
          noteBlocked("form-submit", f.getAttribute("action"));
        }
      },
      true
    );
  })();

  // -----------------------------------------------------------------
  // 6. Overlay scan (pre-emptive)
  // -----------------------------------------------------------------
  function scanOverlays() {
    if (shieldOff() || document.visibilityState === "hidden") return;
    const list = players();
    if (!list.length) return;
    for (const p of list) {
      const r = p.rect;
      if (r.width < 200 || r.height < 120) continue;
      const pts = [
        [r.left + r.width / 2, r.top + r.height / 2],
        [r.left + r.width * 0.25, r.top + r.height * 0.25],
        [r.left + r.width * 0.75, r.top + r.height * 0.25],
        [r.left + r.width * 0.25, r.top + r.height * 0.75],
        [r.left + r.width * 0.75, r.top + r.height * 0.75]
      ];
      for (const [x, y] of pts) {
        if (x < 0 || y < 0 || x > innerWidth || y > innerHeight) continue;
        let stack;
        try {
          stack = document.elementsFromPoint(x, y);
        } catch (_) {
          continue;
        }
        for (const el of stack) {
          if (el === p.el || el.contains(p.el)) break; // reached the player / its container
          if (NEUTRALIZED.has(el)) continue;
          if (isGhostCrossSiteAnchor(el)) neutralize(el, "ghost-anchor");
          else if (S.hostile && isGhostOverlay(el, list)) neutralize(el, "hostile-layer");
        }
      }
    }
  }

  // -----------------------------------------------------------------
  // 7. Player-iframe sandbox
  // -----------------------------------------------------------------
  const SANDBOX_TOKENS = [
    "allow-scripts", "allow-same-origin", "allow-forms", "allow-presentation", "allow-pointer-lock",
    "allow-orientation-lock", "allow-storage-access-by-user-activation"
  ];
  const SANDBOX_STRIP = /^allow-(popups|popups-to-escape-sandbox|top-navigation|top-navigation-by-user-activation|top-navigation-to-custom-protocols|modals|downloads)$/;
  function isBigFrame(f) {
    try {
      const r = f.getBoundingClientRect();
      return r.width >= 300 && r.height >= 150;
    } catch (_) {
      return false;
    }
  }
  function sandboxCandidate(f) {
    const src = resolveURL(f.getAttribute("src"));
    if (!isHttp(src) || isSameSite(src)) return false;
    return !hostIn(src.hostname.toLowerCase(), EMBED_ALLOW);
  }
  function shouldSandbox(f) {
    if (sandboxOff() || SANDBOXED.has(f)) return false;
    if (!sandboxCandidate(f)) return false;
    return S.hostile || isPlayerIframe(f) || isBigFrame(f);
  }
  // Once the page has misbehaved, every third-party frame already on the
  // page gets sandboxed and reloaded so the next click can't escape.
  function hardenFrames() {
    if (sandboxOff() || !S.hostile) return;
    try {
      document.querySelectorAll("iframe").forEach((f) => {
        if (SANDBOXED.has(f) || !sandboxCandidate(f)) return;
        sandboxFrame(f);
        try {
          f.src = f.src; // eslint-disable-line no-self-assign — re-navigate under the sandbox
        } catch (_) {}
      });
    } catch (_) {}
  }
  function sandboxFrame(f) {
    SANDBOXED.add(f);
    try {
      const existing = (f.getAttribute("sandbox") || "").split(/\s+/).filter(Boolean);
      const tokens = existing.length ? existing.filter((t) => !SANDBOX_STRIP.test(t)) : SANDBOX_TOKENS.slice();
      f.setAttribute("sandbox", tokens.join(" "));
      f.setAttribute("data-gb-sandboxed", "");
      dbg("sandboxed player iframe", f.getAttribute("src"));
    } catch (_) {}
  }
  function considerFrame(f) {
    if (shouldSandbox(f)) sandboxFrame(f);
  }

  // -----------------------------------------------------------------
  // Observers
  // -----------------------------------------------------------------
  let scanTimer = 0;
  const scheduleScan = () => {
    if (scanTimer) return;
    scanTimer = setTimeout(() => {
      scanTimer = 0;
      scanOverlays();
    }, 150);
  };
  const mo = new MutationObserver((records) => {
    let touched = false;
    for (const rec of records) {
      if (rec.type === "attributes") {
        if (rec.target instanceof HTMLIFrameElement) considerFrame(rec.target);
        continue;
      }
      for (const n of rec.addedNodes) {
        if (n.nodeType !== 1) continue;
        touched = true;
        if (n instanceof HTMLIFrameElement) considerFrame(n);
        else if (n.querySelectorAll) {
          try {
            n.querySelectorAll("iframe").forEach(considerFrame);
          } catch (_) {}
        }
      }
    }
    if (touched) scheduleScan();
  });
  function startObserving() {
    const target = html() || document;
    try {
      mo.observe(target, { childList: true, subtree: true, attributes: true, attributeFilter: ["src", "allow", "allowfullscreen"] });
    } catch (_) {}
    try {
      document.querySelectorAll("iframe").forEach(considerFrame);
    } catch (_) {}
    scheduleScan();
    setInterval(() => {
      if (document.visibilityState !== "hidden") scanOverlays();
    }, 1500);
  }
  if (html()) startObserving();
  else document.addEventListener("DOMContentLoaded", startObserving, { once: true });

  dbg("active on", location.href, "site=" + MY_SITE, "hostile=" + S.hostile);
})();
