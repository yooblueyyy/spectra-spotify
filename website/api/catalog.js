// Spicetify extension catalog for the website's Extensions page.
// Built from GitHub (repos tagged "spicetify-extensions" + their manifest.json),
// minus the marketplace blacklist. Rebuilt at most every 6 hours; if GitHub is
// unreachable or rate-limited, the last good copy is served.
import { cacheGet, cacheSet } from "./_store.js";

const KEY = "spectra:catalog:extensions";
const MAX_AGE = 6 * 60 * 60 * 1000;
const PAGES = 3; // 3 × 100 repos, sorted by stars
const BLACKLIST = "https://raw.githubusercontent.com/spicetify/marketplace/main/resources/blacklist.json";

const raw = (o, r, b, p) => (/^https?:\/\//i.test(p) ? p : `https://raw.githubusercontent.com/${o}/${r}/${b}/${String(p).replace(/^\.?\/+/, "")}`);
const s = (v, max) => (typeof v === "string" ? v.slice(0, max) : "");

async function gh(url) {
  const headers = { Accept: "application/vnd.github+json", "User-Agent": "spectra-catalog" };
  if (process.env.GITHUB_TOKEN) headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(10000) });
  if (!res.ok) throw new Error(`GitHub ${res.status}`);
  return res.json();
}

async function pool(items, n, fn) {
  const out = [];
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) { const x = items[i++]; try { out.push(await fn(x)); } catch {} }
  }));
  return out;
}

async function build() {
  const bl = await fetch(BLACKLIST, { signal: AbortSignal.timeout(8000) })
    .then((r) => (r.ok ? r.json() : {})).then((j) => (j.repos || []).map((u) => String(u).toLowerCase().replace(/\/$/, ""))).catch(() => []);
  const repos = [];
  for (let page = 1; page <= PAGES; page++) {
    const res = await gh(`https://api.github.com/search/repositories?q=${encodeURIComponent("topic:spicetify-extensions")}&sort=stars&order=desc&per_page=100&page=${page}`);
    repos.push(...(res.items || []));
    if (!res.items || res.items.length < 100) break;
  }
  const keep = repos.filter((r) => !r.archived && !bl.includes(String(r.html_url).toLowerCase()));
  const lists = await pool(keep, 16, async (r) => {
    const repo = { owner: r.owner.login, repo: r.name, branch: r.default_branch };
    const res = await fetch(raw(repo.owner, repo.repo, repo.branch, "manifest.json"), { signal: AbortSignal.timeout(8000) });
    if (!res.ok) return [];
    const m = await res.json();
    return [].concat(m).filter((e) => e && typeof e === "object" && e.name && e.main).map((e) => ({
      key: `${repo.owner}/${repo.repo}:${s(e.name, 120)}`,
      name: s(e.name, 120),
      description: s(e.description, 400),
      authors: (Array.isArray(e.authors) ? e.authors : []).filter((a) => a && a.name).slice(0, 4).map((a) => ({ name: s(a.name, 80), url: /^https:\/\//.test(a.url || "") ? s(a.url, 300) : "" })),
      tags: (Array.isArray(e.tags) ? e.tags : []).map((t) => s(String(t), 30)).filter(Boolean).slice(0, 6),
      preview: e.preview ? raw(repo.owner, repo.repo, repo.branch, s(e.preview, 300)) : "",
      main: s(e.main, 300),
      owner: repo.owner,
      repo: repo.repo,
      branch: repo.branch,
      stars: r.stargazers_count || 0,
      updated: s(r.pushed_at, 30),
      url: `https://github.com/${repo.owner}/${repo.repo}`,
    }));
  });
  const items = lists.flat().sort((a, b) => b.stars - a.stars);
  if (!items.length) throw new Error("Empty catalog");
  return { builtAt: Date.now(), items };
}

// Building from scratch fetches a few hundred manifests; give it time.
export const config = { maxDuration: 60 };

let inflight = null;

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  if (req.method !== "GET" && req.method !== "HEAD") return res.status(405).json({ error: "Method not allowed" });
  let cat = await cacheGet(KEY);
  if (!cat || Date.now() - cat.builtAt > MAX_AGE) {
    try {
      inflight = inflight || build().finally(() => { inflight = null; });
      cat = await inflight;
      await cacheSet(KEY, cat);
    } catch (e) {
      if (!cat) {
        res.setHeader("Cache-Control", "no-store");
        return res.status(503).json({ error: "The catalog couldn't be built right now. Try again in a few minutes." });
      }
    }
  }
  res.setHeader("Cache-Control", "public, max-age=300, s-maxage=3600, stale-while-revalidate=86400");
  return res.status(200).json(cat);
}
