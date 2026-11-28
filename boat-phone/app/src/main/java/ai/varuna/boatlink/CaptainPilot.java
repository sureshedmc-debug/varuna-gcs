package ai.varuna.boatlink;

import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;
import java.util.Locale;

/**
 * Runs the AI captain on the boat phone in WATCH-ONLY mode: 20 times a second it
 * builds the 63 numbers the captain was trained on (boat-r4/ai/boat_sim.py obs())
 * from what the phone knows, and records what the captain WOULD do.
 *
 * It never sends anything to the boat brain: it has no reference to the USB link.
 * Driving stays with the radio, the laptop and the brain. (Letting the captain
 * drive is a separate, later step, after watching it on the water.)
 *
 * Frame: x = north, y = east (metres from where the captain first had a GPS fix),
 * heading psi from true north, clockwise. Body: x forward, y right. Same as the sim.
 *
 * What the phone does not know by itself comes from the laptop in the "world"
 * (POST /captain/world): bottles and weeds the camera AI saw, the shore, the bin.
 * Without it the captain sees open water and nothing to collect, so it searches.
 */
final class CaptainPilot {
    // must match boat_sim.py
    static final int OBS = 63, K_TARGETS = 4, K_WEEDS = 2, RAMP_CAP = 6, BIN_CAP = 30;
    static final float RAY_MAX = 15f, DT = 0.05f;
    static final double[] RAY_DEG = {0, 30, -30, 65, -65, 110, -110, 180};
    static final double M_PER_DEG = 111320.0;
    static final float SEARCH_RADIUS_M = 6f;    // no waypoints from the laptop: a ring round home
    static final long WORLD_STALE_MS = 60000;   // bottles/weeds older than this are dropped

    /** What the phone's sensors say right now. */
    static final class Sensors {
        boolean headingOk, fixOk;
        float headingDeg, rateDegS, speed, courseDeg;
        boolean hasCourse;
        double lat, lng;
        int battPct = -1;
    }

    /** One thing in the world: by position (lat/lng), or relative to the boat (fwd/right metres). */
    static final class Item {
        double lat = Double.NaN, lng = Double.NaN, fwd = Double.NaN, right = Double.NaN, ageS, radius = 1;
    }

    /** What the laptop tells the captain (all optional). */
    static final class World {
        final List<Item> bottles = new ArrayList<>(), weeds = new ArrayList<>();
        final List<double[]> shore = new ArrayList<>();      // [lat, lng] polygon
        final List<double[]> waypoints = new ArrayList<>();  // [lat, lng]
        double[] home;                                       // [lat, lng]
        int rampLoad = -1, bin = -1;
        float weedLoad = -1;
        boolean goHome;
    }

    private final Captain captain;
    // world in local metres
    private boolean haveOrigin;
    private double lat0, lng0, cosLat0;
    private final List<float[]> bottles = new ArrayList<>();   // [n, e, seenAtS]
    private final List<float[]> weeds = new ArrayList<>();     // [n, e, r]
    private float[][] shore;                                   // [k][2]
    private final List<float[]> wps = new ArrayList<>();
    private float[] home;
    private int wpI, rampLoad, bin;
    private float weedLoad;
    private boolean goHome;
    private long worldAtMs;
    // the captain's own memory, as in training
    private float ramp, prevThr, prevSteer;
    private int prevRampAct = Captain.RAMP_HOLD;
    private final float[] rHist = new float[3], sHist = new float[2];
    private float tS;

    // ---- latest result (read by the screen, /status.json, /captain.json)
    volatile boolean ready;
    volatile String why = "starting";
    volatile float outThr, outSteer, soc = 1f;
    volatile int outRamp = Captain.RAMP_HOLD;
    volatile int seenBottles, seenWeeds;
    volatile boolean shoreKnown, battKnown, homeFlag;
    volatile float distHome = Float.NaN, nearestBottle = Float.NaN;
    volatile long ticks;
    volatile float[] lastObs = new float[OBS];
    volatile String goal = "-";

    CaptainPilot(Captain c) {
        captain = c;
    }

