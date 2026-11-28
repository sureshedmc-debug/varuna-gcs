package ai.varuna.cam;

import android.Manifest;
import android.app.Activity;
import android.content.Intent;
import android.hardware.usb.UsbManager;
import android.content.pm.PackageManager;
import android.graphics.Color;
import android.graphics.Typeface;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.provider.Settings;
import android.text.InputType;
import android.view.Gravity;
import android.view.View;
import android.view.WindowManager;
import android.widget.Button;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;
import android.widget.Toast;

import java.util.ArrayList;
import java.util.List;

/**
 * Start/stop screen for the camera stream. Opened with the boolean extra
 * "background" (from the VARUNA-Start shortcut) it starts streaming and then
 * steps aside, so Termux comes back to the front.
 */
public class MainActivity extends Activity {
    private static final int REQ = 1;
    private final Handler ui = new Handler(Looper.getMainLooper());
    private TextView status;
    private TextView overlayHint;
    private Button toggle;
    private Button overlayBtn;
    private Button[] qButtons;
    private Button homeBtn;
    private Button locBtn;
    private Button shutterBtn;
    private Button webcamBtn;
    private TextView tailnetLine;
    private EditText laptopInput;
    private boolean background;
    private boolean locationAsked;

    private final Runnable tick = new Runnable() {
        @Override
        public void run() {
            refresh();
            ui.postDelayed(this, 1000);
        }
    };

