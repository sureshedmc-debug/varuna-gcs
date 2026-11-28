package ai.varuna.cam;

import android.content.Context;
import android.content.SharedPreferences;

import java.util.ArrayList;
import java.util.List;

/**
 * The laptop's Tailscale address(es) or name(s) this phone announces itself to.
 *
 * Over Tailscale the laptop can't find the phone by a broadcast (a WireGuard
 * tunnel carries no broadcast), so instead the phone tells the laptop where it
 * is: it sends a small "I'm here at 100.x" packet to this address every few
 * seconds (see CamService.startAnnounce). The laptop's listener writes that
 * address into phone_ip.txt, and the VARUNA backend connects to it — no IP to
 * type, and it follows the phone if its Tailscale address ever changes.
 * (Usually not needed: the laptop finds this phone by its Tailscale name.)
 *
 * Several laptops may be listed, separated by a space or comma. Empty = the
 * phone only answers when asked (the old same-Wi-Fi way), which still works.
 */
final class LaptopLink {
    private static final String PREFS = "varuna_cam";
    private static final String KEY = "laptop_addr";

    private LaptopLink() {
    }

    /** The saved text, exactly as typed (for the settings box). */
    static String raw(Context c) {
        return prefs(c).getString(KEY, "");
    }

    static void set(Context c, String value) {
        prefs(c).edit().putString(KEY, value == null ? "" : value.trim()).apply();
    }

    /** The addresses to announce to: trimmed, blanks dropped. */
    static List<String> addresses(Context c) {
        List<String> out = new ArrayList<>();
        for (String part : raw(c).replace(",", " ").split("\\s+")) {
            String ip = part.trim();
            if (!ip.isEmpty()) out.add(ip);
        }
        return out;
    }

    private static SharedPreferences prefs(Context c) {
        return c.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }
}