    String modelText() {
        return String.format(Locale.US, "iteration %d, %.0f M sim steps", captain.trainedIterations, captain.trainedSteps / 1e6);
    }

    // ------------------------------------------------------------------ world from the laptop
    synchronized void setWorld(World w, Sensors s, long nowMs) {
        worldAtMs = nowMs;
        if (!haveOrigin && s != null && s.fixOk) setOrigin(s.lat, s.lng);
        float now = tS;
        bottles.clear();
        for (Item it : w.bottles) {
            float[] ne = place(it, s);
            if (ne != null) bottles.add(new float[]{ne[0], ne[1], (float) (now - it.ageS)});
        }
        weeds.clear();
        for (Item it : w.weeds) {
            float[] ne = place(it, s);
            if (ne != null) weeds.add(new float[]{ne[0], ne[1], (float) Math.max(0.2, it.radius)});
        }
        if (haveOrigin && w.shore.size() >= 3) {
            shore = new float[w.shore.size()][];
            for (int i = 0; i < shore.length; i++) shore[i] = ne(w.shore.get(i)[0], w.shore.get(i)[1]);
        }
        if (haveOrigin && !w.waypoints.isEmpty()) {
            wps.clear();
            for (double[] p : w.waypoints) wps.add(ne(p[0], p[1]));
            wpI = 0;
        }
        if (haveOrigin && w.home != null) home = ne(w.home[0], w.home[1]);
        if (w.rampLoad >= 0) rampLoad = Math.min(RAMP_CAP, w.rampLoad);
        if (w.bin >= 0) bin = Math.min(BIN_CAP, w.bin);
        if (w.weedLoad >= 0) weedLoad = Math.min(3f, w.weedLoad);
        goHome = w.goHome;
    }

    private float[] place(Item it, Sensors s) {
        if (!Double.isNaN(it.lat) && !Double.isNaN(it.lng)) return haveOrigin ? ne(it.lat, it.lng) : null;
        if (Double.isNaN(it.fwd) || Double.isNaN(it.right) || !haveOrigin || s == null || !s.fixOk || !s.headingOk) return null;
        float[] me = ne(s.lat, s.lng);
        double psi = Math.toRadians(s.headingDeg), c = Math.cos(psi), sn = Math.sin(psi);
        return new float[]{(float) (me[0] + it.fwd * c - it.right * sn), (float) (me[1] + it.fwd * sn + it.right * c)};
    }

    private void setOrigin(double lat, double lng) {
        haveOrigin = true;
        lat0 = lat;
        lng0 = lng;
        cosLat0 = Math.cos(Math.toRadians(lat0));
        if (home == null) home = new float[]{0, 0};        // where the captain started, until the laptop says
    }

    private float[] ne(double lat, double lng) {
        return new float[]{(float) ((lat - lat0) * M_PER_DEG), (float) ((lng - lng0) * M_PER_DEG * cosLat0)};
    }

