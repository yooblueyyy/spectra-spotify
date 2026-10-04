// Finds, launches and attaches to the Spotify desktop client over the
// Chrome DevTools Protocol. Nothing on disk is modified.
"use strict";
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn, exec } = require("child_process");
const { EventEmitter } = require("events");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function candidates() {
  const p = process.platform;
  if (p === "win32") {
    return [
      path.join(process.env.APPDATA || "", "Spotify", "Spotify.exe"),
      path.join(process.env.LOCALAPPDATA || "", "Spotify", "Spotify.exe"),
    ];
  }
  if (p === "darwin") {
    return ["/Applications/Spotify.app/Contents/MacOS/Spotify", path.join(os.homedir(), "Applications/Spotify.app/Contents/MacOS/Spotify")];
  }
  return [
    "/usr/bin/spotify", "/usr/local/bin/spotify", "/snap/bin/spotify", "/opt/spotify/spotify", "/usr/share/spotify/spotify",
    "/var/lib/flatpak/exports/bin/com.spotify.Client",
    path.join(os.homedir(), ".local/share/flatpak/exports/bin/com.spotify.Client"),
  ];
}

function detectSpotify() {
  return candidates().find((f) => { try { return fs.existsSync(f); } catch { return false; } }) || null;
}

function isStoreBuild() {
  if (process.platform !== "win32") return false;
  const dir = path.join(process.env.LOCALAPPDATA || "", "Microsoft", "WindowsApps");
  try { return fs.readdirSync(dir).some((f) => /^SpotifyAB\.SpotifyMusic/i.test(f)); } catch { return false; }
}

function run(cmd) {
  return new Promise((resolve) => exec(cmd, { windowsHide: true }, (err, stdout) => resolve(err ? "" : String(stdout))));
}

async function spotifyRunning() {
  if (process.platform === "win32") return /Spotify\.exe/i.test(await run('tasklist /FI "IMAGENAME eq Spotify.exe" /NH'));
  return (await run(`pgrep -x ${process.platform === "darwin" ? "Spotify" : "spotify"}`)).trim().length > 0;
}

/** Seconds since the oldest Spotify process started, or null if unknown. */
async function spotifyAgeSeconds() {
  if (process.platform === "win32") {
    const out = await run('powershell -NoProfile -Command "$p = Get-Process Spotify -ErrorAction SilentlyContinue | Sort-Object StartTime | Select-Object -First 1; if ($p) { [int]((Get-Date) - $p.StartTime).TotalSeconds }"');
    const n = parseInt(out.trim(), 10);
    return Number.isFinite(n) ? n : null;
  }
  // "etime" ([[dd-]hh:]mm:ss) works on both macOS and Linux; "etimes" is Linux-only.
  const pid = (await run(`pgrep -o -x ${process.platform === "darwin" ? "Spotify" : "spotify"}`)).trim();
  if (!/^\d+$/.test(pid)) return null;
  const m = (await run(`ps -o etime= -p ${pid}`)).trim().match(/^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)$/);
  if (!m) return null;
  return (+m[1] || 0) * 86400 + (+m[2] || 0) * 3600 + +m[3] * 60 + +m[4];
}

/**
 * Start Spotify with the given arguments. On macOS this goes through `open`, which
 * starts the app properly (Dock, menu bar) or just brings it forward if it's running.
 */
function launchSpotify(exe, args) {
  let cmd = exe, argv = args;
  const bundle = process.platform === "darwin" && exe.match(/^(.*?\.app)(\/|$)/);
  if (bundle) { cmd = "open"; argv = ["-a", bundle[1], "--args", ...args]; }
  const child = spawn(cmd, argv, { detached: true, stdio: "ignore" });
  child.unref();
  return child;
}

const debugFlags = (port) => [`--remote-debugging-port=${port}`, "--remote-debugging-address=127.0.0.1"];

