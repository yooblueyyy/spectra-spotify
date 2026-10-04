// Extensions page: featured picks and snippets from /api/manifest, the full catalog from /api/catalog.
(function () {
  "use strict";
  const $ = (s) => document.querySelector(s);
  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const safeUrl = (u) => (/^(https:\/\/|\/)/.test(u || "") ? u : "");
  const PAGE = 48;
  let all = [], shown = PAGE;

  const initials = (n) => String(n).replace(/[^A-Za-z0-9 ]/g, "").split(/\s+/).map((w) => w[0]).join("").slice(0, 3).toUpperCase() || "?";
  const stars = (n) => (n >= 1000 ? (n / 1000).toFixed(n >= 10000 ? 0 : 1) + "k" : String(n));
  const ago = (iso) => {
    const d = (Date.now() - Date.parse(iso)) / 86400000;
    if (!isFinite(d)) return "";
    if (d < 1) return "today";
    if (d < 45) return Math.round(d) + " days ago";
    if (d < 540) return Math.round(d / 30) + " months ago";
    return Math.round(d / 365) + " years ago";
  };

  function media(preview, name) {
    const src = safeUrl(preview);
    return `<div class="ext-media"><span>${esc(initials(name))}</span>${src ? `<img src="${esc(src)}" alt="" loading="lazy" referrerpolicy="no-referrer" onerror="this.remove()">` : ""}</div>`;
  }

  function extCard(e, featured) {
    const author = (e.authors && e.authors[0] && e.authors[0].name) || e.owner;
    const tags = (e.tags || []).filter((t) => t !== "latest").slice(0, 3)
      .map((t) => `<span class="chip${/outdated|broken|archived/i.test(t) ? " warn" : ""}">${esc(t)}</span>`).join("");
    const url = e.url || `https://github.com/${e.owner}/${e.repo}`;
    return `<article class="ext-card${featured ? " featured" : ""}">
      ${media(e.preview, e.name)}
      <div class="ext-body">
        <h3>${esc(e.name)}</h3>
        <p>${esc(e.note || e.description || "")}</p>
        <div class="ext-meta">
          <span>by ${esc(author)}</span>
          ${e.stars ? `<span>★ ${stars(e.stars)}</span>` : ""}
          ${e.updated ? `<span>updated ${esc(ago(e.updated))}</span>` : ""}
          ${featured ? `<span class="chip pick-chip">Featured</span>` : ""}${tags}
        </div>
        <div class="ext-actions"><a class="btn light small" href="${esc(safeUrl(url))}" rel="noopener" target="_blank">Source</a></div>
      </div>
    </article>`;
  }

  function snipCard(s, i) {
    return `<article class="ext-card">
      ${media(s.preview, s.title)}
      <div class="ext-body">
        <h3>${esc(s.title)}</h3>
        <p>${esc(s.description || "")}</p>
        <div class="ext-actions"><button class="btn light small" data-copy="${i}">Copy CSS</button></div>
      </div>
    </article>`;
  }

  function render() {
    const q = $("#ext-search").value.trim().toLowerCase();
    const sort = $("#ext-sort").value;
    let list = all.filter((e) => !q || [e.name, e.description, e.owner, ...(e.authors || []).map((a) => a.name), ...(e.tags || [])].join(" ").toLowerCase().includes(q));
    if (sort === "name") list = list.slice().sort((a, b) => a.name.localeCompare(b.name));
    else if (sort === "updated") list = list.slice().sort((a, b) => Date.parse(b.updated || 0) - Date.parse(a.updated || 0));
    $("#ext-count").textContent = q ? `${list.length} of ${all.length}` : `${all.length} extensions`;
    $("#ext-grid").innerHTML = list.length ? list.slice(0, shown).map((e) => extCard(e, false)).join("") : `<p class="muted">Nothing matches "${esc(q)}".</p>`;
    $("#ext-more").hidden = list.length <= shown;
  }

  let t;
  $("#ext-search").addEventListener("input", () => { clearTimeout(t); t = setTimeout(() => { shown = PAGE; render(); }, 120); });
  $("#ext-sort").addEventListener("change", () => { shown = PAGE; render(); });
  $("#ext-more").addEventListener("click", () => { shown += PAGE; render(); });

  // Deep link: /extensions?q=lyrics
  const q0 = new URLSearchParams(location.search).get("q");
  if (q0) $("#ext-search").value = q0.slice(0, 80);

  fetch("/api/catalog").then((r) => (r.ok ? r.json() : Promise.reject(new Error("HTTP " + r.status)))).then((c) => {
    all = (c && c.items) || [];
    render();
  }).catch(() => {
    $("#ext-grid").innerHTML = `<p class="muted">The extension list couldn't load right now. Every extension is still searchable inside Spectra's dashboard.</p>`;
  });

  window.spectraManifest().then((m) => {
    const f = (m && m.featured) || {};
    const exts = f.extensions || [];
    if (exts.length) {
      $("#featured-ext").innerHTML = exts.map((e) => extCard(e, true)).join("");
      $("#featured-ext-wrap").hidden = false;
    }
    const snips = f.snippets || [];
    if (snips.length) {
      $("#featured-snip").innerHTML = snips.map(snipCard).join("");
      $("#featured-snip-wrap").hidden = false;
      $("#featured-snip").addEventListener("click", async (e) => {
        const b = e.target.closest("[data-copy]");
        if (!b) return;
        try {
          await navigator.clipboard.writeText(snips[+b.dataset.copy].code);
          b.textContent = "Copied";
        } catch { b.textContent = "Couldn't copy"; }
        setTimeout(() => (b.textContent = "Copy CSS"), 1600);
      });
    }
  });
})();
