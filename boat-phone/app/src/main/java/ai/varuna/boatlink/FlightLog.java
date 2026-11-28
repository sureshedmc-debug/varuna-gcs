package ai.varuna.boatlink;

import android.os.SystemClock;

import java.io.BufferedOutputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.text.SimpleDateFormat;
import java.util.Arrays;
import java.util.Date;
import java.util.Locale;
import java.util.concurrent.ArrayBlockingQueue;
import java.util.concurrent.BlockingQueue;
import java.util.concurrent.TimeUnit;

/**
 * Records every MAVLink frame between the phone and the boat brain to a .tlog file
 * (8-byte big-endian microsecond time + the frame: the format Mission Planner and
 * pymavlink read). Both directions: the brain's outputs, sticks and modes, and what
 * the phone sends it - compass + gyro 50x a second, GPS 10x a second, the laptop's
 * commands. That is the boat's model data: what it did for each command.
 *
 * One file per connection to the brain (a new one after 200 MB). Files live in the
 * app's own folder (Android/data/ai.varuna.boatlink/files/logs), the laptop gets
 * them from http://phone:8080/logs. The oldest go when all of them pass 2 GB.
 * Writing happens on its own thread: the USB link never waits for the phone's storage.
 */
final class FlightLog {
    static final long MAX_FILE = 200L << 20, MAX_TOTAL = 2048L << 20;
    private static final byte[] NEW_FILE = new byte[0], CLOSE = new byte[0];

    final File dir;
    private final BlockingQueue<byte[]> queue = new ArrayBlockingQueue<>(8192);
    private final long wallAtStartUs = System.currentTimeMillis() * 1000L;
    private final long monoAtStartNs = SystemClock.elapsedRealtimeNanos();
    private volatile boolean on;
    volatile String fileName = "";
    volatile long fileBytes, frames, dropped;

    FlightLog(File dir) {
        this.dir = dir;
        //noinspection ResultOfMethodCallIgnored
        dir.mkdirs();
        Thread t = new Thread(this::writer, "flight-log");
        t.setDaemon(true);
        t.start();
    }

    /** The brain is connected: start a new file. */
    void begin() {
        on = true;
        queue.offer(NEW_FILE);
    }

    /** The brain is gone: close the file. */
    void end() {
        on = false;
        queue.offer(CLOSE);
    }

    boolean recording() {
        return on && !fileName.isEmpty();
    }

    /** A whole MAVLink frame (either direction). Never blocks. */
    void add(byte[] frame) {
        if (!on || frame == null || frame.length == 0) return;
        // A steady clock (no jumps when the phone sets its time), started at the wall time.
        long us = wallAtStartUs + (SystemClock.elapsedRealtimeNanos() - monoAtStartNs) / 1000L;
        byte[] rec = new byte[8 + frame.length];
        for (int i = 0; i < 8; i++) rec[i] = (byte) (us >>> (56 - 8 * i));
        System.arraycopy(frame, 0, rec, 8, frame.length);
        if (!queue.offer(rec)) dropped++;
    }

    private void writer() {
        BufferedOutputStream os = null;
        long lastFlush = 0;
        while (true) {
            byte[] r;
            try {
                r = queue.poll(500, TimeUnit.MILLISECONDS);
            } catch (InterruptedException e) {
                return;
            }
            try {
                if (r == NEW_FILE || (r != null && r != CLOSE && (os == null || fileBytes > MAX_FILE))) {
                    if (os != null) os.close();
                    os = open();
                } else if (r == CLOSE) {
                    if (os != null) os.close();
                    os = null;
                    fileName = "";
                    continue;
                }
                if (r != null && r.length > 0 && os != null) {
                    os.write(r);
                    fileBytes += r.length;
                    frames++;
                }
                long now = SystemClock.elapsedRealtime();
                if (os != null && now - lastFlush > 1000) {      // at most 1 s lost if the battery dies
                    os.flush();
                    lastFlush = now;
                }
            } catch (IOException e) {
                os = null;
                fileName = "";
                SystemClock.sleep(1000);
            }
        }
    }

    private BufferedOutputStream open() throws IOException {
        trim();
        String name = "varuna_" + new SimpleDateFormat("yyyyMMdd_HHmmss", Locale.US).format(new Date()) + ".tlog";
        File f = new File(dir, name);
        BufferedOutputStream os = new BufferedOutputStream(new FileOutputStream(f), 65536);
        fileName = name;
        fileBytes = 0;
        return os;
    }

    /** Keep the logs under MAX_TOTAL: the oldest go first. */
    private void trim() {
        File[] fs = list();
        long total = 0;
        for (File f : fs) total += f.length();
        for (File f : fs) {
            if (total <= MAX_TOTAL) break;
            total -= f.length();
            //noinspection ResultOfMethodCallIgnored
            f.delete();
        }
    }

    /** The logs, oldest first. */
    File[] list() {
        File[] fs = dir.listFiles((d, n) -> n.endsWith(".tlog"));
        if (fs == null) return new File[0];
        Arrays.sort(fs, (a, b) -> a.getName().compareTo(b.getName()));
        return fs;
    }

    /** A log by name (only plain .tlog / .csv names in our folder; .csv = the AI captain's logs). */
    File get(String name) {
        if (!name.matches("[A-Za-z0-9_.-]+\\.(tlog|csv)")) return null;
        File f = new File(dir, name);
        return f.isFile() ? f : null;
    }

    String state() {
        if (!recording()) return "not recording (the boat brain is not connected)";
        return String.format(Locale.US, "recording %s (%.1f MB, %d frames%s)", fileName, fileBytes / 1048576.0,
                frames, dropped > 0 ? ", " + dropped + " dropped" : "");
    }
}
