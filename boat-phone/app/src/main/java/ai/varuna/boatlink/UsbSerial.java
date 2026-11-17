package ai.varuna.boatlink;

import android.hardware.usb.UsbConstants;
import android.hardware.usb.UsbDevice;
import android.hardware.usb.UsbDeviceConnection;
import android.hardware.usb.UsbEndpoint;
import android.hardware.usb.UsbInterface;
import android.hardware.usb.UsbManager;
import android.os.SystemClock;

import java.io.IOException;

/** A USB CDC-ACM serial port (what a Pixhawk shows on its USB socket), with no library. */
final class UsbSerial {
    final UsbDevice device;
    private final UsbDeviceConnection conn;
    private final UsbInterface ctrl, data;
    private final UsbEndpoint in, out;
    private int readFailures = 0;

    private UsbSerial(UsbDevice device, UsbDeviceConnection conn, UsbInterface ctrl, UsbInterface data,
                      UsbEndpoint in, UsbEndpoint out) {
        this.device = device;
        this.conn = conn;
        this.ctrl = ctrl;
        this.data = data;
        this.in = in;
        this.out = out;
    }

    /** The data interface of a CDC serial device, or null if it has none. */
    static UsbInterface dataInterface(UsbDevice d) {
        for (int i = 0; i < d.getInterfaceCount(); i++) {
            UsbInterface f = d.getInterface(i);
            if (f.getInterfaceClass() == UsbConstants.USB_CLASS_CDC_DATA && bulk(f, UsbConstants.USB_DIR_IN) != null
                    && bulk(f, UsbConstants.USB_DIR_OUT) != null) return f;
        }
        return null;
    }

    static boolean isSerial(UsbDevice d) {
        return dataInterface(d) != null;
    }

    private static UsbEndpoint bulk(UsbInterface f, int dir) {
        for (int e = 0; e < f.getEndpointCount(); e++) {
            UsbEndpoint ep = f.getEndpoint(e);
            if (ep.getType() == UsbConstants.USB_ENDPOINT_XFER_BULK && ep.getDirection() == dir) return ep;
        }
        return null;
    }

    static UsbSerial open(UsbManager um, UsbDevice d, int baud) throws IOException {
        UsbInterface data = dataInterface(d);
        if (data == null) throw new IOException("not a USB serial device");
        UsbInterface ctrl = null;
        for (int i = 0; i < d.getInterfaceCount(); i++) {
            UsbInterface f = d.getInterface(i);
            if (f.getInterfaceClass() == UsbConstants.USB_CLASS_COMM) {
                ctrl = f;
                break;
            }
        }
        UsbDeviceConnection c = um.openDevice(d);
        if (c == null) throw new IOException("USB permission missing");
        if (ctrl != null) c.claimInterface(ctrl, true);
        if (!c.claimInterface(data, true)) {
            c.close();
            throw new IOException("could not claim the USB serial interface");
        }
        int ifc = ctrl != null ? ctrl.getId() : data.getId();
        byte[] coding = {(byte) (baud & 0xff), (byte) ((baud >> 8) & 0xff), (byte) ((baud >> 16) & 0xff),
                (byte) ((baud >> 24) & 0xff), 0, 0, 8};
        c.controlTransfer(0x21, 0x20, 0, ifc, coding, coding.length, 1000);   // SET_LINE_CODING
        c.controlTransfer(0x21, 0x22, 0x03, ifc, null, 0, 1000);               // DTR + RTS on
        return new UsbSerial(d, c, ctrl, data, bulk(data, UsbConstants.USB_DIR_IN), bulk(data, UsbConstants.USB_DIR_OUT));
    }

    /**
     * Reads what's there (0 if nothing came in `timeoutMs`). Android reports a timeout
     * and a dead device the same way (-1), so a quick -1 counts as a failure and a
     * run of them means the device is gone.
     */
    int read(byte[] buf, int timeoutMs) throws IOException {
        long t0 = SystemClock.elapsedRealtime();
        int n = conn.bulkTransfer(in, buf, Math.min(buf.length, 16384), timeoutMs);
        if (n >= 0) {
            readFailures = 0;
            return n;
        }
        if (SystemClock.elapsedRealtime() - t0 < timeoutMs / 2) {
            if (++readFailures >= 5) throw new IOException("USB read failed (unplugged?)");
            SystemClock.sleep(20);
        } else {
            readFailures = 0;
        }
        return 0;
    }

    void write(byte[] b) throws IOException {
        int off = 0;
        while (off < b.length) {
            int n = conn.bulkTransfer(out, b, off, b.length - off, 1000);
            if (n <= 0) throw new IOException("USB write failed");
            off += n;
        }
    }

    void close() {
        try {
            conn.releaseInterface(data);
            if (ctrl != null) conn.releaseInterface(ctrl);
        } catch (Exception ignored) {
        }
        conn.close();
    }
}
