/* Spectra dashboard */
(function () {
  "use strict";
  const api = globalThis.spectraHost || globalThis.browser || globalThis.chrome;
  const Core = globalThis.SpectraCore;

  const OFFICIAL = { owner: "spicetify", repo: "spicetify-themes", branch: "master" };
  const MARKET = { owner: "spicetify", repo: "marketplace", branch: "main" };
  const BLACKLIST_URL = `https://raw.githubusercontent.com/${MARKET.owner}/${MARKET.repo}/${MARKET.branch}/resources/blacklist.json`;
  const SNIPPETS_URL = `https://raw.githubusercontent.com/${MARKET.owner}/${MARKET.repo}/${MARKET.branch}/resources/snippets.json`;
  const CACHE_TTL = 6 * 60 * 60 * 1000;

  let S = Core.normalizeState(null);
  let lastWritten = null;

  // ------------------------------------------------------------------ helpers
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];

  function h(tag, attrs, ...kids) {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v == null || v === false) continue;
      if (k === "class") n.className = v;
      else if (k === "style" && typeof v === "object") Object.assign(n.style, v);
      else if (k.startsWith("on")) n.addEventListener(k.slice(2), v);
      else if (k in n && typeof v !== "string") n[k] = v;
      else n.setAttribute(k, v === true ? "" : v);
    }
    for (const c of kids.flat(Infinity)) if (c != null && c !== false) n.append(c instanceof Node ? c : String(c));
    return n;
  }
  const svg = (path) => { const t = document.createElement("template"); t.innerHTML = `<svg viewBox="0 0 24 24"><path d="${path}"/></svg>`; return t.content.firstChild; };

  function toast(msg, isError) {
    const t = h("div", { class: "toast" + (isError ? " error" : "") }, msg);
    $("#toasts").append(t);
    setTimeout(() => t.remove(), isError ? 6000 : 2600);
  }

  async function busy(btn, label, fn) {
    const old = [...btn.childNodes];
    btn.disabled = true;
    btn.replaceChildren(h("span", { class: "spin" }), label);
    try { return await fn(); }
    finally { btn.disabled = false; btn.replaceChildren(...old); }
  }

  async function save() {
    lastWritten = JSON.stringify(S);
    await api.storage.local.set({ state: S });
  }

  const debounce = (fn, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };
  const saveSoon = debounce(save, 160);

  // ------------------------------------------------------------------ network
  class RateLimitError extends Error {}

  async function ghFetch(url, as = "json") {
    const headers = {};
    if (S.options.githubToken && url.startsWith("https://api.github.com/")) headers.Authorization = `Bearer ${S.options.githubToken}`;
    const res = await fetch(url, { headers, cache: "no-cache" });
    if ((res.status === 403 || res.status === 429) && url.includes("api.github.com")) {
      const reset = +res.headers.get("x-ratelimit-reset");
      const mins = reset ? Math.max(1, Math.ceil((reset * 1000 - Date.now()) / 60000)) : null;
      throw new RateLimitError(`GitHub rate limit reached${mins ? `, try again in ~${mins} min` : ""}. Adding a GitHub token in Settings raises the limit.`);
    }
    if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
    return as === "json" ? res.json() : res.text();
  }

  async function cached(key, fn, ttl = CACHE_TTL) {
    const k = "spectra-cache:" + key;
    try {
      const hit = JSON.parse(localStorage.getItem(k) || "null");
      if (hit && Date.now() - hit.t < ttl) return hit.v;
    } catch {}
    const v = await fn();
    try { localStorage.setItem(k, JSON.stringify({ t: Date.now(), v })); } catch {}
    return v;
  }

  async function pool(items, n, fn) {
    const out = new Array(items.length);
    let i = 0;
    await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
      while (i < items.length) { const idx = i++; try { out[idx] = await fn(items[idx], idx); } catch { out[idx] = null; } }
    }));
    return out;
  }

  let blacklistP = null;
  function blacklist() {
    blacklistP = blacklistP || cached("blacklist", async () => {
      const j = await ghFetch(BLACKLIST_URL);
      return (j.repos || []).filter((r) => r.startsWith("http")).map((r) => r.toLowerCase().replace(/\/$/, ""));
    }).catch(() => []);
    return blacklistP;
  }

  function normalizeEntry(e, repo, kind, official) {
    if (!e || typeof e !== "object" || !e.name) return null;
    const raw = (p) => (p ? Core.rawUrl(repo.owner, repo.repo, repo.branch, p) : null);
    const item = {
      kind,
      key: `${repo.owner}/${repo.repo}:${e.name}`,
      name: String(e.name),
      description: String(e.description || ""),
      authors: Array.isArray(e.authors) ? e.authors.filter((a) => a && a.name) : [{ name: repo.owner, url: `https://github.com/${repo.owner}` }],
      tags: Array.isArray(e.tags) ? e.tags.map(String).slice(0, 6) : [],
      preview: raw(e.preview),
      readme: raw(e.readme),
      owner: repo.owner, repo: repo.repo, branch: repo.branch,
      stars: repo.stars || 0,
      official: !!official,
      url: `https://github.com/${repo.owner}/${repo.repo}`,
    };
    if (kind === "theme") {
      if (!e.usercss && !e.schemes) return null;
      item.usercss = e.usercss || null;
      item.schemes = e.schemes || null;
      item.include = Array.isArray(e.include) ? e.include : [];
    } else {
      if (!e.main) return null;
      item.main = e.main;
    }
    return item;
  }

  async function officialThemes() {
    return cached("official-themes", async () => {
      const list = await ghFetch(Core.rawUrl(OFFICIAL.owner, OFFICIAL.repo, OFFICIAL.branch, "manifest.json"));
      return list.map((e) => normalizeEntry(e, OFFICIAL, "theme", true)).filter(Boolean);
    });
  }

  async function communityPage(topic, kind, page) {
    return cached(`community:${topic}:${page}`, async () => {
      const q = encodeURIComponent(`topic:${topic}`);
      const res = await ghFetch(`https://api.github.com/search/repositories?q=${q}&sort=stars&order=desc&per_page=30&page=${page}`);
      const bl = await blacklist();
      const repos = (res.items || []).filter((r) => !r.archived && !bl.includes(r.html_url.toLowerCase()) &&
        r.full_name.toLowerCase() !== `${OFFICIAL.owner}/${OFFICIAL.repo}`);
      const results = await pool(repos, 8, async (r) => {
        const repo = { owner: r.owner.login, repo: r.name, branch: r.default_branch, stars: r.stargazers_count };
        const m = await ghFetch(Core.rawUrl(repo.owner, repo.repo, repo.branch, "manifest.json"));
        return [].concat(m).map((e) => normalizeEntry(e, repo, kind, false)).filter(Boolean);
      });
      return { items: results.flat().filter(Boolean), total: res.total_count || 0 };
    });
  }

  // ------------------------------------------------------------------ cards
  function initials(name) { return name.replace(/[^A-Za-z0-9 ]/g, "").split(/\s+/).map((w) => w[0]).join("").slice(0, 3).toUpperCase() || "?"; }

  function mediaEl(item, onClick) {
    const media = h("div", { class: "card-media", onclick: onClick, title: "Details" }, h("div", { class: "ph" }, initials(item.name || item.title || "?")));
    if (item.preview) {
      const img = h("img", { loading: "lazy", alt: "", referrerpolicy: "no-referrer" });
      img.addEventListener("load", () => { img.classList.add("loaded"); media.querySelector(".ph")?.remove(); });
      img.addEventListener("error", () => img.remove());
      img.src = item.preview;
      media.prepend(img);
    }
    return media;
  }

  function authorLine(item) {
    const a = item.authors && item.authors[0];
    return h("div", { class: "card-meta" },
      a ? h("span", {}, "by ", a.name) : null,
      item.stars ? h("span", {}, "★ ", String(item.stars)) : null,
      ...(item.tags || []).filter((t) => t !== "latest").slice(0, 2).map((t) => h("span", { class: "tag" + (/outdated|broken|archived/i.test(t) ? " warn" : "") }, t)));
  }

  function skeletons(container, n) {
    container.replaceChildren(...Array.from({ length: n }, () => h("div", { class: "skeleton" })));
  }

  function errorBox(container, err, retry) {
    const box = h("div", { class: "error-box" }, h("strong", {}, "Couldn't load this list. "), err.message || String(err), " ");
    if (retry) box.append(h("button", { class: "btn ghost small", onclick: retry }, "Retry"));
    container.replaceChildren(box);
  }

  // ------------------------------------------------------------------ safe README rendering
  function renderReadme(md, base) {
    const wrap = h("div", { class: "readme" });
    const esc = (s) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
    const abs = (u) => { try { const x = new URL(u, base); return /^https?:$/.test(x.protocol) ? x.href : null; } catch { return null; } };
    // Strip raw HTML entirely, then render a small, safe markdown subset.
    const text = md.replace(/<!--[\s\S]*?-->/g, "").replace(/<img[^>]*src=["']([^"']+)["'][^>]*>/gi, "![]($1)").replace(/<[^>]+>/g, "");
    const inline = (s) => esc(s)
      .replace(/!\[([^\]]*)\]\(([^)\s]+)[^)]*\)/g, (m, alt, u) => { const a = abs(u.replace(/&amp;/g, "&")); return a ? `<img alt="${alt}" src="${esc(a)}" loading="lazy" referrerpolicy="no-referrer">` : ""; })
      .replace(/\[([^\]]+)\]\(([^)\s]+)[^)]*\)/g, (m, t, u) => { const a = abs(u.replace(/&amp;/g, "&")); return a ? `<a href="${esc(a)}" target="_blank" rel="noopener noreferrer">${t}</a>` : t; })
      .replace(/\*\*([^*]+)\*\*/g, "<b>$1</b>").replace(/`([^`]+)`/g, "<code>$1</code>");
    const out = [];
    let inCode = false, code = [];
    for (const block of text.replace(/\r/g, "").split(/\n{2,}/)) {
      const lines = block.split("\n");
      if (inCode || /^```/.test(lines[0])) {
        for (const l of lines) {
          if (/^```/.test(l)) { if (inCode) { out.push(`<pre>${esc(code.join("\n"))}</pre>`); code = []; } inCode = !inCode; }
          else if (inCode) code.push(l);
        }
        if (inCode) code.push("");
        continue;
      }
      for (let i = 0; i < lines.length; i++) {
        const hm = lines[i].match(/^(#{1,4})\s+(.*)$/);
        if (hm) { out.push(`<h3>${inline(hm[2])}</h3>`); continue; }
        if (/^\s*[-*+]\s+/.test(lines[i])) {
          const items = [];
          while (i < lines.length && /^\s*[-*+]\s+/.test(lines[i])) items.push(`<li>${inline(lines[i++].replace(/^\s*[-*+]\s+/, ""))}</li>`);
          i--;
          out.push(`<ul>${items.join("")}</ul>`);
          continue;
        }
        const para = [];
        while (i < lines.length && !/^(#{1,4})\s|^\s*[-*+]\s+/.test(lines[i])) para.push(lines[i++]);
        i--;
        if (para.join("").trim()) out.push(`<p>${inline(para.join(" "))}</p>`);
      }
    }
    wrap.innerHTML = out.join("");
    return wrap;
  }

  function openDrawer(...content) {
    $("#drawer-content").replaceChildren(...content.filter((c) => c != null && c !== false));
    $("#drawer").hidden = false;
  }
  function closeDrawer() { $("#drawer").hidden = true; }
  $("#drawer-close").onclick = closeDrawer;
  $("#drawer").addEventListener("mousedown", (e) => { if (e.target.id === "drawer") closeDrawer(); });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeDrawer(); });

  async function showDetails(item, actions) {
    const readme = h("div", { class: "muted" }, item.readme ? "Loading README…" : "");
    openDrawer(
      h("div", { class: "card-meta" }, item.official ? h("span", { class: "tag" }, "Official") : null, item.kind),
      h("h2", {}, item.name || item.title),
      authorLine(item),
      item.description ? h("p", { class: "muted" }, item.description) : null,
      h("div", { class: "row-gap wrap" }, ...actions, item.url ? h("a", { class: "btn ghost", href: item.url, target: "_blank", rel: "noopener noreferrer" }, "View on GitHub") : null),
      item.preview ? h("img", { class: "big", src: item.preview, alt: "", referrerpolicy: "no-referrer" }) : null,
      item.code ? h("pre", {}, item.code) : null,
      readme);
    if (item.readme) {
      try {
        const md = await ghFetch(item.readme, "text");
        readme.replaceWith(renderReadme(md, item.readme));
      } catch { readme.textContent = ""; }
    }
  }

  // ------------------------------------------------------------------ THEMES
  const themeList = { official: [], community: [], page: 0, total: 0, loading: false };

  function dirname(p) { return p && p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : ""; }
  function basename(p) { return String(p).split(/[/?#]/).filter(Boolean).pop() || "script.js"; }

  async function installTheme(item) {
    const raw = (p) => Core.rawUrl(item.owner, item.repo, item.branch, p);
    const [cssRaw, ini] = await Promise.all([
      item.usercss ? ghFetch(raw(item.usercss), "text") : "",
      item.schemes ? ghFetch(raw(item.schemes), "text").catch(() => "") : "",
    ]);
    const base = /^https?:/i.test(item.usercss || "") ? new URL(".", item.usercss).href : Core.cdnBase(item.owner, item.repo, item.branch, dirname(item.usercss || ""));
    const scripts = [];
    for (const inc of item.include || []) {
      try { scripts.push({ name: basename(inc), code: await ghFetch(raw(inc), "text") }); }
      catch (e) { toast(`Skipped theme script ${basename(inc)}: ${e.message}`, true); }
    }
    const schemes = Core.parseColorIni(ini);
    S.theme = {
      id: item.key, name: item.name, css: Core.absolutizeCSS(cssRaw, base), schemes, scripts,
      preview: item.preview, readme: item.readme, url: item.url, authors: item.authors,
      source: { owner: item.owner, repo: item.repo, branch: item.branch, usercss: item.usercss, schemes: item.schemes, include: item.include },
      installedAt: Date.now(),
    };
    S.scheme = Object.keys(schemes)[0] || null;
    S.colorOverrides = {};
    await save();
    toast(`${item.name} applied${scripts.length ? " · reload Spotify to start its scripts" : ""}`);
    renderThemes();
    renderColors();
  }

  async function removeTheme() {
    const name = S.theme && S.theme.name;
    S.theme = null; S.scheme = null; S.colorOverrides = {};
    await save();
    toast(`${name || "Theme"} removed. Back to stock Spotify.`);
    renderThemes(); renderColors();
  }

  function themeCard(item) {
    const applied = S.theme && S.theme.id === item.key;
    const btn = h("button", { class: "btn " + (applied ? "ghost" : "primary") + " small" }, applied ? "Remove" : "Apply");
    btn.onclick = (e) => { e.stopPropagation(); applied ? removeTheme() : busy(btn, "Applying", () => installTheme(item).catch((err) => toast(err.message, true))); };
    const details = () => {
      const b = h("button", { class: "btn primary" }, applied ? "Re-install" : "Apply theme");
      b.onclick = () => busy(b, "Applying", () => installTheme(item).then(closeDrawer).catch((err) => toast(err.message, true)));
      showDetails(item, [b]);
    };
    const media = mediaEl(item, details);
    if (applied) media.append(h("span", { class: "badge ok" }, "Applied"));
    else if (item.featured) media.append(h("span", { class: "badge featured" }, "Featured"));
    else if (item.official) media.append(h("span", { class: "badge" }, "Official"));
    return h("div", { class: "card" + (applied ? " applied" : "") }, media,
      h("div", { class: "card-body" },
        h("div", { class: "card-title" }, item.name),
        authorLine(item),
        item.description && item.description !== item.name ? h("div", { class: "card-desc" }, item.description) : null,
        h("div", { class: "card-actions" }, btn, h("button", { class: "btn ghost small", onclick: details }, "Details"))));
  }

  function schemeSwatch(sc) {
    const pal = Object.assign({}, Core.BASE_COLORS, sc);
    return h("span", { class: "sw" }, ...["main", "sidebar", "player", "text", "button"].map((k) => h("i", { style: { background: "#" + pal[k] } })));
  }

  function renderCurrentTheme() {
    const box = $("#current-theme");
    if (!S.theme) {
      box.replaceChildren(h("div", { class: "hero" },
        h("div", { class: "card-media", style: { borderRadius: "10px" } }, h("div", { class: "ph" }, "Stock")),
        h("div", {}, h("div", { class: "eyebrow" }, "Current theme"), h("h2", {}, "Spotify default"),
          h("p", { class: "muted" }, "No theme applied yet. Pick one below and it shows up in Spotify instantly."))));
      return;
    }
    const t = S.theme;
    const names = Object.keys(t.schemes || {});
    box.replaceChildren(h("div", { class: "hero" },
      t.preview ? h("img", { src: t.preview, alt: "", referrerpolicy: "no-referrer" }) : h("div", { class: "card-media", style: { borderRadius: "10px" } }, h("div", { class: "ph" }, initials(t.name))),
      h("div", {},
        h("div", { class: "eyebrow" }, "Current theme"),
        h("h2", {}, t.name),
        t.authors && t.authors[0] ? h("div", { class: "muted" }, "by ", t.authors[0].name) : null,
        names.length ? h("div", { class: "scheme-chips" }, ...names.map((n) => h("button", {
          class: "chip" + ((S.scheme || names[0]) === n ? " on" : ""),
          onclick: async () => { S.scheme = n; S.colorOverrides = {}; await save(); renderCurrentTheme(); renderColors(); },
        }, schemeSwatch(t.schemes[n]), n))) : null,
        h("div", { class: "hero-actions" },
          h("button", { class: "btn ghost small", onclick: () => switchView("colors") }, "Tweak colors"),
          h("button", { class: "btn ghost small", onclick: (e) => busy(e.currentTarget, "Updating", () => reinstallCurrentTheme()) }, "Update"),
          h("button", { class: "btn danger small", onclick: removeTheme }, "Remove")))));
  }

  async function reinstallCurrentTheme() {
    const t = S.theme;
    if (!t || !t.source) return;
    const keepScheme = S.scheme, keepOverrides = S.colorOverrides;
    await installTheme(Object.assign({}, t.source, { key: t.id, name: t.name, preview: t.preview, readme: t.readme, url: t.url, authors: t.authors }));
    if (keepScheme && S.theme.schemes[keepScheme]) S.scheme = keepScheme;
    S.colorOverrides = keepOverrides;
    await save();
    renderThemes(); renderColors();
  }

  function filterItems(list, q) {
    q = q.trim().toLowerCase();
    if (!q) return list;
    return list.filter((i) => [i.name, i.title, i.description, ...(i.authors || []).map((a) => a.name), ...(i.tags || [])].join(" ").toLowerCase().includes(q));
  }

  function renderThemes() {
    renderCurrentTheme();
    const q = $("#theme-search").value;
    const off = filterItems(themeList.official, q);
    const com = filterItems(themeList.community, q);
    if (themeList.official.length) $("#official-themes").replaceChildren(...(off.length ? off.map(themeCard) : [h("div", { class: "empty" }, "No official themes match.")]));
    if (themeList.community.length || themeList.page) $("#community-themes").replaceChildren(...(com.length ? com.map(themeCard) : [h("div", { class: "empty" }, themeList.loading ? "Loading…" : "No community themes match.")]));
    $("#official-count").textContent = themeList.official.length ? `${themeList.official.length} themes` : "";
    $("#community-count").textContent = themeList.community.length ? `${themeList.community.length} loaded` : "";
    $("#more-themes").hidden = !themeList.page || themeList.page * 30 >= themeList.total;
  }

  async function loadOfficialThemes() {
    skeletons($("#official-themes"), 6);
    try { themeList.official = await officialThemes(); renderThemes(); }
    catch (e) { errorBox($("#official-themes"), e, loadOfficialThemes); }
  }

  async function loadCommunityThemes() {
    if (themeList.loading) return;
    themeList.loading = true;
    if (!themeList.page) skeletons($("#community-themes"), 6);
    try {
      const { items, total } = await communityPage("spicetify-themes", "theme", themeList.page + 1);
      themeList.page++;
      themeList.total = total;
      const seen = new Set(themeList.community.map((i) => i.key));
      themeList.community.push(...items.filter((i) => !seen.has(i.key)));
      themeList.loading = false;
      renderThemes();
    } catch (e) {
      themeList.loading = false;
      if (themeList.page) toast(e.message, true);
      else errorBox($("#community-themes"), e, loadCommunityThemes);
    }
  }

  $("#theme-search").addEventListener("input", debounce(renderThemes, 120));
  $("#more-themes").onclick = (e) => busy(e.currentTarget, "Loading", loadCommunityThemes);

  // ------------------------------------------------------------------ COLORS
  function applyMock(palette) {
    const mock = $("#mock");
    for (const [k, v] of Object.entries(palette)) {
      mock.style.setProperty(`--spice-${k}`, "#" + v);
      mock.style.setProperty(`--spice-rgb-${k}`, Core.hexToRgb(v).join(","));
    }
  }

  function renderColors() {
    const names = S.theme ? Object.keys(S.theme.schemes || {}) : [];
    const list = $("#scheme-list");
    if (!names.length) {
      list.replaceChildren(h("span", { class: "muted" }, S.theme ? "This theme has no colour schemes. Tweak the palette below instead." : "Apply a theme to choose from its schemes, or start from Spotify's default palette below."));
    } else {
      list.replaceChildren(...names.map((n) => h("button", {
        class: "chip" + ((S.scheme || names[0]) === n ? " on" : ""),
        onclick: async () => { S.scheme = n; S.colorOverrides = {}; await save(); renderColors(); renderCurrentTheme(); },
      }, schemeSwatch(S.theme.schemes[n]), n)));
    }
    const palette = Core.resolvePalette(S);
    const pal = $("#palette");
    pal.replaceChildren(...Core.COLOR_ORDER.map((k) => {
      const v = h("span", { class: "v" }, "#" + palette[k]);
      const row = h("label", { class: "pal" + (S.colorOverrides[k] ? " changed" : ""), title: S.colorOverrides[k] ? "Tweaked" : "" });
      const input = h("input", { type: "color", value: "#" + palette[k] });
      input.addEventListener("input", () => {
        const hex = input.value.slice(1).toLowerCase();
        S.colorOverrides[k] = hex;
        v.textContent = "#" + hex;
        row.classList.add("changed");
        applyMock(Core.resolvePalette(S));
        saveSoon();
      });
      row.append(input, h("div", {}, h("div", { class: "k" }, k), v));
      return row;
    }));
    applyMock(palette);
  }

  $("#reset-colors").onclick = async () => { S.colorOverrides = {}; await save(); renderColors(); toast("Colour tweaks reset"); };

  // ------------------------------------------------------------------ EXTENSIONS
  const extList = { items: [], page: 0, total: 0, loading: false };

  function rawFromGithubUrl(u) {
    const m = u.match(/^https:\/\/github\.com\/([^/]+)\/([^/]+)\/blob\/([^/]+)\/(.+)$/);
    return m ? `https://raw.githubusercontent.com/${m[1]}/${m[2]}/${m[3]}/${m[4]}` : u;
  }

  async function installExtension(item) {
    const code = await ghFetch(Core.rawUrl(item.owner, item.repo, item.branch, item.main), "text");
    const existing = S.extensions.find((e) => e.id === item.key);
    const ext = {
      id: item.key, name: item.name, description: item.description, code, enabled: true,
      preview: item.preview, url: item.url, authors: item.authors,
      source: { owner: item.owner, repo: item.repo, branch: item.branch, path: item.main },
      installedAt: Date.now(),
    };
    if (existing) Object.assign(existing, ext); else S.extensions.push(ext);
    await save();
    toast(`${item.name} installed · reload Spotify to start it`);
    renderExtensions();
  }

  async function updateExtension(ext) {
    if (!ext.source) return false;
    const url = ext.source.url || Core.rawUrl(ext.source.owner, ext.source.repo, ext.source.branch, ext.source.path);
    const code = await ghFetch(url, "text");
    if (code === ext.code) return false;
    ext.code = code;
    ext.updatedAt = Date.now();
    return true;
  }

  function installedRow(ext) {
    const sw = h("input", { type: "checkbox", class: "switch", checked: ext.enabled, title: ext.enabled ? "Disable" : "Enable" });
    sw.onchange = async () => { ext.enabled = sw.checked; await save(); toast(`${ext.name} ${ext.enabled ? "enabled" : "disabled"} · reload Spotify to apply`); };
    const kb = (ext.code.length / 1024).toFixed(1) + " KB";
    return h("div", { class: "row" },
      h("div", { class: "grow" },
        h("div", { class: "title" }, ext.name),
        h("div", { class: "sub" }, isBlocked(ext) ? "Turned off by Spectra because it's known to cause problems · " : "", ext.source ? (ext.source.url || `${ext.source.owner}/${ext.source.repo}`) : "Pasted code", " · ", kb)),
      h("button", { class: "btn ghost small", onclick: () => showDetails(Object.assign({}, ext, { kind: "extension", code: ext.code.slice(0, 4000) + (ext.code.length > 4000 ? "\n…" : "") }), []) }, "View"),
      h("button", { class: "btn danger small", onclick: async () => {
        if (!confirm(`Remove ${ext.name}?`)) return;
        S.extensions = S.extensions.filter((e) => e !== ext);
        await save(); renderExtensions(); toast(`${ext.name} removed`);
      } }, "Remove"),
      sw);
  }

  function extCard(item) {
    const installed = S.extensions.find((e) => e.id === item.key);
    const btn = h("button", { class: "btn " + (installed ? "ghost" : "primary") + " small" }, installed ? "Installed" : "Install");
    btn.disabled = !!installed;
    btn.onclick = (e) => { e.stopPropagation(); busy(btn, "Installing", () => installExtension(item).catch((err) => toast(err.message, true))); };
    const details = () => {
      const b = h("button", { class: "btn primary" }, installed ? "Re-install" : "Install");
      b.onclick = () => busy(b, "Installing", () => installExtension(item).then(closeDrawer).catch((err) => toast(err.message, true)));
      showDetails(item, [b]);
    };
    const media = mediaEl(item, details);
    if (installed) media.append(h("span", { class: "badge ok" }, "Installed"));
    else if (item.featured) media.append(h("span", { class: "badge featured" }, "Featured"));
    return h("div", { class: "card" + (installed ? " applied" : "") }, media,
      h("div", { class: "card-body" },
        h("div", { class: "card-title" }, item.name),
        authorLine(item),
        item.description ? h("div", { class: "card-desc" }, item.description) : null,
        h("div", { class: "card-actions" }, btn, h("button", { class: "btn ghost small", onclick: details }, "Details"))));
  }

  function renderExtensions() {
    const inst = $("#installed-exts");
    inst.replaceChildren(...(S.extensions.length ? S.extensions.map(installedRow)
      : [h("div", { class: "empty" }, "No extensions yet. Install one from the marketplace below.")]));
    const q = $("#ext-search").value;
    const items = filterItems(extList.items, q);
    if (extList.page) $("#market-exts").replaceChildren(...(items.length ? items.map(extCard) : [h("div", { class: "empty" }, "No extensions match.")]));
    $("#ext-count").textContent = extList.items.length ? `${extList.items.length} loaded` : "";
    $("#more-exts").hidden = !extList.page || extList.page * 30 >= extList.total;
  }

  async function loadExtensions() {
    if (extList.loading) return;
    extList.loading = true;
    if (!extList.page) skeletons($("#market-exts"), 6);
    try {
      const { items, total } = await communityPage("spicetify-extensions", "extension", extList.page + 1);
      extList.page++;
      extList.total = total;
      const seen = new Set(extList.items.map((i) => i.key));
      extList.items.push(...items.filter((i) => !seen.has(i.key)));
      extList.loading = false;
      renderExtensions();
    } catch (e) {
      extList.loading = false;
      if (extList.page) toast(e.message, true);
      else errorBox($("#market-exts"), e, loadExtensions);
    }
  }

  $("#ext-search").addEventListener("input", debounce(renderExtensions, 120));
  $("#more-exts").onclick = (e) => busy(e.currentTarget, "Loading", loadExtensions);
  $("#update-exts").onclick = (e) => busy(e.currentTarget, "Checking", async () => {
    let n = 0;
    for (const ext of S.extensions) { try { if (await updateExtension(ext)) n++; } catch (err) { toast(`${ext.name}: ${err.message}`, true); } }
    if (n) await save();
    toast(n ? `Updated ${n} extension${n > 1 ? "s" : ""} · reload Spotify to apply` : "Everything is up to date");
    renderExtensions();
  });

  $("#add-ext").onclick = () => {
    const name = h("input", { class: "input", placeholder: "My extension", style: { width: "100%" } });
    const url = h("input", { class: "input mono", placeholder: "https://raw.githubusercontent.com/…/extension.js", style: { width: "100%" } });
    const code = h("textarea", { class: "input mono", placeholder: "// or paste JavaScript here", spellcheck: false });
    const add = h("button", { class: "btn primary" }, "Add extension");
    add.onclick = () => busy(add, "Adding", async () => {
      try {
        let src = code.value.trim();
        let source = null;
        const u = url.value.trim();
        if (!src && u) {
          if (!/^https:\/\//.test(u)) throw new Error("Use an https:// URL");
          const rawU = rawFromGithubUrl(u);
          src = await ghFetch(rawU, "text");
          source = { url: rawU };
        }
        if (!src) throw new Error("Enter a URL or paste code");
        const nm = name.value.trim() || (u ? basename(u).replace(/\.m?js$/, "") : "Custom extension");
        S.extensions.push({ id: Core.uid("ext"), name: nm, code: src, enabled: true, source, installedAt: Date.now() });
        await save();
        renderExtensions(); closeDrawer();
        toast(`${nm} added · reload Spotify to start it`);
      } catch (err) { toast(err.message, true); }
    });
    openDrawer(h("h2", {}, "Add an extension"),
      h("p", { class: "muted" }, "Extensions run with the same access as Spotify's own page. Only add code you trust."),
      h("div", { class: "field" }, h("label", {}, "Name"), name),
      h("div", { class: "field" }, h("label", {}, "Script URL"), url),
      h("div", { class: "field" }, h("label", {}, "…or code"), code),
      add);
  };

  // ------------------------------------------------------------------ SNIPPETS
  let marketSnippets = [];

  function snippetCard(sn) {
    const mine = S.snippets.find((s) => s.source === "market:" + sn.title);
    const btn = h("button", { class: "btn " + (mine ? "ghost" : "primary") + " small" }, mine ? "Remove" : "Add");
    btn.onclick = async () => {
      if (mine) S.snippets = S.snippets.filter((s) => s !== mine);
      else S.snippets.push({ id: Core.uid("snip"), title: sn.title, code: sn.code, enabled: true, source: "market:" + sn.title });
      await save(); renderSnippets();
      toast(mine ? `${sn.title} removed` : `${sn.title} added`);
    };
    const item = { name: sn.title, description: sn.description, preview: sn.preview, code: sn.code, kind: "snippet" };
    const media = mediaEl(item, () => showDetails(item, []));
    if (mine) media.append(h("span", { class: "badge ok" }, "Active"));
    return h("div", { class: "card" + (mine ? " applied" : "") }, media,
      h("div", { class: "card-body" }, h("div", { class: "card-title" }, sn.title),
        h("div", { class: "card-desc" }, sn.description || ""), h("div", { class: "card-actions" }, btn)));
  }

  function mySnippetRow(sn) {
    const sw = h("input", { type: "checkbox", class: "switch", checked: sn.enabled });
    sw.onchange = async () => { sn.enabled = sw.checked; await save(); };
    return h("div", { class: "row" },
      h("div", { class: "grow" }, h("div", { class: "title" }, sn.title), h("div", { class: "sub" }, sn.source && sn.source.startsWith("market:") ? "Marketplace" : "Custom")),
      h("button", { class: "btn ghost small", onclick: () => editSnippet(sn) }, "Edit"),
      h("button", { class: "btn danger small", onclick: async () => { S.snippets = S.snippets.filter((s) => s !== sn); await save(); renderSnippets(); } }, "Remove"),
      sw);
  }

  function editSnippet(sn) {
    const isNew = !sn;
    sn = sn || { id: Core.uid("snip"), title: "", code: "", enabled: true, source: "custom" };
    const title = h("input", { class: "input", value: sn.title, placeholder: "Snippet name", style: { width: "100%" } });
    const code = h("textarea", { class: "input mono", spellcheck: false, style: { minHeight: "300px" } });
    code.value = sn.code;
    const saveBtn = h("button", { class: "btn primary" }, isNew ? "Add snippet" : "Save");
    saveBtn.onclick = async () => {
      sn.title = title.value.trim() || "Untitled snippet";
      sn.code = code.value;
      if (isNew) S.snippets.push(sn);
      await save(); renderSnippets(); closeDrawer(); toast("Snippet saved");
    };
    openDrawer(h("h2", {}, isNew ? "New snippet" : "Edit snippet"),
      h("div", { class: "field" }, h("label", {}, "Name"), title),
      h("div", { class: "field" }, h("label", {}, "CSS"), code), saveBtn);
  }

  function renderSnippets() {
    $("#my-snippets").replaceChildren(...(S.snippets.length ? S.snippets.map(mySnippetRow) : [h("div", { class: "empty" }, "No snippets yet.")]));
    if (!marketSnippets.length) return;
    const items = filterItems(marketSnippets.map((s) => Object.assign({ name: s.title }, s)), $("#snippet-search").value);
    $("#market-snippets").replaceChildren(...(items.length ? items.map(snippetCard) : [h("div", { class: "empty" }, "No snippets match.")]));
    $("#snippet-count").textContent = `${marketSnippets.length} snippets`;
  }

  async function loadSnippets() {
    skeletons($("#market-snippets"), 6);
    try {
      const list = await cached("snippets", () => ghFetch(SNIPPETS_URL));
      marketSnippets = list.filter((s) => s && s.title && s.code).map((s) => Object.assign({}, s, {
        preview: s.preview ? Core.rawUrl(MARKET.owner, MARKET.repo, MARKET.branch, s.preview) : null,
      }));
      renderSnippets();
    } catch (e) { errorBox($("#market-snippets"), e, loadSnippets); }
  }
  $("#snippet-search").addEventListener("input", debounce(renderSnippets, 120));
  $("#add-snippet").onclick = () => editSnippet(null);

  // ------------------------------------------------------------------ CUSTOM CSS
  const cssBox = $("#custom-css");
  const cssSave = debounce(async () => { S.customCSS = cssBox.value; await save(); $("#css-status").textContent = "Saved · live"; }, 350);
  cssBox.addEventListener("input", () => { $("#css-status").textContent = "Saving…"; cssSave(); });
  cssBox.addEventListener("keydown", (e) => {
    if (e.key === "Tab") {
      e.preventDefault();
      const { selectionStart: s, selectionEnd: en } = cssBox;
      cssBox.setRangeText("  ", s, en, "end");
      cssBox.dispatchEvent(new Event("input"));
    }
  });

  // ------------------------------------------------------------------ SPOTIFY (desktop app only)
  const IS_APP = !!(api.runtime && api.runtime.spectraApp);
  const IS_ANDROID = !!(api.runtime && api.runtime.platform === "android");
  let spotifyTimer = null;
  const SPOTIFY_STATES = {
    connected: ["ok", "Spectra is active"],
    starting: ["warn", "Starting Spotify…"],
    "running-without-spectra": ["warn", "Spotify is running without Spectra"],
    "not-running": ["bad", "Spotify isn't running"],
    "not-found": ["bad", "Spotify not found"],
    error: ["bad", "Couldn't attach to Spotify"],
  };

  async function refreshSpotify() {
    if (!IS_APP || IS_ANDROID) return;
    let st;
    try { st = await api.runtime.sendMessage({ type: "spotifyStatus" }); } catch { st = { state: "error", message: "Spectra's background service didn't respond." }; }
    const [cls, title] = SPOTIFY_STATES[st.state] || SPOTIFY_STATES.error;
    const pill = $("#spotify-pill");
    pill.className = "status-pill " + cls;
    pill.lastChild.textContent = st.state === "connected" ? "Connected" : cls === "warn" ? "Waiting" : "Not connected";
    $("#spotify-title").textContent = title;
    $("#spotify-detail").textContent = st.message || "";
    $(".spotify-card").classList.toggle("off", st.state !== "connected");
    $("#spotify-dot").classList.toggle("on", st.state === "connected");
    const start = $("#spotify-start");
    start.hidden = st.state === "connected" || st.state === "starting";
    start.textContent = st.state === "running-without-spectra" ? "Restart Spotify with Spectra" : st.state === "not-found" ? "Try again" : "Start Spotify";
    start.dataset.restart = st.state === "running-without-spectra" ? "1" : "";
    $("#spotify-reload").hidden = st.state !== "connected";
    $("#spotify-path-hint").textContent = st.detectedPath ? `Detected: ${st.detectedPath}` : "Leave empty to detect it automatically.";
  }

  $("#spotify-start").onclick = (e) => {
    const restart = !!e.currentTarget.dataset.restart;
    if (restart && !confirm("Spotify will close and reopen. If music is playing, it will stop.")) return;
    busy(e.currentTarget, restart ? "Restarting" : "Starting", async () => {
      const r = await api.runtime.sendMessage({ type: "spotifyStart", restart });
      if (r && r.error) toast(r.error, true);
      refreshSpotify();
    });
  };
  $("#spotify-reload").onclick = () => api.runtime.sendMessage({ type: "reloadSpotifyTabs" });
  $$("[data-app-opt]").forEach((i) => i.addEventListener("change", async () => { S.app[i.dataset.appOpt] = i.checked; await save(); }));
  $("#spotify-path").addEventListener("change", async (e) => { S.app.spotifyPath = e.target.value.trim(); await save(); refreshSpotify(); });

  // ------------------------------------------------------------------ SETTINGS
  function renderSettings() {
    $$("[data-opt]").forEach((i) => { i.checked = !!S.options[i.dataset.opt]; });
    $("#gh-token").value = S.options.githubToken || "";
    if (document.activeElement !== $("#update-server")) $("#update-server").value = S.options.updateServer || "";
    $$("[data-app-opt]").forEach((i) => { i.checked = !!S.app[i.dataset.appOpt]; });
    if (document.activeElement !== $("#spotify-path")) $("#spotify-path").value = S.app.spotifyPath || "";
    $("#master").checked = S.enabled;
    $("#master-label").textContent = S.enabled ? "on" : "off";
    if (document.activeElement !== cssBox) cssBox.value = S.customCSS || "";
  }

  $$("[data-opt]").forEach((i) => i.addEventListener("change", async () => { S.options[i.dataset.opt] = i.checked; await save(); toast("Saved"); }));
  $("#gh-token").addEventListener("change", async (e) => {
    S.options.githubToken = e.target.value.trim(); await save();
    Object.keys(localStorage).filter((k) => k.startsWith("spectra-cache:community")).forEach((k) => localStorage.removeItem(k));
    toast("GitHub token saved");
  });
  $("#master").addEventListener("change", async (e) => { S.enabled = e.target.checked; $("#master-label").textContent = S.enabled ? "on" : "off"; await save(); });
  $("#reload-tabs").onclick = async () => {
    const r = await api.runtime.sendMessage({ type: "reloadSpotifyTabs" });
    if (IS_APP) toast(r && r.ok ? "Spotify reloaded" : "Spotify isn't connected", !(r && r.ok));
    else toast(r && r.count ? `Reloaded ${r.count} Spotify tab${r.count > 1 ? "s" : ""}` : "No Spotify tabs open");
  };

  $("#export").onclick = () => {
    const copy = Core.clone(S);
    copy.options.githubToken = "";
    const json = JSON.stringify({ spectraBackup: 1, exportedAt: new Date().toISOString(), state: copy }, null, 2);
    const filename = `spectra-backup-${new Date().toISOString().slice(0, 10)}.json`;
    if (IS_ANDROID) {
      // Android WebViews can't save blob downloads, so the app writes it to Downloads.
      api.runtime.sendMessage({ type: "saveFile", name: filename, content: json })
        .then((r) => toast(r && r.ok ? `Saved to Downloads/${filename}` : (r && r.error) || "Couldn't save the backup", !(r && r.ok)));
      return;
    }
    const blob = new Blob([json], { type: "application/json" });
    const a = h("a", { href: URL.createObjectURL(blob), download: filename });
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  };
  $("#import").onclick = () => $("#import-file").click();
  $("#import-file").onchange = async (e) => {
    const f = e.target.files[0];
    if (!f) return;
    try {
      const j = JSON.parse(await f.text());
      if (!j || !j.state) throw new Error("Not a Spectra backup");
      const keep = { githubToken: S.options.githubToken, app: S.app };
      S = Core.normalizeState(j.state);
      S.options.githubToken = S.options.githubToken || keep.githubToken;
      S.app = keep.app; // machine-specific
      await save(); renderAll(); toast("Backup imported");
    } catch (err) { toast(err.message, true); }
    e.target.value = "";
  };
  $("#clear-cache").onclick = async (e) => busy(e.currentTarget, "Refreshing", async () => {
    Object.keys(localStorage).filter((k) => k.startsWith("spectra-cache:")).forEach((k) => localStorage.removeItem(k));
    await api.runtime.sendMessage({ type: "ensureCssMap", force: true });
    toast("Caches refreshed");
  });
  $("#reset-all").onclick = async () => {
    if (!confirm("Remove all themes, extensions, snippets and settings?")) return;
    S = Core.normalizeState(null);
    await save(); renderAll(); toast("Spectra reset");
  };

  // ------------------------------------------------------------------ REMOTE (update server)
  let remote = null;   // { data, fetchedAt, from, error }
  let appInfo = null;  // { platform, version }
  const R = () => (remote && remote.data) || null;
  const isBlocked = (ext) => !!(R() && Array.isArray(R().blockedExtensions) && R().blockedExtensions.includes(ext.id));

  function newer(a, b) {
    const pa = String(a || "").split(".").map(Number), pb = String(b || "").split(".").map(Number);
    for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
      const x = pa[i] || 0, y = pb[i] || 0;
      if (x !== y) return x > y;
    }
    return false;
  }

  function renderRemote() {
    const data = R();
    // Announcement (dismissal is remembered per announcement id)
    const a = data && data.announcement;
    const dismissed = (() => { try { return localStorage.getItem("spectra-dismissed-announcement"); } catch { return null; } })();
    const banner = $("#remote-banner");
    if (a && a.text && a.id !== dismissed) {
      banner.className = "banner " + (a.level === "warning" ? "warning" : "info");
      $("#remote-banner-text").textContent = a.text;
      const link = $("#remote-banner-link");
      link.hidden = !a.link;
      if (a.link) link.href = a.link;
      $("#remote-banner-close").onclick = () => { try { localStorage.setItem("spectra-dismissed-announcement", a.id); } catch {} banner.hidden = true; };
      banner.hidden = false;
    } else banner.hidden = true;

    // Update available?
    const key = appInfo && { web: "extension", desktop: "desktop", quest: "quest" }[appInfo.platform];
    const latest = data && data.latest && key ? data.latest[key] : "";
    const ub = $("#update-banner");
    if (latest && appInfo && appInfo.version && newer(latest, appInfo.version)) {
      $("#update-banner-text").textContent = `Spectra ${latest} is out. You have ${appInfo.version}.`;
      const site = remote.from ? remote.from + "/download" : "";
      $("#update-banner-link").href = site;
      $("#update-banner-link").hidden = !site;
      ub.hidden = false;
    } else ub.hidden = true;

    // Featured rows
    const f = (data && data.featured) || {};
    const themes = (f.themes || []).map((t) => ({
      kind: "theme", key: t.key || `${t.owner}/${t.repo}:${t.name}`, name: t.name, description: t.note || "",
      authors: [{ name: t.owner, url: `https://github.com/${t.owner}` }], tags: [], preview: t.preview || null, readme: null,
      owner: t.owner, repo: t.repo, branch: t.branch || "main", stars: 0, official: false, url: `https://github.com/${t.owner}/${t.repo}`,
      usercss: t.usercss || null, schemes: t.schemes || null, include: t.include || [], featured: true,
    }));
    $("#featured-themes-wrap").hidden = !themes.length;
    $("#featured-themes").replaceChildren(...themes.map(themeCard));

    const exts = (f.extensions || []).map((e) => ({
      kind: "extension", key: e.key || `${e.owner}/${e.repo}:${e.name}`, name: e.name, description: e.note || e.description || "",
      authors: [{ name: e.owner, url: `https://github.com/${e.owner}` }], tags: [], preview: e.preview || null, readme: null,
      owner: e.owner, repo: e.repo, branch: e.branch || "main", main: e.main, stars: 0, url: `https://github.com/${e.owner}/${e.repo}`, featured: true,
    }));
    $("#featured-exts-wrap").hidden = !exts.length;
    $("#featured-exts").replaceChildren(...exts.map(extCard));

    const snips = (f.snippets || []).map((x) => ({ title: x.title, description: x.description || "", code: x.code, preview: x.preview || null }));
    $("#featured-snippets-wrap").hidden = !snips.length;
    $("#featured-snippets").replaceChildren(...snips.map(snippetCard));

    // Settings status line
    const st = $("#remote-status");
    if (st) {
      if (!remote) st.textContent = "Featured picks, fixes and announcements come from here. Not checked yet.";
      else if (remote.error && !remote.data) st.textContent = "Couldn't reach the update server: " + remote.error;
      else st.textContent = `Last checked ${new Date(remote.fetchedAt).toLocaleTimeString()}${remote.error ? " (offline, using the last copy)" : ""}.`;
    }
  }

  $("#update-server").addEventListener("change", async (e) => {
    const v = e.target.value.trim();
    if (v && !/^https:\/\//.test(v)) { toast("The update server must start with https://", true); return; }
    S.options.updateServer = v;
    await save();
    api.runtime.sendMessage({ type: "ensureRemote", force: true }).catch(() => {});
  });
  $("#remote-check").onclick = (e) => busy(e.currentTarget, "Checking", async () => {
    const r = await api.runtime.sendMessage({ type: "ensureRemote", force: true }).catch(() => null);
    toast(r && r.ok && !r.error ? "Up to date" : "Couldn't reach the update server", !(r && r.ok && !r.error));
  });

  // ------------------------------------------------------------------ nav
  const loaded = {};
  function switchView(name) {
    if (!$(`.view[data-view="${name}"]`)) name = "themes";
    $$(".nav button").forEach((b) => b.classList.toggle("active", b.dataset.view === name));
    $$(".view").forEach((v) => v.classList.toggle("active", v.dataset.view === name));
    history.replaceState(null, "", "#" + name);
    clearInterval(spotifyTimer);
    if (name === "themes" && !loaded.themes) { loaded.themes = 1; loadOfficialThemes(); loadCommunityThemes(); }
    if (name === "extensions" && !loaded.ext) { loaded.ext = 1; loadExtensions(); }
    if (name === "snippets" && !loaded.snip) { loaded.snip = 1; loadSnippets(); }
    if (name === "spotify") { refreshSpotify(); spotifyTimer = setInterval(refreshSpotify, 2000); }
    window.scrollTo({ top: 0 });
  }
  $$(".nav button").forEach((b) => b.addEventListener("click", () => switchView(b.dataset.view)));

  function renderAll() {
    renderSettings(); renderThemes(); renderColors(); renderExtensions(); renderSnippets();
  }

  // ------------------------------------------------------------------ permissions (Firefox asks separately)
  async function checkPerms() {
    if (!api.permissions || !api.permissions.contains) return;
    const origins = ["https://open.spotify.com/*"];
    const ok = await api.permissions.contains({ origins }).catch(() => true);
    $("#perm-banner").hidden = ok;
    $("#grant-perms").onclick = async () => {
      const granted = await api.permissions.request({ origins: ["https://open.spotify.com/*", "https://raw.githubusercontent.com/*", "https://api.github.com/*", "https://cdn.jsdelivr.net/*"] }).catch(() => false);
      $("#perm-banner").hidden = granted;
    };
  }

  // ------------------------------------------------------------------ boot
  api.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;
    if (changes.remote) { remote = changes.remote.newValue || null; renderRemote(); }
    if (!changes.state) return;
    const json = JSON.stringify(changes.state.newValue);
    if (json === lastWritten) return;
    S = Core.normalizeState(changes.state.newValue);
    renderAll();
  });

  (async function boot() {
    if (IS_APP) document.documentElement.classList.add("is-app");
    const OS = IS_APP && api.runtime.os;
    if (OS) {
      document.documentElement.classList.add("os-" + OS);
      // The settings text is written for Windows; say the right thing elsewhere.
      if (OS !== "win32") $("#login-start-label").textContent = "Start Spectra when you log in";
      if (OS === "darwin") {
        $("#tray-label").textContent = "Keep running in the menu bar";
        $("#tray-help").textContent = "Closing the window keeps Spectra in the menu bar, so your theme and extensions stay active. Quit from the menu bar icon.";
      }
      if (OS === "darwin") $("#always-help").textContent = "If Spotify opens without Spectra (from the Dock, Launchpad or a link), Spectra reopens it with your theme within a few seconds. It never restarts a Spotify that has been playing for a while.";
      if (OS === "linux") $("#always-help").textContent = "Spotify's app-menu entry and spotify: links start it with Spectra attached. If Spotify still opens some other way, Spectra reopens it within a few seconds. Turning this off puts the menu entry back.";
    }
    const { state, remote: savedRemote } = await api.storage.local.get(["state", "remote"]);
    S = Core.normalizeState(state);
    remote = savedRemote || null;
    renderAll();
    renderRemote();
    api.runtime.sendMessage({ type: "appInfo" }).then((info) => { appInfo = info || null; renderRemote(); }).catch(() => {});
    api.runtime.sendMessage({ type: "ensureRemote" }).catch(() => {});
    checkPerms();
    const hash = location.hash.slice(1);
    if (hash === "welcome") {
      $("#welcome").hidden = false;
      $("#dismiss-welcome").onclick = () => { $("#welcome").hidden = true; };
    }
    switchView(hash === "welcome" ? "themes" : hash || "themes");
    if (IS_APP) { refreshSpotify(); setInterval(() => { if (!document.hidden) refreshSpotify(); }, 5000); }
  })();
})();
