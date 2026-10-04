package app.spectra.android;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.graphics.drawable.Icon;
import android.media.MediaMetadata;
import android.media.session.MediaSession;
import android.media.session.PlaybackState;
import android.os.Build;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;

import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;

/**
 * Keeps Spectra alive while music plays (foreground "mediaPlayback" service) and
 * provides the lock-screen / notification player via a MediaSession. The audio
 * itself plays inside the WebView; controls are forwarded to the page.
 */
public class PlaybackService extends Service {
    static final String CHANNEL = "playback";
    static final int NOTIFICATION_ID = 1;
    static final String ACTION_TOGGLE = "app.spectra.android.TOGGLE";
    static final String ACTION_NEXT = "app.spectra.android.NEXT";
    static final String ACTION_PREV = "app.spectra.android.PREV";

    static final class Track {
        String title = "", artist = "", album = "", art = "";
        boolean playing;
        long duration, position;
    }

    private static PlaybackService instance;
    private static Track current;

    private final Handler main = new Handler(Looper.getMainLooper());
    private MediaSession session;
    private Bitmap artBitmap;
    private String artUrl;
    private boolean foreground;

    static boolean isPlaying() { return current != null && current.playing; }

    /** Called whenever the page reports a track/play-state change. */
    static void update(Context ctx, Track t) {
        current = t;
        if (instance != null) {
            instance.render();
        } else if (t.playing) {
            try {
                ctx.startForegroundService(new Intent(ctx, PlaybackService.class));
            } catch (Exception ignored) {
                // Starting from the background can be disallowed; the next foreground play starts it.
            }
        }
    }

    @Override
    public void onCreate() {
        super.onCreate();
        instance = this;
        NotificationManager nm = getSystemService(NotificationManager.class);
        NotificationChannel ch = new NotificationChannel(CHANNEL, getString(R.string.channel_playback), NotificationManager.IMPORTANCE_LOW);
        ch.setShowBadge(false);
        nm.createNotificationChannel(ch);

        session = new MediaSession(this, "Spectra");
        session.setCallback(new MediaSession.Callback() {
            @Override public void onPlay() { CallKeeper.onUserControl(); PlayerHost.control("play"); }
            @Override public void onPause() {
                // When a call starts, the system pauses media players through their media
                // session. Spectra's music should keep going, so ignore pauses during a call.
                if (CallKeeper.inCall(PlaybackService.this)) {
                    android.util.Log.i(CallKeeper.TAG, "Ignored a system pause during a call");
                    return;
                }
                CallKeeper.onUserControl();
                PlayerHost.control("pause");
            }
            @Override public void onStop() {
                if (CallKeeper.inCall(PlaybackService.this)) {
                    android.util.Log.i(CallKeeper.TAG, "Ignored a system stop during a call");
                    return;
                }
                PlayerHost.control("pause");
            }
            @Override public void onSkipToNext() { CallKeeper.onUserControl(); PlayerHost.control("next"); }
            @Override public void onSkipToPrevious() { CallKeeper.onUserControl(); PlayerHost.control("prev"); }
            @Override public void onSeekTo(long pos) { PlayerHost.control("seek:" + pos); }
        });
        session.setActive(true);
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        String action = intent != null ? intent.getAction() : null;
        if (action != null) CallKeeper.onUserControl();
        if (ACTION_TOGGLE.equals(action)) PlayerHost.control("toggle");
        else if (ACTION_NEXT.equals(action)) PlayerHost.control("next");
        else if (ACTION_PREV.equals(action)) PlayerHost.control("prev");
        // startForegroundService() requires startForeground() promptly, every time.
        goForeground(buildNotification());
        render();
        return START_NOT_STICKY;
    }

