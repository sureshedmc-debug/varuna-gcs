package ai.varuna.cam;

import android.media.MediaCodec;
import android.media.MediaCodecInfo;
import android.media.MediaCodecList;
import android.media.MediaFormat;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.HandlerThread;
import android.os.SystemClock;
import android.util.Log;
import android.view.Surface;

import java.io.IOException;
import java.io.OutputStream;
import java.nio.ByteBuffer;
import java.nio.charset.StandardCharsets;
import java.util.ArrayDeque;
import java.util.concurrent.CopyOnWriteArrayList;

/**
 * The camera as H.264, from the phone's hardware encoder, for /h264: a plain
 * Annex-B byte stream that starts at a keyframe (with its SPS and PPS).
 *
 * Built for a live view, the way drone video links work:
 *  - Baseline profile, no B-frames, real-time priority: each frame leaves as
 *    soon as it is encoded.
 *  - The bitrate follows the Wi-Fi. Frames waiting to go out mean the link is
 *    full, so the bitrate goes down at once; a while with none waiting lets it
 *    climb back, up to the preset's most.
 *  - A viewer never gets old video: if its frames pile up, they are dropped
 *    and it carries on from a fresh keyframe, asked for right then.
 *  - Each frame carries its capture time (an SEI message "t=<ms>", phone
 *    clock), so the delay can be measured anywhere down the line. Decoders
 *    ignore it.
 */
final class H264Stream {
    private static final String TAG = "VarunaCam";
    private static final String MIME = "video/avc";
    private static final int MIN_KBPS = 400;
    /** 16 bytes naming the SEI message; no zero bytes, so no emulation prevention needed. */
    private static final byte[] SEI_UUID = "VARUNA-CAM-TIME!".getBytes(StandardCharsets.US_ASCII);
    private static final byte[] START = {0, 0, 0, 1};
    /** Access-unit delimiter, put after each frame: "this frame is complete". */
    private static final byte[] AUD = {0, 0, 0, 1, 0x09, (byte) 0xF0};

    final int width;
    final int height;
    final int fps;
    private final int maxKbps;
    private final MediaCodec codec;
    private final Surface input;
    private final HandlerThread thread;
    private final CopyOnWriteArrayList<Viewer> viewers = new CopyOnWriteArrayList<>();
    private volatile byte[] config;        // SPS + PPS, Annex-B
    private volatile boolean released;

    private volatile int kbps;
    private long lastDownMs;
    private long lastUpMs;
    private long lastFullMs;

    private int statFrames;
    private long statBytes;
    private long statSince = SystemClock.elapsedRealtime();
    private volatile float outFps;
    private volatile int outKbps;

    private H264Stream(int width, int height, int fps, int maxKbps, MediaCodec codec, Surface input,
                       HandlerThread thread, int kbps) {
        this.width = width;
        this.height = height;
        this.fps = fps;
        this.maxKbps = maxKbps;
        this.codec = codec;
        this.input = input;
        this.thread = thread;
        this.kbps = kbps;
    }

    /** True if the phone has an H.264 encoder that takes this size. */
    static boolean supports(int width, int height) {
        for (MediaCodecInfo info : new MediaCodecList(MediaCodecList.REGULAR_CODECS).getCodecInfos()) {
            if (!info.isEncoder()) continue;
            for (String t : info.getSupportedTypes()) {
                if (!t.equalsIgnoreCase(MIME)) continue;
                try {
                    MediaCodecInfo.VideoCapabilities vc = info.getCapabilitiesForType(MIME).getVideoCapabilities();
                    if (vc != null && vc.isSizeSupported(width, height)) return true;
                } catch (IllegalArgumentException ignored) {
                }
            }
        }
        return false;
    }

