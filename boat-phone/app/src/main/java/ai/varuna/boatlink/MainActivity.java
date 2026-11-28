package ai.varuna.boatlink;

import android.Manifest;
import android.annotation.SuppressLint;
import android.app.Activity;
import android.app.AlertDialog;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.graphics.Color;
import android.graphics.Typeface;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.os.PowerManager;
import android.provider.Settings;
import android.view.Gravity;
import android.view.WindowManager;
import android.widget.Button;
import android.graphics.drawable.GradientDrawable;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;

import java.util.ArrayList;
import java.util.List;

/** One screen: what the phone is doing for the boat. The work runs in LinkService. */
public class MainActivity extends Activity {
    private TextView status, headline, captainLine;
    private Button battery, captainWatch, captainFull, captainStop;
    private final Handler ui = new Handler(Looper.getMainLooper());

    @Override
    protected void onCreate(Bundle saved) {
        super.onCreate(saved);
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);

        LinearLayout root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        root.setPadding(32, 24, 32, 24);
        root.setBackgroundColor(Color.rgb(10, 22, 34));

        headline = new TextView(this);
        headline.setTextSize(22);
        headline.setTypeface(Typeface.DEFAULT_BOLD);
        headline.setTextColor(Color.WHITE);
        root.addView(headline);

        LinearLayout buttons = new LinearLayout(this);
        buttons.setOrientation(LinearLayout.HORIZONTAL);
        buttons.setGravity(Gravity.START);
        battery = new Button(this);
        battery.setText("Let it run in the background");
        battery.setOnClickListener(v -> askBattery());
        buttons.addView(battery);
        Button stop = new Button(this);
        stop.setText("Stop");
        stop.setOnClickListener(v -> {
            stopService(new Intent(this, LinkService.class));
            finish();
        });
        buttons.addView(stop);
        root.addView(buttons);

