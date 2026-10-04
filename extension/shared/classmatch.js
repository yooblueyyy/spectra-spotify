/*
 * Spectra class matcher — self-healing class-name maps.
 *
 * Spotify ships CSS-module class names that are re-hashed every few releases
 * (".main-nowPlayingBar-container" is ".BfMk993iHPAQspwtvFRz" in one build and
 * something else in the next). Spicetify's css-map.json is maintained by hand,
 * so themes break whenever Spotify rehashes until someone updates it.
 *
 * The CSS rules themselves barely change between builds, only the names do.
 * So given:
 *   - a "reference" stylesheet set whose hashes css-map.json knows, and
 *   - the "target" stylesheet set of the Spotify build actually running,
 * we fingerprint every hashed class by the rules it appears in (its own name
 * replaced by "&", other hashed names by "#"), pair up unique fingerprints, then
 * iterate: classes paired in one round become known tokens that disambiguate
 * the next round.
 *
 * Pure JS, no DOM. Works in Node (desktop app) and browsers.
 */
(function (root) {
  "use strict";

  const HASHED = /^[A-Za-z0-9_-]{20}$/;
  const isHashed = (c) => HASHED.test(c) && /[A-Z]/.test(c) && /[a-z]/.test(c);
  const CLASS_RE = /\.(-?[_a-zA-Z][\w-]*)/g;

  /**
   * Builds target different browsers, so the same rule may differ only in vendor
   * prefixes or declaration order. Drop prefixed declarations and sort the rest.
   */
  function normDecls(body) {
    const seen = new Set();
    for (let d of String(body).split(";")) {
      d = d.trim().replace(/\s+/g, " ").replace(/\s*:\s*/, ":");
      if (!d) continue;
      if (/^-(webkit|moz|ms|o)-/i.test(d)) continue;
      if (/^[\w-]+:\s*-(webkit|moz|ms|o)-/i.test(d) && !/^--/.test(d)) continue;
      seen.add(d);
    }
    return [...seen].sort().join(";");
  }

  /** Flatten CSS into [{ ctx, selector, decls }] (one entry per comma-separated selector). */
  function parseRules(css) {
    const out = [];
    const src = String(css).replace(/\/\*[\s\S]*?\*\//g, "");
    let i = 0;
    const n = src.length;

    function readBlockBody(start) {
      // returns index just after the matching "}"
      let depth = 1, j = start, q = null;
      while (j < n && depth) {
        const ch = src[j];
        if (q) { if (ch === "\\") j++; else if (ch === q) q = null; }
        else if (ch === '"' || ch === "'") q = ch;
        else if (ch === "{") depth++;
        else if (ch === "}") depth--;
        j++;
      }
      return j;
    }

    function splitSelectors(sel) {
      const parts = [];
      let depth = 0, cur = "";
      for (const ch of sel) {
        if (ch === "(" || ch === "[") depth++;
        else if (ch === ")" || ch === "]") depth--;
        if (ch === "," && depth === 0) { parts.push(cur); cur = ""; } else cur += ch;
      }
      parts.push(cur);
      return parts.map((s) => s.trim().replace(/\s+/g, " ")).filter(Boolean);
    }

    function walk(from, to, ctx) {
      let k = from;
      while (k < to) {
        const open = src.indexOf("{", k);
        if (open < 0 || open >= to) break;
        const prelude = src.slice(k, open).trim().replace(/^[;}\s]+/, "");
        const end = readBlockBody(open + 1);
        const body = src.slice(open + 1, end - 1);
        if (prelude.startsWith("@")) {
          if (/^@(media|supports|container|layer|document)\b/i.test(prelude)) walk(open + 1, end - 1, ctx + prelude.replace(/\s+/g, " ") + ">");
          // @keyframes, @font-face, @property… carry no class names worth matching
        } else if (prelude) {
          const decls = normDecls(body);
          for (const s of splitSelectors(prelude)) out.push({ ctx, selector: s, decls });
        }
        k = end;
      }
    }
    walk(0, n, "");
    i = n;
    return out;
  }

  /** Index rules by hashed class. */
  function indexClasses(rules) {
    const byClass = new Map();
    rules.forEach((r, idx) => {
      const seen = new Set();
      for (const m of r.selector.matchAll(CLASS_RE)) {
        const c = m[1];
        if (!isHashed(c) || seen.has(c)) continue;
        seen.add(c);
        if (!byClass.has(c)) byClass.set(c, []);
        byClass.get(c).push(idx);
      }
    });
    return byClass;
  }

  function signature(cls, ruleIdxs, rules, known) {
    const parts = ruleIdxs.map((idx) => {
      const r = rules[idx];
      const sel = r.selector.replace(CLASS_RE, (m, c) => {
        if (c === cls) return ".&";
        if (!isHashed(c)) return m;
        const k = known.get(c);
        return k ? "." + k : ".#";
      });
      return r.ctx + sel + "{" + r.decls + "}";
    });
    parts.sort();
    return parts.join("\n");
  }

  // ---------------------------------------------------------------- JS side
  // Many classes are only referenced from JSX (className:"…") and have no CSS of
  // their own. Minified identifiers change between builds, but the *string
  // literals* around a className (tag names, data-testid values, aria labels,
  // neighbouring class names) are stable, so they make a good fingerprint.

  const STR_RE = /"((?:[^"\\\n]|\\.){0,200})"/g;

  function jsLiterals(js) {
    const lits = [];
    for (const m of String(js).matchAll(STR_RE)) lits.push(m[1]);
    return lits;
  }

  /** occurrences: Map<class, number[]> of literal indexes where the class appears. */
  function indexJS(lits) {
    const occ = new Map();
    lits.forEach((s, i) => {
      if (s.length < 20 || s.length > 200) return;
      for (const c of s.split(" ")) {
        if (!isHashed(c)) continue;
        if (!occ.has(c)) occ.set(c, []);
        occ.get(c).push(i);
      }
    });
    return occ;
  }

  function normLit(s, self, known) {
    if (s.length >= 20 && s.split(" ").some(isHashed)) {
      return s.split(" ").map((c) => (c === self ? "&" : isHashed(c) ? known.get(c) || "#" : c)).join(" ");
    }
    return s.length > 40 ? s.slice(0, 40) : s;
  }

  function jsContexts(cls, idxs, lits, known, k) {
    const out = [];
    for (const i of idxs) {
      const parts = [];
      for (let j = i - k; j <= i + k; j++) parts.push(j < 0 || j >= lits.length ? "^" : normLit(lits[j], cls, known));
      out.push(parts.join("\u0001"));
    }
    return out;
  }

  function jsRound(ref, tgt, refToTgt, knownRef, knownTgt) {
    const tgtPaired = new Set(refToTgt.values());
    const votes = new Map(); // r -> Map(t -> n)
    for (const k of [1, 2, 3, 5]) {
      const bucket = new Map();
      for (const [c, idxs] of ref.occ) {
        if (refToTgt.has(c)) continue;
        for (const key of new Set(jsContexts(c, idxs, ref.lits, knownRef, k))) {
          if (!bucket.has(key)) bucket.set(key, { r: new Set(), t: new Set() });
          bucket.get(key).r.add(c);
        }
      }
      for (const [c, idxs] of tgt.occ) {
        if (tgtPaired.has(c)) continue;
        for (const key of new Set(jsContexts(c, idxs, tgt.lits, knownTgt, k))) {
          const b = bucket.get(key);
          if (b) b.t.add(c);
        }
      }
      for (const b of bucket.values()) {
        if (b.r.size !== 1 || b.t.size !== 1) continue;
        const [r] = b.r, [t] = b.t;
        if (!votes.has(r)) votes.set(r, new Map());
        votes.get(r).set(t, (votes.get(r).get(t) || 0) + 1);
      }
    }
    // Accept only mutual best matches.
    const bestForT = new Map();
    for (const [r, m] of votes) for (const [t, n] of m) {
      const cur = bestForT.get(t);
      if (!cur || n > cur.n) bestForT.set(t, { r, n, tie: false });
      else if (n === cur.n && cur.r !== r) cur.tie = true;
    }
    let added = 0;
    for (const [r, m] of votes) {
      let best = null, bestN = 0, tie = false;
      for (const [t, n] of m) { if (n > bestN) { best = t; bestN = n; tie = false; } else if (n === bestN) tie = true; }
      const back = best && bestForT.get(best);
      if (!tie && back && back.r === r && !back.tie) { refToTgt.set(r, best); added++; }
    }
    return added;
  }

  /**
   * @param {{css: string, js?: string}} reference  a build whose hashes `cssMap` knows
   * @param {{css: string, js?: string}} target     the build that is running now
   * @param {Object<string,string>} cssMap  hashed -> readable (Spicetify css-map.json)
   * @returns {{ map: Object<string,string>, stats: object }} target-hashed -> readable
   */
  function matchClasses(reference, target, cssMap) {
    if (typeof reference === "string") reference = { css: reference };
    if (typeof target === "string") target = { css: target };
    const refRules = parseRules(reference.css || "");
    const tgtRules = parseRules(target.css || "");
    const refIdx = indexClasses(refRules);
    const tgtIdx = indexClasses(tgtRules);
    const refJS = reference.js ? (() => { const lits = jsLiterals(reference.js); return { lits, occ: indexJS(lits) }; })() : null;
    const tgtJS = target.js ? (() => { const lits = jsLiterals(target.js); return { lits, occ: indexJS(lits) }; })() : null;

    // Classes that exist unchanged in both builds are trivially paired.
    const refToTgt = new Map();
    const allRef = new Set([...refIdx.keys(), ...(refJS ? refJS.occ.keys() : [])]);
    const allTgt = new Set([...tgtIdx.keys(), ...(tgtJS ? tgtJS.occ.keys() : [])]);
    for (const c of allRef) if (allTgt.has(c)) refToTgt.set(c, c);

    // known: class -> stable token shared by both sides (we use the reference name)
    const knownRef = new Map(), knownTgt = new Map();
    const sync = () => {
      for (const [r, t] of refToTgt) { knownRef.set(r, "K" + r); knownTgt.set(t, "K" + r); }
    };
    sync();

    function cssRound() {
      const tgtPaired = new Set(refToTgt.values());
      const bucket = new Map(); // sig -> { ref: [], tgt: [] }
      for (const [c, idxs] of refIdx) {
        if (refToTgt.has(c)) continue;
        const s = signature(c, idxs, refRules, knownRef);
        if (!bucket.has(s)) bucket.set(s, { ref: [], tgt: [] });
        bucket.get(s).ref.push(c);
      }
      for (const [c, idxs] of tgtIdx) {
        if (tgtPaired.has(c)) continue;
        const s = signature(c, idxs, tgtRules, knownTgt);
        const b = bucket.get(s);
        if (b) b.tgt.push(c);
      }
      let added = 0;
      for (const b of bucket.values()) {
        if (b.ref.length === 1 && b.tgt.length === 1) { refToTgt.set(b.ref[0], b.tgt[0]); added++; }
      }
      return added;
    }

    // Rule-level pass: a single identical rule (same context, same selector shape,
    // same declarations) present exactly once on each side pairs up the unknown
    // classes in it, even if the class's *other* rules changed between builds.
    function ruleRound() {
      const tgtPaired = new Set(refToTgt.values());
      const shape = (r, known, paired) => {
        const unknown = [];
        const sel = r.selector.replace(CLASS_RE, (m, c) => {
          if (!isHashed(c)) return m;
          const k = known.get(c);
          if (k) return "." + k;
          if (paired && paired(c)) return ".?";
          unknown.push(c);
          return ".#";
        });
        return { key: r.ctx + sel + "{" + r.decls + "}", unknown };
      };
      const bucket = new Map();
      for (const r of refRules) {
        const s = shape(r, knownRef, (c) => refToTgt.has(c));
        if (!s.unknown.length) continue;
        if (!bucket.has(s.key)) bucket.set(s.key, { ref: [], tgt: [] });
        bucket.get(s.key).ref.push(s.unknown);
      }
      for (const r of tgtRules) {
        const s = shape(r, knownTgt, (c) => tgtPaired.has(c));
        const b = s.unknown.length && bucket.get(s.key);
        if (b) b.tgt.push(s.unknown);
      }
      const votes = new Map();
      for (const b of bucket.values()) {
        if (b.ref.length !== 1 || b.tgt.length !== 1 || b.ref[0].length !== b.tgt[0].length) continue;
        b.ref[0].forEach((r, i) => {
          const t = b.tgt[0][i];
          if (!votes.has(r)) votes.set(r, new Map());
          votes.get(r).set(t, (votes.get(r).get(t) || 0) + 1);
        });
      }
      return acceptMutual(votes);
    }

    function acceptMutual(votes) {
      const bestForT = new Map();
      for (const [r, m] of votes) for (const [t, n] of m) {
        const cur = bestForT.get(t);
        if (!cur || n > cur.n) bestForT.set(t, { r, n, tie: false });
        else if (n === cur.n && cur.r !== r) cur.tie = true;
      }
      const tgtPaired = new Set(refToTgt.values());
      let added = 0;
      for (const [r, m] of votes) {
        if (refToTgt.has(r)) continue;
        let best = null, bestN = 0, tie = false;
        for (const [t, n] of m) { if (n > bestN) { best = t; bestN = n; tie = false; } else if (n === bestN) tie = true; }
        const back = best && bestForT.get(best);
        if (!tie && back && back.r === r && !back.tie && !tgtPaired.has(best)) { refToTgt.set(r, best); tgtPaired.add(best); added++; }
      }
      return added;
    }

    let rounds = 0, cssPairs = 0, jsPairs = 0;
    for (; rounds < 12; rounds++) {
      let a = cssRound(); if (a) sync();
      const a2 = ruleRound(); if (a2) sync();
      a += a2; cssPairs += a;
      const b = refJS && tgtJS ? jsRound(refJS, tgtJS, refToTgt, knownRef, knownTgt) : 0; jsPairs += b; if (b) sync();
      if (!a && !b) break;
    }

    const map = {};
    let mappedReadable = 0;
    for (const [hashed, readable] of Object.entries(cssMap || {})) {
      // css-map may already know the target's hash directly (older/newer entries).
      const t = refToTgt.get(hashed) || (allTgt.has(hashed) ? hashed : null);
      if (t && !map[t]) { map[t] = readable; mappedReadable++; }
    }
    return {
      map,
      pairs: refToTgt,
      stats: {
        rounds: rounds + 1,
        refClasses: allRef.size,
        targetClasses: allTgt.size,
        paired: refToTgt.size,
        cssPairs,
        jsPairs,
        cssMapKnownInRef: Object.keys(cssMap || {}).filter((h) => allRef.has(h)).length,
        mappedReadable,
      },
    };
  }

  /** How many css-map hashes appear in a stylesheet set (0..1). */
  function coverage(css, cssMap) {
    const present = new Set();
    for (const m of String(css).matchAll(CLASS_RE)) present.add(m[1]);
    const keys = Object.keys(cssMap || {});
    if (!keys.length) return 0;
    return keys.filter((k) => present.has(k)).length / keys.length;
  }

  const api = { parseRules, matchClasses, coverage, isHashed };
  root.SpectraClassMatch = api;
  if (typeof module === "object" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : self);