    /** A running encoder; put {@link #surface()} into the camera session. */
    static H264Stream start(int width, int height, int fps, int maxKbps) throws IOException {
        int startKbps = Math.min(maxKbps, 2000);
        HandlerThread thread = new HandlerThread("h264");
        thread.start();
        MediaCodec codec = MediaCodec.createEncoderByType(MIME);
        try {
            boolean cbr = false;
            try {
                MediaCodecInfo.EncoderCapabilities ec = codec.getCodecInfo().getCapabilitiesForType(MIME)
                        .getEncoderCapabilities();
                cbr = ec != null && ec.isBitrateModeSupported(MediaCodecInfo.EncoderCapabilities.BITRATE_MODE_CBR);
            } catch (IllegalArgumentException ignored) {
            }
            final H264Stream[] self = new H264Stream[1];
            MediaCodec.Callback cb = new MediaCodec.Callback() {
                @Override
                public void onInputBufferAvailable(MediaCodec c, int index) {
                    // Surface input: the camera fills the encoder directly.
                }

                @Override
                public void onOutputBufferAvailable(MediaCodec c, int index, MediaCodec.BufferInfo info) {
                    H264Stream s = self[0];
                    if (s != null) s.onOutput(c, index, info);
                    else c.releaseOutputBuffer(index, false);
                }

                @Override
                public void onError(MediaCodec c, MediaCodec.CodecException e) {
                    Log.w(TAG, "H.264 encoder: " + e);
                }

                @Override
                public void onOutputFormatChanged(MediaCodec c, MediaFormat format) {
                    H264Stream s = self[0];
                    if (s != null) s.onFormat(format);
                }
            };
            Handler handler = new Handler(thread.getLooper());
            codec.setCallback(cb, handler);
            try {
                codec.configure(format(width, height, fps, startKbps, cbr, true), null, null,
                        MediaCodec.CONFIGURE_FLAG_ENCODE);
            } catch (RuntimeException e) {
                // Some encoders refuse the profile, level or priority: plain settings.
                Log.w(TAG, "H.264 encoder refused the low-delay settings, using plain ones: " + e);
                codec.reset();
                codec.setCallback(cb, handler);
                codec.configure(format(width, height, fps, startKbps, cbr, false), null, null,
                        MediaCodec.CONFIGURE_FLAG_ENCODE);
            }
            Surface input = codec.createInputSurface();
            H264Stream s = new H264Stream(width, height, fps, maxKbps, codec, input, thread, startKbps);
            self[0] = s;
            codec.start();
            return s;
        } catch (RuntimeException e) {
            codec.release();
            thread.quitSafely();
            throw new IOException("H.264 encoder: " + e.getMessage(), e);
        }
    }

