/*
 * Spectra runtime — runs in the page's MAIN world.
 *
 * Identical on the Spotify web player (injected by the browser extension)
 * and the Spotify desktop app (injected by the Spectra desktop app over CDP).
 *
 * Responsibilities:
 *   1. Theme engine: --spice-* colour vars, live recolouring of Spotify's own CSS
 *      (a runtime port of Spicetify's install-time patching), theme/snippet/custom CSS.
 *   2. Class-name compatibility: Spicetify themes & extensions use readable class
 *      names (".main-nowPlayingBar-container"); Spotify ships hashed ones.
 *   3. window.Spicetify compatibility API so Spicetify extensions run unmodified.
 *   4. Extension loader with per-extension error isolation.
 */
(function () {
  "use strict";
  if (window.__spectra) return;

  const VERSION = "1.0.0";
  const LOG = "%c[Spectra]";
  const LOG_STYLE = "color:#a78bfa;font-weight:bold";
  const log = (...a) => console.log(LOG, LOG_STYLE, ...a);
  const warn = (...a) => console.warn(LOG, LOG_STYLE, ...a);

  const isDesktop = !/^https:\/\/open\.spotify\.com/.test(location.href);

  const state = {
    payload: null,
    cssMap: null,           // hashed -> readable
    reverseMap: null,       // readable -> [hashed]
    scriptsLoaded: false,
    loadedScriptIds: [],
    react: null,
    reactDOM: null,
    jsx: null,
    platform: null,
  };

  // ------------------------------------------------------------------
  // Spotify request credentials
  //
  // Extensions like lyrics plugins call Spotify's internal APIs (spclient,
  // api-partner) through CosmosAsync. On the desktop app the client adds the
  // credentials; on the web we reuse what Spotify's own web player sends:
  // its current access token, client-token and app headers. They are captured
  // from Spotify's own requests to *.spotify.com and only ever sent back there.
  // ------------------------------------------------------------------

  const spotifyAuth = { authorization: null, clientToken: null, appPlatform: null, appVersion: null };
  const originalFetch = window.fetch;

  function headerMap(h) {
    const out = {};
    if (!h) return out;
    try {
      if (Array.isArray(h)) for (const [k, v] of h) out[String(k).toLowerCase()] = String(v);
      else if (typeof h.forEach === "function") h.forEach((v, k) => { out[String(k).toLowerCase()] = String(v); });
      else for (const k of Object.keys(h)) out[k.toLowerCase()] = String(h[k]);
    } catch {}
    return out;
  }

  function noteSpotifyRequest(url, h) {
    let host;
    try { host = new URL(url, location.href).hostname; } catch { return; }
    if (!(host === "spotify.com" || host.endsWith(".spotify.com"))) return;
    if (h.authorization && /^Bearer \S+/i.test(h.authorization)) spotifyAuth.authorization = h.authorization;
    if (h["client-token"]) spotifyAuth.clientToken = h["client-token"];
    if (h["app-platform"]) spotifyAuth.appPlatform = h["app-platform"];
    if (h["spotify-app-version"]) spotifyAuth.appVersion = h["spotify-app-version"];
  }

  if (typeof originalFetch === "function") {
    window.fetch = function (input, init) {
      try {
        const url = typeof input === "string" ? input : input && input.url;
        const h = Object.assign(headerMap(input && typeof input === "object" ? input.headers : null), headerMap(init && init.headers));
        noteSpotifyRequest(url, h);
      } catch {}
      return originalFetch.apply(this, arguments);
    };
  }
  (function () {
    const XHR = window.XMLHttpRequest && window.XMLHttpRequest.prototype;
    if (!XHR) return;
    const open = XHR.open, setHeader = XHR.setRequestHeader;
    XHR.open = function (method, url) { this.__spectraUrl = url; return open.apply(this, arguments); };
    XHR.setRequestHeader = function (k, v) {
      try { noteSpotifyRequest(this.__spectraUrl, { [String(k).toLowerCase()]: String(v) }); } catch {}
      return setHeader.apply(this, arguments);
    };
  })();

  // ------------------------------------------------------------------
  // Utilities
  // ------------------------------------------------------------------

  function onReady(fn) {
    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", fn, { once: true });
    else fn();
  }

  // Observing `document` (not documentElement) works even before <html> exists,
  // which is the case for CDP's addScriptToEvaluateOnNewDocument on desktop.
  function whenRoot(fn) {
    if (document.documentElement) return fn();
    const mo = new MutationObserver(() => {
      if (document.documentElement) { mo.disconnect(); fn(); }
    });
    mo.observe(document, { childList: true });
  }
  function whenHead(fn) {
    if (document.head) return fn();
    const mo = new MutationObserver(() => {
      if (document.head) { mo.disconnect(); fn(); }
    });
    mo.observe(document, { childList: true, subtree: true });
  }

  function debounce(fn, ms) {
    let t;
    return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
  }

  /** One shared, rAF-throttled body observer instead of one per feature. */
  const domWatchers = new Set();
  let domScheduled = false;
  function watchDOM(fn) {
    domWatchers.add(fn);
    ensureDomObserver();
    fn();
    return () => domWatchers.delete(fn);
  }
  let domObserver = null;
  function ensureDomObserver() {
    if (domObserver || !document.body) {
      if (!document.body) onReady(ensureDomObserver);
      return;
    }
    domObserver = new MutationObserver(() => {
      if (domScheduled) return;
      domScheduled = true;
      requestAnimationFrame(() => {
        domScheduled = false;
        for (const fn of domWatchers) {
          try { fn(); } catch (e) { warn("watcher failed", e); }
        }
      });
    });
    domObserver.observe(document.body, { childList: true, subtree: true });
  }

  function el(tag, attrs, ...children) {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v == null || v === false) continue;
      if (k === "class") n.className = v;
      else if (k === "html") n.innerHTML = v;
      else if (k.startsWith("on") && typeof v === "function") n.addEventListener(k.slice(2), v);
      else n.setAttribute(k, v === true ? "" : v);
    }
    for (const c of children.flat()) if (c != null) n.append(c instanceof Node ? c : String(c));
    return n;
  }

  // ------------------------------------------------------------------
  // 1. Style manager
  //
  // Theme/snippet/custom CSS goes into constructable stylesheets
  // (document.adoptedStyleSheets). These always cascade AFTER every
  // <link>/<style> in the document, so Spotify's lazily-loaded chunk CSS
  // can never override the theme — a long-standing Spicetify annoyance.
  // @import rules are not allowed in constructable sheets, so they are
  // hoisted into a small <style> element instead.
  // ------------------------------------------------------------------

  const sheets = {};
  // "hotfix" (from the update server) sits after the theme so it can fix it, before the user's own CSS.
  const SHEET_ORDER = ["colors", "theme", "hotfix", "snippets", "custom", "ui"];
  const supportsAdopted = "adoptedStyleSheets" in Document.prototype && "replaceSync" in CSSStyleSheet.prototype;
  let importStyleEl = null;
  const importsBySlot = {};

  function splitImports(css) {
    const imports = [];
    const rest = String(css || "").replace(/@import\s+(?:url\()?\s*['"]?[^'");]+['"]?\s*\)?[^;]*;/g, (m) => {
      imports.push(m);
      return "";
    });
    return { imports, rest };
  }

  function setSheet(slot, css) {
    const { imports, rest } = splitImports(css);
    importsBySlot[slot] = imports;
    whenHead(() => {
      const allImports = SHEET_ORDER.flatMap((s) => importsBySlot[s] || []).join("\n");
      if (allImports) {
        if (!importStyleEl) {
          importStyleEl = document.createElement("style");
          importStyleEl.id = "spectra-imports";
        }
        if (importStyleEl.textContent !== allImports) importStyleEl.textContent = allImports;
        if (!importStyleEl.isConnected) document.head.prepend(importStyleEl);
      } else if (importStyleEl) {
        importStyleEl.remove();
      }

      if (supportsAdopted) {
        let sheet = sheets[slot];
        if (!sheet) sheet = sheets[slot] = new CSSStyleSheet();
        try {
          sheet.replaceSync(rest);
        } catch (e) {
          warn(`could not parse ${slot} CSS`, e);
        }
        syncAdopted();
      } else {
        let s = document.getElementById("spectra-" + slot);
        if (!s) {
          s = document.createElement("style");
          s.id = "spectra-" + slot;
          document.head.append(s);
        }
        s.textContent = rest;
      }
    });
  }

  function syncAdopted() {
    const ours = new Set(Object.values(sheets));
    const foreign = document.adoptedStyleSheets.filter((s) => !ours.has(s));
    const mine = SHEET_ORDER.map((k) => sheets[k]).filter(Boolean);
    document.adoptedStyleSheets = [...foreign, ...mine];
  }

  // ------------------------------------------------------------------
  // 2. Recolouring Spotify's CSS (port of spicetify-cli colorVariableReplace)
  //
  // Fixes two upstream bugs:
  //   * `white;` was replaced including the semicolon, gluing declarations
  //     together in minified CSS.
  //   * rgba(18,18,18,a) became rgba(var(--spice-main),a) — invalid, since
  //     --spice-main is a hex value. We use the --spice-rgb-* variants.
  // ------------------------------------------------------------------

  const COLOR_PATCHES = [
    [/#(181818|212121)\b/gi, "var(--spice-player)"],
    [/#282828\b/gi, "var(--spice-card)"],
    [/#(242424|1f1f1f)\b/gi, "var(--spice-main-elevated)"],
    [/#121212\b/gi, "var(--spice-main)"],
    [/#1a1a1a\b/gi, "var(--spice-highlight)"],
    [/#2a2a2a\b/gi, "var(--spice-highlight-elevated)"],
    [/#(000|000000)\b/gi, "var(--spice-sidebar)"],
    [/#ffffff([0-9a-f]{2})\b/gi, (m, a) => `rgba(var(--spice-rgb-text),${+(parseInt(a, 16) / 255).toFixed(3)})`],
    [/#fff([0-9a-f])\b/gi, (m, a) => `rgba(var(--spice-rgb-text),${+(parseInt(a, 16) / 15).toFixed(3)})`],
    [/#(fff|ffffff|f8f8f8)\b/gi, "var(--spice-text)"],
    [/:white(?=[;}!\s])/gi, ":var(--spice-text)"],
    [/#(b3b3b3|a7a7a7)\b/gi, "var(--spice-subtext)"],
    [/#(1db954|1877f2)\b/gi, "var(--spice-button)"],
    [/#(1ed760|1fdf64|169c46)\b/gi, "var(--spice-button-active)"],
    [/#535353\b/gi, "var(--spice-button-disabled)"],
    [/#(333|333333)\b/gi, "var(--spice-tab-active)"],
    [/#7f7f7f\b/gi, "var(--spice-misc)"],
    [/#(4687d6|2e77d0)\b/gi, "var(--spice-notification)"],
    [/#(e22134|cd1a2b)\b/gi, "var(--spice-notification-error)"],
    [/rgba\(\s*255\s*,\s*255\s*,\s*255\s*,/gi, "rgba(var(--spice-rgb-text),"],
    [/rgba\(18,18,18,([\d.]+)\)/g, "rgba(var(--spice-rgb-main),$1)"],
    [/rgba\(40,40,40,([\d.]+)\)/g, "rgba(var(--spice-rgb-card),$1)"],
    [/rgba\(0,0,0,([\d.]+)\)/g, "rgba(var(--spice-rgb-shadow),$1)"],
    [/hsla\(0,0%,100%,\.9\)/g, "rgba(var(--spice-rgb-text),.9)"],
    [/hsla\(0,0%,100%,([\d.]+)\)/g, "rgba(var(--spice-rgb-selected-row),$1)"],
  ];

  function recolorCSS(css, baseHref) {
    let out = css;
    for (const [re, rep] of COLOR_PATCHES) out = out.replace(re, rep);
    // Relative url()s must keep resolving against the original stylesheet location.
    return out.replace(/url\(\s*(['"]?)([^'")]+)\1\s*\)/g, (m, q, u) => {
      if (/^(data:|https?:|\/\/|#)/i.test(u)) return m;
      try { return `url("${new URL(u, baseHref).href}")`; } catch { return m; }
    });
  }

  const recolorCache = new Map();   // href -> Promise<string>
  const recolored = new Map();      // link element -> style element
  let recolorActive = false;
  let headObserver = null;

  function isSpotifyStylesheet(link) {
    if (!link.href || link.dataset.spectraSkip != null) return false;
    try {
      const u = new URL(link.href);
      return u.origin === location.origin || /(^|\.)spotifycdn\.com$|(^|\.)scdn\.co$/.test(u.hostname);
    } catch { return false; }
  }

  async function recolorLink(link) {
    if (recolored.has(link) || !isSpotifyStylesheet(link)) return;
    const placeholder = document.createElement("style");
    placeholder.dataset.spectraRecolor = link.href;
    recolored.set(link, placeholder);
    try {
      if (!recolorCache.has(link.href)) {
        recolorCache.set(link.href, fetch(link.href, { cache: "force-cache", credentials: "omit" })
          .then((r) => { if (!r.ok) throw new Error(r.status); return r.text(); })
          .then((css) => recolorCSS(css, link.href)));
      }
      const css = await recolorCache.get(link.href);
      if (!recolorActive || recolored.get(link) !== placeholder) return;
      placeholder.textContent = css;
      link.after(placeholder);
      link.disabled = true;
    } catch (e) {
      recolorCache.delete(link.href);
      recolored.delete(link);
      warn("recolour skipped for", link.href, e);
    }
  }

  function setRecolor(on) {
    if (on === recolorActive) return;
    recolorActive = on;
    whenHead(() => {
      if (on) {
        document.querySelectorAll('link[rel="stylesheet"]').forEach(recolorLink);
        headObserver = new MutationObserver((muts) => {
          for (const m of muts) for (const n of m.addedNodes) {
            if (n.nodeName === "LINK" && n.rel === "stylesheet") {
              if (n.sheet || n.href) recolorLink(n);
            }
          }
        });
        headObserver.observe(document.head, { childList: true });
      } else {
        if (headObserver) headObserver.disconnect();
        headObserver = null;
        for (const [link, style] of recolored) {
          style.remove();
          link.disabled = false;
        }
        recolored.clear();
      }
    });
  }

  // ------------------------------------------------------------------
  // 3. Class-name compatibility
  // ------------------------------------------------------------------

  function setCssMap(map) {
    if (!map || typeof map !== "object" || state.cssMap === map) return;
    state.cssMap = map;
    const rev = {};
    for (const [hashed, readable] of Object.entries(map)) (rev[readable] = rev[readable] || []).push(hashed);
    state.reverseMap = rev;
  }

  const CLASS_RE = /\.(-?[_a-zA-Z][\w-]*)/g;

  /** Rewrite readable selectors so they also match hashed classes, without changing specificity. */
  function mapThemeCSS(css) {
    const rev = state.reverseMap;
    if (!rev || !css) return css || "";
    // Leave url(...) and string contents alone.
    const protectedChunks = [];
    const masked = css.replace(/url\([^)]*\)|"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'/g, (m) => {
      protectedChunks.push(m);
      return `\u0000${protectedChunks.length - 1}\u0000`;
    });
    const mapped = masked.replace(CLASS_RE, (m, name) => {
      const hashes = rev[name];
      if (!hashes) return m;
      return `:is(.${name},${hashes.map((h) => "." + h).join(",")})`;
    });
    return mapped.replace(/\u0000(\d+)\u0000/g, (m, i) => protectedChunks[+i]);
  }

  // Add readable classes to the live DOM so extension querySelector()s work.
  let classObserver = null;
  function tagElement(node) {
    const map = state.cssMap;
    if (!node.classList) return;
    for (const c of node.classList) {
      const r = map[c];
      if (r && !node.classList.contains(r)) node.classList.add(r);
    }
  }
  function tagTree(root) {
    if (root.nodeType !== 1) return;
    tagElement(root);
    const all = root.getElementsByTagName("*");
    for (let i = 0; i < all.length; i++) tagElement(all[i]);
  }
  function setDomClassCompat(on) {
    if (!!classObserver === on || !state.cssMap) return;
    if (!on) { classObserver.disconnect(); classObserver = null; return; }
    onReady(() => {
      tagTree(document.body);
      const pending = new Set();
      let scheduled = false;
      classObserver = new MutationObserver((muts) => {
        for (const m of muts) {
          if (m.type === "attributes") pending.add(m.target);
          else for (const n of m.addedNodes) if (n.nodeType === 1) pending.add(n);
        }
        if (scheduled) return;
        scheduled = true;
        // Microtask, not rAF: tag before paint so extension queries see it immediately.
        queueMicrotask(() => {
          scheduled = false;
          for (const n of pending) n.isConnected && (n === document.body ? tagElement(n) : tagTree(n));
          pending.clear();
        });
      });
      classObserver.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ["class"] });
    });
  }

  // ------------------------------------------------------------------
  // 4. React / webpack discovery
  // ------------------------------------------------------------------

  function getWebpackRequire() {
    const key = Object.getOwnPropertyNames(window).find((k) => /^(webpackChunk|rspackChunk)/.test(k) && Array.isArray(window[k]));
    if (!key) return null;
    let req = null;
    try { window[key].push([[Symbol("spectra")], {}, (r) => { req = r; }]); } catch { return null; }
    return req;
  }

  /** Only inspect already-executed modules (req.c) to avoid running module factories with side effects. */
  function loadedModules(req) {
    const cache = req.c;
    if (cache) return Object.values(cache).map((m) => m && m.exports).filter(Boolean);
    const out = [];
    for (const id of Object.keys(req.m || {})) { try { out.push(req(id)); } catch {} }
    return out;
  }

  // Some Spotify modules export Proxies that throw on unknown property access,
  // so every probe is guarded.
  const safe = (pred) => (m) => { try { return !!pred(m); } catch { return false; } };

  function discoverReact() {
    const req = getWebpackRequire();
    if (!req) return false;
    const mods = loadedModules(req);
    const flat = [];
    for (const m of mods) {
      if (!m || (typeof m !== "object" && typeof m !== "function")) continue;
      flat.push(m);
      try { if (m.default && m.default !== m) flat.push(m.default); } catch {}
    }
    state.react = flat.find(safe((m) => m.createElement && m.useState && m.Component && m.version)) || null;
    state.reactDOM = flat.find(safe((m) => m.createPortal && (m.createRoot || m.render) && m.findDOMNode)) || null;
    state.jsx = flat.find(safe((m) => typeof m.jsx === "function" && typeof m.jsxs === "function" && m.Fragment)) || null;
    state.webpackRequire = req;
    state.graphqlDefs = {};
    const isDef = safe((v) => v && typeof v === "object" && v.operation && v.name && v.sha256Hash);
    for (const m of mods) {
      let vals;
      try { vals = m && typeof m === "object" ? Object.values(m) : []; } catch { continue; }
      for (const v of vals) if (isDef(v)) state.graphqlDefs[v.name] = v;
    }
    return !!state.react;
  }

  /** Walk the React fiber tree to find Spotify's Platform object (only present when signed in). */
  function discoverPlatform() {
    const roots = [document.getElementById("main"), document.querySelector(".Root"), document.body].filter(Boolean);
    let start = null;
    for (const r of roots) {
      for (const node of [r, ...r.children]) {
        const k = Object.keys(node).find((k) => k.startsWith("__reactContainer$") || k.startsWith("__reactFiber$"));
        if (k) { start = node[k]; break; }
      }
      if (start) break;
    }
    if (!start) return null;
    // Older builds: platform.getPlayerAPI(). Newer builds: platform.getRegistry().resolve(Symbol("PlayerAPI")).
    const isPlatform = (v) => v && typeof v === "object" &&
      (typeof v.getPlayerAPI === "function" || (typeof v.getRegistry === "function" && typeof v.getHistory === "function"));
    const stack = [start];
    let visited = 0;
    while (stack.length && visited < 60000) {
      const f = stack.pop();
      visited++;
      try {
        const p = f.memoizedProps;
        if (p && typeof p === "object") {
          if (isPlatform(p.platform)) return p.platform;
          if (p.value && typeof p.value === "object") {
            if (isPlatform(p.value)) return p.value;
            if (isPlatform(p.value.platform)) return p.value.platform;
          }
        }
      } catch {}
      if (f.sibling) stack.push(f.sibling);
      if (f.child) stack.push(f.child);
    }
    return null;
  }

  function buildPlatform(raw) {
    const P = { _raw: raw };
    const keys = new Set();
    for (let o = raw; o && o !== Object.prototype; o = Object.getPrototypeOf(o)) {
      Object.getOwnPropertyNames(o).forEach((k) => keys.add(k));
    }
    for (const k of keys) {
      if (!/^get[A-Z]/.test(k) || typeof raw[k] !== "function") continue;
      try { P[k.slice(3)] = raw[k](); } catch {}
    }
    // Registry-based builds: expose every registered service (PlayerAPI, PlaybackAPI, LibraryAPI…)
    // as a lazy property, resolved only when an extension first touches it.
    const reg = P.Registry;
    const map = reg && (reg._map instanceof Map ? reg._map : Object.values(reg).find((v) => v instanceof Map));
    if (map) {
      for (const sym of map.keys()) {
        const name = typeof sym === "symbol" ? sym.description : String(sym);
        if (!name || name in P) continue;
        let cached, done = false;
        Object.defineProperty(P, name, {
          configurable: true,
          enumerable: true,
          get() {
            if (!done) {
              done = true;
              try { cached = (reg.resolveNoThrow || reg.resolve).call(reg, sym); } catch { cached = undefined; }
            }
            return cached;
          },
        });
      }
    }
    return P;
  }

  // ------------------------------------------------------------------
  // 5. In-page UI (toasts, modal, menu) — themed with --spice-* vars
  // ------------------------------------------------------------------

  const UI_CSS = `
  #spectra-toasts{position:fixed;left:50%;bottom:110px;transform:translateX(-50%);z-index:2147483000;display:flex;flex-direction:column;gap:8px;align-items:center;pointer-events:none}
  .spectra-toast{pointer-events:auto;font:500 14px/1.4 var(--encore-body-font-stack,system-ui,sans-serif);color:#fff;background:var(--spice-notification,#4687d6);padding:10px 16px;border-radius:8px;box-shadow:0 8px 24px rgba(0,0,0,.45);max-width:min(560px,90vw);display:flex;gap:12px;align-items:center;animation:spectra-in .18s ease-out}
  .spectra-toast.error{background:var(--spice-notification-error,#e22134)}
  .spectra-toast button{all:unset;cursor:pointer;font-weight:700;padding:4px 10px;border-radius:999px;background:rgba(255,255,255,.18)}
  .spectra-toast button:hover{background:rgba(255,255,255,.28)}
  @keyframes spectra-in{from{opacity:0;transform:translateY(6px)}}
  #spectra-modal{position:fixed;inset:0;z-index:2147482000;background:rgba(0,0,0,.6);display:grid;place-items:center;animation:spectra-in .15s ease-out}
  #spectra-modal .spectra-modal-box{background:var(--spice-main-elevated,#242424);color:var(--spice-text,#fff);border-radius:12px;width:min(520px,92vw);max-height:85vh;display:flex;flex-direction:column;box-shadow:0 16px 48px rgba(0,0,0,.6);font-family:var(--encore-body-font-stack,system-ui,sans-serif)}
  #spectra-modal.large .spectra-modal-box{width:min(960px,94vw)}
  #spectra-modal header{display:flex;align-items:center;justify-content:space-between;padding:20px 24px 8px;font-size:20px;font-weight:700}
  #spectra-modal header button{all:unset;cursor:pointer;width:32px;height:32px;display:grid;place-items:center;border-radius:50%;color:var(--spice-subtext,#b3b3b3)}
  #spectra-modal header button:hover{background:rgba(var(--spice-rgb-text,255,255,255),.1);color:var(--spice-text,#fff)}
  #spectra-modal .spectra-modal-body{padding:8px 24px 24px;overflow:auto}
  .spectra-topbar{display:flex;gap:4px;align-items:center;margin-inline:8px;-webkit-app-region:no-drag;flex:none!important;pointer-events:auto!important}
  .spectra-topbar .spectra-btn:not([disabled]),.spectra-playbar .spectra-btn:not([disabled]){pointer-events:auto!important}
  .spectra-topbar .spectra-btn{flex:none!important;width:32px!important;min-width:32px!important;height:32px!important;padding:0!important;margin:0!important}
  .spectra-topbar.floating{position:fixed!important;top:12px!important;right:220px!important;left:auto!important;bottom:auto!important;z-index:2147481000!important;display:flex!important;visibility:visible!important;opacity:1!important;transform:none!important;margin:0!important}
  .spectra-topbar.floating .spectra-btn{display:grid!important;visibility:visible!important;opacity:1!important;background:rgba(0,0,0,.55)!important}
  .spectra-btn{all:unset;box-sizing:border-box;cursor:pointer;width:32px;height:32px;display:grid;place-items:center;border-radius:50%;color:var(--spice-subtext,#b3b3b3);background:rgba(0,0,0,.35);transition:transform .1s,color .1s}
  .spectra-btn:hover{color:var(--spice-text,#fff);transform:scale(1.06)}
  .spectra-btn.active{color:var(--spice-button,#1db954)}
  .spectra-btn[disabled]{opacity:.4;pointer-events:none}
  .spectra-btn svg{width:16px;height:16px;fill:currentColor}
  .spectra-playbar{display:inline-flex;gap:2px;align-items:center}
  .spectra-playbar .spectra-btn{background:transparent}
  #spectra-menu{position:fixed;z-index:2147482500;min-width:220px;max-width:320px;background:var(--spice-main-elevated,#282828);color:var(--spice-text,#fff);border-radius:6px;padding:4px;box-shadow:0 16px 24px rgba(0,0,0,.3),0 6px 8px rgba(0,0,0,.2);font:400 14px/1 var(--encore-body-font-stack,system-ui,sans-serif)}
  #spectra-menu .item{display:flex;align-items:center;gap:10px;padding:12px 12px;border-radius:3px;cursor:pointer;justify-content:space-between}
  #spectra-menu .item:hover{background:rgba(var(--spice-rgb-text,255,255,255),.1)}
  #spectra-menu .item .check{color:var(--spice-button,#1db954)}
  #spectra-menu .sep{height:1px;background:rgba(var(--spice-rgb-text,255,255,255),.1);margin:4px 0}
  .spectra-lt{display:flex;flex-direction:column;gap:10px;font-size:14px;line-height:1.45}
  .spectra-lt-intro{margin:0;color:var(--spice-subtext,#b3b3b3)}
  .spectra-lt-label{font-size:11px;letter-spacing:.1em;text-transform:uppercase;color:var(--spice-subtext,#b3b3b3);margin-top:4px}
  .spectra-lt-input{all:unset;box-sizing:border-box;width:100%;padding:10px 14px;border-radius:8px;background:rgba(var(--spice-rgb-text,255,255,255),.08);color:var(--spice-text,#fff);font-size:15px}
  .spectra-lt-input:focus{box-shadow:inset 0 0 0 2px var(--spice-button,#1db954)}
  .spectra-lt-input.code{font:700 18px/1 ui-monospace,Consolas,monospace;letter-spacing:.12em;text-transform:uppercase;flex:1}
  .spectra-lt-row{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
  .spectra-lt-row.end{justify-content:flex-end;margin-top:6px}
  .spectra-lt-btn{all:unset;cursor:pointer;padding:10px 18px;border-radius:999px;font-weight:700;background:rgba(var(--spice-rgb-text,255,255,255),.1);color:var(--spice-text,#fff);text-align:center}
  .spectra-lt-btn:hover{background:rgba(var(--spice-rgb-text,255,255,255),.18)}
  .spectra-lt-btn.primary{background:var(--spice-button,#1db954);color:#000;flex:1}
  .spectra-lt-btn.primary:hover{filter:brightness(1.1)}
  .spectra-lt-btn.danger{color:#ff8a8a}
  .spectra-lt-or{text-align:center;color:var(--spice-subtext,#b3b3b3);font-size:12px;margin:4px 0}
  .spectra-lt-code{flex:1;font:800 40px/1 ui-monospace,Consolas,monospace;letter-spacing:.14em;color:var(--spice-text,#fff);user-select:all;padding:6px 0}
  .spectra-lt-np{display:flex;gap:12px;align-items:center;padding:10px;border-radius:10px;background:rgba(var(--spice-rgb-text,255,255,255),.06)}
  .spectra-lt-np.empty{color:var(--spice-subtext,#b3b3b3);justify-content:center;padding:16px}
  .spectra-lt-np img,.spectra-lt-np .art{width:52px;height:52px;border-radius:6px;object-fit:cover;background:rgba(var(--spice-rgb-text,255,255,255),.1);flex:none}
  .spectra-lt-np .sub{color:var(--spice-subtext,#b3b3b3);font-size:13px}
  .spectra-lt-members{display:flex;flex-direction:column;gap:4px}
  .spectra-lt-member{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:6px 10px;border-radius:8px;background:rgba(var(--spice-rgb-text,255,255,255),.05)}
  .spectra-lt-member .who{display:flex;align-items:center;gap:6px;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .spectra-lt-actions{display:flex;gap:6px;flex:none}
  .spectra-lt-badge{font-size:10px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;padding:2px 6px;border-radius:4px;background:rgba(var(--spice-rgb-text,255,255,255),.12)}
  .spectra-lt-badge.host{background:rgba(255,210,63,.22);color:#ffd23f}
  .spectra-lt-badge.dj{background:rgba(var(--spice-rgb-button,29,185,84),.22);color:var(--spice-button,#1db954)}
  .spectra-lt-tabs{display:flex;gap:4px;padding:4px;border-radius:999px;background:rgba(var(--spice-rgb-text,255,255,255),.06);margin-top:4px}
  .spectra-lt-tab{all:unset;cursor:pointer;flex:1;text-align:center;padding:8px 10px;border-radius:999px;font-weight:600;font-size:13px;color:var(--spice-subtext,#b3b3b3)}
  .spectra-lt-tab.on{background:var(--spice-text,#fff);color:var(--spice-main,#121212)}
  .spectra-lt-rooms{display:flex;flex-direction:column;gap:6px;max-height:320px;overflow:auto}
  .spectra-lt-room{display:flex;align-items:center;gap:12px;padding:8px;border-radius:10px;background:rgba(var(--spice-rgb-text,255,255,255),.05)}
  .spectra-lt-room img,.spectra-lt-room .art{width:48px;height:48px;border-radius:6px;object-fit:cover;flex:none;display:grid;place-items:center;background:rgba(var(--spice-rgb-text,255,255,255),.1);font-size:20px}
  .spectra-lt-room .info{flex:1;min-width:0}
  .spectra-lt-room .sub,.spectra-lt .sub{color:var(--spice-subtext,#b3b3b3);font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .spectra-lt-choice{all:unset;cursor:pointer;flex:1;min-width:150px;display:flex;flex-direction:column;gap:2px;padding:10px 12px;border-radius:10px;box-shadow:inset 0 0 0 1.5px rgba(var(--spice-rgb-text,255,255,255),.15)}
  .spectra-lt-choice span{font-size:12px;color:var(--spice-subtext,#b3b3b3)}
  .spectra-lt-choice.on{box-shadow:inset 0 0 0 2px var(--spice-button,#1db954);background:rgba(var(--spice-rgb-button,29,185,84),.08)}
  .spectra-lt-title{font-size:18px;font-weight:800}
  .spectra-lt-hint{margin:0;font-size:12px;color:var(--spice-subtext,#b3b3b3)}
  .spectra-lt-dj{display:flex;flex-direction:column;gap:8px;padding:12px;border-radius:10px;background:rgba(var(--spice-rgb-button,29,185,84),.07)}
  .spectra-lt-row.between{justify-content:space-between}
  .spectra-lt-btn.small{padding:6px 12px;font-size:12px}
  .spectra-lt-btn.accent{background:var(--spice-button,#1db954);color:#000}
  .spectra-lt-status{margin:0;color:#ffcf7a;font-size:13px}
  #spectra-lt-pill{all:unset;position:fixed;left:16px;bottom:104px;z-index:2147480000;cursor:pointer;padding:7px 14px;border-radius:999px;font:600 13px/1.2 var(--encore-body-font-stack,system-ui,sans-serif);color:#fff;background:linear-gradient(135deg,#8b5cf6,#22d3a6);box-shadow:0 6px 20px rgba(0,0,0,.4);pointer-events:auto}
  #spectra-menu .label{padding:10px 12px 6px;font-size:11px;letter-spacing:.1em;text-transform:uppercase;color:var(--spice-subtext,#b3b3b3)}
  `;

  function toastHost() {
    let h = document.getElementById("spectra-toasts");
    if (!h) { h = el("div", { id: "spectra-toasts" }); document.body.append(h); }
    return h;
  }

  function showNotification(message, isError, ms, action) {
    onReady(() => {
      const t = el("div", { class: "spectra-toast" + (isError ? " error" : ""), role: "status", id: action && action.id });
      if (message instanceof Node) t.append(message); else t.append(String(message));
      if (action) t.append(el("button", { onclick: () => { action.onClick(); t.remove(); } }, action.label));
      toastHost().append(t);
      // ms === 0 with an action = sticky until clicked.
      if (!(ms === 0 && action)) setTimeout(() => t.remove(), ms || (action ? 10000 : 3000));
    });
  }

  let modalRoot = null;
  const PopupModal = {
    display({ title, content, isLarge } = {}) {
      PopupModal.hide();
      const body = el("div", { class: "spectra-modal-body" });
      const close = el("button", { "aria-label": "Close", onclick: () => PopupModal.hide(), html: '<svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor"><path d="M2.47 2.47a.75.75 0 0 1 1.06 0L8 6.94l4.47-4.47a.75.75 0 1 1 1.06 1.06L9.06 8l4.47 4.47a.75.75 0 1 1-1.06 1.06L8 9.06l-4.47 4.47a.75.75 0 0 1-1.06-1.06L6.94 8 2.47 3.53a.75.75 0 0 1 0-1.06z"/></svg>' });
      const wrap = el("div", { id: "spectra-modal", class: isLarge ? "large" : "", role: "dialog", "aria-modal": "true" },
        el("div", { class: "spectra-modal-box" }, el("header", {}, el("span", {}, title || ""), close), body));
      wrap.addEventListener("mousedown", (e) => { if (e.target === wrap) PopupModal.hide(); });
      if (content && content.$$typeof && state.reactDOM) {
        const RD = state.reactDOM;
        if (RD.createRoot) { modalRoot = RD.createRoot(body); modalRoot.render(content); }
        else { RD.render(content, body); modalRoot = { unmount: () => RD.unmountComponentAtNode(body) }; }
      } else if (content instanceof Node) body.append(content);
      else body.innerHTML = content == null ? "" : String(content);
      document.body.append(wrap);
      document.addEventListener("keydown", modalEsc, true);
    },
    hide() {
      const m = document.getElementById("spectra-modal");
      if (modalRoot) { try { modalRoot.unmount(); } catch {} modalRoot = null; }
      if (m) m.remove();
      document.removeEventListener("keydown", modalEsc, true);
    },
  };
  function modalEsc(e) { if (e.key === "Escape") { e.stopPropagation(); PopupModal.hide(); } }

  function iconHTML(icon) {
    if (!icon) return "";
    if (typeof icon === "string" && icon.trim().startsWith("<svg")) return icon;
    if (typeof icon === "string" && SVGIcons[icon]) return `<svg viewBox="0 0 16 16">${SVGIcons[icon]}</svg>`;
    if (typeof icon === "string" && /<path|<g|<circle/.test(icon)) return `<svg viewBox="0 0 16 16">${icon}</svg>`;
    return "";
  }

  const SVGIcons = {
    together: '<path d="M8 1.5A6.5 6.5 0 0 0 1.5 8v4.25c0 .97.78 1.75 1.75 1.75h1c.97 0 1.75-.78 1.75-1.75v-2.5C6 8.78 5.22 8 4.25 8H3.02a5 5 0 0 1 9.96 0h-1.23C10.78 8 10 8.78 10 9.75v2.5c0 .97.78 1.75 1.75 1.75h1c.97 0 1.75-.78 1.75-1.75V8A6.5 6.5 0 0 0 8 1.5z"/>',
    spectra: '<path d="M8 1.5a6.5 6.5 0 1 0 0 13 .75.75 0 0 0 .53-1.28 1.5 1.5 0 0 1 1.06-2.56h1.66A3.25 3.25 0 0 0 14.5 7.4 6.08 6.08 0 0 0 8 1.5zM4.25 8.5a1 1 0 1 1 0-2 1 1 0 0 1 0 2zm1.75-3a1 1 0 1 1 0-2 1 1 0 0 1 0 2zm4 0a1 1 0 1 1 0-2 1 1 0 0 1 0 2zm2 3a1 1 0 1 1 0-2 1 1 0 0 1 0 2z"/>',
    play: '<path d="M3 1.713a.7.7 0 0 1 1.05-.607l10.89 6.288a.7.7 0 0 1 0 1.212L4.05 14.894A.7.7 0 0 1 3 14.288V1.713z"/>',
    pause: '<path d="M2.7 1a.7.7 0 0 0-.7.7v12.6a.7.7 0 0 0 .7.7h2.6a.7.7 0 0 0 .7-.7V1.7a.7.7 0 0 0-.7-.7H2.7zm8 0a.7.7 0 0 0-.7.7v12.6a.7.7 0 0 0 .7.7h2.6a.7.7 0 0 0 .7-.7V1.7a.7.7 0 0 0-.7-.7h-2.6z"/>',
    heart: '<path d="M1.69 2A4.582 4.582 0 0 1 8 2.023 4.583 4.583 0 0 1 11.88.817h.002a4.618 4.618 0 0 1 3.782 3.65v.003a4.543 4.543 0 0 1-1.011 3.84L9.35 14.629a1.765 1.765 0 0 1-2.093.464 1.762 1.762 0 0 1-.605-.463L1.348 8.309A4.582 4.582 0 0 1 1.689 2z"/>',
    plus2px: '<path d="M14 7H9V2H7v5H2v2h5v5h2V9h5z"/>',
    "chart-up": '<path d="M1 14.5h14V16H0V0h1.5v14.5zM15.03 4.53l-1.06-1.06L9 8.44 6.5 5.94 2.47 9.97l1.06 1.06L6.5 8.06 9 10.56z"/>',
    gears: '<path d="M8 5.5a2.5 2.5 0 1 0 0 5 2.5 2.5 0 0 0 0-5zM7 8a1 1 0 1 1 2 0 1 1 0 0 1-2 0z"/><path d="M6.6 0h2.8l.4 2.06a6 6 0 0 1 1.3.75l1.98-.68 1.4 2.42-1.58 1.38a6 6 0 0 1 0 1.5l1.58 1.38-1.4 2.42-1.98-.68a6 6 0 0 1-1.3.75L9.4 16H6.6l-.4-2.06a6 6 0 0 1-1.3-.75l-1.98.68-1.4-2.42 1.58-1.38a6 6 0 0 1 0-1.5L1.52 5.19l1.4-2.42 1.98.68a6 6 0 0 1 1.3-.75z" fill-opacity=".9"/>',
    search: '<path d="M7 1.75a5.25 5.25 0 1 0 0 10.5 5.25 5.25 0 0 0 0-10.5zM.25 7a6.75 6.75 0 1 1 12.096 4.12l3.184 3.185a.75.75 0 1 1-1.06 1.06L11.304 12.2A6.75 6.75 0 0 1 .25 7z"/>',
    lyrics: '<path d="M13.426 2.574a2.831 2.831 0 0 0-4.797 1.55l3.247 3.247a2.831 2.831 0 0 0 1.55-4.797zM10.5 8.118l-2.619-2.62A63303.13 63303.13 0 0 0 4.74 9.075L2.065 12.12a1.287 1.287 0 0 0 1.816 1.816l3.06-2.688 3.56-3.129zM7.12 4.094a4.331 4.331 0 1 1 4.786 4.786l-3.974 3.493-3.06 2.689a2.787 2.787 0 0 1-3.933-3.933l2.676-3.045 3.505-3.99z"/>',
    queue: '<path d="M15 15H1v-1.5h14V15zm0-4.5H1V9h14v1.5zm-14-7A2.5 2.5 0 0 1 3.5 1h9a2.5 2.5 0 0 1 0 5h-9A2.5 2.5 0 0 1 1 3.5zm2.5-1a1 1 0 0 0 0 2h9a1 1 0 1 0 0-2h-9z"/>',
  };

  // ------------------------------------------------------------------
  // 6. Spicetify compatibility API
  // ------------------------------------------------------------------

  function createEmitter() {
    const map = new Map();
    return {
      on(t, fn) { if (!map.has(t)) map.set(t, new Set()); map.get(t).add(fn); },
      off(t, fn) { map.get(t)?.delete(fn); },
      emit(t, data) {
        const ev = { type: t, data };
        for (const fn of map.get(t) || []) { try { fn(ev); } catch (e) { warn(`${t} listener failed`, e); } }
      },
      count(t) { return map.get(t)?.size || 0; },
    };
  }

  // ---- URI ----
  const URI_TYPES = ["album", "artist", "playlist", "track", "episode", "show", "user", "collection", "folder", "genre", "station", "local", "search", "app", "concert", "audiobook", "chapter"];
  class SpectraURI {
    constructor(type, id, extra) { this.type = type; this.id = id; Object.assign(this, extra || {}); }
    toURI() { return this.type === "collection" ? "spotify:user:@:collection" : `spotify:${this.type}:${this.id}`; }
    toString() { return this.toURI(); }
    toURL() { return `https://open.spotify.com/${this.type}/${this.id}`; }
    getPath() { return `/${this.type}/${this.id}`; }
    static from(v) {
      if (v instanceof SpectraURI) return v;
      const s = String(v || "");
      let m = s.match(/^spotify:(?:user:[^:]+:)?(\w+):([^:?]+)/);
      if (m) return new SpectraURI(m[1], m[2]);
      m = s.match(/open\.spotify\.com\/(?:intl-\w+\/)?(\w+)\/([A-Za-z0-9]+)/) || s.match(/^\/(\w+)\/([A-Za-z0-9]+)/);
      if (m) return new SpectraURI(m[1], m[2]);
      return null;
    }
    static fromString(v) { const u = SpectraURI.from(v); if (!u) throw new TypeError("Invalid URI: " + v); return u; }
    static isSameIdentity(a, b) { const x = SpectraURI.from(a), y = SpectraURI.from(b); return !!x && !!y && x.toURI() === y.toURI(); }
  }
  SpectraURI.Type = Object.fromEntries(URI_TYPES.map((t) => [t.toUpperCase(), t]));
  for (const t of URI_TYPES) {
    const name = "is" + t[0].toUpperCase() + t.slice(1);
    SpectraURI[name] = (u) => SpectraURI.from(u)?.type === t;
  }
  SpectraURI.isPlaylistV1OrV2 = SpectraURI.isPlaylist;
  for (const t of URI_TYPES) SpectraURI[t + "URI"] = (id) => new SpectraURI(t, id);

  function uriFromHref(href) {
    if (!href) return null;
    try {
      const u = new URL(href, location.origin);
      const hl = u.searchParams.get("highlight");
      if (hl && hl.startsWith("spotify:")) return hl;
      const parsed = SpectraURI.from(u.pathname);
      return parsed ? parsed.toURI() : null;
    } catch { return null; }
  }

  // ---- Player ----
  const playerEvents = createEmitter();
  const q = (sel) => document.querySelector(sel);
  const clickTestId = (id) => { const b = q(`[data-testid="${id}"]`); if (b) b.click(); return !!b; };

  function domPlayerState() {
    const md = navigator.mediaSession && navigator.mediaSession.metadata;
    const playBtn = q('[data-testid="control-button-playpause"]');
    const label = (playBtn && playBtn.getAttribute("aria-label")) || "";
    const isPaused = playBtn ? !/pause/i.test(label) : (navigator.mediaSession?.playbackState !== "playing");
    const link = q('[data-testid="now-playing-widget"] a[href*="highlight="], [data-testid="context-item-link"]');
    const uri = uriFromHref(link && link.getAttribute("href"));
    const posEl = q('[data-testid="playback-position"]');
    const durEl = q('[data-testid="playback-duration"]');
    const toMs = (t) => {
      if (!t) return 0;
      const parts = t.textContent.trim().replace("-", "").split(":").map(Number);
      return parts.reduce((a, n) => a * 60 + (n || 0), 0) * 1000;
    };
    const art = md && md.artwork && md.artwork.length ? md.artwork[md.artwork.length - 1].src : null;
    const position = toMs(posEl);
    let duration = toMs(durEl);
    if (durEl && durEl.textContent.trim().startsWith("-")) duration += position;
    return {
      item: md ? {
        uri, name: md.title, type: uri ? SpectraURI.from(uri)?.type : "track",
        metadata: { title: md.title, artist_name: md.artist, album_title: md.album, image_url: art, image_xlarge_url: art, image_large_url: art },
        artists: [{ name: md.artist }],
        album: { name: md.album, images: art ? [{ url: art }] : [] },
        duration: { milliseconds: duration },
      } : null,
      isPaused,
      duration,
      positionAsOfTimestamp: position,
      timestamp: Date.now(),
      shuffle: q('[data-testid="control-button-shuffle"]')?.getAttribute("aria-checked") === "true",
      _source: "dom",
    };
  }

  function playerAPI() { return state.platform && state.platform.PlayerAPI; }

  function currentState() {
    const api = playerAPI();
    if (api && typeof api.getState === "function") {
      try {
        const s = api.getState();
        if (s) return s;
      } catch {}
    }
    return domPlayerState();
  }

  function currentProgress(s) {
    s = s || currentState();
    if (s._source === "dom") return s.positionAsOfTimestamp;
    const base = s.positionAsOfTimestamp || 0;
    if (s.isPaused || !s.timestamp) return base;
    return Math.min(base + (Date.now() - s.timestamp) * (s.speed || 1), s.duration || Infinity);
  }

  function mediaEl() { return q("video, audio"); }

  const Player = {
    get data() { return currentState(); },
    addEventListener(type, fn) { playerEvents.on(type, fn); startPlayerPolling(); },
    removeEventListener(type, fn) { playerEvents.off(type, fn); },
    dispatchEvent(ev) { playerEvents.emit(ev.type, ev.data); },
    isPlaying() { return !currentState().isPaused; },
    play() { const a = playerAPI(); if (a?.resume) return a.resume(); if (!Player.isPlaying()) clickTestId("control-button-playpause"); },
    pause() { const a = playerAPI(); if (a?.pause) return a.pause(); if (Player.isPlaying()) clickTestId("control-button-playpause"); },
    togglePlay() { Player.isPlaying() ? Player.pause() : Player.play(); },
    next() { const a = playerAPI(); if (a?.skipToNext) return a.skipToNext(); clickTestId("control-button-skip-forward"); },
    back() { const a = playerAPI(); if (a?.skipToPrevious) return a.skipToPrevious(); clickTestId("control-button-skip-back"); },
    getProgress() { return currentProgress(); },
    getDuration() { return currentState().duration || 0; },
    getProgressPercent() { const d = Player.getDuration(); return d ? Player.getProgress() / d : 0; },
    seek(p) {
      const d = Player.getDuration();
      const ms = p <= 1 ? p * d : p;
      const a = playerAPI();
      if (a?.seekTo) return a.seekTo(ms);
      const m = mediaEl(); if (m) m.currentTime = ms / 1000;
    },
    skipForward(ms = 15000) { Player.seek(Player.getProgress() + ms); },
    skipBack(ms = 15000) { Player.seek(Math.max(0, Player.getProgress() - ms)); },
    getVolume() {
      const pb = state.platform?.PlaybackAPI;
      if (pb?._volume != null) return pb._volume;
      const m = mediaEl(); return m ? m.volume : 1;
    },
    setVolume(v) {
      const pb = state.platform?.PlaybackAPI;
      if (pb?.setVolume) return pb.setVolume(v);
      const m = mediaEl(); if (m) m.volume = Math.max(0, Math.min(1, v));
    },
    increaseVolume() { Player.setVolume(Math.min(1, Player.getVolume() + 0.1)); },
    decreaseVolume() { Player.setVolume(Math.max(0, Player.getVolume() - 0.1)); },
    getMute() { return Player.getVolume() === 0; },
    toggleMute() { clickTestId("volume-bar-toggle-mute-button"); },
    getShuffle() { return !!currentState().shuffle; },
    setShuffle(b) { const a = playerAPI(); if (a?.setShuffle) return a.setShuffle(b); if (Player.getShuffle() !== !!b) clickTestId("control-button-shuffle"); },
    toggleShuffle() { Player.setShuffle(!Player.getShuffle()); },
    getRepeat() { const s = currentState(); return typeof s.repeat === "number" ? s.repeat : 0; },
    setRepeat(n) { const a = playerAPI(); if (a?.setRepeat) return a.setRepeat(n); clickTestId("control-button-repeat"); },
    toggleRepeat() { Player.setRepeat((Player.getRepeat() + 1) % 3); },
    getHeart() { return q('[data-testid="now-playing-widget"] button[aria-checked="true"]') != null; },
    toggleHeart() { q('[data-testid="now-playing-widget"] button[aria-checked]')?.click(); },
    playUri(uri, context, options) {
      const a = playerAPI();
      if (a?.play) return a.play({ uri }, context || {}, options || {});
      const u = SpectraURI.from(uri); if (u) location.assign(u.getPath());
    },
    formatTime(ms) {
      const s = Math.floor(ms / 1000);
      return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
    },
  };
  Player.seekTo = Player.seek;

  let pollTimer = null;
  let lastUri = null, lastPaused = null;
  function startPlayerPolling() {
    if (pollTimer) return;
    pollTimer = setInterval(() => {
      let s;
      try { s = currentState(); } catch { return; }
      const uri = s.item && (s.item.uri || s.item.metadata?.title);
      if (uri !== lastUri) { lastUri = uri; playerEvents.emit("songchange", s); }
      if (s.isPaused !== lastPaused) { lastPaused = s.isPaused; playerEvents.emit("onplaypause", s); }
      if (playerEvents.count("onprogress")) playerEvents.emit("onprogress", currentProgress(s));
    }, 250);
  }

  // ---- CosmosAsync (Web API passthrough) ----
  function accessToken() {
    const P = state.platform;
    try {
      const fromPlatform = P?.Session?.accessToken || P?.AuthorizationAPI?.getState?.()?.token?.accessToken ||
        P?.AuthorizationAPI?._tokenProvider?.()?.accessToken;
      if (fromPlatform) return fromPlatform;
    } catch {}
    // Fall back to the token Spotify's own web player is using right now.
    const a = spotifyAuth.authorization;
    return a && /^Bearer /i.test(a) ? a.slice(7) : null;
  }

  function isSpotifyHost(url) {
    try {
      const h = new URL(url, location.href).hostname;
      return h === "spotify.com" || h.endsWith(".spotify.com");
    } catch { return false; }
  }

  // Desktop-only Cosmos endpoints that extensions rely on, emulated for the web player.
  async function cosmosInternal(method, url) {
    if (url.replace(/\?.*$/, "") === "sp://oauth/v2/token") {
      const token = accessToken();
      if (!token) throw new Error("Spectra: no Spotify access token yet (is the player signed in?)");
      return { accessToken: token, expiresAtTime: Date.now() + 10 * 60 * 1000, tokenType: "Bearer" };
    }
    throw new Error(`Spectra: ${url} endpoints are desktop-internal and unavailable here`);
  }

  async function cosmos(method, url, body, headers) {
    if (!/^https?:/.test(url)) {
      if (url.startsWith("wg://") || url.startsWith("sp://")) return cosmosInternal(method, url);
      url = "https://api.spotify.com/v1/" + url.replace(/^\/+/, "");
    }
    const token = accessToken();
    const h = Object.assign({}, headers || {});
    if (isSpotifyHost(url)) {
      if (token) h.Authorization = h.Authorization || `Bearer ${token}`;
      // spclient / api-partner reject requests without the web player's client headers.
      if (spotifyAuth.clientToken && !h["client-token"]) h["client-token"] = spotifyAuth.clientToken;
      if (spotifyAuth.appPlatform && !h["app-platform"]) h["app-platform"] = spotifyAuth.appPlatform;
      if (spotifyAuth.appVersion && !h["spotify-app-version"]) h["spotify-app-version"] = spotifyAuth.appVersion;
      if (!h.Accept && !h.accept) h.Accept = "application/json";
    }
    let payload = body;
    if (body && typeof body === "object" && !(body instanceof FormData) && !(body instanceof Blob)) {
      payload = JSON.stringify(body);
      h["Content-Type"] = h["Content-Type"] || "application/json";
    }
    if (method === "GET" && body && typeof body === "object") {
      const u = new URL(url);
      for (const [k, v] of Object.entries(body)) u.searchParams.set(k, v);
      url = u.href;
      payload = undefined;
    }
    const res = await originalFetch.call(window, url, { method, headers: h, body: payload });
    const text = await res.text();
    let data;
    try { data = text ? JSON.parse(text) : null; } catch { data = text; }
    if (!res.ok) { const e = new Error(`Cosmos ${method} ${url} -> ${res.status}`); e.status = res.status; e.body = data; throw e; }
    return data;
  }
  const CosmosAsync = {
    get: (u, b, h) => cosmos("GET", u, b, h),
    post: (u, b, h) => cosmos("POST", u, b, h),
    put: (u, b, h) => cosmos("PUT", u, b, h),
    del: (u, b, h) => cosmos("DELETE", u, b, h),
    patch: (u, b, h) => cosmos("PATCH", u, b, h),
    request: (m, u, b, h) => cosmos(m, u, b, h),
    resolve: (m, u, b, h) => cosmos(m, u, b, h).then((body) => ({ body, status: 200 })),
  };

  // ---- Colour extraction from cover art ----
  async function colorExtractor(uri) {
    let img = Player.data?.item?.metadata?.image_xlarge_url || Player.data?.item?.metadata?.image_url;
    if (uri && Player.data?.item?.uri && !SpectraURI.isSameIdentity(uri, Player.data.item.uri)) {
      try {
        const u = SpectraURI.from(uri);
        const r = await fetch(`https://open.spotify.com/oembed?url=${encodeURIComponent(u.toURL())}`).then((r) => r.json());
        img = r.thumbnail_url;
      } catch {}
    }
    if (img && img.startsWith("spotify:image:")) img = "https://i.scdn.co/image/" + img.split(":").pop();
    if (!img) throw new Error("No artwork available");
    const image = await new Promise((res, rej) => {
      const i = new Image(); i.crossOrigin = "anonymous"; i.onload = () => res(i); i.onerror = rej; i.src = img;
    });
    const c = document.createElement("canvas"); c.width = c.height = 48;
    const ctx = c.getContext("2d", { willReadFrequently: true }); ctx.drawImage(image, 0, 0, 48, 48);
    const px = ctx.getImageData(0, 0, 48, 48).data;
    const buckets = new Map();
    for (let i = 0; i < px.length; i += 4) {
      const k = ((px[i] >> 4) << 8) | ((px[i + 1] >> 4) << 4) | (px[i + 2] >> 4);
      const b = buckets.get(k) || { r: 0, g: 0, b: 0, n: 0 };
      b.r += px[i]; b.g += px[i + 1]; b.b += px[i + 2]; b.n++; buckets.set(k, b);
    }
    const cols = [...buckets.values()].map((b) => {
      const r = b.r / b.n, g = b.g / b.n, bl = b.b / b.n;
      const max = Math.max(r, g, bl), min = Math.min(r, g, bl);
      return { r, g, b: bl, n: b.n, sat: max ? (max - min) / max : 0, lum: (0.299 * r + 0.587 * g + 0.114 * bl) / 255 };
    });
    const hex = (c) => "#" + [c.r, c.g, c.b].map((v) => Math.round(v).toString(16).padStart(2, "0")).join("");
    const pick = (score) => hex(cols.reduce((best, c) => (score(c) > score(best) ? c : best), cols[0]));
    return {
      PROMINENT: pick((c) => c.n),
      VIBRANT: pick((c) => c.sat * 2 + (1 - Math.abs(c.lum - 0.5)) + c.n / 400),
      DARK_VIBRANT: pick((c) => c.sat * 2 + (1 - c.lum) * 1.5 + c.n / 400),
      LIGHT_VIBRANT: pick((c) => c.sat * 2 + c.lum * 1.5 + c.n / 400),
      DESATURATED: pick((c) => (1 - c.sat) + c.n / 300),
      VIBRANT_NON_ALARMING: pick((c) => c.sat + (1 - Math.abs(c.lum - 0.45)) * 2 + c.n / 400),
    };
  }

  // ---- Topbar / Playbar buttons ----
  const topbarButtons = new Set();
  const playbarButtons = new Set();

  function makeButton(cfg, extraClass) {
    const b = el("button", { class: "spectra-btn " + (extraClass || ""), "aria-label": cfg.label, title: cfg.label, html: iconHTML(cfg.icon) });
    b.addEventListener("click", (e) => { e.stopPropagation(); try { cfg.onClick && cfg.onClick(cfg.self); } catch (err) { warn("button click failed", err); } });
    return b;
  }

  function buttonClass(set, kind) {
    return class {
      constructor(label, icon, onClick, disabled = false, activeOrRight = false, registerOnCreate = true) {
        this._cfg = { label, icon, onClick, self: this };
        this._disabled = !!disabled;
        this._active = kind === "playbar" ? !!activeOrRight : false;
        this.isRight = kind === "topbar" ? !!activeOrRight : false;
        this.element = makeButton(this._cfg, "");
        this._render();
        const reg = kind === "playbar" ? registerOnCreate : true;
        if (reg) this.register();
      }
      _render() {
        this.element.toggleAttribute("disabled", this._disabled);
        this.element.classList.toggle("active", this._active);
        this.element.setAttribute("aria-label", this._cfg.label);
        this.element.title = this._cfg.label;
        this.element.innerHTML = iconHTML(this._cfg.icon);
      }
      get label() { return this._cfg.label; } set label(v) { this._cfg.label = v; this._render(); }
      get icon() { return this._cfg.icon; } set icon(v) { this._cfg.icon = v; this._render(); }
      get onClick() { return this._cfg.onClick; } set onClick(v) { this._cfg.onClick = v; }
      get disabled() { return this._disabled; } set disabled(v) { this._disabled = !!v; this._render(); }
      get active() { return this._active; } set active(v) { this._active = !!v; this._render(); }
      register() { set.add(this); mountButtons(); }
      deregister() { set.delete(this); this.element.remove(); }
    };
  }

  /**
   * Where the buttons go: { parent, before } (insert before `before`, null = append).
   *  - Global-nav layout (current): first thing in the right-hand section. The middle
   *    section (home + search) is fixed-width and has pointer-events:none around it,
   *    so anything put there gets squeezed, overlapped and can't be clicked.
   *  - Classic layout: right after the back/forward buttons.
   */
  function topbarSpot() {
    const nav = q('[data-testid="global-nav-bar"]');
    const home = nav && nav.querySelector('[data-testid="home-button"]');
    if (home) {
      // Climb to the nav bar's direct child that holds home + search, then take the section after it.
      let middle = home;
      while (middle.parentElement && middle.parentElement !== nav) middle = middle.parentElement;
      const right = middle.parentElement === nav && middle.nextElementSibling;
      if (right) {
        // Some builds wrap the right-hand buttons in one more flex row.
        const row = right.children.length === 1 && right.firstElementChild.id !== "spectra-topbar" ? right.firstElementChild : right;
        const first = row.firstElementChild === document.getElementById("spectra-topbar") ? row.firstElementChild.nextElementSibling : row.firstElementChild;
        return { parent: row, before: first };
      }
    }
    const back = q('[data-testid="top-bar-back-button"], button[aria-label="Go back"]');
    if (back && back.parentElement && back.parentElement.parentElement) return { parent: back.parentElement.parentElement, before: back.parentElement.nextElementSibling };
    return null;
  }

  function topbarHost() {
    let host = document.getElementById("spectra-topbar");
    if (!host) host = el("div", { id: "spectra-topbar", class: "spectra-topbar" });
    const spot = topbarFloat ? null : topbarSpot();
    if (spot) {
      host.classList.remove("floating");
      const before = spot.before === host ? host.nextElementSibling : spot.before;
      if (host.parentElement !== spot.parent || host.nextElementSibling !== before) spot.parent.insertBefore(host, before);
    } else if (!host.isConnected || !host.classList.contains("floating")) {
      host.classList.add("floating");
      document.body.append(host);
    }
    return host;
  }

  // Themes often hide or collapse the top-bar area the buttons sit in. If that
  // happens, float the buttons instead (sticky until the payload changes, so the
  // host doesn't bounce between the two spots on every DOM change).
  let topbarFloat = false;
  function hostVisible(host) {
    if (!host.isConnected) return false;
    if (host.checkVisibility && !host.checkVisibility({ opacityProperty: true, visibilityProperty: true })) return false;
    const r = host.getBoundingClientRect();
    if (!(r.width >= 8 && r.height >= 8 && r.bottom > 0 && r.right > 0 && r.top < innerHeight && r.left < innerWidth)) return false;
    // Visible isn't enough: a theme can slide something over it. Check what a tap there would hit.
    const b = host.querySelector("button") || host;
    const br = b.getBoundingClientRect();
    const hit = document.elementFromPoint(br.left + br.width / 2, br.top + br.height / 2);
    return !hit || host.contains(hit) || !!hit.closest("#spectra-menu, #spectra-modal, [role=dialog]");
  }
  let visTimer = 0;
  function checkTopbarVisible() {
    if (visTimer) return; // a check is already running; Spotify's constant DOM updates mustn't restart it
    const bad = () => {
      const host = document.getElementById("spectra-topbar");
      return !!host && !topbarFloat && topbarButtons.size > 0 && !host.classList.contains("floating") && !hostVisible(host);
    };
    // Let theme CSS and layout settle, then require two failed checks in a row
    // so a passing popup or animation doesn't send the buttons floating.
    // (Timers, not animation frames: frames don't run while a window isn't being drawn.)
    visTimer = setTimeout(() => {
      if (!bad()) { visTimer = 0; return; }
      visTimer = setTimeout(() => {
        visTimer = 0;
        if (bad()) { topbarFloat = true; mountButtons(); }
      }, 700);
    }, 250);
  }

  function playbarHost() {
    const anchor = q('[data-testid="volume-bar"]') || q('[data-testid="control-button-queue"]');
    if (!anchor) return null;
    let host = document.getElementById("spectra-playbar");
    if (!host) host = el("div", { id: "spectra-playbar", class: "spectra-playbar" });
    const row = anchor.closest('[data-testid="volume-bar"]') ? anchor.parentElement : anchor.parentElement;
    if (!row) return null;
    if (host.parentElement !== row) row.insertBefore(host, row.firstChild);
    return host;
  }

  function mountButtons() {
    onReady(() => {
      if (topbarButtons.size) {
        const host = topbarHost();
        for (const b of topbarButtons) if (b.element.parentElement !== host) host.append(b.element);
        checkTopbarVisible();
      }
      if (playbarButtons.size) {
        const host = playbarHost();
        if (host) for (const b of playbarButtons) if (b.element.parentElement !== host) host.append(b.element);
      }
    });
  }

  // ---- Profile-style menu (Spicetify.Menu) shown from the Spectra topbar button ----
  const menuItems = new Set();
  class MenuItem {
    constructor(name, isEnabled, onClick, icon) {
      this.name = name; this.isEnabled = !!isEnabled; this.onClick = onClick; this.icon = icon;
    }
    setState(v) { this.isEnabled = !!v; }
    setName(v) { this.name = v; }
    setIcon(v) { this.icon = v; }
    register() { menuItems.add(this); }
    deregister() { menuItems.delete(this); }
  }
  class SubMenu {
    constructor(name, items) { this.name = name; this.items = new Set(items || []); }
    addItem(i) { this.items.add(i); } removeItem(i) { this.items.delete(i); }
    register() { menuItems.add(this); } deregister() { menuItems.delete(this); }
  }

  function closeMenu() { document.getElementById("spectra-menu")?.remove(); document.removeEventListener("mousedown", outsideMenu, true); }
  function outsideMenu(e) { if (!e.target.closest("#spectra-menu")) closeMenu(); }

  function openMenu(anchorEl, items, title) {
    closeMenu();
    const menu = el("div", { id: "spectra-menu", role: "menu" });
    if (title) menu.append(el("div", { class: "label" }, title));
    const render = (list) => {
      for (const it of list) {
        if (it === "sep") { menu.append(el("div", { class: "sep" })); continue; }
        if (it instanceof SubMenu) {
          menu.append(el("div", { class: "label" }, it.name));
          render([...it.items]);
          continue;
        }
        const row = el("div", { class: "item", role: "menuitem", tabindex: "0" },
          el("span", {}, it.name),
          it.isEnabled ? el("span", { class: "check", html: '<svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor"><path d="M15.53 2.47a.75.75 0 0 1 0 1.06L4.907 14.153.47 9.716a.75.75 0 0 1 1.06-1.06l3.377 3.376L14.47 2.47a.75.75 0 0 1 1.06 0z"/></svg>' }) : null);
        row.addEventListener("click", () => { closeMenu(); try { it.onClick && it.onClick(it); } catch (e) { warn(e); } });
        menu.append(row);
      }
    };
    render(items);
    document.body.append(menu);
    const r = anchorEl.getBoundingClientRect();
    const mw = menu.offsetWidth, mh = menu.offsetHeight;
    menu.style.left = Math.max(8, Math.min(window.innerWidth - mw - 8, r.right - mw)) + "px";
    menu.style.top = Math.min(window.innerHeight - mh - 8, r.bottom + 6) + "px";
    setTimeout(() => document.addEventListener("mousedown", outsideMenu, true));
  }

  // ---- Context menu items injected into Spotify's own context menu ----
  const contextItems = new Set();
  let lastContext = null;
  class ContextMenuItem {
    constructor(name, onClick, shouldAdd = () => true, icon, disabled = false) {
      this.name = name; this.onClick = onClick; this.shouldAdd = shouldAdd; this.icon = icon; this.disabled = disabled;
    }
    register() { contextItems.add(this); }
    deregister() { contextItems.delete(this); }
  }
  class ContextSubMenu {
    constructor(name, items, shouldAdd = () => true, disabled = false) {
      this.name = name; this.items = new Set(items || []); this.shouldAdd = shouldAdd; this.disabled = disabled;
    }
    addItem(i) { this.items.add(i); } removeItem(i) { this.items.delete(i); }
    register() { contextItems.add(this); } deregister() { contextItems.delete(this); }
  }

  function contextFromTarget(target) {
    if (!target || !target.closest) return null;
    const container = target.closest('[role="row"], [data-testid="tracklist-row"], [data-encore-id="card"], [data-testid="now-playing-widget"], li[role="listitem"], [aria-labelledby][role="group"], a[href]');
    if (!container) return null;
    const links = container.matches("a[href]") ? [container] : [...container.querySelectorAll("a[href]")];
    const order = ["track", "episode", "album", "playlist", "show", "artist", "user"];
    const uris = links.map((a) => uriFromHref(a.getAttribute("href"))).filter(Boolean);
    uris.sort((a, b) => order.indexOf(SpectraURI.from(a)?.type) - order.indexOf(SpectraURI.from(b)?.type));
    const ctx = uriFromHref(location.pathname);
    return uris.length ? { uris: [uris[0]], uids: [], contextUri: ctx || undefined } : (ctx ? { uris: [ctx], uids: [], contextUri: ctx } : null);
  }

  function installContextMenuHook() {
    const remember = (e) => { lastContext = contextFromTarget(e.target) || lastContext; };
    document.addEventListener("contextmenu", remember, true);
    document.addEventListener("click", (e) => {
      if (e.target.closest && e.target.closest('[data-testid="more-button"], button[aria-haspopup="menu"]')) remember(e);
    }, true);
    watchDOM(() => {
      if (!contextItems.size) return;
      const menu = q('#context-menu ul[role="menu"], [data-testid="context-menu"] ul[role="menu"], [data-tippy-root] ul[role="menu"]');
      if (!menu || menu.dataset.spectra) return;
      menu.dataset.spectra = "1";
      const ctx = lastContext;
      if (!ctx) return;
      const template = menu.querySelector(':scope > li[role="presentation"]');
      const add = (item, parent) => {
        let ok = false;
        try { ok = item.shouldAdd(ctx.uris, ctx.uids, ctx.contextUri); } catch {}
        if (!ok) return;
        const items = item instanceof ContextSubMenu ? [...item.items] : [item];
        for (const it of items) {
          let ok2 = true;
          if (item instanceof ContextSubMenu) { try { ok2 = it.shouldAdd(ctx.uris, ctx.uids, ctx.contextUri); } catch { ok2 = false; } }
          if (!ok2) continue;
          const li = template ? template.cloneNode(true) : el("li", { role: "presentation" }, el("button", { role: "menuitem" }));
          const btn = li.querySelector("button, [role=menuitem]") || li;
          const textSpan = btn.querySelector("span") || btn;
          const label = item instanceof ContextSubMenu ? `${item.name}: ${it.name}` : it.name;
          btn.querySelectorAll("svg").forEach((s) => s.remove());
          textSpan.textContent = label;
          if (it.icon) btn.insertAdjacentHTML("afterbegin", iconHTML(it.icon));
          if (it.disabled) btn.setAttribute("aria-disabled", "true");
          btn.addEventListener("click", (e) => {
            e.preventDefault(); e.stopPropagation();
            document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
            document.body.click();
            try { it.onClick(ctx.uris, ctx.uids, ctx.contextUri); } catch (err) { warn("context item failed", err); }
          }, true);
          parent.append(li);
        }
      };
      for (const item of contextItems) add(item, menu);
    });
  }

  // ---- Keyboard ----
  const shortcuts = [];
  function parseCombo(c) {
    if (typeof c === "object") return { key: String(c.key).toLowerCase(), ctrl: !!c.ctrl, shift: !!c.shift, alt: !!c.alt, meta: !!c.meta };
    const parts = String(c).toLowerCase().split("+");
    const key = parts.pop();
    const mod = (m) => parts.includes(m);
    return { key, ctrl: mod("ctrl") || (mod("mod") && !/mac/i.test(navigator.platform)), shift: mod("shift"), alt: mod("alt") || mod("option"), meta: mod("meta") || mod("command") || mod("cmd") || (mod("mod") && /mac/i.test(navigator.platform)) };
  }
  document.addEventListener("keydown", (e) => {
    const t = e.target;
    if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
    for (const s of shortcuts) {
      const c = s.combo;
      if (e.key.toLowerCase() === c.key && e.ctrlKey === c.ctrl && e.shiftKey === c.shift && e.altKey === c.alt && e.metaKey === c.meta) {
        try { if (s.cb(e) === false) e.preventDefault(); } catch (err) { warn(err); }
      }
    }
  });
  const Keyboard = {
    registerShortcut(combo, cb) { shortcuts.push({ combo: parseCombo(combo), cb, raw: combo }); },
    _deregisterShortcut(combo) {
      const c = parseCombo(combo);
      for (let i = shortcuts.length - 1; i >= 0; i--) if (JSON.stringify(shortcuts[i].combo) === JSON.stringify(c)) shortcuts.splice(i, 1);
    },
    KEYS: { ENTER: "Enter", ESCAPE: "Escape", SPACE: " ", ARROW_UP: "ArrowUp", ARROW_DOWN: "ArrowDown", ARROW_LEFT: "ArrowLeft", ARROW_RIGHT: "ArrowRight" },
  };
  Keyboard.deregisterShortcut = Keyboard._deregisterShortcut;
  const Mousetrap = {
    bind(keys, cb) { [].concat(keys).forEach((k) => Keyboard.registerShortcut(k, cb)); return Mousetrap; },
    unbind(keys) { [].concat(keys).forEach((k) => Keyboard._deregisterShortcut(k)); return Mousetrap; },
  };

  // ---- Minimal ReactComponent stand-ins (built lazily once React is known) ----
  function buildReactComponents() {
    const R = state.react;
    if (!R) return {};
    const h = R.createElement;
    const btn = (variant) => (props) => h("button", Object.assign({}, props, {
      style: Object.assign({
        border: "none", borderRadius: "999px", padding: "8px 24px", fontWeight: 700, cursor: "pointer",
        background: variant === "primary" ? "var(--spice-button)" : variant === "secondary" ? "transparent" : "transparent",
        color: variant === "primary" ? "#000" : "var(--spice-text)",
        boxShadow: variant === "secondary" ? "inset 0 0 0 1px var(--spice-subtext)" : "none",
      }, props.style || {}),
    }), props.children);
    return {
      TooltipWrapper: (p) => h("span", { title: typeof p.label === "string" ? p.label : undefined, style: { display: "contents" } }, p.children),
      ButtonPrimary: btn("primary"),
      ButtonSecondary: btn("secondary"),
      ButtonTertiary: btn("tertiary"),
      TextComponent: (p) => h(p.as || "span", { className: p.className, style: p.style }, p.children),
      Slider: (p) => h("input", { type: "range", min: p.min ?? 0, max: p.max ?? 1, step: p.step ?? 0.01, value: p.value, onChange: (e) => p.onDragMove && p.onDragMove(+e.target.value), onMouseUp: (e) => p.onDragEnd && p.onDragEnd(+e.target.value) }),
    };
  }

  function installSpicetify() {
    if (window.Spicetify && window.Spicetify.Player && !window.Spicetify.__spectra) {
      log("Real Spicetify detected — using it instead of the compatibility layer.");
      return;
    }
    const events = createEmitter();
    const S = window.Spicetify = window.Spicetify || {};
    Object.assign(S, {
      __spectra: true,
      Spectra: { version: VERSION, isDesktop, apply: (p) => apply(p) },
      Player,
      URI: SpectraURI,
      CosmosAsync,
      LocalStorage: {
        get: (k) => localStorage.getItem(k),
        set: (k, v) => localStorage.setItem(k, v),
        remove: (k) => localStorage.removeItem(k),
        clear: () => localStorage.clear(),
      },
      showNotification: (m, isErr, ms) => showNotification(m, isErr, ms),
      Snackbar: { enqueueSnackbar: (m, o) => showNotification(m, o && o.variant === "error"), enqueueCustomSnackbar: (k, o) => showNotification(String(k)) },
      PopupModal,
      Topbar: { Button: buttonClass(topbarButtons, "topbar") },
      Playbar: { Button: buttonClass(playbarButtons, "playbar"), Widget: buttonClass(playbarButtons, "playbar") },
      Menu: { Item: MenuItem, SubMenu },
      ContextMenu: { Item: ContextMenuItem, SubMenu: ContextSubMenu },
      Keyboard,
      Mousetrap,
      SVGIcons,
      colorExtractor,
      Locale: { _locale: navigator.language, getLocale: () => navigator.language, get: (k) => k, getDictionary: () => ({}) },
      Events: {
        platformLoaded: { on: (fn) => (S.Platform ? fn() : events.on("platformLoaded", fn)) },
        webpackLoaded: { on: (fn) => (S.React ? fn() : events.on("webpackLoaded", fn)) },
      },
      GraphQL: { Definitions: {}, Request: undefined, QueryDefinitions: {} },
      Config: { version: "spectra-" + VERSION, current_theme: null, color_scheme: null, extensions: [], custom_apps: [] },
      AppTitle: { get: async () => document.title, set: async (t) => { document.title = t; }, reset: async () => {}, sub: () => ({ clear() {} }) },
      ReactComponent: {},
      ReactHook: {},
      getFontStyle: () => "",
    });
    state.spicetifyEvents = events;

    // React (webpack) discovery — retried until Spotify's bundle has executed.
    let tries = 0;
    (function findReact() {
      let found = false;
      try { found = discoverReact(); } catch (e) { warn("React discovery error", e); }
      if (found) {
        S.React = state.react;
        S.ReactDOM = state.reactDOM;
        S.ReactDOMServer = S.ReactDOMServer || undefined;
        S.ReactJSX = state.jsx;
        S.Webpack = { require: state.webpackRequire };
        S.GraphQL.Definitions = state.graphqlDefs;
        S.GraphQL.QueryDefinitions = state.graphqlDefs;
        Object.assign(S.ReactComponent, buildReactComponents());
        events.emit("webpackLoaded");
        log(`React ${state.react.version} found`);
        return;
      }
      if (++tries < 120) setTimeout(findReact, tries < 20 ? 100 : 500);
      else warn("React not found; extensions needing Spicetify.React will not start");
    })();

    // Platform discovery — only exists once signed in; keep looking quietly.
    let ptries = 0;
    (function findPlatform() {
      let raw = null;
      try { raw = discoverPlatform(); } catch (e) { warn("Platform discovery error", e); }
      if (raw) {
        state.platform = buildPlatform(raw);
        S.Platform = state.platform;
        events.emit("platformLoaded");
        log("Spotify Platform found:", Object.keys(state.platform).filter((k) => k !== "_raw").length, "APIs");
        return;
      }
      ptries++;
      if (ptries === 40 && !S.Platform) {
        // Signed-out or unknown build: give extensions a navigation-only Platform so they don't wait forever.
        S.Platform = {
          __fallback: true,
          History: {
            push: (p) => { history.pushState({}, "", typeof p === "string" ? p : p.pathname); dispatchEvent(new PopStateEvent("popstate")); },
            replace: (p) => { history.replaceState({}, "", typeof p === "string" ? p : p.pathname); dispatchEvent(new PopStateEvent("popstate")); },
            goBack: () => history.back(), goForward: () => history.forward(),
            get location() { return { pathname: location.pathname, search: location.search, hash: location.hash }; },
            listen: (fn) => { const h = () => fn({ pathname: location.pathname }); addEventListener("popstate", h); return () => removeEventListener("popstate", h); },
          },
        };
        warn("Spotify Platform not found yet (are you signed in?). Using a limited fallback.");
      }
      setTimeout(findPlatform, ptries < 40 ? 250 : 3000);
    })();

    installContextMenuHook();
  }

  // ------------------------------------------------------------------
  // 7. Extension loader
  // ------------------------------------------------------------------

  function runScript(script) {
    return new Promise((resolve) => {
      const tag = `spectra-ext/${String(script.name).replace(/[^\w.-]+/g, "_")}.js`;
      const code = `try{\n${script.code}\n}catch(e){console.error("[Spectra] extension \\"${String(script.name).replace(/["\\]/g, "")}\\" crashed:",e)}\n//# sourceURL=${tag}`;
      // Prefer a blob: <script> (allowed by Spotify's CSP; real stack traces and module-like isolation).
      try {
        const url = URL.createObjectURL(new Blob([code], { type: "text/javascript" }));
        const s = document.createElement("script");
        s.src = url;
        s.dataset.spectraExtension = script.id;
        s.onload = () => { URL.revokeObjectURL(url); resolve(true); };
        s.onerror = () => {
          URL.revokeObjectURL(url);
          // Fallback: indirect eval (desktop CEF / CSP without blob:)
          try { (0, eval)(code); resolve(true); } catch (e) { warn(`failed to run ${script.name}`, e); resolve(false); }
        };
        (document.head || document.documentElement).append(s);
      } catch (e) {
        try { (0, eval)(code); resolve(true); } catch (e2) { warn(`failed to run ${script.name}`, e2); resolve(false); }
      }
    });
  }

  async function loadScripts(scripts) {
    // Wait for React (most extensions need it) but never longer than 10s.
    const t0 = Date.now();
    while (!state.react && Date.now() - t0 < 10000) await new Promise((r) => setTimeout(r, 100));
    for (const s of scripts) {
      const ok = await runScript(s);
      if (ok) state.loadedScriptIds.push(s.id);
      log(`${ok ? "loaded" : "FAILED"}: ${s.name}`);
    }
  }

  // ------------------------------------------------------------------
  // 7b. Listen Together
  //
  // The host creates a room (public rooms show in the room browser, private
  // ones need the code). Everyone who joins follows the host's Spotify: same
  // song, same spot, play/pause and seeks. The host can make people DJs; a DJ's
  // requests (queue a song, play a playlist, skip…) go through the server and
  // run on the host's Spotify, so everyone hears them. Each person plays on
  // their own account; Spectra's server (website/api/rooms.js) only relays
  // what's playing and where.
  // ------------------------------------------------------------------

  const Together = (() => {
    const STORE = "spectra-listen-together";
    let session = null;          // { code, role: "host"|"guest", hostKey?, memberId, name }
    let room = null;             // last room info from the server
    let me = null;               // { pid, dj } for guests
    let clockOffset = 0;         // server time − local time
    let lastSeq = -1;            // last host state a guest applied
    let pollTimer = null, hostTimer = null, pushTimer = null;
    let polls = 0;               // to ask for the member list only every few polls
    let lastPushed = null;       // { snap, at } for the host's seek detection
    let status = "";             // message shown in the panel
    let panelBody = null;        // the open panel, re-rendered on changes
    let tab = "browse";          // when not in a room: "browse" | "code" | "create"
    let publicRooms = null;      // null = not loaded yet
    let loadingPublic = false;
    let browseError = "";
    let createVisibility = "public";
    let togetherButton = null;

    const api = () => ((state.payload && state.payload.apiBase) || "https://usespectra.xyz") + "/api/rooms";
    const prettyCode = (c) => (c ? c.slice(0, 3) + "-" + c.slice(3) : "");
    const save = () => { try { session ? localStorage.setItem(STORE, JSON.stringify(session)) : localStorage.removeItem(STORE); } catch {} };
    const store = (k, v) => { try { localStorage.setItem(STORE + ":" + k, v); } catch {} };
    const stored = (k) => { try { return localStorage.getItem(STORE + ":" + k) || ""; } catch { return ""; } };
    const canControl = () => !!session && (session.role === "host" || !!(me && me.dj));
    const isHost = () => !!session && session.role === "host";

    async function call(method, body, query) {
      const url = api() + (query ? "?" + new URLSearchParams(query) : "");
      const res = await originalFetch.call(window, url, method === "GET" ? { cache: "no-store" } : { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw Object.assign(new Error(data.error || "Couldn't reach Spectra's server."), { status: res.status });
      return data;
    }

    function noteRoom(r) {
      if (!r) return;
      const members = r.members || (room && room.members) || [];
      room = Object.assign({}, r, { members });
      if (r.now) clockOffset = r.now - Date.now();
      render();
    }

    async function defaultName() {
      const saved = stored("name");
      if (saved) return saved;
      try {
        const u = await state.platform?.UserAPI?.getUser?.();
        if (u && u.displayName) return u.displayName;
      } catch {}
      return "";
    }

    // ---- Spotify actions (used by the host, for its own clicks and for DJ requests)
    async function addToQueue(uri) {
      const a = playerAPI();
      if (!a || typeof a.addToQueue !== "function") throw new Error("This Spotify version can't add to the queue from Spectra.");
      await a.addToQueue([{ uri }]);
    }
    function typeOf(uri) { return (SpectraURI.from(uri) || {}).type || ""; }
    const queueable = (uri) => ["track", "episode"].includes(typeOf(uri));
    const playable = (uri) => ["track", "episode", "album", "playlist", "artist", "show"].includes(typeOf(uri));

    async function runCommand(cmd) {
      const who = cmd.from || "A DJ";
      const what = cmd.title ? `“${cmd.title}”` : { track: "a song", episode: "an episode", album: "an album", playlist: "a playlist", artist: "an artist", show: "a show" }[typeOf(cmd.uri)] || "something";
      try {
        switch (cmd.type) {
          case "queue": await addToQueue(cmd.uri); showNotification(`${who} added ${what} to the queue`); break;
          case "play": await Player.playUri(cmd.uri); showNotification(`${who} started ${what}`); break;
          case "skip": await Player.next(); showNotification(`${who} skipped the song`); break;
          case "back": await Player.back(); showNotification(`${who} went back a song`); break;
          case "pause": await Player.pause(); showNotification(`${who} paused`); break;
          case "resume": await Player.play(); showNotification(`${who} pressed play`); break;
        }
      } catch (e) {
        showNotification(`Couldn't do what ${who} asked: ${e.message || e}`, true);
      }
      schedulePush(400);
    }

    /** A control from the panel or the right-click menu: run it here if we're the host, otherwise ask the host. */
    async function control(cmd) {
      if (!session) return;
      if (isHost()) return runCommand(Object.assign({ from: "You" }, cmd));
      try {
        await call("POST", { action: "command", code: session.code, memberId: session.memberId, cmd });
        const done = { queue: "Added to the room's queue", play: "Sent. It'll start in a moment", skip: "Skipping…", back: "Going back…", pause: "Pausing…", resume: "Playing…" }[cmd.type];
        showNotification(done || "Sent to the host");
      } catch (e) {
        showNotification(e.message, true);
      }
    }

    // ---- host: publish what's playing
    function snapshot() {
      const s = currentState();
      const it = s.item || {};
      const md = it.metadata || {};
      return {
        uri: it.uri || "",
        title: md.title || it.name || "",
        artist: md.artist_name || (it.artists || []).map((a) => a.name).join(", "),
        art: md.image_xlarge_url || md.image_large_url || md.image_url || (it.images && it.images[0] && it.images[0].url) || "",
        duration: s.duration || 0,
        position: Math.round(currentProgress(s)),
        playing: !s.isPaused,
      };
    }

    function schedulePush(delay = 250) {
      clearTimeout(pushTimer);
      pushTimer = setTimeout(push, delay);
    }

    async function push() {
      if (!isHost()) return;
      const snap = snapshot();
      try {
        const r = await call("POST", { action: "update", code: session.code, hostKey: session.hostKey, state: snap, full: false });
        lastPushed = { snap, at: Date.now() };
        if (room) room.state = Object.assign({}, room.state, snap);
        if (status.startsWith("Connection")) status = "";
        render();
      } catch (e) {
        if (e.status === 404 || e.status === 403) return end("The room has ended.");
        status = e.message; render();
      }
    }

    function hostTick() {
      // Catch seeks: where the song is now vs. where it should be since the last push.
      if (!lastPushed) return schedulePush(0);
      const s = currentState(), now = Date.now();
      const p = lastPushed.snap;
      const expected = p.playing ? p.position + (now - lastPushed.at) : p.position;
      const uri = (s.item && s.item.uri) || "";
      if (uri !== p.uri || !s.isPaused !== p.playing || Math.abs(currentProgress(s) - expected) > 2500 || now - lastPushed.at > 10000) schedulePush(0);
    }

    async function hostPoll() {
      if (!isHost()) return;
      const s = session;
      try {
        const r = await call("POST", { action: "host-poll", code: session.code, hostKey: session.hostKey, full: polls++ % 3 === 0 });
        if (session !== s) return;
        noteRoom(r.room);
        for (const cmd of r.commands || []) await runCommand(cmd);
      } catch (e) {
        if (e.status === 404 || e.status === 403) return end("The room has ended.");
        status = "Connection trouble, retrying…"; render();
      }
      // Check quickly while there are DJs who might ask for something; otherwise take it easy.
      if (session === s) pollTimer = setTimeout(hostPoll, room && room.djCount ? 2000 : 8000);
    }

    // ---- guests: follow the host
    function expectedPosition(st) {
      if (!st.playing) return st.position;
      return Math.min(st.position + (Date.now() + clockOffset - st.at), st.duration || Infinity);
    }

    async function follow(force) {
      const st = room && room.state;
      if (!st || !st.uri) return;
      if (!playerAPI()) { status = "Waiting for Spotify to finish loading…"; render(); return; }
      const s = currentState();
      const myUri = (s.item && s.item.uri) || "";
      const fresh = force || st.seq !== lastSeq;
      lastSeq = st.seq;
      try {
        if (fresh) {
          if (myUri !== st.uri) {
            await Player.playUri(st.uri, {}, { seekTo: Math.round(expectedPosition(st)) });
            setTimeout(() => {
              if (!session || !room) return;
              const now = room.state;
              if (Math.abs(Player.getProgress() - expectedPosition(now)) > 1500) Player.seek(Math.round(expectedPosition(now)));
              if (!now.playing && Player.isPlaying()) Player.pause();
            }, 1500);
          } else {
            if (Math.abs(Player.getProgress() - expectedPosition(st)) > 1500) await Player.seek(Math.round(expectedPosition(st)));
            if (st.playing && !Player.isPlaying()) await Player.play();
            if (!st.playing && Player.isPlaying()) await Player.pause();
          }
        } else if (st.playing && myUri === st.uri && Player.isPlaying() && Math.abs(Player.getProgress() - expectedPosition(st)) > 3000) {
          // Drifted while both are playing: nudge back. (If the guest paused on purpose, leave them be.)
          await Player.seek(Math.round(expectedPosition(st)));
        }
        if (status.startsWith("Waiting") || status.startsWith("Couldn't play")) status = "";
      } catch (e) {
        status = "Couldn't play that song here. It may not be available in your country.";
      }
      render();
    }

    async function guestPoll() {
      if (!session || isHost()) return;
      const s = session;
      try {
        const q = { code: session.code, member: session.memberId };
        if (polls++ % 3 === 0) q.full = "1";
        const r = await call("GET", null, q);
        if (session !== s) return;
        const wasDj = !!(me && me.dj);
        me = r.me || me;
        if (me && me.dj && !wasDj && polls > 1) showNotification("The host made you a DJ. You can add songs and play playlists for the room.");
        if (me && !me.dj && wasDj) showNotification("You're no longer a DJ in this room.");
        noteRoom(r.room);
        follow(false);
      } catch (e) {
        if (e.status === 404) return end("The room has ended.");
        if (e.status === 410) return end(e.message);
        status = "Connection trouble, retrying…"; render();
      }
      if (session === s) pollTimer = setTimeout(guestPoll, 3000);
    }

    // ---- lifecycle
    function start() {
      stopTimers();
      save();
      polls = 0;
      if (isHost()) {
        Player.addEventListener("songchange", onHostChange);
        Player.addEventListener("onplaypause", onHostChange);
        hostTimer = setInterval(hostTick, 1000);
        schedulePush(0);
        hostPoll();
      } else {
        follow(true);
        guestPoll();
      }
      render();
    }
    function onHostChange() { schedulePush(150); }

    function stopTimers() {
      clearTimeout(pollTimer); clearInterval(hostTimer); clearTimeout(pushTimer);
      pollTimer = hostTimer = pushTimer = null;
      Player.removeEventListener("songchange", onHostChange);
      Player.removeEventListener("onplaypause", onHostChange);
    }

    function end(message) {
      stopTimers();
      session = null; room = null; me = null; lastSeq = -1; lastPushed = null;
      save();
      status = message || "";
      tab = "browse"; publicRooms = null;
      render();
      if (message) showNotification(message);
    }

    async function create(name, roomName, visibility) {
      status = "Creating a room…"; render();
      try {
        const r = await call("POST", { action: "create", name, roomName, visibility });
        session = { code: r.code, role: "host", hostKey: r.hostKey, memberId: r.memberId, name };
        status = "";
        noteRoom(r.room);
        start();
      } catch (e) { status = e.message; render(); }
    }

    async function join(code, name) {
      status = "Joining…"; render();
      try {
        const r = await call("POST", { action: "join", code, name });
        session = { code: r.room.code, role: "guest", memberId: r.memberId, name };
        me = r.me || null;
        status = "";
        lastSeq = -1;
        noteRoom(r.room);
        start();
      } catch (e) { status = e.message; render(); }
    }

    async function leave() {
      const s = session;
      end("");
      if (s) call("POST", { action: "leave", code: s.code, memberId: s.memberId, hostKey: s.hostKey }).catch(() => {});
    }

    async function hostAction(body) {
      try {
        const r = await call("POST", Object.assign({ code: session.code, hostKey: session.hostKey }, body));
        noteRoom(r.room);
      } catch (e) { status = e.message; render(); }
    }

    async function loadPublic() {
      if (loadingPublic) return;
      loadingPublic = true;
      browseError = "";
      try {
        const r = await call("GET", null, { list: "public" });
        publicRooms = r.rooms || [];
      } catch (e) { browseError = e.message; publicRooms = publicRooms || []; }
      loadingPublic = false;
      render();
    }

    /** Pick up an existing session after Spotify reloads. */
    function resume() {
      if (session) return;
      try { session = JSON.parse(localStorage.getItem(STORE) || "null"); } catch { session = null; }
      if (!session || !session.code) { session = null; return; }
      const q = isHost() ? { code: session.code } : { code: session.code, member: session.memberId, full: "1" };
      call("GET", null, q).then((r) => { me = r.me || null; noteRoom(r.room); start(); })
        .catch((e) => { if (e.status === 404 || e.status === 410) end(""); else session = null; });
    }

    // ---- right-click menu: "Add to room queue" / "Play in room" for the host and DJs
    new ContextMenuItem("Add to Listen Together queue", (uris) => control({ type: "queue", uri: uris[0] }),
      (uris) => canControl() && uris.length === 1 && queueable(uris[0])).register();
    new ContextMenuItem("Play in Listen Together room", (uris) => control({ type: "play", uri: uris[0] }),
      (uris) => canControl() && uris.length === 1 && playable(uris[0])).register();

    // ---- UI
    function button(label, onClick, cls, title) {
      return el("button", { class: "spectra-lt-btn " + (cls || ""), onclick: onClick, title: title || null }, label);
    }

    function nameField() {
      const name = el("input", { class: "spectra-lt-input", placeholder: "Your name", maxlength: "32", value: panelBody.dataset.name || "" });
      name.addEventListener("input", () => { panelBody.dataset.name = name.value; store("name", name.value.trim()); });
      return name;
    }
    const nameVal = () => (panelBody.dataset.name || "").trim() || "Listener";

    function nowPlaying() {
      const st = room && room.state;
      if (!st || !st.uri) return el("div", { class: "spectra-lt-np empty" }, isHost() ? "Play something and everyone will hear it." : "Waiting for the host to play something…");
      return el("div", { class: "spectra-lt-np" },
        st.art ? el("img", { src: st.art, alt: "" }) : el("div", { class: "art" }),
        el("div", {}, el("strong", {}, st.title || "Unknown"), el("div", { class: "sub" }, (st.artist || "") + (st.playing ? "" : " · paused"))));
    }

    function memberRows() {
      const ms = (room && room.members) || [];
      const rows = ms.map((m) => {
        const badges = [m.host ? el("span", { class: "spectra-lt-badge host" }, "Host") : null, m.dj ? el("span", { class: "spectra-lt-badge dj" }, "DJ") : null,
          me && m.pid === me.pid ? el("span", { class: "spectra-lt-badge you" }, "You") : null];
        const actions = isHost() && !m.host ? el("div", { class: "spectra-lt-actions" },
          button(m.dj ? "Remove DJ" : "Make DJ", () => hostAction({ action: "set-dj", pid: m.pid, dj: !m.dj }), m.dj ? "small" : "small accent",
            m.dj ? "Stop them controlling the music" : "Let them add songs, play playlists, skip and pause"),
          (() => {
            const b = button("Remove", () => {
              if (b.dataset.sure) return hostAction({ action: "kick", pid: m.pid });
              b.dataset.sure = "1"; b.textContent = "Sure?";
              setTimeout(() => { if (b.isConnected) { delete b.dataset.sure; b.textContent = "Remove"; } }, 3000);
            }, "small danger", `Remove ${m.name} from the room`);
            return b;
          })()) : null;
        return el("div", { class: "spectra-lt-member" }, el("span", { class: "who" }, m.name, ...badges), actions);
      });
      return el("div", { class: "spectra-lt-members" }, el("div", { class: "spectra-lt-label" }, `In the room · ${ms.length}`), ...rows);
    }

    function djPanel() {
      const link = el("input", { class: "spectra-lt-input", placeholder: "Paste a Spotify link: song, album, playlist or artist", autocomplete: "off", spellcheck: "false" });
      const parse = () => {
        const u = SpectraURI.from(link.value.trim());
        if (!u) { showNotification("That isn't a Spotify link. Copy one with Share → Copy link.", true); return null; }
        return u.toURI();
      };
      const st = (room && room.state) || {};
      return el("div", { class: "spectra-lt-dj" },
        el("div", { class: "spectra-lt-label" }, isHost() ? "Quick controls" : "You're a DJ"),
        el("p", { class: "spectra-lt-intro" }, "Right-click any song, album or playlist in Spotify and pick “Add to Listen Together queue” or “Play in Listen Together room”, or paste a link here."),
        link,
        el("div", { class: "spectra-lt-row" },
          button("Add to queue", () => { const u = parse(); if (!u) return; if (!queueable(u)) return showNotification("Only songs and episodes can go in the queue. Use Play now for albums and playlists.", true); control({ type: "queue", uri: u }); link.value = ""; }),
          button("Play now", () => { const u = parse(); if (u) { control({ type: "play", uri: u }); link.value = ""; } })),
        el("div", { class: "spectra-lt-row" },
          button("Back", () => control({ type: "back" }), "small"),
          button(st.playing ? "Pause" : "Play", () => control({ type: st.playing ? "pause" : "resume" }), "small"),
          button("Skip", () => control({ type: "skip" }), "small")));
    }

    function browseView() {
      if (publicRooms === null) { loadPublic(); return [el("p", { class: "spectra-lt-intro" }, "Looking for rooms…")]; }
      const list = publicRooms.map((r) => el("div", { class: "spectra-lt-room" },
        r.nowPlaying && r.nowPlaying.art ? el("img", { src: r.nowPlaying.art, alt: "" }) : el("div", { class: "art" }, "🎧"),
        el("div", { class: "info" },
          el("strong", {}, r.roomName),
          el("div", { class: "sub" }, `${r.hostName} · ${r.listeners} listening`),
          r.nowPlaying ? el("div", { class: "sub np" }, `${r.nowPlaying.playing ? "♪" : "❚❚"} ${r.nowPlaying.title}${r.nowPlaying.artist ? " · " + r.nowPlaying.artist : ""}`) : null),
        button("Join", () => join(r.code, nameVal()), "small accent")));
      return [
        el("div", { class: "spectra-lt-row between" }, el("div", { class: "spectra-lt-label" }, `Public rooms · ${publicRooms.length}`), button("Refresh", () => { publicRooms = null; render(); }, "small")),
        browseError ? el("p", { class: "spectra-lt-status" }, browseError) : null,
        list.length ? el("div", { class: "spectra-lt-rooms" }, ...list)
          : el("div", { class: "spectra-lt-np empty" }, "No public rooms right now. Start one from Create a room."),
      ];
    }

    function codeView() {
      const code = el("input", { class: "spectra-lt-input code", placeholder: "ABC-123", maxlength: "7", autocomplete: "off", spellcheck: "false" });
      code.addEventListener("keydown", (e) => { if (e.key === "Enter") join(code.value, nameVal()); });
      setTimeout(() => code.focus(), 0);
      return [
        el("p", { class: "spectra-lt-intro" }, "Private rooms only work with their code. Ask the host for it."),
        el("div", { class: "spectra-lt-row" }, code, button("Join", () => join(code.value, nameVal()), "primary")),
      ];
    }

    function createView() {
      const roomName = el("input", { class: "spectra-lt-input", placeholder: `${nameVal()}'s room`, maxlength: "40", value: stored("roomName") });
      roomName.addEventListener("input", () => store("roomName", roomName.value.trim()));
      const choice = (value, title, sub) => el("button", {
        class: "spectra-lt-choice" + (createVisibility === value ? " on" : ""),
        onclick: () => { createVisibility = value; render(); },
      }, el("strong", {}, title), el("span", {}, sub));
      return [
        el("label", { class: "spectra-lt-label" }, "Room name"), roomName,
        el("div", { class: "spectra-lt-label" }, "Who can join"),
        el("div", { class: "spectra-lt-row" },
          choice("public", "🌐 Public", "Listed in Browse rooms. Anyone can join."),
          choice("private", "🔒 Private", "Hidden. Only people with the code.")),
        el("div", { class: "spectra-lt-row" }, button("Create room", () => create(nameVal(), roomName.value.trim(), createVisibility), "primary")),
      ];
    }

    function render() {
      if (togetherButton) togetherButton.active = !!session;
      pill();
      if (!panelBody || !panelBody.isConnected) { panelBody = null; return; }
      const parts = [];
      if (!session) {
        const tabs = [["browse", "Browse rooms"], ["code", "Join with code"], ["create", "Create a room"]];
        parts.push(
          el("p", { class: "spectra-lt-intro" }, "Listen to the same music at the same time as your friends. Everyone hears it on their own Spotify; Spectra keeps you in sync."),
          el("label", { class: "spectra-lt-label" }, "Your name"), nameField(),
          el("div", { class: "spectra-lt-tabs" }, ...tabs.map(([k, label]) => el("button", { class: "spectra-lt-tab" + (tab === k ? " on" : ""), onclick: () => { tab = k; status = ""; render(); } }, label))),
          ...(tab === "browse" ? browseView() : tab === "code" ? codeView() : createView()));
      } else if (isHost()) {
        const copy = button("Copy code", async () => {
          try { await navigator.clipboard.writeText(prettyCode(session.code)); copy.textContent = "Copied"; } catch { copy.textContent = "Select and copy it"; }
          setTimeout(() => (copy.textContent = "Copy code"), 1500);
        }, "small");
        const pub = room && room.visibility === "public";
        parts.push(
          el("div", { class: "spectra-lt-row between" },
            el("div", {}, el("div", { class: "spectra-lt-title" }, (room && room.roomName) || "Your room"),
              el("div", { class: "sub" }, pub ? "🌐 Public: listed in Browse rooms" : "🔒 Private: only people with the code")),
            button(pub ? "Make private" : "Make public", () => hostAction({ action: "settings", visibility: pub ? "private" : "public" }), "small")),
          el("div", { class: "spectra-lt-row" }, el("div", { class: "spectra-lt-code" }, prettyCode(session.code)), copy),
          nowPlaying(), memberRows(),
          el("p", { class: "spectra-lt-hint" }, "Make someone a DJ to let them add songs to the queue, play playlists, skip and pause. Everything they do happens on your Spotify, so everyone hears it."),
          djPanel(),
          el("div", { class: "spectra-lt-row end" }, button("End room", leave, "danger")));
      } else {
        parts.push(
          el("div", { class: "spectra-lt-title" }, (room && room.roomName) || `Room ${prettyCode(session.code)}`),
          el("p", { class: "spectra-lt-intro" }, `Hosted by ${(room && room.hostName) || "the host"} · code ${prettyCode(session.code)}` + (room && room.hostAway ? " · the host seems to be away" : "")),
          nowPlaying(), memberRows(),
          me && me.dj ? djPanel() : null,
          el("div", { class: "spectra-lt-row end" }, button("Sync now", () => follow(true)), button("Leave", leave, "danger")));
      }
      if (status) parts.push(el("p", { class: "spectra-lt-status" }, status));
      panelBody.replaceChildren(...parts.filter(Boolean));
    }

    async function open() {
      const body = el("div", { class: "spectra-lt" });
      body.dataset.name = await defaultName();
      panelBody = body;
      if (!session) { publicRooms = null; status = ""; }
      PopupModal.display({ title: "Listen Together", content: body, isLarge: false });
      render();
    }

    /** Small "in a room" badge, so people know they're being synced. */
    function pill() {
      let p = document.getElementById("spectra-lt-pill");
      if (!session) { if (p) p.remove(); return; }
      if (!p) {
        p = el("button", { id: "spectra-lt-pill", title: "Listen Together", onclick: open });
        onReady(() => document.body.append(p));
      }
      const n = room && room.members ? room.members.length : 1;
      const role = isHost() ? "Hosting" : me && me.dj ? "DJ" : "Listening together";
      p.textContent = `🎧 ${role} · ${(room && room.roomName) || prettyCode(session.code)} · ${n}`;
    }

    /** Its own button in Spotify's top bar, lit up while you're in a room. */
    function ensureButton(on) {
      if (!on) { if (togetherButton) togetherButton.deregister(); togetherButton = null; return; }
      if (togetherButton || !window.Spicetify?.Topbar) return;
      togetherButton = new window.Spicetify.Topbar.Button("Listen Together", "together", () => open());
      togetherButton.active = !!session;
    }

    return { open, resume, ensureButton, get active() { return !!session; } };
  })();

  // ------------------------------------------------------------------
  // 8. Apply payload
  // ------------------------------------------------------------------

  let spectraButton = null;
  function ensureSpectraButton(on) {
    if (!on) { if (spectraButton) spectraButton.deregister(); spectraButton = null; return; }
    if (spectraButton || !window.Spicetify?.Topbar) return;
    spectraButton = new window.Spicetify.Topbar.Button("Spectra", "spectra", (self) => {
      const items = [...menuItems];
      const base = [
        new MenuItem(isDesktop ? "Open Spectra" : "Open Spectra dashboard", false, () => post("openDashboard")),
        new MenuItem("Reload Spotify", false, () => location.reload()),
      ];
      openMenu(self.element, items.length ? [...items, "sep", ...base] : base, "Spectra");
    });
  }

  function post(type, data) {
    window.postMessage({ source: "spectra-runtime", type, data }, "*");
    // Desktop app: a CDP binding installed by Spectra's main process.
    if (typeof window.__spectraHost === "function") {
      try { window.__spectraHost(JSON.stringify({ type })); } catch {}
    }
  }

  let lastScriptsKey = null;
  let lastLooksKey = null;

  function apply(payload) {
    if (!payload || typeof payload !== "object") return;
    if (!document.documentElement) return whenRoot(() => apply(payload));
    state.payload = payload;
    if (payload.cssMap || payload.classMapExtra) setCssMap(Object.assign({}, payload.cssMap || {}, payload.classMapExtra || {}));

    const on = payload.enabled !== false;
    document.documentElement.classList.toggle("spectra", on);
    document.documentElement.dataset.spectraTheme = on && payload.themeName ? payload.themeName : "";

    setSheet("ui", UI_CSS);
    setSheet("colors", on ? payload.colorsCSS || "" : "");
    setSheet("theme", on ? mapThemeCSS(payload.themeCSS) : "");
    setSheet("hotfix", on ? mapThemeCSS(payload.hotfixCSS || "") : "");
    setSheet("snippets", on ? mapThemeCSS(payload.snippetsCSS) : "");
    setSheet("custom", on ? mapThemeCSS(payload.customCSS) : "");
    setRecolor(on && !!payload.recolor);

    // New CSS may un-hide the top bar: try the normal spot again.
    const looksKey = [on, payload.themeCSS, payload.snippetsCSS, payload.customCSS, payload.hotfixCSS].map((s) => String(s || "").length).join("|") + (payload.themeName || "");
    if (looksKey !== lastLooksKey) { lastLooksKey = looksKey; topbarFloat = false; }

    const scripts = on ? payload.scripts || [] : [];
    const wantClassCompat = on && payload.classCompat && scripts.length > 0;
    setDomClassCompat(wantClassCompat);

    if (window.Spicetify && window.Spicetify.__spectra) {
      window.Spicetify.Config.current_theme = payload.themeName || null;
      window.Spicetify.Config.color_scheme = payload.schemeName || null;
      window.Spicetify.Config.extensions = scripts.map((s) => s.name);
    }

    const key = scripts.map((s) => s.id + ":" + s.code.length).join("|");
    if (!state.scriptsLoaded) {
      state.scriptsLoaded = true;
      lastScriptsKey = key;
      if (on && payload.shim !== false) {
        try { installSpicetify(); } catch (e) { warn("Spicetify API setup failed", e); }
      }
      onReady(() => {
        try { ensureSpectraButton(on && payload.topbarButton !== false); } catch (e) { warn("Spectra button failed", e); }
        try { Together.ensureButton(on && payload.topbarButton !== false); } catch (e) { warn("Listen Together button failed", e); }
        if (scripts.length) loadScripts(scripts);
        // Rejoin a Listen Together room after Spotify reloads.
        if (on) setTimeout(() => { try { Together.resume(); } catch (e) { warn("Listen Together resume failed", e); } }, 1500);
      });
    } else {
      onReady(() => { ensureSpectraButton(on && payload.topbarButton !== false); Together.ensureButton(on && payload.topbarButton !== false); });
      // Compare against what actually runs in this page, so toggling back restores silence.
      onReady(() => {
        const existing = document.getElementById("spectra-reload-toast");
        if (key === lastScriptsKey) { if (existing) existing.remove(); return; }
        if (existing) return;
        showNotification("Extension changes take effect after a reload.", false, 0, { label: "Reload", onClick: () => location.reload(), id: "spectra-reload-toast" });
      });
    }
    watchDOM(mountButtons);
  }

  // ------------------------------------------------------------------
  // Wiring
  // ------------------------------------------------------------------

  window.addEventListener("message", (e) => {
    if (e.source !== window || !e.data || e.data.source !== "spectra-bridge") return;
    if (e.data.type === "payload") apply(e.data.payload);
    if (e.data.type === "toast") showNotification(e.data.message, !!e.data.isError);
  });

  window.__spectra = {
    version: VERSION, apply, isDesktop, state, recolorCSS, mapThemeCSS,
    // Diagnostics only: which Spotify credentials have been seen (never the values).
    authStatus: () => ({
      token: !!accessToken(),
      clientToken: !!spotifyAuth.clientToken,
      appPlatform: spotifyAuth.appPlatform || null,
      appVersion: !!spotifyAuth.appVersion,
    }),
  };
  post("ready");
  log(`runtime ${VERSION} (${isDesktop ? "desktop" : "web"})`);

  // Desktop: the Spectra app stores the latest payload before injecting us.
  if (window.__spectraPendingPayload) {
    const p = window.__spectraPendingPayload;
    delete window.__spectraPendingPayload;
    apply(p);
  }
})();
