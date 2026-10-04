// Shared bits for the public pages: live config from /api/manifest.
(function () {
  "use strict";

  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const safeUrl = (u) => (/^(https:\/\/|\/)/.test(u || "") ? u : "");

  // Changelog notes: "+ added", "- removed", "* changed". Anything else is a plain bullet.
  const KINDS = { "+": ["add", "New"], "-": ["remove", "Removed"], "*": ["change", "Changed"] };
  function noteHTML(n) {
    const m = String(n).match(/^\s*([+\-*])\s+(.*)$/);
    if (!m) return `<li>${esc(n)}</li>`;
    const [cls, label] = KINDS[m[1]];
    return `<li class="${cls}"><span class="mark" title="${label}" aria-label="${label}:">${m[1] === "-" ? "−" : m[1]}</span>${esc(m[2])}</li>`;
  }

  let manifestPromise = null;
  window.spectraManifest = function () {
    manifestPromise = manifestPromise || fetch("/api/manifest").then((r) => (r.ok ? r.json() : null)).catch(() => null);
    return manifestPromise;
  };

  // ---- Discord buttons: the invite link is set in the admin page
  window.spectraManifest().then((m) => {
    const url = m && m.links && m.links.discord;
    if (!url || !/^https:\/\/(discord\.gg|discord\.com\/invite)\//.test(url)) return;
    document.querySelectorAll('a[href^="https://discord.gg/"], a[href^="https://discord.com/invite/"]').forEach((a) => { a.href = url; });
  });

  // ---- before / after slider
  const box = document.getElementById("compare-box");
  if (box) {
    const range = box.querySelector("input[type=range]");
    const set = () => box.style.setProperty("--split", range.value + "%");
    range.addEventListener("input", set);
    set();
  }

  // ---- featured themes rail
  const rail = document.getElementById("featured-rail");
  // ---- changelog
  const log = document.getElementById("changelog-list");

  // ---- hero release line: newest version and when it shipped
  const release = document.getElementById("release-text");
  if (release) {
    window.spectraManifest().then((m) => {
      const v = m && m.latest && m.latest.desktop;
      const entry = m && m.changelog && m.changelog[0];
      if (!v) return;
      const when = entry && /^\d{4}-\d{2}-\d{2}$/.test(entry.date || "") ? (() => {
        // Compare calendar days in the visitor's time zone ("2026-10-04" means that local day, not UTC midnight).
        const [y, mo, d] = entry.date.split("-").map(Number);
        const then = new Date(y, mo - 1, d), now = new Date();
        const days = Math.round((new Date(now.getFullYear(), now.getMonth(), now.getDate()) - then) / 86400000);
        return days <= 0 ? "today" : days === 1 ? "yesterday" : days < 30 ? `${days} days ago` : then.toLocaleDateString(undefined, { month: "short", day: "numeric" });
      })() : "";
      release.innerHTML = `<b>v${esc(v)}</b>${when ? ` · ${esc(when)}` : ""} · what changed →`;
    });
  }

  if (rail || log) {
    window.spectraManifest().then((m) => {
      if (rail) {
        const themes = (m && m.featured && m.featured.themes) || [];
        rail.innerHTML = themes.length
          ? themes.map((t) => `
            <a class="tcard" href="https://github.com/${encodeURIComponent(t.owner)}/${encodeURIComponent(t.repo)}" target="_blank" rel="noopener">
              <div class="img" role="img" aria-label="${esc(t.name)} preview" style="background-image:url('${esc(safeUrl(t.preview))}')"></div>
              <div class="body">
                <h3>${esc(t.name)} <span class="by">by ${esc(t.owner)}</span></h3>
                ${t.note ? `<p>${esc(t.note)}</p>` : ""}
              </div>
            </a>`).join("")
          : `<p class="muted">Nothing featured right now. Every theme is still in the app.</p>`;
      }
      if (log) {
        const entries = ((m && m.changelog) || []).slice(0, 4);
        log.innerHTML = entries.length
          ? entries.map((e) => `
            <li>
              <div><span class="v">${esc(e.version)}</span><span class="d">${esc(e.date)}</span></div>
              <ul>${(e.notes || []).map(noteHTML).join("")}</ul>
            </li>`).join("")
          : `<li><span class="muted">No releases listed yet.</span></li>`;
      }
    });
  }
})();
