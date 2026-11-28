package ai.varuna.boatlink;

import android.Manifest;
import android.annotation.SuppressLint;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.content.pm.ServiceInfo;
import android.hardware.usb.UsbDevice;
import android.hardware.usb.UsbManager;
import android.location.GnssStatus;
import android.location.Location;
import android.location.LocationListener;
import android.location.LocationManager;
import android.net.wifi.WifiManager;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.HandlerThread;
import android.os.IBinder;
import android.os.PowerManager;
import android.os.SystemClock;

import java.io.BufferedReader;
import java.io.File;
import java.io.IOException;
import java.io.InputStream;
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
import java.util.List;
import java.util.Locale;
import java.util.concurrent.ArrayBlockingQueue;
import java.util.concurrent.BlockingQueue;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.TimeUnit;

/**
 * Everything the phone does on the boat, kept running in the background:
 *
 *  - The boat's brain on USB (OTG) <-> TCP port 5760 on Wi-Fi (the laptop's boat
 *    program connects here). Up to 4 connections. The brain is the VARUNA air-boat
 *    brain on an Arduino UNO R4 (boat-r4/), or a Pixhawk - both speak MAVLink alike.
 *  - The phone's GPS -> the brain as GPS_INPUT. For the UNO R4 the phone is also
 *    the compass: its heading goes in GPS_INPUT's yaw field, 10 times a second,
 *    with the position carried forward between fixes; and the heading with the
 *    gyro's turn rate as ATTITUDE, 50 times a second (the brain's heading loop). (A Pixhawk gets the GPS
 *    fixes as before, without a heading: it has its own compass.)
 *  - The back camera as MJPEG on http://<phone>:8080/video (the boat program's camera).
 *  - The trained AI captain (assets/captain.bin). WATCH ONLY by default: 20 times a second
 *    it works out what it would do and shows it (screen, /status.json, /captain.json, a
 *    CSV log). FULL CONTROL is switched on only on this phone's screen (never over Wi-Fi),
 *    is off again at every start, and drives the VARUNA brain like the laptop does
 *    (MANUAL + RC override of steering and throttle) only while it is armed, GPS and
 *    compass are good and it stays near home. The FS-i6 (SwD up = MANUAL) always wins in
 *    the brain; any doubt -> back to watch only and HOLD. The laptop can tell it what the
 *    camera AI saw with POST /captain/world (see CaptainPilot.World).
 *
 * Every part starts again by itself: Pixhawk unplugged and plugged back, Wi-Fi
 * dropped, laptop reconnecting, camera lost.
 */
public class LinkService extends Service {
    static final int MAV_PORT = 5760, HTTP_PORT = 8080, BAUD = 115200;
    static final int GPS_SYS = 254, GPS_COMP = 220;     // our id on the Pixhawk's link (220 = GPS)
    private static final String CHANNEL = "link";

    static volatile LinkService instance;

    private volatile boolean running;
    private PowerManager.WakeLock wake;
    private WifiManager.WifiLock wifiLock;
    private UsbManager usbManager;
    private volatile UsbSerial usb;
    private final BlockingQueue<byte[]> toPixhawk = new ArrayBlockingQueue<>(512);
    private final List<Client> clients = new CopyOnWriteArrayList<>();
    private ServerSocket mavServer, httpServer;
    private CameraStream camera;
    private LocationManager locationManager;
    private HandlerThread gpsThread;
    private final Mav.Splitter fromPixhawk = new Mav.Splitter();
    private int gpsSeq;
    private Compass compass;
    FlightLog log;                                      // every frame to / from the brain (.tlog)
    // Arduino (UNO R4 boat brain) USB vendor ids; anything else is treated as a Pixhawk.
    static final int VID_ARDUINO = 0x2341, VID_ARDUINO_ORG = 0x2A03;
    volatile boolean brainR4;
    volatile String brainName = "boat brain";
    static final long NAV_PERIOD_MS = 100;       // GPS_INPUT + heading to the UNO R4: 10 Hz
    static final long ATT_PERIOD_MS = 20;        // ATTITUDE (heading + gyro) to the UNO R4: 50 Hz
    static final long FIX_STALE_MS = 2500;       // older fix: tell the brain "no fix" (it stops)

    // ---- status (read by the screen and /status.json)
    volatile String usbState = "looking for the boat brain";
    volatile long lastHeartbeat, bytesIn, bytesOut;
    volatile String fcMode = "-";
    volatile boolean fcArmed;
    volatile int fcGpsFix = -1, fcGpsSats = -1;
    volatile String gpsState = "waiting for GPS";
    volatile Location lastFix;
    volatile int satsUsed = -1, satsSeen = -1;
    volatile long gpsSent, lastGpsSent;
    private long lastPermissionAsk;
    // Pixhawk telemetry (read from the USB stream, shown on the phone and in /status.json)
    volatile int fcSys = 1, fcSysStatus = -1;
    volatile float fcSpeed = Float.NaN, fcAlt = Float.NaN, fcBattV = Float.NaN;
    volatile int fcHeading = -1, fcBattPct = -1, fcThrottle = -1;
    volatile double fcLat = Double.NaN, fcLng = Double.NaN;
    private final java.util.ArrayDeque<String> fcWarnings = new java.util.ArrayDeque<>();
    // Laptop link watchdog: no frame from any laptop for WATCHDOG_MS while the Pixhawk
    // drives itself (GUIDED / AUTO / RTL) -> the phone switches it to HOLD. Never in MANUAL / ACRO.
    static final long WATCHDOG_MS = 6000;
    volatile long lastLaptopFrame;
    volatile long holdSentAt;
    volatile String watchdogNote = "";
    private int cmdSeq;
    // ---- AI captain
    volatile CaptainPilot pilot;
    volatile String captainError = "";
    static final long CAPTAIN_PERIOD_MS = 50;           // 20 Hz, as trained
    static final float CAPTAIN_MAX_FROM_HOME_M = 60f;   // full control stops (HOLD) beyond this
    static final long CAPTAIN_MODE_WAIT_MS = 3000;      // MANUAL asked for, not reported yet -> give up
    /** Full control asked for on the phone screen (confirmed). Never set over Wi-Fi; false at every start. */
    volatile boolean captainFull;
    /** Full control is really driving now (all checks good). */
    volatile boolean captainDriving;
    volatile String captainNote = "";
    private long captainManualAskedAt;

