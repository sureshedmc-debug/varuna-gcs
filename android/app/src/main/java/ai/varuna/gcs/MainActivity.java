package ai.varuna.gcs;

import android.Manifest;
import android.app.Activity;
import android.app.Dialog;
import android.content.ActivityNotFoundException;
import android.content.ContentValues;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ActivityInfo;
import android.content.pm.ApplicationInfo;
import android.content.pm.PackageManager;
import android.content.res.AssetFileDescriptor;
import android.content.res.AssetManager;
import android.graphics.Color;
import android.graphics.Rect;
import android.graphics.Typeface;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Environment;
import android.os.Handler;
import android.os.Looper;
import android.os.Message;
import android.print.PrintAttributes;
import android.print.PrintManager;
import android.provider.MediaStore;
import android.util.Base64;
import android.util.Log;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.view.WindowManager;
import android.webkit.CookieManager;
import android.webkit.GeolocationPermissions;
import android.webkit.JavascriptInterface;
import android.webkit.MimeTypeMap;
import android.webkit.PermissionRequest;
import android.webkit.URLUtil;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Button;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.TextView;
import android.widget.Toast;

import org.json.JSONObject;

import java.io.ByteArrayInputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.atomic.AtomicInteger;

/**
 * VARUNA GCS on Android.
 *
 * The page is the same built frontend as the desktop app. It is served to the
 * WebView straight from the APK (assets/www) under http://127.0.0.1:PORT, and
 * every backend path (/api, /video_feed, /stream, /tune, /boat, /local) goes
 * over the network to the app's own Node server on that port
 * (android/nodejs-project/main.js): the Pi proxy and the local records store,
 * exactly as electron/server.cjs does on the desktop.
 */
public class MainActivity extends Activity {
    private static final String TAG = "varuna";
    private static final int BASE = Color.rgb(0x0E, 0x11, 0x16);
    private static final String[] BACKEND = {"/api", "/video_feed", "/stream", "/tune", "/boat", "/local"};
    private static final int REQ_WEB_PERMISSION = 41;
    private static final int REQ_LOCATION = 42;
    private static final int REQ_FILE = 43;
    private static final int DEFAULT_PORT = 47621; // android/nodejs-project/main.js
    // The page needs WebCodecs for the drone's H.264 video (Chromium 94) and, under
    // the content policy below, 'wasm-unsafe-eval' for the AI models (97).
    private static final int MIN_WEBVIEW = 97;
    private static final Object BOOT_LOCK = new Object();
    // Same policy as the desktop app (electron/main.cjs applyCsp): scripts only
    // from the app itself, so injected markup can never reach the shell bridge.
    private static final String CSP = "default-src 'self'; "
            + "script-src 'self' 'wasm-unsafe-eval' blob:; "
            + "worker-src 'self' blob:; "
            + "style-src 'self' 'unsafe-inline'; "
            + "font-src 'self' data:; "
            + "img-src 'self' data: blob: https://server.arcgisonline.com https://*.googleusercontent.com; "
            + "media-src 'self' blob: data:; "
            + "connect-src 'self' https:; "
            + "form-action 'none'; frame-ancestors 'none'; object-src 'none'; base-uri 'self'";
    private static long lastRendererCrash = 0;
    private static int rendererCrashes = 0;

    private static final Map<String, String> MIME = new HashMap<>();

    static {
        MIME.put("html", "text/html");
        MIME.put("js", "text/javascript");
        MIME.put("mjs", "text/javascript");
        MIME.put("css", "text/css");
        MIME.put("json", "application/json");
        MIME.put("wasm", "application/wasm");
        MIME.put("onnx", "application/octet-stream");
        MIME.put("svg", "image/svg+xml");
        MIME.put("png", "image/png");
        MIME.put("jpg", "image/jpeg");
        MIME.put("jpeg", "image/jpeg");
        MIME.put("gif", "image/gif");
        MIME.put("webp", "image/webp");
        MIME.put("ico", "image/x-icon");
        MIME.put("woff", "font/woff");
        MIME.put("woff2", "font/woff2");
        MIME.put("ttf", "font/ttf");
        MIME.put("mp4", "video/mp4");
        MIME.put("webm", "video/webm");
        MIME.put("mp3", "audio/mpeg");
        MIME.put("txt", "text/plain");
    }

    private final Handler ui = new Handler(Looper.getMainLooper());
    private FrameLayout root;
    private WebView web;
    private TextView splash;
    private volatile int port = 0;
    private boolean destroyed = false;

    // Pop-up windows the page opened (window.open). Kept until the page closes them.
    private final List<WebView> popups = new ArrayList<>();
    private Dialog popupDialog;