async function killSpotify() {
  if (process.platform === "win32") await run("taskkill /IM Spotify.exe /F /T");
  else await run(`pkill -x ${process.platform === "darwin" ? "Spotify" : "spotify"}`);
}

class CDP {
  constructor(url) {
    this.ws = new WebSocket(url);
    this.id = 0;
    this.pending = new Map();
    this.handlers = new Map();
    this.closed = new Promise((r) => { this.ws.addEventListener("close", r); this.ws.addEventListener("error", r); });
    this.ws.addEventListener("message", (e) => {
      let msg;
      try { msg = JSON.parse(typeof e.data === "string" ? e.data : e.data.toString()); } catch { return; }
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result);
      } else if (msg.method) {
        for (const fn of this.handlers.get(msg.method) || []) fn(msg.params);
      }
    });
  }
  open() {
    return new Promise((resolve, reject) => {
      this.ws.addEventListener("open", resolve, { once: true });
      this.ws.addEventListener("error", () => reject(new Error("Could not connect to Spotify")), { once: true });
    });
  }
  send(method, params = {}) {
    const id = ++this.id;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      setTimeout(() => { if (this.pending.delete(id)) reject(new Error(method + " timed out")); }, 15000);
    });
  }
  on(method, fn) {
    if (!this.handlers.has(method)) this.handlers.set(method, []);
    this.handlers.get(method).push(fn);
  }
  close() { try { this.ws.close(); } catch {} }
}

/**
 * Events: "status" (status object), "host" (message object from the runtime).
 */
class SpotifyManager extends EventEmitter {
  /**
   * @param {{ settings: () => {spotifyPath: string, debugPort: number}, runtimeSource: () => string, payload: () => object }} opts
   */
  constructor(opts) {
    super();
    this.opts = opts;
    this.session = null;
    this.bootstrapId = null;
    this.version = null;
    this.state = "not-running";
    this.message = "";
    this.busy = false;
    this.loopTimer = null;
  }

  get port() { return +this.opts.settings().debugPort || 9333; }
  exePath() { return this.opts.settings().spotifyPath || detectSpotify(); }

  status() {
    return { state: this.state, message: this.message, version: this.version, detectedPath: detectSpotify() };
  }

  setState(state, message) {
    if (this.state === state && this.message === message) return;
    this.state = state;
    this.message = message || "";
    this.emit("status", this.status());
  }

  async cdpJSON(p) {
    const res = await fetch(`http://127.0.0.1:${this.port}${p}`, { signal: AbortSignal.timeout(1500) });
    return res.json();
  }

  async portAlive() {
    try { await this.cdpJSON("/json/version"); return true; } catch { return false; }
  }

  startLoop() {
    if (this.loopTimer) return;
    const tick = async () => {
      try { await this.check(); } catch {}
      this.loopTimer = setTimeout(tick, this.session ? 4000 : 1500);
    };
    tick();
  }

  async check() {
    if (this.session || this.busy) return;
    if (await this.portAlive()) {
      try { await this.attach(); } catch (e) { this.setState("error", e.message); }
      return;
    }
    if (await spotifyRunning()) {
      // Safety net for launch paths Spectra couldn't hook: if Spotify *just* opened,
      // restart it with Spectra right away. Never touch a Spotify that has been
      // running a while — it might be playing music.
      if (this.opts.autoRestartFresh && this.opts.autoRestartFresh() && Date.now() - (this.lastAutoRestart || 0) > 60000) {
        const age = await spotifyAgeSeconds();
        if (age != null && age < 30) {
          this.lastAutoRestart = Date.now();
          this.emit("auto-restart");
          const r = await this.start({ restart: true });
          if (r && r.ok) return;
        }
      }
      this.setState("running-without-spectra", "Spotify was opened in a way Spectra couldn't catch. Restart it from here and it connects.");
    } else if (!this.exePath()) {
      this.setState("not-found", isStoreBuild()
        ? "You have the Microsoft Store version of Spotify, which doesn't allow this. Install Spotify from spotify.com/download instead."
        : "Install Spotify, or set its location below.");
    } else {
      this.setState("not-running", "Start Spotify from here and Spectra applies your theme and extensions.");
    }
  }

