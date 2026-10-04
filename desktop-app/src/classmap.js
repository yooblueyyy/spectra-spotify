// Self-healing class map for the Spotify desktop client.
//
// Spicetify's css-map.json lags behind Spotify releases. When the installed
// Spotify has rehashed its class names, we rebuild the map by matching the
// installed build against the current web player build (which css-map covers
// better) using shared/classmatch.js. Results are cached until either side changes.
"use strict";
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { readZip } = require("./zip");

const UA = { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36" };
const WEB_BASE = "https://open.spotifycdn.com/cdn/build/web-player/";

function chunkMaps(src, fnPattern) {
  const i = src.search(fnPattern);
  if (i < 0) return null;
  const seg = src.slice(i, i + 400000);
  const objs = [...seg.matchAll(/\(\{((?:\s*(?:"[^"]+"|\d+)\s*:\s*"[^"]*"\s*,?)+)\}\)/g)]
    .slice(0, 2)
    .map((m) => Object.fromEntries([...m[1].matchAll(/("[^"]+"|\d+)\s*:\s*"([^"]*)"/g)].map((x) => [x[1].replace(/"/g, ""), x[2]])));
  if (!objs.length) return null;
  const isHashes = (o) => Object.values(o).every((v) => /^[0-9a-f]{8}$/.test(v));
  return isHashes(objs[0]) ? { names: {}, hashes: objs[0] } : { names: objs[0], hashes: objs[1] || {} };
}

async function fetchText(url) {
  const res = await fetch(url, { headers: UA, signal: AbortSignal.timeout(30000) });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.text();
}

async function pool(items, n, fn) {
  const out = [];
  let i = 0;
  await Promise.all(Array.from({ length: n }, async () => {
    while (i < items.length) { const idx = i++; try { out[idx] = await fn(items[idx]); } catch { out[idx] = ""; } }
  }));
  return out;
}

/** Download the current web player's complete CSS + JS (cached by build id). */
async function webReference(cacheDir) {
  const html = await fetchText("https://open.spotify.com/");
  const m = html.match(/https:\/\/open\.spotifycdn\.com\/cdn\/build\/web-player\/web-player\.([\w]+)\.js/);
  if (!m) throw new Error("Couldn't find the web player bundle");
  const buildId = m[1];
  const cacheFile = path.join(cacheDir, `web-reference-${buildId}.json`);
  try { return { buildId, ...JSON.parse(fs.readFileSync(cacheFile, "utf8")) }; } catch {}

  const mainJs = await fetchText(m[0]);
  const jsMap = chunkMaps(mainJs, /\.u=\w+=>/);
  const cssMapFn = chunkMaps(mainJs, /\.miniCssF=\w+=>/);
  const cssUrls = new Set([...html.matchAll(/https:\/\/open\.spotifycdn\.com\/cdn\/build\/web-player\/[\w.-]+\.css/g)].map((x) => x[0]));
  if (cssMapFn) for (const id of Object.keys(cssMapFn.hashes)) cssUrls.add(`${WEB_BASE}${cssMapFn.names[id] || id}.${cssMapFn.hashes[id]}.css`);
  const jsUrls = jsMap ? Object.keys(jsMap.hashes).map((id) => `${WEB_BASE}${jsMap.names[id] || id}.${jsMap.hashes[id]}.js`) : [];
  const css = (await pool([...cssUrls], 8, fetchText)).join("\n");
  const js = mainJs + "\n" + (await pool(jsUrls, 8, fetchText)).join("\n");

  fs.mkdirSync(cacheDir, { recursive: true });
  for (const f of fs.readdirSync(cacheDir)) if (f.startsWith("web-reference-")) fs.rmSync(path.join(cacheDir, f), { force: true });
  fs.writeFileSync(cacheFile, JSON.stringify({ css, js }));
  return { buildId, css, js };
}

/** Read the installed desktop client's CSS + JS straight from xpui.spa. */
function findXpui(spotifyExe) {
  // /usr/bin/spotify is usually a symlink into /usr/share/spotify or /opt/spotify.
  let real = spotifyExe;
  try { real = fs.realpathSync(spotifyExe); } catch {}
  const dir = path.dirname(real);
  const list = [
    path.join(dir, "Apps", "xpui.spa"),                     // Windows, /opt/spotify, /usr/share/spotify
    path.join(dir, "..", "Resources", "Apps", "xpui.spa"),  // macOS: Spotify.app/Contents/MacOS → Resources
    "/usr/share/spotify/Apps/xpui.spa",
    "/opt/spotify/Apps/xpui.spa",
    "/snap/spotify/current/usr/share/spotify/Apps/xpui.spa",
    "/var/lib/flatpak/app/com.spotify.Client/current/active/files/extra/share/spotify/Apps/xpui.spa",
    path.join(require("os").homedir(), ".local/share/flatpak/app/com.spotify.Client/current/active/files/extra/share/spotify/Apps/xpui.spa"),
  ];
  return list.find((f) => { try { return fs.statSync(f).isFile(); } catch { return false; } }) || list[0];
}

function desktopTarget(spotifyExe) {
  const spa = findXpui(spotifyExe);
  const st = fs.statSync(spa);
  let css = "", js = "";
  for (const e of readZip(spa)) {
    if (e.name.endsWith(".css")) css += "\n" + e.read().toString("utf8");
    else if (e.name.endsWith(".js")) js += "\n" + e.read().toString("utf8");
  }
  return { id: `${st.size}-${st.mtimeMs}`, css, js };
}

/**
 * @returns {Promise<{ map: object, stats: object, key: string } | null>}
 *   extra hashed -> readable entries for the installed Spotify, or null when not needed/possible.
 */
async function buildDesktopClassMap({ spotifyExe, cssMap, cssMapStamp, cacheDir, previous, log = () => {} }) {
  const Match = require(path.join(__dirname, "..", "ui", "shared", "classmatch.js"));
  const target = desktopTarget(spotifyExe);
  const coverage = Match.coverage(target.css, cssMap);
  const reference = await webReference(cacheDir);
  const key = crypto.createHash("sha1").update(`${target.id}|${reference.buildId}|${cssMapStamp}|v1`).digest("hex");
  if (previous && previous.key === key) return previous;
  log(`class map: desktop coverage ${(coverage * 100).toFixed(1)}%, matching against web build ${reference.buildId}…`);
  const t0 = Date.now();
  const { map, stats } = Match.matchClasses({ css: reference.css, js: reference.js }, target, cssMap);
  stats.ms = Date.now() - t0;
  stats.desktopCoverage = coverage;
  log(`class map: ${stats.mappedReadable} readable classes mapped (${stats.paired} pairs) in ${stats.ms} ms`);
  return { key, map, stats, builtAt: Date.now() };
}

module.exports = { buildDesktopClassMap };
