package ai.varuna.boatlink;

import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.util.ArrayList;
import java.util.List;

/** The little MAVLink this app needs: whole-frame splitting, a GPS_INPUT encoder,
 *  and reading a few fields for the status screen. Pure Java (unit-tested on the PC). */
final class Mav {
    private Mav() {}

    static final int GPS_INPUT_ID = 232;
    static final int GPS_INPUT_CRC_EXTRA = 151;

    // GPS_INPUT ignore_flags
    static final int IGNORE_ALT = 1, IGNORE_HDOP = 2, IGNORE_VDOP = 4, IGNORE_VEL_HORIZ = 8,
            IGNORE_VEL_VERT = 16, IGNORE_SPEED_ACCURACY = 32, IGNORE_HORIZONTAL_ACCURACY = 64,
            IGNORE_VERTICAL_ACCURACY = 128;

    static int crcAccumulate(int b, int crc) {
        int tmp = (b ^ crc) & 0xff;
        tmp = (tmp ^ (tmp << 4)) & 0xff;
        return ((crc >> 8) ^ (tmp << 8) ^ (tmp << 3) ^ (tmp >> 4)) & 0xffff;
    }

    /** A MAVLink 2 frame (payload's trailing zeros trimmed, as the spec asks). */
    static byte[] frame2(int seq, int sysId, int compId, int msgId, int crcExtra, byte[] payload) {
        int len = payload.length;
        while (len > 1 && payload[len - 1] == 0) len--;
        byte[] f = new byte[12 + len];
        f[0] = (byte) 0xFD;
        f[1] = (byte) len;
        f[2] = 0;
        f[3] = 0;
        f[4] = (byte) seq;
        f[5] = (byte) sysId;
        f[6] = (byte) compId;
        f[7] = (byte) (msgId & 0xff);
        f[8] = (byte) ((msgId >> 8) & 0xff);
        f[9] = (byte) ((msgId >> 16) & 0xff);
        System.arraycopy(payload, 0, f, 10, len);
        int crc = 0xffff;
        for (int i = 1; i < 10 + len; i++) crc = crcAccumulate(f[i] & 0xff, crc);
        crc = crcAccumulate(crcExtra, crc);
        f[10 + len] = (byte) (crc & 0xff);
        f[11 + len] = (byte) ((crc >> 8) & 0xff);
        return f;
    }

    /** GPS_INPUT payload in MAVLink wire order (largest fields first, yaw extension last). */
    static byte[] gpsInputPayload(long timeUsec, int gpsId, int ignoreFlags, long timeWeekMs, int timeWeek,
                                  int fixType, int latE7, int lonE7, float altM, float hdop, float vdop,
                                  float vn, float ve, float vd, float speedAcc, float horizAcc, float vertAcc,
                                  int satellites, int yawCdeg) {
        ByteBuffer b = ByteBuffer.allocate(65).order(ByteOrder.LITTLE_ENDIAN);
        b.putLong(timeUsec);
        b.putInt((int) timeWeekMs);
        b.putInt(latE7);
        b.putInt(lonE7);
        b.putFloat(altM);
        b.putFloat(hdop);
        b.putFloat(vdop);
        b.putFloat(vn);
        b.putFloat(ve);
        b.putFloat(vd);
        b.putFloat(speedAcc);
        b.putFloat(horizAcc);
        b.putFloat(vertAcc);
        b.putShort((short) ignoreFlags);
        b.putShort((short) timeWeek);
        b.put((byte) gpsId);
        b.put((byte) fixType);
        b.put((byte) satellites);
        b.putShort((short) yawCdeg);
        return b.array();
    }

    static final int ATTITUDE_ID = 30;
    static final int ATTITUDE_CRC_EXTRA = 39;

    /** ATTITUDE payload (28 bytes): time_boot_ms, roll, pitch, yaw (rad), and their rates (rad/s). */
    static byte[] attitudePayload(long timeBootMs, float roll, float pitch, float yaw,
                                  float rollSpeed, float pitchSpeed, float yawSpeed) {
        ByteBuffer b = ByteBuffer.allocate(28).order(ByteOrder.LITTLE_ENDIAN);
        b.putInt((int) timeBootMs);
        b.putFloat(roll);
        b.putFloat(pitch);
        b.putFloat(yaw);
        b.putFloat(rollSpeed);
        b.putFloat(pitchSpeed);
        b.putFloat(yawSpeed);
        return b.array();
    }

    static final int COMMAND_LONG_ID = 76;
    static final int COMMAND_LONG_CRC_EXTRA = 152;
    static final int MAV_CMD_DO_SET_MODE = 176;
    static final int ROVER_HOLD = 4;
    static final int ROVER_MANUAL = 0;

    // RC_CHANNELS_OVERRIDE (70): how the laptop drives the brain in MANUAL; the AI captain does the same.
    static final int RC_OVERRIDE_ID = 70;
    static final int RC_OVERRIDE_CRC_EXTRA = 124;
    static final int RC_IGNORE = 65535, RC_RELEASE = 0;

