#!/usr/bin/env node
/**
 * One-command Firefox release:
 *   build → sign with Mozilla (unlisted) → save the .xpi → (optional) publish it
 *
 *   node tools/release-firefox.mjs            sign and save to dist/signed
 *   node tools/release-firefox.mjs --publish  also upload to GitHub Releases and update the website
 *
 * Mozilla API keys are asked for once and saved in your Windows profile
 * (%APPDATA%\Spectra\amo-keys.json), outside the project, so they never end up
 * in git, a build, or the website. Delete that file to forget them.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline/promises";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const PUBLISH = process.argv.includes("--publish");
const SIGNED_DIR = path.join(ROOT, "dist", "signed");
const KEY_FILE = path.join(process.env.APPDATA || path.join(os.homedir(), ".config"), "Spectra", "amo-keys.json");
const SITE = JSON.parse(fs.readFileSync(path.join(ROOT, "spectra.config.json"), "utf8")).apiBase.replace(/\/+$/, "");
const REPO = "yooblueyyy/spectra-releases";

const say = (m) => console.log(`\n▸ ${m}`);
const fail = (m) => { console.error(`\n✗ ${m}`); process.exit(1); };

// ---------------------------------------------------------------- keys
async function getKeys() {
  if (process.env.WEB_EXT_API_KEY && process.env.WEB_EXT_API_SECRET) return { key: process.env.WEB_EXT_API_KEY, secret: process.env.WEB_EXT_API_SECRET };
  try {
    const saved = JSON.parse(fs.readFileSync(KEY_FILE, "utf8"));
    if (saved.key && saved.secret) return saved;
  } catch {}
  console.log("\nFirst run: Spectra needs your Mozilla add-on API keys (one time only).");
  console.log("Get them at https://addons.mozilla.org/developers/addon/api/key/");
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const key = (await rl.question("JWT issuer (starts with user:): ")).trim();
  const secret = (await rl.question("JWT secret: ")).trim();
  rl.close();
  if (!/^user:\d+:\d+$/.test(key) || secret.length < 32) fail("Those don't look like AMO keys. Run again and paste them exactly.");
  fs.mkdirSync(path.dirname(KEY_FILE), { recursive: true });
  fs.writeFileSync(KEY_FILE, JSON.stringify({ key, secret }), { mode: 0o600 });
  console.log(`Saved to ${KEY_FILE}. You won't be asked again.`);
  return { key, secret };
}

// ---------------------------------------------------------------- helpers
function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { stdio: "inherit", shell: process.platform === "win32", cwd: ROOT, ...opts });
  return r.status === 0;
}

function jwt({ key, secret }) {
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const now = Math.floor(Date.now() / 1000);
  const body = `${b64({ alg: "HS256", typ: "JWT" })}.${b64({ iss: key, jti: crypto.randomUUID(), iat: now, exp: now + 60 })}`;
  return `${body}.${crypto.createHmac("sha256", secret).update(body).digest("base64url")}`;
}

async function amoFile(keys, addonId, version) {
  for (const v of [`v${version}`, version]) {
    const res = await fetch(`https://addons.mozilla.org/api/v5/addons/addon/${encodeURIComponent(addonId)}/versions/${encodeURIComponent(v)}/`, { headers: { Authorization: `JWT ${jwt(keys)}` } });
    if (res.ok) return (await res.json()).file;
  }
  return null;
}

/** Wait for Mozilla to finish signing, then download the .xpi. */
async function downloadSigned(keys, addonId, version) {
  const deadline = Date.now() + 30 * 60 * 1000;
  for (;;) {
    const file = await amoFile(keys, addonId, version);
    if (file && file.url && file.status === "public") {
      const dl = await fetch(file.url, { headers: { Authorization: `JWT ${jwt(keys)}` } });
      if (!dl.ok) fail(`Download failed: HTTP ${dl.status}`);
      const out = path.join(SIGNED_DIR, path.basename(new URL(file.url).pathname));
      fs.mkdirSync(SIGNED_DIR, { recursive: true });
      fs.writeFileSync(out, Buffer.from(await dl.arrayBuffer()));
      return out;
    }
    if (Date.now() > deadline) fail("Mozilla hasn't approved it after 30 minutes. Run this again later. It picks up where it left off.");
    process.stdout.write(file ? `  waiting for approval (${file.status})…\r` : "  waiting for Mozilla…\r");
    await new Promise((r) => setTimeout(r, 15000));
  }
}

