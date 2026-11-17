package ai.varuna.cam;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.graphics.Color;
import android.graphics.ImageFormat;
import android.graphics.PixelFormat;
import android.graphics.Rect;
import android.graphics.Typeface;
import android.graphics.YuvImage;
import android.graphics.drawable.GradientDrawable;
import android.hardware.camera2.CameraAccessException;
import android.hardware.camera2.CameraCaptureSession;
import android.hardware.camera2.CameraCharacteristics;
import android.hardware.camera2.CameraDevice;
import android.hardware.camera2.CameraManager;
import android.hardware.camera2.CaptureRequest;
import android.hardware.camera2.CaptureResult;
import android.hardware.camera2.TotalCaptureResult;
import android.hardware.camera2.params.OutputConfiguration;
import android.hardware.camera2.params.SessionConfiguration;
import android.hardware.camera2.params.StreamConfigurationMap;
import android.media.Image;
import android.media.ImageReader;
import android.media.MediaCodec;
import android.net.wifi.WifiManager;
import android.os.Build;
import android.os.Handler;
import android.os.HandlerThread;
import android.os.IBinder;
import android.os.PowerManager;
import android.os.SystemClock;
import android.provider.Settings;
import android.util.Log;
import android.util.Range;
import android.util.Size;
import android.view.Gravity;
import android.view.Surface;
import android.view.View;
import android.view.WindowManager;
import android.widget.TextView;

import java.io.BufferedOutputStream;
import java.io.BufferedReader;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.net.Inet4Address;
import java.net.InetAddress;
import java.net.InetSocketAddress;
import java.net.NetworkInterface;
import java.net.ServerSocket;
import java.net.Socket;
import java.nio.ByteBuffer;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Collections;
import java.util.Enumeration;
import java.util.List;
import java.util.Locale;
import java.util.concurrent.Executor;
import java.util.concurrent.RejectedExecutionException;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicInteger;

/**
 * Streams the back camera over HTTP, for the VARUNA drone backend:
 *
 *   http://<phone>:8080/h264      H.264 stream (Annex-B), smooth and light: the main video
 *   http://<phone>:8080/video     MJPEG stream (multipart/x-mixed-replace), a light backup
 *   http://<phone>:8080/shot.jpg  one JPEG
 *   http://<phone>:8080/status    JSON status
 *   http://<phone>:8080/location         the phone's GPS position and camera attitude (JSON)
 *   http://<phone>:8080/location/stream  the same as a live stream, one JSON line ~20 times a second
 *   http://<phone>:8080/location/home    makes the current position the take-off point
 *
 * The phone's GPS is the drone's position: the VARUNA backend reads /location/stream.
 * Runs as a camera foreground service, so it keeps the camera when the app is in
 * the background. JPEGs are only encoded while someone is watching /video.
 */
public class CamService extends Service {
    static final String TAG = "VarunaCam";
    static final int PORT = 8080;
    static final String ACTION_STOP = "ai.varuna.cam.STOP";
    private static final String CHANNEL = "varuna_cam";
    private static final String BOUNDARY = "varunacam";

    /** The running service, for the activity's status line; null when stopped. */
    static volatile CamService running;

    private HandlerThread camThread;
    private Handler camHandler;
    private CameraDevice camera;
    private CameraCaptureSession session;
    private ImageReader reader;
    /** The H.264 encoder fed by the camera; null if this phone can't. */
    private volatile H264Stream h264;
    /** The camera refused H.264 next to the backup stream once: MJPEG only from then on. */
    private boolean h264Refused;
    private volatile String h264Note = "";
    private volatile Quality quality;
    private volatile Size size;
    private Range<Integer> fpsRange;
    private volatile String extras = "";
    /** Short exposures in flight (sharp through vibration); see {@link Shutter}. */
    private volatile Shutter shutter;
    private long lastMeterMs;
    // What the camera really does (from its capture results): frames a second
    // and exposure. In dim light some cameras lengthen the exposure and slow
    // down whatever frame rate was asked for.
    private volatile float camFps;
    private volatile float exposureMs;
    private int camCount;
    private long camSince;
    private final CameraCaptureSession.CaptureCallback camStats = new CameraCaptureSession.CaptureCallback() {
        @Override
        public void onCaptureCompleted(CameraCaptureSession session, CaptureRequest req, TotalCaptureResult result) {
            Long exp = result.get(CaptureResult.SENSOR_EXPOSURE_TIME);
            if (exp != null) exposureMs = exp / 1_000_000f;
            long now = SystemClock.elapsedRealtime();
            if (camSince == 0) camSince = now;
            camCount++;
            if (now - camSince >= 2000) {
                camFps = camCount * 1000f / (now - camSince);
                camCount = 0;
                camSince = now;
            }
        }
    };
    private PowerManager.WakeLock wakeLock;
    private WifiManager.WifiLock wifiLock;
    private WifiManager.WifiLock wifiPerfLock;
    // Android doubles this: about two 480p frames in flight, so a slow moment on
    // the Wi-Fi skips frames instead of queueing old ones.
    private static final int SEND_BUFFER = 32 * 1024;
    /** JPEG quality now, adapted to what the Wi-Fi carries; at most the preset's. */
    private volatile int liveJpeg = 70;
    private static final int MIN_JPEG = 35;
    private int easyFrames;
    /**
     * A smaller preset in use because the Wi-Fi couldn't carry the chosen one even
     * at the lowest JPEG quality; null while the chosen one fits. Choosing a
     * quality again clears it.
     */
    private volatile Quality steppedDown;
    private long congestedSinceMs;
    private long steppedAtMs;
    /** How long the link may stay full at the lowest JPEG quality before a smaller picture. */
    private static final long STEP_DOWN_AFTER_MS = 3000;
    /** The phone's GPS and attitude: the drone's position. */
    private PhoneLocation location;
    private ServerSocket server;
    private volatile boolean stopping;
    private volatile String state = "Starting the camera";

    private final Object frameLock = new Object();
    private byte[] frame;            // latest JPEG, guarded by frameLock
    private long frameSeq;           // guarded by frameLock
    private long lastEncodeMs;
    private byte[] nv21;
    private final ByteArrayOutputStream jpegOut = new ByteArrayOutputStream(512 * 1024);
    private int kbSum;
    private volatile int frameKb;
    private HandlerThread encThread;
    private Handler encHandler;
    // JPEG compression has its own thread: a slow compress must never keep a
    // camera picture waiting, or the camera (and the H.264 video) slows down.
    private HandlerThread jpegThread;
    private Handler jpegHandler;
    private final AtomicBoolean jpegBusy = new AtomicBoolean();
    // The repeating request, kept to switch the MJPEG pictures on and off: the
    // camera only makes them while someone watches /video (or wants a shot).
    private CaptureRequest.Builder request;
    private boolean requestHasH264;
    private boolean readerInRequest;
    private final AtomicInteger clients = new AtomicInteger();
    private volatile long wantShotUntil;
    private volatile float fps;
    private int fpsCount;
    private long fpsSince = SystemClock.elapsedRealtime();
    private final List<Socket> sockets = Collections.synchronizedList(new ArrayList<Socket>());