        // ---- AI captain: WATCH ONLY | FULL CONTROL, and a big STOP
        TextView ct = new TextView(this);
        ct.setText("AI CAPTAIN");
        ct.setTextSize(13);
        ct.setTypeface(Typeface.DEFAULT_BOLD);
        ct.setTextColor(Color.rgb(150, 170, 190));
        ct.setPadding(0, 20, 0, 4);
        root.addView(ct);
        LinearLayout seg = new LinearLayout(this);
        seg.setOrientation(LinearLayout.HORIZONTAL);
        captainWatch = new Button(this);
        captainWatch.setText("Watch only");
        captainWatch.setOnClickListener(v -> {
            LinkService s = LinkService.instance;
            if (s != null && (s.captainFull || s.captainDriving)) s.captainStop("switched to watch only on the phone", true);
        });
        captainFull = new Button(this);
        captainFull.setText("Full control");
        captainFull.setOnClickListener(v -> askFullControl());
        seg.addView(captainWatch, new LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1));
        seg.addView(captainFull, new LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1));
        root.addView(seg);
        captainStop = new Button(this);
        captainStop.setText("STOP CAPTAIN");
        captainStop.setTextSize(20);
        captainStop.setTypeface(Typeface.DEFAULT_BOLD);
        captainStop.setTextColor(Color.WHITE);
        captainStop.setBackground(round(Color.rgb(220, 38, 38)));
        captainStop.setOnClickListener(v -> {
            LinkService s = LinkService.instance;
            if (s != null) s.captainStop("STOP CAPTAIN pressed on the phone", true);
        });
        root.addView(captainStop, new LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, 150));
        captainLine = new TextView(this);
        captainLine.setTextSize(15);
        captainLine.setTextColor(Color.WHITE);
        captainLine.setPadding(0, 8, 0, 12);
        root.addView(captainLine);

        status = new TextView(this);
        status.setTextSize(15);
        status.setTextColor(Color.rgb(220, 232, 240));
        status.setTypeface(Typeface.MONOSPACE);
        ScrollView sv = new ScrollView(this);
        sv.addView(status);
        root.addView(sv);
        setContentView(root);

        askPermissions();
    }

    private void askPermissions() {
        List<String> want = new ArrayList<>();
        want.add(Manifest.permission.ACCESS_FINE_LOCATION);
        want.add(Manifest.permission.ACCESS_COARSE_LOCATION);
        want.add(Manifest.permission.CAMERA);
        if (Build.VERSION.SDK_INT >= 33) want.add(Manifest.permission.POST_NOTIFICATIONS);
        List<String> missing = new ArrayList<>();
        for (String p : want) if (checkSelfPermission(p) != PackageManager.PERMISSION_GRANTED) missing.add(p);
        if (missing.isEmpty()) startLink();
        else requestPermissions(missing.toArray(new String[0]), 1);
    }

    @Override
    public void onRequestPermissionsResult(int code, String[] perms, int[] results) {
        startLink();                                    // runs with whatever was allowed
    }

    private void startLink() {
        Intent i = new Intent(this, LinkService.class);
        if (Build.VERSION.SDK_INT >= 26) startForegroundService(i);
        else startService(i);
    }

    private static GradientDrawable round(int color) {
        GradientDrawable d = new GradientDrawable();
        d.setColor(color);
        d.setCornerRadius(24);
        return d;
    }

    /** Full control only after the person on the phone has read the checks and said yes. */
    private void askFullControl() {
        LinkService s = LinkService.instance;
        if (s == null || s.pilot == null) return;
        if (s.captainFull) return;
        new AlertDialog.Builder(this)
                .setTitle("Give the boat to the AI captain?")
                .setMessage("The captain will steer and set the throttle by itself.\n\n"
                        + "It only drives when:\n"
                        + " - the VARUNA brain is connected and the boat is ARMED (by you)\n"
                        + " - GPS and the compass are good\n"
                        + " - the boat is in HOLD (SwD down) - it then takes MANUAL\n"
                        + " - it stays within " + Math.round(LinkService.CAPTAIN_MAX_FROM_HOME_M) + " m of home\n\n"
                        + "To take the boat back at any time: flip SwD UP on the FS-i6 (the radio always wins), "
                        + "or press STOP CAPTAIN. It goes back to watch only by itself if anything is wrong.\n\n"
                        + "It was trained in a simulator and has not driven this boat before: "
                        + "start on calm, open water with the radio in your hand.")
                .setPositiveButton("Yes, captain drives", (d, w) -> s.captainStartFull())
                .setNegativeButton("Cancel", null)
                .show();
    }

    @SuppressLint("BatteryLife")
    private void askBattery() {
        try {
            startActivity(new Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS,
                    Uri.parse("package:" + getPackageName())));
        } catch (Exception e) {
            startActivity(new Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS));
        }
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        startLink();                                    // e.g. the boat brain was just plugged in
    }

    @Override
    protected void onResume() {
        super.onResume();
        ui.post(refresh);
    }

    @Override
    protected void onPause() {
        super.onPause();
        ui.removeCallbacks(refresh);
    }

    private final Runnable refresh = new Runnable() {
        @Override
        public void run() {
            LinkService s = LinkService.instance;
            if (s == null) {
                headline.setText("Starting...");
                headline.setTextColor(Color.YELLOW);
                status.setText("");
            } else {
                boolean px = s.pixhawkTalking();
                boolean gps = s.lastFix != null && System.currentTimeMillis() - s.lastFix.getTime() < 5000;
                String brain = s.brainR4 ? s.brainName.replace(" boat brain", " brain") : "boat brain";
                if (px && gps) {
                    headline.setText("BOAT READY - " + brain + " + GPS OK");
                    headline.setTextColor(Color.rgb(90, 220, 120));
                } else if (px) {
                    headline.setText(brain + " OK - waiting for GPS (go outdoors)");
                    headline.setTextColor(Color.YELLOW);
                } else {
                    headline.setText("Waiting for the boat brain (USB OTG)");
                    headline.setTextColor(Color.rgb(255, 120, 100));
                }
                status.setText(s.statusText());
                CaptainPilot cp = s.pilot;
                boolean full = s.captainFull || s.captainDriving;
                captainWatch.setBackground(round(full ? Color.rgb(40, 52, 66) : Color.rgb(14, 116, 144)));
                captainWatch.setTextColor(Color.WHITE);
                captainFull.setBackground(round(s.captainDriving ? Color.rgb(21, 128, 61) : full ? Color.rgb(180, 83, 9) : Color.rgb(40, 52, 66)));
                captainFull.setTextColor(Color.WHITE);
                captainFull.setEnabled(cp != null);
                captainStop.setAlpha(full ? 1f : 0.55f);
                String line = cp == null ? s.captainError
                        : s.captainModeText() + (cp.ready ? String.format(java.util.Locale.US, "  |  thr %.0f%%  steer %s %.2f  |  %s",
                        cp.outThr * 100, cp.outSteer >= 0 ? "R" : "L", Math.abs(cp.outSteer), cp.goal) : "  |  " + cp.why);
                if (!s.captainNote.isEmpty()) line += "\n" + s.captainNote;
                captainLine.setText(line);
                captainLine.setTextColor(s.captainDriving ? Color.rgb(90, 220, 120) : full ? Color.YELLOW : Color.rgb(200, 215, 230));
            }
            PowerManager pm = (PowerManager) getSystemService(POWER_SERVICE);
            battery.setEnabled(!pm.isIgnoringBatteryOptimizations(getPackageName()));
            ui.postDelayed(this, 500);
        }
    };
}