    // ------------------------------------------------------------------ lifecycle
    @Override
    public void onCreate() {
        super.onCreate();
        instance = this;
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        goForeground();
        if (!running) {
            running = true;
            PowerManager pm = (PowerManager) getSystemService(POWER_SERVICE);
            wake = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "varuna:boatlink");
            wake.acquire();
            WifiManager wm = (WifiManager) getApplicationContext().getSystemService(WIFI_SERVICE);
            @SuppressWarnings("deprecation")
            int mode = Build.VERSION.SDK_INT >= 29 ? WifiManager.WIFI_MODE_FULL_LOW_LATENCY
                    : WifiManager.WIFI_MODE_FULL_HIGH_PERF;
            wifiLock = wm.createWifiLock(mode, "varuna:boatlink");
            wifiLock.acquire();
            usbManager = (UsbManager) getSystemService(USB_SERVICE);
            File ext = getExternalFilesDir("logs");
            log = new FlightLog(ext != null ? ext : new File(getFilesDir(), "logs"));
            thread("usb-read", this::usbLoop);
            thread("usb-write", this::usbWriter);
            thread("mav-server", this::mavServerLoop);
            thread("http-server", this::httpServerLoop);
            thread("watchdog", this::watchdogLoop);
            thread("nav-out", this::navLoop);
            thread("att-out", this::attitudeLoop);
            compass = new Compass(this);
            compass.start();
            startGps();
            startCaptain();
            if (granted(Manifest.permission.CAMERA)) {
                camera = new CameraStream(this);
                camera.start();
            }
        } else {
            // Started again (permissions granted since): fill in what was missing.
            if (camera == null && granted(Manifest.permission.CAMERA)) {
                camera = new CameraStream(this);
                camera.start();
            }
            if (locationManager == null) startGps();
        }
        return START_STICKY;
    }

    @Override
    public void onDestroy() {
        if (captainFull || captainDriving) captainStop("Boat Link closing", true);   // before the USB link closes
        running = false;
        closeQuietly(mavServer);
        closeQuietly(httpServer);
        for (Client c : clients) c.close();
        UsbSerial u = usb;
        if (u != null) u.close();
        if (camera != null) camera.stop();
        if (compass != null) compass.stop();
        if (locationManager != null) {
            try {
                locationManager.removeUpdates(gpsListener);
                if (Build.VERSION.SDK_INT >= 24) locationManager.unregisterGnssStatusCallback(gnssCallback);
            } catch (Exception ignored) {
            }
        }
        if (gpsThread != null) gpsThread.quitSafely();
        if (wake != null && wake.isHeld()) wake.release();
        if (wifiLock != null && wifiLock.isHeld()) wifiLock.release();
        instance = null;
        super.onDestroy();
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    private void goForeground() {
        NotificationManager nm = (NotificationManager) getSystemService(NOTIFICATION_SERVICE);
        if (Build.VERSION.SDK_INT >= 26) {
            nm.createNotificationChannel(new NotificationChannel(CHANNEL, "Boat link", NotificationManager.IMPORTANCE_LOW));
        }
        PendingIntent open = PendingIntent.getActivity(this, 0, new Intent(this, MainActivity.class),
                PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
        Notification.Builder b = Build.VERSION.SDK_INT >= 26 ? new Notification.Builder(this, CHANNEL)
                : new Notification.Builder(this);
        Notification n = b.setContentTitle("VARUNA Boat Link is running")
                .setContentText("Boat brain, GPS, compass and camera to the laptop")
                .setSmallIcon(android.R.drawable.stat_sys_upload)
                .setContentIntent(open)
                .setOngoing(true)
                .build();
        if (Build.VERSION.SDK_INT >= 29) {
            int types = ServiceInfo.FOREGROUND_SERVICE_TYPE_CONNECTED_DEVICE;
            if (granted(Manifest.permission.ACCESS_FINE_LOCATION)) types |= ServiceInfo.FOREGROUND_SERVICE_TYPE_LOCATION;
            if (Build.VERSION.SDK_INT >= 30 && granted(Manifest.permission.CAMERA))
                types |= ServiceInfo.FOREGROUND_SERVICE_TYPE_CAMERA;
            try {
                startForeground(1, n, types);
            } catch (Exception e) {
                startForeground(1, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_CONNECTED_DEVICE);
            }
        } else {
            startForeground(1, n);
        }
    }

    private boolean granted(String perm) {
        return checkSelfPermission(perm) == PackageManager.PERMISSION_GRANTED;
    }

    private void thread(String name, Runnable r) {
        Thread t = new Thread(() -> {
            while (running) {
                try {
                    r.run();
                } catch (Throwable e) {
                    SystemClock.sleep(1000);            // never let a part die: run it again
                }
                if (running) SystemClock.sleep(200);
            }
        }, name);
        t.setDaemon(true);
        t.start();
    }

    // ------------------------------------------------------------------ boat brain on USB
    static boolean isArduino(UsbDevice d) {
        return d.getVendorId() == VID_ARDUINO || d.getVendorId() == VID_ARDUINO_ORG;
    }

    /** The boat brain we feed GPS + heading: the UNO R4, or the ESP32 version (CH340 / CP210x). */
    static boolean isBrain(UsbDevice d) {
        return isArduino(d) || UsbSerial.isEsp32Bridge(d);
    }

    /** The UNO R4 brain first (another USB serial gadget on a hub must not win), then any serial device. */
    private UsbDevice findDevice() {
        UsbDevice any = null;
        for (UsbDevice d : usbManager.getDeviceList().values()) {
            if (!UsbSerial.isSerial(d)) continue;
            if (isBrain(d)) return d;
            if (any == null) any = d;
        }
        return any;
    }

    private void usbLoop() {
        UsbDevice d = findDevice();
        if (d == null) {
            usbState = "boat brain not plugged in (USB OTG)";
            SystemClock.sleep(1000);
            return;
        }
        if (!usbManager.hasPermission(d)) {
            usbState = "allow USB access on the phone screen";
            long now = SystemClock.elapsedRealtime();
            if (now - lastPermissionAsk > 15000) {
                lastPermissionAsk = now;
                int fl = Build.VERSION.SDK_INT >= 31 ? PendingIntent.FLAG_MUTABLE : 0;
                Intent i = new Intent("ai.varuna.boatlink.USB_PERMISSION").setPackage(getPackageName());
                usbManager.requestPermission(d, PendingIntent.getBroadcast(this, 0, i, fl));
            }
            SystemClock.sleep(1000);
            return;
        }
        UsbSerial u;
        try {
            u = UsbSerial.open(usbManager, d, BAUD);
        } catch (IOException e) {
            usbState = "USB: " + e.getMessage();
            SystemClock.sleep(1500);
            return;
        }
        brainR4 = isBrain(d);
        brainName = UsbSerial.isEsp32Bridge(d) ? "ESP32 boat brain" : brainR4 ? "UNO R4 boat brain" : "Pixhawk";
        usb = u;
        usbState = brainName + " on USB";
        log.begin();
        byte[] buf = new byte[16384];
        try {
            while (running) {
                int n = u.read(buf, 200);
                if (n <= 0) continue;
                bytesIn += n;
                byte[] chunk = new byte[n];
                System.arraycopy(buf, 0, chunk, 0, n);
                for (Client c : clients) c.send(chunk);
                watchPixhawk(chunk);
            }
        } catch (IOException e) {
            usbState = brainName + " unplugged - waiting for it";
        } finally {
            log.end();
            usb = null;
            u.close();
            toPixhawk.clear();
        }
    }

    private void usbWriter() {
        while (running) {
            byte[] f;
            try {
                f = toPixhawk.poll(500, TimeUnit.MILLISECONDS);
            } catch (InterruptedException e) {
                return;
            }
            if (f == null) continue;
            UsbSerial u = usb;
            if (u == null) continue;                    // not connected: dropped
            try {
                u.write(f);
                bytesOut += f.length;
                log.add(f);
            } catch (IOException e) {
                SystemClock.sleep(100);
            }
        }
    }

    /** Whole frames only, so the laptop's and the GPS's messages never interleave. */
    private void sendToPixhawk(byte[] frame) {
        if (usb == null) return;
        if (!toPixhawk.offer(frame)) {
            toPixhawk.poll();                           // full: drop the oldest
            toPixhawk.offer(frame);
        }
    }

    private void watchPixhawk(byte[] chunk) {
        for (byte[] f : fromPixhawk.feed(chunk, 0, chunk.length, SystemClock.elapsedRealtime())) {
            log.add(f);
            int id = Mav.msgId(f);
            if (id == 0 && Mav.compId(f) == 1) {          // HEARTBEAT from the autopilot
                ByteBuffer p = Mav.payload(f, 9);
                long custom = p.getInt(0) & 0xffffffffL;
                int type = p.get(4) & 0xff;
                if (type == 6) continue;                // a ground station, not the Pixhawk
                fcMode = Mav.roverMode(custom);
                fcArmed = (p.get(6) & 0x80) != 0;
                fcSysStatus = p.get(7) & 0xff;
                fcSys = Mav.sysId(f);
                lastHeartbeat = SystemClock.elapsedRealtime();
            } else if (Mav.compId(f) != 1) {
                continue;                               // only the autopilot's own reports below
            } else if (id == 24) {                      // GPS_RAW_INT
                ByteBuffer p = Mav.payload(f, 30);
                fcGpsFix = p.get(28) & 0xff;
                int s = p.get(29) & 0xff;
                fcGpsSats = s == 255 ? 0 : s;
            } else if (id == 33) {                      // GLOBAL_POSITION_INT
                ByteBuffer p = Mav.payload(f, 28);
                int lat = p.getInt(4), lon = p.getInt(8);
                if (lat != 0 || lon != 0) {
                    fcLat = lat / 1e7;
                    fcLng = lon / 1e7;
                }
                fcAlt = p.getInt(16) / 1000f;
            } else if (id == 74) {                      // VFR_HUD
                ByteBuffer p = Mav.payload(f, 20);
                fcSpeed = p.getFloat(4);
                fcHeading = p.getShort(16);
                fcThrottle = p.getShort(18) & 0xffff;
            } else if (id == 1) {                       // SYS_STATUS
                ByteBuffer p = Mav.payload(f, 31);
                int mv = p.getShort(14) & 0xffff;
                fcBattV = mv == 0xffff || mv == 0 ? Float.NaN : mv / 1000f;
                fcBattPct = p.get(30);
            } else if (id == 253) {                     // STATUSTEXT
                ByteBuffer p = Mav.payload(f, 51);
                int sev = p.get(0) & 0xff;
                byte[] t = new byte[50];
                p.position(1);
                p.get(t);
                int len = 0;
                while (len < 50 && t[len] != 0) len++;
                String text = new String(t, 0, len, StandardCharsets.US_ASCII).trim();
                if (sev <= 4 && !text.isEmpty()) {      // warnings and worse
                    synchronized (fcWarnings) {
                        fcWarnings.addLast(new java.text.SimpleDateFormat("HH:mm:ss", Locale.US)
                                .format(new java.util.Date()) + " " + text);
                        while (fcWarnings.size() > 5) fcWarnings.removeFirst();
                    }
                }
            }
        }
    }

    // ------------------------------------------------------------------ laptop link watchdog
    private void watchdogLoop() {
        SystemClock.sleep(500);
        if (!pixhawkTalking()) return;
        long now = SystemClock.elapsedRealtime();
        boolean selfDriving = "GUIDED".equals(fcMode) || "AUTO".equals(fcMode) || "RTL".equals(fcMode)
                || "SMART_RTL".equals(fcMode);
        long quiet = lastLaptopFrame == 0 ? Long.MAX_VALUE : now - lastLaptopFrame;
        if (selfDriving && quiet > WATCHDOG_MS) {
            if (now - holdSentAt > 2000) {              // until the Pixhawk reports HOLD
                holdSentAt = now;
                byte[] p = Mav.commandLongPayload(Mav.MAV_CMD_DO_SET_MODE, fcSys, 1, 1f, Mav.ROVER_HOLD);
                sendToPixhawk(Mav.frame2(cmdSeq++ & 0xff, GPS_SYS, 190, Mav.COMMAND_LONG_ID,
                        Mav.COMMAND_LONG_CRC_EXTRA, p));
                watchdogNote = new java.text.SimpleDateFormat("HH:mm:ss", Locale.US).format(new java.util.Date())
                        + " laptop link lost in " + fcMode + " - HOLD sent";
            }
        }
    }

    // ------------------------------------------------------------------ laptop connections (TCP 5760)
    private void mavServerLoop() {
        try (ServerSocket ss = new ServerSocket()) {
            ss.setReuseAddress(true);
            ss.bind(new InetSocketAddress(MAV_PORT));
            mavServer = ss;
            while (running) {
                Socket s = ss.accept();
                s.setTcpNoDelay(true);
                s.setKeepAlive(true);
                if (clients.size() >= 4) {               // too many: drop the oldest
                    clients.get(0).close();
                }
                Client c = new Client(s);
                clients.add(c);
                c.start();
            }
        } catch (IOException e) {
            SystemClock.sleep(1000);
        }
    }

    /** One laptop connection: frames in -> Pixhawk; Pixhawk bytes -> out, never blocking the USB reader. */
    private final class Client {
        final Socket sock;
        final String who;
        final BlockingQueue<byte[]> out = new ArrayBlockingQueue<>(256);
        final Mav.Splitter split = new Mav.Splitter();
        volatile boolean open = true;
        volatile long lastOk = SystemClock.elapsedRealtime();

        Client(Socket s) {
            sock = s;
            who = s.getInetAddress().getHostAddress();
        }

        void start() {
            Thread r = new Thread(this::readLoop, "client-in");
            Thread w = new Thread(this::writeLoop, "client-out");
            r.setDaemon(true);
            w.setDaemon(true);
            r.start();
            w.start();
        }

        void send(byte[] chunk) {
            if (!open) return;
            if (!out.offer(chunk)) {
                // The laptop isn't taking data: drop it (MAVLink copes); give up after 10 s.
                if (SystemClock.elapsedRealtime() - lastOk > 10000) close();
            }
        }

        private void readLoop() {
            byte[] buf = new byte[4096];
            try (InputStream in = sock.getInputStream()) {
                int n;
                while (open && (n = in.read(buf)) > 0) {
                    for (byte[] f : split.feed(buf, 0, n, SystemClock.elapsedRealtime())) {
                        sendToPixhawk(f);
                        lastLaptopFrame = SystemClock.elapsedRealtime();
                    }
                }
            } catch (IOException ignored) {
            } finally {
                close();
            }
        }

        private void writeLoop() {
            try {
                OutputStream os = sock.getOutputStream();
                byte[] batch = new byte[16384];
                while (open) {
                    byte[] first = out.poll(500, TimeUnit.MILLISECONDS);
                    if (first == null) {
                        lastOk = SystemClock.elapsedRealtime();
                        continue;
                    }
                    // Send what's queued together: fewer, bigger Wi-Fi packets.
                    int n = 0;
                    byte[] c = first;
                    while (c != null) {
                        if (n + c.length > batch.length) {
                            os.write(batch, 0, n);
                            n = 0;
                        }
                        if (c.length > batch.length) {
                            os.write(c);
                        } else {
                            System.arraycopy(c, 0, batch, n, c.length);
                            n += c.length;
                        }
                        c = out.poll();
                    }
                    if (n > 0) os.write(batch, 0, n);
                    os.flush();
                    lastOk = SystemClock.elapsedRealtime();
                }
            } catch (Exception ignored) {
            } finally {
                close();
            }
        }

        void close() {
            if (!open) return;
            open = false;
            clients.remove(this);
            closeQuietly(sock);
        }
    }

    // ------------------------------------------------------------------ phone GPS -> Pixhawk
    private final LocationListener gpsListener = new LocationListener() {
        @Override
        public void onLocationChanged(Location loc) {
            onFix(loc);
        }

        @Override
        public void onProviderEnabled(String provider) {
            gpsState = "waiting for GPS";
        }

        @Override
        public void onProviderDisabled(String provider) {
            gpsState = "phone Location is OFF - turn it on";
        }

        @Override
        @SuppressWarnings("deprecation")
        public void onStatusChanged(String provider, int status, Bundle extras) {
        }
    };

    private final GnssStatus.Callback gnssCallback = Build.VERSION.SDK_INT >= 24 ? new GnssStatus.Callback() {
        @Override
        public void onSatelliteStatusChanged(GnssStatus status) {
            int used = 0;
            for (int i = 0; i < status.getSatelliteCount(); i++) if (status.usedInFix(i)) used++;
            satsUsed = used;
            satsSeen = status.getSatelliteCount();
        }
    } : null;

    @SuppressLint("MissingPermission")
    private void startGps() {
        if (!granted(Manifest.permission.ACCESS_FINE_LOCATION)) {
            gpsState = "no location permission";
            return;
        }
        locationManager = (LocationManager) getSystemService(Context.LOCATION_SERVICE);
        gpsThread = new HandlerThread("gps");
        gpsThread.start();
        Handler h = new Handler(gpsThread.getLooper());
        try {
            if (!locationManager.isProviderEnabled(LocationManager.GPS_PROVIDER)) {
                gpsState = "phone Location is OFF - turn it on";
            }
            locationManager.requestLocationUpdates(LocationManager.GPS_PROVIDER, 200, 0f, gpsListener,
                    gpsThread.getLooper());
            if (Build.VERSION.SDK_INT >= 24) locationManager.registerGnssStatusCallback(gnssCallback, h);
        } catch (Exception e) {
            gpsState = "GPS: " + e.getMessage();
        }
    }

    private void onFix(Location loc) {
        lastFix = loc;
        float acc = loc.hasAccuracy() ? loc.getAccuracy() : 99f;
        gpsState = String.format(Locale.US, "fix, %.1f m accuracy", acc);
        if (compass != null) compass.setPosition(loc.getLatitude(), loc.getLongitude(),
                loc.hasAltitude() ? loc.getAltitude() : 0, loc.getTime());
        if (brainR4) return;                    // the UNO R4 gets GPS + heading from navLoop()
        sendGpsInput(loc, 0, 0);
    }

    /** GPS_INPUT for this fix, its position carried forward `aheadMs`, with the heading (cdeg, 0 = none). */
    private void sendGpsInput(Location loc, long aheadMs, int yawCdeg) {
        float acc = loc.hasAccuracy() ? loc.getAccuracy() : 99f;
        // GPS time (GPS_INPUT wants GPS week + ms of week; GPS = UTC + 18 s leap seconds).
        long gpsMs = loc.getTime() + aheadMs - 315964800000L + 18000L;
        int week = (int) (gpsMs / 604800000L);
        long weekMs = gpsMs % 604800000L;
        int ignore = Mav.IGNORE_VEL_VERT | Mav.IGNORE_VERTICAL_ACCURACY;
        float vn = 0, ve = 0;
        if (loc.hasSpeed() && loc.hasBearing()) {
            double b = Math.toRadians(loc.getBearing());
            vn = (float) (loc.getSpeed() * Math.cos(b));
            ve = (float) (loc.getSpeed() * Math.sin(b));
        } else if (loc.hasSpeed() && loc.getSpeed() < 0.2f) {
            vn = 0;                                     // standing still
            ve = 0;
        } else {
            ignore |= Mav.IGNORE_VEL_HORIZ;
        }
        float speedAcc = 0;
        if (Build.VERSION.SDK_INT >= 26 && loc.hasSpeedAccuracy()) speedAcc = loc.getSpeedAccuracyMetersPerSecond();
        else ignore |= Mav.IGNORE_SPEED_ACCURACY;
        double alt = loc.hasAltitude() ? loc.getAltitude() : 0;
        if (Build.VERSION.SDK_INT >= 34 && loc.hasMslAltitude()) alt = loc.getMslAltitudeMeters();
        if (!loc.hasAltitude()) ignore |= Mav.IGNORE_ALT;
        float hdop = Math.max(0.7f, acc / 5f);
        int sats = satsUsed >= 0 ? satsUsed : (acc < 10 ? 10 : 6);
        int fix = acc <= 50 ? 3 : 2;
        double lat = loc.getLatitude(), lon = loc.getLongitude();
        if (aheadMs > 0 && (ignore & Mav.IGNORE_VEL_HORIZ) == 0) {
            // Carried forward at the fix's own velocity (the phone gives a fix about once a second).
            double t = aheadMs / 1000.0;
            lat += vn * t / 6378137.0 * 180 / Math.PI;
            lon += ve * t / (6378137.0 * Math.cos(Math.toRadians(lat))) * 180 / Math.PI;
        }
        byte[] payload = Mav.gpsInputPayload((loc.getTime() + aheadMs) * 1000L, 0, ignore, weekMs, week, fix,
                (int) Math.round(lat * 1e7), (int) Math.round(lon * 1e7),
                (float) alt, hdop, hdop * 1.5f, vn, ve, 0f, speedAcc, acc, 0f, Math.min(sats, 255), yawCdeg);
        sendToPixhawk(Mav.frame2(gpsSeq++ & 0xff, GPS_SYS, GPS_COMP, Mav.GPS_INPUT_ID, Mav.GPS_INPUT_CRC_EXTRA, payload));
        if (usb != null) {
            gpsSent++;
            lastGpsSent = SystemClock.elapsedRealtime();
        }
    }

    /** Heading in GPS_INPUT's yaw field: centidegrees, 36000 = north, 0 = no heading. */
    private int compassCdeg() {
        Compass c = compass;
        if (c == null || !c.ok()) return 0;
        int cd = Math.round(c.headingDeg * 100f) % 36000;
        return cd == 0 ? 36000 : cd;
    }

    /** UNO R4 brain: GPS + phone heading at 10 Hz (a fresh fix is carried forward until the next). */
    private void navLoop() {
        SystemClock.sleep(NAV_PERIOD_MS);
        if (!brainR4 || usb == null) return;
        int yaw = compassCdeg();
        Location f = lastFix;
        long ageMs = f == null ? Long.MAX_VALUE
                : (SystemClock.elapsedRealtimeNanos() - f.getElapsedRealtimeNanos()) / 1000000L;
        if (f != null && ageMs >= 0 && ageMs <= FIX_STALE_MS) {
            sendGpsInput(f, Math.min(ageMs, 1200), yaw);
        } else if (yaw != 0) {
            // No usable fix: the heading alone (fix type 1), so the brain still knows where the bow points.
            int ignore = Mav.IGNORE_ALT | Mav.IGNORE_HDOP | Mav.IGNORE_VDOP | Mav.IGNORE_VEL_HORIZ
                    | Mav.IGNORE_VEL_VERT | Mav.IGNORE_SPEED_ACCURACY | Mav.IGNORE_HORIZONTAL_ACCURACY
                    | Mav.IGNORE_VERTICAL_ACCURACY;
            byte[] payload = Mav.gpsInputPayload(System.currentTimeMillis() * 1000L, 0, ignore, 0, 0, 1,
                    0, 0, 0f, 99f, 99f, 0f, 0f, 0f, 0f, 99f, 0f, 0, yaw);
            sendToPixhawk(Mav.frame2(gpsSeq++ & 0xff, GPS_SYS, GPS_COMP, Mav.GPS_INPUT_ID, Mav.GPS_INPUT_CRC_EXTRA, payload));
        }
    }

    /** UNO R4 brain: heading + gyro turn rate as ATTITUDE, 50 times a second. Its
     *  heading loop steers with the gyro (like a drone), so the fin and the two
     *  motors answer a turn within ~20 ms instead of waiting for the next GPS_INPUT. */
    private void attitudeLoop() {
        long next = SystemClock.elapsedRealtime();
        while (running) {
            next += ATT_PERIOD_MS;
            long wait = next - SystemClock.elapsedRealtime();
            if (wait > 0) SystemClock.sleep(wait);
            else next = SystemClock.elapsedRealtime();     // fell behind: don't burst
            Compass c = compass;
            if (!brainR4 || usb == null || c == null || !c.ok()) continue;
            float yaw = c.headingDeg;
            if (yaw > 180) yaw -= 360;
            float rate = c.rateOk() ? c.rateDegS : 0f;
            byte[] payload = Mav.attitudePayload(SystemClock.elapsedRealtime(), 0f, 0f,
                    (float) Math.toRadians(yaw), 0f, 0f, (float) Math.toRadians(rate));
            sendToPixhawk(Mav.frame2(gpsSeq++ & 0xff, GPS_SYS, GPS_COMP, Mav.ATTITUDE_ID, Mav.ATTITUDE_CRC_EXTRA, payload));
        }
    }

    // ------------------------------------------------------------------ AI captain
    private void startCaptain() {
        try (InputStream in = getAssets().open("captain.bin")) {
            pilot = new CaptainPilot(Captain.load(in));
            thread("captain", this::captainLoop);
        } catch (Exception e) {
            captainError = "AI captain not loaded: " + e.getMessage();
        }
    }

    /** What the phone's sensors say, for the captain. */
    private CaptainPilot.Sensors sensors() {
        CaptainPilot.Sensors s = new CaptainPilot.Sensors();
        Compass c = compass;
        s.headingOk = c != null && c.ok();
        if (s.headingOk) {
            s.headingDeg = c.headingDeg;
            s.rateDegS = c.rateOk() ? c.rateDegS : 0f;
        }
        Location f = lastFix;
        s.fixOk = f != null && System.currentTimeMillis() - f.getTime() < FIX_STALE_MS;
        if (s.fixOk) {
            s.lat = f.getLatitude();
            s.lng = f.getLongitude();
            s.speed = f.hasSpeed() ? f.getSpeed() : 0f;
            s.hasCourse = f.hasBearing();
            s.courseDeg = f.hasBearing() ? f.getBearing() : 0f;
        }
        s.battPct = fcBattPct;
        return s;
    }

    private void captainLoop() {
        CaptainLog clog = new CaptainLog(log.dir);
        long next = SystemClock.elapsedRealtime();
        int n = 0;
        while (running) {
            CaptainPilot p = pilot;
            CaptainPilot.Sensors s = null;
            try {
                s = sensors();
                p.tick(s, SystemClock.elapsedRealtime());
                captainControl(p);
                if (++n % 4 == 0) clog.write(p, s, fcMode, fcThrottle, captainDriving);        // 5 lines a second
            } catch (Exception e) {
                captainError = "AI captain error: " + e;
                if (captainFull || captainDriving) captainStop("captain error", true);
            }
            next += CAPTAIN_PERIOD_MS;
            long wait = next - SystemClock.elapsedRealtime();
            if (wait > 0) SystemClock.sleep(wait);
            else next = SystemClock.elapsedRealtime();             // fell behind: do not try to catch up
        }
        if (captainDriving) captainStop("Boat Link closing", true);
        clog.close();
    }

    /** Why full control may not drive right now ("" = all good). */
    private String captainBlocker(CaptainPilot p) {
        if (usb == null || !pixhawkTalking()) return "the boat brain is not connected";
        if (!brainR4) return "a Pixhawk is connected: full control is for the VARUNA brain only";
        if (!fcArmed) return "the boat is not armed (arm it with the radio or the laptop: the phone never arms)";
        if (!p.ready) return p.why;
        if (!Float.isNaN(p.distHome) && p.distHome > CAPTAIN_MAX_FROM_HOME_M)
            return String.format(Locale.US, "%.0f m from home (limit %.0f m)", p.distHome, CAPTAIN_MAX_FROM_HOME_M);
        return "";
    }

    /** Full control, 20 times a second. Watch only: nothing is sent. */
    private void captainControl(CaptainPilot p) {
        if (!captainFull) return;
        String block = captainBlocker(p);
        if (captainDriving) {
            if (!"MANUAL".equals(fcMode)) {                       // the radio (SwD) or the laptop changed the mode:
                captainStop("the mode changed to " + fcMode + ": you have the boat", false);   // they took over
                return;
            }
            if (!block.isEmpty()) {
                captainStop(block, true);
                return;
            }
            sendCaptainSticks(Mav.stickUs(p.outSteer), Mav.stickUs(p.outThr));
            return;
        }
        // not driving yet: wait until everything is right, then take MANUAL from HOLD
        if (!block.isEmpty()) {
            captainNote = "full control waiting: " + block;
            return;
        }
        if ("MANUAL".equals(fcMode)) {
            captainDriving = true;
            captainManualAskedAt = 0;
            captainNote = "full control: the captain is driving (SwD up = the radio takes over)";
            sendCaptainSticks(Mav.stickUs(p.outSteer), Mav.stickUs(p.outThr));
        } else if ("HOLD".equals(fcMode)) {
            long now = SystemClock.elapsedRealtime();
            if (captainManualAskedAt == 0) {
                captainManualAskedAt = now;
                sendMode(Mav.ROVER_MANUAL);
                captainNote = "full control: asking the brain for MANUAL";
            } else if (now - captainManualAskedAt > CAPTAIN_MODE_WAIT_MS) {
                captainStop("the brain did not switch to MANUAL (is SwD on MANUAL? check its messages)", false);
            }
        } else {
            captainNote = "full control waiting: put the boat in HOLD first (it is in " + fcMode + ")";
        }
    }

    private void sendCaptainSticks(int steerUs, int thrUs) {
        // CH1 steering + CH3 throttle together (the brain's "game controller" scale), the rest untouched
        byte[] pl = Mav.rcOverridePayload(fcSys, 1, steerUs, Mav.RC_IGNORE, thrUs);
        sendToPixhawk(Mav.frame2(cmdSeq++ & 0xff, GPS_SYS, 190, Mav.RC_OVERRIDE_ID, Mav.RC_OVERRIDE_CRC_EXTRA, pl));
    }

    private void sendMode(int roverMode) {
        byte[] pl = Mav.commandLongPayload(Mav.MAV_CMD_DO_SET_MODE, fcSys, 1, 1f, roverMode);
        sendToPixhawk(Mav.frame2(cmdSeq++ & 0xff, GPS_SYS, 190, Mav.COMMAND_LONG_ID, Mav.COMMAND_LONG_CRC_EXTRA, pl));
    }

    /** Back to watch only. hold: also stop the boat (HOLD) - not when the pilot has just taken over. */
    synchronized void captainStop(String why, boolean hold) {
        boolean was = captainDriving || captainManualAskedAt != 0;
        captainFull = false;
        captainDriving = false;
        captainManualAskedAt = 0;
        if (usb != null) {
            // steering + throttle back to the receiver at once (do not wait for the 3 s override timeout)
            byte[] pl = Mav.rcOverridePayload(fcSys, 1, Mav.RC_RELEASE, Mav.RC_IGNORE, Mav.RC_RELEASE);
            sendToPixhawk(Mav.frame2(cmdSeq++ & 0xff, GPS_SYS, 190, Mav.RC_OVERRIDE_ID, Mav.RC_OVERRIDE_CRC_EXTRA, pl));
            if (hold && was && "MANUAL".equals(fcMode)) sendMode(Mav.ROVER_HOLD);
        }
        captainNote = new java.text.SimpleDateFormat("HH:mm:ss", Locale.US).format(new java.util.Date())
                + " back to watch only: " + why + (hold && was ? " (HOLD sent)" : "");
    }

    /** From the phone screen only (after the user confirmed). */
    void captainStartFull() {
        if (pilot == null) return;
        captainManualAskedAt = 0;
        captainDriving = false;
        captainNote = "full control switched on: checking";
        captainFull = true;
    }

    /** POST /captain/world: {"plastic":[{"lat":..,"lng":..,"age_s":..} or {"fwd_m":..,"right_m":..}],
     *  "weeds":[{"lat","lng","radius_m"} or {"fwd_m","right_m","radius_m"}], "shore":[[lat,lng],...],
     *  "home":[lat,lng], "search":[[lat,lng],...], "ramp_load":n, "bin":n, "weed_load":0..3, "go_home":bool} */
    private String setWorld(String body) {
        CaptainPilot p = pilot;
        if (p == null) return "{\"ok\":false,\"error\":\"" + esc(captainError) + "\"}";
        try {
            org.json.JSONObject j = new org.json.JSONObject(body);
            CaptainPilot.World w = new CaptainPilot.World();
            readItems(j.optJSONArray("plastic"), w.bottles, false);
            readItems(j.optJSONArray("weeds"), w.weeds, true);
            readPoints(j.optJSONArray("shore"), w.shore);
            readPoints(j.optJSONArray("search"), w.waypoints);
            org.json.JSONArray h = j.optJSONArray("home");
            if (h != null && h.length() == 2) w.home = new double[]{h.getDouble(0), h.getDouble(1)};
            w.rampLoad = j.optInt("ramp_load", -1);
            w.bin = j.optInt("bin", -1);
            w.weedLoad = (float) j.optDouble("weed_load", -1);
            w.goHome = j.optBoolean("go_home", false);
            p.setWorld(w, sensors(), SystemClock.elapsedRealtime());
            return String.format(Locale.US, "{\"ok\":true,\"plastic\":%d,\"weeds\":%d,\"shore_points\":%d}",
                    w.bottles.size(), w.weeds.size(), w.shore.size());
        } catch (Exception e) {
            return "{\"ok\":false,\"error\":\"" + esc(String.valueOf(e.getMessage())) + "\"}";
        }
    }

    private static void readItems(org.json.JSONArray a, List<CaptainPilot.Item> out, boolean weed) throws org.json.JSONException {
        if (a == null) return;
        for (int i = 0; i < a.length() && i < 64; i++) {
            org.json.JSONObject o = a.getJSONObject(i);
            CaptainPilot.Item it = new CaptainPilot.Item();
            it.lat = o.optDouble("lat", Double.NaN);
            it.lng = o.optDouble("lng", Double.NaN);
            it.fwd = o.optDouble("fwd_m", Double.NaN);
            it.right = o.optDouble("right_m", Double.NaN);
            it.ageS = Math.max(0, o.optDouble("age_s", 0));
            if (weed) it.radius = o.optDouble("radius_m", 1.0);
            out.add(it);
        }
    }

    private static void readPoints(org.json.JSONArray a, List<double[]> out) throws org.json.JSONException {
        if (a == null) return;
        for (int i = 0; i < a.length() && i < 256; i++) {
            org.json.JSONArray q = a.getJSONArray(i);
            out.add(new double[]{q.getDouble(0), q.getDouble(1)});
        }
    }

    String captainModeText() {
        return captainDriving ? "FULL CONTROL - driving" : captainFull ? "FULL CONTROL - waiting" : "WATCH ONLY";
    }

    private String captainJson() {
        CaptainPilot p = pilot;
        if (p == null) return "{\"mode\":\"off\",\"error\":\"" + esc(captainError) + "\"}";
        String j = p.json();
        return j.substring(0, j.length() - 1) + String.format(Locale.US,
                ",\"control\":\"%s\",\"driving\":%b,\"note\":\"%s\"}",
                captainDriving ? "full_driving" : captainFull ? "full_waiting" : "watch_only", captainDriving, esc(captainNote));
    }

    // ------------------------------------------------------------------ camera + status over HTTP (8080)
    private void httpServerLoop() {
        try (ServerSocket ss = new ServerSocket()) {
            ss.setReuseAddress(true);
            ss.bind(new InetSocketAddress(HTTP_PORT));
            httpServer = ss;
            while (running) {
                Socket s = ss.accept();
                Thread t = new Thread(() -> serveHttp(s), "http");
                t.setDaemon(true);
                t.start();
            }
        } catch (IOException e) {
            SystemClock.sleep(1000);
        }
    }

    private final java.util.concurrent.atomic.AtomicInteger viewers = new java.util.concurrent.atomic.AtomicInteger();

    private void serveHttp(Socket s) {
        try (Socket sock = s) {
            sock.setSoTimeout(5000);
            sock.setTcpNoDelay(true);
            BufferedReader r = new BufferedReader(new InputStreamReader(sock.getInputStream(), StandardCharsets.US_ASCII));
            String line = r.readLine();
            if (line == null) return;
            String method = line.split(" ")[0];
            String path = line.split(" ").length > 1 ? line.split(" ")[1] : "/";
            int contentLength = 0;
            while ((line = r.readLine()) != null && !line.isEmpty()) {
                if (line.toLowerCase(Locale.US).startsWith("content-length:")) {
                    try { contentLength = Integer.parseInt(line.substring(15).trim()); } catch (NumberFormatException ignored) { }
                }
            }
            OutputStream os = sock.getOutputStream();
            if (method.equals("POST") && path.startsWith("/captain/world")) {
                if (contentLength <= 0 || contentLength > 256 * 1024) {
                    reply(os, "400 Bad Request", "application/json", "{\"ok\":false,\"error\":\"need a JSON body under 256 KB\"}".getBytes());
                    return;
                }
                char[] body = new char[contentLength];
                int got = 0;
                while (got < contentLength) {
                    int k = r.read(body, got, contentLength - got);
                    if (k < 0) break;
                    got += k;
                }
                reply(os, "200 OK", "application/json", setWorld(new String(body, 0, got)).getBytes(StandardCharsets.UTF_8));
            } else if (method.equals("POST") && path.startsWith("/captain/stop")) {
                // Over Wi-Fi the captain can only be STOPPED (back to watch only + HOLD), never given the boat.
                if (captainFull || captainDriving) captainStop("stopped from the laptop", true);
                reply(os, "200 OK", "application/json", captainJson().getBytes(StandardCharsets.UTF_8));
            } else if (path.startsWith("/captain.json")) {
                reply(os, "200 OK", "application/json", captainJson().getBytes(StandardCharsets.UTF_8));
            } else if (path.startsWith("/video")) {
                streamVideo(sock, os);
            } else if (path.startsWith("/shot.jpg")) {
                byte[] f = camera == null ? null : camera.next(-1, 3000, new long[1]);
                if (f == null) {
                    reply(os, "503 Service Unavailable", "text/plain", "no camera frame".getBytes());
                } else {
                    reply(os, "200 OK", "image/jpeg", f);
                }
            } else if (path.equals("/logs") || path.equals("/logs/")) {
                reply(os, "200 OK", "application/json", logsJson().getBytes(StandardCharsets.UTF_8));
            } else if (path.startsWith("/logs/")) {
                File f = log.get(path.substring(6));
                if (f == null) reply(os, "404 Not Found", "text/plain", "no such log".getBytes());
                else sendFile(sock, os, f);
            } else if (path.startsWith("/status.json")) {
                reply(os, "200 OK", "application/json", statusJson().getBytes(StandardCharsets.UTF_8));
            } else {
                String html = "<html><head><meta name=viewport content='width=device-width'></head><body style='font-family:sans-serif'>"
                        + "<h3>VARUNA Boat Link</h3><pre>" + statusText() + "</pre><img src='/video' style='max-width:100%'></body></html>";
                reply(os, "200 OK", "text/html", html.getBytes(StandardCharsets.UTF_8));
            }
        } catch (Exception ignored) {
        }
    }

    private void streamVideo(Socket sock, OutputStream os) throws IOException, InterruptedException {
        if (camera == null) {
            reply(os, "503 Service Unavailable", "text/plain", "camera not allowed on the phone".getBytes());
            return;
        }
        if (viewers.get() >= 4) {
            reply(os, "503 Service Unavailable", "text/plain", "too many viewers".getBytes());
            return;
        }
        viewers.incrementAndGet();
        try {
            sock.setSoTimeout(0);
            os.write(("HTTP/1.0 200 OK\r\nCache-Control: no-cache\r\nConnection: close\r\n"
                    + "Content-Type: multipart/x-mixed-replace; boundary=frame\r\n\r\n").getBytes());
            long[] seq = {0};
            long last = 0;
            while (running) {
                byte[] f = camera.next(last, 5000, seq);
                if (f == null) continue;                // no new frame yet: keep the connection
                last = seq[0];
                os.write(("--frame\r\nContent-Type: image/jpeg\r\nContent-Length: " + f.length + "\r\n\r\n").getBytes());
                os.write(f);
                os.write("\r\n".getBytes());
                os.flush();
            }
        } finally {
            viewers.decrementAndGet();
        }
    }

    private String logsJson() {
        StringBuilder b = new StringBuilder("[");
        List<File> all = new ArrayList<>(java.util.Arrays.asList(log.list()));
        all.addAll(java.util.Arrays.asList(CaptainLog.list(log.dir)));
        for (File f : all) {
            if (b.length() > 1) b.append(',');
            b.append(String.format(Locale.US, "{\"name\":\"%s\",\"bytes\":%d,\"recording\":%b}", f.getName(), f.length(),
                    f.getName().equals(log.fileName)));
        }
        return b.append(']').toString();
    }

    /** A log file (the one being written too: what is on the phone so far). */
    private static void sendFile(Socket sock, OutputStream os, File f) throws IOException {
        sock.setSoTimeout(0);
        long len = f.length();
        os.write(("HTTP/1.0 200 OK\r\nContent-Type: application/octet-stream\r\nContent-Length: " + len
                + "\r\nContent-Disposition: attachment; filename=\"" + f.getName() + "\"\r\nConnection: close\r\n\r\n").getBytes());
        try (java.io.FileInputStream in = new java.io.FileInputStream(f)) {
            byte[] buf = new byte[65536];
            long left = len;
            int n;
            while (left > 0 && (n = in.read(buf, 0, (int) Math.min(buf.length, left))) > 0) {
                os.write(buf, 0, n);
                left -= n;
            }
        }
        os.flush();
    }

    private static void reply(OutputStream os, String status, String type, byte[] body) throws IOException {
        os.write(("HTTP/1.0 " + status + "\r\nContent-Type: " + type + "\r\nContent-Length: " + body.length
                + "\r\nAccess-Control-Allow-Origin: *\r\nConnection: close\r\n\r\n").getBytes());
        os.write(body);
        os.flush();
    }

    // ------------------------------------------------------------------ status
    boolean pixhawkTalking() {
        return usb != null && lastHeartbeat != 0 && SystemClock.elapsedRealtime() - lastHeartbeat < 3000;
    }

    String statusText() {
        StringBuilder b = new StringBuilder();
        b.append("Phone address: ").append(String.join(", ", addresses())).append("\n\n");
        b.append("== ").append(brainName.toUpperCase(Locale.US)).append(" (USB) ==\n");
        if (pixhawkTalking()) {
            b.append("connected - ").append(fcMode).append(fcArmed ? ", ARMED" : ", disarmed");
            if (fcSysStatus == 5 || fcSysStatus == 6) b.append("  ** FAILSAFE / EMERGENCY **");
            b.append(String.format(Locale.US, "\n  speed %s m/s   heading %s   alt %s m",
                    Float.isNaN(fcSpeed) ? "-" : String.format(Locale.US, "%.1f", fcSpeed),
                    fcHeading < 0 ? "-" : fcHeading + "°",
                    Float.isNaN(fcAlt) ? "-" : String.format(Locale.US, "%.1f", fcAlt)));
            b.append("\n  position ").append(Double.isNaN(fcLat) ? "-" :
                    String.format(Locale.US, "%.7f, %.7f", fcLat, fcLng));
            if (fcGpsFix >= 0) b.append("\n  GPS fix ").append(fcGpsFix).append(" (3 = 3D), ").append(fcGpsSats).append(" sats");
            b.append("\n  battery ").append(Float.isNaN(fcBattV) ? "no sensor (no power module)" :
                    String.format(Locale.US, "%.2f V", fcBattV) + (fcBattPct >= 0 ? " " + fcBattPct + "%" : ""));
            synchronized (fcWarnings) {
                for (String w : fcWarnings) b.append("\n  ! ").append(w);
            }
        } else if (usb != null) {
            b.append("USB connected, waiting for MAVLink");
        } else {
            b.append("BOAT BRAIN CONNECTION LOST - ").append(usbState);
        }
        if (!watchdogNote.isEmpty()) b.append("\n  watchdog: ").append(watchdogNote);
        b.append("\n\nLAPTOP: ");
        int n = clients.size();
        if (n == 0) b.append("not connected yet (start the boat on the laptop)");
        else {
            List<String> who = new ArrayList<>();
            for (Client c : clients) who.add(c.who);
            b.append("connected (").append(String.join(", ", who)).append(")");
        }
        b.append("\n\n== PHONE GPS (the boat's position) ==\n").append(gpsState);
        Location f = lastFix;
        if (f != null) {
            long age = (System.currentTimeMillis() - f.getTime()) / 1000;
            b.append(String.format(Locale.US, "\n  %.8f, %.8f  (%d s ago)", f.getLatitude(), f.getLongitude(), age));
            if (age > 5) b.append("\n  PHONE GPS UNAVAILABLE (no new fix)");
        }
        if (satsSeen >= 0) b.append("\n  satellites used ").append(satsUsed).append(" of ").append(satsSeen);
        b.append("\n  sent to the brain: ").append(gpsSent);
        b.append("\n\n== PHONE COMPASS (the boat's heading) ==\n").append(compassText());
        CaptainPilot cp = pilot;
        b.append("\n\n== AI CAPTAIN: ").append(captainModeText()).append(" ==\n");
        b.append(cp == null ? captainError : cp.modelText() + "\n  " + cp.text());
        if (!captainNote.isEmpty()) b.append("\n  ").append(captainNote);
        if (cp != null && !captainError.isEmpty()) b.append("\n  ").append(captainError);
        b.append("\n\nCAMERA: ").append(camera == null ? "not allowed (give camera permission)" :
                camera.state() + String.format(Locale.US, " %s %.0f fps, %d viewer(s)", camera.size(), camera.fps(), viewers.get()));
        b.append(String.format(Locale.US, "\n\nData: %d KB from the brain, %d KB to it", bytesIn / 1024, bytesOut / 1024));
        b.append("\n\nLOG: ").append(log == null ? "-" : log.state());
        return b.toString();
    }

    String compassText() {
        Compass c = compass;
        if (c == null) return "starting";
        if (!c.ok()) return "no reading (" + c.sensorName + ")";
        StringBuilder b = new StringBuilder(String.format(Locale.US, "%.0f° true", c.headingDeg));
        if (c.haveDeclination) b.append(String.format(Locale.US, " (declination %+.1f°)", c.declinationDeg));
        else b.append(" (magnetic - true north once GPS has a fix)");
        b.append("\n  ").append(c.axis());
        if (c.accuracyDeg >= 0) b.append(String.format(Locale.US, ", phone says +/- %.0f°", c.accuracyDeg));
        if (c.needsCalibration()) b.append("\n  CALIBRATE: wave the phone in a figure 8, away from the motors");
        if (c.rateOk()) b.append(String.format(Locale.US, "\n  gyro: turning %+.1f°/s", c.rateDegS));
        b.append(brainR4 ? "\n  sent to the UNO R4 brain 50x a second (heading + gyro)" : "\n  (shown only: a Pixhawk uses its own compass)");
        return b.toString();
    }

    private String statusJson() {
        Location f = lastFix;
        String warns;
        synchronized (fcWarnings) {
            StringBuilder w = new StringBuilder("[");
            for (String s : fcWarnings) w.append(w.length() > 1 ? "," : "").append('"').append(esc(s)).append('"');
            warns = w.append(']').toString();
        }
        return String.format(Locale.US,
                "{\"pixhawk\":%b,\"brain\":\"%s\",\"compass_deg\":%s,\"compass_calibrate\":%b,\"usb\":\"%s\",\"mode\":\"%s\",\"armed\":%b,\"laptops\":%d,"
                        + "\"gps\":\"%s\",\"lat\":%s,\"lng\":%s,\"accuracy_m\":%s,\"sats_used\":%d,\"gps_sent\":%d,"
                        + "\"fix_age_s\":%s,"
                        + "\"fc_speed\":%s,\"fc_heading\":%s,\"fc_alt\":%s,\"fc_lat\":%s,\"fc_lng\":%s,"
                        + "\"fc_gps_fix\":%d,\"fc_sats\":%d,\"fc_batt_v\":%s,\"fc_sys_status\":%d,\"fc_warnings\":%s,"
                        + "\"watchdog\":\"%s\","
                        + "\"camera\":\"%s\",\"camera_fps\":%.1f,\"camera_size\":\"%s\",\"captain\":%s}",
                pixhawkTalking(), usb == null ? "none" : brainR4 ? "uno_r4" : "pixhawk",
                compass != null && compass.ok() ? String.format(Locale.US, "%.1f", compass.headingDeg) : "null",
                compass != null && compass.needsCalibration(), esc(usbState), fcMode, fcArmed, clients.size(), esc(gpsState),
                f == null ? "null" : String.valueOf(f.getLatitude()), f == null ? "null" : String.valueOf(f.getLongitude()),
                f == null || !f.hasAccuracy() ? "null" : String.valueOf(f.getAccuracy()), satsUsed, gpsSent,
                f == null ? "null" : String.format(Locale.US, "%.1f", (System.currentTimeMillis() - f.getTime()) / 1000.0),
                num(fcSpeed), fcHeading < 0 ? "null" : String.valueOf(fcHeading), num(fcAlt),
                Double.isNaN(fcLat) ? "null" : String.valueOf(fcLat), Double.isNaN(fcLng) ? "null" : String.valueOf(fcLng),
                fcGpsFix, fcGpsSats, num(fcBattV), fcSysStatus, warns, esc(watchdogNote),
                camera == null ? "off" : esc(camera.state()), camera == null ? 0.0 : camera.fps(),
                camera == null ? "-" : camera.size(), captainJson());
    }

    private static String num(float v) {
        return Float.isNaN(v) || Float.isInfinite(v) ? "null" : String.format(Locale.US, "%.2f", v);
    }

    private static String esc(String s) {
        return s.replace("\\", "\\\\").replace("\"", "'");
    }

    static List<String> addresses() {
        List<String> out = new ArrayList<>();
        try {
            for (NetworkInterface ni : Collections.list(NetworkInterface.getNetworkInterfaces())) {
                if (!ni.isUp() || ni.isLoopback()) continue;
                for (InetAddress a : Collections.list(ni.getInetAddresses())) {
                    if (a instanceof Inet4Address) out.add(a.getHostAddress() + " (" + ni.getName() + ")");
                }
            }
        } catch (Exception ignored) {
        }
        if (out.isEmpty()) out.add("no network - join the laptop's hotspot");
        return out;
    }

    private static void closeQuietly(java.io.Closeable c) {
        try {
            if (c != null) c.close();
        } catch (Exception ignored) {
        }
    }
}
