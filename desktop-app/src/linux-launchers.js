// Linux side of "Always open Spotify with Spectra" and "Start Spectra at login".
//
// Spotify's menu entry is a .desktop file in a system folder. A file with the same
// name in ~/.local/share/applications takes priority over it (XDG spec), so we put
// our own copy there that runs a tiny launcher script. The script starts Spectra
// with --open-spotify, or, if Spectra has been removed, Spotify directly, so the
// menu entry can never end up broken. Turning the feature off deletes our copies.
"use strict";
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFile } = require("child_process");

const MARK = "X-Spectra-Launcher=true";
const NAMES = ["spotify.desktop", "spotify-client.desktop", "spotify_spotify.desktop", "com.spotify.Client.desktop"];

const home = os.homedir();
const dataHome = process.env.XDG_DATA_HOME || path.join(home, ".local", "share");
const configHome = process.env.XDG_CONFIG_HOME || path.join(home, ".config");
const userApps = path.join(dataHome, "applications");
const launcherScript = path.join(dataHome, "spectra", "open-spotify.sh");

function systemAppDirs() {
  const dirs = (process.env.XDG_DATA_DIRS || "/usr/local/share:/usr/share").split(":").filter(Boolean);
  dirs.push("/var/lib/snapd/desktop", "/var/lib/flatpak/exports/share", path.join(dataHome, "flatpak", "exports", "share"));
  return [...new Set(dirs)].map((d) => path.join(d, "applications"));
}

const read = (f) => { try { return fs.readFileSync(f, "utf8"); } catch { return null; } };
const ours = (text) => !!text && text.includes(MARK);
const shq = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;

/** The system's Spotify .desktop files: [{ name, file, text }]. */
function systemEntries() {
  const found = new Map();
  for (const dir of systemAppDirs()) {
    for (const name of NAMES) {
      if (found.has(name)) continue;
      const file = path.join(dir, name);
      const text = read(file);
      if (text && /^\s*Exec\s*=/m.test(text)) found.set(name, { name, file, text });
    }
  }
  return [...found.values()];
}

/** Where the running Spectra can be started from again (AppImage path, or the installed binary). */
function spectraBinary() {
  return process.env.APPIMAGE || process.execPath;
}

function refreshMenus() {
  execFile("update-desktop-database", [userApps], () => {});
}

/**
 * @param {{ port: number, spotifyPath: string|null, packaged: boolean }} o
 */
function enable(o) {
  const entries = systemEntries();
  if (!entries.length) return { supported: true, changed: [] };
  const flags = `--remote-debugging-port=${o.port} --remote-debugging-address=127.0.0.1`;
  fs.mkdirSync(path.dirname(launcherScript), { recursive: true });
  fs.mkdirSync(userApps, { recursive: true });

  // Development runs have no stable Spectra binary: just start Spotify with the flags.
  const spectra = o.packaged ? spectraBinary() : "";
  const fallback = o.spotifyPath ? `exec ${shq(o.spotifyPath)} ${flags} "$@"` : `exec spotify ${flags} "$@"`;
  const script = [
    "#!/bin/sh",
    "# Written by Spectra. Opens Spotify with Spectra attached.",
    spectra ? `SPECTRA=${shq(spectra)}` : "SPECTRA=",
    'if [ -n "$SPECTRA" ] && [ -x "$SPECTRA" ]; then exec "$SPECTRA" --open-spotify "$@"; fi',
    fallback,
    "",
  ].join("\n");
  if (read(launcherScript) !== script) fs.writeFileSync(launcherScript, script, { mode: 0o755 });
  try { fs.chmodSync(launcherScript, 0o755); } catch {}

  const changed = [];
  for (const e of entries) {
    const target = path.join(userApps, e.name);
    const existing = read(target);
    if (existing && !ours(existing)) continue; // the user's own override: leave it alone
    // Replace every Exec= (main entry and actions) with our launcher, keeping %U so spotify: links still work.
    let text = e.text.replace(/^(\s*Exec\s*=).*$/gm, `$1/bin/sh ${launcherScript.includes(" ") ? `"${launcherScript}"` : launcherScript} %U`);
    text = text.replace(/^\s*TryExec\s*=.*$/gm, "").replace(/\[Desktop Entry\]\s*\n/, `[Desktop Entry]\n${MARK}\n`);
    if (existing !== text) { fs.writeFileSync(target, text); changed.push(e.name); }
  }
  if (changed.length) refreshMenus();
  return { supported: true, changed };
}

function disable() {
  let removed = 0;
  for (const name of NAMES) {
    const f = path.join(userApps, name);
    if (ours(read(f))) { try { fs.unlinkSync(f); removed++; } catch {} }
  }
  try { fs.unlinkSync(launcherScript); } catch {}
  if (removed) refreshMenus();
}

// ---------------------------------------------------------------- start at login

const autostartFile = path.join(configHome, "autostart", "spectra.desktop");

function setAutostart(on) {
  if (!on) { if (ours(read(autostartFile))) try { fs.unlinkSync(autostartFile); } catch {} return; }
  const bin = spectraBinary();
  const text = [
    "[Desktop Entry]",
    MARK,
    "Type=Application",
    "Name=Spectra",
    "Comment=Themes and extensions for Spotify",
    `Exec=${bin.includes(" ") ? `"${bin}"` : bin} --background`,
    "Icon=spectra",
    "Terminal=false",
    "X-GNOME-Autostart-enabled=true",
    "",
  ].join("\n");
  const existing = read(autostartFile);
  if (existing === text || (existing && !ours(existing))) return;
  fs.mkdirSync(path.dirname(autostartFile), { recursive: true });
  fs.writeFileSync(autostartFile, text);
}

module.exports = { enable, disable, setAutostart };
