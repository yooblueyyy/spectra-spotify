package android.media;

/**
 * An AudioManager that says "yes" to audio focus without asking the system.
 *
 * Only the WebView's media focus code gets this (see app.spectra.android.SpectraApp).
 * During a call, Android's call service holds audio focus with a lock, so the WebView's
 * focus requests are refused and it pauses Spotify itself. The music stream is not
 * muted by the system, so if the WebView never asks, the music simply keeps playing.
 *
 * Lives in android.media only so it can reach AudioManager's constructor. It overrides
 * just the four focus methods; the WebView's focus code uses nothing else.
 */
public final class SpectraFocusFreeAudioManager extends AudioManager {
    public SpectraFocusFreeAudioManager() {
        super();
    }

    @Override
    public int requestAudioFocus(OnAudioFocusChangeListener listener, int streamType, int durationHint) {
        android.util.Log.i("Spectra", "Player asked for audio focus: granted inside Spectra, the system wasn't asked");
        return AUDIOFOCUS_REQUEST_GRANTED;
    }

    @Override
    public int abandonAudioFocus(OnAudioFocusChangeListener listener) {
        return AUDIOFOCUS_REQUEST_GRANTED;
    }

    @Override
    public int requestAudioFocus(AudioFocusRequest request) {
        return AUDIOFOCUS_REQUEST_GRANTED;
    }

    @Override
    public int abandonAudioFocusRequest(AudioFocusRequest request) {
        return AUDIOFOCUS_REQUEST_GRANTED;
    }
}
