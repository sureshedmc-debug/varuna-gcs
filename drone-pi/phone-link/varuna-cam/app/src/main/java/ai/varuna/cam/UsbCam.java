package ai.varuna.cam;

import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.hardware.usb.UsbConstants;
import android.hardware.usb.UsbDevice;
import android.hardware.usb.UsbDeviceConnection;
import android.hardware.usb.UsbInterface;
import android.hardware.usb.UsbManager;
import android.os.Build;
import android.util.Log;

import java.util.ArrayList;
import java.util.List;
import java.util.Locale;

/**
 * A USB webcam plugged into the phone (through an OTG adapter), as the video
 * source instead of the phone's own camera. Works on any Android 8+ phone with
 * USB host (OTG): the app talks UVC to the webcam itself, so the phone needs no
 * webcam support of its own.
 *
 * The webcam sends MJPEG (every webcam does): each picture arrives as a JPEG,
 * through {@link Listener#onFrame}. The video setup (probe / commit) and the
 * choice of size and frame rate happen here; the isochronous transfers, which
 * Java can't do, are in uvc_stream.c.
 */
final class UsbCam {
    private static final String TAG = "VarunaCam";
    static final String ACTION_PERMISSION = "ai.varuna.cam.USB_PERMISSION";

    private static final String PREFS = "varuna_cam";
    private static final String KEY = "usb_webcam";

    private static final int CC_VIDEO = 0x0E;
    private static final int SC_CONTROL = 0x01;
    private static final int SC_STREAMING = 0x02;

    private static boolean nativeOk;

    static {
        try {
            System.loadLibrary("uvcstream");
            nativeOk = true;
        } catch (Throwable t) {
            Log.w(TAG, "USB webcam support missing: " + t);
        }
    }

    interface Listener {
        /** A whole JPEG picture from the webcam; on the webcam's own thread. Keep it quick. */
        void onFrame(byte[] jpeg, int length);

        /** The stream ended without stop(): the webcam was unplugged or failed. */
        void onLost(String why);
    }

    /** One picture size the webcam offers as MJPEG. */
    static final class Frame {
        final int index;
        final int width;
        final int height;
        final long defaultInterval;     // 100 ns units
        final long[] intervals;         // discrete choices, or {min, max, step} when continuous
        final boolean continuous;

        Frame(int index, int width, int height, long defaultInterval, long[] intervals, boolean continuous) {
            this.index = index;
            this.width = width;
            this.height = height;
            this.defaultInterval = defaultInterval;
            this.intervals = intervals;
            this.continuous = continuous;
        }

        /** The frame interval (100 ns units) closest to fps. */
        long intervalFor(int fps) {
            long want = 10_000_000L / Math.max(1, fps);
            if (continuous && intervals.length >= 2) {
                long min = intervals[0], max = intervals[1], step = intervals.length > 2 ? Math.max(1, intervals[2]) : 1;
                long v = Math.max(min, Math.min(max, want));
                return min + (v - min) / step * step;
            }
            long best = defaultInterval;
            double bestErr = Double.MAX_VALUE;
            for (long iv : intervals) {
                if (iv <= 0) continue;
                double err = Math.abs(1e7 / iv - fps);
                if (1e7 / iv < fps) err += 0.5;     // a little faster beats a little slower
                if (err < bestErr) {
                    bestErr = err;
                    best = iv;
                }
            }
            return best > 0 ? best : want;
        }
    }

    /** What the webcam's descriptors say. */
    private static final class Layout {
        int bcdUvc = 0x0100;
        int controlIf = -1;
        int cameraTerminal = -1;
        int streamIf = -1;
        int mjpegFormat = -1;
        final List<Frame> frames = new ArrayList<>();
        // The streaming interface's alternate settings: endpoint, packet size, iso or bulk.
        final List<int[]> alts = new ArrayList<>();   // {alt, endpoint, packetSize, iso ? 1 : 0, interface}
    }