    private final Runnable reopen = new Runnable() {
        @Override
        public void run() {
            closeCamera();
            openCamera();
        }
    };

    @Override
    public void onCreate() {
        super.onCreate();
        running = this;
        NotificationManager nm = getSystemService(NotificationManager.class);
        nm.createNotificationChannel(new NotificationChannel(CHANNEL, "VARUNA Cam", NotificationManager.IMPORTANCE_LOW));
        goForeground();
        location = new PhoneLocation(this);
        location.start();

        PowerManager pm = (PowerManager) getSystemService(Context.POWER_SERVICE);
        wakeLock = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "VarunaCam:stream");
        wakeLock.acquire();
        holdWifi();

        showOverlay();

        camThread = new HandlerThread("cam");
        camThread.start();
        camHandler = new Handler(camThread.getLooper());
        encThread = new HandlerThread("encode");
        encThread.start();
        encHandler = new Handler(encThread.getLooper());
        jpegThread = new HandlerThread("jpeg");
        jpegThread.start();
        jpegHandler = new Handler(jpegThread.getLooper());
        startServer();
        startDiscovery();
        camHandler.post(new Runnable() {
            @Override
            public void run() {
                openCamera();
            }
        });
    }

    // ---- "Where is VARUNA Cam?" ------------------------------------------

    /** UDP port the laptop's backend asks on (a broadcast "VARUNA_CAM?"). */
    static final int DISCOVERY_PORT = 47800;
    private volatile java.net.DatagramSocket discoSock;
    private WifiManager.MulticastLock multicastLock;

    /**
     * Answers the laptop's broadcast question "VARUNA_CAM?" with where this
     * phone's video is. The backend asks every second while it has no video,
     * so it finds the phone on any Wi-Fi or hotspot within a second, also after
     * the phone got a new address — no scanning, no IP to type.
     */
    private void startDiscovery() {
        WifiManager wm = (WifiManager) getApplicationContext().getSystemService(Context.WIFI_SERVICE);
        try {
            if (wm != null) {
                // Many phones drop broadcast packets to save power unless an app asks for them.
                multicastLock = wm.createMulticastLock("VarunaCam:discovery");
                multicastLock.setReferenceCounted(false);
                multicastLock.acquire();
            }
        } catch (RuntimeException e) {
            Log.w(TAG, "multicast lock: " + e);
        }
        Thread t = new Thread(new Runnable() {
            @Override
            public void run() {
                byte[] buf = new byte[256];
                while (!stopping) {
                    try (java.net.DatagramSocket s = new java.net.DatagramSocket(null)) {
                        s.setReuseAddress(true);
                        s.setBroadcast(true);
                        s.bind(new InetSocketAddress(DISCOVERY_PORT));
                        discoSock = s;
                        while (!stopping) {
                            java.net.DatagramPacket p = new java.net.DatagramPacket(buf, buf.length);
                            s.receive(p);
                            String q = new String(p.getData(), 0, p.getLength(), StandardCharsets.UTF_8);
                            if (!q.startsWith("VARUNA_CAM?")) continue;
                            byte[] r = String.format(Locale.US,
                                    "{\"varuna_cam\":1,\"port\":%d,\"state\":\"%s\",\"h264\":%b}",
                                    PORT, state.replace("\"", "'"), h264 != null).getBytes(StandardCharsets.UTF_8);
                            s.send(new java.net.DatagramPacket(r, r.length, p.getAddress(), p.getPort()));
                        }
                    } catch (IOException | RuntimeException e) {
                        if (!stopping) SystemClock.sleep(2000);   // Wi-Fi changing: open it again
                    }
                }
            }
        }, "discovery");
        t.setDaemon(true);
        t.start();
    }

    private void stopDiscovery() {
        java.net.DatagramSocket s = discoSock;
        if (s != null) s.close();
        if (multicastLock != null && multicastLock.isHeld()) multicastLock.release();
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        if (intent != null && ACTION_STOP.equals(intent.getAction())) {
            stopSelf();
            return START_NOT_STICKY;
        }
        goForeground();   // every startForegroundService() needs a startForeground()
        // Not sticky: Android may not let a restarted service open the camera from the background.
        return START_NOT_STICKY;
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    @Override
    public void onDestroy() {
        stopping = true;
        running = null;
        stopDiscovery();
        try {
            if (server != null) server.close();
        } catch (IOException ignored) {
        }
        synchronized (sockets) {
            for (Socket s : sockets) {
                try {
                    s.close();
                } catch (IOException ignored) {
                }
            }
        }
        synchronized (frameLock) {
            frameLock.notifyAll();
        }
        location.stop();
        camHandler.removeCallbacks(reopen);
        camHandler.post(new Runnable() {
            @Override
            public void run() {
                closeCamera();
                if (reader != null) reader.close();
                camThread.quitSafely();
                encThread.quitSafely();
                jpegThread.quitSafely();
            }
        });
        if (wakeLock.isHeld()) wakeLock.release();
        releaseWifi();
        hideOverlay();
        super.onDestroy();
    }

    // ---- Wi-Fi without power saving --------------------------------------

    /**
     * Keeps the phone's Wi-Fi out of power-save while streaming. In power-save
     * the radio naps between beacons and sends in bursts, which shows as lag
     * and stutter in the video.
     */
    @SuppressWarnings("deprecation")   // HIGH_PERF: the only no-power-save lock before Android 10
    private void holdWifi() {
        WifiManager wm = (WifiManager) getApplicationContext().getSystemService(Context.WIFI_SERVICE);
        if (wm == null) return;
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                wifiLock = wm.createWifiLock(WifiManager.WIFI_MODE_FULL_LOW_LATENCY, "VarunaCam:lowlatency");
                wifiLock.setReferenceCounted(false);
                wifiLock.acquire();
            }
            wifiPerfLock = wm.createWifiLock(WifiManager.WIFI_MODE_FULL_HIGH_PERF, "VarunaCam:highperf");
            wifiPerfLock.setReferenceCounted(false);
            wifiPerfLock.acquire();
        } catch (RuntimeException e) {
            Log.w(TAG, "wifi lock: " + e);
        }
    }

    private void releaseWifi() {
        if (wifiLock != null && wifiLock.isHeld()) wifiLock.release();
        if (wifiPerfLock != null && wifiPerfLock.isHeld()) wifiPerfLock.release();
    }

    // ---- "LIVE" badge over other apps -------------------------------------

    private View overlay;

    /** Shows the badge if "Display over other apps" is allowed. Main thread only. */
    void showOverlay() {
        if (overlay != null || !Settings.canDrawOverlays(this)) return;
        TextView badge = new TextView(this);
        badge.setText("● VARUNA LIVE");
        badge.setTextColor(Color.WHITE);
        badge.setTextSize(11);
        badge.setTypeface(Typeface.DEFAULT_BOLD);
        float d = getResources().getDisplayMetrics().density;
        badge.setPadding((int) (8 * d), (int) (3 * d), (int) (8 * d), (int) (3 * d));
        GradientDrawable bg = new GradientDrawable();
        bg.setColor(Color.argb(170, 200, 30, 30));
        bg.setCornerRadius(10 * d);
        badge.setBackground(bg);

        WindowManager.LayoutParams lp = new WindowManager.LayoutParams(
                WindowManager.LayoutParams.WRAP_CONTENT, WindowManager.LayoutParams.WRAP_CONTENT,
                WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY,
                WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE | WindowManager.LayoutParams.FLAG_NOT_TOUCHABLE
                        | WindowManager.LayoutParams.FLAG_LAYOUT_IN_SCREEN,
                PixelFormat.TRANSLUCENT);
        lp.gravity = Gravity.TOP | Gravity.END;
        lp.x = (int) (12 * d);
        lp.y = (int) (40 * d);
        try {
            ((WindowManager) getSystemService(Context.WINDOW_SERVICE)).addView(badge, lp);
            overlay = badge;
        } catch (RuntimeException e) {
            Log.w(TAG, "overlay: " + e);
        }
    }

    boolean hasOverlay() {
        return overlay != null;
    }

    private void hideOverlay() {
        if (overlay == null) return;
        try {
            ((WindowManager) getSystemService(Context.WINDOW_SERVICE)).removeView(overlay);
        } catch (RuntimeException ignored) {
        }
        overlay = null;
    }

    // ---- foreground notification ------------------------------------------

    private void goForeground() {
        PendingIntent open = PendingIntent.getActivity(this, 0, new Intent(this, MainActivity.class),
                PendingIntent.FLAG_IMMUTABLE);
        PendingIntent stop = PendingIntent.getService(this, 1,
                new Intent(this, CamService.class).setAction(ACTION_STOP), PendingIntent.FLAG_IMMUTABLE);
        Notification n = new Notification.Builder(this, CHANNEL)
                .setSmallIcon(android.R.drawable.ic_menu_camera)
                .setContentTitle("VARUNA Cam is streaming")
                .setContentText("Video on port " + PORT + " for the VARUNA app on this Wi-Fi")
                .setContentIntent(open)
                .addAction(new Notification.Action.Builder(null, "Stop", stop).build())
                .setOngoing(true)
                .build();
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            // Location too once it is allowed, so the GPS keeps going in the background.
            int types = ServiceInfo.FOREGROUND_SERVICE_TYPE_CAMERA
                    | (PhoneLocation.allowed(this) ? ServiceInfo.FOREGROUND_SERVICE_TYPE_LOCATION : 0);
            startForeground(1, n, types);
        } else {
            startForeground(1, n);
        }
    }

    // ---- the phone's GPS --------------------------------------------------

    boolean locationRunning() {
        return location != null && location.gpsRequested();
    }

    /** Location was allowed after the start: the GPS starts now. */
    void restartLocation() {
        goForeground();
        if (location != null) location.requestGps();
    }

    void setHome() {
        if (location != null) location.setHome();
    }

    /** One JSON line per sample for as long as the client stays. */
    private void locationStream(OutputStream out) throws IOException {
        final java.util.concurrent.LinkedBlockingQueue<String> q = new java.util.concurrent.LinkedBlockingQueue<>(20);
        PhoneLocation.Sink sink = new PhoneLocation.Sink() {
            @Override
            public void sample(String json) {
                if (!q.offer(json)) {      // the client is behind: only the newest matters
                    q.clear();
                    q.offer(json);
                }
            }
        };
        ascii(out, "HTTP/1.0 200 OK\r\nContent-Type: application/x-ndjson\r\n"
                + "Cache-Control: no-cache, no-store\r\nConnection: close\r\n\r\n");
        out.write((location.latestJson() + "\n").getBytes(StandardCharsets.UTF_8));
        out.flush();
        location.addSink(sink);
        try {
            while (!stopping) {
                // A line at least every 0.25 s, even with no rotation sensor.
                String j = q.poll(250, java.util.concurrent.TimeUnit.MILLISECONDS);
                if (j == null) j = location.latestJson();
                out.write((j + "\n").getBytes(StandardCharsets.UTF_8));
                if (q.isEmpty()) out.flush();
            }
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
        } finally {
            location.removeSink(sink);
        }
    }

    /**
     * Tells the attitude which way the picture's top faces in the phone, and the
     * picture's horizontal field of view (from the lens focal length and sensor
     * size, for the width the stream uses).
     */
    private void cameraGeometry(CameraCharacteristics cc, int width, int height) {
        Integer orient = cc.get(CameraCharacteristics.SENSOR_ORIENTATION);
        float fov = Float.NaN;
        android.util.SizeF phys = cc.get(CameraCharacteristics.SENSOR_INFO_PHYSICAL_SIZE);
        float[] focal = cc.get(CameraCharacteristics.LENS_INFO_AVAILABLE_FOCAL_LENGTHS);
        if (phys != null && focal != null && focal.length > 0 && focal[0] > 0 && width > 0 && height > 0) {
            float sensorAspect = phys.getWidth() / phys.getHeight();
            float aspect = (float) width / height;
            // A wider picture than the sensor is cut from its full width; a narrower one from part of it.
            float usedWidth = phys.getWidth() * Math.min(1f, aspect / sensorAspect);
            fov = (float) Math.toDegrees(2 * Math.atan(usedWidth / (2 * focal[0])));
        }
        if (location != null) location.setCamera(orient != null ? orient : 90, fov);
    }

    // ---- camera -----------------------------------------------------------

    private void openCamera() {
        if (stopping) return;
        CameraManager cm = (CameraManager) getSystemService(Context.CAMERA_SERVICE);
        try {
            String id = null;
            String[] ids = cm.getCameraIdList();
            for (String c : ids) {
                Integer facing = cm.getCameraCharacteristics(c).get(CameraCharacteristics.LENS_FACING);
                if (facing != null && facing == CameraCharacteristics.LENS_FACING_BACK) {
                    id = c;
                    break;
                }
            }
            if (id == null && ids.length > 0) id = ids[0];
            if (id == null) {
                state = "No camera found";
                return;
            }
            CameraCharacteristics cc = cm.getCameraCharacteristics(id);
            StreamConfigurationMap map = cc.get(CameraCharacteristics.SCALER_STREAM_CONFIGURATION_MAP);
            if (map == null) {
                state = "The camera reports no video sizes";
                return;
            }
            Quality down = steppedDown;
            quality = down != null ? down : Quality.get(this);
            liveJpeg = quality.jpeg;
            Quality q = quality;
            startH264(map, q);
            // With H.264 as the main video, the MJPEG backup only needs to be light:
            // 640 wide, the shape of the H.264 picture.
            H264Stream h = h264;
            size = h != null
                    ? pickSize(map.getOutputSizes(ImageFormat.YUV_420_888), 640, 640 * h.height / h.width)
                    : pickSize(map.getOutputSizes(ImageFormat.YUV_420_888), q.width, q.height);
            cameraGeometry(cc, h != null ? h.width : size.getWidth(), h != null ? h.height : size.getHeight());
            fpsRange = pickFps(cc.get(CameraCharacteristics.CONTROL_AE_AVAILABLE_TARGET_FPS_RANGES), quality.fps);
            final boolean videoFocus = hasMode(cc.get(CameraCharacteristics.CONTROL_AF_AVAILABLE_MODES),
                    CaptureRequest.CONTROL_AF_MODE_CONTINUOUS_VIDEO);
            // Steady picture on a vibrating drone: optical stabilisation if the lens has it,
            // otherwise electronic. Not both: they fight each other.
            final boolean ois = hasMode(cc.get(CameraCharacteristics.LENS_INFO_AVAILABLE_OPTICAL_STABILIZATION),
                    CaptureRequest.LENS_OPTICAL_STABILIZATION_MODE_ON);
            final boolean eis = !ois && hasMode(cc.get(CameraCharacteristics.CONTROL_AVAILABLE_VIDEO_STABILIZATION_MODES),
                    CaptureRequest.CONTROL_VIDEO_STABILIZATION_MODE_ON);
            long minFrameNs = map.getOutputMinFrameDuration(ImageFormat.YUV_420_888, size);
            int camMaxFps = minFrameNs > 0 ? (int) (1_000_000_000L / minFrameNs) : 0;
            extras = (ois ? "optical stabilisation" : eis ? "electronic stabilisation" : "no stabilisation")
                    + (camMaxFps > 0 ? ", camera up to " + camMaxFps + " fps here" : "")
                    + (fpsRange != null ? ", frame rate " + (fpsRange.getLower().equals(fpsRange.getUpper())
                    ? "fixed " + fpsRange.getUpper() : fpsRange.getLower() + "-" + fpsRange.getUpper()) + " fps" : "");
            shutter = new Shutter(cc, fpsRange != null ? fpsRange.getUpper() : quality.fps, Shutter.enabled(this));
            if (reader != null) reader.close();
            reader = ImageReader.newInstance(size.getWidth(), size.getHeight(), ImageFormat.YUV_420_888, 3);
            reader.setOnImageAvailableListener(new ImageReader.OnImageAvailableListener() {
                @Override
                public void onImageAvailable(ImageReader r) {
                    onImage(r);
                }
            }, encHandler);
            cm.openCamera(id, new CameraDevice.StateCallback() {
                @Override
                public void onOpened(CameraDevice d) {
                    camera = d;
                    startSession(videoFocus, ois, eis);
                }

                @Override
                public void onDisconnected(CameraDevice d) {
                    d.close();
                    camera = null;
                    state = "Another app took the camera; trying again";
                    retryLater();
                }

                @Override
                public void onError(CameraDevice d, int error) {
                    d.close();
                    camera = null;
                    state = "Camera error " + error + "; trying again";
                    retryLater();
                }
            }, camHandler);
        } catch (CameraAccessException | SecurityException | IllegalArgumentException e) {
            state = "Can't open the camera: " + e.getMessage();
            Log.w(TAG, state);
            retryLater();
        }
    }

    /** Starts the H.264 encoder at the preset's size, or the nearest the phone can encode. */
    private void startH264(StreamConfigurationMap map, Quality q) {
        releaseH264();
        if (h264Refused) {
            h264Note = "H.264: this camera can't send it next to the backup stream; MJPEG only";
            return;
        }
        Size[] sizes = map.getOutputSizes(MediaCodec.class);
        if (sizes == null || sizes.length == 0) {
            h264Note = "H.264: the camera can't feed the video encoder; MJPEG only";
            return;
        }
        h264Note = "";
        int[][] tries = {{q.width, q.height}, {1280, 720}, {640, 480}};
        for (int[] t : tries) {
            Size s = pickSize(sizes, t[0], t[1]);
            if (!H264Stream.supports(s.getWidth(), s.getHeight())) continue;
            try {
                h264 = H264Stream.start(s.getWidth(), s.getHeight(), q.fps, q.maxKbps);
                h264Note = "";
                return;
            } catch (IOException e) {
                Log.w(TAG, "H.264 at " + s + ": " + e.getMessage());
                h264Note = "H.264: " + e.getMessage() + "; MJPEG only";
            }
        }
        if (h264Note.isEmpty()) h264Note = "H.264: no encoder for these sizes on this phone; MJPEG only";
    }

    private void releaseH264() {
        H264Stream h = h264;
        h264 = null;
        if (h != null) h.release();
    }

    private void startSession(final boolean videoFocus, final boolean ois, final boolean eis) {
        final H264Stream h = h264;
        CameraCaptureSession.StateCallback cb = new CameraCaptureSession.StateCallback() {
                        @Override
                        public void onConfigured(CameraCaptureSession s) {
                            if (camera == null) return;
                            session = s;
                            try {
                                CaptureRequest.Builder b = camera.createCaptureRequest(CameraDevice.TEMPLATE_RECORD);
                                if (h != null) b.addTarget(h.surface());
                                requestHasH264 = h != null;
                                readerInRequest = jpegWanted();
                                if (readerInRequest) b.addTarget(reader.getSurface());
                                b.set(CaptureRequest.CONTROL_MODE, CaptureRequest.CONTROL_MODE_AUTO);
                                if (videoFocus) {
                                    b.set(CaptureRequest.CONTROL_AF_MODE, CaptureRequest.CONTROL_AF_MODE_CONTINUOUS_VIDEO);
                                }
                                if (fpsRange != null) b.set(CaptureRequest.CONTROL_AE_TARGET_FPS_RANGE, fpsRange);
                                if (ois) {
                                    b.set(CaptureRequest.LENS_OPTICAL_STABILIZATION_MODE,
                                            CaptureRequest.LENS_OPTICAL_STABILIZATION_MODE_ON);
                                }
                                if (eis) {
                                    b.set(CaptureRequest.CONTROL_VIDEO_STABILIZATION_MODE,
                                            CaptureRequest.CONTROL_VIDEO_STABILIZATION_MODE_ON);
                                }
                                Shutter sh = shutter;
                                if (sh != null) sh.apply(b);
                                s.setRepeatingRequest(b.build(), camStats, camHandler);
                                request = b;
                                state = "Streaming";
                            } catch (CameraAccessException | IllegalStateException e) {
                                state = "Can't start the camera: " + e.getMessage();
                                retryLater();
                            }
                        }

                        @Override
                        public void onConfigureFailed(CameraCaptureSession s) {
                            if (h != null && !h264Refused) {
                                h264Refused = true;     // try again without H.264
                                state = "The camera refused H.264 with the backup stream; using MJPEG";
                            } else {
                                state = "The camera refused the video setup; trying again";
                            }
                            retryLater();
                        }
                    };
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
                List<OutputConfiguration> outs = new ArrayList<>();
                outs.add(new OutputConfiguration(reader.getSurface()));
                if (h != null) outs.add(new OutputConfiguration(h.surface()));
                camera.createCaptureSession(new SessionConfiguration(SessionConfiguration.SESSION_REGULAR,
                        outs, new HandlerExecutor(camHandler), cb));
            } else {
                createSessionLegacy(cb, h);
            }
        } catch (CameraAccessException | IllegalStateException e) {
            state = "Can't start the camera: " + e.getMessage();
            retryLater();
        }
    }

    @SuppressWarnings("deprecation")   // the only way on Android 8 (API 26-27)
    private void createSessionLegacy(CameraCaptureSession.StateCallback cb, H264Stream h)
            throws CameraAccessException {
        List<Surface> outs = new ArrayList<>();
        outs.add(reader.getSurface());
        if (h != null) outs.add(h.surface());
        camera.createCaptureSession(outs, cb, camHandler);
    }

    /** Runs the camera callbacks on the camera thread. */
    private static final class HandlerExecutor implements Executor {
        private final Handler handler;

        HandlerExecutor(Handler handler) {
            this.handler = handler;
        }

        @Override
        public void execute(Runnable r) {
            if (!handler.post(r)) throw new RejectedExecutionException("camera thread stopped");
        }
    }

    private void retryLater() {
        if (stopping) return;
        camHandler.removeCallbacks(reopen);
        camHandler.postDelayed(reopen, 3000);
    }

    private void closeCamera() {
        request = null;
        readerInRequest = false;
        if (session != null) {
            try {
                session.close();
            } catch (IllegalStateException ignored) {
            }
            session = null;
        }
        if (camera != null) {
            camera.close();
            camera = null;
        }
        releaseH264();
    }

    /** The wanted size if the camera offers it, else the closest of the same shape. */
    private static Size pickSize(Size[] sizes, int width, int height) {
        long want = (long) width * height;
        Size best = null;
        long bestScore = Long.MAX_VALUE;
        for (Size s : sizes) {
            if (s.getWidth() == width && s.getHeight() == height) return s;
            long area = (long) s.getWidth() * s.getHeight();
            long score = Math.abs(area - want);
            if ((long) s.getWidth() * height != (long) s.getHeight() * width) score += want;  // other shape
            if (area > want) score += want / 4;     // a little smaller beats a little bigger
            if (score < bestScore) {
                bestScore = score;
                best = s;
            }
        }
        return best != null ? best : new Size(width, height);
    }

    private static Range<Integer> pickFps(Range<Integer>[] ranges, int fps) {
        if (ranges == null || ranges.length == 0) return null;
        Range<Integer> best = null;
        // A fixed rate: smooth video comes first. With a range such as [7, 30] the
        // camera slows to 7-10 fps indoors or at dusk to brighten the picture,
        // and the video stutters. Fixed, it stays at fps and is a little darker.
        for (Range<Integer> r : ranges) {
            if (r.getUpper() == fps && r.getLower() == fps) return r;
        }
        for (Range<Integer> r : ranges) {
            // Else up to fps, with the floor as high as the camera allows.
            if (r.getUpper() == fps && (best == null || r.getLower() > best.getLower())) best = r;
        }
        if (best != null) return best;
        for (Range<Integer> r : ranges) {
            if (r.getUpper() >= fps && (best == null || r.getUpper() < best.getUpper())) best = r;
        }
        if (best != null) return best;
        for (Range<Integer> r : ranges) {
            if (best == null || r.getUpper() > best.getUpper()) best = r;
        }
        return best;
    }

    private static boolean hasMode(int[] modes, int mode) {
        if (modes == null) return false;
        for (int m : modes) {
            if (m == mode) return true;
        }
        return false;
    }

    /** Whether the camera should make pictures for MJPEG (/video, /shot.jpg). */
    private boolean jpegWanted() {
        Shutter sh = shutter;
        return !requestHasH264 || clients.get() > 0 || SystemClock.elapsedRealtime() < wantShotUntil
                || (sh != null && sh.metering());   // the fast shutter's exposure reads the pictures' brightness
    }

    /** On the camera thread: the request again with the fast shutter's new exposure and ISO. */
    private void resendShutter() {
        CameraCaptureSession s = session;
        CaptureRequest.Builder b = request;
        Shutter sh = shutter;
        if (s == null || b == null || sh == null) return;
        try {
            sh.apply(b);
            s.setRepeatingRequest(b.build(), camStats, camHandler);
        } catch (CameraAccessException | IllegalStateException | IllegalArgumentException e) {
            Log.w(TAG, "shutter: " + e.getMessage());
        }
    }

    /** Mean brightness (0-255) of a picture, from a grid of its Y (luma) samples. */
    private static float meanLuma(Image img) {
        Image.Plane p = img.getPlanes()[0];
        java.nio.ByteBuffer buf = p.getBuffer();
        int rs = p.getRowStride(), ps = p.getPixelStride();
        int w = img.getWidth(), h = img.getHeight();
        int sx = Math.max(1, w / 32), sy = Math.max(1, h / 24);
        long sum = 0;
        int n = 0;
        for (int y = sy / 2; y < h; y += sy) {
            for (int x = sx / 2; x < w; x += sx) {
                sum += buf.get(y * rs + x * ps) & 0xff;
                n++;
            }
        }
        return n > 0 ? (float) sum / n : 0f;
    }

    /** Adds or drops the MJPEG pictures from the camera's request, as they're wanted. */
    private void applyRequest() {
        CameraCaptureSession s = session;
        CaptureRequest.Builder b = request;
        ImageReader rd = reader;
        if (s == null || b == null || rd == null) return;
        boolean want = jpegWanted();
        if (want == readerInRequest) return;
        try {
            if (want) b.addTarget(rd.getSurface());
            else b.removeTarget(rd.getSurface());
            s.setRepeatingRequest(b.build(), camStats, camHandler);
            readerInRequest = want;
            if (!want) fps = 0;
        } catch (CameraAccessException | IllegalStateException | IllegalArgumentException e) {
            Log.w(TAG, "camera request: " + e.getMessage());
        }
    }

    private void jpegDemandChanged(long recheckMs) {
        Handler hd = camHandler;
        if (hd == null) return;
        hd.post(this::applyRequest);
        if (recheckMs > 0) hd.postDelayed(this::applyRequest, recheckMs);
    }

    /**
     * Runs on the encoder thread. Each picture goes back to the camera at once:
     * the JPEG is made on its own thread, and pictures that come while it is
     * busy are skipped, so the camera never waits.
     */
    private void onImage(ImageReader r) {
        Image img = r.acquireLatestImage();
        if (img == null) return;
        try {
            long now = SystemClock.elapsedRealtime();
            Shutter sh = shutter;
            if (sh != null && sh.metering() && now - lastMeterMs >= 150) {
                lastMeterMs = now;
                try {
                    if (sh.meter(meanLuma(img))) {
                        Handler hd = camHandler;
                        if (hd != null) hd.post(this::resendShutter);
                    }
                } catch (IllegalStateException e) {
                    return;     // the camera was closed mid-picture
                }
            }
            boolean wanted = clients.get() > 0 || now < wantShotUntil;
            Quality q = quality;
            if (!wanted || q == null || now - lastEncodeMs < 1000 / q.fps - 5 || jpegBusy.get()) return;
            lastEncodeMs = now;
            long takenMs;
            int w = img.getWidth();
            int h = img.getHeight();
            try {
                takenMs = captureWallMs(img.getTimestamp());
                toNv21(img);
            } catch (IllegalStateException e) {
                return;     // the camera was closed mid-picture (quality change, stop)
            }
            // Hand the picture back before compressing it: on many phones a picture
            // still held stalls the camera, and the H.264 video with it.
            img.close();
            img = null;
            jpegBusy.set(true);
            final int jw = w, jh = h, jq = Math.min(liveJpeg, q.jpeg);
            final long taken = takenMs;
            Handler jt = jpegHandler;
            if (jt == null || !jt.post(() -> makeJpeg(jw, jh, jq, taken))) jpegBusy.set(false);
        } finally {
            if (img != null) img.close();
        }
    }

    /** On the JPEG thread: the NV21 copy as the next MJPEG frame. */
    private void makeJpeg(int w, int h, int quality, long takenMs) {
        try {
            byte[] jpeg = stamp(compressNv21(w, h, quality), takenMs);
            synchronized (frameLock) {
                frame = jpeg;
                frameSeq++;
                frameLock.notifyAll();
            }
            long now = SystemClock.elapsedRealtime();
            fpsCount++;
            kbSum += jpeg.length / 1024;
            if (now - fpsSince >= 2000) {
                fps = fpsCount * 1000f / (now - fpsSince);
                frameKb = fpsCount > 0 ? kbSum / fpsCount : 0;
                fpsCount = 0;
                kbSum = 0;
                fpsSince = now;
            }
        } finally {
            jpegBusy.set(false);
        }
    }

    /** When the picture was taken, on the phone's clock (ms since 1970). */
    static long captureWallMs(long sensorNs) {
        long nowNs = SystemClock.elapsedRealtimeNanos();
        long ageNs = nowNs - sensorNs;
        // Most cameras time-stamp on the elapsed-realtime clock; if this one
        // doesn't, the age makes no sense and "now" is the best guess.
        if (ageNs < 0 || ageNs > 2_000_000_000L) ageNs = 0;
        return System.currentTimeMillis() - ageNs / 1_000_000L;
    }

    /**
     * Adds a JPEG comment "VARUNA t=<ms>" with the capture time, so anything down
     * the line can tell how old a frame is. Viewers ignore comments.
     */
    private static byte[] stamp(byte[] jpeg, long takenMs) {
        if (jpeg.length < 2 || (jpeg[0] & 0xff) != 0xFF || (jpeg[1] & 0xff) != 0xD8) return jpeg;
        byte[] text = ("VARUNA t=" + takenMs).getBytes(StandardCharsets.US_ASCII);
        int segLen = text.length + 2;
        byte[] out = new byte[jpeg.length + 2 + segLen];
        out[0] = (byte) 0xFF;
        out[1] = (byte) 0xD8;
        out[2] = (byte) 0xFF;
        out[3] = (byte) 0xFE;
        out[4] = (byte) (segLen >> 8);
        out[5] = (byte) segLen;
        System.arraycopy(text, 0, out, 6, text.length);
        System.arraycopy(jpeg, 2, out, 6 + text.length, jpeg.length - 2);
        return out;
    }

    /** The NV21 copy (from {@link #toNv21}) as a JPEG. */
    private byte[] compressNv21(int w, int h, int jpegQuality) {
        YuvImage yuv = new YuvImage(nv21, ImageFormat.NV21, w, h, null);
        jpegOut.reset();
        yuv.compressToJpeg(new Rect(0, 0, w, h), jpegQuality, jpegOut);
        return jpegOut.toByteArray();
    }

    /** YUV_420_888 -> NV21 (into {@link #nv21}), copying whole rows where the layout allows. */
    private void toNv21(Image img) {
        int w = img.getWidth();
        int h = img.getHeight();
        Image.Plane[] p = img.getPlanes();
        int ySize = w * h;
        if (nv21 == null || nv21.length != ySize * 3 / 2) nv21 = new byte[ySize * 3 / 2];

        ByteBuffer yb = p[0].getBuffer();
        int yRow = p[0].getRowStride();
        if (yRow == w) {
            yb.position(0);
            yb.get(nv21, 0, ySize);
        } else {
            for (int row = 0; row < h; row++) {
                yb.position(row * yRow);
                yb.get(nv21, row * w, w);
            }
        }
        int pos = ySize;
        ByteBuffer ub = p[1].getBuffer();
        ByteBuffer vb = p[2].getBuffer();
        int uRow = p[1].getRowStride();
        int uPix = p[1].getPixelStride();
        int vRow = p[2].getRowStride();
        int vPix = p[2].getPixelStride();
        int cw = w / 2;
        int ch = h / 2;
        if (uPix == 2 && vPix == 2 && uRow == vRow && interleavedVu(ub, vb, uRow, cw, ch)) {
            // Most phones: the V plane already holds V,U,V,U... (NV21). Copy each row whole.
            for (int row = 0; row < ch; row++) {
                vb.position(row * vRow);
                vb.get(nv21, pos, 2 * cw - 1);
                nv21[pos + 2 * cw - 1] = ub.get(row * uRow + 2 * (cw - 1));
                pos += 2 * cw;
            }
        } else {
            for (int row = 0; row < ch; row++) {
                for (int col = 0; col < cw; col++) {
                    nv21[pos++] = vb.get(row * vRow + col * vPix);
                    nv21[pos++] = ub.get(row * uRow + col * uPix);
                }
            }
        }
    }

    /** True when the U and V planes are one interleaved V,U buffer (U sits one byte after V). */
    private static boolean interleavedVu(ByteBuffer ub, ByteBuffer vb, int rowStride, int cw, int ch) {
        for (int i = 0; i < 16; i++) {
            int row = (ch - 1) * i / 15;
            int col = (cw - 2) * ((i * 7) % 16) / 15;
            int at = row * rowStride + 2 * col;
            if (at + 1 >= vb.limit() || at >= ub.limit()) return false;
            if (vb.get(at + 1) != ub.get(at)) return false;
        }
        return true;
    }

    // ---- HTTP server ------------------------------------------------------

    private void startServer() {
        new Thread(new Runnable() {
            @Override
            public void run() {
                try {
                    server = new ServerSocket();
                    server.setReuseAddress(true);
                    server.bind(new InetSocketAddress(PORT));
                    while (!stopping) {
                        final Socket s = server.accept();
                        new Thread(new Runnable() {
                            @Override
                            public void run() {
                                handle(s);
                            }
                        }, "cam-client").start();
                    }
                } catch (IOException e) {
                    if (!stopping) {
                        state = "Port " + PORT + " is busy. Is IP Webcam running? Stop it, then restart VARUNA Cam.";
                        Log.w(TAG, "server: " + e);
                    }
                }
            }
        }, "cam-server").start();
    }

    private void handle(Socket s) {
        sockets.add(s);
        try {
            s.setTcpNoDelay(true);
            // Android lets a connection queue megabytes of unsent data: after a
            // Wi-Fi hiccup that is seconds of old video waiting to go out, and the
            // view never catches up. With room for about two frames, a slow link
            // makes the stream skip to the newest frame instead.
            s.setSendBufferSize(SEND_BUFFER);
            s.setSoTimeout(10000);
            BufferedReader in = new BufferedReader(new InputStreamReader(s.getInputStream(), StandardCharsets.ISO_8859_1));
            String line = in.readLine();
            if (line == null) return;
            String[] parts = line.split(" ");
            String path = parts.length > 1 ? parts[1] : "/";
            int q = path.indexOf('?');
            String query = q >= 0 ? path.substring(q + 1) : "";
            if (q >= 0) path = path.substring(0, q);
            while ((line = in.readLine()) != null && !line.isEmpty()) {
                // skip the request headers
            }
            OutputStream out = new BufferedOutputStream(s.getOutputStream(), 64 * 1024);
            if (path.equals("/h264")) {
                H264Stream h = h264;
                if (h == null) {
                    send(out, "503 Service Unavailable", "text/plain",
                            ("No H.264 on this phone now: " + h264Note + ". The video is at /video\n")
                                    .getBytes(StandardCharsets.UTF_8));
                } else {
                    ascii(out, "HTTP/1.0 200 OK\r\nContent-Type: video/h264\r\n"
                            + "Cache-Control: no-cache, no-store\r\nConnection: close\r\n\r\n");
                    out.flush();
                    h.serve(out);
                }
            } else if (path.equals("/video") || path.equals("/video_feed") || path.equals("/mjpeg")) {
                stream(out);
            } else if (path.equals("/shot.jpg") || path.equals("/snapshot.jpg")) {
                shot(out);
            } else if (path.equals("/status")) {
                send(out, "200 OK", "application/json", statusJson().getBytes(StandardCharsets.UTF_8));
            } else if (path.equals("/location")) {
                send(out, "200 OK", "application/json", location.latestJson().getBytes(StandardCharsets.UTF_8));
            } else if (path.equals("/location/stream")) {
                locationStream(out);
            } else if (path.equals("/shutter")) {
                // /shutter?fast=1 or 0: the fast shutter on or off (reopens the camera); kept across restarts.
                if (query.contains("fast=1") || query.contains("fast=0")) {
                    Shutter.set(this, query.contains("fast=1"));
                    applyQuality();
                }
                Shutter sh = shutter;
                String j = String.format(Locale.US, "{\"fast\":%b,\"shutter\":\"%s\"}", Shutter.enabled(this),
                        sh != null ? sh.describe().replace("\"", "'") : "");
                send(out, "200 OK", "application/json", j.getBytes(StandardCharsets.UTF_8));
            } else if (path.equals("/location/home")) {
                location.setHome();
                send(out, "200 OK", "application/json", location.latestJson().getBytes(StandardCharsets.UTF_8));
            } else if (path.equals("/")) {
                String html = "<!doctype html><title>VARUNA Cam</title><body style=\"margin:0;background:#000\">"
                        + "<img src=\"/video\" style=\"width:100%\"></body>";
                send(out, "200 OK", "text/html; charset=utf-8", html.getBytes(StandardCharsets.UTF_8));
            } else {
                send(out, "404 Not Found", "text/plain", "Not found. The video is at /video\n".getBytes(StandardCharsets.UTF_8));
            }
        } catch (IOException ignored) {
            // the client went away
        } finally {
            sockets.remove(s);
            try {
                s.close();
            } catch (IOException ignored) {
            }
        }
    }

    private void stream(OutputStream out) throws IOException {
        clients.incrementAndGet();
        jpegDemandChanged(0);
        try {
            ascii(out, "HTTP/1.0 200 OK\r\nContent-Type: multipart/x-mixed-replace; boundary=" + BOUNDARY
                    + "\r\nCache-Control: no-cache, no-store\r\nPragma: no-cache\r\nConnection: close\r\n\r\n");
            out.flush();
            long seen = -1;
            while (!stopping) {
                byte[] f = nextFrame(seen, 5000);
                if (f == null) continue;     // camera quiet for 5 s: keep waiting
                long seq;
                synchronized (frameLock) {
                    seq = frameSeq;
                }
                boolean skipped = seen >= 0 && seq > seen + 1;
                seen = seq;
                long t0 = SystemClock.elapsedRealtime();
                ascii(out, "--" + BOUNDARY + "\r\nContent-Type: image/jpeg\r\nContent-Length: " + f.length + "\r\n\r\n");
                out.write(f);
                ascii(out, "\r\n");
                out.flush();
                adapt(SystemClock.elapsedRealtime() - t0, skipped);
            }
        } finally {
            clients.decrementAndGet();
            jpegDemandChanged(0);
        }
    }

    /**
     * Fits the JPEG quality to the Wi-Fi. A frame that takes most of a frame's
     * time to leave the phone (the link is full), or frames skipped while the last
     * one was going out, lower it; a run of quick sends raises it again, up to the
     * preset. Frame rate and freshness come first, detail second.
     */
    private synchronized void adapt(long sendMs, boolean skipped) {
        Quality q = quality;
        if (q == null) return;
        long frameMs = 1000L / q.fps;
        long now = SystemClock.elapsedRealtime();
        if (sendMs > frameMs * 7 / 10 || skipped) {
            boolean atFloor = liveJpeg <= MIN_JPEG;
            liveJpeg = Math.max(MIN_JPEG, liveJpeg - (sendMs > frameMs * 2 ? 8 : 4));
            easyFrames = 0;
            // Already as light as JPEG gets and the link is still full: the frames
            // wait in the Wi-Fi queue and the video falls behind. A smaller picture
            // is the only way to keep it live.
            if (atFloor) {
                if (congestedSinceMs == 0) congestedSinceMs = now;
                Quality smaller = smaller(q);
                if (smaller != null && now - congestedSinceMs > STEP_DOWN_AFTER_MS
                        && now - steppedAtMs > 2 * STEP_DOWN_AFTER_MS) {
                    steppedDown = smaller;
                    steppedAtMs = now;
                    congestedSinceMs = 0;
                    reopenCamera();
                }
            }
            return;
        }
        congestedSinceMs = 0;
        if (sendMs < frameMs / 4) {
            if (++easyFrames >= 15) {
                liveJpeg = Math.min(q.jpeg, liveJpeg + 2);
                easyFrames = 0;
            }
        } else {
            easyFrames = 0;
        }
    }

    private void shot(OutputStream out) throws IOException {
        long seen;
        synchronized (frameLock) {
            seen = frame != null && SystemClock.elapsedRealtime() - lastEncodeMs < 1000 ? frameSeq - 1 : frameSeq;
        }
        wantShotUntil = SystemClock.elapsedRealtime() + 3000;
        jpegDemandChanged(3100);
        byte[] f = nextFrame(seen, 3000);
        if (f == null) {
            send(out, "503 Service Unavailable", "text/plain", ("No picture yet: " + state + "\n").getBytes(StandardCharsets.UTF_8));
        } else {
            send(out, "200 OK", "image/jpeg", f);
        }
    }

    /** The latest frame once it's newer than seq `seen`; null after timeoutMs or when stopping. */
    private byte[] nextFrame(long seen, long timeoutMs) {
        long deadline = SystemClock.elapsedRealtime() + timeoutMs;
        synchronized (frameLock) {
            while (frameSeq == seen || frame == null) {
                long left = deadline - SystemClock.elapsedRealtime();
                if (left <= 0 || stopping) return null;
                try {
                    frameLock.wait(left);
                } catch (InterruptedException e) {
                    Thread.currentThread().interrupt();
                    return null;
                }
            }
            return frame;
        }
    }

    private static void send(OutputStream out, String status, String type, byte[] body) throws IOException {
        ascii(out, "HTTP/1.0 " + status + "\r\nContent-Type: " + type + "\r\nContent-Length: " + body.length
                + "\r\nCache-Control: no-cache\r\nConnection: close\r\n\r\n");
        out.write(body);
        out.flush();
    }

    private static void ascii(OutputStream out, String s) throws IOException {
        out.write(s.getBytes(StandardCharsets.ISO_8859_1));
    }

    // ---- status -----------------------------------------------------------

    String statusText() {
        StringBuilder sb = new StringBuilder(state);
        Quality q = quality;
        if (q != null) sb.append("\nQuality: ").append(q.label);
        if (steppedDown != null) {
            sb.append("\nThe Wi-Fi is too slow for ").append(Quality.get(this).label)
                    .append(", so the picture was made smaller to keep the video live. Tap a quality to try again.");
        }
        H264Stream h = h264;
        if (h != null) {
            sb.append(String.format(Locale.US, "\nH.264 %dx%d, %.0f fps, %.1f Mbit/s (fitted to the Wi-Fi)",
                    h.width, h.height, h.fps(), h.kbps() / 1000f));
        } else if (!h264Note.isEmpty()) {
            sb.append("\n").append(h264Note);
        }
        // The MJPEG stream: the backup when H.264 runs, else the video.
        if (size != null && (h == null || clients.get() > 0)) {
            sb.append(h != null ? "\nMJPEG backup " : "\n");
            sb.append(String.format(Locale.US, "%dx%d, %.0f fps", size.getWidth(), size.getHeight(), fps));
            if (fps > 0) {
                sb.append(String.format(Locale.US, ", %d KB a picture, %.1f Mbit/s", frameKb, frameKb * fps * 8 / 1024f));
            }
            if (q != null) {
                sb.append(", JPEG quality ").append(Math.min(liveJpeg, q.jpeg)).append(" of ").append(q.jpeg);
            }
        }
        if (!extras.isEmpty()) sb.append("\n").append(extras);
        Shutter sh = shutter;
        if (sh != null) sb.append("\n").append(sh.describe());
        if (camFps > 0) sb.append(String.format(Locale.US, "\ncamera now %.0f fps, exposure %.0f ms", camFps, exposureMs));
        if (location != null) sb.append("\n").append(location.statusLine());
        int watching = clients.get() + (h != null ? h.viewers() : 0);
        sb.append("\nWatching: ").append(watching);
        if (watching > 1) {
            sb.append(" (each one gets its own copy of the video over the Wi-Fi: close any extra,"
                    + " such as a browser tab on this address, for less delay)");
        }
        sb.append("\nLIVE badge: ").append(overlay != null ? "on (safe in the background)" : "off");
        sb.append("\n\nVideo address:");
        for (String ip : addresses()) sb.append("\nhttp://").append(ip).append(':').append(PORT).append("/video");
        if (h != null) sb.append("\n(the VARUNA backend takes the H.264 video at /h264 by itself)");
        return sb.toString();
    }

    private String statusJson() {
        H264Stream h = h264;
        String h264Json = h == null ? "null" : String.format(Locale.US,
                "{\"width\":%d,\"height\":%d,\"fps\":%.1f,\"kbps\":%d,\"sent_kbps\":%d,\"viewers\":%d}",
                h.width, h.height, h.fps(), h.kbps(), h.sentKbps(), h.viewers());
        return String.format(Locale.US,
                "{\"state\":\"%s\",\"quality\":\"%s\",\"width\":%d,\"height\":%d,\"fps\":%.1f,"
                        + "\"frame_kb\":%d,\"jpeg\":%d,\"clients\":%d,\"port\":%d,\"camera\":\"%s\",\"now_ms\":%d,"
                        + "\"h264\":%s,\"h264_note\":\"%s\",\"shutter\":\"%s\",\"location\":%s}",
                state.replace("\"", "'"), quality != null ? quality.id : "",
                size != null ? size.getWidth() : 0, size != null ? size.getHeight() : 0,
                fps, frameKb, Math.min(liveJpeg, quality != null ? quality.jpeg : 100), clients.get(), PORT,
                (extras + (camFps > 0 ? String.format(Locale.US, ", camera now %.0f fps, exposure %.0f ms", camFps, exposureMs) : "")).replace("\"", "'"),
                System.currentTimeMillis(), h264Json, h264Note.replace("\"", "'"),
                shutter != null ? shutter.describe().replace("\"", "'") : "",
                location != null ? location.latestJson() : "null");
    }

    /** Switch to the quality now saved in the settings: reopens the camera. */
    void applyQuality() {
        steppedDown = null;    // a fresh choice gets a fresh try on this Wi-Fi
        reopenCamera();
    }

    /** One preset smaller than q, or null for the smallest. */
    private static Quality smaller(Quality q) {
        for (int i = 1; i < Quality.ALL.length; i++) {
            if (Quality.ALL[i] == q) return Quality.ALL[i - 1];
        }
        return null;
    }

    private void reopenCamera() {
        state = "Changing the quality";
        camHandler.removeCallbacks(reopen);
        camHandler.post(reopen);
    }

    /** IPv4 addresses of this phone; a NetBird one (100.x) first. */
    static List<String> addresses() {
        List<String> out = new ArrayList<>();
        try {
            Enumeration<NetworkInterface> ifs = NetworkInterface.getNetworkInterfaces();
            while (ifs != null && ifs.hasMoreElements()) {
                NetworkInterface ni = ifs.nextElement();
                if (!ni.isUp() || ni.isLoopback()) continue;
                Enumeration<InetAddress> as = ni.getInetAddresses();
                while (as.hasMoreElements()) {
                    InetAddress a = as.nextElement();
                    if (!(a instanceof Inet4Address)) continue;
                    String ip = a.getHostAddress();
                    if (ip.startsWith("100.")) out.add(0, ip);
                    else out.add(ip);
                }
            }
        } catch (Exception ignored) {
        }
        return out;
    }
}
