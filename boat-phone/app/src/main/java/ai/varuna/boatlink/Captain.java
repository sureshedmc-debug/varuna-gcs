package ai.varuna.boatlink;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.nio.ByteBuffer;
import java.nio.ByteOrder;

/**
 * The trained AI captain (boat-r4/ai, reinforcement learning), in plain Java: no ML
 * library. Loads assets/captain.bin (written by boat-r4/ai/export.py) and maps the
 * 63 numbers the phone knows about the boat to throttle, steer and a ramp choice.
 *
 *   x = clip((obs - mean) / std, -8, 8); every layer: x = W x + b, ELU except the last
 *   throttle = clip((x0 + 1) / 2, 0, 1); steer = clip(x1, -1, 1); ramp = argmax(x2..x4)
 *
 * This class only does the maths. It has no way to reach the boat brain.
 */
final class Captain {
    static final int RAMP_LOWER = 0, RAMP_HOLD = 1, RAMP_TIP = 2;

    final int obsDim, trainedIterations;
    final long trainedSteps;
    private final float clip;
    private final float[] mean, std;
    private final float[][][] w;        // [layer][out][in]
    private final float[][] b;          // [layer][out]
    private final float[][] buf;        // scratch per layer (one caller at a time)

    static Captain load(InputStream in) throws IOException {
        ByteArrayOutputStream bo = new ByteArrayOutputStream();
        byte[] chunk = new byte[1 << 16];
        int n;
        while ((n = in.read(chunk)) > 0) bo.write(chunk, 0, n);
        return new Captain(ByteBuffer.wrap(bo.toByteArray()).order(ByteOrder.LITTLE_ENDIAN));
    }

    private Captain(ByteBuffer bb) throws IOException {
        byte[] magic = new byte[4];
        bb.get(magic);
        if (magic[0] != 'V' || magic[1] != 'C' || magic[2] != 'A' || magic[3] != 'P')
            throw new IOException("not a captain file");
        int version = bb.getInt();
        if (version != 1) throw new IOException("captain file version " + version + " (this app reads 1)");
        obsDim = bb.getInt();
        trainedIterations = bb.getInt();
        trainedSteps = bb.getLong();
        clip = bb.getFloat();
        mean = floats(bb, obsDim);
        std = floats(bb, obsDim);
        int layers = bb.getInt();
        w = new float[layers][][];
        b = new float[layers][];
        buf = new float[layers][];
        int prev = obsDim;
        for (int l = 0; l < layers; l++) {
            int out = bb.getInt(), inn = bb.getInt();
            if (inn != prev) throw new IOException("layer " + l + " expects " + inn + " inputs, got " + prev);
            w[l] = new float[out][];
            for (int o = 0; o < out; o++) w[l][o] = floats(bb, inn);
            b[l] = floats(bb, out);
            buf[l] = new float[out];
            prev = out;
        }
        if (prev != 5) throw new IOException("captain gives " + prev + " outputs, expected 5");
    }

    private static float[] floats(ByteBuffer bb, int n) {
        float[] a = new float[n];
        bb.asFloatBuffer().get(a);
        bb.position(bb.position() + 4 * n);
        return a;
    }

    /** The raw 5 outputs for one observation (a copy). */
    synchronized float[] forward(float[] obs) {
        if (obs.length != obsDim) throw new IllegalArgumentException("obs has " + obs.length + " values, need " + obsDim);
        float[] x = new float[obsDim];
        for (int i = 0; i < obsDim; i++) {
            float v = (obs[i] - mean[i]) / std[i];
            x[i] = v > clip ? clip : v < -clip ? -clip : v;
        }
        for (int l = 0; l < w.length; l++) {
            float[] y = buf[l];
            boolean last = l == w.length - 1;
            for (int o = 0; o < y.length; o++) {
                float[] row = w[l][o];
                float s = b[l][o];
                for (int i = 0; i < row.length; i++) s += row[i] * x[i];
                y[o] = last || s > 0 ? s : (float) Math.expm1(s);      // ELU
            }
            x = y;
        }
        return x.clone();
    }

    static float throttle(float[] out) {
        return Math.max(0f, Math.min(1f, (out[0] + 1f) / 2f));
    }

    static float steer(float[] out) {
        return Math.max(-1f, Math.min(1f, out[1]));
    }

    static int ramp(float[] out) {
        int best = 0;
        for (int k = 1; k < 3; k++) if (out[2 + k] > out[2 + best]) best = k;
        return best;
    }

    static String rampWords(int r) {
        return r == RAMP_LOWER ? "lower ramp (collect)" : r == RAMP_TIP ? "tip into the bin" : "raise and hold";
    }
}
