/*
 * Spectra creator packages: the format themes, extensions and snippets are saved,
 * exported and submitted in, and the checks the Spectra Store runs on them.
 *
 * One file, used by the dashboard (classic script → globalThis.SpectraPackage) and by
 * the store server (build.mjs copies it to website/api/_package.cjs).
 */
(function (root) {
  "use strict";

  const KINDS = ["theme", "extension", "snippet"];
  const PLATFORMS = ["web", "desktop", "quest"];
  const LICENSES = {
    "MIT": "MIT: anyone can use, change and share it",
    "Apache-2.0": "Apache 2.0: like MIT, with a patent grant",
    "GPL-3.0": "GPL 3.0: changes must stay open source",
    "MPL-2.0": "MPL 2.0: changed files must stay open",
    "CC-BY-4.0": "CC BY 4.0: share and change it, with credit",
    "CC-BY-SA-4.0": "CC BY-SA 4.0: with credit, under the same terms",
    "CC0-1.0": "CC0: public domain",
    "All-rights-reserved": "All rights reserved: people can install it, not republish it",
  };
  // What an extension may do. Extensions from the Spectra Store only get what they ask for.
  const PERMISSIONS = {
    playback: { label: "Control playback", detail: "Play, pause, skip, seek and change what's playing." },
    library: { label: "Change your library", detail: "Read and change your saved songs and playlists." },
    account: { label: "See your profile", detail: "Read your Spotify name and account details." },
    network: { label: "Connect to other sites", detail: "Send and receive data from sites outside Spotify." },
    interface: { label: "Add to Spotify's interface", detail: "Add buttons, menus, pop-ups and pages." },
    storage: { label: "Remember settings", detail: "Save its own settings on this device." },
  };
  const LIMITS = { css: 400000, code: 400000, snippet: 50000, readme: 20000, preview: 300000, icon: 60000, total: 900000, schemes: 30 };
  const COLOR_KEYS = ["text", "subtext", "main", "main-elevated", "highlight", "highlight-elevated", "sidebar", "player", "card", "shadow",
    "selected-row", "button", "button-active", "button-disabled", "tab-active", "notification", "notification-error", "misc"];

  // ---------- versions
  const SEMVER = /^(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})$/;
  function parseVersion(v) { const m = SEMVER.exec(String(v || "").trim()); return m ? [+m[1], +m[2], +m[3]] : null; }
  function compareVersions(a, b) {
    const x = parseVersion(a) || [0, 0, 0], y = parseVersion(b) || [0, 0, 0];
    for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] > y[i] ? 1 : -1;
    return 0;
  }
  function bumpVersion(v, part) {
    const p = parseVersion(v) || [0, 1, 0];
    if (part === "major") return `${p[0] + 1}.0.0`;
    if (part === "minor") return `${p[0]}.${p[1] + 1}.0`;
    return `${p[0]}.${p[1]}.${p[2] + 1}`;
  }

  // ---------- cleaning
  const str = (v, max) => (typeof v === "string" ? v.slice(0, max) : "");
  const line = (v, max) => str(String(v == null ? "" : v).replace(/[\u0000-\u001f]/g, " ").replace(/\s+/g, " ").trim(), max);
  const text = (v, max) => str(String(v == null ? "" : v).replace(/\r\n/g, "\n").replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, ""), max);
  const hex = (v) => { const s = String(v || "").trim().replace(/^#/, "").toLowerCase(); return /^[0-9a-f]{6}$/.test(s) ? s : ""; };
  const isImage = (v, max) => typeof v === "string" && v.length <= max &&
    (/^https:\/\/[^\s"'<>()]+$/.test(v) || /^data:image\/(png|jpeg|webp|gif);base64,[A-Za-z0-9+/=]+$/.test(v));
  const httpsUrl = (v) => (/^https:\/\/[^\s"'<>]+$/.test(v || "") ? str(v, 500) : "");

  /** Keeps only known fields, trimmed to size. Never throws. */
  function normalizePackage(p) {
    p = p && typeof p === "object" ? p : {};
    const kind = KINDS.includes(p.kind) ? p.kind : "theme";
    const out = {
      format: 1,
      kind,
      name: line(p.name, 60),
      description: text(p.description, 500).trim(),
      version: parseVersion(p.version) ? String(p.version).trim() : "",
      license: Object.prototype.hasOwnProperty.call(LICENSES, p.license) ? p.license : "",
      tags: (Array.isArray(p.tags) ? p.tags : []).map((t) => line(t, 24).toLowerCase()).filter(Boolean).filter((t, i, a) => a.indexOf(t) === i).slice(0, 5),
      platforms: (Array.isArray(p.platforms) ? p.platforms : PLATFORMS).filter((x) => PLATFORMS.includes(x)),
      preview: isImage(p.preview, LIMITS.preview) ? p.preview : "",
      author: line(p.author, 40),
    };
    if (!out.platforms.length) out.platforms = PLATFORMS.slice();
    if (p.basedOn && typeof p.basedOn === "object" && line(p.basedOn.name, 80)) {
      out.basedOn = { name: line(p.basedOn.name, 80), author: line(p.basedOn.author, 60), url: httpsUrl(p.basedOn.url), license: line(p.basedOn.license, 40) };
    }
    if (kind === "theme") {
      const schemes = {};
      const src = p.schemes && typeof p.schemes === "object" ? p.schemes : {};
      for (const name of Object.keys(src).slice(0, LIMITS.schemes)) {
        const n = line(name, 40);
        if (!n || !src[name] || typeof src[name] !== "object") continue;
        const sc = {};
        for (const [k, v] of Object.entries(src[name])) { const key = String(k).toLowerCase(); if (/^[a-z][a-z0-9-]{0,39}$/.test(key) && hex(v)) sc[key] = hex(v); }
        if (Object.keys(sc).length) schemes[n] = sc;
      }
      out.css = text(p.css, LIMITS.css);
      out.schemes = schemes;
    } else if (kind === "extension") {
      out.code = text(p.code, LIMITS.code);
      out.permissions = (Array.isArray(p.permissions) ? p.permissions : []).filter((x) => PERMISSIONS[x]).filter((x, i, a) => a.indexOf(x) === i);
      out.dependencies = (Array.isArray(p.dependencies) ? p.dependencies : []).map((d) => line(d, 80)).filter(Boolean).slice(0, 10);
      out.readme = text(p.readme, LIMITS.readme);
      out.icon = isImage(p.icon, LIMITS.icon) ? p.icon : "";
    } else {
      out.css = text(p.css, LIMITS.snippet);
    }
    return out;
  }

  // ---------- what extension code actually uses
  const USES = {
    playback: /\b(Player\s*\.\s*(play|pause|togglePlay|next|back|seek|seekTo|skipForward|skipBack|playUri|setShuffle|toggleShuffle|setRepeat|toggleRepeat|setVolume|increaseVolume|decreaseVolume|toggleMute|setMute|setHeart|toggleHeart)\b|PlayerAPI|PlaybackAPI|addToQueue|removeFromQueue)/,
    library: /\b(LibraryAPI|PlaylistAPI|RootlistAPI|CollectionAPI|EnhanceAPI|LocalFilesAPI|ShowAPI)\b|CosmosAsync\s*\.\s*(post|put|del|patch)\b|\/v1\/(me\/(tracks|albums|playlists|shows|episodes|following)|playlists\/)/,
    account: /\b(UserAPI|getUser|Session\s*\.\s*(accessToken|user)|ProfileAPI)\b|\/v1\/me\b|sp:\/\/oauth|accessToken/,
    interface: /\b(Topbar|Playbar|ContextMenu|Menu\s*\.|PopupModal|Panel|ReactComponent|createElement|appendChild|insertAdjacent|\.append\(|\.prepend\(|innerHTML)\b/,
    storage: /\b(localStorage|LocalStorage|sessionStorage|indexedDB)\b/,
  };
  // Things a reviewer should look at closely. None of them block a submission alone.
  const RISKS = [
    [/\beval\s*\(|\bnew\s+Function\s*\(|setTimeout\s*\(\s*["'`]/, "Runs code from text (eval or new Function)."],
    [/createElement\s*\(\s*["'`]script["'`]|\bimport\s*\(\s*["'`]?https?:|importScripts/, "Loads more code from the internet."],
    [/document\s*\.\s*cookie/, "Reads cookies."],
    [/\b(window|globalThis|self|top|parent)\s*(\.\s*|\[\s*["'`])(fetch|XMLHttpRequest|WebSocket|Spicetify|localStorage)\b/, "Reaches for globals directly, which gets around Spectra's permission checks."],
    [/__spectra|spectra-bridge|spectra-runtime/, "Touches Spectra's own internals."],
    [/\b(chrome|browser)\s*\.\s*(runtime|storage|tabs)\b/, "Uses browser-extension APIs."],
    [/coinhive|cryptonight|webminer|miner\.start/i, "Looks like a crypto miner."],
    [/\batob\s*\(\s*["'`][A-Za-z0-9+/=]{400,}/, "Contains a large encoded blob."],
  ];

  function detectPermissions(code) {
    const src = String(code || "").replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`\\])\/\/[^\n]*/g, "$1");
    const used = Object.keys(USES).filter((k) => USES[k].test(src));
    // Spotify itself is always reachable; anything else needs "Connect to other sites".
    const external = (src.match(/https?:\/\/[a-z0-9.-]+/gi) || []).map((u) => u.replace(/^https?:\/\//i, ""))
      .filter((host) => !/(^|\.)(spotify\.com|scdn\.co|spotifycdn\.com)$/i.test(host));
    if (/\b(WebSocket|EventSource|sendBeacon)\b/.test(src) || (/\b(fetch|XMLHttpRequest)\b/.test(src) && external.length)) used.push("network");
    const order = Object.keys(PERMISSIONS);
    used.sort((a, b) => order.indexOf(a) - order.indexOf(b));
    const risks = RISKS.filter(([re]) => re.test(src)).map(([, msg]) => msg);
    const longest = src.split("\n").reduce((m, l) => Math.max(m, l.length), 0);
    if (longest > 20000) risks.push("Has very long lines (minified or obfuscated code is hard to review; include the readable source).");
    return { used, risks };
  }

  // ---------- checks
  /**
   * @param pkg   a package (normalized or not)
   * @param opts  { previousVersion }  the version already in the store, for updates
   * @returns { ok, errors: [msg], warnings: [msg], notes: [msg], detected: [perm] }
   */
  function validate(pkg, opts) {
    const raw = pkg && typeof pkg === "object" ? pkg : {};
    const p = normalizePackage(raw);
    const errors = [], warnings = [], notes = [];
    if (!KINDS.includes(raw.kind)) errors.push("Pick what this is: a theme, an extension or a snippet.");
    if (p.name.length < 2) errors.push("Give it a name (2 to 60 characters).");
    if (p.description.length < 10) errors.push("Add a short description (at least 10 characters) so people know what it does.");
    if (!p.version) errors.push("Use a version like 1.0.0 (three numbers separated by dots).");
    else if (opts && opts.previousVersion && compareVersions(p.version, opts.previousVersion) <= 0) errors.push(`The version must be higher than ${opts.previousVersion}, the one already in the store.`);
    if (!p.license) errors.push("Choose a license, so people know what they're allowed to do with it.");
    if (raw.preview && !p.preview) errors.push("The preview must be an https:// image link or a PNG, JPEG, WebP or GIF under 300 KB.");
    if (!p.preview && p.kind === "theme") warnings.push("Themes without a preview image get far fewer installs. Add a screenshot.");
    if (p.basedOn && p.license !== "All-rights-reserved") notes.push(`Based on ${p.basedOn.name}${p.basedOn.author ? ` by ${p.basedOn.author}` : ""}. Make sure its license lets you share changed versions.`);
    if (p.basedOn && p.license === "All-rights-reserved") warnings.push("This is based on someone else's work but is marked all rights reserved. Use a license compatible with the original.");

    const cssChecks = (css, what) => {
      const bare = css.replace(/\/\*[\s\S]*?\*\//g, "");
      if (/url\(\s*["']?\s*http:/i.test(bare) || /@import\s+["']http:/i.test(bare)) errors.push(`${what} loads something over plain http://. Use https:// links.`);
      if (/javascript:|expression\s*\(|-moz-binding|behavior\s*:/i.test(bare)) errors.push(`${what} contains script-like CSS (javascript:, expression() or bindings), which isn't allowed.`);
      const open = (bare.match(/{/g) || []).length, close = (bare.match(/}/g) || []).length;
      if (open !== close) errors.push(`${what} has ${open > close ? `${open - close} unclosed {` : `${close - open} extra }`}.`);
      const remote = new Set((bare.match(/url\(\s*["']?https:\/\/[^/"')]+/gi) || []).map((u) => u.replace(/^url\(\s*["']?https:\/\//i, "")));
      if (remote.size) notes.push(`Loads files from ${[...remote].slice(0, 4).join(", ")}${remote.size > 4 ? ` and ${remote.size - 4} more` : ""}.`);
    };

    let detected = [];
    if (p.kind === "theme") {
      if (!p.css.trim() && !Object.keys(p.schemes).length) errors.push("A theme needs CSS, a colour scheme, or both.");
      if (raw.css && String(raw.css).length > LIMITS.css) errors.push("The CSS is over 400 KB.");
      if (p.css.trim()) cssChecks(p.css, "The CSS");
      for (const [n, sc] of Object.entries(p.schemes)) {
        const missing = ["text", "main", "button"].filter((k) => !sc[k]);
        if (missing.length) warnings.push(`Scheme “${n}” has no ${missing.join(", ")} colour, so Spotify's default is used.`);
      }
    } else if (p.kind === "extension") {
      if (p.code.trim().length < 20) errors.push("An extension needs its JavaScript code.");
      if (raw.code && String(raw.code).length > LIMITS.code) errors.push("The code is over 400 KB.");
      const d = detectPermissions(p.code);
      detected = d.used;
      const missing = d.used.filter((x) => !p.permissions.includes(x));
      if (missing.length) errors.push(`The code uses things it doesn't ask permission for: ${missing.map((x) => PERMISSIONS[x].label.replace(/^./, (ch) => ch.toLowerCase())).join(", ")}. Add ${missing.length > 1 ? "those permissions" : "that permission"} or remove the code.`);
      const unused = p.permissions.filter((x) => !d.used.includes(x));
      if (unused.length) notes.push(`Asks for ${unused.map((x) => PERMISSIONS[x].label.replace(/^./, (ch) => ch.toLowerCase())).join(", ")} but the code doesn't seem to use ${unused.length > 1 ? "them" : "it"}. Only ask for what it needs.`);
      for (const r of d.risks) warnings.push(r);
      if (!p.readme.trim()) warnings.push("Add a README: what it does, how to use it, and anything it sends elsewhere.");
      try { new Function(p.code); } catch (e) { if (e instanceof SyntaxError && !/import|export|await/.test(String(e.message))) errors.push(`The code doesn't parse: ${e.message}`); }
    } else {
      if (!p.css.trim()) errors.push("A snippet needs some CSS.");
      if (raw.css && String(raw.css).length > LIMITS.snippet) errors.push("Snippets are limited to 50 KB of CSS. Make it a theme instead.");
      if (p.css.trim()) cssChecks(p.css, "The CSS");
    }
    const size = JSON.stringify(p).length;
    if (size > LIMITS.total) errors.push(`The whole package is ${(size / 1024).toFixed(0)} KB; the limit is ${(LIMITS.total / 1024).toFixed(0)} KB. Use an https:// link for big images.`);
    return { ok: !errors.length, errors, warnings, notes, detected, package: p };
  }

  const api = { KINDS, PLATFORMS, LICENSES, PERMISSIONS, LIMITS, COLOR_KEYS, parseVersion, compareVersions, bumpVersion, normalizePackage, detectPermissions, validate };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.SpectraPackage = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
