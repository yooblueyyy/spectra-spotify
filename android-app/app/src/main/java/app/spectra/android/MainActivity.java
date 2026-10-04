package app.spectra.android;

import android.Manifest;
import android.app.Activity;
import android.content.ContentValues;
import android.content.Intent;
import android.content.pm.ApplicationInfo;
import android.content.pm.PackageManager;
import android.graphics.Color;
import android.graphics.drawable.GradientDrawable;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Environment;
import android.os.Handler;
import android.os.Looper;
import android.provider.MediaStore;
import android.view.Gravity;
import android.view.View;
import android.view.WindowInsets;
import android.webkit.JavascriptInterface;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.FrameLayout;
import android.widget.ImageButton;

import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;

/**
 * The Spectra window: the long-lived Spotify player (see PlayerHost) plus the
 * shared Spectra dashboard, which is served from app assets.
 */
public class MainActivity extends Activity implements PlayerHost.Ui {
    // Reserved by Android for app-served content; never resolves on the network.
    static final String ASSET_HOST = "appassets.androidplatform.net";
    static final String DASH_URL = "https://" + ASSET_HOST + "/ui/dashboard/index.html";
    static final String ACTION_OPEN_DASHBOARD = "app.spectra.android.OPEN_DASHBOARD";
    static final String CSS_MAP_URL = "https://raw.githubusercontent.com/spicetify/cli/main/css-map.json";
    static final long CSS_MAP_TTL = 24L * 60 * 60 * 1000;

    private final Handler main = new Handler(Looper.getMainLooper());
    private SpectraStore store;
    private PlayerHost player;
    private WebView dash;
    private ImageButton fab;
    private boolean dashLoaded;
    private boolean pageHasSpectraButton;
    private ValueCallback<Uri[]> fileCallback;

    // ------------------------------------------------------------------ lifecycle

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        store = SpectraStore.get(this);
        if ((getApplicationInfo().flags & ApplicationInfo.FLAG_DEBUGGABLE) != 0) WebView.setWebContentsDebuggingEnabled(true);