    // Android answers one permission dialog at a time: a second request made
    // while one is open is refused at once. The page asks for the microphone
    // (wake word) and the location (Home) together on start-up, so they queue.
    private final java.util.ArrayDeque<Runnable> permissionQueue = new java.util.ArrayDeque<>();
    private boolean permissionDialogOpen = false;
    private PermissionRequest pendingWebPermission;
    private Bridge mainBridge;
    private String pendingGeoOrigin;
    private GeolocationPermissions.Callback pendingGeoCallback;
    private ValueCallback<Uri[]> pendingFile;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);

        // A ground station is a landscape screen: phones stay in landscape (either
        // way up); tablets rotate freely.
        if (getResources().getConfiguration().smallestScreenWidthDp < 600) {
            setRequestedOrientation(ActivityInfo.SCREEN_ORIENTATION_SENSOR_LANDSCAPE);
        }

        root = new FrameLayout(this);
        root.setBackgroundColor(BASE);
        // Full screen (no status / navigation bars), so the keyboard has to be
        // handled here: keep the page above it.
        root.getViewTreeObserver().addOnGlobalLayoutListener(this::fitAboveKeyboard);
        root.addOnLayoutChangeListener((v, l, t, r, b, ol, ot, or, ob) -> {
            if ((r - l) != (or - ol) && web != null) web.evaluateJavascript("window.__varunaFitViewport&&__varunaFitViewport()", null);
        });

        splash = new TextView(this);
        splash.setText("VARUNA AI\n\nStarting…");
        splash.setTextColor(Color.rgb(0xC9, 0xD3, 0xE0));
        splash.setTextSize(18);
        splash.setTypeface(Typeface.DEFAULT_BOLD);
        splash.setGravity(Gravity.CENTER);
        splash.setLineSpacing(0, 1.3f);
        splash.setPadding(48, 48, 48, 48);

        boolean debuggable = (getApplicationInfo().flags & ApplicationInfo.FLAG_DEBUGGABLE) != 0;
        WebView.setWebContentsDebuggingEnabled(debuggable);

        web = new WebView(this);
        configure(web);
        web.setVisibility(View.INVISIBLE);
        mainBridge = new Bridge();
        web.addJavascriptInterface(mainBridge, "VarunaAndroid");
        // A download the page's own handling missed (android-bridge.js saves links
        // itself): hand it back to the page, which fetches it and saves it.
        web.setDownloadListener((url, userAgent, contentDisposition, mimeType, length) -> {
            Uri u = Uri.parse(url);
            if (!isOwn(u) && !"blob".equals(u.getScheme()) && !"data".equals(u.getScheme())) return;
            String name = "blob".equals(u.getScheme()) || "data".equals(u.getScheme()) ? "" : URLUtil.guessFileName(url, contentDisposition, mimeType);
            web.evaluateJavascript("window.__varunaSaveUrl&&__varunaSaveUrl(" + JSONObject.quote(url) + "," + JSONObject.quote(name) + ")", null);
        });
        web.setWebViewClient(new AppClient(true));
        web.setWebChromeClient(new AppChrome());

        root.addView(web, new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        root.addView(splash, new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        setContentView(root);

        new Thread(this::boot, "varuna-boot").start();
    }

    /** Hide the system bars; a swipe from the edge shows them for a moment. */
    private void goFullScreen() {
        getWindow().getDecorView().setSystemUiVisibility(
                View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY
                        | View.SYSTEM_UI_FLAG_FULLSCREEN
                        | View.SYSTEM_UI_FLAG_HIDE_NAVIGATION
                        | View.SYSTEM_UI_FLAG_LAYOUT_STABLE
                        | View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN
                        | View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION);
    }

    @Override
    public void onWindowFocusChanged(boolean hasFocus) {
        super.onWindowFocusChanged(hasFocus);
        if (hasFocus) goFullScreen();
    }

    /** A full-screen window is not resized for the keyboard: pad the page up by its height. */
    private void fitAboveKeyboard() {
        if (root == null) return;
        Rect visible = new Rect();
        root.getWindowVisibleDisplayFrame(visible);
        int[] at = new int[2];
        root.getLocationOnScreen(at);
        int hidden = at[1] + root.getHeight() - visible.bottom;
        // Anything under a fifth of the screen is a system bar passing by, not a keyboard.
        int pad = hidden > root.getRootView().getHeight() / 5 ? hidden : 0;
        if (root.getPaddingBottom() != pad) root.setPadding(0, 0, 0, pad);
    }

    private void configure(WebView w) {
        w.setBackgroundColor(BASE);
        WebSettings s = w.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setDatabaseEnabled(true);
        s.setMediaPlaybackRequiresUserGesture(false);
        s.setJavaScriptCanOpenWindowsAutomatically(true);
        s.setSupportMultipleWindows(true);
        s.setGeolocationEnabled(true);
        s.setAllowFileAccess(false);
        s.setAllowContentAccess(false);
        s.setTextZoom(100); // the layout is sized in px; the system font scale would break it
        s.setUseWideViewPort(true);
        s.setLoadWithOverviewMode(true);
        s.setSupportZoom(false);
        s.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        s.setCacheMode(WebSettings.LOAD_DEFAULT);
        w.setOverScrollMode(View.OVER_SCROLL_NEVER);
        w.setScrollBarStyle(View.SCROLLBARS_INSIDE_OVERLAY);
    }

    // ------------------------------------------------------------------ start-up

    /** Unpack the server (first run / after an update), start Node, wait for its port, load the page. */
    private void boot() {
        try {
            int webView = webViewMajorVersion();
            if (webView > 0 && webView < MIN_WEBVIEW) {
                throw new IOException("Android System WebView on this phone is too old (version " + webView
                        + "). Update \"Android System WebView\" (and Chrome) in the Play Store, then open VARUNA again.");
            }
            File files = getFilesDir();
            File project = new File(files, "nodejs-project");
            File portFile = new File(files, "varuna-port");
            // One at a time: a recreated activity must not unpack the server again
            // while the first one's Node is starting from those files.
            synchronized (BOOT_LOCK) {
                if (!NodeRunner.isStarted()) {
                    long stamp = getPackageManager().getPackageInfo(getPackageName(), 0).lastUpdateTime;
                    File stampFile = new File(files, "nodejs-project.stamp");
                    if (!String.valueOf(stamp).equals(readText(stampFile)) || !new File(project, "main.js").exists()) {
                        deleteTree(project);
                        copyAssets("nodejs-project", project);
                        writeText(stampFile, String.valueOf(stamp));
                    }
                    // A port file from an earlier process is stale.
                    //noinspection ResultOfMethodCallIgnored
                    portFile.delete();
                    NodeRunner.start(new File(project, "main.js").getAbsolutePath(), files.getAbsolutePath(), NodeRunner.token());
                }
            }
            long deadline = System.currentTimeMillis() + 40000;
            String text = "";
            while (System.currentTimeMillis() < deadline) {
                text = readText(portFile).trim();
                if (!text.isEmpty()) break;
                if (NodeRunner.hasExited()) throw new IOException("The app's server stopped while starting.");
                Thread.sleep(50);
            }
            if (text.isEmpty()) throw new IOException("The app's server did not start in time.");
            if (text.startsWith("error")) throw new IOException(text);
            final int p = Integer.parseInt(text);
            final String origin = "http://127.0.0.1:" + p;
            ui.post(() -> {
                if (destroyed) return;
                port = p;
                // Only this WebView gets the server's token (see NodeRunner.token()).
                CookieManager cookies = CookieManager.getInstance();
                cookies.setAcceptCookie(true);
                cookies.setCookie(origin, "varuna_token=" + NodeRunner.token() + "; Path=/; HttpOnly; SameSite=Strict");
                if (p != DEFAULT_PORT) {
                    // Settings and logs are kept per address, and the port is part of it.
                    Toast.makeText(this, "Another app is using VARUNA's usual port, so saved settings from earlier sessions are not shown this time. They are not deleted: close the other app and restart VARUNA.", Toast.LENGTH_LONG).show();
                }
                web.loadUrl(origin + "/");
            });
        } catch (Throwable t) {
            Log.e(TAG, "boot failed", t);
            final String why = String.valueOf(t.getMessage());
            ui.post(() -> {
                if (!destroyed) splash.setText("VARUNA AI\n\nCould not start.\n" + why + "\n\nClose the app and open it again.");
            });
        }
    }

    private void copyAssets(String assetPath, File out) throws IOException {
        AssetManager am = getAssets();
        String[] children = am.list(assetPath);
        if (children == null || children.length == 0) {
            // A file (or an empty folder, which the APK does not keep).
            File parent = out.getParentFile();
            if (parent != null && !parent.isDirectory() && !parent.mkdirs()) throw new IOException("mkdir " + parent);
            try (InputStream in = am.open(assetPath); OutputStream os = new FileOutputStream(out)) {
                byte[] buf = new byte[64 * 1024];
                int n;
                while ((n = in.read(buf)) > 0) os.write(buf, 0, n);
            }
            return;
        }
        if (!out.isDirectory() && !out.mkdirs()) throw new IOException("mkdir " + out);
        for (String c : children) copyAssets(assetPath + "/" + c, new File(out, c));
    }

    private static void deleteTree(File f) {
        File[] kids = f.listFiles();
        if (kids != null) for (File k : kids) deleteTree(k);
        //noinspection ResultOfMethodCallIgnored
        f.delete();
    }

    private static String readText(File f) {
        if (!f.isFile()) return "";
        try (FileInputStream in = new FileInputStream(f)) {
            byte[] buf = new byte[256];
            int n = in.read(buf);
            return n <= 0 ? "" : new String(buf, 0, n, StandardCharsets.UTF_8);
        } catch (IOException e) {
            return "";
        }
    }

    private static void writeText(File f, String text) throws IOException {
        try (FileOutputStream os = new FileOutputStream(f)) {
            os.write(text.getBytes(StandardCharsets.UTF_8));
        }
    }

    // ------------------------------------------------------------------ URLs

    /** The app's own page origin: http://127.0.0.1:PORT. */
    private boolean isOwn(Uri u) {
        return u != null && "http".equals(u.getScheme()) && "127.0.0.1".equals(u.getHost()) && u.getPort() == port && port != 0;
    }

    private static boolean isBackend(String path) {
        for (String p : BACKEND) if (path.equals(p) || path.startsWith(p + "/")) return true;
        return false;
    }

    /** Hand a link to another app (the browser, WhatsApp, maps). */
    private boolean openExternal(Uri u) {
        // Web pages and e-mail only (as on the desktop): never intent:, file:, content: …
        String scheme = u.getScheme() == null ? "" : u.getScheme().toLowerCase(Locale.ROOT);
        if (!scheme.equals("https") && !scheme.equals("http") && !scheme.equals("mailto")) return false;
        try {
            Intent i = new Intent(Intent.ACTION_VIEW, u);
            i.addCategory(Intent.CATEGORY_BROWSABLE);
            i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            startActivity(i);
            return true;
        } catch (ActivityNotFoundException | SecurityException e) {
            Toast.makeText(this, "No app on this phone can open that link.", Toast.LENGTH_LONG).show();
            return false;
        }
    }

    /** The installed WebView's major version, or 0 if it cannot be read. */
    private static int webViewMajorVersion() {
        try {
            android.content.pm.PackageInfo info = WebView.getCurrentWebViewPackage();
            if (info == null || info.versionName == null) return 0;
            return Integer.parseInt(info.versionName.split("\\.")[0].trim());
        } catch (Exception e) {
            return 0;
        }
    }

    // ------------------------------------------------------------------ the frontend, from the APK

    private WebResourceResponse serveAsset(String path, Map<String, String> requestHeaders) {
        if (path == null || path.isEmpty()) path = "/";
        if (path.contains("..") || path.indexOf('\0') >= 0) return text(403, "Forbidden", "Forbidden");
        String rel = path.endsWith("/") ? path + "index.html" : path;
        String asset = "www" + rel;
        Opened o = open(asset);
        if (o == null) {
            // Unknown extension-less paths get the app shell; a missing asset stays
            // a 404 so a broken model / wasm URL fails loudly (same as server.cjs).
            int slash = rel.lastIndexOf('/');
            if (rel.indexOf('.', slash + 1) >= 0) return text(404, "Not Found", "Not found");
            rel = "/index.html";
            asset = "www/index.html";
            o = open(asset);
            if (o == null) return text(404, "Not Found", "Not found");
        }
        String ext = rel.substring(rel.lastIndexOf('.') + 1).toLowerCase(Locale.ROOT);
        String mime = MIME.get(ext);
        if (mime == null) mime = "application/octet-stream";
        boolean isText = mime.startsWith("text/") || mime.equals("application/json") || mime.equals("image/svg+xml");

        Map<String, String> headers = new HashMap<>();
        headers.put("X-Content-Type-Options", "nosniff");
        if (mime.equals("text/html")) {
            headers.put("Content-Security-Policy", CSP);
            headers.put("X-Frame-Options", "DENY");
        }
        // Vite fingerprints /assets/*, so those never change; the rest is re-read.
        headers.put("Cache-Control", path.startsWith("/assets/") ? "public, max-age=31536000, immutable" : "no-cache");

        int status = 200;
        String reason = "OK";
        InputStream body = o.stream;
        if (o.length >= 0) {
            headers.put("Accept-Ranges", "bytes");
            long start = 0, end = o.length - 1;
            String range = header(requestHeaders, "Range");
            if (range != null && range.startsWith("bytes=") && o.length > 0) {
                try {
                    String spec = range.substring(6).split(",")[0].trim();
                    int dash = spec.indexOf('-');
                    String a = spec.substring(0, dash).trim(), b = spec.substring(dash + 1).trim();
                    if (a.isEmpty()) {
                        start = Math.max(0, o.length - Long.parseLong(b));
                    } else {
                        start = Long.parseLong(a);
                        if (!b.isEmpty()) end = Math.min(end, Long.parseLong(b));
                    }
                    if (start > end || start >= o.length) {
                        close(o.stream);
                        headers.put("Content-Range", "bytes */" + o.length);
                        return new WebResourceResponse("text/plain", "utf-8", 416, "Range Not Satisfiable", headers, empty());
                    }
                    skipFully(o.stream, start);
                    body = new Limited(o.stream, end - start + 1);
                    status = 206;
                    reason = "Partial Content";
                    headers.put("Content-Range", "bytes " + start + "-" + end + "/" + o.length);
                } catch (Exception e) {
                    // An unreadable Range header: send the whole file.
                    close(o.stream);
                    o = open(asset);
                    if (o == null) return text(404, "Not Found", "Not found");
                    body = o.stream;
                    start = 0;
                    end = o.length - 1;
                    status = 200;
                    reason = "OK";
                }
            }
            headers.put("Content-Length", String.valueOf(end - start + 1));
        }
        return new WebResourceResponse(mime, isText ? "utf-8" : null, status, reason, headers, body);
    }

    private static final class Opened {
        final InputStream stream;
        final long length; // -1 when the asset is compressed in the APK

        Opened(InputStream stream, long length) {
            this.stream = stream;
            this.length = length;
        }
    }

    private Opened open(String asset) {
        AssetManager am = getAssets();
        try {
            AssetFileDescriptor fd = am.openFd(asset); // stored uncompressed: length known
            return new Opened(fd.createInputStream(), fd.getLength());
        } catch (IOException notStored) {
            try {
                return new Opened(am.open(asset, AssetManager.ACCESS_STREAMING), -1);
            } catch (IOException missing) {
                return null;
            }
        }
    }

    private static String header(Map<String, String> headers, String name) {
        if (headers == null) return null;
        for (Map.Entry<String, String> e : headers.entrySet()) if (name.equalsIgnoreCase(e.getKey())) return e.getValue();
        return null;
    }

    private static void skipFully(InputStream in, long n) throws IOException {
        while (n > 0) {
            long k = in.skip(n);
            if (k <= 0) {
                if (in.read() < 0) throw new IOException("EOF");
                k = 1;
            }
            n -= k;
        }
    }

    private static void close(InputStream in) {
        try {
            in.close();
        } catch (IOException ignored) {
            // nothing to do
        }
    }

    private static InputStream empty() {
        return new ByteArrayInputStream(new byte[0]);
    }

    private static WebResourceResponse text(int status, String reason, String body) {
        Map<String, String> headers = new HashMap<>();
        headers.put("Cache-Control", "no-store");
        return new WebResourceResponse("text/plain", "utf-8", status, reason, headers,
                new ByteArrayInputStream(body.getBytes(StandardCharsets.UTF_8)));
    }

    /** At most `left` bytes of the wrapped stream. */
    private static final class Limited extends InputStream {
        private final InputStream in;
        private long left;

        Limited(InputStream in, long left) {
            this.in = in;
            this.left = left;
        }

        @Override
        public int read() throws IOException {
            if (left <= 0) return -1;
            int b = in.read();
            if (b >= 0) left--;
            return b;
        }

        @Override
        public int read(byte[] b, int off, int len) throws IOException {
            if (left <= 0) return -1;
            int n = in.read(b, off, (int) Math.min(len, left));
            if (n > 0) left -= n;
            return n;
        }

        @Override
        public void close() throws IOException {
            in.close();
        }
    }

    // ------------------------------------------------------------------ WebView clients

    private class AppClient extends WebViewClient {
        private final boolean main;

        AppClient(boolean main) {
            this.main = main;
        }

        @Override
        public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
            Uri u = request.getUrl();
            if (!isOwn(u)) return null;
            String path = u.getPath();
            if (path != null && isBackend(path)) return null; // the Node server answers
            if (!"GET".equalsIgnoreCase(request.getMethod()) && !"HEAD".equalsIgnoreCase(request.getMethod())) {
                return text(405, "Method Not Allowed", "Method not allowed");
            }
            return serveAsset(path, request.getRequestHeaders());
        }

        @Override
        public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
            Uri u = request.getUrl();
            if (isOwn(u) || "about".equals(u.getScheme()) || "blob".equals(u.getScheme()) || "data".equals(u.getScheme())) return false;
            // Everything else leaves the app: the Google / fingerprint sign-in pages
            // (http://localhost:PORT, which Google only allows in a real browser),
            // maps, WhatsApp.
            if (request.isForMainFrame()) openExternal(u);
            return true;
        }

        @Override
        public void onPageStarted(WebView view, String url, android.graphics.Bitmap favicon) {
            // A reload: whatever the old page was saving will never be finished.
            if (main && mainBridge != null) mainBridge.discardAll();
        }

        @Override
        public void onPageFinished(WebView view, String url) {
            if (main) view.evaluateJavascript("window.__varunaFitViewport&&__varunaFitViewport()", null);
            if (!main || splash == null) return;
            view.setVisibility(View.VISIBLE);
            root.removeView(splash);
            splash = null;
        }

        @Override
        public boolean onRenderProcessGone(WebView view, android.webkit.RenderProcessGoneDetail detail) {
            // The page's process was killed (usually low memory). Recreating the
            // activity brings the app back instead of leaving a dead screen.
            Log.e(TAG, "render process gone, crashed=" + detail.didCrash());
            if (!main) {
                closePopup(view);
                return true;
            }
            // Bring the app back, but do not loop: a page that dies again and again
            // (not enough memory to load it) gets a message instead.
            long now = System.currentTimeMillis();
            rendererCrashes = now - lastRendererCrash < 60000 ? rendererCrashes + 1 : 1;
            lastRendererCrash = now;
            if (rendererCrashes >= 3) {
                ui.post(() -> {
                    if (destroyed) return;
                    root.removeView(view);
                    view.destroy();
                    if (web == view) web = null;
                    TextView msg = new TextView(MainActivity.this);
                    msg.setText("VARUNA AI\n\nThe app keeps running out of memory on this phone.\nClose other apps, then open VARUNA again.");
                    msg.setTextColor(Color.rgb(0xC9, 0xD3, 0xE0));
                    msg.setTextSize(18);
                    msg.setGravity(Gravity.CENTER);
                    msg.setPadding(48, 48, 48, 48);
                    root.addView(msg, new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
                });
                return true;
            }
            ui.post(MainActivity.this::recreate);
            return true;
        }
    }

    private class AppChrome extends WebChromeClient {
        @Override
        public void onPermissionRequest(final PermissionRequest request) {
            ui.post(() -> {
                if (!isOwn(request.getOrigin())) {
                    request.deny();
                    return;
                }
                List<String> need = new ArrayList<>();
                for (String r : request.getResources()) {
                    if (PermissionRequest.RESOURCE_VIDEO_CAPTURE.equals(r) && !granted(Manifest.permission.CAMERA)) need.add(Manifest.permission.CAMERA);
                    if (PermissionRequest.RESOURCE_AUDIO_CAPTURE.equals(r) && !granted(Manifest.permission.RECORD_AUDIO)) need.add(Manifest.permission.RECORD_AUDIO);
                }
                if (need.isEmpty()) {
                    grantWeb(request);
                    return;
                }
                askSystem(() -> {
                    pendingWebPermission = request;
                    requestPermissions(need.toArray(new String[0]), REQ_WEB_PERMISSION);
                });
            });
        }

        @Override
        public void onPermissionRequestCanceled(PermissionRequest request) {
            if (pendingWebPermission == request) pendingWebPermission = null;
        }

        @Override
        public void onGeolocationPermissionsShowPrompt(String origin, GeolocationPermissions.Callback callback) {
            if (!isOwn(Uri.parse(origin))) {
                callback.invoke(origin, false, false);
                return;
            }
            if (granted(Manifest.permission.ACCESS_FINE_LOCATION) || granted(Manifest.permission.ACCESS_COARSE_LOCATION)) {
                callback.invoke(origin, true, false);
                return;
            }
            askSystem(() -> {
                pendingGeoOrigin = origin;
                pendingGeoCallback = callback;
                requestPermissions(new String[]{Manifest.permission.ACCESS_FINE_LOCATION, Manifest.permission.ACCESS_COARSE_LOCATION}, REQ_LOCATION);
            });
        }

        @Override
        public boolean onShowFileChooser(WebView webView, ValueCallback<Uri[]> callback, FileChooserParams params) {
            if (pendingFile != null) pendingFile.onReceiveValue(null);
            pendingFile = callback;
            try {
                startActivityForResult(params.createIntent(), REQ_FILE);
                return true;
            } catch (ActivityNotFoundException e) {
                pendingFile = null;
                return false;
            }
        }

        /** window.open(): the sign-in pages go to the browser, the app's own windows open on top. */
        @Override
        public boolean onCreateWindow(WebView view, boolean isDialog, boolean isUserGesture, Message resultMsg) {
            final WebView popup = new WebView(MainActivity.this);
            configure(popup);
            popup.addJavascriptInterface(new Bridge(popup), "VarunaAndroid");
            final boolean[] external = {false};
            popup.setWebViewClient(new AppClient(false) {
                @Override
                public boolean shouldOverrideUrlLoading(WebView v, WebResourceRequest request) {
                    boolean leave = super.shouldOverrideUrlLoading(v, request);
                    if (leave && request.isForMainFrame()) {
                        // A link with target="_blank": it has gone to another app, so
                        // this window is not needed (nor its dialog, if it was shown).
                        external[0] = true;
                        ui.post(() -> closePopup(v));
                    }
                    return leave;
                }
            });
            popup.setWebChromeClient(new AppChrome());
            popups.add(popup);
            ((WebView.WebViewTransport) resultMsg.obj).setWebView(popup);
            resultMsg.sendToTarget();
            // An external link is known within a moment; anything else (a blank
            // window the page writes into, a camera snapshot) is shown here.
            ui.postDelayed(() -> {
                if (!destroyed && !external[0] && popups.contains(popup)) showPopup(popup);
            }, 350);
            return true;
        }

        @Override
        public void onCloseWindow(WebView window) {
            closePopup(window);
        }
    }

    /** Show a system permission dialog now, or after the one that is open. */
    private void askSystem(Runnable ask) {
        if (permissionDialogOpen) {
            permissionQueue.add(ask);
            return;
        }
        permissionDialogOpen = true;
        ask.run();
    }

    private boolean granted(String permission) {
        return checkSelfPermission(permission) == PackageManager.PERMISSION_GRANTED;
    }

    /** Grant the page the camera / microphone it asked for, as far as Android allowed it. */
    private void grantWeb(PermissionRequest request) {
        List<String> ok = new ArrayList<>();
        for (String r : request.getResources()) {
            if (PermissionRequest.RESOURCE_VIDEO_CAPTURE.equals(r) && granted(Manifest.permission.CAMERA)) ok.add(r);
            if (PermissionRequest.RESOURCE_AUDIO_CAPTURE.equals(r) && granted(Manifest.permission.RECORD_AUDIO)) ok.add(r);
        }
        try {
            if (ok.isEmpty()) request.deny();
            else request.grant(ok.toArray(new String[0]));
        } catch (IllegalStateException alreadyAnswered) {
            // the page went away
        }
    }

    @Override
    public void onRequestPermissionsResult(int requestCode, String[] permissions, int[] grantResults) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults);
        if (requestCode == REQ_WEB_PERMISSION && pendingWebPermission != null) {
            PermissionRequest r = pendingWebPermission;
            pendingWebPermission = null;
            grantWeb(r);
        } else if (requestCode == REQ_LOCATION && pendingGeoCallback != null) {
            boolean ok = granted(Manifest.permission.ACCESS_FINE_LOCATION) || granted(Manifest.permission.ACCESS_COARSE_LOCATION);
            pendingGeoCallback.invoke(pendingGeoOrigin, ok, false);
            pendingGeoCallback = null;
            pendingGeoOrigin = null;
        }
        permissionDialogOpen = false;
        Runnable next = permissionQueue.poll();
        if (next != null && !destroyed) {
            permissionDialogOpen = true;
            next.run();
        }
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        if (requestCode == REQ_FILE && pendingFile != null) {
            pendingFile.onReceiveValue(WebChromeClient.FileChooserParams.parseResult(resultCode, data));
            pendingFile = null;
        }
    }

    // ------------------------------------------------------------------ pop-up windows

    private void showPopup(final WebView popup) {
        if (popupDialog != null) popupDialog.dismiss();
        final Dialog d = new Dialog(this, android.R.style.Theme_Material_NoActionBar);
        LinearLayout col = new LinearLayout(this);
        col.setOrientation(LinearLayout.VERTICAL);
        col.setBackgroundColor(BASE);
        col.setFitsSystemWindows(true);

        LinearLayout bar = new LinearLayout(this);
        bar.setOrientation(LinearLayout.HORIZONTAL);
        bar.setGravity(Gravity.END);
        bar.setPadding(16, 8, 16, 8);
        Button print = new Button(this);
        print.setText("Print / Save as PDF");
        print.setAllCaps(false);
        print.setOnClickListener(v -> printView(popup));
        Button close = new Button(this);
        close.setText("Close");
        close.setAllCaps(false);
        close.setOnClickListener(v -> d.dismiss());
        bar.addView(print);
        bar.addView(close);

        popup.setBackgroundColor(Color.WHITE);
        popup.getSettings().setSupportZoom(true);
        popup.getSettings().setBuiltInZoomControls(true);
        popup.getSettings().setDisplayZoomControls(false);
        col.addView(bar, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));
        col.addView(popup, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 0, 1f));
        d.setContentView(col);
        d.setOnDismissListener(x -> {
            if (popupDialog == d) popupDialog = null;
            closePopup(popup);
        });
        popupDialog = d;
        d.show();
    }

    private void closePopup(WebView popup) {
        if (!popups.remove(popup)) return;
        if (popupDialog != null && popup.getParent() != null) {
            Dialog d = popupDialog;
            popupDialog = null;
            d.dismiss();
        }
        ViewGroup parent = (ViewGroup) popup.getParent();
        if (parent != null) parent.removeView(popup);
        popup.destroy();
    }

    private void printView(WebView view) {
        try {
            PrintManager pm = (PrintManager) getSystemService(Context.PRINT_SERVICE);
            String job = "VARUNA AI";
            pm.print(job, view.createPrintDocumentAdapter(job), new PrintAttributes.Builder().build());
        } catch (Exception e) {
            Toast.makeText(this, "Printing is not available on this phone.", Toast.LENGTH_LONG).show();
        }
    }

    // ------------------------------------------------------------------ page → shell

    /** Called from the page (android/web/android-bridge.js). Methods run on a WebView thread. */
    private class Bridge {
        private final WebView target; // the window that owns this bridge (null = the main one)
        private final Map<String, Save> saves = new ConcurrentHashMap<>();
        private final AtomicInteger next = new AtomicInteger(1);

        Bridge() {
            this(null);
        }

        Bridge(WebView target) {
            this.target = target;
        }

        @JavascriptInterface
        public String saveBegin(String name, String mime) {
            try {
                Save s = new Save(cleanName(name), mime);
                String id = "s" + next.getAndIncrement();
                saves.put(id, s);
                return id;
            } catch (Exception e) {
                Log.e(TAG, "saveBegin", e);
                toast("Could not save " + name + ": " + e.getMessage());
                return "";
            }
        }

        @JavascriptInterface
        public boolean saveChunk(String id, String base64) {
            Save s = saves.get(id);
            if (s == null) return false;
            try {
                s.out.write(Base64.decode(base64, Base64.DEFAULT));
                return true;
            } catch (Exception e) {
                Log.e(TAG, "saveChunk", e);
                return false;
            }
        }

        @JavascriptInterface
        public boolean saveEnd(String id) {
            Save s = saves.remove(id);
            if (s == null) return false;
            try {
                s.finish();
                toast("Saved: " + s.where);
                return true;
            } catch (Exception e) {
                Log.e(TAG, "saveEnd", e);
                s.discard();
                toast("Could not save " + s.name + ": " + e.getMessage());
                return false;
            }
        }

        @JavascriptInterface
        public void saveAbort(String id, String why) {
            Save s = saves.remove(id);
            if (s == null) return;
            s.discard();
            toast("Could not save " + s.name + ": " + why);
        }

        @JavascriptInterface
        public void saveFailed(String name, String why) {
            toast("Could not save " + name + ": " + why);
        }

        /** The width of the app's window in dp (CSS px at scale 1), for the page's viewport. */
        @JavascriptInterface
        public int viewWidthDp() {
            View v = root;
            float density = getResources().getDisplayMetrics().density;
            int px = v != null && v.getWidth() > 0 ? v.getWidth() : getResources().getDisplayMetrics().widthPixels;
            return Math.round(px / density);
        }

        /** Open a web or mailto link in another app. False if it is not one. */
        @JavascriptInterface
        public boolean openExternal(String url) {
            final Uri u;
            try {
                u = Uri.parse(String.valueOf(url));
            } catch (Exception e) {
                return false;
            }
            String scheme = u.getScheme() == null ? "" : u.getScheme().toLowerCase(Locale.ROOT);
            if (!scheme.equals("https") && !scheme.equals("http") && !scheme.equals("mailto")) return false;
            if (isOwn(u)) return false; // the app's own pages never leave it
            ui.post(() -> {
                if (!destroyed) MainActivity.this.openExternal(u);
            });
            return true;
        }

        /** Drop files that were being written when the page went away. */
        void discardAll() {
            for (String id : new ArrayList<>(saves.keySet())) {
                Save s = saves.remove(id);
                if (s != null) s.discard();
            }
        }

        /** Print the pop-up window that is open on top (called by the page that opened it). */
        @JavascriptInterface
        public void printPopup() {
            // The page may ask a moment before the window is on screen: wait for it.
            ui.postDelayed(() -> {
                if (destroyed || popupDialog == null) return;
                for (int i = popups.size() - 1; i >= 0; i--) {
                    WebView p = popups.get(i);
                    if (p.getParent() != null) {
                        printView(p);
                        return;
                    }
                }
            }, 500);
        }

        @JavascriptInterface
        public void print() {
            ui.post(() -> {
                if (!destroyed) printView(target != null ? target : web);
            });
        }
    }

    private void toast(final String text) {
        ui.post(() -> {
            if (!destroyed) Toast.makeText(MainActivity.this, text, Toast.LENGTH_LONG).show();
        });
    }

    private static String cleanName(String name) {
        String n = String.valueOf(name).replaceAll("[\\\\/:*?\"<>|\\x00-\\x1f]", "_").trim();
        if (n.isEmpty() || n.startsWith(".")) n = "download" + n;
        return n.length() > 120 ? n.substring(n.length() - 120) : n;
    }

    /** One file being written to the phone's Downloads/VARUNA folder. */
    private final class Save {
        final String name;
        String where;
        OutputStream out;
        private Uri uri;   // Android 10+: a MediaStore entry
        private File file; // older: the app's own Downloads folder

        Save(String name, String mime) throws IOException {
            this.name = name;
            if (mime == null || mime.isEmpty() || mime.indexOf('/') < 0) {
                String ext = name.contains(".") ? name.substring(name.lastIndexOf('.') + 1).toLowerCase(Locale.ROOT) : "";
                mime = MimeTypeMap.getSingleton().getMimeTypeFromExtension(ext);
                if (mime == null) mime = "application/octet-stream";
            }
            int semi = mime.indexOf(';');
            if (semi > 0) mime = mime.substring(0, semi).trim();
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                ContentValues v = new ContentValues();
                v.put(MediaStore.Downloads.DISPLAY_NAME, name);
                v.put(MediaStore.Downloads.MIME_TYPE, mime);
                v.put(MediaStore.Downloads.RELATIVE_PATH, Environment.DIRECTORY_DOWNLOADS + "/VARUNA");
                v.put(MediaStore.Downloads.IS_PENDING, 1);
                uri = getContentResolver().insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, v);
                if (uri == null) throw new IOException("the Downloads folder is not available");
                out = getContentResolver().openOutputStream(uri);
                if (out == null) throw new IOException("the Downloads folder is not writable");
                where = "Downloads/VARUNA/" + name;
            } else {
                File dir = getExternalFilesDir(Environment.DIRECTORY_DOWNLOADS);
                if (dir == null) dir = new File(getFilesDir(), "downloads");
                if (!dir.isDirectory() && !dir.mkdirs()) throw new IOException("cannot create " + dir);
                file = new File(dir, name);
                out = new FileOutputStream(file);
                where = file.getAbsolutePath();
            }
        }

        void finish() throws IOException {
            out.close();
            if (uri != null && Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                ContentValues v = new ContentValues();
                v.put(MediaStore.Downloads.IS_PENDING, 0);
                getContentResolver().update(uri, v, null, null);
            }
        }

        void discard() {
            try {
                out.close();
            } catch (IOException ignored) {
                // already closed
            }
            try {
                if (uri != null) getContentResolver().delete(uri, null, null);
                else if (file != null) //noinspection ResultOfMethodCallIgnored
                    file.delete();
            } catch (Exception ignored) {
                // nothing more to do
            }
        }
    }

    // ------------------------------------------------------------------ lifecycle

    @Override
    public void onBackPressed() {
        if (web != null && web.canGoBack()) web.goBack();
        else moveTaskToBack(true); // keep the mission, the server and the session alive
    }

    // The page is paused only when the app really leaves the screen (onStop),
    // not when a permission dialog or the notification shade covers it (onPause):
    // pausing there stopped the Home video and the camera for good.
    @Override
    protected void onStart() {
        super.onStart();
        if (web == null) return;
        web.onResume(); // the page restarts its own videos (android-bridge.js)
        // Node cannot be restarted inside this process: start a fresh one.
        if (NodeRunner.hasExited()) {
            Toast.makeText(this, "VARUNA's server stopped. Open the app again.", Toast.LENGTH_LONG).show();
            finishAndRemoveTask();
            ui.postDelayed(() -> android.os.Process.killProcess(android.os.Process.myPid()), 400);
        }
    }

    @Override
    protected void onStop() {
        if (web != null) web.onPause();
        super.onStop();
    }

    @Override
    protected void onDestroy() {
        destroyed = true;
        ui.removeCallbacksAndMessages(null);
        if (popupDialog != null) popupDialog.dismiss();
        for (WebView p : new ArrayList<>(popups)) closePopup(p);
        if (pendingFile != null) pendingFile.onReceiveValue(null);
        if (mainBridge != null) mainBridge.discardAll();
        if (web != null) {
            root.removeView(web);
            web.destroy();
            web = null;
        }
        super.onDestroy();
    }
}
