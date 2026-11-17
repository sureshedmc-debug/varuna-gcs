package ai.varuna.cam;

import android.Manifest;
import android.content.Context;
import android.content.pm.PackageManager;
import android.hardware.GeomagneticField;
import android.hardware.Sensor;
import android.hardware.SensorEvent;
import android.hardware.SensorEventListener;
import android.hardware.SensorManager;
import android.location.GnssStatus;
import android.location.Location;
import android.location.LocationListener;
import android.location.LocationManager;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.HandlerThread;
import android.os.SystemClock;
import android.util.Log;

import java.util.Locale;
import java.util.concurrent.CopyOnWriteArrayList;

/**
 * The phone on the drone as its position and attitude source, for the VARUNA
 * backend when the drone sends no telemetry of its own.
 *
 *  - Position: the phone's GPS (GNSS) at its fastest rate, with its accuracy
 *    and satellite count; the network position only until GPS has a fix.
 *  - Height above the take-off point: from the barometer if the phone has one
 *    (steady to about half a metre), else GPS altitude (several metres of
 *    noise). The take-off point is the first good fix, or where "Set take-off
 *    point here" was last pressed.
 *  - Attitude: the camera's own heading, pitch and roll from the rotation
 *    sensor, as a straight-down camera on a drone would have them: heading =
 *    the way the top of the picture faces (true north), pitch / roll = how far
 *    the camera is tipped from looking straight down. So the app places what it
 *    sees on the water without knowing how the phone is mounted.
 *
 * Every sample carries the phone's clock (ms since 1970), the same clock as the
 * capture time stamped on each video frame, so the backend gives each frame the
 * pose it was taken at without matching clocks.
 */
final class PhoneLocation implements LocationListener, SensorEventListener {
    private static final String TAG = "VarunaCam";
    private static final long STALE_FIX_MS = 5000;
    private static final float HOME_ACCURACY_M = 12f;   // a fix this good becomes the take-off point

    interface Sink {
        void sample(String json);
    }

    private final Context ctx;
    private final LocationManager lm;
    private final SensorManager sm;
    private final HandlerThread thread = new HandlerThread("location");
    private Handler handler;
    private final CopyOnWriteArrayList<Sink> sinks = new CopyOnWriteArrayList<>();
    private GnssStatus.Callback gnssCallback;

    // Position (guarded by this)
    private Location fix;
    private long fixAtMs;                  // phone clock when it arrived
    private boolean gpsFix;
    private int satsUsed;
    private int satsSeen;
    private double homeLat = Double.NaN;
    private double homeLng = Double.NaN;
    private double homeAlt = Double.NaN;   // GPS altitude at home
    private float homePressure = Float.NaN;
    private float pressure = Float.NaN;    // hPa, smoothed
    private float declination;

    // Attitude
    private final float[] rot = new float[9];
    private boolean hasRot;
    private boolean manualRot;                 // compass + accelerometer (no gyroscope)
    private final float[] grav = new float[3];
    private final float[] mag = new float[3];
    private boolean hasGrav;
    private boolean hasMag;
    private volatile int sensorOrientation = 90;
    private volatile float fovH = Float.NaN;
    private float heading;
    private float pitch;
    private float roll;
    private long lastSentMs;
    private volatile boolean running;
    private volatile boolean gpsRequested;
    private volatile String problem = "";

    PhoneLocation(Context ctx) {
        this.ctx = ctx.getApplicationContext();
        lm = (LocationManager) this.ctx.getSystemService(Context.LOCATION_SERVICE);
        sm = (SensorManager) this.ctx.getSystemService(Context.SENSOR_SERVICE);
    }

    static boolean allowed(Context c) {
        return c.checkSelfPermission(Manifest.permission.ACCESS_FINE_LOCATION) == PackageManager.PERMISSION_GRANTED;
    }

    /** The camera's mounting in the phone and its field of view, once the camera is open. */
    void setCamera(int orientation, float horizontalFovDeg) {
        sensorOrientation = ((orientation % 360) + 360) % 360;
        fovH = horizontalFovDeg;
    }

    void addSink(Sink s) {
        sinks.add(s);
    }

    void removeSink(Sink s) {
        sinks.remove(s);
    }

