// VARUNA Cam: the USB webcam's video stream (UVC, MJPEG), read straight from
// the USB device the app opened with Android's UsbManager.
//
// Android's Java USB API can't do isochronous transfers, and almost every
// webcam sends its video that way, so this small piece reads them through the
// kernel's usbfs (the device's file descriptor) and puts the UVC payloads back
// together into whole JPEG pictures, one Java call per picture.
//
// Java (UsbCam) does everything else: finding the webcam, the permission, the
// format negotiation (probe / commit) and choosing the alternate setting.

#include <jni.h>
#include <errno.h>
#include <poll.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>
#include <sys/ioctl.h>
#include <linux/usbdevice_fs.h>
#include <android/log.h>

#define TAG "VarunaCam"
#define LOGW(...) __android_log_print(ANDROID_LOG_WARN, TAG, __VA_ARGS__)

#define ISO_URBS 8
#define ISO_PACKETS 32
#define BULK_URBS 4

static volatile int g_stop;

typedef struct {
    JNIEnv *env;
    jobject self;
    jmethodID on_frame;
    uint8_t *buf;
    size_t len;
    size_t cap;
    int fid;
    int have_fid;
    int bad;            // this picture lost data or the camera flagged an error
    long frames;
} Assembler;

static void emit(Assembler *a) {
    if (!a->bad && a->len > 4 && a->buf[0] == 0xFF && a->buf[1] == 0xD8) {
        jbyteArray arr = (*a->env)->NewByteArray(a->env, (jsize) a->len);
        if (arr) {
            (*a->env)->SetByteArrayRegion(a->env, arr, 0, (jsize) a->len, (const jbyte *) a->buf);
            (*a->env)->CallVoidMethod(a->env, a->self, a->on_frame, arr, (jint) a->len);
            (*a->env)->DeleteLocalRef(a->env, arr);
            if ((*a->env)->ExceptionCheck(a->env)) (*a->env)->ExceptionClear(a->env);
            a->frames++;
        }
    }
    a->len = 0;
    a->bad = 0;
}

// One UVC payload: a header (length, flags: bit 0 frame id, bit 1 end of
// frame, bit 6 error), then part of the picture.
static void payload(Assembler *a, const uint8_t *p, int n) {
    if (n < 2) return;
    int hl = p[0];
    if (hl < 2 || hl > n) return;
    int info = p[1];
    int fid = info & 0x01;
    // A new frame id means a new picture: whatever came before is complete
    // (cameras that never set the end-of-frame bit) or was cut short.
    if (a->have_fid && fid != a->fid && a->len > 0) emit(a);
    a->fid = fid;
    a->have_fid = 1;
    if (info & 0x40) a->bad = 1;
    int dn = n - hl;
    if (dn > 0) {
        if (a->len + dn > a->cap) {
            size_t want = a->cap * 2;
            if (want < a->len + dn) want = a->len + dn;
            if (want > 16 * 1024 * 1024) {      // nonsense: drop this picture
                a->len = 0;
                a->bad = 1;
                return;
            }
            uint8_t *nb = realloc(a->buf, want);
            if (!nb) {
                a->len = 0;
                a->bad = 1;
                return;
            }
            a->buf = nb;
            a->cap = want;
        }
        memcpy(a->buf + a->len, p + hl, dn);
        a->len += dn;
    }
    if (info & 0x02) emit(a);
}

// Waits up to 100 ms for a finished transfer. 1 = got one, 0 = none yet,
// -errno = the device is gone (or another fatal error).
static int reap(int fd, struct usbdevfs_urb **out) {
    for (;;) {
        if (ioctl(fd, USBDEVFS_REAPURBNDELAY, out) == 0) return 1;
        int e = errno;
        if (e == EINTR) continue;
        if (e != EAGAIN) return -e;
        struct pollfd pfd = {fd, POLLOUT | POLLWRNORM, 0};
        int r = poll(&pfd, 1, 100);
        if (r < 0 && errno != EINTR) return -errno;
        if (r == 0) return 0;
        if (pfd.revents & (POLLERR | POLLHUP)) {
            if (ioctl(fd, USBDEVFS_REAPURBNDELAY, out) == 0) return 1;
            return -ENODEV;
        }
    }
}

static void discard_all(int fd, struct usbdevfs_urb **urbs, int n) {
    for (int i = 0; i < n; i++) {
        if (urbs[i]) ioctl(fd, USBDEVFS_DISCARDURB, urbs[i]);
    }
    // Collect them, so the kernel no longer writes into the buffers.
    for (int tries = 0; tries < 20; tries++) {
        struct usbdevfs_urb *u;
        if (ioctl(fd, USBDEVFS_REAPURBNDELAY, &u) == 0) {
            tries = 0;
            continue;
        }
        if (errno != EAGAIN) break;
        struct pollfd pfd = {fd, POLLOUT | POLLWRNORM, 0};
        if (poll(&pfd, 1, 20) <= 0) break;
    }
}

