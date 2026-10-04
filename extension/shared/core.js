/*
 * Spectra shared core.
 * Pure functions used by the dashboard, popup and background script.
 * Loaded as a classic script; exposes globalThis.SpectraCore.
 */
(function (root) {
  "use strict";

  // Spectra's update server (website/ on Vercel). Kept in sync from spectra.config.json by build.mjs.
  const API_BASE = "https://usespectra.xyz";
  const REMOTE_TTL = 5 * 60 * 1000;

  // Spicetify's base palette (utils.BaseColorList). Missing scheme keys fall back to these.
  const BASE_COLORS = {
    "text": "ffffff",
    "subtext": "b3b3b3",
    "main": "121212",
    "main-elevated": "242424",
    "highlight": "1a1a1a",
    "highlight-elevated": "2a2a2a",
    "sidebar": "000000",
    "player": "181818",
    "card": "282828",
    "shadow": "000000",
    "selected-row": "ffffff",
    "button": "1db954",
    "button-active": "1ed760",
    "button-disabled": "535353",
    "tab-active": "333333",
    "notification": "4687d6",
    "notification-error": "e22134",
    "misc": "7f7f7f",
  };
  const COLOR_ORDER = Object.keys(BASE_COLORS);

  const DEFAULT_STATE = {
    version: 1,
    enabled: true,
    theme: null,          // installed theme object (see installTheme in dashboard)
    scheme: null,         // selected colour-scheme name within theme
    colorOverrides: {},   // { key: "rrggbb" } user tweaks on top of scheme
    snippets: [],         // [{ id, title, code, enabled, source }]
    extensions: [],       // [{ id, name, code, enabled, source, description }]
    customCSS: "",
    options: {
      recolorSpotify: true,   // rewrite Spotify's own CSS colours into --spice-* vars (what Spicetify does at install time)
      classCompat: true,      // map Spicetify's readable class names onto Spotify's hashed ones
      shim: true,             // provide window.Spicetify for extensions
      topbarButton: true,     // in-page Spectra button
      githubToken: "",        // optional, raises GitHub API rate limit for the marketplace
      updateServer: "",       // override for API_BASE (blank = default)
    },
    // Only used by the Spectra desktop app.
    app: {
      autoLaunch: true,       // start Spotify (with Spectra attached) when the app opens
      alwaysWithSpectra: true, // hook Spotify's shortcuts/login/link launchers so it always opens with Spectra
      startWithWindows: true, // run Spectra quietly in the tray at login
      discordPresence: true,  // show "Using Spectra" on the user's Discord profile
      closeToTray: true,      // keep running in the tray so Spotify stays themed
      spotifyPath: "",        // empty = auto-detect
      debugPort: 9333,
    },
  };

  function clone(v) {
    return JSON.parse(JSON.stringify(v));
  }

  /** Deep-merge saved state onto defaults so new keys appear after upgrades. */
  function normalizeState(saved) {
    const out = clone(DEFAULT_STATE);
    if (!saved || typeof saved !== "object") return out;
    for (const k of Object.keys(out)) {
      if (!(k in saved)) continue;
      const def = out[k];
      const val = saved[k];
      if (def && typeof def === "object" && !Array.isArray(def) && val && typeof val === "object" && !Array.isArray(val)) {
        out[k] = Object.assign(def, val);
      } else {
        out[k] = val;
      }
    }
    if (!Array.isArray(out.snippets)) out.snippets = [];
    if (!Array.isArray(out.extensions)) out.extensions = [];
    return out;
  }

  // ---------- colours ----------

  function normalizeHex(raw) {
    if (raw == null) return null;
    let s = String(raw).trim();
    // Strip inline comments ("ffffff ; comment")
    s = s.split(/[;#\s]/).filter(Boolean)[0] || s.trim();
    s = s.replace(/^#/, "");
    // rgb form: "255,255,255"
    const rgb = s.match(/^(\d{1,3}),\s*(\d{1,3}),\s*(\d{1,3})$/);
    if (rgb) {
      return rgb.slice(1, 4).map((n) => Math.min(255, +n).toString(16).padStart(2, "0")).join("");
    }
    if (/^[0-9a-f]{3}$/i.test(s)) s = s.split("").map((c) => c + c).join("");
    if (/^[0-9a-f]{8}$/i.test(s)) s = s.slice(0, 6);
    if (!/^[0-9a-f]{6}$/i.test(s)) return null;
    return s.toLowerCase();
  }

  function hexToRgb(hex) {
    const n = parseInt(hex, 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }

  /**
   * Parse a Spicetify color.ini into { schemeName: { key: "rrggbb" } }.
   * Tolerates comments, CRLF, blank sections, "key = value ; comment", "#" prefixes.
   */
  function parseColorIni(text) {
    const schemes = {};
    let current = null;
    for (const rawLine of String(text || "").split(/\r?\n/)) {
      const line = rawLine.replace(/^﻿/, "").trim();
      if (!line || line.startsWith(";") || line.startsWith("//")) continue;
      const sec = line.match(/^\[([^\]]+)\]/);
      if (sec) {
        current = sec[1].trim();
        schemes[current] = schemes[current] || {};
        continue;
      }
      if (!current) continue;
      const kv = line.match(/^([\w-]+)\s*=\s*(.+)$/);
      if (!kv) continue;
      const hex = normalizeHex(kv[2]);
      if (hex) schemes[current][kv[1].trim().toLowerCase()] = hex;
    }
    for (const k of Object.keys(schemes)) if (!Object.keys(schemes[k]).length) delete schemes[k];
    return schemes;
  }

  function resolvePalette(state) {
    const palette = Object.assign({}, BASE_COLORS);
    const theme = state.theme;
    if (theme && theme.schemes) {
      const names = Object.keys(theme.schemes);
      const name = state.scheme && theme.schemes[state.scheme] ? state.scheme : names[0];
      if (name) Object.assign(palette, theme.schemes[name]);
    }
    for (const [k, v] of Object.entries(state.colorOverrides || {})) {
      const hex = normalizeHex(v);
      if (hex) palette[k] = hex;
    }
    return palette;
  }

  function paletteToCSS(palette) {
    const lines = [];
    const keys = COLOR_ORDER.concat(Object.keys(palette).filter((k) => !COLOR_ORDER.includes(k)));
    for (const k of keys) {
      const hex = normalizeHex(palette[k]);
      if (!hex) continue;
      lines.push(`  --spice-${k}: #${hex};`);
      lines.push(`  --spice-rgb-${k}: ${hexToRgb(hex).join(",")};`);
    }
    return `:root {\n${lines.join("\n")}\n}\n`;
  }

  function hasCustomColors(state) {
    return !!((state.theme && state.theme.schemes && Object.keys(state.theme.schemes).length) ||
      Object.keys(state.colorOverrides || {}).length);
  }

  /**
   * Compile stored state into the payload the in-page runtime consumes.
   * The runtime is identical on the web player and the desktop app.
   */
  /**
   * @param stateIn  stored settings
   * @param remote   config from the update server (or null)
   * @param opts     { platform: "web"|"desktop"|"quest", allowRemoteScripts: boolean }
   */
  function compilePayload(stateIn, remote, opts) {
    const state = normalizeState(stateIn);
    const palette = resolvePalette(state);
    const platform = (opts && opts.platform) || "web";
    const forPlatform = (x) => x && x.enabled !== false && (!Array.isArray(x.platforms) || x.platforms.includes(platform));
    const blocked = new Set(remote && Array.isArray(remote.blockedExtensions) ? remote.blockedExtensions : []);
    const scripts = [];
    if (state.theme && Array.isArray(state.theme.scripts)) {
      for (const s of state.theme.scripts) {
        if (s && s.code) scripts.push({ id: "theme:" + s.name, name: `${state.theme.name} / ${s.name}`, code: s.code });
      }
    }
    for (const ext of state.extensions) {
      if (ext.enabled && ext.code && !blocked.has(ext.id)) scripts.push({ id: ext.id, name: ext.name, code: ext.code });
    }
    if (remote && opts && opts.allowRemoteScripts && Array.isArray(remote.scripts)) {
      for (const r of remote.scripts) if (forPlatform(r) && r.code) scripts.push({ id: "remote:" + r.id, name: r.name || r.id, code: r.code });
    }
    const hotfixCSS = remote && Array.isArray(remote.cssHotfixes)
      ? remote.cssHotfixes.filter(forPlatform).map((h) => `/* hotfix: ${String(h.id).replace(/\*\//g, "")} */\n${h.css}`).join("\n\n")
      : "";
    return {
      v: 1,
      enabled: !!state.enabled,
      recolor: !!state.options.recolorSpotify && hasCustomColors(state),
      classCompat: !!state.options.classCompat,
      shim: !!state.options.shim,
      topbarButton: !!state.options.topbarButton,
      colorsCSS: paletteToCSS(palette),
      themeCSS: state.theme ? state.theme.css || "" : "",
      themeName: state.theme ? state.theme.name : null,
      schemeName: state.theme ? state.scheme : null,
      snippetsCSS: state.snippets.filter((s) => s.enabled).map((s) => `/* ${String(s.title).replace(/\*\//g, "")} */\n${s.code}`).join("\n\n"),
      customCSS: state.customCSS || "",
      hotfixCSS,
      classMapExtra: remote && remote.classMap && typeof remote.classMap === "object" ? remote.classMap : null,
      scripts,
      apiBase: apiBase(state), // for Listen Together
      platform,
    };
  }

  // ---------- GitHub / marketplace helpers ----------

  /** Rewrite relative url(...) and @import in theme CSS so assets resolve from the theme repo. */
  function absolutizeCSS(css, baseUrl) {
    if (!baseUrl) return css;
    const fix = (u) => {
      const t = u.trim().replace(/^['"]|['"]$/g, "");
      if (!t || /^(data:|https?:|\/\/|#|var\()/i.test(t)) return null;
      try { return new URL(t, baseUrl).href; } catch { return null; }
    };
    return String(css)
      .replace(/url\(\s*(['"]?)([^'")]+)\1\s*\)/g, (m, q, u) => {
        const abs = fix(u);
        return abs ? `url("${abs}")` : m;
      })
      .replace(/@import\s+(['"])([^'"]+)\1/g, (m, q, u) => {
        const abs = fix(u);
        return abs ? `@import "${abs}"` : m;
      });
  }

  /** jsDelivr serves correct MIME types (fonts/images) unlike raw.githubusercontent. */
  function cdnBase(owner, repo, branch, dir) {
    const d = dir ? dir.replace(/^\/+|\/+$/g, "") + "/" : "";
    return `https://cdn.jsdelivr.net/gh/${owner}/${repo}@${branch}/${d}`;
  }

  function rawUrl(owner, repo, branch, path) {
    if (/^https?:\/\//i.test(path)) return path;
    return `https://raw.githubusercontent.com/${owner}/${repo}/${branch}/${String(path).replace(/^\.?\/+/, "")}`;
  }

  function uid(prefix) {
    return (prefix || "id") + "-" + Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
  }

  function apiBase(state) {
    const custom = state && state.options && state.options.updateServer;
    return String(custom && /^https:\/\//.test(custom) ? custom : API_BASE).replace(/\/+$/, "");
  }

  root.SpectraCore = {
    API_BASE,
    REMOTE_TTL,
    apiBase,
    BASE_COLORS,
    COLOR_ORDER,
    DEFAULT_STATE,
    normalizeState,
    normalizeHex,
    hexToRgb,
    parseColorIni,
    resolvePalette,
    paletteToCSS,
    compilePayload,
    absolutizeCSS,
    cdnBase,
    rawUrl,
    uid,
    clone,
  };
})(typeof globalThis !== "undefined" ? globalThis : self);