function findGh() {
  const candidates = ["C:\\Program Files\\GitHub CLI\\gh.exe", "gh"];
  return candidates.find((c) => spawnSync(c, ["--version"], { stdio: "ignore", shell: c === "gh" }).status === 0);
}

// ---------------------------------------------------------------- main
const keys = await getKeys();

say("Building");
if (!run("node", ["build.mjs"])) fail("Build failed.");
const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, "dist", "firefox", "manifest.json"), "utf8"));
const version = manifest.version;
const addonId = manifest.browser_specific_settings.gecko.id;
console.log(`  Spectra ${version} (${addonId})`);

let xpi = fs.existsSync(SIGNED_DIR) ? fs.readdirSync(SIGNED_DIR).filter((f) => f.endsWith(`-${version}.xpi`)).map((f) => path.join(SIGNED_DIR, f))[0] : null;
if (xpi) {
  say(`Already signed: ${path.relative(ROOT, xpi)}`);
} else {
  const existing = await amoFile(keys, addonId, version);
  if (!existing) {
    say("Sending to Mozilla for signing");
    const env = { ...process.env, WEB_EXT_API_KEY: keys.key, WEB_EXT_API_SECRET: keys.secret };
    // Don't wait inside web-ext; we poll ourselves so an interrupted run can resume.
    const ok = run("npx", ["--yes", "web-ext", "sign", "--source-dir", "dist/firefox", "--channel", "unlisted", "--artifacts-dir", "dist/signed", "--approval-timeout", "0"], { env });
    if (!ok && !(await amoFile(keys, addonId, version))) fail("Mozilla rejected the upload (see above). If it says the version already exists, bump \"version\" in extension/manifest.json.");
  } else {
    say(`Version ${version} is already on Mozilla's side; picking it up`);
  }
  say("Waiting for Mozilla to sign it (usually a few minutes)");
  xpi = await downloadSigned(keys, addonId, version);
  console.log(`\n  Saved ${path.relative(ROOT, xpi)}`);
}

if (!PUBLISH) {
  console.log("\n✓ Done. Run with --publish to upload it and update the website.");
  process.exit(0);
}

// ---------------------------------------------------------------- publish
const gh = findGh();
if (!gh) fail("GitHub CLI not found. Install it, or upload the .xpi yourself.");
const tag = `firefox-v${version}`;
const assetName = `spectra-firefox-${version}.xpi`;
const staged = path.join(SIGNED_DIR, assetName);
if (xpi !== staged) fs.copyFileSync(xpi, staged);

say(`Uploading to GitHub (${REPO}, ${tag})`);
const exists = spawnSync(gh, ["release", "view", tag, "--repo", REPO], { stdio: "ignore", shell: gh === "gh" }).status === 0;
const notes = path.join(os.tmpdir(), "spectra-firefox-notes.md");
fs.writeFileSync(notes, `Spectra for Firefox ${version}\n\nSigned by Mozilla. Open \`${assetName}\` in Firefox and click **Add**.\n\nInstall guide: ${SITE}/download?p=firefox\n`);
const ghOk = exists
  ? run(gh, ["release", "upload", tag, staged, "--clobber", "--repo", REPO], { shell: gh === "gh" })
  : run(gh, ["release", "create", tag, `${staged}#Spectra for Firefox ${version} (signed)`, "--repo", REPO, "--title", `Spectra for Firefox ${version}`, "--notes-file", notes, "--latest=false"], { shell: gh === "gh" });
if (!ghOk) fail("GitHub upload failed (are you signed in? run: gh auth login).");
const url = `https://github.com/${REPO}/releases/download/${tag}/${assetName}`;

say("Updating the website");
const tokenFile = path.join(ROOT, "admin-token.txt");
if (!fs.existsSync(tokenFile)) fail(`No admin-token.txt. Set the Firefox link yourself in ${SITE}/admin: ${url}`);
const H = { Authorization: "Bearer " + fs.readFileSync(tokenFile, "utf8").trim(), "Content-Type": "application/json" };
const cur = await fetch(`${SITE}/api/admin`, { headers: H }).then((r) => r.json());
if (!cur.config) fail(`Couldn't read the site config: ${cur.error}`);
cur.config.downloads.firefox = url;
cur.config.latest.extension = version;
const saved = await fetch(`${SITE}/api/admin`, { method: "PUT", headers: H, body: JSON.stringify({ config: cur.config }) }).then((r) => r.json());
if (!saved.ok) fail(`Saving failed: ${saved.error}`);

console.log(`\n✓ Released Spectra for Firefox ${version}`);
console.log(`  ${url}`);
console.log(`  Live on ${SITE}/download?p=firefox within about 30 seconds.`);
