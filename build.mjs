#!/usr/bin/env node
/**
 * Spectra build — no dependencies.
 *   node build.mjs          -> dist/chrome, dist/firefox (+ .zip when `tar` is available)
 *   node build.mjs --icons  -> only regenerate extension/icons/*.png
 */
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.join(ROOT, "extension");
const DIST = path.join(ROOT, "dist");

// ---------------------------------------------------------------- icons
function crc32(buf) {
  let c, crc = 0xffffffff;
  for (let n = 0; n < buf.length; n++) {
    c = (crc ^ buf[n]) & 0xff;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crc = (crc >>> 8) ^ c;
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function png(size, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", zlib.deflateSync(raw, { level: 9 })), chunk("IEND", Buffer.alloc(0))]);
}

function roundRectSDF(x, y, cx, cy, hw, hh, r) {
  const qx = Math.abs(x - cx) - hw + r, qy = Math.abs(y - cy) - hh + r;
  return Math.min(Math.max(qx, qy), 0) + Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) - r;
}

function drawIcon(size) {
  const SS = 4; // supersampling
  const out = Buffer.alloc(size * size * 4);
  const bars = [0.38, 0.62, 0.86, 0.55, 0.3]; // equalizer heights (fraction of inner box)
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let sy = 0; sy < SS; sy++) for (let sx = 0; sx < SS; sx++) {
        const x = (px + (sx + 0.5) / SS) / size, y = (py + (sy + 0.5) / SS) / size;
        const bg = roundRectSDF(x, y, 0.5, 0.5, 0.5, 0.5, 0.24);
        if (bg > 0) continue;
        // diagonal violet -> teal gradient
        const t = Math.min(1, Math.max(0, (x + y) / 2));
        let cr = 139 + (34 - 139) * t, cg = 92 + (211 - 92) * t, cb = 246 + (166 - 246) * t;
        // soft highlight
        const hl = Math.max(0, 1 - Math.hypot(x - 0.25, y - 0.2) / 0.6) * 0.18;
        cr += (255 - cr) * hl; cg += (255 - cg) * hl; cb += (255 - cb) * hl;
        // white equalizer bars
        const n = bars.length, bw = 0.085, gap = (0.62 - n * bw) / (n - 1), x0 = 0.19;
        for (let i = 0; i < n; i++) {
          const bx = x0 + i * (bw + gap) + bw / 2;
          const bh = bars[i] * 0.56;
          if (roundRectSDF(x, y, bx, 0.5, bw / 2, bh / 2, bw / 2) <= 0) { cr = 255; cg = 255; cb = 255; }
        }
        r += cr; g += cg; b += cb; a += 255;
      }
      const n = SS * SS, i = (py * size + px) * 4;
      const cov = a / n / 255;
      out[i] = cov ? r / (a / 255) : 0;
      out[i + 1] = cov ? g / (a / 255) : 0;
      out[i + 2] = cov ? b / (a / 255) : 0;
      out[i + 3] = a / n;
    }
  }
  return png(size, out);
}

function buildIcons() {
  const dir = path.join(SRC, "icons");
  fs.mkdirSync(dir, { recursive: true });
  for (const s of [16, 32, 48, 128]) fs.writeFileSync(path.join(dir, `icon-${s}.png`), drawIcon(s));
  console.log("icons  ✓");
}

// ---------------------------------------------------------------- packaging
function copyDir(from, to) {
  fs.mkdirSync(to, { recursive: true });
  for (const e of fs.readdirSync(from, { withFileTypes: true })) {
    const a = path.join(from, e.name), b = path.join(to, e.name);
    if (e.isDirectory()) copyDir(a, b); else fs.copyFileSync(a, b);
  }
}

function firefoxManifest(m) {
  const f = structuredClone(m);
  f.background = { scripts: ["shared/core.js", "background.js"] };
  delete f.minimum_chrome_version;
  f.browser_specific_settings = {
    gecko: {
      id: "spectra@spectra-themes",
      strict_min_version: "128.0",
      data_collection_permissions: { required: ["none"] },
    },
  };
  return f;
}

function zip(dir, file) {
  fs.rmSync(file, { force: true });
  const attempts = process.platform === "win32"
    ? [[path.join(process.env.SystemRoot || "C:\\Windows", "System32", "tar.exe"), ["-a", "-c", "-f", file, "-C", dir, "."], {}]]
    : [["zip", ["-qr", file, "."], { cwd: dir }]];
  for (const [cmd, args, opts] of attempts) {
    try { execFileSync(cmd, args, { stdio: "ignore", ...opts }); return true; } catch {}
  }
  return false;
}

function build() {
  if (!fs.existsSync(path.join(SRC, "icons", "icon-128.png"))) buildIcons();
  const manifest = JSON.parse(fs.readFileSync(path.join(SRC, "manifest.json"), "utf8"));
  fs.rmSync(DIST, { recursive: true, force: true });

  const chrome = path.join(DIST, "chrome");
  copyDir(SRC, chrome);
  console.log("chrome ✓ dist/chrome");

  const ff = path.join(DIST, "firefox");
  copyDir(SRC, ff);
  fs.writeFileSync(path.join(ff, "manifest.json"), JSON.stringify(firefoxManifest(manifest), null, 2));
  console.log("firefox ✓ dist/firefox");

  const v = manifest.version;
  if (zip(chrome, path.join(DIST, `spectra-chrome-${v}.zip`)) && zip(ff, path.join(DIST, `spectra-firefox-${v}.zip`))) {
    console.log(`zips   ✓ dist/spectra-{chrome,firefox}-${v}.zip`);
  }
}

