// Spectra admin: edit /api/manifest live. Talks to /api/admin with the ADMIN_TOKEN.
(function () {
  "use strict";
  const $ = (s, r = document) => r.querySelector(s);
  const PLATFORMS = [["web", "Browser"], ["desktop", "Desktop app"], ["quest", "Quest"]];
  let token = sessionStorage.getItem("spectra-admin-token") || "";
  let cfg = null, saved = null, storage = false, tab = "general";

  // ---------------------------------------------------------------- tiny DOM helper
  function h(tag, attrs, ...kids) {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v == null || v === false) continue;
      if (k === "class") n.className = v;
      else if (k.startsWith("on")) n.addEventListener(k.slice(2), v);
      else if (k === "value") n.value = v;
      else if (k === "checked") n.checked = !!v;
      else n.setAttribute(k, v === true ? "" : v);
    }
    for (const c of kids.flat(Infinity)) if (c != null && c !== false) n.append(c instanceof Node ? c : String(c));
    return n;
  }
  const field = (label, input, note) => h("label", { class: "f" }, h("span", {}, label), input, note ? h("small", { class: "muted" }, note) : null);
  const text = (value, onInput, attrs) => h("input", Object.assign({ type: "text", value: value || "", oninput: (e) => { onInput(e.target.value); dirty(); } }, attrs || {}));
  const area = (value, onInput, cls) => h("textarea", { class: cls || "", spellcheck: "false", value: value || "", oninput: (e) => { onInput(e.target.value); dirty(); } });

  // ---------------------------------------------------------------- API
  async function api(method, body) {
    const res = await fetch("/api/admin", {
      method,
      headers: Object.assign({ Authorization: "Bearer " + token }, body ? { "Content-Type": "application/json" } : {}),
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || "HTTP " + res.status);
    return data;
  }

  function status(msg, kind) {
    const s = $("#status");
    s.textContent = msg;
    s.className = kind || "";
  }
  function dirty() {
    status(JSON.stringify(cfg) === JSON.stringify(saved) ? (storage ? "No unsaved changes." : "Read-only: connect storage to save.") : "Unsaved changes", "");
  }

  async function load() {
    const data = await api("GET");
    cfg = data.config;
    saved = JSON.parse(JSON.stringify(cfg));
    storage = data.storage;
    $("#login").hidden = true;
    $("#admin").hidden = false;
    $("#savebar").hidden = false;
    $("#logout").hidden = false;
    render();
    status(storage ? `Loaded · last published ${cfg.updatedAt ? new Date(cfg.updatedAt).toLocaleString() : "never"}` : "Read-only: add an Upstash Redis database in Vercel → Storage, then redeploy.", storage ? "" : "err");
  }

  $("#login").addEventListener("submit", async (e) => {
    e.preventDefault();
    token = $("#token").value.trim();
    try {
      await load();
      sessionStorage.setItem("spectra-admin-token", token);
    } catch (err) {
      $("#login-err").textContent = err.message;
    }
  });
  $("#logout").onclick = (e) => { e.preventDefault(); sessionStorage.removeItem("spectra-admin-token"); location.reload(); };
  $("#revert").onclick = () => { cfg = JSON.parse(JSON.stringify(saved)); render(); dirty(); };
  $("#save").onclick = async () => {
    try {
      status("Publishing…");
      const data = await api("PUT", { config: cfg });
      cfg = data.config;
      saved = JSON.parse(JSON.stringify(cfg));
      render();
      status("Published. Installs pick this up within about 30 seconds.", "ok");
    } catch (err) {
      status(err.message, "err");
    }
  };
  window.addEventListener("beforeunload", (e) => { if (cfg && JSON.stringify(cfg) !== JSON.stringify(saved)) { e.preventDefault(); e.returnValue = ""; } });

  document.querySelectorAll(".tabs button").forEach((b) => b.addEventListener("click", () => {
    tab = b.dataset.t;
    document.querySelectorAll(".tabs button").forEach((x) => x.setAttribute("aria-selected", String(x === b)));
    render();
  }));

  // ---------------------------------------------------------------- GitHub helpers (for "add from repo")
  async function repoManifest(ownerRepo, branchHint) {
    const [owner, repo] = ownerRepo.replace(/^https:\/\/github\.com\//, "").replace(/\/+$/, "").split("/");
    if (!owner || !repo) throw new Error("Use the form owner/repo");
    for (const branch of [branchHint, "main", "master"].filter(Boolean)) {
      const res = await fetch(`https://raw.githubusercontent.com/${owner}/${repo}/${branch}/manifest.json`);
      if (res.ok) return { owner, repo, branch, entries: [].concat(await res.json()) };
    }
    throw new Error("No manifest.json found in that repo");
  }
  const raw = (o, r, b, p) => (/^https?:\/\//.test(p || "") ? p : p ? `https://raw.githubusercontent.com/${o}/${r}/${b}/${String(p).replace(/^\.?\/+/, "")}` : "");

  // ---------------------------------------------------------------- panes
  function render() {
    const panes = $("#panes");
    panes.replaceChildren(({ general, featured, hotfixes, classmap, scripts, blocked, changelog, raw: rawPane })[tab]());
  }

  function general() {
    cfg.latest = cfg.latest || {};
    cfg.downloads = cfg.downloads || {};
    cfg.links = cfg.links || {};
    const discordNote = h("small", { class: "muted" }, "Used by the Discord buttons on the website and in every app's dashboard. Must be a discord.gg or discord.com/invite link.");
    const discordIn = text(cfg.links.discord, (v) => {
      cfg.links.discord = v.trim();
      const ok = /^https:\/\/(discord\.gg|discord\.com\/invite)\/[\w-]+\/?$/.test(cfg.links.discord);
      discordNote.textContent = ok ? "Used by the Discord buttons on the website and in every app's dashboard."
        : "That doesn't look like an invite link (https://discord.gg/…). It won't be saved until it does.";
      discordNote.style.color = ok ? "" : "#b3261e";
    }, { placeholder: "https://discord.gg/…" });
    const a = cfg.announcement || { id: "", text: "", link: "", level: "info" };
    const setA = (k, v) => {
      cfg.announcement = Object.assign({}, cfg.announcement || { level: "info" }, { [k]: v });
      if (k === "text") cfg.announcement.id = "a-" + Date.now().toString(36); // new text = shown again to everyone
      if (!cfg.announcement.text) cfg.announcement = null;
    };
    const level = h("select", { onchange: (e) => { setA("level", e.target.value); dirty(); } },
      h("option", { value: "info" }, "Info"), h("option", { value: "warning" }, "Warning"));
    level.value = a.level || "info";
    return h("div", { class: "pane on" },
      h("h2", {}, "General"),
      h("p", {}, "Shown in every install's dashboard and on the website."),
      h("div", { class: "item" },
        h("div", { class: "item-head" }, h("strong", {}, "Announcement banner")),
        field("Message", text(a.text, (v) => setA("text", v), { placeholder: "Leave empty for no banner" })),
        h("div", { class: "grid2" }, field("Link (optional)", text(a.link, (v) => setA("link", v), { placeholder: "https://…" })), field("Style", level))),
      h("div", { class: "item" },
        h("div", { class: "item-head" }, h("strong", {}, "Community")),
        h("label", { class: "f" }, h("span", {}, "Discord invite link"), discordIn, discordNote)),
      h("div", { class: "item" },
        h("div", { class: "item-head" }, h("strong", {}, "Latest versions")),
        h("p", { class: "small-note" }, "Installs older than these show an 'update available' banner."),
        h("div", { class: "grid4" },
          field("Browser ext.", text(cfg.latest.extension, (v) => (cfg.latest.extension = v))),
          field("Desktop app", text(cfg.latest.desktop, (v) => (cfg.latest.desktop = v))),
          field("Quest", text(cfg.latest.quest, (v) => (cfg.latest.quest = v))))),
      h("div", { class: "item" },
        h("div", { class: "item-head" }, h("strong", {}, "Download links")),
        h("p", { class: "small-note" }, "Used by the download page. Big files (the Windows installer) belong on GitHub Releases. Paste the link here."),
        field("Chrome / Edge ZIP", text(cfg.downloads.chrome, (v) => (cfg.downloads.chrome = v))),
        field("Firefox .xpi", text(cfg.downloads.firefox, (v) => (cfg.downloads.firefox = v))),
        field("Windows installer", text(cfg.downloads.windows, (v) => (cfg.downloads.windows = v))),
        h("div", { class: "grid2" },
          field("Mac, Apple silicon (.dmg)", text(cfg.downloads.mac, (v) => (cfg.downloads.mac = v))),
          field("Mac, Intel (.dmg)", text(cfg.downloads.macIntel, (v) => (cfg.downloads.macIntel = v)))),
        h("div", { class: "grid2" },
          field("Linux AppImage", text(cfg.downloads.linux, (v) => (cfg.downloads.linux = v))),
          field("Linux .deb", text(cfg.downloads.linuxDeb, (v) => (cfg.downloads.linuxDeb = v)))),
        field("Quest APK", text(cfg.downloads.quest, (v) => (cfg.downloads.quest = v)))));
  }

  function featured() {
    cfg.featured = cfg.featured || { themes: [], extensions: [], snippets: [] };
    const F = cfg.featured;
    const list = (arr, label, describe) => arr.map((x, i) => h("div", { class: "item" },
      h("div", { class: "item-head" },
        h("div", { class: "row" }, x.preview ? h("img", { class: "thumb", src: x.preview, alt: "" }) : null, h("div", {}, h("strong", {}, x.name || x.title), h("div", { class: "mono muted" }, describe(x)))),
        h("div", { class: "row" },
          i > 0 ? h("button", { class: "btn light small", onclick: () => { arr.splice(i - 1, 0, arr.splice(i, 1)[0]); render(); dirty(); } }, "↑") : null,
          h("button", { class: "btn light small danger", onclick: () => { arr.splice(i, 1); render(); dirty(); } }, "Remove"))),
      "note" in x || label !== "snippet" ? field("Note shown to users", text(x.note || x.description || "", (v) => { if (label === "snippet") x.description = v; else x.note = v; })) : null));

    const repoIn = h("input", { type: "text", placeholder: "owner/repo, e.g. spicetify/spicetify-themes" });
    const nameIn = h("input", { type: "text", placeholder: "Name as in its manifest.json" });
    const kindIn = h("select", {}, h("option", { value: "theme" }, "Theme"), h("option", { value: "extension" }, "Extension"));
    const addMsg = h("span", { class: "mono muted" });
    const add = h("button", { class: "btn small", type: "button", onclick: async () => {
      try {
        addMsg.textContent = "Looking it up…";
        const m = await repoManifest(repoIn.value.trim());
        const e = m.entries.find((x) => x && x.name && x.name.toLowerCase() === nameIn.value.trim().toLowerCase()) || (m.entries.length === 1 ? m.entries[0] : null);
        if (!e) throw new Error("Not found. Names in that repo: " + m.entries.map((x) => x.name).join(", "));
        const base = { key: `${m.owner}/${m.repo}:${e.name}`, name: e.name, owner: m.owner, repo: m.repo, branch: m.branch, preview: raw(m.owner, m.repo, m.branch, e.preview), note: e.description || "" };
        if (kindIn.value === "theme") {
          if (!e.usercss && !e.schemes) throw new Error("That entry isn't a theme (no usercss/schemes).");
          F.themes.push(Object.assign(base, { usercss: e.usercss || "", schemes: e.schemes || "", include: Array.isArray(e.include) ? e.include : [] }));
        } else {
          if (!e.main) throw new Error("That entry isn't an extension (no main).");
          F.extensions.push(Object.assign(base, { main: e.main, description: e.description || "" }));
        }
        addMsg.textContent = "";
        render(); dirty();
      } catch (err) { addMsg.textContent = err.message; }
    } }, "Add");

    // Snippets: feature one from the Spicetify marketplace, or write one.
    const snipList = F.snippets.map((x, i) => h("div", { class: "item" },
      h("div", { class: "item-head" },
        h("div", { class: "row" }, x.preview ? h("img", { class: "thumb", src: x.preview, alt: "" }) : null, h("strong", {}, x.title || "Untitled")),
        h("div", { class: "row" },
          i > 0 ? h("button", { class: "btn light small", onclick: () => { F.snippets.splice(i - 1, 0, F.snippets.splice(i, 1)[0]); render(); dirty(); } }, "↑") : null,
          h("button", { class: "btn light small danger", onclick: () => { F.snippets.splice(i, 1); render(); dirty(); } }, "Remove"))),
      h("div", { class: "grid2" },
        field("Title", text(x.title, (v) => (x.title = v))),
        field("Preview image (optional)", text(x.preview, (v) => (x.preview = v), { placeholder: "https://…" }))),
      field("Description", text(x.description, (v) => (x.description = v))),
      h("details", {}, h("summary", { class: "small-note" }, `CSS (${(x.code || "").length} characters)`), area(x.code, (v) => (x.code = v), "code"))));

    const pickSearch = h("input", { type: "search", placeholder: "Search marketplace snippets…" });
    const pickOut = h("div", { class: "mpicker" }, h("p", { class: "small-note" }, "Loading the marketplace…"));
    const showPicks = () => {
      const q = pickSearch.value.trim().toLowerCase();
      const items = marketSnippets.filter((s) => !q || (s.title + " " + (s.description || "")).toLowerCase().includes(q)).slice(0, 40);
      pickOut.replaceChildren(...(items.length ? items.map((s) => {
        const on = F.snippets.some((x) => x.title === s.title);
        return h("div", { class: "mpick" },
          s.preview ? h("img", { class: "thumb", src: s.preview, alt: "", loading: "lazy" }) : h("div", { class: "thumb" }),
          h("div", { class: "grow" }, h("strong", {}, s.title), h("div", { class: "small-note" }, s.description || "")),
          h("button", { class: "btn small" + (on ? " light" : ""), disabled: on, onclick: () => {
            F.snippets.push({ title: s.title, description: s.description || "", code: s.code, preview: s.preview || "" });
            render(); dirty();
          } }, on ? "Featured" : "Feature"));
      }) : [h("p", { class: "small-note" }, "No snippets match.")]));
    };
    pickSearch.addEventListener("input", showPicks);
    loadMarketSnippets().then(showPicks, (e) => pickOut.replaceChildren(h("p", { class: "small-note" }, "Couldn't load the marketplace: " + e.message)));

    const snipTitle = h("input", { type: "text", placeholder: "Snippet title" });
    const snipDesc = h("input", { type: "text", placeholder: "One line about what it does" });
    const snipCode = h("textarea", { class: "code", spellcheck: "false", placeholder: "/* CSS */" });
    const addSnip = h("button", { class: "btn small", type: "button", onclick: () => {
      if (!snipTitle.value.trim() || !snipCode.value.trim()) return;
      F.snippets.push({ title: snipTitle.value.trim(), description: snipDesc.value.trim(), code: snipCode.value, preview: "" });
      render(); dirty();
    } }, "Add snippet");

    return h("div", { class: "pane on" },
      h("h2", {}, "Featured"),
      h("p", {}, "Pinned at the top of the dashboard's Themes, Extensions and Snippets tabs, and shown on the website's home and Extensions pages."),
      h("div", { class: "item" },
        h("div", { class: "item-head" }, h("strong", {}, "Add a theme or extension from a GitHub repo")),
        h("div", { class: "grid2" }, field("Repo", repoIn), field("Name", nameIn)),
        h("div", { class: "row" }, kindIn, add, addMsg)),
      h("h3", {}, `Themes (${F.themes.length})`), list(F.themes, "theme", (x) => `${x.owner}/${x.repo}`),
      h("h3", {}, `Extensions (${F.extensions.length})`), list(F.extensions, "extension", (x) => `${x.owner}/${x.repo} · ${x.main}`),
      h("h3", {}, `Snippets (${F.snippets.length})`), snipList,
      h("div", { class: "item" }, h("div", { class: "item-head" }, h("strong", {}, "Feature a marketplace snippet")), pickSearch, pickOut),
      h("div", { class: "item" }, h("div", { class: "item-head" }, h("strong", {}, "Write your own snippet")), field("Title", snipTitle), field("Description", snipDesc), field("CSS", snipCode), addSnip));
  }

  // Spicetify marketplace snippets, fetched once per page load.
  const MARKET_RAW = "https://raw.githubusercontent.com/spicetify/marketplace/main/";
  let marketSnippets = [], marketLoad = null;
  function loadMarketSnippets() {
    marketLoad = marketLoad || fetch(MARKET_RAW + "resources/snippets.json")
      .then((r) => { if (!r.ok) throw new Error("HTTP " + r.status); return r.json(); })
      .then((list) => {
        marketSnippets = list.filter((s) => s && s.title && s.code).map((s) => Object.assign({}, s, {
          preview: s.preview ? (/^https?:/.test(s.preview) ? s.preview : MARKET_RAW + String(s.preview).replace(/^\.?\/+/, "")) : "",
        }));
      })
      .catch((e) => { marketLoad = null; throw e; });
    return marketLoad;
  }

  function platformChecks(item) {
    item.platforms = item.platforms || PLATFORMS.map((p) => p[0]);
    return h("div", { class: "row" }, ...PLATFORMS.map(([k, label]) => h("label", { class: "chk" },
      h("input", { type: "checkbox", checked: item.platforms.includes(k), onchange: (e) => {
        item.platforms = e.target.checked ? [...new Set([...item.platforms, k])] : item.platforms.filter((x) => x !== k);
        dirty();
      } }), label)));
  }

  function codeList(arrName, kind, codeKey) {
    cfg[arrName] = cfg[arrName] || [];
    const arr = cfg[arrName];
    return arr.map((x, i) => h("div", { class: "item" },
      h("div", { class: "item-head" },
        h("strong", {}, x.name || x.id || `${kind} ${i + 1}`),
        h("div", { class: "row" },
          h("label", { class: "chk" }, h("input", { type: "checkbox", checked: x.enabled !== false, onchange: (e) => { x.enabled = e.target.checked; dirty(); } }), "Enabled"),
          h("button", { class: "btn light small danger", onclick: () => { if (confirm(`Delete this ${kind}?`)) { arr.splice(i, 1); render(); dirty(); } } }, "Delete"))),
      h("div", { class: "grid2" },
        field("ID", text(x.id, (v) => (x.id = v.replace(/[^\w.:/@-]/g, "")), { placeholder: "short-unique-id" })),
        kind === "script" ? field("Name", text(x.name, (v) => (x.name = v))) : field("What it fixes", text(x.description, (v) => (x.description = v)))),
      kind === "script" ? field("Description", text(x.description, (v) => (x.description = v))) : null,
      field(kind === "script" ? "JavaScript (runs inside Spotify)" : "CSS", area(x[codeKey], (v) => (x[codeKey] = v), "code")),
      h("div", { class: "f" }, h("span", {}, "Platforms"), platformChecks(x))));
  }

  function hotfixes() {
    return h("div", { class: "pane on" },
      h("h2", {}, "CSS hotfixes"),
      h("p", {}, "Applied on top of every theme (after the theme, before the user's own CSS). Readable class names like .main-nowPlayingBar-container work here."),
      codeList("cssHotfixes", "hotfix", "css"),
      h("button", { class: "btn small", onclick: () => { cfg.cssHotfixes.push({ id: "hotfix-" + Date.now().toString(36), description: "", css: "", enabled: true, platforms: ["web", "desktop", "quest"] }); render(); dirty(); } }, "Add hotfix"));
  }

  function scripts() {
    return h("div", { class: "pane on" },
      h("h2", {}, "Scripts"),
      h("p", {}, "JavaScript that runs inside Spotify on every install, with the full Spicetify API. It reaches users on their next Spotify reload. Never runs in the Firefox add-on (Mozilla's rules). Test before enabling. A broken script affects everyone."),
      codeList("scripts", "script", "code"),
      h("button", { class: "btn small", onclick: () => { cfg.scripts.push({ id: "script-" + Date.now().toString(36), name: "", description: "", code: "", enabled: false, platforms: ["web", "desktop", "quest"] }); render(); dirty(); } }, "Add script"));
  }

  function classmap() {
    const note = h("p", { class: "small-note" });
    const ta = h("textarea", { class: "raw", spellcheck: "false", value: JSON.stringify(cfg.classMap || {}, null, 2), oninput: (e) => {
      try {
        const v = JSON.parse(e.target.value || "{}");
        if (!v || typeof v !== "object" || Array.isArray(v)) throw new Error("Must be an object");
        cfg.classMap = v; note.textContent = `${Object.keys(v).length} entries`; note.style.color = ""; dirty();
      } catch (err) { note.textContent = "Not valid JSON yet: " + err.message; note.style.color = "#b3261e"; }
    } });
    return h("div", { class: "pane on" },
      h("h2", {}, "Class map"),
      h("p", {}, 'Extra entries for Spicetify\'s class-name map, as "hashedClass": "readable-name". Use this when Spotify renames something before Spectra\'s automatic matcher catches it.'),
      ta, note);
  }

  function blocked() {
    return h("div", { class: "pane on" },
      h("h2", {}, "Blocked extensions"),
      h("p", {}, "Extensions listed here are switched off on every install (users see why). One per line, as owner/repo:Name, e.g. someone/cool-ext:Cool Extension."),
      area((cfg.blockedExtensions || []).join("\n"), (v) => (cfg.blockedExtensions = v.split("\n").map((s) => s.trim()).filter(Boolean)), "code"));
  }

  function changelog() {
    cfg.changelog = cfg.changelog || [];
    return h("div", { class: "pane on" },
      h("h2", {}, "Changelog"),
      h("p", {}, "Shown on the website, newest first."),
      h("button", { class: "btn small", style: "margin-bottom:14px", onclick: () => { cfg.changelog.unshift({ version: "", date: new Date().toISOString().slice(0, 10), notes: [] }); render(); dirty(); } }, "Add release"),
      cfg.changelog.map((e, i) => h("div", { class: "item" },
        h("div", { class: "grid2" }, field("Version", text(e.version, (v) => (e.version = v))), field("Date", text(e.date, (v) => (e.date = v), { placeholder: "YYYY-MM-DD" }))),
        field("Notes (one per line)", area((e.notes || []).join("\n"), (v) => (e.notes = v.split("\n").map((s) => s.trim()).filter(Boolean))),
          "Start a line with + for something new, - for something removed, * for something changed."),
        h("button", { class: "btn light small danger", onclick: () => { cfg.changelog.splice(i, 1); render(); dirty(); } }, "Delete release"))));
  }

  function rawPane() {
    const note = h("p", { class: "small-note" }, "Edit everything at once. Unknown fields are dropped when saving.");
    const ta = h("textarea", { class: "raw", spellcheck: "false", value: JSON.stringify(cfg, null, 2) });
    return h("div", { class: "pane on" },
      h("h2", {}, "Raw JSON"), note, ta,
      h("div", { class: "row", style: "margin-top:12px" }, h("button", { class: "btn small", onclick: () => {
        try { cfg = JSON.parse(ta.value); note.textContent = "Applied. Review, then Save & publish."; note.style.color = ""; dirty(); }
        catch (err) { note.textContent = "Invalid JSON: " + err.message; note.style.color = "#b3261e"; }
      } }, "Apply"), h("button", { class: "btn light small", onclick: () => {
        const blob = new Blob([JSON.stringify(cfg, null, 2)], { type: "application/json" });
        const a = h("a", { href: URL.createObjectURL(blob), download: `spectra-config-${new Date().toISOString().slice(0, 10)}.json` });
        a.click();
      } }, "Download backup")));
  }

  if (token) load().catch(() => { sessionStorage.removeItem("spectra-admin-token"); token = ""; });
})();