    void start() {
        if (running) return;
        running = true;
        thread.start();
        handler = new Handler(thread.getLooper());
        // Gyro-fused rotation if the phone has a gyroscope; without one (budget
        // phones) the compass and accelerometer, smoothed against vibration.
        Sensor rv = sm.getDefaultSensor(Sensor.TYPE_ROTATION_VECTOR);
        if (rv == null) rv = sm.getDefaultSensor(Sensor.TYPE_GEOMAGNETIC_ROTATION_VECTOR);
        Sensor acc = sm.getDefaultSensor(Sensor.TYPE_ACCELEROMETER);
        Sensor magS = sm.getDefaultSensor(Sensor.TYPE_MAGNETIC_FIELD);
        if (rv != null) {
            sm.registerListener(this, rv, SensorManager.SENSOR_DELAY_GAME, handler);
        } else if (acc != null && magS != null) {
            manualRot = true;
            sm.registerListener(this, acc, SensorManager.SENSOR_DELAY_GAME, handler);
            sm.registerListener(this, magS, SensorManager.SENSOR_DELAY_GAME, handler);
        } else {
            problem = "no rotation sensor: no heading or tilt";
        }
        Sensor baro = sm.getDefaultSensor(Sensor.TYPE_PRESSURE);
        if (baro != null) sm.registerListener(this, baro, SensorManager.SENSOR_DELAY_GAME, handler);
        requestGps();
    }

    /** True once the GPS is asked for fixes (Location was allowed). */
    boolean gpsRequested() {
        return gpsRequested;
    }

