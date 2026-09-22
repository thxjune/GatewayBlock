/**
 * GatewayBlock — popup logic (external file: MV3 CSP forbids inline scripts)
 *
 * Settings (a missing key means ON, same default the content scripts
 * assume, so a fresh install never has to write storage):
 *   hideShorts      YouTube Shorts removal
 *   shieldEnabled   click shield (page-world hijack protection)
 *   sandboxPlayers  sandbox third-party player iframes
 *   shieldPaused    { [host]: true } — per-site pause, keyed by top host
 *
 * The site row asks the current tab's bridge script for stats
 * ("gb:stats"); pages without a content script (Safari start page,
 * extension pages) simply keep the row hidden.
 */

(() => {
  "use strict";

  const api = globalThis.browser ?? globalThis.chrome;
  const $ = (id) => document.getElementById(id);

  const ON = "#30c552";
  const OFF = "rgba(128, 128, 128, 0.5)";
  const WARN = "#ff9f0a";

  function bindSwitch(toggleId, dotId, key, invert) {
    const toggle = $(toggleId);
    const dot = $(dotId);
    const paint = (on) => {
      toggle.checked = on;
      dot.style.background = on !== !!invert ? ON : OFF;
    };
    api.storage.local.get(key).then((res) => paint(res[key] !== false));
    toggle.addEventListener("change", () => {
      paint(toggle.checked);
      api.storage.local.set({ [key]: toggle.checked });
    });
  }

  bindSwitch("hide-shorts-toggle", "shorts-dot", "hideShorts");
  bindSwitch("shield-toggle", "shield-dot", "shieldEnabled");
  bindSwitch("sandbox-toggle", "sandbox-dot", "sandboxPlayers");

  // ---- per-site row ------------------------------------------------
  async function initSiteRow() {
    let stats = null;
    try {
      const [tab] = await api.tabs.query({ active: true, currentWindow: true });
      if (!tab || tab.id == null) return;
      stats = await api.tabs.sendMessage(tab.id, { type: "gb:stats" });
    } catch (_) {
      return; // no content script in this tab
    }
    if (!stats || !stats.host) return;

    const row = $("site-row");
    const host = stats.host;
    $("site-host").textContent = host;
    const stat = $("site-stat");
    const dot = $("site-dot");
    const toggle = $("site-toggle");

    const paint = (paused) => {
      toggle.checked = paused;
      if (paused) {
        stat.textContent = "paused";
        dot.style.background = OFF;
      } else if (stats.blocked > 0) {
        stat.textContent = `${stats.blocked} blocked`;
        dot.style.background = WARN;
      } else {
        stat.textContent = stats.hostile ? "hijack seen" : "clean";
        dot.style.background = stats.hostile ? WARN : ON;
      }
    };
    paint(!!stats.paused);
    row.hidden = false;

    toggle.addEventListener("change", async () => {
      const res = await api.storage.local.get("shieldPaused");
      const paused = res.shieldPaused && typeof res.shieldPaused === "object" ? { ...res.shieldPaused } : {};
      if (toggle.checked) paused[host] = true;
      else delete paused[host];
      await api.storage.local.set({ shieldPaused: paused });
      paint(toggle.checked);
    });
  }

  initSiteRow();
})();