    private final UsbManager usb;
    private final UsbDevice device;
    private UsbDeviceConnection conn;
    private Layout layout;
    private Thread thread;
    private volatile boolean stopping;
    private Listener listener;

    int width;
    int height;
    float fps;
    String name = "";

    private UsbCam(UsbManager usb, UsbDevice device) {
        this.usb = usb;
        this.device = device;
    }

    // ---- settings ---------------------------------------------------------

    /** Use a plugged-in USB webcam instead of the phone's camera (on unless turned off). */
    static boolean enabled(Context c) {
        return prefs(c).getBoolean(KEY, true);
    }

    static void set(Context c, boolean on) {
        prefs(c).edit().putBoolean(KEY, on).apply();
    }

    private static SharedPreferences prefs(Context c) {
        return c.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }

    static boolean supported() {
        return nativeOk;
    }

    // ---- finding it ---------------------------------------------------------

    /** The first USB video device plugged in, or null. */
    static UsbDevice find(Context c) {
        UsbManager um = (UsbManager) c.getSystemService(Context.USB_SERVICE);
        if (um == null) return null;
        for (UsbDevice d : um.getDeviceList().values()) {
            if (isWebcam(d)) return d;
        }
        return null;
    }

    static boolean isWebcam(UsbDevice d) {
        if (d == null) return false;
        for (int i = 0; i < d.getInterfaceCount(); i++) {
            UsbInterface f = d.getInterface(i);
            if (f.getInterfaceClass() == CC_VIDEO && f.getInterfaceSubclass() == SC_STREAMING) return true;
        }
        return false;
    }

    static String label(UsbDevice d) {
        String p = null;
        try {
            p = d.getProductName();
        } catch (SecurityException ignored) {
        }
        if (p == null || p.trim().isEmpty()) {
            p = String.format(Locale.US, "USB webcam %04x:%04x", d.getVendorId(), d.getProductId());
        }
        return p.trim();
    }

    static boolean hasPermission(Context c, UsbDevice d) {
        UsbManager um = (UsbManager) c.getSystemService(Context.USB_SERVICE);
        return um != null && um.hasPermission(d);
    }

    /** Shows Android's "Allow VARUNA Cam to access the webcam?" question; the answer comes as ACTION_PERMISSION. */
    static void askPermission(Context c, UsbDevice d) {
        UsbManager um = (UsbManager) c.getSystemService(Context.USB_SERVICE);
        if (um == null) return;
        Intent i = new Intent(ACTION_PERMISSION).setPackage(c.getPackageName());
        int flags = Build.VERSION.SDK_INT >= 31 ? PendingIntent.FLAG_MUTABLE : 0;
        um.requestPermission(d, PendingIntent.getBroadcast(c, 0, i, flags));
    }

    // ---- opening it ---------------------------------------------------------

    /**
     * Opens the webcam and starts its MJPEG stream at the size closest to
     * width x height and the rate closest to fps. Throws with a reason the
     * status line can show.
     */
    static UsbCam open(Context c, UsbDevice d, int wantW, int wantH, int wantFps, Listener l) throws Exception {
        if (!nativeOk) throw new Exception("USB webcam support didn't load on this phone");
        UsbManager um = (UsbManager) c.getSystemService(Context.USB_SERVICE);
        UsbCam cam = new UsbCam(um, d);
        cam.name = label(d);
        try {
            cam.start(wantW, wantH, wantFps, l);
            return cam;
        } catch (Exception e) {
            cam.stop();
            throw e;
        }
    }

