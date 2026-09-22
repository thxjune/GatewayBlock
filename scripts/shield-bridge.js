/**
 * GatewayBlock — click-shield bridge (isolated world, every frame)
 *
 * The click shield itself runs in the page's JS context and cannot read
 * extension storage. This script owns the settings attributes on <html>
 * that the shield checks on every decision:
 *
 *   data-gb-shield="off"    shield disabled globally or paused for this site
 *   data-gb-sandbox="off"   player-iframe sandboxing disabled
 *
 * and answers the popup's "gb:stats" message with what the shield
 * published (data-gb-blocked count, data-gb-hostile flag) so the popup
 * can show "N hijack attempts blocked on <host>" and offer a per-site
 * pause. Per-site keys use the *top* page's host, so frames inside a
 * paused site are paused too.
 */

(() => {
  "use strict";

  const api = globalThis.browser ?? globalThis.chrome;
  const root = () => document.documentElement;

  const topHost = (() => {
    try {
      const ao = location.ancestorOrigins;
      if (ao && ao.length) return new URL(ao[ao.length - 1]).hostname;
    } catch (_) {}
    return location.hostname;
  })();

  const settings = { enabled: true, paused: false, sandbox: true };

  function apply() {
    const r = root();
    if (!r) return;
    const off = !settings.enabled || settings.paused;
    if (off) r.setAttribute("data-gb-shield", "off");
    else r.removeAttribute("data-gb-shield");
    if (off || !settings.sandbox) r.setAttribute("data-gb-sandbox", "off");
    else r.removeAttribute("data-gb-sandbox");
  }

  function load() {
    api.storage.local.get(["shieldEnabled", "shieldPaused", "sandboxPlayers"]).then((res) => {
      settings.enabled = res.shieldEnabled !== false;
      settings.paused = !!(res.shieldPaused && res.shieldPaused[topHost]);
      settings.sandbox = res.sandboxPlayers !== false;
      apply();
    });
  }

  load();
  if (!root()) document.addEventListener("DOMContentLoaded", apply, { once: true });

  api.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;
    if ("shieldEnabled" in changes || "shieldPaused" in changes || "sandboxPlayers" in changes) load();
  });

  api.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (!msg || msg.type !== "gb:stats" || window !== window.top) return;
    const r = root();
    sendResponse({
      host: topHost,
      blocked: r ? Number(r.getAttribute("data-gb-blocked")) || 0 : 0,
      hostile: !!r && r.hasAttribute("data-gb-hostile"),
      enabled: settings.enabled,
      paused: settings.paused,
      sandbox: settings.sandbox
    });
  });
})();