  /** Launch Spotify with a local-only debugging port (optionally restarting it). */
  async start({ restart = false } = {}) {
    if (this.session || this.busy) return { ok: true };
    const exe = this.exePath();
    if (!exe) { await this.check(); return { error: "Spotify wasn't found. Set its location in the Spotify page." }; }
    this.busy = true;
    try {
      if (await this.portAlive()) return { ok: true };
      if (await spotifyRunning()) {
        if (!restart) return { error: "Spotify is already running." };
        this.setState("starting", "Closing Spotify…");
        await killSpotify();
        for (let i = 0; i < 40 && (await spotifyRunning()); i++) await sleep(200);
      }
      this.setState("starting", "Opening Spotify…");
      const child = launchSpotify(exe, debugFlags(this.port));
      child.on("error", (e) => this.setState("error", "Couldn't start Spotify: " + e.message));
      for (let i = 0; i < 60; i++) {
        if (await this.portAlive()) break;
        await sleep(500);
      }
      if (!(await this.portAlive())) {
        this.setState("error", "Spotify opened but didn't allow Spectra to connect. Your Spotify version may block it.");
        return { error: this.message };
      }
      for (let i = 0; i < 30 && !this.session; i++) {
        try { await this.attach(); } catch { await sleep(500); }
      }
      return this.session ? { ok: true } : { error: "Spotify's window didn't load in time. Try again." };
    } finally {
      this.busy = false;
    }
  }

  pickTarget(list) {
    const pages = list.filter((t) => t.type === "page" && t.webSocketDebuggerUrl && !/^(devtools|chrome|edge):/.test(t.url));
    return pages.find((t) => /xpui|spotify/i.test(t.url)) || null;
  }

  bootstrapSource() {
    const payload = this.opts.payload();
    return `;(function(){try{window.__spectraPendingPayload=${JSON.stringify(payload)};window.__spectraBuild=${JSON.stringify(this.runtimeBuild())};}catch(e){}})();\n${this.opts.runtimeSource()}`;
  }

  /** Fingerprint of the runtime this app ships, so an older one left in Spotify can be spotted. */
  runtimeBuild() {
    const src = this.opts.runtimeSource();
    if (this._buildFor !== src) { this._buildFor = src; this._build = require("crypto").createHash("sha1").update(src).digest("hex").slice(0, 12); }
    return this._build;
  }

  /**
   * Spotify still runs an older Spectra (Spectra was updated while Spotify stayed open).
   * Reload right away if nothing is playing; otherwise ask, so music isn't cut off.
   */
  async refreshStaleRuntime(s) {
    const r = await s.send("Runtime.evaluate", { expression: "(function(){try{return !!(window.Spicetify&&window.Spicetify.Player&&window.Spicetify.Player.isPlaying());}catch(e){return false;}})()", returnByValue: true }).catch(() => null);
    const playing = !!(r && r.result && r.result.value);
    if (!playing) { await s.send("Page.reload", { ignoreCache: false }); return; }
    const toast = `(function(){
      if (document.getElementById("spectra-update-toast")) return;
      var t = document.createElement("div");
      t.id = "spectra-update-toast";
      t.setAttribute("style", "position:fixed;left:50%;bottom:110px;transform:translateX(-50%);z-index:2147483000;display:flex;gap:12px;align-items:center;padding:10px 16px;border-radius:8px;background:#4687d6;color:#fff;font:500 14px/1.4 system-ui,sans-serif;box-shadow:0 8px 24px rgba(0,0,0,.45)");
      t.textContent = "Spectra was updated. Reload Spotify to get the new features.";
      var b = document.createElement("button");
      b.textContent = "Reload";
      b.setAttribute("style", "all:unset;cursor:pointer;font-weight:700;padding:4px 10px;border-radius:999px;background:rgba(255,255,255,.2)");
      b.onclick = function(){ location.reload(); };
      var x = document.createElement("button");
      x.textContent = "Later";
      x.setAttribute("style", "all:unset;cursor:pointer;opacity:.8;padding:4px 6px");
      x.onclick = function(){ t.remove(); };
      t.append(b, x);
      document.body.append(t);
    })()`;
    await s.send("Runtime.evaluate", { expression: toast }).catch(() => {});
  }

