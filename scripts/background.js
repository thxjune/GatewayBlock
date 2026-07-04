/**
 * GatewayBlock — background script
 * Minimal by design: all blocking is declarative (rules/*.json) and
 * all page logic lives in content scripts. This just confirms the
 * extension is alive and stamps the install time.
 */

const api = typeof browser !== "undefined" ? browser : chrome;

api.runtime.onInstalled.addListener(() => {
  api.storage.local.set({ installedAt: Date.now() });
  console.log("[GatewayBlock] installed — declarative rules active.");
});