    private static MediaFormat format(int width, int height, int fps, int kbps, boolean cbr, boolean lowDelay) {
        MediaFormat f = MediaFormat.createVideoFormat(MIME, width, height);
        f.setInteger(MediaFormat.KEY_COLOR_FORMAT, MediaCodecInfo.CodecCapabilities.COLOR_FormatSurface);
        f.setInteger(MediaFormat.KEY_BIT_RATE, kbps * 1000);
        f.setInteger(MediaFormat.KEY_FRAME_RATE, fps);
        // A keyframe every 2 s: viewers join at once anyway (one is asked for), and
        // the big keyframes come rarely enough not to bump the delay.
        f.setInteger(MediaFormat.KEY_I_FRAME_INTERVAL, 2);
        if (cbr) f.setInteger(MediaFormat.KEY_BITRATE_MODE, MediaCodecInfo.EncoderCapabilities.BITRATE_MODE_CBR);
        if (lowDelay) {
            f.setInteger(MediaFormat.KEY_PROFILE, MediaCodecInfo.CodecProfileLevel.AVCProfileBaseline);
            f.setInteger(MediaFormat.KEY_LEVEL, width * height > 1280 * 720
                    ? MediaCodecInfo.CodecProfileLevel.AVCLevel4 : MediaCodecInfo.CodecProfileLevel.AVCLevel31);
            f.setInteger(MediaFormat.KEY_PRIORITY, 0);    // real time
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) f.setInteger(MediaFormat.KEY_LATENCY, 1);
        }
        return f;
    }

    Surface surface() {
        return input;
    }

    int kbps() {
        return kbps;
    }

    float fps() {
        return outFps;
    }

    int sentKbps() {
        return outKbps;
    }

    int viewers() {
        return viewers.size();
    }

    void release() {
        released = true;
        for (Viewer v : viewers) v.close();
        try {
            codec.stop();
        } catch (RuntimeException ignored) {
        }
        codec.release();
        input.release();
        thread.quitSafely();
    }

    // ---- encoder output ----------------------------------------------------

    private void onFormat(MediaFormat format) {
        if (config != null) return;
        ByteBuffer sps = format.getByteBuffer("csd-0");
        ByteBuffer pps = format.getByteBuffer("csd-1");
        if (sps == null || pps == null) return;
        byte[] out = new byte[sps.remaining() + pps.remaining()];
        sps.get(out, 0, sps.remaining());
        pps.get(out, out.length - pps.remaining(), pps.remaining());
        config = out;
    }

    private void onOutput(MediaCodec c, int index, MediaCodec.BufferInfo info) {
        byte[] data;
        try {
            ByteBuffer b = c.getOutputBuffer(index);
            if (b == null || info.size <= 0) {
                c.releaseOutputBuffer(index, false);
                return;
            }
            data = new byte[info.size];
            b.position(info.offset);
            b.get(data);
            c.releaseOutputBuffer(index, false);
        } catch (IllegalStateException e) {
            return;     // encoder stopping
        }
        if ((info.flags & MediaCodec.BUFFER_FLAG_CODEC_CONFIG) != 0) {
            config = data;
            return;
        }
        boolean key = (info.flags & MediaCodec.BUFFER_FLAG_KEY_FRAME) != 0;
        byte[] sei = sei(CamService.captureWallMs(info.presentationTimeUs * 1000L));
        byte[] cfg = key ? config : null;
        // An access-unit delimiter closes the frame: a reader knows it is complete
        // now, instead of when the next frame starts (a frame's time later).
        int n = (cfg != null ? cfg.length : 0) + sei.length + data.length + AUD.length;
        byte[] frame = new byte[n];
        int at = 0;
        if (cfg != null) {
            System.arraycopy(cfg, 0, frame, 0, cfg.length);
            at = cfg.length;
        }
        System.arraycopy(sei, 0, frame, at, sei.length);
        System.arraycopy(data, 0, frame, at + sei.length, data.length);
        System.arraycopy(AUD, 0, frame, at + sei.length + data.length, AUD.length);
        deliver(frame, key && cfg != null);
        count(n);
    }

    /** SEI "user data unregistered" with the capture time: digits only, so no zero bytes. */
    private static byte[] sei(long takenMs) {
        byte[] text = ("t=" + takenMs).getBytes(StandardCharsets.US_ASCII);
        int payload = SEI_UUID.length + text.length;
        byte[] out = new byte[START.length + 3 + payload + 1];
        System.arraycopy(START, 0, out, 0, START.length);
        int at = START.length;
        out[at++] = 0x06;               // NAL: SEI
        out[at++] = 0x05;               // payload type: user data unregistered
        out[at++] = (byte) payload;     // payload size (< 255)
        System.arraycopy(SEI_UUID, 0, out, at, SEI_UUID.length);
        at += SEI_UUID.length;
        System.arraycopy(text, 0, out, at, text.length);
        at += text.length;
        out[at] = (byte) 0x80;          // rbsp trailing bits
        return out;
    }

    private void count(int bytes) {
        long now = SystemClock.elapsedRealtime();
        statFrames++;
        statBytes += bytes;
        if (now - statSince >= 2000) {
            outFps = statFrames * 1000f / (now - statSince);
            outKbps = (int) (statBytes * 8 / (now - statSince));
            statFrames = 0;
            statBytes = 0;
            statSince = now;
        }
    }

    // ---- viewers -------------------------------------------------------------

    private void deliver(byte[] frame, boolean key) {
        long now = SystemClock.elapsedRealtime();
        // About a fifth of a second of frames waiting: the link can't keep up.
        int maxWaiting = Math.max(3, fps / 5);
        boolean busy = false;
        boolean full = false;
        for (Viewer v : viewers) {
            synchronized (v) {
                if (v.needKey) {
                    if (!key) continue;
                    v.needKey = false;
                }
                if (v.waiting.size() >= maxWaiting) {
                    v.waiting.clear();
                    v.needKey = true;   // carry on from a fresh keyframe, not from old video
                    full = true;
                    continue;
                }
                if (v.waiting.size() >= 2) busy = true;
                v.waiting.add(frame);
                v.notifyAll();
            }
        }
        if (full) {
            lastFullMs = now;
            setKbps(kbps * 6 / 10, now);
            requestKeyframe();
        } else if (busy) {
            if (now - lastDownMs > 1000) setKbps(kbps * 85 / 100, now);
        } else if (kbps < maxKbps && !viewers.isEmpty() && now - lastDownMs > 4000 && now - lastUpMs > 1500
                && now - lastFullMs > 8000) {
            lastUpMs = now;
            setKbps(Math.min(maxKbps, kbps * 11 / 10 + 50), -1);
        }
    }

    private void setKbps(int want, long downAt) {
        int k = Math.max(MIN_KBPS, Math.min(maxKbps, want));
        if (downAt >= 0) lastDownMs = downAt;
        if (k == kbps) return;
        kbps = k;
        try {
            Bundle b = new Bundle();
            b.putInt(MediaCodec.PARAMETER_KEY_VIDEO_BITRATE, k * 1000);
            codec.setParameters(b);
        } catch (IllegalStateException ignored) {
        }
    }

    private void requestKeyframe() {
        try {
            Bundle b = new Bundle();
            b.putInt(MediaCodec.PARAMETER_KEY_REQUEST_SYNC_FRAME, 0);
            codec.setParameters(b);
        } catch (IllegalStateException ignored) {
        }
    }

    /**
     * Sends the stream to one viewer until it leaves or the encoder stops. The
     * HTTP header is already written.
     */
    void serve(OutputStream out) throws IOException {
        Viewer v = new Viewer();
        viewers.add(v);
        requestKeyframe();          // start now, not at the next scheduled keyframe
        try {
            while (!released) {
                byte[] f;
                synchronized (v) {
                    while (v.waiting.isEmpty() && !v.closed && !released) {
                        try {
                            v.wait(2000);
                        } catch (InterruptedException e) {
                            return;
                        }
                    }
                    if (v.closed || released) return;
                    f = v.waiting.poll();
                }
                out.write(f);
                out.flush();
            }
        } finally {
            viewers.remove(v);
        }
    }

    private static final class Viewer {
        final ArrayDeque<byte[]> waiting = new ArrayDeque<>();
        boolean needKey = true;
        boolean closed;

        synchronized void close() {
            closed = true;
            notifyAll();
        }
    }
}