// The desktop app reuses the exact same dashboard, runtime and core as the extension.
function prepareApp() {
  if (!fs.existsSync(path.join(SRC, "icons", "icon-128.png"))) buildIcons();
  const APP = path.join(ROOT, "desktop-app");
  const ui = path.join(APP, "ui");
  fs.rmSync(ui, { recursive: true, force: true });
  for (const dir of ["dashboard", "shared", "runtime", "icons"]) copyDir(path.join(SRC, dir), path.join(ui, dir));
  fs.mkdirSync(path.join(APP, "build"), { recursive: true });
  fs.writeFileSync(path.join(APP, "build", "icon.png"), drawIcon(1024));
  const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, "spectra.config.json"), "utf8"));
  fs.writeFileSync(path.join(ui, "app-config.json"), JSON.stringify({ site: cfg.apiBase, discordClientId: cfg.discordClientId || "" }, null, 2));
  console.log("app ui ✓ desktop-app/ui");
}

// Android app: same dashboard (+ native-bridge shim) and a single injected player bundle.
function prepareAndroid() {
  if (!fs.existsSync(path.join(SRC, "icons", "icon-128.png"))) buildIcons();
  const AND = path.join(ROOT, "android-app");
  const assets = path.join(AND, "app", "src", "main", "assets");
  const ui = path.join(assets, "ui");
  fs.rmSync(assets, { recursive: true, force: true });
  for (const dir of ["dashboard", "shared", "icons"]) copyDir(path.join(SRC, dir), path.join(ui, dir));
  fs.copyFileSync(path.join(AND, "web", "android-shim.js"), path.join(ui, "android-shim.js"));
  const indexFile = path.join(ui, "dashboard", "index.html");
  const index = fs.readFileSync(indexFile, "utf8");
  const marker = '<script src="../shared/core.js"></script>';
  if (!index.includes(marker)) throw new Error("dashboard/index.html: core.js script tag not found");
  fs.writeFileSync(indexFile, index.replace(marker, '<script src="../android-shim.js"></script>\n  ' + marker));
  const bundle = [
    fs.readFileSync(path.join(SRC, "shared", "core.js"), "utf8"),
    fs.readFileSync(path.join(AND, "web", "android-player.js"), "utf8"),
    fs.readFileSync(path.join(SRC, "runtime", "spectra-runtime.js"), "utf8"),
  ].join("\n;\n");
  fs.writeFileSync(path.join(assets, "spectra-player.js"), bundle);
  const densities = { mdpi: 48, hdpi: 72, xhdpi: 96, xxhdpi: 144, xxxhdpi: 192 };
  for (const [d, size] of Object.entries(densities)) {
    const dir = path.join(AND, "app", "src", "main", "res", `mipmap-${d}`);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "ic_launcher.png"), drawIcon(size));
  }
  console.log("android ✓ android-app/app/src/main/assets");
}

// spectra.config.json → the update-server address compiled into every build.
function syncConfig() {
  const cfgFile = path.join(ROOT, "spectra.config.json");
  if (!fs.existsSync(cfgFile)) return;
  const { apiBase } = JSON.parse(fs.readFileSync(cfgFile, "utf8"));
  if (!/^https:\/\/[^\s"]+$/.test(apiBase || "")) throw new Error("spectra.config.json: apiBase must be an https:// URL");
  const base = apiBase.replace(/\/+$/, "");
  const targets = [
    [path.join(SRC, "shared", "core.js"), /const API_BASE = "[^"]*";/, `const API_BASE = "${base}";`],
    [path.join(ROOT, "android-app", "app", "src", "main", "java", "app", "spectra", "android", "MainActivity.java"), /String base = "https:\/\/[^"]*";/, `String base = "${base}";`],
  ];
  for (const [file, re, line] of targets) {
    if (!fs.existsSync(file)) continue;
    const src = fs.readFileSync(file, "utf8");
    if (!re.test(src)) throw new Error(`update-server line not found in ${path.relative(ROOT, file)}`);
    const next = src.replace(re, line);
    if (next !== src) fs.writeFileSync(file, next);
  }
  console.log(`config ✓ update server ${base}`);
}

// Discord bot: the server icon /setupserver uploads.
function prepareBot() {
  const dir = path.join(ROOT, "discord-bot", "assets");
  if (!fs.existsSync(path.dirname(dir))) return;
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "icon.png"), drawIcon(512));
  fs.copyFileSync(path.join(dir, "icon.png"), path.join(ROOT, "website", "img", "logo-512.png"));
  console.log("bot    ✓ discord-bot/assets/icon.png");
}

syncConfig();
if (process.argv.includes("--icons")) buildIcons();
else if (process.argv.includes("--bot")) prepareBot();
else if (process.argv.includes("--app")) prepareApp();
else if (process.argv.includes("--android")) prepareAndroid();
else { build(); prepareApp(); prepareAndroid(); prepareBot(); }