    // ------------------------------------------------------------------ 20 Hz
    synchronized void tick(Sensors s, long nowMs) {
        tS += DT;
        ticks++;
        if (!s.headingOk) { ready = false; why = "waiting for the compass"; return; }
        if (!s.fixOk) { ready = false; why = "waiting for GPS"; return; }
        if (!haveOrigin) setOrigin(s.lat, s.lng);
        if (nowMs - worldAtMs > WORLD_STALE_MS) { bottles.clear(); weeds.clear(); }
        if (wps.isEmpty()) {
            for (int k = 0; k < 6; k++) {
                double a = Math.toRadians(60 * k);
                wps.add(new float[]{home[0] + SEARCH_RADIUS_M * (float) Math.cos(a), home[1] + SEARCH_RADIUS_M * (float) Math.sin(a)});
            }
        }
        float[] pos = ne(s.lat, s.lng);
        double psi = Math.toRadians(s.headingDeg);
        // velocity in the body frame (GPS speed along its course; heading when it has none)
        double crs = Math.toRadians(s.hasCourse && s.speed > 0.2f ? s.courseDeg : s.headingDeg);
        double vn = s.speed * Math.cos(crs), ve = s.speed * Math.sin(crs);
        float u = (float) (vn * Math.cos(psi) + ve * Math.sin(psi));
        float v = (float) (-vn * Math.sin(psi) + ve * Math.cos(psi));
        float r = (float) Math.toRadians(s.rateDegS);
        battKnown = s.battPct >= 0;
        soc = battKnown ? Math.max(0f, Math.min(1f, s.battPct / 100f)) : 1f;
        // the next search point: on to the next one within 3 m
        float[] wp = wps.get(wpI % wps.size());
        if (Math.hypot(pos[0] - wp[0], pos[1] - wp[1]) < 3.0) { wpI++; wp = wps.get(wpI % wps.size()); }
        homeFlag = bin >= 0.8f * BIN_CAP || soc < 0.2f || goHome;
        // history, as the sim keeps it (newest first)
        rHist[2] = rHist[1]; rHist[1] = rHist[0]; rHist[0] = r;

        float[] o = new float[OBS];
        o[0] = u; o[1] = v; o[2] = r;
        o[3] = ramp;
        o[4] = rampLoad / (float) RAMP_CAP;
        o[5] = Math.min(weedLoad, 3f) / 3f;
        o[6] = bin / (float) BIN_CAP;
        o[7] = soc;
        o[8] = homeFlag ? 1 : 0;
        o[9] = prevThr;
        o[10] = prevSteer;
        o[11 + prevRampAct] = 1;
        o[14] = rHist[0]; o[15] = rHist[1]; o[16] = rHist[2];
        o[17] = sHist[0]; o[18] = sHist[1];
        // bottles: nearest 4 [x/10, y/10, min(d,30)/10, min(age,60)/30, 1]
        float[][] bb = new float[bottles.size()][];
        for (int i = 0; i < bb.length; i++) {
            float[] p = body(bottles.get(i)[0], bottles.get(i)[1], pos, psi);
            bb[i] = new float[]{p[0], p[1], (float) Math.hypot(p[0], p[1]), tS - bottles.get(i)[2]};
        }
        Arrays.sort(bb, (a, c) -> Float.compare(a[2], c[2]));
        for (int k = 0; k < Math.min(K_TARGETS, bb.length); k++) {
            int j = 19 + 5 * k;
            o[j] = bb[k][0] / 10; o[j + 1] = bb[k][1] / 10; o[j + 2] = Math.min(bb[k][2], 30f) / 10;
            o[j + 3] = Math.min(Math.max(bb[k][3], 0f), 60f) / 30; o[j + 4] = 1;
        }
        seenBottles = bb.length;
        nearestBottle = bb.length > 0 ? bb[0][2] : Float.NaN;
        // weeds: nearest 2 by edge distance [x/10, y/10, clip(edge,-3,30)/10, r/3, 1]
        float[][] wb = new float[weeds.size()][];
        for (int i = 0; i < wb.length; i++) {
            float[] w = weeds.get(i);
            float[] p = body(w[0], w[1], pos, psi);
            wb[i] = new float[]{p[0], p[1], (float) Math.hypot(p[0], p[1]) - w[2], w[2]};
        }
        Arrays.sort(wb, (a, c) -> Float.compare(a[2], c[2]));
        for (int k = 0; k < Math.min(K_WEEDS, wb.length); k++) {
            int j = 39 + 5 * k;
            o[j] = wb[k][0] / 10; o[j + 1] = wb[k][1] / 10; o[j + 2] = Math.max(-3f, Math.min(30f, wb[k][2])) / 10;
            o[j + 3] = wb[k][3] / 3; o[j + 4] = 1;
        }
        seenWeeds = wb.length;
        // shore: 8 rays (open water = 15 m each way when no shore is known)
        shoreKnown = shore != null;
        for (int k = 0; k < 8; k++) o[49 + k] = ray(pos, psi + Math.toRadians(RAY_DEG[k])) / RAY_MAX;
        float[] hb = body(home[0], home[1], pos, psi);
        o[57] = hb[0] / 20; o[58] = hb[1] / 20;
        distHome = (float) Math.hypot(hb[0], hb[1]);
        o[59] = distHome / 20;
        float[] pb = body(wp[0], wp[1], pos, psi);
        o[60] = pb[0] / 20; o[61] = pb[1] / 20; o[62] = (float) Math.hypot(pb[0], pb[1]) / 20;
        for (int i = 0; i < OBS; i++) o[i] = Math.max(-5f, Math.min(5f, o[i]));

        float[] out = captain.forward(o);
        float thr = Captain.throttle(out), steer = Captain.steer(out);
        int ra = Captain.ramp(out);
        // its own memory for the next step (as in training): the ramp glides ~1 unit/s
        float target = ra == Captain.RAMP_LOWER ? 1f : ra == Captain.RAMP_TIP ? -1f : 0f;
        ramp += Math.max(-1.1f * DT, Math.min(1.1f * DT, target - ramp));
        sHist[1] = sHist[0]; sHist[0] = prevSteer;
        prevThr = thr; prevSteer = steer; prevRampAct = ra;

        lastObs = o;
        outThr = thr; outSteer = steer; outRamp = ra;
        goal = homeFlag ? "going home" : bb.length > 0 ? String.format(Locale.US, "plastic %.1f m away", bb[0][2])
                : "searching (no plastic known)";
        ready = true;
        why = "watching";
    }