  async refreshBootstrap(s) {
    if (this.bootstrapId) { try { await s.send("Page.removeScriptToEvaluateOnNewDocument", { identifier: this.bootstrapId }); } catch {} }
    const r = await s.send("Page.addScriptToEvaluateOnNewDocument", { source: this.bootstrapSource() });
    this.bootstrapId = r.identifier;
  }

  async attach() {
    const target = this.pickTarget(await this.cdpJSON("/json/list"));
    if (!target) throw new Error("Waiting for Spotify's window…");
    const s = new CDP(target.webSocketDebuggerUrl);
    await s.open();
    try {
      await s.send("Page.enable");
      await s.send("Runtime.enable");
      await s.send("Page.setBypassCSP", { enabled: true }).catch(() => {});
      await s.send("Runtime.addBinding", { name: "__spectraHost" }).catch(() => {});
      s.on("Runtime.bindingCalled", (p) => {
        if (p.name !== "__spectraHost") return;
        try { this.emit("host", JSON.parse(p.payload)); } catch {}
      });
      this.bootstrapId = null;
      await this.refreshBootstrap(s);
      const ua = await s.send("Runtime.evaluate", { expression: "navigator.userAgent", returnByValue: true }).catch(() => null);
      const m = ua && ua.result && String(ua.result.value).match(/Spotify\/([\d.]+)/);
      this.version = m ? m[1] : null;
      const has = await s.send("Runtime.evaluate", { expression: "window.__spectra ? String(window.__spectraBuild || 'old') : ''", returnByValue: true }).catch(() => null);
      const inPage = (has && has.result && has.result.value) || "";
      // A reload lets the runtime start at document-start (no flash of stock Spotify).
      if (!inPage) await s.send("Page.reload", { ignoreCache: false });
      else if (inPage !== this.runtimeBuild()) await this.refreshStaleRuntime(s);
    } catch (e) {
      s.close();
      throw e;
    }
    this.session = s;
    this.setState("connected", this.version ? `Spotify ${this.version}. Changes you make here appear in Spotify straight away.` : "Changes you make here appear in Spotify straight away.");
    s.closed.then(() => {
      if (this.session !== s) return;
      this.session = null;
      this.bootstrapId = null;
      this.setState("not-running", "Spotify was closed.");
      this.check().catch(() => {});
    });
  }

  /** Apply a new payload to the running Spotify immediately, and for future reloads. */
  async push() {
    const s = this.session;
    if (!s) return false;
    await this.refreshBootstrap(s);
    const payload = JSON.stringify(this.opts.payload());
    const expr = `(function(P){ if (window.__spectra) { window.__spectra.apply(P); return true; } window.__spectraPendingPayload = P; ${this.opts.runtimeSource()}\n; return true; })(${payload})`;
    const r = await s.send("Runtime.evaluate", { expression: expr });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.text || "Spotify rejected the update");
    return true;
  }

  async reload() {
    if (!this.session) return false;
    await this.session.send("Page.reload", { ignoreCache: false });
    return true;
  }

  dispose() {
    clearTimeout(this.loopTimer);
    if (this.session) this.session.close();
  }
}

module.exports = { SpotifyManager, detectSpotify, launchSpotify, debugFlags };