    /** chan1..chan8 (µs; 65535 = leave as it is, 0 = back to the receiver), then target system / component. */
    static byte[] rcOverridePayload(int targetSys, int targetComp, int... ch) {
        ByteBuffer b = ByteBuffer.allocate(18).order(ByteOrder.LITTLE_ENDIAN);
        for (int i = 0; i < 8; i++) b.putShort((short) (i < ch.length ? ch[i] : RC_IGNORE));
        b.put((byte) targetSys);
        b.put((byte) targetComp);
        return b.array();
    }

    /** The brain's "laptop stick" scale (brain.cpp laptop_norm): 1500 = centre, ±30 µs dead band, ±370 µs full. */
    static int stickUs(float v) {
        v = Math.max(-1f, Math.min(1f, v));
        if (Math.abs(v) < 0.01f) return 1500;
        return Math.round(1500 + Math.signum(v) * (30 + Math.abs(v) * 370));
    }

    /** COMMAND_LONG payload in wire order: 7 floats, command, target system / component, confirmation. */
    static byte[] commandLongPayload(int command, int targetSys, int targetComp, float... params) {
        ByteBuffer b = ByteBuffer.allocate(33).order(ByteOrder.LITTLE_ENDIAN);
        for (int i = 0; i < 7; i++) b.putFloat(i < params.length ? params[i] : 0f);
        b.putShort((short) command);
        b.put((byte) targetSys);
        b.put((byte) targetComp);
        b.put((byte) 0);
        return b.array();
    }

    /** Message id of a whole frame (v1 or v2). */
    static int msgId(byte[] f) {
        if ((f[0] & 0xff) == 0xFD) return (f[7] & 0xff) | ((f[8] & 0xff) << 8) | ((f[9] & 0xff) << 16);
        return f[5] & 0xff;
    }

    static int sysId(byte[] f) {
        return ((f[0] & 0xff) == 0xFD) ? (f[5] & 0xff) : (f[3] & 0xff);
    }

    static int compId(byte[] f) {
        return ((f[0] & 0xff) == 0xFD) ? (f[6] & 0xff) : (f[4] & 0xff);
    }

    /** The payload, zero-padded to `want` bytes (MAVLink 2 trims trailing zeros). */
    static ByteBuffer payload(byte[] f, int want) {
        boolean v2 = (f[0] & 0xff) == 0xFD;
        int start = v2 ? 10 : 6;
        int len = f[1] & 0xff;
        byte[] p = new byte[Math.max(want, len)];
        System.arraycopy(f, start, p, 0, len);
        return ByteBuffer.wrap(p).order(ByteOrder.LITTLE_ENDIAN);
    }

    /**
     * Cuts a byte stream into whole MAVLink frames (v1 0xFE / v2 0xFD, signed v2 too),
     * so frames from different senders are never mixed byte by byte on the Pixhawk's
     * USB. Bytes between frames are dropped. The CRC isn't checked here: the Pixhawk
     * does that, and a frame that is really garbage just gets dropped there.
     */
    static final class Splitter {
        private final byte[] buf = new byte[8192];
        private int n = 0;
        private long partialSince = 0;

        List<byte[]> feed(byte[] data, int off, int len, long nowMs) {
            List<byte[]> out = new ArrayList<>();
            // A frame that never completes (a stray magic byte) is dropped after 1 s.
            if (n > 0 && partialSince != 0 && nowMs - partialSince > 1000) {
                drop(1);
            }
            int i = 0;
            while (i < len) {
                int take = Math.min(len - i, buf.length - n);
                if (take <= 0) {           // full of junk: start over
                    n = 0;
                    continue;
                }
                System.arraycopy(data, off + i, buf, n, take);
                n += take;
                i += take;
                extract(out);
            }
            partialSince = n > 0 ? (partialSince == 0 ? nowMs : partialSince) : 0;
            return out;
        }

        private void extract(List<byte[]> out) {
            while (true) {
                int s = 0;
                while (s < n && (buf[s] & 0xff) != 0xFD && (buf[s] & 0xff) != 0xFE) s++;
                if (s > 0) {
                    drop(s);
                    partialSince = 0;
                }
                if (n < 3) return;
                int total;
                if ((buf[0] & 0xff) == 0xFD) {
                    int signed = ((buf[2] & 0x01) != 0) ? 13 : 0;
                    total = 12 + (buf[1] & 0xff) + signed;
                } else {
                    total = 8 + (buf[1] & 0xff);
                }
                if (n < total) return;
                byte[] f = new byte[total];
                System.arraycopy(buf, 0, f, 0, total);
                drop(total);
                partialSince = 0;
                out.add(f);
            }
        }

        private void drop(int k) {
            k = Math.min(k, n);
            System.arraycopy(buf, k, buf, 0, n - k);
            n -= k;
        }
    }

    static String roverMode(long customMode) {
        switch ((int) customMode) {
            case 0: return "MANUAL";
            case 1: return "ACRO";
            case 3: return "STEERING";
            case 4: return "HOLD";
            case 5: return "LOITER";
            case 6: return "FOLLOW";
            case 7: return "SIMPLE";
            case 8: return "DOCK";
            case 9: return "CIRCLE";
            case 10: return "AUTO";
            case 11: return "RTL";
            case 12: return "SMART_RTL";
            case 15: return "GUIDED";
            case 16: return "INITIALISING";
            default: return "MODE " + customMode;
        }
    }
}