    private static float[] body(float n, float e, float[] pos, double psi) {
        double dn = n - pos[0], de = e - pos[1], c = Math.cos(psi), s = Math.sin(psi);
        return new float[]{(float) (dn * c + de * s), (float) (-dn * s + de * c)};
    }

    private float ray(float[] pos, double a) {
        if (shore == null) return RAY_MAX;
        double dx = Math.cos(a), dy = Math.sin(a), best = RAY_MAX;
        for (int i = 0; i < shore.length; i++) {
            float[] p0 = shore[i], p1 = shore[(i + 1) % shore.length];
            double ex = p1[0] - p0[0], ey = p1[1] - p0[1], wx = p0[0] - pos[0], wy = p0[1] - pos[1];
            double den = dx * ey - dy * ex;
            if (Math.abs(den) < 1e-6) den = 1e-6;
            double t = (wx * ey - wy * ex) / den, sg = (wx * dy - wy * dx) / den;
            if (t > 0 && sg >= 0 && sg <= 1 && t < best) best = t;
        }
        return (float) Math.max(0, Math.min(RAY_MAX, best));
    }

    String text() {
        if (!ready) return "AI captain (watch only): " + why;
        return String.format(Locale.US,
                "would do: throttle %3.0f%%  steer %s %.2f  %s\n  goal: %s\n  sees %d plastic, %d weed patches; shore %s; battery %s; home %.0f m",
                outThr * 100, outSteer >= 0 ? "right" : "left", Math.abs(outSteer), Captain.rampWords(outRamp), goal,
                seenBottles, seenWeeds, shoreKnown ? "known" : "not sent (open water assumed)",
                battKnown ? Math.round(soc * 100) + "%" : "unknown (full assumed)", distHome);
    }

    String json() {
        return String.format(Locale.US,
                "{\"mode\":\"watch_only\",\"ready\":%b,\"why\":\"%s\",\"throttle\":%.3f,\"steer\":%.3f,\"ramp\":%d,\"ramp_words\":\"%s\","
                        + "\"goal\":\"%s\",\"plastic_known\":%d,\"weeds_known\":%d,\"nearest_plastic_m\":%s,\"home_m\":%s,"
                        + "\"going_home\":%b,\"shore_known\":%b,\"battery_known\":%b,\"model\":\"%s\",\"ticks\":%d}",
                ready, why, outThr, outSteer, outRamp, Captain.rampWords(outRamp), goal, seenBottles, seenWeeds,
                Float.isNaN(nearestBottle) ? "null" : String.format(Locale.US, "%.2f", nearestBottle),
                Float.isNaN(distHome) ? "null" : String.format(Locale.US, "%.1f", distHome),
                homeFlag, shoreKnown, battKnown, modelText(), ticks);
    }
}
