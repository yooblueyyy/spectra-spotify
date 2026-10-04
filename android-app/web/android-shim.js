/*
 * Spectra for Android: gives the shared dashboard the same storage/messaging API
 * it uses in the browser extension and desktop app, backed by the native
 * SpectraNative bridge (only exposed to the dashboard's own WebView).
 */
(function () {
  "use strict";
  const N = window.SpectraNative;
  const listeners = new Set();
  const parse = (s, fallback) => { try { return s ? JSON.parse(s) : fallback; } catch { return fallback; } };

  // Called by the native side whenever stored settings change.
  window.__spectraStorageChanged = function (changes) {
    for (const fn of listeners) { try { fn(changes, "local"); } catch (e) { console.error(e); } }
  };

  window.spectraHost = {
    storage: {
      local: {
        get: async (keys) => parse(N.storageGet(JSON.stringify(keys == null ? null : keys)), {}),
        set: async (obj) => { N.storageSet(JSON.stringify(obj || {})); },
      },
      onChanged: { addListener: (fn) => { listeners.add(fn); } },
    },
    runtime: {
      spectraApp: true,
      platform: "android",
      sendMessage: async (msg) => parse(N.sendMessage(JSON.stringify(msg || {})), {}),
      getURL: (p) => p,
    },
    permissions: { contains: async () => true, request: async () => true },
  };
  document.documentElement.classList.add("is-app", "is-android");
})();
