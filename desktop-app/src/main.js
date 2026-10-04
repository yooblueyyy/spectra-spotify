// Spectra desktop app: main process.
"use strict";
const { app, BrowserWindow, ipcMain, Tray, Menu, shell, nativeTheme, nativeImage, Notification } = require("electron");
const path = require("path");
const fs = require("fs");
const { Store } = require("./store");
const { SpotifyManager, detectSpotify, launchSpotify, debugFlags } = require("./spotify");
const { LaunchHooks } = require("./launch-hooks");
const { buildDesktopClassMap } = require("./classmap");
const { DiscordPresence } = require("./discord-rpc");

const UI = path.join(__dirname, "..", "ui");
require(path.join(UI, "shared", "core.js"));
const Core = globalThis.SpectraCore;

const CSS_MAP_URL = "https://raw.githubusercontent.com/spicetify/cli/main/css-map.json";
const CSS_MAP_TTL = 24 * 60 * 60 * 1000;
const ICON = path.join(UI, "icons", "icon-128.png");

if (process.argv.includes("--restore-launchers")) {
  // Run by the uninstaller: put Spotify's shortcuts and registry entries back, then exit.
  app.whenReady().then(async () => {
    try {
      const { LaunchHooks } = require("./launch-hooks");
      await new LaunchHooks().disable(detectSpotify());
    } catch (e) { console.error(e); }
    app.exit(0);
  });
} else if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.setAppUserModelId("app.spectra.desktop");
  nativeTheme.themeSource = "dark";

  let win = null;
  let tray = null;
  let quitting = false;
  let firstRun = false;
  let trayHintShown = false;

  const store = new Store(path.join(app.getPath("userData"), "spectra-settings.json"));
  if (!store.get("state").state) firstRun = true;
  store.set({ state: Core.normalizeState(store.get("state").state) });

  const appSettings = () => Core.normalizeState(store.get("state").state).app;
  const runtimePath = path.join(UI, "runtime", "spectra-runtime.js");
  let runtimeCache = null;
  const runtimeSource = () => (runtimeCache = runtimeCache || fs.readFileSync(runtimePath, "utf8"));

  function payload() {
    const { state, cssMap, desktopClassMap, remote } = store.get(["state", "cssMap", "desktopClassMap", "remote"]);
    const p = Core.compilePayload(state, remote && remote.data, { platform: "desktop", allowRemoteScripts: true });
    // Spicetify's map plus the entries we derived for this exact Spotify build.
    p.cssMap = cssMap ? Object.assign({}, cssMap.map, desktopClassMap ? desktopClassMap.map : null) : null;
    return p;
  }

  // ---------------------------------------------------------------- Discord Rich Presence
  const appConfig = (() => { try { return JSON.parse(fs.readFileSync(path.join(UI, "app-config.json"), "utf8")); } catch { return {}; } })();
  const presence = appConfig.discordClientId ? new DiscordPresence(appConfig.discordClientId) : null;
  const presenceSince = Date.now();
  function updatePresence() {
    if (!presence) return;
    const s = Core.normalizeState(store.get("state").state);
    const on = s.app.discordPresence && s.enabled && spotify.status().state === "connected";
    if (!on) { presence.set(null); return; }
    const theme = s.theme ? s.theme.name : null;
    const site = appConfig.site || "https://usespectra.xyz";
    presence.set({
      details: "Theming Spotify",
      state: theme ? `${theme}${s.scheme ? " · " + s.scheme : ""}` : "Stock look, for now",
      timestamps: { start: presenceSince },
      // No image here on purpose: Discord then shows the application's icon (the Spectra logo).
      buttons: [{ label: "Get Spectra", url: `${site}/download` }],
    });
  }

  // ---------------------------------------------------------------- update server (remote config)
  let remoteInflight = null;
  function ensureRemote(force) {
    const { remote, state } = store.get(["remote", "state"]);
    if (!force && remote && remote.fetchedAt && Date.now() - remote.fetchedAt < Core.REMOTE_TTL) return Promise.resolve(remote);
    if (remoteInflight) return remoteInflight;
    const base = Core.apiBase(Core.normalizeState(state));
    remoteInflight = (async () => {
      try {
        const res = await fetch(base + "/api/manifest", { cache: "no-cache", signal: AbortSignal.timeout(15000) });
        if (!res.ok) throw new Error("HTTP " + res.status);
        const next = { data: await res.json(), fetchedAt: Date.now(), from: base };
        const changed = JSON.stringify(next.data) !== JSON.stringify(remote && remote.data);
        broadcast(store.set({ remote: next }));
        if (changed) schedulePush();
        return next;
      } catch (e) {
        if (remote) broadcast(store.set({ remote: Object.assign({}, remote, { fetchedAt: Date.now(), error: String(e.message || e) }) }));
        return remote || null;
      } finally {
        remoteInflight = null;
      }
    })();
    return remoteInflight;
  }

  // ---------------------------------------------------------------- self-healing class map
  let classMapBusy = null;
  function refreshClassMap() {
    if (classMapBusy) return classMapBusy;
    classMapBusy = (async () => {
      const exe = spotify.exePath();
      const { cssMap, desktopClassMap } = store.get(["cssMap", "desktopClassMap"]);
      if (!exe || !cssMap || !cssMap.map) return;
      try {
        const next = await buildDesktopClassMap({
          spotifyExe: exe,
          cssMap: cssMap.map,
          cssMapStamp: cssMap.fetchedAt,
          cacheDir: path.join(app.getPath("userData"), "cache"),
          previous: desktopClassMap,
          log: (m) => console.log("[Spectra] " + m),
        });
        if (next && next !== desktopClassMap) {
          store.set({ desktopClassMap: next });
          schedulePush();
        }
      } catch (e) {
        console.warn("[Spectra] class map rebuild failed:", e.message);
      }
    })().finally(() => { classMapBusy = null; });
    return classMapBusy;
  }

  const spotify = new SpotifyManager({
    settings: appSettings,
    runtimeSource,
    payload,
    autoRestartFresh: () => appSettings().alwaysWithSpectra,
  });

  // Started at login by Windows: stay in the tray instead of popping a window.
  // --background: started with Windows. --open-spotify: started from a Spotify shortcut.
  // Either way, stay in the tray instead of popping the Spectra window.
  const openSpotifyArg = (argv) => argv.includes("--open-spotify");
  // macOS login items can't pass arguments, so ask the system instead.
  const openedAtLogin = process.platform === "darwin" && (() => { try { return !!app.getLoginItemSettings().wasOpenedAtLogin; } catch { return false; } })();
  const startedHidden = process.argv.includes("--background") || openSpotifyArg(process.argv) || openedAtLogin;
  // macOS: no Dock icon while Spectra only lives in the menu bar.
  const dock = (show) => { if (process.platform === "darwin" && app.dock) { if (show) app.dock.show(); else app.dock.hide(); } };

  /** A Spotify shortcut was used: start (or bring up) Spotify, ready for Spectra to attach. */
  function openSpotify(argv) {
    const exe = spotify.exePath();
    if (!exe) { showWindow(); return; }
    const port = appSettings().debugPort || 9333;
    // Linux menu entries pass spotify: links through to us; hand them on.
    const uri = (argv || []).find((a) => /^spotify:/i.test(a));
    // If Spotify is already running this just brings its window forward.
    launchSpotify(exe, [...debugFlags(port), ...(uri ? [`--uri=${uri}`] : [])]).on("error", () => showWindow());
  }

  // ---------------------------------------------------------------- "always open Spotify with Spectra"
  const hooks = new LaunchHooks();
  let lastHookKey = null;
  async function syncLaunchSettings(force) {
    const s = appSettings();
    const key = `${s.alwaysWithSpectra}|${s.debugPort}|${s.startWithWindows}`;
    if (!force && key === lastHookKey) return;
    lastHookKey = key;
    try {
      if (s.alwaysWithSpectra) await hooks.enable(s.debugPort, spotify.exePath());
      else await hooks.disable();
    } catch (e) { console.warn("[Spectra] launch hooks:", e.message); }
    // Only a packaged app has a stable path to register for login.
    if (app.isPackaged && (process.platform === "win32" || process.platform === "darwin")) {
      app.setLoginItemSettings({ openAtLogin: !!s.startWithWindows, args: ["--background"] });
    } else if (app.isPackaged && process.platform === "linux") {
      try { require("./linux-launchers").setAutostart(!!s.startWithWindows); } catch (e) { console.warn("[Spectra] autostart:", e.message); }
    }
  }

  // ---------------------------------------------------------------- css-map
  async function ensureCssMap(force) {
    const { cssMap } = store.get("cssMap");
    if (!force && cssMap && cssMap.map && Date.now() - cssMap.fetchedAt < CSS_MAP_TTL) return true;
    try {
      const res = await fetch(CSS_MAP_URL, { cache: "no-cache" });
      if (!res.ok) throw new Error("HTTP " + res.status);
      const map = await res.json();
      broadcast(store.set({ cssMap: { map, fetchedAt: Date.now() } }));
      schedulePush();
      return true;
    } catch (e) {
      console.warn("[Spectra] css-map fetch failed:", e.message);
      return !!(cssMap && cssMap.map);
    }
  }

  // ---------------------------------------------------------------- live push to Spotify
  let pushTimer = null;
  function schedulePush() {
    clearTimeout(pushTimer);
    pushTimer = setTimeout(() => spotify.push().catch((e) => console.warn("[Spectra] push failed:", e.message)), 120);
  }

  function broadcast(changes) {
    for (const w of BrowserWindow.getAllWindows()) w.webContents.send("storage-changed", changes);
  }

  // ---------------------------------------------------------------- window
  function showWindow() {
    if (!win) { createWindow(); win.__userOpened = true; return; }
    win.__userOpened = true;
    dock(true);
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
  }

  function createWindow() {
    win = new BrowserWindow({
      width: 1320,
      height: 860,
      minWidth: 900,
      minHeight: 600,
      title: "Spectra",
      icon: ICON,
      show: false,
      backgroundColor: "#0b0b0f",
      titleBarStyle: process.platform === "darwin" ? "hiddenInset" : "hidden",
      titleBarOverlay: process.platform === "darwin" ? undefined : { color: "#0b0b0f", symbolColor: "#a1a1ad", height: 36 },
      webPreferences: {
        preload: path.join(__dirname, "preload.js"),
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false,
        spellcheck: false,
      },
    });
    win.setMenuBarVisibility(false);
    win.loadFile(path.join(UI, "dashboard", "index.html"), { hash: firstRun ? "welcome" : "themes" });
    firstRun = false;
    win.once("ready-to-show", () => {
      if (!startedHidden || win.__userOpened) win.show();
      else dock(false);
    });

    // Links open in the user's browser; the window itself never navigates away.
    win.webContents.setWindowOpenHandler(({ url }) => {
      if (/^https?:\/\//i.test(url)) shell.openExternal(url);
      return { action: "deny" };
    });
    win.webContents.on("will-navigate", (e, url) => {
      if (!url.startsWith("file://")) { e.preventDefault(); if (/^https?:\/\//i.test(url)) shell.openExternal(url); }
    });

    win.on("close", (e) => {
      if (quitting || !appSettings().closeToTray || !tray) return;
      e.preventDefault();
      win.hide();
      dock(false);
      if (!trayHintShown && Notification.isSupported()) {
        trayHintShown = true;
        new Notification({ title: "Spectra is still running", body: "Your theme stays active in Spotify. Quit from the tray icon.", icon: ICON }).show();
      }
    });
    win.on("closed", () => { win = null; });
  }

  function createTray() {
    const img = nativeImage.createFromPath(path.join(UI, "icons", process.platform === "darwin" ? "icon-16.png" : "icon-32.png"));
    tray = new Tray(img);
    tray.setToolTip("Spectra");
    const rebuild = () => {
      const st = spotify.status();
      tray.setContextMenu(Menu.buildFromTemplate([
        { label: "Open Spectra", click: showWindow },
        { type: "separator" },
        { label: st.state === "connected" ? "Spotify: connected" : "Spotify: not connected", enabled: false },
        st.state === "connected"
          ? { label: "Reload Spotify", click: () => spotify.reload() }
          : { label: st.state === "running-without-spectra" ? "Restart Spotify with Spectra" : "Start Spotify", click: () => spotify.start({ restart: true }) },
        { type: "separator" },
        { label: "Quit Spectra", click: () => { quitting = true; app.quit(); } },
      ]));
    };
    rebuild();
    spotify.on("status", rebuild);
    tray.on("click", showWindow);
  }

  // ---------------------------------------------------------------- IPC (mirrors the browser extension's APIs)
  ipcMain.handle("storage:get", (e, keys) => store.get(keys));
  ipcMain.handle("storage:set", (e, obj) => {
    const changes = store.set(obj);
    broadcast(changes);
    if (changes.state) { schedulePush(); syncLaunchSettings(false); updatePresence(); }
    return true;
  });
  ipcMain.handle("message", async (e, msg) => {
    switch (msg && msg.type) {
      case "spotifyStatus": return spotify.status();
      case "spotifyStart": return spotify.start({ restart: !!msg.restart });
      case "reloadSpotifyTabs": return { ok: await spotify.reload().catch(() => false) };
      case "ensureCssMap": return { ok: await ensureCssMap(!!msg.force) };
      case "ensureRemote": { const r = await ensureRemote(!!msg.force); return { ok: !!(r && r.data), fetchedAt: r && r.fetchedAt, error: r && r.error }; }
      case "appInfo": return { platform: "desktop", version: app.getVersion() };
      case "openDashboard": showWindow(); return { ok: true };
      default: return { ok: false };
    }
  });

  spotify.on("status", (st) => { if (st.state === "connected") refreshClassMap(); updatePresence(); });
  spotify.on("status", (st) => { for (const w of BrowserWindow.getAllWindows()) w.webContents.send("spotify-status", st); });
  spotify.on("host", (m) => { if (m && m.type === "openDashboard") showWindow(); });
  spotify.on("auto-restart", () => {
    if (Notification.isSupported()) new Notification({ title: "Spectra", body: "Reopening Spotify with your theme and extensions…", icon: ICON, silent: true }).show();
  });

  app.on("second-instance", (e, argv) => (openSpotifyArg(argv) ? openSpotify(argv) : showWindow()));
  app.on("before-quit", () => { quitting = true; store.flush(); spotify.dispose(); if (presence) presence.stop(); });
  app.on("window-all-closed", () => { if (!tray || !appSettings().closeToTray) app.quit(); });
  app.on("activate", () => { if (app.isReady()) showWindow(); });

  app.whenReady().then(async () => {
    createWindow();
    createTray();
    await syncLaunchSettings(true);
    if (presence) { presence.start(); updatePresence(); }
    // Spotify updates can rewrite its shortcuts; quietly re-apply now and then.
    setInterval(() => { if (appSettings().alwaysWithSpectra) syncLaunchSettings(true); }, 10 * 60 * 1000);
    await ensureCssMap(false);
    ensureRemote(true);
    setInterval(() => ensureRemote(false), Core.REMOTE_TTL);
    refreshClassMap();
    spotify.startLoop();
    if (openSpotifyArg(process.argv)) {
      openSpotify(process.argv);
    } else if (appSettings().autoLaunch && !startedHidden) {
      // Never force-close a Spotify the user already has open; the Spotify page offers a restart instead.
      setTimeout(() => spotify.start({ restart: false }).catch(() => {}), 500);
    }
  });
}
