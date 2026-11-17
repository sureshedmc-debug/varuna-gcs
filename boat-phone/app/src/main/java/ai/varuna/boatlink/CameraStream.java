package ai.varuna.boatlink;

import android.annotation.SuppressLint;
import android.content.Context;
import android.graphics.ImageFormat;
import android.graphics.Rect;
import android.graphics.YuvImage;
import android.hardware.camera2.CameraAccessException;
import android.hardware.camera2.CameraCaptureSession;
import android.hardware.camera2.CameraCharacteristics;
import android.hardware.camera2.CameraDevice;
import android.hardware.camera2.CameraManager;
import android.hardware.camera2.CaptureRequest;
import android.hardware.camera2.params.StreamConfigurationMap;
import android.media.Image;
import android.media.ImageReader;
import android.os.Handler;
import android.os.HandlerThread;
import android.os.SystemClock;
import android.util.Range;
import android.util.Size;

import java.io.ByteArrayOutputStream;
import java.nio.ByteBuffer;
import java.util.Collections;

/**
 * The phone's back camera as JPEG frames (for the MJPEG server). Opens by itself,
 * and opens again if the camera is lost (another app took it, an error).
 */
final class CameraStream {
    // 60 fps, locked, for a smooth live stream. 640x480 keeps the phone's
    // software JPEG encoder inside the 16 ms-per-frame budget even on a budget
    // phone, so it can really hold 60 (fps() reports what it actually reaches).
    static final int WANT_W = 640, WANT_H = 480, FPS = 60, QUALITY = 70;

    private final Context ctx;
    private HandlerThread thread;
    private Handler handler;
    private CameraDevice camera;
    private CameraCaptureSession session;
    private ImageReader reader;
    private volatile boolean running;
    private final Object frameLock = new Object();
    private byte[] frame;
    private long frameSeq;
    private long lastEncode;
    private volatile String state = "starting";
    private volatile int width, height;
    private final long[] times = new long[30];
    private int timesN;

    CameraStream(Context ctx) {
        this.ctx = ctx.getApplicationContext();
    }

    void start() {
        running = true;
        thread = new HandlerThread("camera");
        thread.start();
        handler = new Handler(thread.getLooper());
        handler.post(this::open);
    }

    void stop() {
        running = false;
        if (handler != null) handler.post(this::closeAll);
        if (thread != null) thread.quitSafely();
    }

    String state() {
        return state;
    }

    String size() {
        return width > 0 ? width + "x" + height : "-";
    }

    /** Frames a second over the last few seconds. */
    double fps() {
        synchronized (times) {
            if (timesN < 2) return 0;
            int n = Math.min(timesN, times.length);
            long newest = times[(timesN - 1) % times.length];
            long oldest = times[(timesN - n) % times.length];
            if (SystemClock.elapsedRealtime() - newest > 2000 || newest == oldest) return 0;
            return (n - 1) * 1000.0 / (newest - oldest);
        }
    }

    /** The newest frame after `afterSeq` (waits up to `waitMs`), or null. out[0] = its seq. */
    byte[] next(long afterSeq, long waitMs, long[] seqOut) throws InterruptedException {
        long end = SystemClock.elapsedRealtime() + waitMs;
        synchronized (frameLock) {
            while (frameSeq <= afterSeq || frame == null) {
                long left = end - SystemClock.elapsedRealtime();
                if (left <= 0) return null;
                frameLock.wait(left);
            }
            seqOut[0] = frameSeq;
            return frame;
        }
    }

    private void retryLater() {
        closeAll();
        if (running) handler.postDelayed(this::open, 3000);
    }

    @SuppressLint("MissingPermission")
    private void open() {
        if (!running) return;
        try {
            CameraManager cm = (CameraManager) ctx.getSystemService(Context.CAMERA_SERVICE);
            String id = null;
            for (String c : cm.getCameraIdList()) {
                Integer facing = cm.getCameraCharacteristics(c).get(CameraCharacteristics.LENS_FACING);
                if (facing != null && facing == CameraCharacteristics.LENS_FACING_BACK) {
                    id = c;
                    break;
                }
            }
            if (id == null && cm.getCameraIdList().length > 0) id = cm.getCameraIdList()[0];
            if (id == null) {
                state = "no camera";
                return;
            }
            CameraCharacteristics ch = cm.getCameraCharacteristics(id);
            StreamConfigurationMap map = ch.get(CameraCharacteristics.SCALER_STREAM_CONFIGURATION_MAP);
            Size best = pickSize(map.getOutputSizes(ImageFormat.YUV_420_888));
            width = best.getWidth();
            height = best.getHeight();
            Range<Integer> fpsRange = pickFps(ch.get(CameraCharacteristics.CONTROL_AE_AVAILABLE_TARGET_FPS_RANGES));
            reader = ImageReader.newInstance(width, height, ImageFormat.YUV_420_888, 3);
            reader.setOnImageAvailableListener(this::onImage, handler);
            state = "opening";
            cm.openCamera(id, new CameraDevice.StateCallback() {
                @Override
                public void onOpened(CameraDevice cam) {
                    camera = cam;
                    startSession(fpsRange);
                }

                @Override
                public void onDisconnected(CameraDevice cam) {
                    state = "camera taken by another app - retrying";
                    retryLater();
                }

                @Override
                public void onError(CameraDevice cam, int error) {
                    state = "camera error " + error + " - retrying";
                    retryLater();
                }
            }, handler);
        } catch (SecurityException e) {
            state = "no camera permission";
        } catch (Exception e) {
            state = "camera: " + e.getMessage() + " - retrying";
            retryLater();
        }
    }

