// Download page: platform picker + install steps. Download links come from /api/manifest,
// so they can be changed from the admin page without redeploying.
(function () {
  "use strict";
  const panel = document.getElementById("panel");
  const picks = [...document.querySelectorAll(".pick")];
  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  let manifest = null;

  const PLATFORMS = {
    chrome: {
      title: "Spectra for Chrome & Edge",
      file: "ZIP · about 80 KB",
      version: (m) => m.latest.extension,
      button: "Download for Chrome / Edge",
      steps: [
        "Download the ZIP and extract it (right-click → <em>Extract All</em>). Keep the folder somewhere permanent, like Documents. Chrome loads it from there.",
        "Open <code>chrome://extensions</code> (in Edge: <code>edge://extensions</code>).",
        "Turn on <strong>Developer mode</strong> (top right in Chrome, left sidebar in Edge).",
        "Click <strong>Load unpacked</strong> and choose the extracted folder.",
        "Pin Spectra from the puzzle-piece menu, pick a theme in the dashboard that opens, then go to <a href=\"https://open.spotify.com\" target=\"_blank\" rel=\"noopener\">open.spotify.com</a>.",
      ],
      notes: [
        "Chrome may remind you that developer-mode extensions are on. That's expected for extensions installed this way. Click away.",
      ],
    },
    firefox: {
      title: "Spectra for Firefox",
      file: "Signed add-on (.xpi)",
      version: (m) => m.latest.extension,
      button: "Add to Firefox",
      steps: [
        "Open this page in Firefox and click the button above.",
        "Firefox asks whether to add Spectra. Click <strong>Add</strong>.",
        "Open Spectra from the puzzle-piece menu, pick a theme, then go to <a href=\"https://open.spotify.com\" target=\"_blank\" rel=\"noopener\">open.spotify.com</a>.",
      ],
      notes: [
        "Downloaded it in another browser? In Firefox go to <code>about:addons</code>, click the gear icon, choose <em>Install Add-on From File…</em> and pick the file.",
        "Firefox version 128 or newer is needed.",
      ],
    },
    windows: {
      title: "Spectra for Windows",
      file: "Installer · about 110 MB",
      version: (m) => m.latest.desktop,
      button: "Download for Windows",
      steps: [
        "Run the installer. Windows may show <em>“Windows protected your PC”</em> the first time. Click <strong>More info → Run anyway</strong>.",
        "Open Spectra. It starts Spotify for you and attaches to it. Your Spotify files are never modified.",
        "Pick a theme. It shows up in Spotify right away.",
      ],
      notes: [
        "You need Spotify from <a href=\"https://www.spotify.com/download/\" target=\"_blank\" rel=\"noopener\">spotify.com/download</a>. The Microsoft Store version can't be used.",
        "Spectra starts with Windows and lives in the tray, so Spotify always opens with your theme. Both are switches on its Spotify page.",
      ],
    },
    mac: {
      title: "Spectra for Mac",
      file: "Disk image · about 120 MB",
      version: (m) => m.latest.desktop,
      buttons: [["mac", "Download for Apple silicon"], ["macIntel", "Download for Intel Macs"]],
      steps: [
        "Not sure which one? Apple menu → <em>About This Mac</em>. <em>Chip: Apple M…</em> means Apple silicon; <em>Processor: Intel</em> means Intel.",
        "Open the disk image and drag <strong>Spectra</strong> into <strong>Applications</strong>.",
        "The first time, right-click Spectra in Applications and choose <strong>Open</strong>, then <strong>Open</strong> again. On macOS 15 and newer, if that doesn't offer Open, go to <em>System Settings → Privacy &amp; Security</em> and click <strong>Open Anyway</strong>.",
        "Spectra starts Spotify for you and attaches to it. Pick a theme and it shows up in Spotify right away.",
      ],
      notes: [
        "Spectra isn't notarized by Apple yet, which is why macOS asks before the first launch. If it says the app is damaged, run <code>xattr -cr /Applications/Spectra.app</code> in Terminal once.",
        "You need Spotify from <a href=\"https://www.spotify.com/download/\" target=\"_blank\" rel=\"noopener\">spotify.com/download</a>. Spectra lives in the menu bar and reopens Spotify with your theme if you start it from the Dock.",
      ],
    },
    linux: {
      title: "Spectra for Linux",
      file: "AppImage or .deb · x64",
      version: (m) => m.latest.desktop,
      buttons: [["linux", "Download AppImage"], ["linuxDeb", "Download .deb"]],
      steps: [
        "<strong>.deb</strong> (Ubuntu, Debian, Mint, Pop!_OS): open it with your software installer, or run <code>sudo apt install ./Spectra-*.deb</code>.",
        "<strong>AppImage</strong> (any distro): make it executable with <code>chmod +x Spectra-*.AppImage</code>, then run it. Keep it in one place, since Spotify's menu entry will point to it.",
        "Spectra starts Spotify and attaches to it. Pick a theme and it shows up right away.",
      ],
      notes: [
        "Works with Spotify installed from spotify.com (deb), Snap or Flatpak.",
        "With <em>Always open Spotify with Spectra</em> on, Spectra puts its own copy of Spotify's menu entry in <code>~/.local/share/applications</code>. Turning the switch off removes it. If you delete Spectra, the entry still opens Spotify normally.",
      ],
    },
    quest: {
      title: "Spectra for Meta Quest",
      file: "APK · under 1 MB",
      version: (m) => m.latest.quest,
      button: "Download the APK",
      steps: [
        "Turn on Developer Mode: in the Meta Horizon app on your phone, go to <em>Devices → your headset → Developer Mode</em>. (Meta asks you to register as a developer once. It's free.)",
        "Connect the headset to your PC with a USB cable and accept the <em>Allow USB debugging</em> prompt inside the headset.",
        "Install the APK with <a href=\"https://sidequestvr.com\" target=\"_blank\" rel=\"noopener\">SideQuest</a> (drag it onto the window), or run <code>adb install Spectra.apk</code>.",
        "In the headset, open <em>Library → Unknown sources</em> and launch Spectra. Sign in to Spotify once.",
      ],
      notes: [
        "Music keeps playing when you close the Spectra window. Use the media controls in your Quest notifications.",
        "Quest pauses all music during calls (Meta, Discord and others). That's built into Horizon OS, and no app can override it.",
      ],
    },
  };

  function detect() {
    const ua = navigator.userAgent;
    if (/OculusBrowser|Quest/i.test(ua)) return "quest";
    if (/Firefox\//.test(ua)) return "firefox";
    if (/Chrome\/|Edg\//.test(ua)) return "chrome";
    if (/Windows/.test(ua)) return "windows";
    if (/Macintosh/.test(ua)) return "mac";
    if (/Linux/.test(ua) && !/Android/.test(ua)) return "linux";
    return null;
  }

  function render(p) {
    const info = PLATFORMS[p];
    if (!info) return;
    picks.forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.p === p)));
    const link = (key) => {
      const url = manifest && manifest.downloads ? manifest.downloads[key] : "";
      return /^(https:\/\/|\/)/.test(url || "") ? url : "";
    };
    const buttons = (info.buttons || [[p, info.button]]).map(([key, label]) => ({ url: link(key), label }));
    const ready = buttons.filter((b) => b.url);
    const version = manifest && manifest.latest ? info.version(manifest) : "";
    panel.innerHTML = `
      <span class="label">${esc(info.file)}${version ? " · version " + esc(version) : ""}</span>
      <h2>${esc(info.title)}</h2>
      <div class="meta">
        ${ready.length
          ? ready.map((b, i) => `<a class="btn${i ? " light" : ""}" href="${esc(b.url)}" ${p === "firefox" ? "" : "download"} rel="noopener">${esc(b.label)}</a>`).join("")
          : `<span class="btn" aria-disabled="true">${esc(buttons[0].label)}</span><span class="empty-dl">Not published yet. Check back soon.</span>`}
      </div>
      <ol class="steps">${info.steps.map((s) => `<li>${s}</li>`).join("")}</ol>
      ${info.notes.map((n) => `<p class="note">${n}</p>`).join("")}
    `;
    const u = new URL(location.href);
    u.searchParams.set("p", p);
    history.replaceState(null, "", u);
  }

  picks.forEach((b) => b.addEventListener("click", () => render(b.dataset.p)));

  const fromUrl = new URL(location.href).searchParams.get("p");
  const guess = detect();
  if (guess) {
    const tile = picks.find((b) => b.dataset.p === guess);
    if (tile) tile.insertAdjacentHTML("beforeend", '<span class="detected">Your browser</span>');
  }
  const initial = PLATFORMS[fromUrl] ? fromUrl : guess;

  window.spectraManifest().then((m) => {
    manifest = m || { latest: {}, downloads: {} };
    if (initial) render(initial);
  });
})();