    private void start(int wantW, int wantH, int wantFps, Listener l) throws Exception {
        listener = l;
        conn = usb.openDevice(device);
        if (conn == null) throw new Exception("Android didn't open the webcam (permission?)");
        byte[] raw = conn.getRawDescriptors();
        if (raw == null) throw new Exception("the webcam gave no descriptors");
        layout = parse(raw);
        if (layout.streamIf < 0) throw new Exception("no video stream on this USB device");
        if (layout.mjpegFormat < 0 || layout.frames.isEmpty()) {
            throw new Exception("this webcam has no MJPEG video (only raw); not supported");
        }
        UsbInterface vs0 = iface(layout.streamIf, 0);
        if (vs0 == null || !conn.claimInterface(vs0, true)) throw new Exception("can't claim the webcam's video stream");
        UsbInterface vc = layout.controlIf >= 0 ? iface(layout.controlIf, 0) : null;
        if (vc != null) conn.claimInterface(vc, true);
        conn.setInterface(vs0);     // alternate setting 0: not streaming yet

        Frame f = pick(layout.frames, wantW, wantH);
        long interval = f.intervalFor(wantFps);
        byte[] probe = negotiate(f, interval);
        long maxFrame = u32(probe, 18);
        long maxPayload = u32(probe, 22);
        long gotInterval = u32(probe, 4);
        if (gotInterval <= 0) gotInterval = interval;
        width = f.width;
        height = f.height;
        fps = (float) (1e7 / gotInterval);

        // Constant frame rate in dim light: don't let auto exposure slow the camera down.
        keepFrameRate();

        int[] alt = chooseAlt(maxPayload);
        if (alt == null) throw new Exception("the webcam offers no video endpoint");
        if (alt[3] == 1) {
            UsbInterface a = iface(layout.streamIf, alt[0]);
            if (a == null || !conn.setInterface(a)) throw new Exception("the webcam refused bandwidth setting " + alt[0]);
        }
        final int fd = conn.getFileDescriptor();
        final int ep = alt[1];
        final int pkt = alt[3] == 1 ? alt[2] : (int) Math.max(16 * 1024, Math.min(maxPayload > 0 ? maxPayload : 512 * 1024, 2 * 1024 * 1024));
        final boolean iso = alt[3] == 1;
        final int frameHint = (int) Math.min(maxFrame > 0 ? maxFrame : 1 << 20, 8 << 20);
        Log.i(TAG, String.format(Locale.US, "USB webcam %s: %dx%d @ %.1f fps, %s endpoint 0x%02x, %d bytes",
                name, width, height, fps, iso ? "iso" : "bulk", ep, pkt));
        thread = new Thread(new Runnable() {
            @Override
            public void run() {
                int r = nativeStream(fd, ep, pkt, iso, frameHint);
                if (!stopping) {
                    Listener li = listener;
                    if (li != null) li.onLost(r == -19 ? "the USB webcam was unplugged" : "the USB webcam stopped (" + r + ")");
                }
            }
        }, "usbcam");
        thread.setPriority(Thread.MAX_PRIORITY);
        thread.start();
    }

    /** Stops the stream and lets the webcam go; safe to call twice. */
    void stop() {
        stopping = true;
        if (thread != null) {
            nativeStop();
            try {
                thread.join(1500);
            } catch (InterruptedException ignored) {
            }
            thread = null;
        }
        if (conn != null) {
            try {
                if (layout != null && layout.streamIf >= 0) {
                    UsbInterface vs0 = iface(layout.streamIf, 0);
                    if (vs0 != null) {
                        conn.setInterface(vs0);
                        conn.releaseInterface(vs0);
                    }
                    UsbInterface vc = layout.controlIf >= 0 ? iface(layout.controlIf, 0) : null;
                    if (vc != null) conn.releaseInterface(vc);
                }
            } catch (Exception ignored) {
            }
            conn.close();
            conn = null;
        }
        listener = null;
    }

    boolean isDevice(UsbDevice d) {
        return d != null && d.getDeviceName().equals(device.getDeviceName());
    }

    String describe() {
        return String.format(Locale.US, "USB webcam: %s, MJPEG %dx%d at %.0f fps", name, width, height, fps);
    }

    // ---- UVC ----------------------------------------------------------------