        FrameLayout root = new FrameLayout(this);
        root.setBackgroundColor(Color.BLACK);
        root.setOnApplyWindowInsetsListener((v, insets) -> {
            int l, t, r, b;
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
                android.graphics.Insets i = insets.getInsets(WindowInsets.Type.systemBars() | WindowInsets.Type.displayCutout() | WindowInsets.Type.ime());
                l = i.left; t = i.top; r = i.right; b = i.bottom;
            } else {
                l = insets.getSystemWindowInsetLeft(); t = insets.getSystemWindowInsetTop();
                r = insets.getSystemWindowInsetRight(); b = insets.getSystemWindowInsetBottom();
            }
            v.setPadding(l, t, r, b);
            return insets;
        });
        setContentView(root);

        // Re-uses the already-running player if music kept playing while the window was closed.
        player = PlayerHost.get(this);
        player.attach(this, root, this);

        dash = new WebView(this);
        setupDashboard(dash);
        dash.setVisibility(View.GONE);
        root.addView(dash, new FrameLayout.LayoutParams(-1, -1));

        fab = makeFab();
        // Bottom-left sits clear of Spotify's top bar and the playback controls on a wide panel.
        FrameLayout.LayoutParams fp = new FrameLayout.LayoutParams(dp(36), dp(36), Gravity.BOTTOM | Gravity.START);
        fp.setMargins(dp(14), 0, 0, dp(104));
        root.addView(fab, fp);

        if (Build.VERSION.SDK_INT >= 33 && checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
            requestPermissions(new String[]{Manifest.permission.POST_NOTIFICATIONS}, 1);
        }
        ensureCssMap(false);
        ensureRemote(true);
        handleIntent(getIntent());
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        handleIntent(intent);
    }

    private void handleIntent(Intent intent) {
        if (intent != null && ACTION_OPEN_DASHBOARD.equals(intent.getAction())) showDashboard(true);
    }

    // Deliberately no WebView.onPause()/pauseTimers(): that would stop the music.

    @Override
    public void onBackPressed() {
        if (dash.getVisibility() == View.VISIBLE) { showDashboard(false); return; }
        if (player.goBack()) return;
        moveTaskToBack(true); // keep playing in the background
    }

    @Override
    protected void onDestroy() {
        main.removeCallbacks(remotePoll);
        player.detach(this);
        dash.destroy();
        super.onDestroy();
    }

    // ------------------------------------------------------------------ PlayerHost.Ui

    @Override
    public void showDashboard(boolean show) {
        if (show && !dashLoaded) { dash.loadUrl(DASH_URL); dashLoaded = true; }
        dash.setVisibility(show ? View.VISIBLE : View.GONE);
        updateFab();
        if (show) dash.requestFocus(); else player.view().requestFocus();
    }

    /** Hide the floating button once Spectra's own button is visible in Spotify's top bar. */
    @Override
    public void setSpectraButtonPresent(boolean present) {
        pageHasSpectraButton = present;
        updateFab();
    }

    private void updateFab() {
        boolean dashOpen = dash.getVisibility() == View.VISIBLE;
        fab.setVisibility(dashOpen || pageHasSpectraButton ? View.GONE : View.VISIBLE);
    }

    // ------------------------------------------------------------------ dashboard

    private void setupDashboard(WebView w) {
        WebSettings s = w.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setAllowFileAccess(false);
        s.setAllowContentAccess(false);
        s.setSupportMultipleWindows(false);
        w.setBackgroundColor(Color.parseColor("#0b0b0f"));
        w.addJavascriptInterface(new DashBridge(), "SpectraNative");

        w.setWebViewClient(new WebViewClient() {
            @Override
            public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest req) {
                Uri u = req.getUrl();
                if (!ASSET_HOST.equals(u.getHost())) return null;
                String path = u.getPath() == null ? "" : u.getPath().replaceFirst("^/+", "");
                if (path.contains("..")) return null;
                try {
                    InputStream in = getAssets().open(path);
                    return new WebResourceResponse(mime(path), "utf-8", in);
                } catch (Exception e) {
                    return new WebResourceResponse("text/plain", "utf-8", 404, "Not Found", null, null);
                }
            }

            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest req) {
                Uri u = req.getUrl();
                if (ASSET_HOST.equals(u.getHost())) return false;
                openExternal(u); // README / GitHub links, target=_blank, etc.
                return true;
            }
        });

        w.setWebChromeClient(new WebChromeClient() {
            @Override
            public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> cb, FileChooserParams params) {
                if (fileCallback != null) fileCallback.onReceiveValue(null);
                fileCallback = cb;
                try {
                    startActivityForResult(params.createIntent(), 42);
                } catch (Exception e) {
                    fileCallback = null;
                    return false;
                }
                return true;
            }
        });
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        if (requestCode == 42 && fileCallback != null) {
            fileCallback.onReceiveValue(WebChromeClient.FileChooserParams.parseResult(resultCode, data));
            fileCallback = null;
        }
    }

    /** Exposed only to the dashboard WebView, which never loads third-party pages. */
    final class DashBridge {
        @JavascriptInterface
        public String storageGet(String keysJson) {
            return store.getJson(keysJson);
        }

        @JavascriptInterface
        public void storageSet(String objJson) {
            JSONObject changes = store.set(objJson);
            main.post(() -> {
                dash.evaluateJavascript("window.__spectraStorageChanged&&window.__spectraStorageChanged(" + changes + ")", null);
                if (changes.has("state") || changes.has("cssMap")) player.pushState();
            });
        }

        @JavascriptInterface
        public String sendMessage(String json) {
            try {
                JSONObject m = new JSONObject(json);
                switch (m.optString("type")) {
                    case "reloadSpotifyTabs":
                        main.post(() -> { player.reload(); showDashboard(false); });
                        return "{\"ok\":true}";
                    case "ensureCssMap":
                        ensureCssMap(m.optBoolean("force"));
                        return "{\"ok\":true}";
                    case "ensureRemote":
                        ensureRemote(m.optBoolean("force"));
                        return "{\"ok\":true}";
                    case "appInfo":
                        return new JSONObject().put("platform", "quest").put("version", BuildInfo.versionName(MainActivity.this)).toString();
                    case "openDashboard":
                        main.post(() -> showDashboard(true));
                        return "{\"ok\":true}";
                    case "saveFile":
                        return saveToDownloads(m.optString("name", "spectra.json"), m.optString("content"));
                    default:
                        return "{\"ok\":false}";
                }
            } catch (Exception e) {
                return "{\"ok\":false}";
            }
        }
    }

    // ------------------------------------------------------------------ helpers

    private void ensureCssMap(boolean force) {
        Object cur = store.opt("cssMap");
        if (!force && cur instanceof JSONObject && System.currentTimeMillis() - ((JSONObject) cur).optLong("fetchedAt") < CSS_MAP_TTL) return;
        new Thread(() -> {
            try {
                HttpURLConnection c = (HttpURLConnection) new URL(CSS_MAP_URL).openConnection();
                c.setConnectTimeout(15000);
                c.setReadTimeout(30000);
                try (InputStream in = c.getInputStream()) {
                    JSONObject map = new JSONObject(new String(readAll(in), StandardCharsets.UTF_8));
                    JSONObject wrapped = new JSONObject().put("map", map).put("fetchedAt", System.currentTimeMillis());
                    store.set(new JSONObject().put("cssMap", wrapped).toString());
                    main.post(() -> { PlayerHost h = PlayerHost.peek(); if (h != null) h.pushState(); });
                }
            } catch (Exception ignored) {}
        }).start();
    }

    /** Remote config from the update server: featured catalog, hotfixes, class-map fixes, scripts. */
    private void ensureRemote(boolean force) {
        Object cur = store.opt("remote");
        long ttl = 5L * 60 * 1000;
        if (!force && cur instanceof JSONObject && System.currentTimeMillis() - ((JSONObject) cur).optLong("fetchedAt") < ttl) return;
        String base = "https://usespectra.xyz";
        try {
            Object st = store.opt("state");
            JSONObject opts = st instanceof JSONObject ? ((JSONObject) st).optJSONObject("options") : null;
            String custom = opts != null ? opts.optString("updateServer", "") : "";
            if (custom.startsWith("https://")) base = custom.replaceAll("/+$", "");
        } catch (Exception ignored) {}
        final String url = base + "/api/manifest";
        new Thread(() -> {
            try {
                HttpURLConnection c = (HttpURLConnection) new URL(url).openConnection();
                c.setConnectTimeout(15000);
                c.setReadTimeout(30000);
                c.setUseCaches(false);
                try (InputStream in = c.getInputStream()) {
                    JSONObject data = new JSONObject(new String(readAll(in), StandardCharsets.UTF_8));
                    JSONObject wrapped = new JSONObject().put("data", data).put("fetchedAt", System.currentTimeMillis()).put("from", url);
                    JSONObject changes = store.set(new JSONObject().put("remote", wrapped).toString());
                    main.post(() -> {
                        if (dashLoaded) dash.evaluateJavascript("window.__spectraStorageChanged&&window.__spectraStorageChanged(" + changes + ")", null);
                        PlayerHost h = PlayerHost.peek();
                        if (h != null) h.pushState();
                    });
                }
            } catch (Exception ignored) {}
        }).start();
        main.removeCallbacks(remotePoll);
        main.postDelayed(remotePoll, ttl);
    }

    private final Runnable remotePoll = () -> ensureRemote(false);

    private String saveToDownloads(String name, String content) {
        String safe = name.replaceAll("[^\\w.-]", "_");
        byte[] bytes = content.getBytes(StandardCharsets.UTF_8);
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                ContentValues v = new ContentValues();
                v.put(MediaStore.Downloads.DISPLAY_NAME, safe);
                v.put(MediaStore.Downloads.MIME_TYPE, "application/json");
                Uri uri = getContentResolver().insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, v);
                if (uri == null) throw new Exception("insert failed");
                try (OutputStream out = getContentResolver().openOutputStream(uri)) { out.write(bytes); }
            } else {
                File dir = getExternalFilesDir(Environment.DIRECTORY_DOWNLOADS);
                try (FileOutputStream out = new FileOutputStream(new File(dir, safe))) { out.write(bytes); }
            }
            return "{\"ok\":true}";
        } catch (Exception e) {
            return "{\"ok\":false,\"error\":\"Couldn't save the file\"}";
        }
    }

    private void openExternal(Uri u) {
        try { startActivity(new Intent(Intent.ACTION_VIEW, u)); } catch (Exception ignored) {}
    }

    private ImageButton makeFab() {
        ImageButton b = new ImageButton(this);
        b.setImageResource(R.drawable.ic_stat_spectra);
        b.setContentDescription(getString(R.string.open_spectra));
        GradientDrawable bg = new GradientDrawable(GradientDrawable.Orientation.TL_BR, new int[]{0xFF8B5CF6, 0xFF22D3A6});
        bg.setShape(GradientDrawable.OVAL);
        b.setBackground(bg);
        b.setAlpha(0.9f);
        b.setPadding(dp(8), dp(8), dp(8), dp(8));
        b.setScaleType(ImageButton.ScaleType.FIT_CENTER);
        b.setElevation(dp(6));
        b.setOnClickListener(v -> showDashboard(true));
        return b;
    }

    private int dp(int v) { return Math.round(v * getResources().getDisplayMetrics().density); }

    private static byte[] readAll(InputStream in) throws java.io.IOException {
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        byte[] buf = new byte[16384];
        int n;
        while ((n = in.read(buf)) > 0) out.write(buf, 0, n);
        return out.toByteArray();
    }

    private static String mime(String path) {
        String p = path.toLowerCase();
        if (p.endsWith(".html")) return "text/html";
        if (p.endsWith(".js")) return "text/javascript";
        if (p.endsWith(".css")) return "text/css";
        if (p.endsWith(".png")) return "image/png";
        if (p.endsWith(".svg")) return "image/svg+xml";
        if (p.endsWith(".json")) return "application/json";
        return "application/octet-stream";
    }
}
