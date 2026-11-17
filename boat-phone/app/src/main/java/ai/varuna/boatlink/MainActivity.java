package ai.varuna.boatlink;

import android.Manifest;
import android.annotation.SuppressLint;
import android.app.Activity;
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
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;

import java.util.ArrayList;
import java.util.List;

/** One screen: what the phone is doing for the boat. The work runs in LinkService. */
public class MainActivity extends Activity {
    private TextView status, headline;
    private Button battery;
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
        startLink();                                    // e.g. the Pixhawk was just plugged in
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
                if (px && gps) {
                    headline.setText("BOAT READY - Pixhawk + GPS OK");
                    headline.setTextColor(Color.rgb(90, 220, 120));
                } else if (px) {
                    headline.setText("Pixhawk OK - waiting for GPS (go outdoors)");
                    headline.setTextColor(Color.YELLOW);
                } else {
                    headline.setText("Waiting for the Pixhawk (USB OTG)");
                    headline.setTextColor(Color.rgb(255, 120, 100));
                }
                status.setText(s.statusText());
            }
            PowerManager pm = (PowerManager) getSystemService(POWER_SERVICE);
            battery.setEnabled(!pm.isIgnoringBatteryOptimizations(getPackageName()));
            ui.postDelayed(this, 1000);
        }
    };
}
