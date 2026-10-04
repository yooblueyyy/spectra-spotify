/* Spectra dashboard: My Library (make themes, extensions and snippets) and the Spectra Store. */
(function () {
  "use strict";
  const D = globalThis.__spectraDash;
  const P = globalThis.SpectraPackage;
  const Core = globalThis.SpectraCore;
  if (!D || !P) return;
  const { h, $, $$, toast, busy, openDrawer, closeDrawer, placeholder, mediaEl, empty, timeAgo, renderReadme, debounce } = D;
  const S = () => D.S;
  const storeApi = () => Core.apiBase(S()) + "/api/store";

  const KIND_LABEL = { theme: "Theme", extension: "Extension", snippet: "Snippet" };
  const STATUS = {
    draft: ["Draft", ""], ready: ["Ready to submit", ""], submitted: ["Submitted", "warn"], reviewing: ["Under review", "warn"],
    changes: ["Changes requested", "warn"], published: ["Published", "live"], rejected: ["Rejected", "bad"], archived: ["Archived", ""],
    removed: ["Removed by Spectra", "bad"],
  };

  // ------------------------------------------------------------------ helpers
  const byId = (id) => S().creations.find((c) => c.id === id);
  const creatorName = () => (S().creator && S().creator.name) || "";
  function ensureKey() {
    const c = S().creator;
    if (!c.key) {
      const b = new Uint8Array(32);
      crypto.getRandomValues(b);
      c.key = btoa(String.fromCharCode(...b)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    }
    return c.key;
  }
  async function call(method, body, query) {
    const url = storeApi() + (query ? "?" + new URLSearchParams(query) : "");
    const res = await fetch(url, method === "GET" ? { cache: "no-cache" } : { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw Object.assign(new Error(data.error || `The store said ${res.status}`), { status: res.status, data });
    return data;
  }
  const slug = (s) => String(s || "untitled").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "untitled";

  /** The package for a creation, as it would be exported or submitted. */
  function pkgOf(c) {
    return P.normalizePackage(Object.assign({}, c, { author: creatorName() }));
  }
  /** Content fields only, for version snapshots. */
  const CONTENT = ["name", "description", "tags", "platforms", "license", "preview", "css", "schemes", "code", "permissions", "dependencies", "readme", "icon"];
  const snapshot = (c) => JSON.parse(JSON.stringify(Object.fromEntries(CONTENT.filter((k) => k in c).map((k) => [k, c[k]]))));

  function statusKey(c) {
    const sub = c.submission;
    if (sub && ["submitted", "reviewing", "changes", "rejected"].includes(sub.status)) return sub.status;
    if (c.listing) return c.listing.status === "published" ? "published" : c.listing.status === "removed" ? "removed" : "archived";
    return P.validate(pkgOf(c)).ok ? "ready" : "draft";
  }
  const statusBadge = (c) => { const [label, cls] = STATUS[statusKey(c)]; return h("span", { class: "state " + cls }, label); };

  function newCreation(kind, init) {
    const c = Object.assign({
      id: Core.uid("mine"),
      kind,
      name: "",
      description: "",
      version: "1.0.0",
      license: "",
      tags: [],
      platforms: P.PLATFORMS.slice(),
      preview: "",
      versions: [],
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }, kind === "theme" ? { css: "", schemes: {} } : kind === "extension" ? { code: "", permissions: [], dependencies: [], readme: "", icon: "" } : { css: "" }, init || {});
    S().creations.unshift(c);
    return c;
  }

  // ------------------------------------------------------------------ applying creations in Spotify
  const appliedTheme = (c) => S().theme && S().theme.creationId === c.id;
  const appliedExt = (c) => S().extensions.find((e) => e.creationId === c.id);
  const appliedSnippet = (c) => S().snippets.find((s) => s.creationId === c.id);
  const isApplied = (c) => (c.kind === "theme" ? appliedTheme(c) : c.kind === "extension" ? !!appliedExt(c) : !!appliedSnippet(c));

  /** Copy a creation's latest content into what Spotify is running (if it's on). */
  function syncApplied(c) {
    if (c.kind === "theme" && appliedTheme(c)) {
      Object.assign(S().theme, { name: c.name || "Untitled theme", css: c.css || "", schemes: c.schemes || {}, preview: c.preview || null });
      if (S().scheme && !(c.schemes || {})[S().scheme]) S().scheme = Object.keys(c.schemes || {})[0] || null;
      return false;
    }
    const e = c.kind === "extension" && appliedExt(c);
    if (e) {
      const changed = e.code !== c.code || JSON.stringify(e.permissions) !== JSON.stringify(c.permissions);
      Object.assign(e, { name: c.name || "Untitled extension", code: c.code || "", permissions: (c.permissions || []).slice(), updatedAt: Date.now() });
      return changed; // extensions need a Spotify reload to pick up new code
    }
    const sn = c.kind === "snippet" && appliedSnippet(c);
    if (sn) Object.assign(sn, { title: c.name || "Untitled snippet", code: c.css || "" });
    return false;
  }

  function reloadAction() {
    return { label: "Reload Spotify", onClick: () => D.api.runtime.sendMessage({ type: "reloadSpotifyTabs" }).catch(() => {}) };
  }

  async function toggleApplied(c) {
    const st = S();
    if (c.kind === "theme") {
      if (appliedTheme(c)) { st.theme = null; st.scheme = null; st.colorOverrides = {}; await D.save(); toast("Back to stock Spotify"); }
      else {
        st.theme = { id: "mine:" + c.id, creationId: c.id, name: c.name || "Untitled theme", css: c.css || "", schemes: c.schemes || {}, scripts: [],
          preview: c.preview || null, authors: creatorName() ? [{ name: creatorName() }] : [], installedAt: Date.now() };
        st.scheme = Object.keys(c.schemes || {})[0] || null;
        st.colorOverrides = {};
        await D.save();
        toast(`${c.name || "Your theme"} is on. Changes show up in Spotify as you edit`);
      }
      D.renderThemes(); D.renderColors();
    } else if (c.kind === "extension") {
      const e = appliedExt(c);
      if (e) { st.extensions = st.extensions.filter((x) => x !== e); await D.save(); toast("Turned off. Reload Spotify to stop it", false, reloadAction()); }
      else {
        st.extensions.push({ id: "mine:" + c.id, creationId: c.id, name: c.name || "Untitled extension", code: c.code || "", permissions: (c.permissions || []).slice(), enabled: true, installedAt: Date.now() });
        await D.save();
        toast("Running in Spotify after a reload", false, reloadAction());
      }
      D.renderExtensions();
    } else {
      const sn = appliedSnippet(c);
      if (sn) { st.snippets = st.snippets.filter((x) => x !== sn); toast("Snippet off"); }
      else { st.snippets.push({ id: "mine:" + c.id, creationId: c.id, title: c.name || "Untitled snippet", code: c.css || "", enabled: true, source: "mine" }); toast("Snippet on in Spotify. It updates as you edit"); }
      await D.save();
      D.renderSnippets();
    }
    render();
  }

  // ------------------------------------------------------------------ customizing something that exists ("Based on X by Y")
  D.hooks.customize = (kind, src) => {
    const author = (src.authors && src.authors[0] && src.authors[0].name) || src.creator || "";
    const name = src.name || src.title || "Untitled";
    const base = { name: `${name} (custom)`, description: src.description || "", basedOn: { name, author, url: src.url || "", license: src.license || "" } };
    let c;
    if (kind === "theme") c = newCreation("theme", Object.assign(base, { css: src.css || "", schemes: JSON.parse(JSON.stringify(src.schemes || {})), preview: src.preview && /^https:/.test(src.preview) ? src.preview : "" }));
    else if (kind === "extension") c = newCreation("extension", Object.assign(base, { code: src.code || "", permissions: P.detectPermissions(src.code || "").used, readme: "" }));
    else c = newCreation("snippet", Object.assign(base, { css: src.code || src.css || "" }));
    if (kind === "theme" && src.scripts && src.scripts.length) toast("The theme's scripts weren't copied. Store themes are CSS and colours only", true);
    D.save();
    openEditor(c.id);
    toast(`Copied into My Library${author ? `. Credit to ${author} is kept` : ""}`);
  };
  D.hooks.editCreation = (id) => openEditor(id);

  // ------------------------------------------------------------------ the library list
  let filter = "all";
  let mine = null;          // last answer from the store about this creator's submissions
  let refreshing = false;

  async function refreshMine(force) {
    const key = S().creator.key;
    if (!key || refreshing || (!force && mine && Date.now() - mine.at < 60000)) return;
    refreshing = true;
    try {
      const r = await call("POST", { action: "mine", creatorKey: key });
      mine = { at: Date.now(), ...r };
      let changed = false;
      for (const c of S().creations) {
        const subs = r.submissions.filter((s) => s.localId === c.id || (c.storeId && s.storeId === c.storeId));
        const latest = subs.sort((a, b) => b.updated - a.updated)[0];
        const storeId = (latest && latest.storeId) || c.storeId;
        const listing = storeId && r.items.find((i) => i.id === storeId);
        const sub = latest ? { id: latest.id, storeId: latest.storeId, status: latest.status, feedback: latest.feedback, version: latest.version, updated: latest.updated, history: latest.history } : c.submission;
        const lst = listing ? { status: listing.status, version: listing.version, updatedAt: listing.updatedAt } : null;
        // Only remember a listing id once it's actually been published.
        const nextStoreId = listing ? storeId : c.storeId;
        if (JSON.stringify([c.submission, c.listing, c.storeId]) !== JSON.stringify([sub, lst, nextStoreId])) {
          c.submission = sub; c.listing = lst; c.storeId = nextStoreId; changed = true;
        }
      }
      if (changed) await D.save();
      render();
    } catch (e) {
      if (force) toast(`Couldn't check your submissions: ${e.message}`, true);
    } finally { refreshing = false; }
  }

  function creatorCard() {
    const c = S().creator;
    const box = $("#creator-card");
    if (!c.name) {
      box.replaceChildren(h("div", { class: "banner info creator-setup" },
        h("div", {}, h("strong", {}, "Set up your creator profile"), h("br"),
          h("small", {}, "The name people see on what you publish. It's separate from your Spotify account, and Spectra never links the two.")),
        h("button", { class: "btn primary small", onclick: editProfile }, "Set up")));
      return;
    }
    const counts = { published: 0, review: 0 };
    for (const x of S().creations) { const k = statusKey(x); if (k === "published") counts.published++; if (["submitted", "reviewing", "changes"].includes(k)) counts.review++; }
    box.replaceChildren(h("div", { class: "creator-card" },
      h("span", { class: "avatar", "aria-hidden": "true" }, c.name.slice(0, 1).toUpperCase()),
      h("div", { class: "grow" },
        h("div", { class: "title" }, c.name, h("span", { class: "muted small" }, "creator profile")),
        h("div", { class: "sub" }, [c.bio, `${S().creations.length} in your library`, counts.published ? `${counts.published} published` : "", counts.review ? `${counts.review} waiting on review` : ""].filter(Boolean).join(" · "))),
      h("button", { class: "btn link small", onclick: (e) => busy(e.currentTarget, "Checking", () => refreshMine(true)) }, "Check reviews"),
      h("button", { class: "btn ghost small", onclick: editProfile }, "Edit profile")));
  }

  function editProfile() {
    const c = S().creator;
    const name = h("input", { class: "input", value: c.name, maxlength: "40", placeholder: "How you want to be credited", style: { width: "100%" } });
    const bio = h("input", { class: "input", value: c.bio, maxlength: "200", placeholder: "Optional, one line about you", style: { width: "100%" } });
    const link = h("input", { class: "input mono", value: c.link, maxlength: "200", placeholder: "https://… (optional)", style: { width: "100%" } });
    const saveBtn = h("button", { class: "btn primary" }, "Save profile");
    saveBtn.onclick = async () => {
      const n = name.value.trim();
      if (n.length < 2) return toast("Your creator name needs at least 2 characters", true);
      if (link.value.trim() && !/^https:\/\//.test(link.value.trim())) return toast("The link must start with https://", true);
      Object.assign(c, { name: n, bio: bio.value.trim(), link: link.value.trim() });
      ensureKey();
      await D.save();
      closeDrawer(); render(); renderEditor();
      toast("Profile saved");
    };
    openDrawer(h("h2", {}, "Creator profile"),
      h("p", { class: "muted" }, "Shown on everything you publish in the Spectra Store. It isn't your Spotify name, and Spectra never connects the two."),
      h("div", { class: "field" }, h("label", {}, "Name"), name),
      h("div", { class: "field" }, h("label", {}, "About you"), bio),
      h("div", { class: "field" }, h("label", {}, "Link"), link),
      h("p", { class: "muted small" }, "Spectra also makes a private creator key on this device, so only you can update what you publish. It's in your backups (Settings → Export); keep it if you move to a new device."),
      saveBtn);
    setTimeout(() => name.focus(), 0);
  }

  const FILTERS = [["all", "All"], ["theme", "Themes"], ["extension", "Extensions"], ["snippet", "Snippets"], ["drafts", "Drafts"], ["review", "Submissions"], ["published", "Published"], ["favorites", "Favorites"]];
  function matches(c) {
    const k = statusKey(c);
    switch (filter) {
      case "theme": case "extension": case "snippet": return c.kind === filter;
      case "drafts": return k === "draft" || k === "ready";
      case "review": return ["submitted", "reviewing", "changes", "rejected"].includes(k);
      case "published": return ["published", "archived", "removed"].includes(k);
      default: return true;
    }
  }

  function libRow(c) {
    const k = statusKey(c);
    const sub = [KIND_LABEL[c.kind], "v" + (c.version || "1.0.0"), `edited ${timeAgo(c.updatedAt)}`];
    if (c.basedOn) sub.push(`based on ${c.basedOn.name}${c.basedOn.author ? ` by ${c.basedOn.author}` : ""}`);
    const applied = isApplied(c);
    const more = h("button", { class: "btn link small", title: "More" }, "More");
    more.onclick = () => openDrawer(h("h2", {}, c.name || "Untitled"),
      h("div", { class: "row-gap wrap" },
        h("button", { class: "btn ghost", onclick: () => { closeDrawer(); duplicate(c); } }, "Duplicate"),
        h("button", { class: "btn ghost", onclick: () => exportPackage(c) }, "Export package"),
        h("button", { class: "btn danger", onclick: () => { closeDrawer(); remove(c); } }, "Delete")),
      c.listing ? h("p", { class: "muted small" }, "Deleting it here doesn't take it out of the store. Archive the listing from the Publish tab first if you want that.") : null);
    const row = h("div", { class: "row lib-row" },
      mediaEl({ name: c.name || KIND_LABEL[c.kind], preview: c.preview }, () => openEditor(c.id), "row-thumb"),
      h("div", { class: "grow" },
        h("div", { class: "title" }, c.name || h("span", { class: "muted" }, `Untitled ${c.kind}`), statusBadge(c), applied ? h("span", { class: "tag" }, "On in Spotify") : null),
        h("div", { class: "sub" }, sub.join(" · ")),
        (k === "changes" || k === "rejected") && c.submission.feedback ? h("div", { class: "feedback-line" }, h("b", {}, k === "changes" ? "Reviewer: " : "Why: "), c.submission.feedback) : null),
      h("div", { class: "actions" },
        h("button", { class: "btn link small", onclick: () => toggleApplied(c) }, applied ? (c.kind === "extension" ? "Stop testing" : "Turn off") : (c.kind === "extension" ? "Test in Spotify" : "Try in Spotify")),
        more,
        h("button", { class: "btn ghost small", onclick: () => openEditor(c.id) }, "Open")));
    return row;
  }

  function duplicate(c) {
    const copy = JSON.parse(JSON.stringify(c));
    Object.assign(copy, { id: Core.uid("mine"), name: (c.name || "Untitled") + " copy", versions: [], submission: undefined, listing: undefined, storeId: undefined, createdAt: Date.now(), updatedAt: Date.now() });
    S().creations.unshift(copy);
    D.save(); render();
    toast("Duplicated");
  }

  async function remove(c) {
    const st = S();
    const at = st.creations.indexOf(c);
    const wasApplied = isApplied(c);
    if (wasApplied) await toggleApplied(c);
    st.creations = st.creations.filter((x) => x !== c);
    await D.save(); render();
    toast(`${c.name || "Untitled"} deleted`, false, { label: "Undo", onClick: async () => { S().creations.splice(at, 0, c); await D.save(); render(); } });
  }

  function render() {
    renderNavCount();
    if (!$('.view[data-view="library"]').classList.contains("active")) return;
    creatorCard();
    const list = S().creations;
    $("#lib-filters").replaceChildren(...FILTERS.map(([k, label]) => {
      const n = k === "favorites" ? S().favorites.length : list.filter((c) => { const f = filter; filter = k; const m = matches(c); filter = f; return m; }).length;
      return h("button", { class: "chip" + (filter === k ? " on" : ""), role: "tab", "aria-selected": String(filter === k), onclick: () => { filter = k; render(); } }, label, n && k !== "all" ? h("span", { class: "n" }, String(n)) : null);
    }));
    const box = $("#lib-list");
    if (filter === "favorites") return renderFavorites(box);
    const shown = list.filter(matches);
    if (!list.length) {
      box.replaceChildren(h("div", { class: "empty lib-empty" },
        h("strong", {}, "Nothing here yet."),
        "Start a theme from scratch, or open any theme, extension or snippet and pick Customize to make your own version of it."));
      return;
    }
    box.replaceChildren(...(shown.length ? shown.map(libRow) : [empty("Nothing in this list.", null)]));
  }

  function renderNavCount() {
    const n = S().creations.filter((c) => statusKey(c) === "changes").length;
    const badge = $("#library-count");
    badge.hidden = !n;
    badge.textContent = String(n);
    badge.title = n ? `${n} submission${n > 1 ? "s" : ""} need changes` : "";
  }

  // ------------------------------------------------------------------ import / export
  function download(name, text) {
    if (D.IS_ANDROID) {
      D.api.runtime.sendMessage({ type: "saveFile", name, content: text })
        .then((r) => toast(r && r.ok ? `Saved to Downloads/${name}` : (r && r.error) || "Couldn't save it", !(r && r.ok)));
      return;
    }
    const a = h("a", { href: URL.createObjectURL(new Blob([text], { type: "application/json" })), download: name });
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }
  function exportPackage(c) {
    const pkg = pkgOf(c);
    download(`${slug(c.name)}-${pkg.version || "1.0.0"}.spectra.json`, JSON.stringify({ spectraPackage: 1, exportedAt: new Date().toISOString(), package: pkg }, null, 2));
  }
  $("#import-package").onclick = () => $("#import-package-file").click();
  $("#import-package-file").onchange = async (e) => {
    const f = e.target.files[0];
    e.target.value = "";
    if (!f) return;
    try {
      const j = JSON.parse(await f.text());
      const raw = j && (j.package || (j.kind && j));
      if (!raw || !P.KINDS.includes(raw.kind)) throw new Error("That isn't a Spectra package (.spectra.json).");
      const pkg = P.normalizePackage(raw);
      const c = newCreation(pkg.kind, Object.assign({}, pkg, { version: pkg.version || "1.0.0" }));
      delete c.format; delete c.author;
      await D.save();
      openEditor(c.id);
      toast(`Imported ${pkg.name || "package"}`);
    } catch (err) { toast(err.message, true); }
  };
  $("#new-theme").onclick = () => { const c = newCreation("theme", { schemes: { Default: { text: "ffffff", subtext: "b3b3b3", main: "121212", sidebar: "000000", player: "181818", card: "282828", button: "1db954", "button-active": "1ed760" } } }); D.save(); openEditor(c.id); };
  $("#new-extension").onclick = () => { const c = newCreation("extension", { code: EXT_TEMPLATE, permissions: ["interface", "playback"] }); D.save(); openEditor(c.id); };
  $("#new-snippet").onclick = () => { const c = newCreation("snippet", { css: "/* Your CSS here. Spicetify class names work too. */\n" }); D.save(); openEditor(c.id); };

  const EXT_TEMPLATE = `// Runs in Spotify with the Spicetify API. Ask only for the permissions you use (Permissions tab).
(async function main() {
  while (!Spicetify?.Player || !Spicetify?.Topbar) await new Promise((r) => setTimeout(r, 300));

  new Spicetify.Topbar.Button("Skip", "skip-forward", () => {
    Spicetify.Player.next();
    Spicetify.showNotification("Skipped");
  });
})();
`;

  // ------------------------------------------------------------------ the editor
  let currentId = null;
  let tab = "details";
  let saveState = "saved";     // "saved" | "saving" | "dirty" | "failed"
  let saveError = "";
  let schemeSel = null;

  function openEditor(id) {
    currentId = id;
    tab = "details";
    schemeSel = null;
    saveState = "saved";
    D.switchView("creator");
    try { history.replaceState(null, "", "#creator:" + id); } catch {}
  }
  D.onView("creator", () => {
    if (!currentId) { const m = location.hash.match(/^#creator:(.+)$/); currentId = m ? m[1] : null; }
    if (!currentId || !byId(currentId)) return D.switchView("library");
    renderEditor();
  });
  D.onView("library", () => { render(); refreshMine(false); });

  function setSave(stateName, err) {
    saveState = stateName; saveError = err || "";
    const el = $("#save-state");
    if (!el) return;
    const map = { saved: ["Saved", "live"], saving: ["Saving…", ""], dirty: ["Unsaved changes", "warn"], failed: ["Failed to save", "bad"] };
    const [label, cls] = map[stateName];
    el.className = "state " + cls;
    el.textContent = label;
    el.title = stateName === "failed" ? saveError : stateName === "saved" ? "Everything is saved on this device" : "";
  }

  const autosave = debounce(async () => {
    const c = byId(currentId);
    if (!c) return;
    setSave("saving");
    c.updatedAt = Date.now();
    const needsReload = syncApplied(c);
    try {
      await D.save();
      setSave("saved");
      if (needsReload && !autosave.toldReload) { autosave.toldReload = true; toast("Saved. Reload Spotify to run the new code", false, reloadAction()); }
    } catch (e) {
      setSave("failed", e && e.message);
      toast(`Couldn't save: ${e && e.message ? e.message : e}`, true);
    }
  }, 600);
  function changed() { setSave("dirty"); autosave(); }
  window.addEventListener("beforeunload", (e) => { if (saveState === "dirty" || saveState === "saving") { e.preventDefault(); e.returnValue = ""; } });

  const TABS = {
    theme: [["details", "Details"], ["colors", "Colours"], ["css", "CSS"], ["versions", "Versions"], ["publish", "Publish"]],
    extension: [["details", "Details"], ["code", "Code"], ["permissions", "Permissions"], ["readme", "README"], ["versions", "Versions"], ["publish", "Publish"]],
    snippet: [["details", "Details"], ["css", "CSS"], ["versions", "Versions"], ["publish", "Publish"]],
  };

  function renderEditor() {
    const root = $("#creator-root");
    const c = byId(currentId);
    if (!root || !c) return;
    const applied = isApplied(c);
    const head = h("header", { class: "creator-head" },
      h("button", { class: "btn link small back", onclick: () => D.switchView("library") }, "← My Library"),
      h("div", { class: "creator-title" },
        h("h1", {}, c.name || `Untitled ${c.kind}`),
        h("div", { class: "creator-meta" }, KIND_LABEL[c.kind], " · v", c.version || "1.0.0", " · ", statusBadge(c), " · ", h("span", { id: "save-state", class: "state live" }, "Saved"))),
      h("div", { class: "row-gap wrap" },
        h("button", { class: "btn " + (applied ? "ghost" : "primary") + " small", onclick: () => toggleApplied(c).then(renderEditor) },
          applied ? (c.kind === "extension" ? "Stop testing" : "Turn off in Spotify") : (c.kind === "extension" ? "Test in Spotify" : "Try in Spotify")),
        h("button", { class: "btn ghost small", onclick: () => { tab = "publish"; renderEditor(); } }, c.listing ? "Publish update" : "Submit to store")));
    const tabs = h("div", { class: "creator-tabs", role: "tablist" }, ...TABS[c.kind].map(([k, label]) => h("button", {
      class: tab === k ? "on" : "", role: "tab", "aria-selected": String(tab === k), onclick: () => { tab = k; renderEditor(); },
    }, label)));
    const body = h("div", { class: "creator-body" });
    const views = { details: detailsTab, colors: colorsTab, css: cssTab, code: codeTab, permissions: permissionsTab, readme: readmeTab, versions: versionsTab, publish: publishTab };
    body.append(...[].concat(views[tab](c)).filter(Boolean));
    root.replaceChildren(head, tabs, body);
    setSave(saveState, saveError);
  }

  const field = (label, control, hint) => h("div", { class: "field" }, h("label", {}, label), control, hint ? h("small", { class: "muted" }, hint) : null);
  function bindInput(input, c, key, transform) {
    input.addEventListener("input", () => {
      c[key] = transform ? transform(input.value) : input.value;
      changed();
      if (key === "name") { const t = $(".creator-title h1"); if (t) t.textContent = c.name || `Untitled ${c.kind}`; }
    });
    return input;
  }

  // ---- details
  function detailsTab(c) {
    const name = bindInput(h("input", { class: "input", value: c.name, maxlength: "60", placeholder: KIND_LABEL[c.kind] + " name", style: { width: "100%" } }), c, "name");
    const desc = bindInput(h("textarea", { class: "input", maxlength: "500", placeholder: "What it does and why someone would want it", rows: "3", style: { width: "100%" } }), c, "description");
    desc.value = c.description || "";
    const tags = bindInput(h("input", { class: "input", value: (c.tags || []).join(", "), placeholder: "dark, minimal, pastel", style: { width: "100%" } }), c, "tags",
      (v) => v.split(",").map((t) => t.trim().toLowerCase()).filter(Boolean).slice(0, 5));
    const license = h("select", { class: "input", style: { width: "100%" } }, h("option", { value: "" }, "Choose a license…"),
      ...Object.entries(P.LICENSES).map(([k, label]) => h("option", { value: k, selected: c.license === k }, label)));
    license.onchange = () => { c.license = license.value; changed(); };
    const platforms = h("div", { class: "row-gap wrap" }, ...[["web", "Web player"], ["desktop", "Desktop app"], ["quest", "Meta Quest"]].map(([k, label]) => {
      const box = h("input", { type: "checkbox", checked: (c.platforms || P.PLATFORMS).includes(k) });
      box.onchange = () => {
        const set = new Set(c.platforms || P.PLATFORMS);
        box.checked ? set.add(k) : set.delete(k);
        if (!set.size) { box.checked = true; return toast("Pick at least one place it works", true); }
        c.platforms = P.PLATFORMS.filter((p) => set.has(p)); changed();
      };
      return h("label", { class: "check" }, box, label);
    }));
    const parts = [
      h("div", { class: "creator-grid" },
        h("div", {},
          field("Name", name),
          field("Description", desc),
          field("Tags", tags, "Up to 5, separated by commas. People search by these."),
          field("License", license, "Required to submit. It tells people what they may do with your work."),
          field("Works on", platforms),
          c.kind === "extension" ? field("Needs other extensions", (() => {
            const t = bindInput(h("textarea", { class: "input mono", rows: "2", placeholder: "One per line (optional)", style: { width: "100%" } }), c, "dependencies",
              (v) => v.split("\n").map((x) => x.trim()).filter(Boolean).slice(0, 10));
            t.value = (c.dependencies || []).join("\n");
            return t;
          })()) : null,
          field("Author", h("div", { class: "author-line" }, creatorName() || h("span", { class: "muted" }, "Set up your creator profile first"),
            h("button", { class: "btn link small", onclick: editProfile }, creatorName() ? "Edit profile" : "Set up")))),
        h("div", {}, previewField(c), c.kind === "extension" ? iconField(c) : null,
          c.basedOn ? h("div", { class: "based-on" }, h("div", { class: "label" }, "Based on"),
            h("div", {}, c.basedOn.url ? h("a", { href: c.basedOn.url, target: "_blank", rel: "noopener noreferrer" }, c.basedOn.name) : c.basedOn.name, c.basedOn.author ? ` by ${c.basedOn.author}` : ""),
            h("small", { class: "muted" }, "This credit is kept when you publish. Check the original's license allows sharing changed versions.")) : null)),
    ];
    return parts;
  }

  /** Pick an image file and shrink it to a reasonable JPEG data URL. */
  function readImage(file, maxW, maxBytes) {
    return new Promise((resolve, reject) => {
      if (!/^image\//.test(file.type)) return reject(new Error("Pick an image file"));
      const img = new Image();
      img.onload = () => {
        const scale = Math.min(1, maxW / img.width);
        const cv = document.createElement("canvas");
        cv.width = Math.round(img.width * scale); cv.height = Math.round(img.height * scale);
        cv.getContext("2d").drawImage(img, 0, 0, cv.width, cv.height);
        URL.revokeObjectURL(img.src);
        for (const q of [0.85, 0.75, 0.6, 0.45]) {
          const url = cv.toDataURL("image/jpeg", q);
          if (url.length <= maxBytes) return resolve(url);
        }
        reject(new Error("That image is too detailed to fit. Try a smaller one, or use an https:// link."));
      };
      img.onerror = () => reject(new Error("Couldn't read that image"));
      img.src = URL.createObjectURL(file);
    });
  }

  function previewField(c) {
    const show = h("div", { class: "preview-box" });
    const paint = () => show.replaceChildren(c.preview ? h("img", { src: c.preview, alt: "Preview", referrerpolicy: "no-referrer" }) : placeholder(c.name || "Preview"));
    paint();
    const url = h("input", { class: "input mono", placeholder: "https://… image link", value: /^https:/.test(c.preview || "") ? c.preview : "", style: { width: "100%" } });
    url.addEventListener("change", () => {
      const v = url.value.trim();
      if (v && !/^https:\/\//.test(v)) return toast("Use an https:// link", true);
      c.preview = v; paint(); changed();
    });
    const file = h("input", { type: "file", accept: "image/png,image/jpeg,image/webp", hidden: true });
    file.onchange = async () => {
      const f = file.files[0]; file.value = "";
      if (!f) return;
      try { c.preview = await readImage(f, 1280, P.LIMITS.preview - 1000); url.value = ""; paint(); changed(); } catch (e) { toast(e.message, true); }
    };
    return field("Preview image", h("div", {}, show,
      h("div", { class: "row-gap" }, h("button", { class: "btn ghost small", onclick: () => file.click() }, "Upload screenshot"),
        c.preview ? h("button", { class: "btn link small", onclick: () => { c.preview = ""; url.value = ""; paint(); changed(); } }, "Remove") : null, file),
      url), "A screenshot of Spotify with it on. Uploads are shrunk to fit (300 KB max).");
  }

  function iconField(c) {
    const show = h("div", { class: "icon-box" }, c.icon ? h("img", { src: c.icon, alt: "" }) : placeholder(c.name || "?"));
    const file = h("input", { type: "file", accept: "image/png,image/jpeg,image/webp", hidden: true });
    file.onchange = async () => {
      const f = file.files[0]; file.value = "";
      if (!f) return;
      try { c.icon = await readImage(f, 128, P.LIMITS.icon - 1000); changed(); renderEditor(); } catch (e) { toast(e.message, true); }
    };
    return field("Icon", h("div", { class: "row-gap" }, show, h("button", { class: "btn ghost small", onclick: () => file.click() }, "Upload icon"),
      c.icon ? h("button", { class: "btn link small", onclick: () => { c.icon = ""; changed(); renderEditor(); } }, "Remove") : null, file));
  }

  // ---- code / CSS editors (same look as Custom CSS)
  function codeEditor(c, key, opts) {
    const ta = h("textarea", { spellcheck: false, "aria-label": opts.label, placeholder: opts.placeholder || "" });
    ta.value = c[key] || "";
    const gutter = h("pre", { class: "gutter", "aria-hidden": "true" }, "1");
    const meta = h("span", { class: "meta" });
    const note = h("span", { class: "meta" });
    const chrome = () => {
      const v = ta.value;
      const lines = (v.match(/\n/g) || []).length + 1;
      if (gutter.dataset.n !== String(lines)) { gutter.dataset.n = String(lines); gutter.textContent = Array.from({ length: lines }, (_, i) => i + 1).join("\n"); }
      meta.textContent = `${lines} line${lines > 1 ? "s" : ""} · ${(new Blob([v]).size / 1024).toFixed(1)} KB`;
      if (opts.check) { const msg = opts.check(v); note.textContent = msg; note.className = "meta" + (msg ? " warn-text" : ""); }
    };
    ta.addEventListener("input", () => { c[key] = ta.value; chrome(); changed(); });
    ta.addEventListener("scroll", () => { gutter.scrollTop = ta.scrollTop; });
    ta.addEventListener("keydown", (e) => {
      if (e.key === "Tab" && !e.shiftKey) { e.preventDefault(); ta.setRangeText("  ", ta.selectionStart, ta.selectionEnd, "end"); ta.dispatchEvent(new Event("input")); }
      if ((e.ctrlKey || e.metaKey) && e.key === "s") { e.preventDefault(); autosave(); }
    });
    chrome();
    return h("div", { class: "editor creator-editor" },
      h("div", { class: "editor-bar" }, h("span", {}, opts.title), note, h("span", { class: "grow" }), meta, h("span", { class: "meta" }, "Tab indents · saves as you type")),
      h("div", { class: "editor-body" }, gutter, ta));
  }
  const braceCheck = (v) => {
    const bare = v.replace(/\/\*[\s\S]*?\*\//g, "");
    const o = (bare.match(/{/g) || []).length, cl = (bare.match(/}/g) || []).length;
    return o === cl ? "" : o > cl ? `${o - cl} unclosed {` : `${cl - o} extra }`;
  };
  function cssTab(c) {
    return [
      c.kind === "theme" ? h("p", { class: "muted" }, "Colours from the Colours tab are available as ", h("code", {}, "var(--spice-main)"), ", ", h("code", {}, "var(--spice-button)"), " and so on. Spicetify class names work. Use https:// links for images and fonts.") : null,
      codeEditor(c, "css", { title: c.kind === "theme" ? "Theme CSS" : "Snippet CSS", label: "CSS", check: braceCheck, placeholder: ".main-nowPlayingBar-container { border-top: 1px solid var(--spice-button); }" }),
      isApplied(c) ? h("p", { class: "muted small" }, "On in Spotify: changes show up there a moment after you type.") : h("p", { class: "muted small" }, h("button", { class: "btn link small", onclick: () => toggleApplied(c).then(renderEditor) }, "Try it in Spotify"), " to see changes live."),
    ];
  }
  function codeTab(c) {
    let lastCheck = "";
    const check = (v) => {
      try { new Function(v); lastCheck = ""; } catch (e) { lastCheck = e instanceof SyntaxError ? "Syntax error: " + e.message : ""; }
      return lastCheck;
    };
    return [
      h("p", { class: "muted" }, "Plain JavaScript with the Spicetify API (", h("code", {}, "Spicetify.Player"), ", ", h("code", {}, "Spicetify.Topbar"), ", ", h("code", {}, "Spicetify.Platform"), "…). It only gets the permissions you tick in the Permissions tab, even while you test it."),
      codeEditor(c, "code", { title: "extension.js", label: "Extension code", check }),
      h("p", { class: "muted small" }, isApplied(c) ? "Testing in Spotify. Reload Spotify after editing to run the new code." : "Use Test in Spotify (top right) to run it. Errors show in Spotify's developer console."),
    ];
  }

  // ---- permissions
  function permissionsTab(c) {
    const d = P.detectPermissions(c.code || "");
    const rows = Object.entries(P.PERMISSIONS).map(([k, info]) => {
      const box = h("input", { type: "checkbox", checked: (c.permissions || []).includes(k) });
      box.onchange = () => {
        const set = new Set(c.permissions || []);
        box.checked ? set.add(k) : set.delete(k);
        c.permissions = Object.keys(P.PERMISSIONS).filter((p) => set.has(p));
        changed(); renderEditor();
      };
      const used = d.used.includes(k), asked = (c.permissions || []).includes(k);
      return h("label", { class: "setting perm-row" },
        h("div", {}, h("strong", {}, info.label), h("small", {}, info.detail),
          used && !asked ? h("small", { class: "warn-text" }, "Your code uses this. Without it, those calls are blocked.") : null,
          !used && asked ? h("small", { class: "muted" }, "Your code doesn't seem to use this.") : null),
        box);
    });
    return [
      h("p", { class: "muted" }, "People see this list before they install. Spectra blocks anything your extension didn't ask for, and the store review checks the code too."),
      h("div", { class: "settings" }, ...rows),
      d.risks.length ? h("div", { class: "checks" }, h("h3", {}, "Reviewers will look closely at"), h("ul", {}, ...d.risks.map((r) => h("li", { class: "warn" }, r)))) : null,
    ];
  }

  // ---- README
  function readmeTab(c) {
    const ta = bindInput(h("textarea", { class: "input mono readme-input", placeholder: "# What it does\n\nHow to use it, settings, and anything it sends to other sites.", rows: "16", style: { width: "100%" } }), c, "readme");
    ta.value = c.readme || "";
    const preview = h("div", { class: "readme-preview" });
    const paint = () => preview.replaceChildren(c.readme && c.readme.trim() ? renderReadme(c.readme, "https://usespectra.xyz/") : h("p", { class: "muted" }, "The preview shows up here."));
    ta.addEventListener("input", debounce(paint, 250));
    paint();
    return h("div", { class: "readme-split" }, field("README (Markdown)", ta), h("div", { class: "field" }, h("label", {}, "Preview"), preview));
  }

  // ---- colours
  function colorsTab(c) {
    c.schemes = c.schemes || {};
    const names = Object.keys(c.schemes);
    if (!schemeSel || !c.schemes[schemeSel]) schemeSel = names[0] || null;
    const mock = $("#mock").cloneNode(true);
    mock.removeAttribute("id");
    const paintMock = () => {
      const pal = Object.assign({}, Core.BASE_COLORS, schemeSel ? c.schemes[schemeSel] : {});
      for (const [k, v] of Object.entries(pal)) { mock.style.setProperty(`--spice-${k}`, "#" + v); mock.style.setProperty(`--spice-rgb-${k}`, Core.hexToRgb(v).join(",")); }
    };
    const addScheme = (copyFrom) => {
      let n = "New scheme", i = 2;
      while (c.schemes[n]) n = `New scheme ${i++}`;
      c.schemes[n] = Object.assign({}, copyFrom ? c.schemes[copyFrom] : Core.BASE_COLORS);
      schemeSel = n; changed(); renderEditor();
    };
    const chips = h("div", { class: "scheme-list" },
      ...names.map((n) => h("button", { class: "chip" + (n === schemeSel ? " on" : ""), "aria-pressed": String(n === schemeSel), onclick: () => { schemeSel = n; renderEditor(); } },
        h("span", { class: "sw" }, ...["main", "sidebar", "player", "text", "button"].map((k) => h("i", { style: { background: "#" + (c.schemes[n][k] || Core.BASE_COLORS[k]) } }))), n)),
      h("button", { class: "btn ghost small", onclick: () => addScheme(schemeSel) }, names.length ? "Duplicate scheme" : "Add a scheme"),
      h("button", { class: "btn link small", onclick: pasteIni }, "Paste color.ini"));
    function pasteIni() {
      const ta = h("textarea", { class: "input mono", rows: "12", placeholder: "[Dark]\ntext = ffffff\nmain = 121212\n…", style: { width: "100%" } });
      const go = h("button", { class: "btn primary" }, "Add schemes");
      go.onclick = () => {
        const parsed = Core.parseColorIni(ta.value);
        const count = Object.keys(parsed).length;
        if (!count) return toast("No colour schemes found in that text", true);
        Object.assign(c.schemes, parsed);
        schemeSel = Object.keys(parsed)[0];
        changed(); closeDrawer(); renderEditor();
        toast(`Added ${count} scheme${count > 1 ? "s" : ""}`);
      };
      openDrawer(h("h2", {}, "Paste a color.ini"), h("p", { class: "muted" }, "Spicetify's colour file format. Every [section] becomes a scheme."), ta, go);
    }
    if (!schemeSel) return [h("div", { class: "panel" }, h("div", { class: "panel-body" }, h("p", { class: "muted" }, "No colour schemes yet. A theme can be CSS only, but schemes let people pick colours."), chips))];

    const sc = c.schemes[schemeSel];
    const rename = h("input", { class: "input", value: schemeSel, maxlength: "40", "aria-label": "Scheme name" });
    rename.addEventListener("change", () => {
      const n = rename.value.trim();
      if (!n || n === schemeSel) { rename.value = schemeSel; return; }
      if (c.schemes[n]) { rename.value = schemeSel; return toast("There's already a scheme with that name", true); }
      const next = {};
      for (const [k, v] of Object.entries(c.schemes)) next[k === schemeSel ? n : k] = v;
      c.schemes = next; schemeSel = n; changed(); renderEditor();
    });
    const del = h("button", { class: "btn link small" }, "Delete scheme");
    del.onclick = () => {
      const gone = schemeSel, value = c.schemes[gone];
      delete c.schemes[gone]; schemeSel = null; changed(); renderEditor();
      toast(`Deleted ${gone}`, false, { label: "Undo", onClick: () => { c.schemes[gone] = value; schemeSel = gone; changed(); renderEditor(); } });
    };
    const rows = P.COLOR_KEYS.map((k) => {
      const set = !!sc[k];
      const val = sc[k] || Core.BASE_COLORS[k];
      const row = h("div", { class: "pal" + (set ? " changed" : " unset") });
      const picker = h("input", { type: "color", value: "#" + val, "aria-label": `${k} colour` });
      const hexIn = h("input", { class: "hex", value: "#" + val, spellcheck: false, maxlength: "7", "aria-label": `${k} hex value` });
      const apply = (v) => { sc[k] = v; picker.value = hexIn.value = "#" + v; row.classList.add("changed"); row.classList.remove("unset"); paintMock(); changed(); };
      picker.addEventListener("input", () => apply(picker.value.slice(1).toLowerCase()));
      hexIn.addEventListener("input", () => { const v = Core.normalizeHex(hexIn.value); hexIn.classList.toggle("bad", !v && hexIn.value.trim().length > 0); if (v && /^#?[0-9a-f]{6}$/i.test(hexIn.value.trim())) apply(v); });
      hexIn.addEventListener("blur", () => { hexIn.classList.remove("bad"); hexIn.value = "#" + (sc[k] || Core.BASE_COLORS[k]); });
      const reset = h("button", { class: "icon-btn reset", title: "Use Spotify's default for this", "aria-label": `Unset ${k}` }, "×");
      reset.onclick = () => { delete sc[k]; picker.value = hexIn.value = "#" + Core.BASE_COLORS[k]; row.classList.remove("changed"); row.classList.add("unset"); paintMock(); changed(); };
      row.append(picker, h("span", { class: "k" }, k), hexIn, reset);
      return row;
    });
    paintMock();
    return h("div", { class: "colors-layout" },
      h("div", {},
        h("section", { class: "panel" }, h("header", { class: "panel-head" }, h("h2", {}, "Schemes"), h("span", {}, `${names.length}`)), h("div", { class: "panel-body" }, chips)),
        h("section", { class: "panel" },
          h("header", { class: "panel-head" }, h("h2", {}, "Palette"), h("div", { class: "row-gap" }, rename, del)),
          h("div", { class: "palette" }, ...rows),
          h("div", { class: "panel-body muted small" }, "Unset colours (faded) use Spotify's defaults."))),
      h("div", { class: "preview-wrap" }, mock, h("div", { class: "caption" }, h("span", {}, "Preview"), h("span", {}, isApplied(c) ? "Also live in Spotify" : "Try in Spotify to see it for real"))));
  }

  // ---- versions
  function versionsTab(c) {
    const last = c.versions && c.versions[0];
    const base = (last && last.version) || (c.listing && c.listing.version) || null;
    const next = { patch: base ? P.bumpVersion(base, "patch") : c.version || "1.0.0", minor: base ? P.bumpVersion(base, "minor") : "1.1.0", major: base ? P.bumpVersion(base, "major") : "2.0.0" };
    let pick = "patch";
    const choice = h("div", { class: "seg" }, ...[["patch", "Fix"], ["minor", "New feature"], ["major", "Big change"]].map(([k, label]) => {
      const b = h("button", { class: k === pick ? "on" : "", onclick: () => { pick = k; $$(".seg button", choice).forEach((x) => x.classList.toggle("on", x === b)); num.textContent = next[k]; } }, label);
      return b;
    }));
    const num = h("strong", { class: "mono" }, next[pick]);
    const notes = h("textarea", { class: "input", rows: "3", maxlength: "1000", placeholder: "What changed, in a sentence or two. People see this when they update.", style: { width: "100%" } });
    const saveBtn = h("button", { class: "btn primary small" }, base ? "Save version" : "Save first version");
    saveBtn.onclick = async () => {
      if (!notes.value.trim()) return toast("Write a line about what changed", true);
      const version = base ? next[pick] : (P.parseVersion(c.version) ? c.version : "1.0.0");
      c.version = version;
      c.versions = [{ version, changelog: notes.value.trim(), at: Date.now(), data: snapshot(c) }].concat(c.versions || []).slice(0, 10);
      changed(); renderEditor();
      toast(`Saved version ${version}`);
    };
    const list = (c.versions || []).map((v, i) => h("div", { class: "row" },
      h("div", { class: "grow" },
        h("div", { class: "title" }, "v" + v.version, i === 0 ? h("span", { class: "tag" }, "latest") : null, c.listing && c.listing.version === v.version ? h("span", { class: "state live" }, "in the store") : null),
        h("div", { class: "sub" }, `${timeAgo(v.at)} · ${v.changelog}`)),
      h("div", { class: "actions" }, h("button", { class: "btn link small", onclick: () => {
        const before = snapshot(c);
        Object.assign(c, JSON.parse(JSON.stringify(v.data)));
        changed(); renderEditor();
        toast(`Restored v${v.version}`, false, { label: "Undo", onClick: () => { Object.assign(c, before); changed(); renderEditor(); } });
      } }, "Restore"))));
    return [
      h("section", { class: "panel" },
        h("header", { class: "panel-head" }, h("h2", {}, "Save a version"), h("span", {}, base ? `last saved: v${base}` : "nothing saved yet")),
        h("div", { class: "panel-body version-form" },
          base ? h("div", { class: "row-gap wrap" }, choice, h("span", { class: "muted" }, "→ v"), num) : h("p", { class: "muted" }, "Your work saves automatically. A version is a named snapshot you can go back to, and what you submit to the store."),
          notes, h("div", {}, saveBtn))),
      list.length ? h("div", { class: "list" }, ...list) : null,
    ];
  }

  // ---- publish
  function publishTab(c) {
    const pkg = pkgOf(c);
    const prev = c.listing && c.listing.version;
    const v = P.validate(pkg, { previousVersion: prev || "" });
    const sub = c.submission;
    const waiting = sub && ["submitted", "reviewing", "changes"].includes(sub.status);
    const parts = [];

    if (c.listing) {
      const [label, cls] = STATUS[c.listing.status === "published" ? "published" : c.listing.status === "removed" ? "removed" : "archived"];
      parts.push(h("div", { class: "now publish-now" },
        h("div", {},
          h("div", { class: "label" }, h("span", { class: "state " + cls }, label), h("span", {}, `· v${c.listing.version} in the Spectra Store`)),
          h("p", { class: "muted" }, c.listing.status === "published" ? "People can find and install it from the Spectra Store in Spectra." : c.listing.status === "archived" ? "Hidden from the store. People who installed it keep it." : "Spectra took this listing down. Ask on Discord if you're not sure why.")),
        c.listing.status !== "removed" ? h("div", { class: "now-actions" }, h("button", { class: "btn ghost small", onclick: (e) => busy(e.currentTarget, "Saving", () => setArchived(c, c.listing.status === "published")) },
          c.listing.status === "published" ? "Archive listing" : "List it again")) : null));
    }

    if (sub) {
      const steps = [["submitted", "Submitted"], ["reviewing", "Under review"], [sub.status === "rejected" ? "rejected" : sub.status === "changes" ? "changes" : "approved", sub.status === "rejected" ? "Rejected" : sub.status === "changes" ? "Changes requested" : "Published"]];
      const reached = { submitted: 0, reviewing: 1, changes: 2, approved: 2, rejected: 2, withdrawn: 0 }[sub.status];
      parts.push(h("section", { class: "panel" },
        h("header", { class: "panel-head" }, h("h2", {}, `Submission · v${sub.version}`), h("span", {}, `updated ${timeAgo(sub.updated)}`)),
        h("div", { class: "panel-body" },
          sub.status === "withdrawn" ? h("p", { class: "muted" }, "You withdrew this submission.") : h("ol", { class: "steps" }, ...steps.map(([k, label], i) => h("li", { class: i < reached ? "done" : i === reached ? "here " + k : "" }, label))),
          sub.feedback ? h("blockquote", { class: "feedback" }, h("div", { class: "label" }, "From the reviewer"), sub.feedback) : null,
          sub.status === "changes" ? h("p", { class: "muted small" }, "Make the changes, then submit again below. Your new submission replaces this one.") : null,
          waiting && sub.status !== "changes" ? h("div", { class: "row-gap" }, h("button", { class: "btn link small", onclick: (e) => busy(e.currentTarget, "Withdrawing", () => withdraw(c)) }, "Withdraw")) : null)));
    }

    const list = (items, cls) => items.map((t) => h("li", { class: cls }, t));
    parts.push(h("section", { class: "panel" },
      h("header", { class: "panel-head" }, h("h2", {}, "Store checks"), h("span", { class: "state " + (v.ok ? "live" : "bad") }, v.ok ? "Ready" : `${v.errors.length} to fix`)),
      h("div", { class: "panel-body checks" },
        v.errors.length ? h("ul", {}, ...list(v.errors, "bad")) : h("p", { class: "ok-text" }, "Everything the store needs is here."),
        v.warnings.length ? h("ul", {}, ...list(v.warnings, "warn")) : null,
        v.notes.length ? h("ul", {}, ...list(v.notes, "note")) : null,
        c.kind === "extension" ? h("p", { class: "muted small" }, "People will see: ", pkg.permissions.length ? pkg.permissions.map((p) => P.PERMISSIONS[p].label).join(", ") : "no special permissions", ".") : null)));

    if (!creatorName()) {
      parts.push(h("div", { class: "banner info" }, h("div", {}, h("strong", {}, "Set up your creator profile to submit"), h("br"), h("small", {}, "It's the name shown on your work in the store.")),
        h("button", { class: "btn primary small", onclick: editProfile }, "Set up")));
      return parts;
    }

    const latest = c.versions && c.versions[0];
    const notes = h("textarea", { class: "input", rows: "3", maxlength: "1000", placeholder: prev ? "What's new in this version" : "Optional: anything the reviewer should know", style: { width: "100%" } });
    notes.value = latest && latest.version === c.version ? latest.changelog : "";
    const agree = h("input", { type: "checkbox" });
    const submit = h("button", { class: "btn primary" }, prev ? `Submit v${pkg.version || "?"} for review` : "Submit for review");
    submit.disabled = !v.ok;
    submit.onclick = () => busy(submit, "Submitting", async () => {
      if (!agree.checked) return toast("Tick the box to confirm you can share this", true);
      if (prev && !notes.value.trim()) return toast("Say what changed in this version", true);
      try {
        const r = await call("POST", { action: "submit", creatorKey: ensureKey(), creator: { name: S().creator.name, bio: S().creator.bio, link: S().creator.link },
          item: pkg, changelog: notes.value.trim(), storeId: c.storeId || "", localId: c.id });
        c.submission = { id: r.submission.id, storeId: r.submission.storeId, status: r.submission.status, feedback: "", version: r.submission.version, updated: r.submission.updated, history: r.submission.history };
        await D.save();
        mine = null;
        renderEditor(); render();
        toast("Submitted. You'll see the review here and in My Library");
      } catch (e) {
        if (e.data && e.data.findings) toast("The store found problems: " + e.data.findings.errors[0], true);
        else toast(e.message, true);
      }
    });
    parts.push(h("section", { class: "panel" },
      h("header", { class: "panel-head" }, h("h2", {}, prev ? "Publish an update" : "Submit to the Spectra Store"), h("span", {}, `as ${creatorName()} · v${pkg.version || "?"} · ${pkg.license || "no license yet"}`)),
      h("div", { class: "panel-body submit-form" },
        prev && P.compareVersions(pkg.version, prev) <= 0 ? h("p", { class: "warn-text" }, `Save a new version in the Versions tab first (the store has v${prev}).`) : null,
        field(prev ? "What changed" : "Note for the reviewer", notes),
        h("label", { class: "check" }, agree, "I made this, or its license lets me share a changed version, and it doesn't collect anyone's data without saying so."),
        h("div", { class: "row-gap" }, submit, h("button", { class: "btn ghost", onclick: () => exportPackage(c) }, "Export package")),
        h("p", { class: "muted small" }, "A person at Spectra reviews every submission. Approved items appear in the Spectra Store with your creator name. You can archive your listing at any time."))));
    return parts;
  }

  async function withdraw(c) {
    try {
      await call("POST", { action: "withdraw", creatorKey: ensureKey(), id: c.submission.id });
      c.submission.status = "withdrawn";
      await D.save();
      renderEditor(); render();
      toast("Withdrawn");
    } catch (e) { toast(e.message, true); }
  }
  async function setArchived(c, archive) {
    try {
      await call("POST", { action: archive ? "archive" : "unarchive", creatorKey: ensureKey(), storeId: c.storeId });
      c.listing.status = archive ? "archived" : "published";
      await D.save();
      storeCache = null;
      renderEditor(); render();
      toast(archive ? "Archived. It's hidden from the store" : "Listed again");
    } catch (e) { toast(e.message, true); }
  }

  // ------------------------------------------------------------------ the Spectra Store (in Themes, Extensions and Snippets)
  let storeCache = null; // { at, items }
  async function storeItems(force) {
    if (!force && storeCache && Date.now() - storeCache.at < 5 * 60 * 1000) return storeCache.items;
    const r = await call("GET", null, { list: "1" });
    storeCache = { at: Date.now(), items: r.items || [] };
    return storeCache.items;
  }
  async function storePackage(id) {
    const r = await call("GET", null, { id });
    return r.item;
  }

  const installedFromStore = (item) => {
    const st = S();
    if (item.kind === "theme") return st.theme && st.theme.source && st.theme.source.store === item.id ? st.theme : null;
    if (item.kind === "extension") return st.extensions.find((e) => e.source && e.source.store === item.id) || null;
    return st.snippets.find((s) => s.source === "store:" + item.id) || null;
  };

  function heart(item) {
    const on = S().favorites.includes(item.id);
    const b = h("button", { class: "icon-btn fav" + (on ? " on" : ""), title: on ? "Remove from favorites" : "Add to favorites", "aria-pressed": String(on), "aria-label": "Favorite" }, on ? "♥" : "♡");
    b.onclick = async (e) => {
      e.stopPropagation();
      const st = S();
      st.favorites = on ? st.favorites.filter((x) => x !== item.id) : [item.id].concat(st.favorites).slice(0, 200);
      await D.save();
      renderStore(); render();
    };
    return b;
  }

  function permissionList(perms) {
    return h("ul", { class: "perm-list" }, ...(perms && perms.length ? perms.map((p) => h("li", {}, h("strong", {}, P.PERMISSIONS[p].label), " ", h("span", { class: "muted" }, P.PERMISSIONS[p].detail)))
      : [h("li", {}, "No special permissions. It can't control playback, reach other sites or change your library.")]));
  }

  async function installStoreItem(item, confirmed) {
    const full = await storePackage(item.id);
    const p = full.package;
    if (p.kind === "extension" && !confirmed) {
      return new Promise((resolve) => {
        const go = h("button", { class: "btn primary" }, "Install with these permissions");
        go.onclick = () => busy(go, "Installing", async () => { try { await installStoreItem(item, true); closeDrawer(); resolve(true); } catch (e) { toast(e.message, true); } });
        openDrawer(h("h2", {}, `Install ${p.name}?`), h("p", { class: "muted" }, `by ${full.creator} · v${p.version} · ${p.license}`),
          h("h3", {}, "It will be able to"), permissionList(p.permissions),
          h("p", { class: "muted small" }, "Spectra blocks anything it didn't ask for. You can turn it off or remove it any time in Extensions."),
          h("div", { class: "row-gap" }, go, h("button", { class: "btn ghost", onclick: () => { closeDrawer(); resolve(false); } }, "Cancel")));
      });
    }
    const st = S();
    const source = { store: item.id, version: p.version };
    const authors = [{ name: full.creator }];
    if (p.kind === "theme") {
      st.theme = { id: "store:" + item.id, name: p.name, css: p.css, schemes: p.schemes, scripts: [], preview: p.preview || null, authors, source, installedAt: Date.now() };
      st.scheme = Object.keys(p.schemes || {})[0] || null;
      st.colorOverrides = {};
      await D.save();
      toast(`${p.name} is on`);
      D.renderThemes(); D.renderColors();
    } else if (p.kind === "extension") {
      const ext = { id: "store:" + item.id, name: p.name, description: p.description, code: p.code, permissions: p.permissions.slice(), enabled: true, authors, source, installedAt: Date.now() };
      const existing = st.extensions.find((e) => e.id === ext.id);
      existing ? Object.assign(existing, ext) : st.extensions.push(ext);
      await D.save();
      toast(`${p.name} installed`, false, reloadAction());
      D.renderExtensions();
    } else {
      const existing = st.snippets.find((s) => s.source === "store:" + item.id);
      if (existing) Object.assign(existing, { title: p.name, code: p.css });
      else st.snippets.push({ id: Core.uid("snip"), title: p.name, code: p.css, enabled: true, source: "store:" + item.id, version: p.version });
      await D.save();
      toast(`${p.name} added`);
      D.renderSnippets();
    }
    renderStore();
    return true;
  }

  async function uninstallStoreItem(item) {
    const st = S();
    if (item.kind === "theme") { st.theme = null; st.scheme = null; st.colorOverrides = {}; D.renderThemes(); D.renderColors(); }
    else if (item.kind === "extension") { st.extensions = st.extensions.filter((e) => !(e.source && e.source.store === item.id)); D.renderExtensions(); }
    else { st.snippets = st.snippets.filter((s) => s.source !== "store:" + item.id); D.renderSnippets(); }
    await D.save();
    renderStore();
    toast(`${item.name} removed`);
  }

  D.hooks.updateStoreExtension = async (ext) => {
    const full = await storePackage(ext.source.store);
    const p = full.package;
    if (P.compareVersions(p.version, ext.source.version || "0.0.0") <= 0) return false;
    const added = p.permissions.filter((x) => !(ext.permissions || []).includes(x));
    if (added.length && !confirm(`${p.name} ${p.version} wants new permissions: ${added.map((x) => P.PERMISSIONS[x].label.replace(/^./, (ch) => ch.toLowerCase())).join(", ")}. Update anyway?`)) return false;
    Object.assign(ext, { name: p.name, code: p.code, permissions: p.permissions.slice(), updatedAt: Date.now(), source: { store: ext.source.store, version: p.version } });
    return true;
  };
  D.hooks.updateStoreTheme = async (t) => {
    const full = await storePackage(t.source.store);
    const p = full.package;
    if (P.compareVersions(p.version, t.source.version || "0.0.0") <= 0) return false;
    Object.assign(t, { name: p.name, css: p.css, schemes: p.schemes, preview: p.preview || null, source: { store: t.source.store, version: p.version }, installedAt: Date.now() });
    toast(`Updated ${p.name} to ${p.version}`);
    return true;
  };

  async function storeDetails(item) {
    const installed = installedFromStore(item);
    const act = h("button", { class: "btn " + (installed ? "ghost" : "primary") }, installed ? "Remove" : item.kind === "theme" ? "Apply theme" : item.kind === "extension" ? "Install" : "Add snippet");
    act.onclick = () => busy(act, installed ? "Removing" : "Installing", async () => {
      try { if (installed) await uninstallStoreItem(item); else if (await installStoreItem(item)) closeDrawer(); } catch (e) { toast(e.message, true); }
    });
    const custom = h("button", { class: "btn ghost", title: "Make your own copy in My Library, with credit to the creator" }, "Customize");
    custom.onclick = () => busy(custom, "Copying", async () => {
      try {
        const full = await storePackage(item.id);
        closeDrawer();
        D.hooks.customize(item.kind, Object.assign({}, full.package, { title: full.package.name, code: item.kind === "snippet" ? full.package.css : full.package.code, creator: full.creator, url: "" }));
      } catch (e) { toast(e.message, true); }
    });
    const more = h("div", { class: "muted" }, "Loading…");
    openDrawer(
      h("div", { class: "card-meta" }, h("span", { class: "tag" }, "Spectra Store"), KIND_LABEL[item.kind]),
      h("h2", {}, item.name),
      h("div", { class: "card-meta" }, h("span", {}, "by ", item.creator), h("span", {}, "v" + item.version), h("span", {}, item.license.replace(/-/g, " ")), h("span", {}, "updated " + timeAgo(item.updatedAt))),
      item.basedOn ? h("p", { class: "muted small" }, `Based on ${item.basedOn.name}${item.basedOn.author ? ` by ${item.basedOn.author}` : ""}`) : null,
      h("p", {}, item.description),
      h("div", { class: "row-gap wrap" }, act, custom, heart(item)),
      item.preview ? h("img", { class: "big", src: item.preview, alt: "", referrerpolicy: "no-referrer" }) : null,
      item.kind === "extension" ? h("div", {}, h("h3", {}, "Permissions"), permissionList(item.permissions)) : null,
      more);
    try {
      const full = await storePackage(item.id);
      const kids = [];
      if (full.package.readme) kids.push(renderReadme(full.package.readme, "https://usespectra.xyz/"));
      if (full.versions && full.versions.length) kids.push(h("h3", {}, "Versions"), h("ul", { class: "versions" }, ...full.versions.map((v) => h("li", {}, h("strong", {}, "v" + v.version), ` · ${timeAgo(v.at)}`, v.changelog ? ` · ${v.changelog}` : ""))));
      more.replaceWith(h("div", {}, ...kids));
    } catch { more.textContent = ""; }
  }

  function storeCard(item) {
    const installed = installedFromStore(item);
    const btn = h("button", { class: "btn " + (installed ? "ghost" : "primary") + " small" }, installed ? "Remove" : item.kind === "theme" ? "Apply" : "Add");
    btn.onclick = (e) => { e.stopPropagation(); busy(btn, installed ? "Removing" : "Applying", async () => { try { installed ? await uninstallStoreItem(item) : await installStoreItem(item); } catch (err) { toast(err.message, true); } }); };
    const media = mediaEl(item, () => storeDetails(item));
    return h("div", { class: "card" + (installed ? " applied" : "") }, media,
      h("div", { class: "card-body" },
        h("div", { class: "card-title" }, h("span", {}, item.name), installed ? h("span", { class: "state live" }, item.kind === "theme" ? "Applied" : "On") : null),
        h("div", { class: "card-meta" }, h("span", {}, "by ", item.creator), h("span", {}, "v" + item.version), item.schemes ? h("span", {}, `${item.schemes} scheme${item.schemes > 1 ? "s" : ""}`) : null),
        item.description ? h("div", { class: "card-desc" }, item.description) : null,
        h("div", { class: "card-actions" }, btn, h("button", { class: "btn link small", onclick: () => storeDetails(item) }, "Details"), heart(item))));
  }
  function storeRow(item) {
    const installed = installedFromStore(item);
    const btn = h("button", { class: "btn " + (installed ? "ghost" : "primary") + " small" }, installed ? "Installed" : "Install");
    btn.disabled = !!installed;
    btn.onclick = (e) => { e.stopPropagation(); busy(btn, "Installing", async () => { try { await installStoreItem(item); } catch (err) { toast(err.message, true); } }); };
    return h("div", { class: "row" + (installed ? " installed" : "") },
      mediaEl(item, () => storeDetails(item), "row-thumb"),
      h("div", { class: "grow" },
        h("div", { class: "title" }, item.name),
        item.description ? h("div", { class: "desc" }, item.description) : null,
        h("div", { class: "card-meta" }, h("span", {}, "by ", item.creator), h("span", {}, "v" + item.version),
          h("span", { title: (item.permissions || []).map((p) => P.PERMISSIONS[p].label).join(", ") }, item.permissions && item.permissions.length ? `${item.permissions.length} permission${item.permissions.length > 1 ? "s" : ""}` : "no special permissions"))),
      h("div", { class: "actions" }, heart(item), h("button", { class: "btn link small", onclick: () => storeDetails(item) }, "Details"), btn));
  }

  let storeError = "";
  async function renderStore(force) {
    let items;
    try { items = await storeItems(force); storeError = ""; } catch (e) { storeError = e.message; items = (storeCache && storeCache.items) || []; }
    const sections = [["theme", "#store-themes", "#store-themes-wrap", storeCard, "#theme-search"], ["extension", "#store-exts", "#store-exts-wrap", storeRow, "#ext-search"], ["snippet", "#store-snips", "#store-snips-wrap", storeCard, "#snippet-search"]];
    for (const [kind, list, wrap, make, search] of sections) {
      const all = items.filter((i) => i.kind === kind);
      const shown = D.filterItems(all.map((i) => Object.assign({ authors: [{ name: i.creator }] }, i)), $(search).value || "");
      $(wrap).hidden = !all.length; // only when there's something real to show
      if (all.length) $(list).replaceChildren(...(shown.length ? shown.map(make) : [empty("Nothing in the Spectra Store matches that.")]));
    }
  }
  for (const id of ["#theme-search", "#ext-search", "#snippet-search"]) $(id).addEventListener("input", debounce(() => renderStore(), 150));
  for (const v of ["themes", "extensions", "snippets"]) D.onView(v, () => renderStore());

  function renderFavorites(box) {
    const favs = S().favorites;
    if (!favs.length) return box.replaceChildren(empty("No favorites yet.", "Tap the heart on anything in the Spectra Store to keep it here."));
    box.replaceChildren(h("div", { class: "muted", style: { padding: "12px" } }, "Loading…"));
    storeItems().then((items) => {
      const list = favs.map((id) => items.find((i) => i.id === id)).filter(Boolean);
      box.replaceChildren(...(list.length ? list.map(storeRow) : [empty("Your favorites aren't in the store anymore.", null)]));
    }).catch((e) => box.replaceChildren(empty("Couldn't reach the Spectra Store.", e.message)));
  }

  // Keep everything in step with the rest of the dashboard (imports, resets, other windows).
  D.onRender(() => {
    render();
    if ($('.view[data-view="creator"]').classList.contains("active") && saveState !== "dirty" && saveState !== "saving") {
      if (!byId(currentId)) D.switchView("library"); else renderEditor();
    }
  });
  renderNavCount();
  // The dashboard may have opened a view before this file loaded: catch up.
  const active = $(".view.active");
  if (active) {
    const v = active.dataset.view;
    if (v === "library") { render(); refreshMine(false); }
    else if (v === "creator") D.switchView("creator");
    else if (["themes", "extensions", "snippets"].includes(v)) renderStore();
  }
})();