    /** Probe and commit the format: MJPEG, this frame size, this interval. Returns the agreed probe block. */
    private byte[] negotiate(Frame f, long interval) throws Exception {
        int[] lengths = layout.bcdUvc >= 0x0150 ? new int[]{48, 34, 26}
                : layout.bcdUvc >= 0x0110 ? new int[]{34, 26, 48} : new int[]{26, 34, 48};
        for (int len : lengths) {
            byte[] p = new byte[len];
            // Start from what the camera has now, then ask for ours.
            conn.controlTransfer(0xA1, 0x81, 0x0100, layout.streamIf, p, len, 1000);
            p[0] = 1;                       // bmHint: keep the frame interval
            p[1] = 0;
            p[2] = (byte) layout.mjpegFormat;
            p[3] = (byte) f.index;
            put32(p, 4, interval);
            if (conn.controlTransfer(0x21, 0x01, 0x0100, layout.streamIf, p, len, 1000) < 0) continue;
            byte[] got = new byte[len];
            if (conn.controlTransfer(0xA1, 0x81, 0x0100, layout.streamIf, got, len, 1000) < 26) continue;
            if (conn.controlTransfer(0x21, 0x01, 0x0200, layout.streamIf, got, len, 1000) < 0) continue;
            return got;
        }
        throw new Exception("the webcam refused the video format");
    }

    /** Auto-exposure priority off (frame rate stays constant), if the webcam has the control. */
    private void keepFrameRate() {
        if (layout.controlIf < 0 || layout.cameraTerminal < 0) return;
        byte[] v = {0};
        conn.controlTransfer(0x21, 0x01, 0x03 << 8, (layout.cameraTerminal << 8) | layout.controlIf, v, 1, 500);
    }

    /**
     * The isochronous setting with the smallest packets that still carry the
     * camera's payload size (less USB bandwidth used), else the biggest; or the
     * bulk endpoint if the webcam streams over bulk.
     */
    private int[] chooseAlt(long maxPayload) {
        int[] best = null;
        int[] biggest = null;
        int[] bulk = null;
        for (int[] a : layout.alts) {
            if (a[3] == 0) {
                if (bulk == null) bulk = a;
                continue;
            }
            if (biggest == null || a[2] > biggest[2]) biggest = a;
            if (maxPayload > 0 && a[2] >= maxPayload && (best == null || a[2] < best[2])) best = a;
        }
        if (best != null) return best;
        if (biggest != null) return biggest;
        return bulk;
    }

    private UsbInterface iface(int number, int alt) {
        for (int i = 0; i < device.getInterfaceCount(); i++) {
            UsbInterface f = device.getInterface(i);
            if (f.getId() == number && f.getAlternateSetting() == alt) return f;
        }
        return null;
    }

    /** The webcam size closest to the wanted one; the same shape and a little smaller preferred. */
    static Frame pick(List<Frame> frames, int w, int h) {
        long want = (long) w * h;
        Frame best = null;
        long bestScore = Long.MAX_VALUE;
        for (Frame f : frames) {
            if (f.width == w && f.height == h) return f;
            long area = (long) f.width * f.height;
            long score = Math.abs(area - want);
            if ((long) f.width * h != (long) f.height * w) score += want / 2;    // other shape
            if (area > want) score += want / 4;
            if (score < bestScore) {
                bestScore = score;
                best = f;
            }
        }
        return best;
    }

