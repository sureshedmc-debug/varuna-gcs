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

    /** Light: for a weak or crowded Wi-Fi. */
    static final Quality SD = new Quality("480p", "480p light", 640, 480, 30, 75, 1500);
    /**
     * The default: 720p at 30 fps in about 2-3 Mbit/s, which ordinary 2.4 GHz
     * Wi-Fi carries with room to spare. Sharp enough for the app's long-range
     * scan, and the detector gets the whole width.
     */
    static final Quality HD = new Quality("720p", "720p 30fps (best)", 1280, 720, 30, 80, 3000);
    /** Sharpest; needs strong Wi-Fi (5 GHz). */
    static final Quality FHD = new Quality("1080p", "1080p sharp (strong Wi-Fi)", 1920, 1080, 30, 85, 6000);

    /** Smallest first. */
    static final Quality[] ALL = {SD, HD, FHD};

    private static final String PREFS = "varuna_cam";
    private static final String KEY = "quality";

    static Quality get(Context c) {
        String id = prefs(c).getString(KEY, HD.id);
        for (Quality q : ALL) {
            if (q.id.equals(id)) return q;
        }
        return HD;
    }

    static void set(Context c, Quality q) {
        prefs(c).edit().putString(KEY, q.id).apply();
    }

    private static SharedPreferences prefs(Context c) {
        return c.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }
}
