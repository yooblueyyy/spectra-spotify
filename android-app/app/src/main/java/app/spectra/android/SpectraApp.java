package app.spectra.android;

import android.app.Application;
import android.content.Context;
import android.media.AudioManager;
import android.media.SpectraFocusFreeAudioManager;
import android.util.Log;

/**
 * Keeps Spotify playing during calls.
 *
 * The WebView (Chromium) asks Android for audio focus whenever media plays and pauses
 * itself if that's refused or lost. During any call (Meta, Discord, phone…) the call
 * service holds focus with a lock, so Spotify always paused. The WebView gets its
 * AudioManager from this Application object, so we hand its focus code an AudioManager
 * that grants focus without asking the system. Everything else — sound output, volume,
 * devices — keeps using the real AudioManager.
 */
public final class SpectraApp extends Application {
    private static final String TAG = "Spectra";
    private AudioManager focusFree;
    private boolean focusFreeFailed;

    @Override
    public void onCreate() {
        super.onCreate();
        // Log call-mode changes, so `adb logcat -s Spectra` shows when a call starts and ends.
        if (android.os.Build.VERSION.SDK_INT >= 31) {
            try {
                AudioManager am = (AudioManager) super.getSystemService(Context.AUDIO_SERVICE);
                am.addOnModeChangedListener(getMainExecutor(), (mode) -> Log.i(TAG, "Audio mode is now: " + CallKeeper.modeName(mode)));
            } catch (Exception ignored) {}
        }
    }

    private final java.util.Set<String> loggedCallers = new java.util.HashSet<>();

    @Override
    public Object getSystemService(String name) {
        if (Context.AUDIO_SERVICE.equals(name)) {
            String chromiumCaller = null;
            boolean focusCode = false;
            for (StackTraceElement e : new Throwable().getStackTrace()) {
                String cls = e.getClassName();
                // org.chromium.content.browser.AudioFocusDelegate in the system WebView.
                if (cls.endsWith(".AudioFocusDelegate")) focusCode = true;
                if (chromiumCaller == null && cls.startsWith("org.chromium.")) chromiumCaller = cls + "." + e.getMethodName();
            }
            if (chromiumCaller != null) {
                synchronized (loggedCallers) {
                    if (loggedCallers.add(chromiumCaller)) Log.i(TAG, "Player code asked for the audio service: " + chromiumCaller + (focusCode ? " (focus: handled inside Spectra)" : ""));
                }
            }
            if (focusCode) {
                AudioManager am = focusFree();
                if (am != null) return am;
            }
        }
        return super.getSystemService(name);
    }

    private synchronized AudioManager focusFree() {
        if (focusFree == null && !focusFreeFailed) {
            try {
                focusFree = new SpectraFocusFreeAudioManager();
                Log.i(TAG, "Music keeps playing during calls: WebView audio focus requests are granted locally");
            } catch (Throwable t) {
                // A future Android may not allow this; then the WebView behaves as before.
                focusFreeFailed = true;
                Log.w(TAG, "Couldn't keep music playing during calls", t);
            }
        }
        return focusFree;
    }
}
