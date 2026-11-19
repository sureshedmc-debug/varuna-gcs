package ai.varuna.cam;

import android.content.Context;
import android.content.SharedPreferences;

/**
 * Video presets. The choice is kept across restarts. The video goes out as
 * H.264 (/h264): smooth, and a fraction of MJPEG's data, with the bitrate
 * fitted to the Wi-Fi as it goes, up to the preset's most. The JPEG quality is
 * for the MJPEG backup stream (/video), which VARUNA Cam also lowers while the
 * Wi-Fi can't carry more.
 */
final class Quality {
    final String id;
    final String label;
    final int width;
    final int height;
    final int fps;
    final int jpeg;      // highest JPEG quality for /video, 0-100
    final int maxKbps;   // highest H.264 bitrate

    private Quality(String id, String label, int width, int height, int fps, int jpeg, int maxKbps) {
        this.id = id;
        this.label = label;
        this.width = width;
        this.height = height;
        this.fps = fps;
        this.jpeg = jpeg;
        this.maxKbps = maxKbps;
    }

    /** Lightest: a very weak 4G uplink. */
    static final Quality SD = new Quality("480p", "480p light", 640, 480, 25, 70, 1000);
    /**
     * The default, made for NetBird over 4G: 540p at 25 fps in about 1.5 Mbit/s.
     * A WireGuard tunnel over mobile data carries far less than Wi-Fi and jitters,
     * so the video has to be lean to stay smooth and live. The detector resizes
     * every frame to 640 wide anyway, so 960 wide loses it nothing, and the
     * bitrate adapts down further by itself when the link tightens.
     */
    static final Quality NB = new Quality("nb540", "NetBird 540p (4G / VPN)", 960, 540, 25, 70, 1800);
    /** Sharper: a strong NetBird link (good 4G/5G) or the same Wi-Fi. */
    static final Quality HD = new Quality("720p", "720p (strong link / Wi-Fi)", 1280, 720, 30, 78, 2800);
    /** Sharpest; only a fast local Wi-Fi (5 GHz) carries this, not 4G. */
    static final Quality FHD = new Quality("1080p", "1080p (LAN Wi-Fi only)", 1920, 1080, 30, 85, 5000);

    /** Smallest first (the step-down when a link can't carry the chosen one). */
    static final Quality[] ALL = {SD, NB, HD, FHD};

    private static final String PREFS = "varuna_cam";
    private static final String KEY = "quality";

    static Quality get(Context c) {
        String id = prefs(c).getString(KEY, NB.id);
        for (Quality q : ALL) {
            if (q.id.equals(id)) return q;
        }
        return NB;
    }

    static void set(Context c, Quality q) {
        prefs(c).edit().putString(KEY, q.id).apply();
    }

    private static SharedPreferences prefs(Context c) {
        return c.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }
}
