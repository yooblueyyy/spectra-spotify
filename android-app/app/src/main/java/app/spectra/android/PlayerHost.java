package app.spectra.android;

import android.app.Activity;
import android.content.Context;
import android.content.Intent;
import android.content.MutableContextWrapper;
import android.graphics.Color;
import android.net.Uri;
import android.os.Handler;
import android.os.Looper;
import android.view.ViewGroup;
import android.webkit.CookieManager;
import android.webkit.JavascriptInterface;
import android.webkit.PermissionRequest;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;

import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Owns the Spotify player WebView independently of the window.
 *
 * On Quest, closing an app's panel destroys its Activity. The player lives here
 * instead (wrapped in a MutableContextWrapper), so music keeps playing with the
 * window closed and the next window simply re-attaches the same player.
 */
final class PlayerHost {
    static final String PLAYER_HOST = "open.spotify.com";
    static final String PLAYER_URL = "https://open.spotify.com/";

    interface Ui {
        void showDashboard(boolean show);
        void setSpectraButtonPresent(boolean present);
    }

    private static PlayerHost instance;

    private final Context app;
    private final MutableContextWrapper ctx;
    private final WebView web;
    private final Handler main = new Handler(Looper.getMainLooper());
    private final String bundle;
    private Ui ui;

    static PlayerHost get(Activity activity) {
        if (instance == null) instance = new PlayerHost(activity);
        return instance;
    }

    static PlayerHost peek() { return instance; }

    private PlayerHost(Activity activity) {
        app = activity.getApplicationContext();
        ctx = new MutableContextWrapper(activity);
        bundle = readAsset(app, "spectra-player.js");
        web = new WebView(ctx);
        setup();
        CookieManager cm = CookieManager.getInstance();
        cm.setAcceptCookie(true);
        cm.setAcceptThirdPartyCookies(web, true);
        web.loadUrl(PLAYER_URL);
    }

    WebView view() { return web; }

    /** Attach the long-lived player to a (new) window. */
    void attach(Activity activity, ViewGroup parent, Ui ui) {
        this.ui = ui;
        ctx.setBaseContext(activity);
        if (web.getParent() instanceof ViewGroup) ((ViewGroup) web.getParent()).removeView(web);
        parent.addView(web, 0, new ViewGroup.LayoutParams(-1, -1));
    }

    /**
     * The window is going away. Keep the player alive while music plays;
     * otherwise free it so a closed, idle Spectra uses no resources.
     */
    void detach(Activity activity) {
        if (ctx.getBaseContext() != activity) return;
        ui = null;
        if (web.getParent() instanceof ViewGroup) ((ViewGroup) web.getParent()).removeView(web);
        if (PlaybackService.isPlaying()) {
            ctx.setBaseContext(app);
        } else {
            web.destroy();
            instance = null;
        }
    }

    // ------------------------------------------------------------------ setup

    private void setup() {
        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setDatabaseEnabled(true);
        s.setMediaPlaybackRequiresUserGesture(false);
        s.setSupportZoom(true);
        s.setBuiltInZoomControls(true);
        s.setDisplayZoomControls(false);
        s.setSupportMultipleWindows(false);
        s.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        s.setAllowFileAccess(false);
        s.setAllowContentAccess(false);
        // Spotify only serves the full web player to desktop browsers.
        s.setUserAgentString(desktopUserAgent(s.getUserAgentString()));
        web.setBackgroundColor(Color.BLACK);
        web.addJavascriptInterface(new Bridge(), "SpectraAndroid");

        web.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest req) {
                Uri u = req.getUrl();
                if (!"https".equals(u.getScheme())) return true; // spotify:, intent:, etc.
                if (isAllowedHost(u.getHost())) return false;
                openExternal(u);
                return true;
            }