    @SuppressWarnings("deprecation")
    private void startSession(Range<Integer> fpsRange) {
        try {
            camera.createCaptureSession(Collections.singletonList(reader.getSurface()),
                    new CameraCaptureSession.StateCallback() {
                        @Override
                        public void onConfigured(CameraCaptureSession s) {
                            session = s;
                            try {
                                CaptureRequest.Builder b = camera.createCaptureRequest(CameraDevice.TEMPLATE_RECORD);
                                b.addTarget(reader.getSurface());
                                b.set(CaptureRequest.CONTROL_MODE, CaptureRequest.CONTROL_MODE_AUTO);
                                b.set(CaptureRequest.CONTROL_AF_MODE, CaptureRequest.CONTROL_AF_MODE_CONTINUOUS_VIDEO);
                                if (fpsRange != null) b.set(CaptureRequest.CONTROL_AE_TARGET_FPS_RANGE, fpsRange);
                                s.setRepeatingRequest(b.build(), null, handler);
                                state = "streaming";
                            } catch (Exception e) {
                                state = "camera: " + e.getMessage() + " - retrying";
                                retryLater();
                            }
                        }

                        @Override
                        public void onConfigureFailed(CameraCaptureSession s) {
                            state = "camera setup failed - retrying";
                            retryLater();
                        }
                    }, handler);
        } catch (CameraAccessException | IllegalStateException e) {
            state = "camera: " + e.getMessage() + " - retrying";
            retryLater();
        }
    }

    private void onImage(ImageReader r) {
        Image img = null;
        try {
            img = r.acquireLatestImage();
            if (img == null) return;
            long now = SystemClock.elapsedRealtime();
            if (now - lastEncode < 1000 / FPS - 5) return;          // keep to FPS
            lastEncode = now;
            byte[] nv21 = toNv21(img);
            ByteArrayOutputStream jpg = new ByteArrayOutputStream(64 * 1024);
            new YuvImage(nv21, ImageFormat.NV21, img.getWidth(), img.getHeight(), null)
                    .compressToJpeg(new Rect(0, 0, img.getWidth(), img.getHeight()), QUALITY, jpg);
            synchronized (frameLock) {
                frame = jpg.toByteArray();
                frameSeq++;
                frameLock.notifyAll();
            }
            synchronized (times) {
                times[timesN % times.length] = now;
                timesN++;
            }
        } catch (Exception e) {
            state = "camera frame error: " + e.getMessage();
        } finally {
            if (img != null) img.close();
        }
    }

    private static byte[] toNv21(Image img) {
        int w = img.getWidth(), h = img.getHeight();
        byte[] out = new byte[w * h * 3 / 2];
        Image.Plane[] p = img.getPlanes();
        ByteBuffer y = p[0].getBuffer(), u = p[1].getBuffer(), v = p[2].getBuffer();
        int yRow = p[0].getRowStride(), yPix = p[0].getPixelStride();
        int pos = 0;
        if (yPix == 1) {
            for (int row = 0; row < h; row++) {
                y.position(row * yRow);
                y.get(out, pos, w);
                pos += w;
            }
        } else {
            for (int row = 0; row < h; row++)
                for (int col = 0; col < w; col++) out[pos++] = y.get(row * yRow + col * yPix);
        }
        int uvRow = p[1].getRowStride(), uvPix = p[1].getPixelStride();
        int vRow = p[2].getRowStride(), vPix = p[2].getPixelStride();
        for (int row = 0; row < h / 2; row++) {
            for (int col = 0; col < w / 2; col++) {
                out[pos++] = v.get(row * vRow + col * vPix);
                out[pos++] = u.get(row * uvRow + col * uvPix);
            }
        }
        return out;
    }

    private static Size pickSize(Size[] sizes) {
        Size best = null;
        long bestScore = Long.MAX_VALUE;
        for (Size s : sizes) {
            // Closest to 640x480 by area, preferring 4:3, never bigger than 1280x720.
            if (s.getWidth() > 1280 || s.getHeight() > 960) continue;
            long score = Math.abs((long) s.getWidth() * s.getHeight() - (long) WANT_W * WANT_H)
                    + (s.getWidth() * 3 == s.getHeight() * 4 ? 0 : 50000);
            if (score < bestScore) {
                bestScore = score;
                best = s;
            }
        }
        return best != null ? best : sizes[sizes.length - 1];
    }

    private static Range<Integer> pickFps(Range<Integer>[] ranges) {
        if (ranges == null) return null;
        // A range that reaches FPS (60), the most "locked" one first: a fixed
        // [60,60] holds 60, where a wide [15,60] lets auto-exposure drop to the
        // floor in dim light. Prefer the highest lower bound, then the tightest.
        Range<Integer> best = null;
        for (Range<Integer> r : ranges) {
            if (r.getUpper() < FPS) continue;
            if (best == null
                    || r.getLower() > best.getLower()
                    || (r.getLower().equals(best.getLower()) && r.getUpper() < best.getUpper()))
                best = r;
        }
        if (best != null) return best;
        // The phone offers nothing that reaches 60 at this size: take the
        // fastest range it does have, so it runs as smooth as it can.
        for (Range<Integer> r : ranges)
            if (best == null || r.getUpper() > best.getUpper()) best = r;
        return best;
    }

    private void closeAll() {
        try {
            if (session != null) session.close();
        } catch (Exception ignored) {
        }
        session = null;
        try {
            if (camera != null) camera.close();
        } catch (Exception ignored) {
        }
        camera = null;
        try {
            if (reader != null) reader.close();
        } catch (Exception ignored) {
        }
        reader = null;
    }
}
