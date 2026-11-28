package ai.varuna.boatlink;

import java.io.BufferedWriter;
import java.io.File;
import java.io.FileWriter;
import java.io.IOException;
import java.text.SimpleDateFormat;
import java.util.Arrays;
import java.util.Date;
import java.util.Locale;

/**
 * captain_YYYYMMDD_HHMMSS.csv next to the .tlog files: 5 lines a second of what the
 * captain saw and what it would do (or did, in full control), to compare with how
 * the boat was really driven. Keeps the newest KEEP files.
 */
final class CaptainLog {
    static final int KEEP = 10;
    private final File dir;
    private BufferedWriter w;
    private long lines;

    CaptainLog(File dir) {
        this.dir = dir;
    }

    static File[] list(File dir) {
        File[] fs = dir.listFiles((d, n) -> n.startsWith("captain_") && n.endsWith(".csv"));
        if (fs == null) return new File[0];
        Arrays.sort(fs, (a, b) -> a.getName().compareTo(b.getName()));
        return fs;
    }

    void write(CaptainPilot p, CaptainPilot.Sensors s, String mode, int fcThrottlePct, boolean driving) {
        if (!p.ready) return;                                    // nothing useful to log yet
        try {
            if (w == null) {
                File[] old = list(dir);
                for (int i = 0; i < old.length - (KEEP - 1); i++) //noinspection ResultOfMethodCallIgnored
                    old[i].delete();
                String name = "captain_" + new SimpleDateFormat("yyyyMMdd_HHmmss", Locale.US).format(new Date()) + ".csv";
                w = new BufferedWriter(new FileWriter(new File(dir, name)));
                w.write("time_ms,lat,lng,heading_deg,turn_deg_s,speed_m_s,course_deg,battery_pct,brain_mode,brain_throttle_pct,"
                        + "captain_driving,captain_throttle,captain_steer,captain_ramp,plastic_known,nearest_plastic_m,home_m,goal\n");
            }
            w.write(String.format(Locale.US, "%d,%.7f,%.7f,%.1f,%.1f,%.2f,%.1f,%d,%s,%d,%d,%.3f,%.3f,%d,%d,%s,%.1f,%s\n",
                    System.currentTimeMillis(), s.lat, s.lng, s.headingDeg, s.rateDegS, s.speed, s.courseDeg, s.battPct, mode,
                    fcThrottlePct, driving ? 1 : 0, p.outThr, p.outSteer, p.outRamp, p.seenBottles,
                    Float.isNaN(p.nearestBottle) ? "" : String.format(Locale.US, "%.2f", p.nearestBottle), p.distHome,
                    p.goal.replace(',', ' ')));
            if (++lines % 25 == 0) w.flush();
        } catch (IOException e) {
            close();
        }
    }

    void close() {
        try {
            if (w != null) w.close();
        } catch (IOException ignored) {
        }
        w = null;
    }
}