    /** Starts the GPS: at start, or once Location is allowed after the start. */
    synchronized void requestGps() {
        if (!running || gpsRequested) return;
        if (!allowed(ctx)) {
            problem = "location not allowed: open VARUNA Cam and allow Location (precise)";
            return;
        }
        problem = "";
        gpsRequested = true;
        try {
            if (lm.isProviderEnabled(LocationManager.GPS_PROVIDER)) {
                lm.requestLocationUpdates(LocationManager.GPS_PROVIDER, 0, 0f, this, thread.getLooper());
            } else {
                problem = "Location (GPS) is off in the phone's settings";
            }
            if (lm.isProviderEnabled(LocationManager.NETWORK_PROVIDER)) {
                lm.requestLocationUpdates(LocationManager.NETWORK_PROVIDER, 1000, 0f, this, thread.getLooper());
            }
            gnssCallback = new GnssStatus.Callback() {
                @Override
                public void onSatelliteStatusChanged(GnssStatus status) {
                    int used = 0;
                    for (int i = 0; i < status.getSatelliteCount(); i++) {
                        if (status.usedInFix(i)) used++;
                    }
                    synchronized (PhoneLocation.this) {
                        satsUsed = used;
                        satsSeen = status.getSatelliteCount();
                    }
                }
            };
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
                lm.registerGnssStatusCallback(new HandlerExecutor(handler), gnssCallback);
            } else {
                registerGnssLegacy();
            }
        } catch (SecurityException | IllegalArgumentException e) {
            problem = "can't read the GPS: " + e.getMessage();
            gpsRequested = false;
            Log.w(TAG, problem);
        }
    }

    @SuppressWarnings("deprecation")   // the only form before Android 11
    private void registerGnssLegacy() {
        lm.registerGnssStatusCallback(gnssCallback, handler);
    }

    void stop() {
        if (!running) return;
        running = false;
        try {
            lm.removeUpdates(this);
            if (gnssCallback != null) lm.unregisterGnssStatusCallback(gnssCallback);
        } catch (SecurityException ignored) {
        }
        sm.unregisterListener(this);
        thread.quitSafely();
    }

    /** Makes the current position the take-off point (height 0). */
    synchronized void setHome() {
        if (fix == null) return;
        homeLat = fix.getLatitude();
        homeLng = fix.getLongitude();
        homeAlt = fix.hasAltitude() ? fix.getAltitude() : Double.NaN;
        homePressure = pressure;
    }

    // ---- sensors -------------------------------------------------------------

    @Override
    public void onLocationChanged(Location loc) {
        boolean isGps = LocationManager.GPS_PROVIDER.equals(loc.getProvider());
        synchronized (this) {
            // The network position only stands in until the GPS has a fix.
            if (!isGps && gpsFix && SystemClock.elapsedRealtime() - fixAtMs < STALE_FIX_MS) return;
            if (isGps) gpsFix = true;
            fix = loc;
            // When the position was measured, not when it reached the app: the
            // backend lines it up with the video frames by this.
            long measured = loc.getElapsedRealtimeNanos() / 1_000_000L;
            long now = SystemClock.elapsedRealtime();
            fixAtMs = measured > 0 && measured <= now && now - measured < 3000 ? measured : now;
            if (Double.isNaN(homeLat) && isGps && loc.hasAccuracy() && loc.getAccuracy() <= HOME_ACCURACY_M) {
                setHome();
            }
            GeomagneticField gf = new GeomagneticField((float) loc.getLatitude(), (float) loc.getLongitude(),
                    loc.hasAltitude() ? (float) loc.getAltitude() : 0f, System.currentTimeMillis());
            declination = gf.getDeclination();
        }
        if (isGps && problem.startsWith("Location")) problem = "";
        // A new fix goes out at once, not with the next attitude sample.
        long now = System.currentTimeMillis();
        lastSentMs = now;
        String json = sampleJson(now);
        for (Sink s : sinks) s.sample(json);
    }

    @Override
    public void onProviderEnabled(String provider) {
        if (LocationManager.GPS_PROVIDER.equals(provider) && running && allowed(ctx)) {
            try {
                lm.requestLocationUpdates(LocationManager.GPS_PROVIDER, 0, 0f, this, thread.getLooper());
                problem = "";
            } catch (SecurityException ignored) {
            }
        }
    }

    @Override
    public void onProviderDisabled(String provider) {
        if (LocationManager.GPS_PROVIDER.equals(provider)) problem = "Location (GPS) is off in the phone's settings";
    }

    @Override
    @SuppressWarnings("deprecation")   // still called on Android 8-9
    public void onStatusChanged(String provider, int status, Bundle extras) {
    }

    @Override
    public void onSensorChanged(SensorEvent e) {
        if (e.sensor.getType() == Sensor.TYPE_PRESSURE) {
            float p = e.values[0];
            synchronized (this) {
                pressure = Float.isNaN(pressure) ? p : pressure + 0.1f * (p - pressure);   // ~0.2 s smoothing
                if (Float.isNaN(homePressure) && !Double.isNaN(homeLat)) homePressure = pressure;
            }
            return;
        }
        int type = e.sensor.getType();
        if (type == Sensor.TYPE_MAGNETIC_FIELD) {
            lowPass(mag, e.values, hasMag ? 0.1f : 1f);
            hasMag = true;
            return;                                  // worked out with the next accelerometer sample
        }
        if (type == Sensor.TYPE_ACCELEROMETER) {
            lowPass(grav, e.values, hasGrav ? 0.08f : 1f);
            hasGrav = true;
            if (!hasMag || !SensorManager.getRotationMatrix(rot, null, grav, mag)) return;
        } else {
            SensorManager.getRotationMatrixFromVector(rot, e.values);
        }
        hasRot = true;
        attitude();
        long now = System.currentTimeMillis();
        if (now - lastSentMs >= 50) {          // 20 samples a second
            lastSentMs = now;
            String json = sampleJson(now);
            for (Sink s : sinks) s.sample(json);
        }
    }

    @Override
    public void onAccuracyChanged(Sensor sensor, int accuracy) {
    }

    private static void lowPass(float[] out, float[] in, float a) {
        for (int i = 0; i < 3; i++) out[i] += a * (in[i] - out[i]);
    }

    /**
     * The camera as a straight-down drone camera: body x = the top of the picture,
     * y = its right, z = where the lens looks. Heading / pitch / roll of that body
     * (north-east-down), as the app's ground projection expects them.
     */
    private void attitude() {
        // Picture top and right in phone axes (x right, y top, z out of the screen);
        // the back camera looks along -z.
        float ux, uy, rx, ry;
        switch (sensorOrientation) {
            case 0: ux = 0; uy = 1; rx = 1; ry = 0; break;
            case 180: ux = 0; uy = -1; rx = -1; ry = 0; break;
            case 270: ux = -1; uy = 0; rx = 0; ry = 1; break;
            default: ux = 1; uy = 0; rx = 0; ry = -1; break;     // 90, most phones
        }
        // rot: phone axes -> world east, north, up.
        float fe = rot[0] * ux + rot[1] * uy, fn = rot[3] * ux + rot[4] * uy, fu = rot[6] * ux + rot[7] * uy;
        float ru = rot[6] * rx + rot[7] * ry;
        float du = -rot[8];                       // lens axis (-z) up component
        // North-east-down: down = -up.
        float fd = -fu, rd = -ru, dd = -du;
        double h = Math.toDegrees(Math.atan2(fe, fn)) + declination;
        heading = (float) ((h % 360 + 360) % 360);
        pitch = (float) Math.toDegrees(Math.asin(Math.max(-1f, Math.min(1f, -fd))));
        roll = (float) Math.toDegrees(Math.atan2(rd, dd));
    }

    // ---- output --------------------------------------------------------------

    private synchronized String sampleJson(long now) {
        StringBuilder sb = new StringBuilder(256);
        sb.append("{\"t\":").append(now);
        Location f = fix;
        long age = f == null ? -1 : SystemClock.elapsedRealtime() - fixAtMs;
        if (f != null && age < STALE_FIX_MS) {
            sb.append(String.format(Locale.US, ",\"lat\":%.7f,\"lng\":%.7f", f.getLatitude(), f.getLongitude()));
            if (f.hasAccuracy()) sb.append(String.format(Locale.US, ",\"acc\":%.1f", f.getAccuracy()));
            if (f.hasAltitude()) sb.append(String.format(Locale.US, ",\"alt_msl\":%.1f", f.getAltitude()));
            if (f.hasSpeed()) sb.append(String.format(Locale.US, ",\"spd\":%.2f", f.getSpeed()));
            if (f.hasBearing() && f.hasSpeed() && f.getSpeed() > 1f) {
                sb.append(String.format(Locale.US, ",\"crs\":%.1f", f.getBearing()));
            }
            sb.append(",\"fix\":\"").append(LocationManager.GPS_PROVIDER.equals(f.getProvider()) ? "gps" : "network")
                    .append('"').append(",\"fix_age\":").append(age);
            double rel = relAlt(f);
            if (!Double.isNaN(rel)) {
                sb.append(String.format(Locale.US, ",\"rel_alt\":%.2f,\"alt_src\":\"%s\"", rel,
                        !Float.isNaN(homePressure) && !Float.isNaN(pressure) ? "baro" : "gps"));
            }
        }
        sb.append(",\"sats\":").append(satsUsed).append(",\"sats_seen\":").append(satsSeen);
        if (!Double.isNaN(homeLat)) {
            sb.append(String.format(Locale.US, ",\"home_lat\":%.7f,\"home_lng\":%.7f", homeLat, homeLng));
        }
        if (hasRot) {
            sb.append(String.format(Locale.US, ",\"hdg\":%.1f,\"pitch\":%.1f,\"roll\":%.1f,\"att_src\":\"%s\"",
                    heading, pitch, roll, manualRot ? "compass" : "gyro"));
        }
        if (!Float.isNaN(fovH)) sb.append(String.format(Locale.US, ",\"fov\":%.1f", fovH));
        if (!Float.isNaN(pressure)) sb.append(String.format(Locale.US, ",\"hpa\":%.2f", pressure));
        if (!problem.isEmpty()) sb.append(",\"problem\":\"").append(problem.replace("\"", "'")).append('"');
        sb.append('}');
        return sb.toString();
    }

    /** Height above the take-off point: barometer if there is one, else GPS. */
    private double relAlt(Location f) {
        if (!Float.isNaN(homePressure) && !Float.isNaN(pressure)) {
            return 44330.0 * (1.0 - Math.pow(pressure / homePressure, 1.0 / 5.255));
        }
        if (!Double.isNaN(homeAlt) && f.hasAltitude()) return f.getAltitude() - homeAlt;
        return Double.NaN;
    }

    /** The latest sample, for /location. */
    String latestJson() {
        return sampleJson(System.currentTimeMillis());
    }

    /** One line for the status screen. */
    synchronized String statusLine() {
        if (!problem.isEmpty() && fix == null) return "GPS: " + problem;
        Location f = fix;
        if (f == null || SystemClock.elapsedRealtime() - fixAtMs > STALE_FIX_MS) {
            return String.format(Locale.US, "GPS: waiting for a fix (%d satellites seen; go under open sky)", satsSeen);
        }
        String src = LocationManager.GPS_PROVIDER.equals(f.getProvider()) ? "GPS" : "network (no GPS fix yet)";
        String alt = "";
        double rel = relAlt(f);
        if (!Double.isNaN(rel)) {
            alt = String.format(Locale.US, ", %.1f m up (%s)", rel,
                    !Float.isNaN(homePressure) && !Float.isNaN(pressure) ? "barometer" : "GPS height");
        }
        return String.format(Locale.US, "%s: %.6f, %.6f ±%.0f m, %d satellites%s\nCamera facing %.0f°, tilt %.0f°/%.0f°",
                src, f.getLatitude(), f.getLongitude(), f.hasAccuracy() ? f.getAccuracy() : 0f, satsUsed, alt,
                heading, pitch, roll);
    }

    /** Runs callbacks on the location thread. */
    private static final class HandlerExecutor implements java.util.concurrent.Executor {
        private final Handler h;

        HandlerExecutor(Handler h) {
            this.h = h;
        }

        @Override
        public void execute(Runnable r) {
            h.post(r);
        }
    }
}