            @Override public void onPageStarted(WebView view, String url, android.graphics.Bitmap favicon) { if (isPlayer(url)) inject(); }
            @Override public void onPageCommitVisible(WebView view, String url) { if (isPlayer(url)) inject(); }
            @Override public void onPageFinished(WebView view, String url) { if (isPlayer(url)) inject(); }
        });

        web.setWebChromeClient(new WebChromeClient() {
            @Override
            public void onPermissionRequest(PermissionRequest request) {
                // Only DRM (Widevine) for Spotify itself — needed to play music. Nothing else.
                Uri origin = request.getOrigin();
                String host = origin != null ? origin.getHost() : null;
                boolean spotify = host != null && (host.equals("spotify.com") || host.endsWith(".spotify.com"));
                for (String r : request.getResources()) {
                    if (spotify && PermissionRequest.RESOURCE_PROTECTED_MEDIA_ID.equals(r)) {
                        request.grant(new String[]{PermissionRequest.RESOURCE_PROTECTED_MEDIA_ID});
                        return;
                    }
                }
                request.deny();
            }
        });
    }

    static boolean isPlayer(String url) {
        try { return PLAYER_HOST.equals(Uri.parse(url).getHost()); } catch (Exception e) { return false; }
    }

    /** Spotify, its CDNs and the sign-in providers Spotify offers stay in-app; everything else opens in the browser. */
    private static boolean isAllowedHost(String host) {
        if (host == null) return false;
        String[] allowed = {"spotify.com", "spotifycdn.com", "scdn.co", "spotify.net", "google.com", "gstatic.com",
                "facebook.com", "apple.com", "recaptcha.net"};
        for (String a : allowed) if (host.equals(a) || host.endsWith("." + a)) return true;
        return false;
    }

    private static String desktopUserAgent(String webViewUa) {
        Matcher m = Pattern.compile("Chrome/([\\d.]+)").matcher(webViewUa == null ? "" : webViewUa);
        String ver = m.find() ? m.group(1) : "130.0.0.0";
        return "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/" + ver + " Safari/537.36";
    }

    private void openExternal(Uri u) {
        try {
            app.startActivity(new Intent(Intent.ACTION_VIEW, u).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
        } catch (Exception ignored) {}
    }

    // ------------------------------------------------------------------ page <-> app

    /** Idempotent: the bundle guards against double-loading; this also (re)sends the current settings. */
    private void inject() {
        if (bundle == null) return;
        web.evaluateJavascript(bundle, null);
        pushState();
    }

    /** Sends settings into the page. Main frame only; secrets are stripped first. */
    void pushState() {
        if (!isPlayer(web.getUrl())) return;
        try {
            SpectraStore store = SpectraStore.get(app);
            Object stateObj = store.opt("state");
            JSONObject state = stateObj instanceof JSONObject ? new JSONObject(stateObj.toString()) : new JSONObject();
            JSONObject options = state.optJSONObject("options");
            if (options != null) options.remove("githubToken");
            Object cssMapObj = store.opt("cssMap");
            String cssMap = cssMapObj instanceof JSONObject && ((JSONObject) cssMapObj).has("map")
                    ? ((JSONObject) cssMapObj).getJSONObject("map").toString() : "null";
            Object remoteObj = store.opt("remote");
            String remote = remoteObj instanceof JSONObject && ((JSONObject) remoteObj).has("data")
                    ? ((JSONObject) remoteObj).getJSONObject("data").toString() : "null";
            web.evaluateJavascript("window.__spectraAndroidApply&&window.__spectraAndroidApply(" + state + "," + cssMap + "," + remote + ")", null);
        } catch (Exception ignored) {}
    }

    void reload() { web.reload(); }

    boolean goBack() {
        if (!web.canGoBack()) return false;
        web.goBack();
        return true;
    }

    /** Notification / lock-screen controls → page. Works with or without a window. */
    static void control(String cmd) {
        PlayerHost h = instance;
        if (h == null) return;
        h.main.post(() -> {
            String js;
            switch (cmd) {
                case "play": js = "Spicetify.Player.play()"; break;
                case "pause": js = "Spicetify.Player.pause()"; break;
                case "toggle": js = "Spicetify.Player.togglePlay()"; break;
                case "next": js = "Spicetify.Player.next()"; break;
                case "prev": js = "Spicetify.Player.back()"; break;
                default:
                    if (cmd.startsWith("seek:")) js = "Spicetify.Player.seek(" + Long.parseLong(cmd.substring(5)) + ")";
                    else return;
            }
            h.web.evaluateJavascript("try{" + js + "}catch(e){}", null);
        });
    }

    /** Exposed to the player page (all frames). Accepts only track reports, UI hints and "open dashboard". */
    final class Bridge {
        @JavascriptInterface
        public void post(String json) {
            try {
                JSONObject m = new JSONObject(json);
                switch (m.optString("type")) {
                    case "openDashboard":
                        main.post(() -> {
                            if (ui != null) ui.showDashboard(true);
                            else openWindow(true);
                        });
                        break;
                    case "chrome":
                        boolean present = m.optBoolean("spectraButton");
                        main.post(() -> { if (ui != null) ui.setSpectraButtonPresent(present); });
                        break;
                    case "track":
                        PlaybackService.Track t = new PlaybackService.Track();
                        t.title = clip(m.optString("title"));
                        t.artist = clip(m.optString("artist"));
                        t.album = clip(m.optString("album"));
                        t.art = clip(m.optString("art"));
                        t.playing = m.optBoolean("playing");
                        t.duration = Math.max(0, m.optLong("duration"));
                        t.position = Math.max(0, m.optLong("position"));
                        long sinceInput = m.optLong("sinceInput", Long.MAX_VALUE);
                        main.post(() -> {
                            PlaybackService.update(app, t);
                            CallKeeper.onPlayState(app, t.playing, sinceInput);
                        });
                        break;
                }
            } catch (Exception ignored) {}
        }
    }

    private void openWindow(boolean dashboard) {
        Intent i = new Intent(app, MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        if (dashboard) i.setAction(MainActivity.ACTION_OPEN_DASHBOARD);
        try { app.startActivity(i); } catch (Exception ignored) {}
    }

    private static String clip(String s) { return s == null ? "" : s.length() > 300 ? s.substring(0, 300) : s; }

    static String readAsset(Context c, String path) {
        try (InputStream in = c.getAssets().open(path)) {
            ByteArrayOutputStream out = new ByteArrayOutputStream();
            byte[] buf = new byte[16384];
            int n;
            while ((n = in.read(buf)) > 0) out.write(buf, 0, n);
            return new String(out.toByteArray(), StandardCharsets.UTF_8);
        } catch (Exception e) {
            return null;
        }
    }
}
