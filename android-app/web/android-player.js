/*
 * Spectra for Android: glue between the native app and the Spectra runtime
 * running inside open.spotify.com.
 *
 * The native side only ever pushes data *in* (evaluateJavascript, main frame
 * only). The page can only send two kinds of messages out: the current track
 * (for the lock-screen / notification player) and "open the dashboard".
 * Settings, tokens and storage are never readable from the page.
 */
(function () {
  "use strict";
  if (window.__spectraAndroidGlue) return;
  window.__spectraAndroidGlue = true;

  const send = (obj) => { try { window.SpectraAndroid.post(JSON.stringify(obj)); } catch (e) {} };

  // The runtime calls this for in-page actions like "Open Spectra dashboard".
  window.__spectraHost = (json) => {
    try { const m = JSON.parse(json); if (m && m.type === "openDashboard") send({ type: "openDashboard" }); } catch (e) {}
  };

  window.__spectraAndroidApply = (state, cssMap, remote) => {
    const p = window.SpectraCore.compilePayload(state, remote || null, { platform: "quest", allowRemoteScripts: true });
    p.cssMap = cssMap || null;
    if (window.__spectra) window.__spectra.apply(p);
    else window.__spectraPendingPayload = p;
  };

  // Tell the app whether Spectra's own button is in Spotify's top bar, so it can
  // hide its floating button and avoid a duplicate.
  // It has to be actually visible: themes often hide the top-bar area it sits in.
  const visible = (b) => {
    if (!b || !b.isConnected) return false;
    if (b.checkVisibility && !b.checkVisibility({ opacityProperty: true, visibilityProperty: true })) return false;
    const r = b.getBoundingClientRect();
    if (!(r.width >= 8 && r.height >= 8 && r.bottom > 0 && r.right > 0 && r.top < innerHeight && r.left < innerWidth)) return false;
    // And actually tappable: nothing from the theme lying on top of it.
    const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    return !hit || b.contains(hit) || !!hit.closest("#spectra-menu, #spectra-modal, [role=dialog]");
  };
  let lastButton = null, misses = 0;
  setInterval(() => {
    // Two misses in a row before showing the app's own button, so a passing popup doesn't flicker it.
    misses = visible(document.querySelector('#spectra-topbar button[aria-label="Spectra"]')) ? 0 : misses + 1;
    const present = misses < 2;
    if (present !== lastButton) { lastButton = present; send({ type: "chrome", spectraButton: present }); }
  }, 1500);

  // When the user last tapped/typed in the page, so the app can tell a pause they made
  // from one forced on the music (e.g. by a call starting).
  let lastInput = 0;
  const markInput = () => { lastInput = Date.now(); };
  for (const ev of ["pointerdown", "touchstart", "keydown"]) window.addEventListener(ev, markInput, { capture: true, passive: true });

  // Report the now-playing track so Android can show lock-screen controls.
  let last = "";
  setInterval(() => {
    const S = window.Spicetify;
    if (!S || !S.Player) return;
    let d;
    try { d = S.Player.data; } catch (e) { return; }
    const it = d && d.item;
    if (!it) return;
    const md = it.metadata || {};
    const info = {
      type: "track",
      title: md.title || it.name || "",
      artist: md.artist_name || (it.artists || []).map((a) => a.name).join(", "),
      album: md.album_title || (it.album && it.album.name) || "",
      art: md.image_xlarge_url || md.image_large_url || md.image_url || "",
      playing: !d.isPaused,
      duration: +d.duration || 0,
      position: (() => { try { return +S.Player.getProgress() || 0; } catch (e) { return 0; } })(),
    };
    const key = [info.title, info.artist, info.playing, info.art].join("\u0001");
    if (key !== last) { last = key; info.sinceInput = lastInput ? Date.now() - lastInput : 1e9; send(info); }
  }, 1000);
})();
