/*
 * Spectra bridge — isolated-world content script on open.spotify.com.
 * Reads settings from extension storage, compiles them and hands the payload
 * to the MAIN-world runtime. Only a tiny, fixed set of messages flows back.
 */
(function () {
  "use strict";
  const api = globalThis.browser || globalThis.chrome;
  const Core = globalThis.SpectraCore;

  let cssMap = null;
  let current = null;
  // Mozilla's policy forbids remote code in Firefox add-ons, so remote scripts only run in the Chrome build.
  // (Only the Firefox build's manifest has browser_specific_settings.gecko.)
  let isFirefox = true;
  try { isFirefox = !!(api.runtime.getManifest().browser_specific_settings || {}).gecko; } catch {}

  function send(payload) {
    window.postMessage({ source: "spectra-bridge", type: "payload", payload }, "*");
  }

  async function refresh() {
    const data = await api.storage.local.get(["state", "cssMap", "remote"]);
    if (data.cssMap && data.cssMap.map) cssMap = data.cssMap.map;
    else api.runtime.sendMessage({ type: "ensureCssMap" }).catch(() => {});
    const remote = data.remote && data.remote.data ? data.remote.data : null;
    current = Core.compilePayload(data.state, remote, { platform: "web", allowRemoteScripts: !isFirefox });
    current.cssMap = cssMap;
    send(current);
  }

  api.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && (changes.state || changes.cssMap || changes.remote)) refresh();
  });

  window.addEventListener("message", (e) => {
    if (e.source !== window || !e.data || e.data.source !== "spectra-runtime") return;
    // Never trust page-originated messages for anything privileged.
    switch (e.data.type) {
      case "ready":
        if (current) send(current);
        break;
      case "openDashboard":
        api.runtime.sendMessage({ type: "openDashboard" }).catch(() => {});
        break;
    }
  });

  refresh();
  // Pick up edits from the update server while Spotify stays open.
  const pollRemote = () => api.runtime.sendMessage({ type: "ensureRemote" }).catch(() => {});
  pollRemote();
  setInterval(pollRemote, 5 * 60 * 1000);
})();
