/*
 * Spectra background (Chrome service worker / Firefox event page).
 *  - keeps Spicetify's css-map.json cached
 *  - fetches the remote config from Spectra's update server
 *  - opens the dashboard
 */
if (typeof importScripts === "function" && !globalThis.SpectraCore) importScripts("shared/core.js");

const api = globalThis.browser || globalThis.chrome;
const Core = globalThis.SpectraCore;
const CSS_MAP_URL = "https://raw.githubusercontent.com/spicetify/cli/main/css-map.json";
const CSS_MAP_TTL = 24 * 60 * 60 * 1000;

async function ensureCssMap(force) {
  const { cssMap } = await api.storage.local.get("cssMap");
  if (!force && cssMap && cssMap.map && Date.now() - cssMap.fetchedAt < CSS_MAP_TTL) return cssMap.map;
  try {
    const res = await fetch(CSS_MAP_URL, { cache: "no-cache" });
    if (!res.ok) throw new Error("HTTP " + res.status);
    const map = await res.json();
    await api.storage.local.set({ cssMap: { map, fetchedAt: Date.now() } });
    return map;
  } catch (e) {
    console.warn("[Spectra] css-map fetch failed", e);
    return cssMap ? cssMap.map : null;
  }
}

// Featured catalog, CSS hotfixes, class-map fixes and remote scripts from the update server.
// Cached for a few minutes; failures keep the last good copy.
let remoteInflight = null;
async function ensureRemote(force) {
  const { remote, state } = await api.storage.local.get(["remote", "state"]);
  if (!force && remote && remote.fetchedAt && Date.now() - remote.fetchedAt < Core.REMOTE_TTL) return remote;
  if (remoteInflight) return remoteInflight;
  remoteInflight = (async () => {
    const base = Core.apiBase(Core.normalizeState(state));
    try {
      const res = await fetch(base + "/api/manifest", { cache: "no-cache" });
      if (!res.ok) throw new Error("HTTP " + res.status);
      const data = await res.json();
      const next = { data, fetchedAt: Date.now(), from: base };
      await api.storage.local.set({ remote: next });
      return next;
    } catch (e) {
      console.warn("[Spectra] update server unreachable", e);
      if (remote) await api.storage.local.set({ remote: Object.assign({}, remote, { fetchedAt: Date.now(), error: String(e.message || e) }) });
      return remote || null;
    } finally {
      remoteInflight = null;
    }
  })();
  return remoteInflight;
}

function openDashboard(hash) {
  const url = api.runtime.getURL("dashboard/index.html") + (hash ? "#" + hash : "");
  return api.tabs.create({ url });
}

// ---------------- lifecycle & messages ----------------

api.runtime.onInstalled.addListener(async (details) => {
  const { state } = await api.storage.local.get("state");
  await api.storage.local.set({ state: Core.normalizeState(state) });
  ensureCssMap(true);
  ensureRemote(true);
  if (details.reason === "install") openDashboard("welcome");
});

if (api.runtime.onStartup) api.runtime.onStartup.addListener(() => { ensureCssMap(false); ensureRemote(false); });

api.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || typeof msg !== "object") return;
  // Messages from content scripts are limited to harmless requests.
  const fromPage = sender.tab && !String(sender.url || "").startsWith(api.runtime.getURL(""));
  switch (msg.type) {
    case "openDashboard":
      openDashboard(msg.hash);
      return;
    case "ensureRemote":
      ensureRemote(!!msg.force && !fromPage).then((r) => sendResponse({ ok: !!(r && r.data), fetchedAt: r && r.fetchedAt, error: r && r.error }));
      return true;
    case "appInfo":
      sendResponse({ platform: "web", version: api.runtime.getManifest().version });
      return;
    case "ensureCssMap":
      ensureCssMap(!!msg.force && !fromPage).then((m) => sendResponse({ ok: !!m }));
      return true;
    case "reloadSpotifyTabs":
      if (fromPage) return;
      api.tabs.query({ url: "https://open.spotify.com/*" }).then((tabs) => {
        tabs.forEach((t) => api.tabs.reload(t.id));
        sendResponse({ count: tabs.length });
      });
      return true;
  }
});
