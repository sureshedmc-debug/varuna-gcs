package ai.varuna.boatlink;

import android.content.Context;
import android.hardware.GeomagneticField;
import android.hardware.Sensor;
import android.hardware.SensorEvent;
import android.hardware.SensorEventListener;
import android.hardware.SensorManager;
import android.os.Handler;
import android.os.HandlerThread;
import android.os.SystemClock;

/**
 * The phone's compass as the boat's heading, for the UNO R4 boat brain (which has
 * no compass of its own). Rotation-vector sensor (gyro + accelerometer +
 * magnetometer fused by the phone) at 100 Hz, so it is smooth and does not swing
 * when the boat rolls - and the gyro's turn rate about the vertical, which the
 * brain's heading loop steers with (like a drone's rate loop: no waiting for the
 * heading to change, no lag).
 *
 * Which way is "forward": the phone sits on the boat as its camera, upright,
 * back camera looking over the bow - then forward is the camera's direction. If
 * the phone lies flat instead, forward is the top edge of the phone. Chosen from
 * how the phone is held, with a margin so it never flips back and forth.
 *
 * True north (GPS courses and map bearings are true): magnetic + the local
 * declination from the phone's own world magnetic model, once there is a fix.
 * Whatever mounting error is left, the brain learns from the GPS course.
 */
final class Compass implements SensorEventListener {
    private final SensorManager sm;
    private HandlerThread thread;
    private Sensor sensor, gyro;
    private final float[] r = new float[9];
    private double sx, sy;                       // smoothed direction (unit vector)
    private boolean flat;                        // phone lying flat: forward = top edge

    volatile float headingDeg = -1;              // true north, 0..360; -1 = none yet
    volatile float rateDegS;                     // turn rate, deg/s, + = turning right (clockwise)
    volatile long rateTMs;                       // elapsedRealtime of the last gyro reading
    private double rate;                         // lightly filtered gyro rate
    private boolean haveR;                       // r holds a rotation matrix
    volatile long tMs;                           // elapsedRealtime of the last reading
    volatile int status = -1;                    // SensorManager.SENSOR_STATUS_*
    volatile float accuracyDeg = -1;             // the phone's own estimate, -1 = unknown
    volatile float declinationDeg;
    volatile boolean haveDeclination;
    volatile String sensorName = "none";
    private long declAt;

    Compass(Context c) {
        sm = (SensorManager) c.getSystemService(Context.SENSOR_SERVICE);
    }

    void start() {
        if (sm == null) return;
        sensor = sm.getDefaultSensor(Sensor.TYPE_ROTATION_VECTOR);
        if (sensor == null) sensor = sm.getDefaultSensor(Sensor.TYPE_GEOMAGNETIC_ROTATION_VECTOR);
        if (sensor == null) {
            sensorName = "this phone has no compass";
            return;
        }
        sensorName = sensor.getName();
        thread = new HandlerThread("compass");
        thread.start();
        Handler h = new Handler(thread.getLooper());
        sm.registerListener(this, sensor, 10000, h);                    // 100 Hz
        gyro = sm.getDefaultSensor(Sensor.TYPE_GYROSCOPE);
        if (gyro != null) sm.registerListener(this, gyro, 10000, h);    // 100 Hz
    }

    void stop() {
        if (sm != null) sm.unregisterListener(this);
        if (thread != null) thread.quitSafely();
    }

    /** The heading is fresh (a reading within the last second). */
    boolean ok() {
        return headingDeg >= 0 && SystemClock.elapsedRealtime() - tMs < 1000;
    }

    /** The gyro's turn rate is fresh (and there is a rotation to put it in world terms). */
    boolean rateOk() {
        return gyro != null && haveR && SystemClock.elapsedRealtime() - rateTMs < 300;
    }

    /** The phone says its magnetometer needs a figure-8 calibration. */
    boolean needsCalibration() {
        return status == SensorManager.SENSOR_STATUS_UNRELIABLE || status == SensorManager.SENSOR_STATUS_ACCURACY_LOW;
    }

    String axis() {
        return flat ? "phone flat, top edge = bow" : "camera looks over the bow";
    }

    /** Local magnetic declination, refreshed once a minute from the GPS position. */
    void setPosition(double lat, double lon, double altM, long timeMs) {
        long now = SystemClock.elapsedRealtime();
        if (haveDeclination && now - declAt < 60000) return;
        declAt = now;
        declinationDeg = new GeomagneticField((float) lat, (float) lon, (float) altM, timeMs).getDeclination();
        haveDeclination = true;
    }

    @Override
    public void onSensorChanged(SensorEvent e) {
        if (e.sensor.getType() == Sensor.TYPE_GYROSCOPE) {
            if (!haveR) return;
            // Phone-frame rad/s -> the world's vertical axis (third row of r = Up).
            // Counter-clockwise about Up is a LEFT turn, so the sign flips.
            double up = r[6] * e.values[0] + r[7] * e.values[1] + r[8] * e.values[2];
            double d = -Math.toDegrees(up);
            long now = SystemClock.elapsedRealtime();
            rate = now - rateTMs > 300 ? d : rate + 0.5 * (d - rate);    // ~10 ms of smoothing
            rateDegS = (float) rate;
            rateTMs = now;
            return;
        }
        SensorManager.getRotationMatrixFromVector(r, e.values);
        haveR = true;
        // Rows of r: world East, North, Up; columns: phone x (right), y (top), z (out of the screen).
        // Up-component of the camera direction (-z) is -r[8].
        double camUp = Math.abs(r[8]);
        if (flat && camUp < 0.70) flat = false;
        else if (!flat && camUp > 0.80) flat = true;
        double east, north;
        if (flat) {                              // top edge of the phone
            east = r[1];
            north = r[4];
        } else {                                 // where the back camera looks
            east = -r[2];
            north = -r[5];
        }
        double len = Math.hypot(east, north);
        if (len < 1e-3) return;
        double h = Math.atan2(east, north) + Math.toRadians(haveDeclination ? declinationDeg : 0);
        double hx = Math.sin(h), hy = Math.cos(h);
        if (headingDeg < 0 || SystemClock.elapsedRealtime() - tMs > 1000) {
            sx = hx;
            sy = hy;
        } else {                                 // very light smoothing at 100 Hz (~10 ms)
            sx += 0.5 * (hx - sx);
            sy += 0.5 * (hy - sy);
        }
        double d = Math.toDegrees(Math.atan2(sx, sy));
        if (d < 0) d += 360;
        headingDeg = (float) d;
        if (e.values.length > 4 && e.values[4] >= 0) accuracyDeg = (float) Math.toDegrees(e.values[4]);
        tMs = SystemClock.elapsedRealtime();
    }

    @Override
    public void onAccuracyChanged(Sensor s, int accuracy) {
        status = accuracy;
    }
}