    private void goForeground(Notification n) {
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) startForeground(NOTIFICATION_ID, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK);
            else startForeground(NOTIFICATION_ID, n);
            foreground = true;
        } catch (Exception ignored) {}
    }

    private void render() {
        Track t = current;
        if (t == null) return;
        loadArt(t.art);

        MediaMetadata.Builder md = new MediaMetadata.Builder()
                .putString(MediaMetadata.METADATA_KEY_TITLE, t.title)
                .putString(MediaMetadata.METADATA_KEY_ARTIST, t.artist)
                .putString(MediaMetadata.METADATA_KEY_ALBUM, t.album)
                .putLong(MediaMetadata.METADATA_KEY_DURATION, t.duration);
        if (artBitmap != null) md.putBitmap(MediaMetadata.METADATA_KEY_ALBUM_ART, artBitmap);
        session.setMetadata(md.build());
        session.setPlaybackState(new PlaybackState.Builder()
                .setActions(PlaybackState.ACTION_PLAY | PlaybackState.ACTION_PAUSE | PlaybackState.ACTION_PLAY_PAUSE
                        | PlaybackState.ACTION_SKIP_TO_NEXT | PlaybackState.ACTION_SKIP_TO_PREVIOUS | PlaybackState.ACTION_SEEK_TO)
                .setState(t.playing ? PlaybackState.STATE_PLAYING : PlaybackState.STATE_PAUSED, t.position, t.playing ? 1f : 0f)
                .build());

        Notification n = buildNotification();
        if (t.playing) {
            goForeground(n);
        } else {
            // Paused: let the user swipe the notification away and let Android reclaim us.
            if (foreground) { stopForeground(STOP_FOREGROUND_DETACH); foreground = false; }
            getSystemService(NotificationManager.class).notify(NOTIFICATION_ID, n);
        }
    }

    private Notification buildNotification() {
        Track t = current != null ? current : new Track();
        PendingIntent open = PendingIntent.getActivity(this, 0,
                new Intent(this, MainActivity.class).setFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP),
                PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
        Notification.Builder b = new Notification.Builder(this, CHANNEL)
                .setSmallIcon(R.drawable.ic_stat_spectra)
                .setContentTitle(t.title.isEmpty() ? getString(R.string.app_name) : t.title)
                .setContentText(t.artist)
                .setContentIntent(open)
                .setVisibility(Notification.VISIBILITY_PUBLIC)
                .setOnlyAlertOnce(true)
                .setShowWhen(false)
                .setOngoing(t.playing)
                .addAction(act(android.R.drawable.ic_media_previous, "Previous", ACTION_PREV, 1))
                .addAction(act(t.playing ? android.R.drawable.ic_media_pause : android.R.drawable.ic_media_play, t.playing ? "Pause" : "Play", ACTION_TOGGLE, 2))
                .addAction(act(android.R.drawable.ic_media_next, "Next", ACTION_NEXT, 3))
                .setStyle(new Notification.MediaStyle().setMediaSession(session.getSessionToken()).setShowActionsInCompactView(0, 1, 2));
        if (artBitmap != null) b.setLargeIcon(artBitmap);
        return b.build();
    }

    private Notification.Action act(int icon, String label, String a, int code) {
        return new Notification.Action.Builder(Icon.createWithResource(this, icon), label, action(a, code)).build();
    }

    private PendingIntent action(String a, int code) {
        return PendingIntent.getService(this, code, new Intent(this, PlaybackService.class).setAction(a), PendingIntent.FLAG_IMMUTABLE);
    }

    private void loadArt(String url) {
        if (url == null || url.isEmpty() || url.equals(artUrl)) return;
        artUrl = url;
        final String fetchUrl = url.startsWith("spotify:image:") ? "https://i.scdn.co/image/" + url.substring("spotify:image:".length()) : url;
        if (!fetchUrl.startsWith("https://")) return;
        new Thread(() -> {
            try {
                HttpURLConnection c = (HttpURLConnection) new URL(fetchUrl).openConnection();
                c.setConnectTimeout(8000);
                c.setReadTimeout(8000);
                try (InputStream in = c.getInputStream()) {
                    Bitmap bmp = BitmapFactory.decodeStream(in);
                    main.post(() -> {
                        if (!fetchUrl.equals(artUrl) && !url.equals(artUrl)) return;
                        artBitmap = bmp;
                        render();
                    });
                }
            } catch (Exception ignored) {}
        }).start();
    }

    @Override
    public void onDestroy() {
        instance = null;
        if (session != null) session.release();
        super.onDestroy();
    }

    @Override
    public IBinder onBind(Intent intent) { return null; }
}
