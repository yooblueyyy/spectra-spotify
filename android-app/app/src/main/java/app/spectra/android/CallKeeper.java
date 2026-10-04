package app.spectra.android;

import android.content.Context;
import android.media.AudioManager;
import android.os.Handler;
import android.os.Looper;
import android.os.SystemClock;
import android.util.Log;

/**
 * Keeps the music going when a call starts.
 *
 * Three things can stop Spotify when a Meta/Discord call begins:
 *  1. The WebView asking Android for audio focus and being refused (handled in SpectraApp).
 *  2. The system pausing "media players" through Spectra's media session; during a call
 *     those pauses are ignored (see PlaybackService).
 *  3. Anything else: if playback stops during a call and the user didn't do it, resume.
 *
 * Every step is logged under the "Spectra" tag, so `adb logcat -s Spectra` shows what happened.
 */
final class CallKeeper {
    static final String TAG = "Spectra";
    private static final long USER_ACTION_WINDOW_MS = 2500;   // a pause this soon after a tap/key is the user's
    private static final long[] RESUME_DELAYS_MS = {300, 1000, 2500, 5000};

    private static final Handler main = new Handler(Looper.getMainLooper());
    private static boolean playing;
    private static long lastUserControlAt;

    private CallKeeper() {}

    /** True while a phone/VoIP call (Meta, Discord, …) has the audio system in call mode. */
    static boolean inCall(Context c) {
        try {
            AudioManager am = (AudioManager) c.getApplicationContext().getSystemService(Context.AUDIO_SERVICE);
            int mode = am.getMode();
            return mode == AudioManager.MODE_IN_CALL || mode == AudioManager.MODE_IN_COMMUNICATION
                    || mode == AudioManager.MODE_RINGTONE || mode == 4 /* MODE_CALL_SCREENING */;
        } catch (Exception e) {
            return false;
        }
    }

    static String modeName(int mode) {
        switch (mode) {
            case AudioManager.MODE_NORMAL: return "normal";
            case AudioManager.MODE_RINGTONE: return "ringing";
            case AudioManager.MODE_IN_CALL: return "in call";
            case AudioManager.MODE_IN_COMMUNICATION: return "in communication (VoIP call)";
            case 4: return "call screening";
            default: return "mode " + mode;
        }
    }

    /** The user pressed play/pause/next somewhere in Spectra's own controls. */
    static void onUserControl() {
        lastUserControlAt = SystemClock.elapsedRealtime();
    }

    /** The page reported a play-state change. sinceInputMs = time since the user last touched the page. */
    static void onPlayState(Context c, boolean nowPlaying, long sinceInputMs) {
        boolean was = playing;
        playing = nowPlaying;
        if (nowPlaying || !was) return;

        boolean call = inCall(c);
        long sinceControl = SystemClock.elapsedRealtime() - lastUserControlAt;
        boolean byUser = sinceInputMs < USER_ACTION_WINDOW_MS || sinceControl < USER_ACTION_WINDOW_MS;
        Log.i(TAG, "Playback stopped. In a call: " + call + ". Paused by you: " + byUser);
        if (call && !byUser) resume(c, 0);
    }

    private static void resume(Context c, int attempt) {
        if (attempt >= RESUME_DELAYS_MS.length) {
            Log.w(TAG, "Couldn't restart the music during the call after " + attempt + " tries");
            return;
        }
        main.postDelayed(() -> {
            if (playing) {
                Log.i(TAG, "Music is playing again during the call");
                return;
            }
            Log.i(TAG, "Restarting the music during the call (try " + (attempt + 1) + ")");
            PlayerHost.control("play");
            resume(c, attempt + 1);
        }, RESUME_DELAYS_MS[attempt]);
    }
}