    /** Reads the configuration descriptors: the video control and streaming interfaces, MJPEG sizes, endpoints. */
    private static Layout parse(byte[] raw) {
        Layout L = new Layout();
        int curIf = -1, curAlt = 0, curClass = -1, curSub = -1;
        boolean inMjpeg = false;
        int i = 0;
        while (i + 2 <= raw.length) {
            int len = raw[i] & 0xff;
            int type = raw[i + 1] & 0xff;
            if (len < 2 || i + len > raw.length) break;
            if (type == 0x04 && len >= 9) {                    // interface
                curIf = raw[i + 2] & 0xff;
                curAlt = raw[i + 3] & 0xff;
                curClass = raw[i + 5] & 0xff;
                curSub = raw[i + 6] & 0xff;
                if (curClass == CC_VIDEO && curSub == SC_CONTROL && L.controlIf < 0) L.controlIf = curIf;
                if (curClass == CC_VIDEO && curSub == SC_STREAMING && curAlt == 0) inMjpeg = false;
            } else if (type == 0x24 && len >= 3 && curClass == CC_VIDEO) {   // class-specific interface
                int sub = raw[i + 2] & 0xff;
                if (curSub == SC_CONTROL) {
                    if (sub == 0x01 && len >= 5) L.bcdUvc = u16(raw, i + 3);
                    if (sub == 0x02 && len >= 8 && u16(raw, i + 4) == 0x0201 && L.cameraTerminal < 0) {
                        L.cameraTerminal = raw[i + 3] & 0xff;
                    }
                } else if (curSub == SC_STREAMING && (L.streamIf < 0 || L.streamIf == curIf)) {
                    if (sub == 0x06 && len >= 4) {              // MJPEG format
                        if (L.mjpegFormat < 0) {
                            L.mjpegFormat = raw[i + 3] & 0xff;
                            L.streamIf = curIf;
                            inMjpeg = true;
                        } else {
                            inMjpeg = false;
                        }
                    } else if (sub == 0x07 && inMjpeg && len >= 26) {   // MJPEG frame
                        int idx = raw[i + 3] & 0xff;
                        int w = u16(raw, i + 5);
                        int h = u16(raw, i + 7);
                        long def = u32(raw, i + 21);
                        int n = raw[i + 25] & 0xff;
                        long[] ivs;
                        boolean cont = n == 0;
                        int count = cont ? 3 : n;
                        ivs = new long[count];
                        for (int k = 0; k < count && i + 26 + 4 * k + 4 <= i + len; k++) ivs[k] = u32(raw, i + 26 + 4 * k);
                        L.frames.add(new Frame(idx, w, h, def, ivs, cont));
                    } else if (sub == 0x04 || sub == 0x10 || sub == 0x0C) {
                        inMjpeg = false;                        // another format's frames follow
                    }
                }
            } else if (type == 0x05 && len >= 7 && curClass == CC_VIDEO && curSub == SC_STREAMING) {   // endpoint
                int addr = raw[i + 2] & 0xff;
                int attr = raw[i + 3] & 0x03;
                int mps = u16(raw, i + 4);
                int size = (mps & 0x7ff) * (1 + ((mps >> 11) & 3));
                if ((addr & UsbConstants.USB_DIR_IN) != 0 && (attr == 1 || attr == 2)) {
                    L.alts.add(new int[]{curAlt, addr, size, attr == 1 ? 1 : 0, curIf});
                }
            }
            i += len;
        }
        // Only the endpoints of the streaming interface that has the MJPEG video.
        for (int k = L.alts.size() - 1; k >= 0; k--) {
            if (L.alts.get(k)[4] != L.streamIf) L.alts.remove(k);
        }
        return L;
    }

    private static int u16(byte[] b, int at) {
        return (b[at] & 0xff) | (b[at + 1] & 0xff) << 8;
    }

    private static long u32(byte[] b, int at) {
        if (at + 4 > b.length) return 0;
        return (b[at] & 0xffL) | (b[at + 1] & 0xffL) << 8 | (b[at + 2] & 0xffL) << 16 | (b[at + 3] & 0xffL) << 24;
    }

    private static void put32(byte[] b, int at, long v) {
        b[at] = (byte) v;
        b[at + 1] = (byte) (v >> 8);
        b[at + 2] = (byte) (v >> 16);
        b[at + 3] = (byte) (v >> 24);
    }

    private native int nativeStream(int fd, int endpoint, int packetSize, boolean iso, int frameSizeHint);

    private static native void nativeStop();

    /** Called from uvc_stream.c with each whole picture. */
    @SuppressWarnings("unused")
    private void onFrame(byte[] jpeg, int length) {
        Listener l = listener;
        if (l != null) l.onFrame(jpeg, length);
    }
}
