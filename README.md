# Spectra

**A better Spicetify.** Themes, extensions and snippets from the Spicetify marketplace, in two separate products:

* **Spectra for Desktop**, a standalone app (Windows, macOS, Linux) for the Spotify desktop client.
* **Spectra for Web**, a browser extension (Chrome, Edge, Brave, Opera, Firefox) for [open.spotify.com](https://open.spotify.com).

Both have the same marketplace, editors and engine. Neither needs the other.

| | Spicetify | Spectra |
|---|---|---|
| Install | CLI, patches Spotify's files | Normal app / browser extension |
| Spotify update breaks it | Often, until you run `spicetify backup apply` again | Spotify's files are never touched |
| Applying a theme | CLI + restart | One click, live |
| Colour tweaks | Edit `color.ini` | Visual editor with a live preview |
| Theme vs. lazy-loaded Spotify CSS | Theme can lose to later chunks | Theme always wins |
| A crashing extension | Can take others down | Isolated |
| Web player | ✗ | ✓ |

## Spectra for Desktop

```bash
cd desktop-app
npm install
npm start          # run it
npm run dist:win   # Windows installer + portable .exe into desktop-app/release/
npm run dist:linux # AppImage + .deb (build on Linux)
npm run dist:mac   # .dmg for Apple silicon and Intel, macOS 12+ (build on a Mac)
```

macOS and Linux builds can't be made on Windows. `.github/workflows/desktop.yml` builds both on GitHub's machines: run it from the Actions tab, or push a `desktop-v1.2.0`-style tag to attach the files to that release in yooblueyyy/spectra-releases (needs a `RELEASES_TOKEN` secret).

* **macOS:** Spotify is started through `open`, so it behaves like a normal launch. Spectra lives in the menu bar (no Dock icon while its window is closed). There are no shortcut files to redirect on a Mac, so "always open with Spectra" relies on the restart safety net described below. The app is ad-hoc signed, not notarized, so the first launch needs right-click → Open.
* **Linux:** works with Spotify from spotify.com (deb), Snap and Flatpak. "Always open with Spectra" writes a copy of Spotify's `.desktop` entry to `~/.local/share/applications` that runs `~/.local/share/spectra/open-spotify.sh`; the script falls back to plain Spotify if Spectra is gone. Turning the switch off deletes both. "Start at login" writes `~/.config/autostart/spectra.desktop`. Discord status also finds Flatpak and Snap Discord.

When it opens, Spectra starts Spotify and attaches to it. Pick a theme and it appears in Spotify straight away.

* **Spotify always opens with Spectra** (on by default, Windows). Spectra adds its attach flag to Spotify's Start Menu, desktop and taskbar shortcuts, Spotify's own "open at login" entry and the `spotify:` link handler, and re-checks them every 10 minutes in case a Spotify update resets them. If Spotify still starts some other way, Spectra restarts it within a few seconds, but only if it opened in the last 30 seconds, so it never interrupts music that's playing. Turning the setting off restores every original from `%APPDATA%\Spectra\spotify-launch-backup.json`.
* **Spectra starts with Windows** (on by default) quietly in the tray, so it's ready whenever Spotify opens.
* If Spotify has been running a while without Spectra, the **Spotify** page offers **Restart Spotify with Spectra**. It never closes a running Spotify without asking.
* Before uninstalling, turn off **Always open Spotify with Spectra** to put Spotify's shortcuts back. If you forget, Spotify still works normally; it just keeps the extra flag.
* With **Keep running in the tray** on (the default), closing the window keeps Spectra in the tray so everything stays active.
* The Spotify page shows the connection status and lets you set Spotify's location if it isn't detected.

> The Microsoft Store build of Spotify can't be started this way. Use the installer from spotify.com/download.

**How it attaches:** Spectra launches Spotify with Chromium's remote-debugging port bound to `127.0.0.1` (default 9333). It injects the runtime through the DevTools protocol (`Page.addScriptToEvaluateOnNewDocument`), so nothing on disk changes. While Spotify runs this way, other programs on your computer could also connect to that local port. This is the same trade-off as Spotify's own developer mode.

## Spectra for Android

A standalone app that runs Spotify's **web player** with Spectra built in. Spotify's own Android app is fully native, so CSS themes and JS extensions can't apply to it; the web player is the only Spotify client themes work on.

```bash
node build.mjs --android                      # copy the shared UI + runtime into the app
cd android-app && ./gradlew assembleRelease   # → app/build/outputs/apk/release/app-release.apk
```

* **Player:** open.spotify.com in a WebView, presented as desktop Chrome to get the full player, with the Spectra runtime injected. Same themes, colours, snippets, CSS and extensions as the web version.
* **Dashboard:** the shared marketplace UI, served from the app. Open it with the floating Spectra button, the in-page Spectra menu, or long-press the app icon → **Themes**. Back returns to the player.
* **Background playback:** a media foreground service with lock-screen and notification controls (cover art, play/pause, next, previous, seek). Back from the player sends the app to the background instead of closing it.
* **Security:** the player page can't read settings or tokens. The app pushes them in (main frame only, GitHub token stripped), and the page can only report the current track or ask to open the dashboard.
* **Signing:** releases use `android-app/spectra-release.jks`, with its passwords in `keystore.properties`. Both are excluded from git. **Back them up**: Android only installs updates signed with the same key.
* **Building on Windows:** if Gradle fails with "Unable to establish loopback connection", set `JAVA_TOOL_OPTIONS=-Djdk.net.unixdomain.tmpdir=C:\Users\<you>\.gradle\sockets` (any existing folder).

## Spectra for Web

```bash
node build.mjs
```

* **Chrome, Edge, Brave or Opera:** open `chrome://extensions`, turn on Developer mode, click **Load unpacked** and pick `dist/chrome`.
* **Firefox 128+:** open `about:debugging#/runtime/this-firefox`, click **Load Temporary Add-on…** and pick `dist/firefox/manifest.json`. For a permanent install, sign `dist/spectra-firefox-*.zip` on addons.mozilla.org as an unlisted add-on.

## Website & update server (Vercel)

`website/` is the public site (home, download page) plus the API every Spectra install reads:

* `GET /api/manifest`: the live config (featured themes, extensions and snippets, CSS hotfixes, class-map fixes, remote scripts, blocked extensions, announcement, latest versions, download links, changelog). It's cached at the edge for 30 seconds, so edits reach every install within about half a minute.
* `/admin`: a password-protected editor for all of it. Saving publishes instantly; no new app version and no redeploy.

Installs check for changes on start and every 5 minutes. Remote **scripts** never run in the Firefox add-on (Mozilla forbids remote code there); CSS hotfixes and everything else do.

**Deploy once:**
1. `cd website`, then `npx vercel login`, then `npx vercel --prod` (pick a project name, e.g. `spectra-spotify`).
2. In the Vercel dashboard → your project → **Settings → Environment Variables**, add `ADMIN_TOKEN` (generate one with `node -e "console.log(require('crypto').randomBytes(24).toString('base64url'))"`).
3. **Storage** tab → **Create** → **Upstash for Redis** (free tier) → connect it to the project.
4. Redeploy: `npx vercel --prod`.
5. Put your site's address in `spectra.config.json` and run `node build.mjs`, so every version points at it. (Currently `https://usespectra.xyz`. `spectra.yooblueyyy.com` and `spectra-spotify.vercel.app` redirect there, but keep serving the API and downloads for older installs. Keep all three attached to the Vercel project.)

Big files (the Windows installer) belong on GitHub Releases. Paste their links into the admin page's download fields.

## Project layout

```
extension/
  runtime/spectra-runtime.js   ← runs inside Spotify (desktop AND web), one file
  dashboard/                   ← marketplace + editors (shared by both products)
  shared/core.js               ← color.ini parser, payload compiler
  bridge.js, background.js, popup/   ← browser-extension plumbing
desktop-app/
  src/main.js                  ← window, tray, settings, live push
  src/spotify.js               ← find / launch / attach to Spotify (CDP)
  src/preload.js               ← gives the shared dashboard its storage/messaging API
build.mjs                      ← builds the extension; `--app` copies the shared UI into desktop-app/ui
```

## Engine details

* **Colours.** Spicetify rewrites Spotify's CSS at install time (`#121212` → `var(--spice-main)` and so on). Spectra does it live, so new Spotify CSS is handled automatically. It also fixes two upstream bugs: `white;` glued declarations together, and `rgba(var(--spice-main),a)` was invalid CSS.
* **Class names.** Spicetify themes use readable names like `.main-nowPlayingBar-container`. Spectra maps them to Spotify's hashed classes with Spicetify's `css-map.json`: theme CSS becomes `:is(.readable,.hashed)`, so specificity doesn't change, and readable classes are added to the DOM for extensions.
* **`window.Spicetify`.** A compatibility layer with `React`, `ReactDOM`, `ReactJSX`, `Platform` (every service from Spotify's registry: `PlayerAPI`, `PlaybackAPI`, `LibraryAPI`, `PlaylistAPI`… resolved lazily), `Player`, `CosmosAsync`, `Topbar`/`Playbar` buttons, `ContextMenu` items in Spotify's own menus, `Menu`, `PopupModal`, `showNotification`, `URI`, `Keyboard`/`Mousetrap`, `LocalStorage`, `colorExtractor`, `GraphQL.Definitions`. If real Spicetify is installed, Spectra steps aside.

## Limitations

* Extensions run with the same access as Spotify's own UI. Only install ones you trust.
* Turning off or removing an extension takes effect after **Reload Spotify**, because JavaScript can't be unloaded. Themes, colours and CSS always apply live.
* Custom apps (full Spicetify pages like Lyrics Plus) aren't supported yet.
* On the web player, `Platform` only exists when you're signed in, and desktop-only endpoints (`sp://`, `wg://`) aren't available.
