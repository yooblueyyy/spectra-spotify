(function () {
  "use strict";
  const api = globalThis.browser || globalThis.chrome;
  const Core = globalThis.SpectraCore;
  const $ = (s) => document.querySelector(s);
  let S;

  function render() {
    $("#master").checked = S.enabled;
    $("#status").textContent = S.enabled ? "Live on open.spotify.com" : "Paused, Spotify looks stock";
    $("#head").classList.toggle("off", !S.enabled);
    const t = S.theme;
    $("#theme-name").textContent = t ? t.name : "Stock Spotify";
    $("#theme-sub").textContent = t ? (t.authors && t.authors[0] ? "by " + t.authors[0].name : "Theme") : "No theme yet";
    if (t && t.preview) $("#art").src = t.preview; else $("#art").removeAttribute("src");
    const names = t ? Object.keys(t.schemes || {}) : [];
    $("#schemes-wrap").hidden = names.length < 2;
    $("#schemes").replaceChildren(...names.map((n) => {
      const b = document.createElement("button");
      b.className = "chip" + ((S.scheme || names[0]) === n ? " on" : "");
      b.textContent = n;
      b.onclick = async () => { S.scheme = n; S.colorOverrides = {}; await api.storage.local.set({ state: S }); render(); };
      return b;
    }));
    $("#n-ext").textContent = S.extensions.filter((e) => e.enabled).length;
    $("#n-snip").textContent = S.snippets.filter((s) => s.enabled).length;
    $("#n-css").textContent = (S.customCSS || "").split("\n").filter((l) => l.trim()).length;
  }

  $("#master").onchange = async (e) => { S.enabled = e.target.checked; await api.storage.local.set({ state: S }); render(); };
  $("#open").onclick = () => { api.runtime.sendMessage({ type: "openDashboard" }); window.close(); };
  $("#spotify").onclick = async () => {
    const tabs = await api.tabs.query({ url: "https://open.spotify.com/*" });
    if (tabs[0]) { api.tabs.update(tabs[0].id, { active: true }); api.windows.update(tabs[0].windowId, { focused: true }); }
    else api.tabs.create({ url: "https://open.spotify.com/" });
    window.close();
  };

  api.storage.local.get("state").then(({ state }) => { S = Core.normalizeState(state); render(); });
})();