    @Override
    protected void onCreate(Bundle saved) {
        super.onCreate(saved);
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        int pad = dp(20);

        LinearLayout root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        root.setPadding(pad, pad, pad, pad);
        root.setBackgroundColor(Color.rgb(8, 18, 32));

        TextView title = new TextView(this);
        title.setText("VARUNA Cam");
        title.setTextColor(Color.WHITE);
        title.setTextSize(26);
        title.setTypeface(Typeface.DEFAULT_BOLD);
        root.addView(title);

        TextView sub = new TextView(this);
        sub.setText("Sends this phone's camera and GPS to the VARUNA app over Tailscale (or the same Wi-Fi).");
        sub.setTextColor(Color.rgb(150, 175, 200));
        sub.setTextSize(14);
        sub.setPadding(0, dp(4), 0, dp(14));
        root.addView(sub);

        // This phone's Tailscale address, so it's easy to read off / copy.
        tailnetLine = new TextView(this);
        tailnetLine.setTextColor(Color.rgb(120, 220, 160));
        tailnetLine.setTextSize(14);
        tailnetLine.setTypeface(Typeface.MONOSPACE);
        tailnetLine.setPadding(0, 0, 0, dp(12));
        root.addView(tailnetLine);

        // The laptop's Tailscale address: where this phone announces itself. Only a
        // backup - the laptop normally finds this phone by its Tailscale name
        // (varuna-drone-cam) by itself.
        TextView nbTitle = new TextView(this);
        nbTitle.setText("Laptop Tailscale address (optional, e.g. varuna-laptop)");
        nbTitle.setTextColor(Color.rgb(150, 175, 200));
        nbTitle.setTextSize(13);
        root.addView(nbTitle);

        LinearLayout nbRow = new LinearLayout(this);
        nbRow.setOrientation(LinearLayout.HORIZONTAL);
        laptopInput = new EditText(this);
        laptopInput.setHint("varuna-laptop or 100.x.x.x");
        laptopInput.setHintTextColor(Color.rgb(110, 130, 150));
        laptopInput.setTextColor(Color.WHITE);
        laptopInput.setTextSize(16);
        laptopInput.setSingleLine(true);
        laptopInput.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_URI);
        laptopInput.setText(LaptopLink.raw(this));
        nbRow.addView(laptopInput, new LinearLayout.LayoutParams(0, dp(52), 1f));
        Button nbSave = new Button(this);
        nbSave.setText("Save");
        nbSave.setAllCaps(false);
        nbSave.setOnClickListener(new View.OnClickListener() {
            @Override
            public void onClick(View v) {
                LaptopLink.set(MainActivity.this, laptopInput.getText().toString());
                Toast.makeText(MainActivity.this, "Saved. Announcing to the laptop over Tailscale.",
                        Toast.LENGTH_SHORT).show();
                refresh();
            }
        });
        nbRow.addView(nbSave, new LinearLayout.LayoutParams(dp(84), dp(52)));
        LinearLayout.LayoutParams nbLp = new LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT);
        nbLp.bottomMargin = dp(18);
        root.addView(nbRow, nbLp);

        toggle = new Button(this);
        toggle.setTextSize(18);
        toggle.setOnClickListener(new View.OnClickListener() {
            @Override
            public void onClick(View v) {
                if (CamService.running != null) stopStream();
                else startStream();
            }
        });
        root.addView(toggle, new LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, dp(64)));

        TextView qTitle = new TextView(this);
        qTitle.setText("Video quality");
        qTitle.setTextColor(Color.rgb(150, 175, 200));
        qTitle.setTextSize(13);
        qTitle.setPadding(0, dp(16), 0, dp(4));
        root.addView(qTitle);
        LinearLayout qRow = new LinearLayout(this);
        qRow.setOrientation(LinearLayout.HORIZONTAL);
        qButtons = new Button[Quality.ALL.length];
        for (int i = 0; i < Quality.ALL.length; i++) {
            final Quality q = Quality.ALL[i];
            Button b = new Button(this);
            b.setText(q.label);
            b.setAllCaps(false);
            b.setOnClickListener(new View.OnClickListener() {
                @Override
                public void onClick(View v) {
                    Quality.set(MainActivity.this, q);
                    CamService s = CamService.running;
                    if (s != null) s.applyQuality();
                    refresh();
                }
            });
            qButtons[i] = b;
            qRow.addView(b, new LinearLayout.LayoutParams(0, dp(52), 1f));
        }
        root.addView(qRow);

        // Short exposures so the drone's vibration doesn't smear the pictures.
        shutterBtn = new Button(this);
        shutterBtn.setAllCaps(false);
        shutterBtn.setOnClickListener(new View.OnClickListener() {
            @Override
            public void onClick(View v) {
                Shutter.set(MainActivity.this, !Shutter.enabled(MainActivity.this));
                CamService s = CamService.running;
                if (s != null) s.applyQuality();   // reopens the camera with it
                refresh();
            }
        });
        LinearLayout.LayoutParams slp = new LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, dp(52));
        slp.topMargin = dp(8);
        root.addView(shutterBtn, slp);

        // A USB webcam on the phone's port (OTG adapter) as the video instead of the phone's camera.
        webcamBtn = new Button(this);
        webcamBtn.setAllCaps(false);
        webcamBtn.setOnClickListener(new View.OnClickListener() {
            @Override
            public void onClick(View v) {
                UsbCam.set(MainActivity.this, !UsbCam.enabled(MainActivity.this));
                CamService s = CamService.running;
                if (s != null) s.switchCamera("Changing the camera", 0);
                refresh();
            }
        });
        LinearLayout.LayoutParams wlp = new LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, dp(52));
        wlp.topMargin = dp(8);
        root.addView(webcamBtn, wlp);

        homeBtn = new Button(this);
        homeBtn.setText("Set take-off point here (height 0)");
        homeBtn.setAllCaps(false);
        homeBtn.setOnClickListener(new View.OnClickListener() {
            @Override
            public void onClick(View v) {
                CamService s = CamService.running;
                if (s != null) s.setHome();
                refresh();
            }
        });
        LinearLayout.LayoutParams hlp = new LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, dp(52));
        hlp.topMargin = dp(12);
        root.addView(homeBtn, hlp);

        locBtn = new Button(this);
        locBtn.setAllCaps(false);
        locBtn.setOnClickListener(new View.OnClickListener() {
            @Override
            public void onClick(View v) {
                if (!PhoneLocation.allowed(MainActivity.this)) {
                    // Denied twice: Android only lets the user turn it on in the app's settings.
                    startActivity(new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS,
                            Uri.parse("package:" + getPackageName())));
                } else {
                    startActivity(new Intent(Settings.ACTION_LOCATION_SOURCE_SETTINGS));
                }
            }
        });
        LinearLayout.LayoutParams llp = new LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, dp(52));
        llp.topMargin = dp(8);
        root.addView(locBtn, llp);

        overlayBtn = new Button(this);
        overlayBtn.setText("Allow display over other apps");
        overlayBtn.setOnClickListener(new View.OnClickListener() {
            @Override
            public void onClick(View v) {
                startActivity(new Intent(Settings.ACTION_MANAGE_OVERLAY_PERMISSION,
                        Uri.parse("package:" + getPackageName())));
            }
        });
        LinearLayout.LayoutParams olp = new LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, dp(56));
        olp.topMargin = dp(12);
        root.addView(overlayBtn, olp);

        overlayHint = new TextView(this);
        overlayHint.setText("Needed to keep streaming with VARUNA Cam in the background: "
                + "without it the phone closes the camera. It shows a small LIVE badge.");
        overlayHint.setTextColor(Color.rgb(255, 190, 90));
        overlayHint.setTextSize(13);
        overlayHint.setPadding(0, dp(6), 0, 0);
        root.addView(overlayHint);

        status = new TextView(this);
        status.setTextColor(Color.rgb(220, 230, 240));
        status.setTextSize(15);
        status.setTypeface(Typeface.MONOSPACE);
        status.setPadding(0, dp(20), 0, dp(20));
        root.addView(status);

        TextView tips = new TextView(this);
        tips.setText("Keep it running: lock VARUNA Cam in Recents and allow it background power use. "
                + "Stop it from here or from its notification.");
        tips.setTextColor(Color.rgb(150, 175, 200));
        tips.setTextSize(13);
        tips.setGravity(Gravity.START);
        root.addView(tips);

        ScrollView scroll = new ScrollView(this);
        scroll.setBackgroundColor(Color.rgb(8, 18, 32));
        scroll.addView(root);
        setContentView(scroll);

        handleIntent(getIntent());
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        handleIntent(intent);
    }

    private void handleIntent(Intent intent) {
        background = intent != null && intent.getBooleanExtra("background", false);
        // Opened by plugging in the USB webcam (VARUNA Cam is its app): use it now.
        if (intent != null && UsbManager.ACTION_USB_DEVICE_ATTACHED.equals(intent.getAction())) {
            CamService s = CamService.running;
            if (s != null && UsbCam.enabled(this)) s.switchCamera("USB webcam plugged in: opening it", 300);
        }
        // Opened from the shortcut or the launcher: start streaming straight away.
        if (CamService.running == null) startStream();
        else if (background) stepAside();
    }

    @Override
    protected void onResume() {
        super.onResume();
        ui.post(tick);
    }

    @Override
    protected void onPause() {
        ui.removeCallbacks(tick);
        super.onPause();
    }

    private void startStream() {
        List<String> need = new ArrayList<>();
        if (checkSelfPermission(Manifest.permission.CAMERA) != PackageManager.PERMISSION_GRANTED) {
            need.add(Manifest.permission.CAMERA);
        }
        if (Build.VERSION.SDK_INT >= 33
                && checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
            need.add(Manifest.permission.POST_NOTIFICATIONS);
        }
        // The phone's GPS is the drone's position. Asked once per start: without
        // it the video still streams.
        if (!locationAsked && !PhoneLocation.allowed(this)) {
            need.add(Manifest.permission.ACCESS_FINE_LOCATION);
            need.add(Manifest.permission.ACCESS_COARSE_LOCATION);
        }
        locationAsked = true;
        if (!need.isEmpty()) {
            requestPermissions(need.toArray(new String[0]), REQ);
            return;
        }
        // Started while this screen is in front, so Android lets the service keep the camera in the background.
        startForegroundService(new Intent(this, CamService.class));
        ui.postDelayed(new Runnable() {
            @Override
            public void run() {
                refresh();
            }
        }, 300);
        if (background) stepAside();
    }

    private void stepAside() {
        background = false;
        ui.postDelayed(new Runnable() {
            @Override
            public void run() {
                moveTaskToBack(true);
            }
        }, 1500);
    }

    private void stopStream() {
        stopService(new Intent(this, CamService.class));
        ui.postDelayed(new Runnable() {
            @Override
            public void run() {
                refresh();
            }
        }, 300);
    }

    @Override
    public void onRequestPermissionsResult(int requestCode, String[] permissions, int[] results) {
        super.onRequestPermissionsResult(requestCode, permissions, results);
        if (checkSelfPermission(Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED) {
            startStream();
        } else {
            status.setText("VARUNA Cam needs the Camera permission to stream. Tap Start and allow it.");
        }
    }

    private void refresh() {
        List<String> ips = CamService.addresses();
        String nb = "";
        for (String ip : ips) {
            if (ip.startsWith("100.")) {    // Tailscale
                nb = ip;
                break;
            }
        }
        if (nb.isEmpty() && !ips.isEmpty()) nb = ips.get(0);
        if (nb.isEmpty()) {
            tailnetLine.setText("This phone: no network yet — turn on Tailscale (or Wi-Fi)");
        } else {
            tailnetLine.setText("This phone: http://" + nb + ":8080"
                    + (nb.startsWith("100.") ? "   ✓ Tailscale" : "   (Tailscale off - no 100.x yet)"));
        }

        Quality cur = Quality.get(this);
        for (int i = 0; i < qButtons.length; i++) {
            boolean on = Quality.ALL[i] == cur;
            qButtons[i].setText((on ? "✓ " : "") + Quality.ALL[i].label);
            qButtons[i].setTypeface(on ? Typeface.DEFAULT_BOLD : Typeface.DEFAULT);
        }
        android.hardware.usb.UsbDevice cam = UsbCam.find(this);
        webcamBtn.setText(UsbCam.enabled(this)
                ? "✓ USB webcam when plugged in" + (cam != null ? " (" + UsbCam.label(cam) + ")" : " (none plugged in now)")
                : "USB webcam: off, the phone camera only (tap to use a webcam)");
        shutterBtn.setText(Shutter.enabled(this)
                ? "✓ Fast shutter for flight (sharp when the drone shakes)"
                : "Fast shutter for flight: off (tap to turn on)");
        boolean overlayOk = Settings.canDrawOverlays(this);
        overlayBtn.setVisibility(overlayOk ? View.GONE : View.VISIBLE);
        overlayHint.setVisibility(overlayOk ? View.GONE : View.VISIBLE);
        CamService s = CamService.running;
        if (s != null && overlayOk) s.showOverlay();   // allowed just now: show the badge
        boolean locOk = PhoneLocation.allowed(this);
        android.location.LocationManager lm = (android.location.LocationManager) getSystemService(LOCATION_SERVICE);
        boolean gpsOn = lm != null && lm.isProviderEnabled(android.location.LocationManager.GPS_PROVIDER);
        if (!locOk) {
            locBtn.setText("Allow Location (the drone's position comes from this phone's GPS)");
            locBtn.setVisibility(View.VISIBLE);
        } else if (!gpsOn) {
            locBtn.setText("Turn on Location (GPS) in the phone's settings");
            locBtn.setVisibility(View.VISIBLE);
        } else {
            locBtn.setVisibility(View.GONE);
        }
        homeBtn.setVisibility(s != null && locOk ? View.VISIBLE : View.GONE);
        if (s != null && locOk && !s.locationRunning()) s.restartLocation();   // allowed just now
        if (s != null) {
            toggle.setText("Stop streaming");
            status.setText(s.statusText());
        } else {
            toggle.setText("Start streaming");
            boolean camOk = checkSelfPermission(Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED;
            status.setText(camOk ? "Stopped." : "VARUNA Cam needs the Camera permission to stream. Tap Start and allow it.");
        }
    }

    private int dp(int v) {
        return Math.round(v * getResources().getDisplayMetrics().density);
    }
}
