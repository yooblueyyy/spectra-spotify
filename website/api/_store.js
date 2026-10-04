// Config storage: Upstash Redis (added from Vercel's Storage tab) when configured,
// otherwise the bundled data/spectra.json (read-only).
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

const KEY = "spectra:config";
const MAX_BYTES = 1_500_000;

const REDIS_URL = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL || "";
const REDIS_TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN || "";

export const hasStorage = () => !!(REDIS_URL && REDIS_TOKEN);

export async function redis(command) {
  const res = await fetch(REDIS_URL, {
    method: "POST",
    headers: { Authorization: `Bearer ${REDIS_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify(command),
  });
  if (!res.ok) throw new Error(`Storage error ${res.status}`);
  const body = await res.json();
  if (body.error) throw new Error(`Storage error: ${body.error}`);
  return body.result;
}

/** Several commands in one round trip. Returns each command's result (null where it failed). */
export async function redisPipeline(commands) {
  if (!commands.length) return [];
  const res = await fetch(REDIS_URL.replace(/\/+$/, "") + "/pipeline", {
    method: "POST",
    headers: { Authorization: `Bearer ${REDIS_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify(commands),
  });
  if (!res.ok) throw new Error(`Storage error ${res.status}`);
  return (await res.json()).map((r) => (r && !r.error ? r.result : null));
}

/** Small JSON cache in the same Redis database (no-op without storage). */
export async function cacheGet(key) {
  if (!hasStorage()) return null;
  try { const raw = await redis(["GET", key]); return raw ? JSON.parse(raw) : null; } catch { return null; }
}
export async function cacheSet(key, value) {
  if (!hasStorage()) return;
  try { await redis(["SET", key, JSON.stringify(value)]); } catch {}
}

function bundled() {
  const file = path.join(process.cwd(), "data", "spectra.json");
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

export async function readConfig() {
  if (hasStorage()) {
    const raw = await redis(["GET", KEY]);
    if (raw) return JSON.parse(raw);
  }
  return bundled();
}

export async function writeConfig(config) {
  if (!hasStorage()) throw Object.assign(new Error("No storage connected. Add an Upstash Redis database in Vercel â†’ Storage, then redeploy."), { status: 501 });
  const clean = normalize(config);
  clean.updatedAt = new Date().toISOString();
  const raw = JSON.stringify(clean);
  if (Buffer.byteLength(raw) > MAX_BYTES) throw Object.assign(new Error("Config is too large (max 1.5 MB)."), { status: 413 });
  await redis(["SET", KEY, raw]);
  return clean;
}

// ---------------------------------------------------------------- validation

const str = (v, max = 2000) => (typeof v === "string" ? v.slice(0, max) : "");
const arr = (v) => (Array.isArray(v) ? v : []);
const PLATFORMS = ["web", "desktop", "quest"];
const platforms = (v) => {
  const p = arr(v).filter((x) => PLATFORMS.includes(x));
  return p.length ? p : PLATFORMS.slice();
};
const id = (v, fallback) => str(v, 120).replace(/[^\w.:/@-]/g, "") || fallback;

/** Keeps only known fields with the right types, so a typo in the admin page can't break installs. */
export function normalize(c) {
  c = c && typeof c === "object" ? c : {};
  const a = c.announcement && typeof c.announcement === "object" && str(c.announcement.text) ? {
    id: id(c.announcement.id, "a-" + Date.now()),
    text: str(c.announcement.text, 500),
    link: /^https:\/\//.test(c.announcement.link || "") ? str(c.announcement.link, 500) : "",
    level: ["info", "warning"].includes(c.announcement.level) ? c.announcement.level : "info",
  } : null;

  const theme = (t) => ({
    key: str(t.key, 200),
    name: str(t.name, 120),
    owner: str(t.owner, 100),
    repo: str(t.repo, 100),
    branch: str(t.branch, 100) || "main",
    usercss: str(t.usercss, 300),
    schemes: str(t.schemes, 300),
    include: arr(t.include).map((x) => str(x, 500)).filter(Boolean).slice(0, 10),
    preview: str(t.preview, 500),
    note: str(t.note, 300),
  });
  const ext = (e) => ({
    key: str(e.key, 200),
    name: str(e.name, 120),
    owner: str(e.owner, 100),
    repo: str(e.repo, 100),
    branch: str(e.branch, 100) || "main",
    main: str(e.main, 500),
    preview: str(e.preview, 500),
    description: str(e.description, 400),
    note: str(e.note, 300),
  });
  const snippet = (s) => ({ title: str(s.title, 120), description: str(s.description, 400), code: str(s.code, 50000), preview: str(s.preview, 500) });

  const classMap = {};
  if (c.classMap && typeof c.classMap === "object") {
    for (const [k, v] of Object.entries(c.classMap)) {
      if (/^[\w-]{1,80}$/.test(k) && typeof v === "string" && /^[\w-]{1,120}$/.test(v)) classMap[k] = v;
    }
  }

  return {
    schema: 1,
    updatedAt: str(c.updatedAt, 40),
    announcement: a,
    latest: {
      extension: str(c.latest?.extension, 20),
      desktop: str(c.latest?.desktop, 20),
      quest: str(c.latest?.quest, 20),
    },
    // Community links shown on the website and in every app's dashboard.
    links: {
      discord: /^https:\/\/(discord\.gg|discord\.com\/invite)\/[\w-]+\/?$/.test(c.links?.discord || "") ? str(c.links.discord, 200) : "https://discord.gg/spicetify",
    },
    downloads: {
      chrome: str(c.downloads?.chrome, 500),
      firefox: str(c.downloads?.firefox, 500),
      windows: str(c.downloads?.windows, 500),
      mac: str(c.downloads?.mac, 500),
      macIntel: str(c.downloads?.macIntel, 500),
      linux: str(c.downloads?.linux, 500),
      linuxDeb: str(c.downloads?.linuxDeb, 500),
      quest: str(c.downloads?.quest, 500),
    },
    featured: {
      themes: arr(c.featured?.themes).map(theme).filter((t) => t.name && t.owner && t.repo).slice(0, 24),
      extensions: arr(c.featured?.extensions).map(ext).filter((e) => e.name && e.main).slice(0, 24),
      snippets: arr(c.featured?.snippets).map(snippet).filter((s) => s.title && s.code).slice(0, 48),
    },
    cssHotfixes: arr(c.cssHotfixes).map((h, i) => ({
      id: id(h.id, "hotfix-" + i),
      description: str(h.description, 300),
      css: str(h.css, 200000),
      enabled: h.enabled !== false,
      platforms: platforms(h.platforms),
    })).filter((h) => h.css),
    classMap,
    scripts: arr(c.scripts).map((s, i) => ({
      id: id(s.id, "script-" + i),
      name: str(s.name, 120) || "Remote script",
      description: str(s.description, 300),
      code: str(s.code, 400000),
      enabled: s.enabled !== false,
      platforms: platforms(s.platforms),
    })).filter((s) => s.code),
    blockedExtensions: arr(c.blockedExtensions).map((x) => str(x, 200)).filter(Boolean).slice(0, 200),
    changelog: arr(c.changelog).map((e) => ({
      version: str(e.version, 60),
      date: str(e.date, 20),
      notes: arr(e.notes).map((n) => str(n, 400)).filter(Boolean).slice(0, 30),
    })).filter((e) => e.version).slice(0, 50),
  };
}

export function checkAdmin(req) {
  const expected = process.env.ADMIN_TOKEN || "";
  const header = req.headers["authorization"] || "";
  const given = header.startsWith("Bearer ") ? header.slice(7) : "";
  if (expected.length < 16 || !given) return false;
  const a = Buffer.from(given), b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
