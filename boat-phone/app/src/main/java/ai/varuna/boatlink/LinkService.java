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
 *  - Pixhawk on USB (OTG)  <->  TCP port 5760 on Wi-Fi (the laptop's boat program
 *    connects here, exactly as it did to the ESP32). Up to 4 connections.
 *  - The phone's GPS -> the Pixhawk as GPS_INPUT (Pixhawk GPS1_TYPE 14 = MAVLink).
 *  - The back camera as MJPEG on http://<phone>:8080/video (the boat program's camera).
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

    // ---- status (read by the screen and /status.json)
    volatile String usbState = "looking for the Pixhawk";
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
            thread("usb-read", this::usbLoop);
            thread("usb-write", this::usbWriter);
            thread("mav-server", this::mavServerLoop);
            thread("http-server", this::httpServerLoop);
            thread("watchdog", this::watchdogLoop);
            startGps();
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
        running = false;
        closeQuietly(mavServer);
        closeQuietly(httpServer);
        for (Client c : clients) c.close();
        UsbSerial u = usb;
        if (u != null) u.close();
        if (camera != null) camera.stop();
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
                .setContentText("Pixhawk, GPS and camera to the laptop")
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

    // ------------------------------------------------------------------ Pixhawk on USB
    private UsbDevice findDevice() {
        for (UsbDevice d : usbManager.getDeviceList().values()) {
            if (UsbSerial.isSerial(d)) return d;
        }
        return null;
    }

    private void usbLoop() {
        UsbDevice d = findDevice();
        if (d == null) {
            usbState = "Pixhawk not plugged in (USB OTG)";
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
        usb = u;
        usbState = "Pixhawk on USB";
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
            usbState = "Pixhawk unplugged - waiting for it";
        } finally {
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
        // GPS time (GPS_INPUT wants GPS week + ms of week; GPS = UTC + 18 s leap seconds).
        long gpsMs = loc.getTime() - 315964800000L + 18000L;
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
        byte[] payload = Mav.gpsInputPayload(loc.getTime() * 1000L, 0, ignore, weekMs, week, fix,
                (int) Math.round(loc.getLatitude() * 1e7), (int) Math.round(loc.getLongitude() * 1e7),
                (float) alt, hdop, hdop * 1.5f, vn, ve, 0f, speedAcc, acc, 0f, Math.min(sats, 255), 0);
        sendToPixhawk(Mav.frame2(gpsSeq++ & 0xff, GPS_SYS, GPS_COMP, Mav.GPS_INPUT_ID, Mav.GPS_INPUT_CRC_EXTRA, payload));
        if (usb != null) {
            gpsSent++;
            lastGpsSent = SystemClock.elapsedRealtime();
        }
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
            String path = line.split(" ").length > 1 ? line.split(" ")[1] : "/";
            while ((line = r.readLine()) != null && !line.isEmpty()) { /* headers: not needed */ }
            OutputStream os = sock.getOutputStream();
            if (path.startsWith("/video")) {
                streamVideo(sock, os);
            } else if (path.startsWith("/shot.jpg")) {
                byte[] f = camera == null ? null : camera.next(-1, 3000, new long[1]);
                if (f == null) {
                    reply(os, "503 Service Unavailable", "text/plain", "no camera frame".getBytes());
                } else {
                    reply(os, "200 OK", "image/jpeg", f);
                }
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
        b.append("== PIXHAWK TELEMETRY (USB) ==\n");
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
            b.append("PIXHAWK CONNECTION LOST - ").append(usbState);
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
        b.append("\n  sent to the Pixhawk: ").append(gpsSent);
        b.append("\n\nCAMERA: ").append(camera == null ? "not allowed (give camera permission)" :
                camera.state() + String.format(Locale.US, " %s %.0f fps, %d viewer(s)", camera.size(), camera.fps(), viewers.get()));
        b.append(String.format(Locale.US, "\n\nData: %d KB from Pixhawk, %d KB to Pixhawk", bytesIn / 1024, bytesOut / 1024));
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
                "{\"pixhawk\":%b,\"usb\":\"%s\",\"mode\":\"%s\",\"armed\":%b,\"laptops\":%d,"
                        + "\"gps\":\"%s\",\"lat\":%s,\"lng\":%s,\"accuracy_m\":%s,\"sats_used\":%d,\"gps_sent\":%d,"
                        + "\"fix_age_s\":%s,"
                        + "\"fc_speed\":%s,\"fc_heading\":%s,\"fc_alt\":%s,\"fc_lat\":%s,\"fc_lng\":%s,"
                        + "\"fc_gps_fix\":%d,\"fc_sats\":%d,\"fc_batt_v\":%s,\"fc_sys_status\":%d,\"fc_warnings\":%s,"
                        + "\"watchdog\":\"%s\","
                        + "\"camera\":\"%s\",\"camera_fps\":%.1f,\"camera_size\":\"%s\"}",
                pixhawkTalking(), esc(usbState), fcMode, fcArmed, clients.size(), esc(gpsState),
                f == null ? "null" : String.valueOf(f.getLatitude()), f == null ? "null" : String.valueOf(f.getLongitude()),
                f == null || !f.hasAccuracy() ? "null" : String.valueOf(f.getAccuracy()), satsUsed, gpsSent,
                f == null ? "null" : String.format(Locale.US, "%.1f", (System.currentTimeMillis() - f.getTime()) / 1000.0),
                num(fcSpeed), fcHeading < 0 ? "null" : String.valueOf(fcHeading), num(fcAlt),
                Double.isNaN(fcLat) ? "null" : String.valueOf(fcLat), Double.isNaN(fcLng) ? "null" : String.valueOf(fcLng),
                fcGpsFix, fcGpsSats, num(fcBattV), fcSysStatus, warns, esc(watchdogNote),
                camera == null ? "off" : esc(camera.state()), camera == null ? 0.0 : camera.fps(),
                camera == null ? "-" : camera.size());
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
