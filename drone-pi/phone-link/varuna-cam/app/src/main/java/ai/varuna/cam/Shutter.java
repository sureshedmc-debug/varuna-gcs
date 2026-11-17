package ai.varuna.cam;

import android.content.Context;
import android.hardware.camera2.CameraCharacteristics;
import android.hardware.camera2.CameraMetadata;
import android.hardware.camera2.CaptureRequest;
import android.util.Range;

import java.util.Locale;

/**
 * Fast shutter for flight. On a vibrating drone the camera's own auto exposure
 * picks long exposures (up to a whole frame, 33 ms), and every picture is
 * smeared by the shaking: the plastic detector then sees blobs. Here the
 * exposure is kept short (1/500 s) and the brightness made up with ISO
 * (sensor gain): a little grainier, but sharp.
 *
 * How, depending on what the phone's camera allows:
 *  - manual: exposure and ISO set by VARUNA Cam itself, with its own auto
 *    exposure from the brightness of the pictures ({@link #meter});
 *  - scene: the camera's "sports" / "action" scene, which favours short exposures;
 *  - none: the phone allows neither; the camera's own exposure is used.
 * The choice is kept across restarts; on by default (this is a drone camera).
 */
final class Shutter {
    /** 1/500 s: sharp through a drone's vibration. */
    static final long FAST_NS = 2_000_000L;
    /** Longest exposure allowed, only once even the highest ISO is too dark (dusk). */
    static final long DARK_MAX_NS = 8_000_000L;
    /** Mid-grey picture (0-255 brightness) the exposure aims for. */
    private static final float TARGET = 115f;

    private static final String PREFS = "varuna_cam";
    private static final String KEY = "fast_shutter";

    static boolean enabled(Context c) {
        return c.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getBoolean(KEY, true);
    }

    static void set(Context c, boolean on) {
        c.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().putBoolean(KEY, on).apply();
    }

    final boolean on;
    /** "manual", "scene" or "none". */
    final String mode;
    private final int scene;
    private final long expMin, expMax, frameNs;
    private final int isoMin, isoMax;
    private volatile long exp;
    private volatile int iso;
    private volatile float luma = -1;

    Shutter(CameraCharacteristics cc, int fps, boolean on) {
        this.on = on;
        frameNs = 1_000_000_000L / Math.max(1, fps);
        int[] caps = cc.get(CameraCharacteristics.REQUEST_AVAILABLE_CAPABILITIES);
        Range<Long> er = cc.get(CameraCharacteristics.SENSOR_INFO_EXPOSURE_TIME_RANGE);
        Range<Integer> ir = cc.get(CameraCharacteristics.SENSOR_INFO_SENSITIVITY_RANGE);
        boolean manual = has(caps, CameraMetadata.REQUEST_AVAILABLE_CAPABILITIES_MANUAL_SENSOR) && er != null && ir != null;
        int[] scenes = cc.get(CameraCharacteristics.CONTROL_AVAILABLE_SCENE_MODES);
        int sc = has(scenes, CameraMetadata.CONTROL_SCENE_MODE_SPORTS) ? CameraMetadata.CONTROL_SCENE_MODE_SPORTS
                : has(scenes, CameraMetadata.CONTROL_SCENE_MODE_ACTION) ? CameraMetadata.CONTROL_SCENE_MODE_ACTION : -1;
        mode = manual ? "manual" : sc >= 0 ? "scene" : "none";
        scene = sc;
        expMin = er != null ? er.getLower() : FAST_NS;
        expMax = er != null ? Math.min(er.getUpper(), frameNs) : frameNs;
        isoMin = ir != null ? ir.getLower() : 100;
        isoMax = ir != null ? ir.getUpper() : 800;
        exp = clamp(FAST_NS, expMin, expMax);
        iso = (int) clamp(400, isoMin, isoMax);
    }

    /** VARUNA Cam sets the exposure itself, from the pictures' brightness. */
    boolean metering() {
        return on && "manual".equals(mode);
    }

    /** Puts this shutter into the camera's repeating request. */
    void apply(CaptureRequest.Builder b) {
        if (!on) return;
        if ("manual".equals(mode)) {
            b.set(CaptureRequest.CONTROL_AE_MODE, CaptureRequest.CONTROL_AE_MODE_OFF);
            b.set(CaptureRequest.SENSOR_EXPOSURE_TIME, exp);
            b.set(CaptureRequest.SENSOR_SENSITIVITY, iso);
            b.set(CaptureRequest.SENSOR_FRAME_DURATION, frameNs);
        } else if ("scene".equals(mode)) {
            b.set(CaptureRequest.CONTROL_MODE, CaptureRequest.CONTROL_MODE_USE_SCENE_MODE);
            b.set(CaptureRequest.CONTROL_SCENE_MODE, scene);
        }
    }

    /**
     * Auto exposure with a short shutter: the picture's mean brightness in,
     * a new exposure and ISO out. Light is exposure x ISO; the exposure stays
     * at 1/500 s and ISO moves, until ISO is at its highest — only then may
     * the exposure grow, up to 1/125 s. Returns whether they changed enough
     * to send the camera a new request.
     */
    boolean meter(float mean) {
        if (!metering()) return false;
        luma = mean;
        float r = TARGET / Math.max(mean, 3f);
        if (Math.abs(r - 1f) < 0.08f) return false;     // close enough: no flicker from small corrections
        r = (float) Math.pow(Math.min(2.5f, Math.max(0.4f, r)), 0.75);   // damped: no overshoot
        double light = (double) exp * iso * r;
        long cap = clamp(FAST_NS, expMin, expMax);
        long ne = clamp((long) (light / isoMin), expMin, cap);
        long ni = Math.round(light / ne);
        if (ni > isoMax) {
            ni = isoMax;
            long darkCap = clamp(DARK_MAX_NS, expMin, expMax);
            ne = clamp((long) (light / isoMax), cap, darkCap);
        }
        ni = clamp(ni, isoMin, isoMax);
        boolean changed = Math.abs(ne - exp) > exp * 0.03 || Math.abs(ni - iso) > iso * 0.03;
        exp = ne;
        iso = (int) ni;
        return changed;
    }

    String describe() {
        if (!on) return "shutter auto (the camera's own; may blur when the drone shakes)";
        if ("manual".equals(mode)) {
            return String.format(Locale.US, "fast shutter 1/%d s, ISO %d%s", Math.round(1e9 / exp), iso,
                    luma >= 0 ? String.format(Locale.US, ", brightness %.0f", luma) : "");
        }
        if ("scene".equals(mode)) return "fast shutter (the camera's sports scene)";
        return "fast shutter: not possible on this phone's camera (auto exposure)";
    }

    private static boolean has(int[] a, int v) {
        if (a == null) return false;
        for (int x : a) if (x == v) return true;
        return false;
    }

    private static long clamp(long v, long lo, long hi) {
        return Math.max(lo, Math.min(hi, v));
    }
}
