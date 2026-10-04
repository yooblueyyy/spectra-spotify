// Makes every normal way of opening Spotify (Start Menu, desktop & taskbar shortcuts,
// "open at login", spotify: links) start it ready for Spectra to attach.
// Originals are backed up and restored when the feature is turned off.
"use strict";
const fs = require("fs");
const path = require("path");
const { execFile } = require("child_process");
const { app, shell } = require("electron");

const RUN_KEY = "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run";
const PROTOCOL_KEY = "HKCU\\Software\\Classes\\spotify\\shell\\open\\command";
const FLAG_RE = /\s*--remote-debugging-(?:port|address)=\S+/g;
const HAS_FLAG = /--remote-debugging-port=/;

const OPEN_FLAG = "--open-spotify";
// Packaged app only: in development process.execPath is electron.exe.
const spectraExe = () => (app.isPackaged ? process.execPath : null);
const isSpectraExe = (p) => /(^|[\\/])spectra\.exe$/i.test(String(p || ""));
const isSpectraLauncher = (link) => isSpectraExe(link.target) && String(link.args || "").includes(OPEN_FLAG);
const flags = (port) => `--remote-debugging-port=${port} --remote-debugging-address=127.0.0.1`;
const strip = (s) => String(s || "").replace(FLAG_RE, "").trim();
const isSpotifyExe = (p) => /(^|[\\/])spotify\.exe$/i.test(String(p || "").replace(/"/g, ""));

function reg(args) {
  return new Promise((resolve) => execFile("reg", args, { windowsHide: true }, (err, stdout) => resolve(err ? null : String(stdout))));
}

async function regGet(key, name) {
  const out = await reg(["query", key, ...(name ? ["/v", name] : ["/ve"])]);
  if (!out) return null;
  const m = out.match(/REG_(?:EXPAND_)?SZ\s+(.*)\r?\n?/);
  return m ? m[1].trim() : null;
}

async function regSet(key, name, value) {
  return (await reg(["add", key, ...(name ? ["/v", name] : ["/ve"]), "/t", "REG_SZ", "/d", value, "/f"])) !== null;
}

function shortcutDirs() {
  const roaming = process.env.APPDATA || "";
  return [
    path.join(roaming, "Microsoft", "Windows", "Start Menu", "Programs"),
    app.getPath("desktop"),
    path.join(roaming, "Microsoft", "Internet Explorer", "Quick Launch"),
    path.join(roaming, "Microsoft", "Internet Explorer", "Quick Launch", "User Pinned", "TaskBar"),
    path.join(roaming, "Microsoft", "Internet Explorer", "Quick Launch", "User Pinned", "StartMenu"),
  ];
}

function spotifyShortcuts() {
  const found = [];
  for (const dir of shortcutDirs()) {
    let files = [];
    try { files = fs.readdirSync(dir).filter((f) => f.toLowerCase().endsWith(".lnk")); } catch { continue; }
    for (const f of files) {
      const file = path.join(dir, f);
      try {
        const link = shell.readShortcutLink(file);
        if (isSpotifyExe(link.target) || isSpectraLauncher(link)) found.push({ file, link });
      } catch {}
    }
  }
  return found;
}

class LaunchHooks {
  constructor() {
    this.backupFile = path.join(app.getPath("userData"), "spotify-launch-backup.json");
    try { this.backup = JSON.parse(fs.readFileSync(this.backupFile, "utf8")); } catch { this.backup = {}; }
  }

  saveBackup() {
    try { fs.writeFileSync(this.backupFile, JSON.stringify(this.backup, null, 2)); } catch {}
  }

  remember(id, original) {
    if (!(id in this.backup)) { this.backup[id] = original; this.saveBackup(); }
  }

  /**
   * Make every way of opening Spotify go through Spectra. Safe to call repeatedly.
   *  - Shortcuts (Start Menu, desktop, taskbar) launch Spectra itself with --open-spotify
   *    (keeping Spotify's icon), so opening Spotify always brings Spectra up, even if
   *    Spectra wasn't running. In development builds they just get the debug flags.
   *  - "Open at login" and spotify: links start Spotify with the debug flags; Spectra
   *    starts with Windows and attaches.
   */
  async enable(port, spotifyPath) {
    if (process.platform === "linux") return require("./linux-launchers").enable({ port, spotifyPath: spotifyPath || null, packaged: app.isPackaged });
    // macOS has no shortcut files to redirect; Spectra's "reopen a just-started Spotify" safety net covers it.
    if (process.platform !== "win32") return { supported: false };
    const want = flags(port);
    const exe = spectraExe();
    const changed = [];

    for (const { file, link } of spotifyShortcuts()) {
      try {
        if (exe) {
          if (isSpectraLauncher(link) && link.target.toLowerCase() === exe.toLowerCase()) continue;
          if (isSpotifyExe(link.target)) {
            this.remember("lnk:" + file, { target: link.target, args: strip(link.args), icon: link.icon || "", iconIndex: link.iconIndex || 0 });
          }
          const spotifyTarget = isSpotifyExe(link.target) ? link.target : this.originalTarget(file);
          shell.writeShortcutLink(file, "update", {
            target: exe,
            args: OPEN_FLAG,
            cwd: path.dirname(exe),
            icon: link.icon && !isSpectraExe(link.icon) ? link.icon : spotifyTarget || "",
            iconIndex: link.icon && !isSpectraExe(link.icon) ? link.iconIndex || 0 : 0,
          });
          changed.push(path.basename(file));
        } else {
          const args = link.args || "";
          const next = `${strip(args)} ${want}`.trim();
          if (!isSpotifyExe(link.target) || args.trim() === next) continue;
          this.remember("lnk:" + file, { target: link.target, args, icon: link.icon || "", iconIndex: link.iconIndex || 0 });
          shell.writeShortcutLink(file, "update", { args: next });
          changed.push(path.basename(file));
        }
      } catch {}
    }

    const run = await regGet(RUN_KEY, "Spotify");
    if (run && /spotify\.exe/i.test(run)) {
      const next = `${strip(run)} ${want}`;
      if (run !== next) {
        this.remember("run", run);
        if (await regSet(RUN_KEY, "Spotify", next)) changed.push("open at login");
      }
    }

    const proto = await regGet(PROTOCOL_KEY, null);
    if (proto && /spotify\.exe/i.test(proto)) {
      // Keep --protocol-uri="%1" last so Spotify still receives the link.
      const base = strip(proto);
      const next = base.replace(/(\.exe"?)\s*/i, `$1 ${want} `).trim();
      if (proto !== next) {
        this.remember("protocol", proto);
        if (await regSet(PROTOCOL_KEY, null, next)) changed.push("spotify: links");
      }
    }
    return { supported: true, changed };
  }

  /** Where a shortcut pointed before Spectra changed it. */
  originalTarget(file) {
    const b = this.backup["lnk:" + file];
    return (b && typeof b === "object" && b.target) || this.spotifyPath || null;
  }

  /** Put every launch path back exactly how it was. */
  async disable(spotifyPath) {
    if (process.platform === "linux") return require("./linux-launchers").disable();
    if (process.platform !== "win32") return;
    this.spotifyPath = spotifyPath || this.spotifyPath;
    for (const { file, link } of spotifyShortcuts()) {
      const b = this.backup["lnk:" + file];
      // Older backups stored only the arguments.
      const original = b && typeof b === "object" ? b : { target: isSpotifyExe(link.target) ? link.target : this.spotifyPath, args: typeof b === "string" ? b : strip(link.args), icon: "", iconIndex: 0 };
      if (!original.target) continue;
      try {
        shell.writeShortcutLink(file, "update", {
          target: original.target,
          args: original.args || "",
          cwd: path.dirname(original.target),
          icon: original.icon || original.target,
          iconIndex: original.iconIndex || 0,
        });
      } catch {}
    }
    const run = await regGet(RUN_KEY, "Spotify");
    if (run && HAS_FLAG.test(run)) await regSet(RUN_KEY, "Spotify", this.backup.run ? strip(this.backup.run) : strip(run));
    const proto = await regGet(PROTOCOL_KEY, null);
    if (proto && HAS_FLAG.test(proto)) await regSet(PROTOCOL_KEY, null, this.backup.protocol ? strip(this.backup.protocol) : strip(proto).replace(/\s{2,}/g, " "));
    this.backup = {};
    this.saveBackup();
  }
}

module.exports = { LaunchHooks };
