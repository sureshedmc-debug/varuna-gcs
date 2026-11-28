package ai.varuna.boatlink;

import android.hardware.usb.UsbConstants;
import android.hardware.usb.UsbDevice;
import android.hardware.usb.UsbDeviceConnection;
import android.hardware.usb.UsbEndpoint;
import android.hardware.usb.UsbInterface;
import android.hardware.usb.UsbManager;
import android.os.SystemClock;

import java.io.IOException;

/**
 * A USB serial port with no library: CDC-ACM (a Pixhawk, the UNO R4) and the two
 * USB chips on ESP32 dev boards (WCH CH340 / CH341 and Silicon Labs CP210x).
 */
final class UsbSerial {
    static final int VID_WCH = 0x1A86, VID_SILABS = 0x10C4;
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

    static boolean isCh34x(UsbDevice d) {
        int p = d.getProductId();
        return d.getVendorId() == VID_WCH && (p == 0x7523 || p == 0x5523 || p == 0x7522);
    }

    static boolean isCp210x(UsbDevice d) {
        int p = d.getProductId();
        return d.getVendorId() == VID_SILABS && (p == 0xEA60 || p == 0xEA70 || p == 0xEA71);
    }

    /** An ESP32 dev board's USB chip (the ESP32 boat brain). */
    static boolean isEsp32Bridge(UsbDevice d) {
        return (isCh34x(d) || isCp210x(d)) && d.getInterfaceCount() > 0;
    }

    static boolean isSerial(UsbDevice d) {
        return dataInterface(d) != null || isEsp32Bridge(d);
    }

    private static UsbEndpoint bulk(UsbInterface f, int dir) {
        for (int e = 0; e < f.getEndpointCount(); e++) {
            UsbEndpoint ep = f.getEndpoint(e);
            if (ep.getType() == UsbConstants.USB_ENDPOINT_XFER_BULK && ep.getDirection() == dir) return ep;
        }
        return null;
    }

    static UsbSerial open(UsbManager um, UsbDevice d, int baud) throws IOException {
        if (isEsp32Bridge(d)) return openVendor(um, d, baud);
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
     * CH340 / CP210x: vendor commands set 115200 8N1. DTR and RTS stay OFF: on an ESP32
     * dev board they drive its auto-reset circuit (RTS = EN / reset, DTR = GPIO0 / boot),
     * and with both off the ESP32 just keeps running - opening the port never resets it.
     */
    private static UsbSerial openVendor(UsbManager um, UsbDevice d, int baud) throws IOException {
        UsbInterface f = d.getInterface(0);
        UsbEndpoint in = bulk(f, UsbConstants.USB_DIR_IN), out = bulk(f, UsbConstants.USB_DIR_OUT);
        if (in == null || out == null) throw new IOException("USB serial chip without data endpoints");
        UsbDeviceConnection c = um.openDevice(d);
        if (c == null) throw new IOException("USB permission missing");
        if (!c.claimInterface(f, true)) {
            c.close();
            throw new IOException("could not claim the USB serial interface");
        }
        boolean ok;
        if (isCh34x(d)) ok = ch34xInit(c, baud);
        else ok = cp210xInit(c, f.getId(), baud);
        if (!ok) {
            c.releaseInterface(f);
            c.close();
            throw new IOException("USB serial chip did not accept the settings");
        }
        return new UsbSerial(d, c, null, f, in, out);
    }

    private static boolean ch34xOut(UsbDeviceConnection c, int req, int value, int index) {
        return c.controlTransfer(0x40, req, value, index, null, 0, 1000) >= 0;
    }

    // The CH340 / CH341 setup (as Linux's ch341 driver and usb-serial-for-android do).
    private static boolean ch34xInit(UsbDeviceConnection c, int baud) {
        byte[] v = new byte[2];
        c.controlTransfer(0xC0, 0x5F, 0, 0, v, 2, 1000);                   // read version
        if (!ch34xOut(c, 0xA1, 0, 0)) return false;                        // serial init
        if (!ch34xBaud(c, baud)) return false;
        if (!ch34xOut(c, 0x9A, 0x2518, 0x00C3)) return false;              // 8N1, RX + TX on
        if (!ch34xOut(c, 0xA1, 0x501F, 0xD90A)) return false;
        if (!ch34xBaud(c, baud)) return false;
        return ch34xOut(c, 0xA4, 0xFFFF, 0);                               // DTR + RTS off
    }

    private static boolean ch34xBaud(UsbDeviceConnection c, int baud) {
        long factor = 1532620800L / baud, divisor = 3;
        while (factor > 0xFFF0 && divisor > 0) {
            factor >>= 3;
            divisor--;
        }
        factor = 0x10000 - factor;
        divisor |= 0x0080;
        int v1 = (int) ((factor & 0xFF00) | divisor), v2 = (int) (factor & 0xFF);
        return ch34xOut(c, 0x9A, 0x1312, v1) && ch34xOut(c, 0x9A, 0x0F2C, v2);
    }

    private static boolean cp210xInit(UsbDeviceConnection c, int ifc, int baud) {
        if (c.controlTransfer(0x41, 0x00, 0x0001, ifc, null, 0, 1000) < 0) return false;   // IFC_ENABLE
        byte[] b = {(byte) (baud & 0xff), (byte) ((baud >> 8) & 0xff), (byte) ((baud >> 16) & 0xff),
                (byte) ((baud >> 24) & 0xff)};
        if (c.controlTransfer(0x41, 0x1E, 0, ifc, b, 4, 1000) < 0) return false;          // SET_BAUDRATE
        if (c.controlTransfer(0x41, 0x03, 0x0800, ifc, null, 0, 1000) < 0) return false;  // 8N1
        return c.controlTransfer(0x41, 0x07, 0x0300, ifc, null, 0, 1000) >= 0;             // DTR + RTS off
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