/*
 * Streams until stop() or until the webcam goes away. Returns 0 after stop(),
 * or a negative errno (-19 ENODEV: unplugged).
 *   endpoint: the video endpoint's address (0x81...)
 *   packetSize: bytes per isochronous packet (with the high-bandwidth multiplier),
 *               or for bulk the payload transfer size
 */
JNIEXPORT jint JNICALL
Java_ai_varuna_cam_UsbCam_nativeStream(JNIEnv *env, jobject self, jint fd, jint endpoint,
                                       jint packetSize, jboolean iso, jint frameSizeHint) {
    g_stop = 0;
    Assembler a;
    memset(&a, 0, sizeof a);
    a.env = env;
    a.self = self;
    jclass cls = (*env)->GetObjectClass(env, self);
    a.on_frame = (*env)->GetMethodID(env, cls, "onFrame", "([BI)V");
    if (!a.on_frame) return -EINVAL;
    a.cap = frameSizeHint > 64 * 1024 && frameSizeHint < 16 * 1024 * 1024 ? (size_t) frameSizeHint : 1024 * 1024;
    a.buf = malloc(a.cap);
    if (!a.buf) return -ENOMEM;

    int nurbs = iso ? ISO_URBS : BULK_URBS;
    int perUrb = iso ? ISO_PACKETS : 1;
    size_t bufLen = (size_t) packetSize * perUrb;
    struct usbdevfs_urb *urbs[ISO_URBS];
    uint8_t *bufs[ISO_URBS];
    memset(urbs, 0, sizeof urbs);
    memset(bufs, 0, sizeof bufs);
    int result = 0;

    for (int i = 0; i < nurbs; i++) {
        size_t sz = sizeof(struct usbdevfs_urb) + (iso ? perUrb * sizeof(struct usbdevfs_iso_packet_desc) : 0);
        urbs[i] = calloc(1, sz);
        bufs[i] = malloc(bufLen);
        if (!urbs[i] || !bufs[i]) {
            result = -ENOMEM;
            goto done;
        }
        struct usbdevfs_urb *u = urbs[i];
        u->type = iso ? USBDEVFS_URB_TYPE_ISO : USBDEVFS_URB_TYPE_BULK;
        u->endpoint = (unsigned char) endpoint;
        u->buffer = bufs[i];
        u->buffer_length = (int) bufLen;
        u->usercontext = (void *) (intptr_t) i;
        if (iso) {
            u->flags = USBDEVFS_URB_ISO_ASAP;
            u->number_of_packets = perUrb;
            for (int k = 0; k < perUrb; k++) u->iso_frame_desc[k].length = (unsigned int) packetSize;
        }
        if (ioctl(fd, USBDEVFS_SUBMITURB, u) < 0) {
            result = -errno;
            LOGW("USB webcam: can't start the transfer (%d)", errno);
            free(urbs[i]);
            urbs[i] = NULL;
            goto done;
        }
    }

    while (!g_stop) {
        struct usbdevfs_urb *u = NULL;
        int r = reap(fd, &u);
        if (r < 0) {
            result = r;
            break;
        }
        if (r == 0 || !u) continue;
        if (u->status == -ENODEV || u->status == -ESHUTDOWN) {
            result = -ENODEV;
            break;
        }
        if (iso) {
            for (int k = 0; k < u->number_of_packets; k++) {
                struct usbdevfs_iso_packet_desc *d = &u->iso_frame_desc[k];
                if (d->status != 0) {
                    if (a.len > 0) a.bad = 1;   // a lost packet tears the picture
                    continue;
                }
                if (d->actual_length > 0) {
                    payload(&a, (const uint8_t *) u->buffer + (size_t) k * packetSize, (int) d->actual_length);
                }
            }
            for (int k = 0; k < u->number_of_packets; k++) {
                u->iso_frame_desc[k].actual_length = 0;
                u->iso_frame_desc[k].status = 0;
            }
        } else if (u->status == 0 && u->actual_length > 0) {
            payload(&a, (const uint8_t *) u->buffer, u->actual_length);
        }
        if (g_stop) break;
        u->status = 0;
        u->actual_length = 0;
        if (ioctl(fd, USBDEVFS_SUBMITURB, u) < 0) {
            int e = errno;
            int idx = (int) (intptr_t) u->usercontext;
            if (idx >= 0 && idx < nurbs) urbs[idx] = NULL;   // no longer with the kernel
            free(u);
            if (e == ENODEV || e == ESHUTDOWN) {
                result = -ENODEV;
                break;
            }
            LOGW("USB webcam: resubmit failed (%d)", e);
            result = -e;
            break;
        }
    }

done:
    discard_all(fd, urbs, nurbs);
    for (int i = 0; i < nurbs; i++) {
        free(urbs[i]);
        free(bufs[i]);
    }
    free(a.buf);
    return result;
}

JNIEXPORT void JNICALL
Java_ai_varuna_cam_UsbCam_nativeStop(JNIEnv *env, jclass cls) {
    (void) env;
    (void) cls;
    g_stop = 1;
}
