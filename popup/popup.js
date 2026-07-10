/**
 * GatewayBlock — popup logic (external file: MV3 CSP forbids inline scripts)
 *
 * One setting for now: hideShorts. A missing key means ON — the same
 * default the content scripts assume — so a fresh install shows the
 * switch on and behaves that way without ever writing storage.
 * Content scripts listen via storage.onChanged, so flipping the switch
 * applies to open YouTube tabs instantly.
 */

(() => {
  "use strict";

  const api = globalThis.browser ?? globalThis.chrome;
  const toggle = document.getElementById("hide-shorts-toggle");
  const dot = document.getElementById("shorts-dot");

  function paint(on) {
    toggle.checked = on;
    // Match the status dots on the other rows: green when active,
    // grey when the feature is off.
    dot.style.background = on ? "#30c552" : "rgba(128, 128, 128, 0.5)";
  }

  api.storage.local.get("hideShorts").then((res) => {
    paint(res.hideShorts !== false);
  });

  toggle.addEventListener("change", () => {
    paint(toggle.checked);
    api.storage.local.set({ hideShorts: toggle.checked });
  });
})();
