package ai.varuna.gcs;

import java.security.SecureRandom;

/** Runs the app's Node server (nodejs-mobile). Node can be started once per process. */
final class NodeRunner {
    static {
        System.loadLibrary("node");
        System.loadLibrary("native-lib");
    }

    private static boolean started = false;
    private static volatile boolean exited = false;
    private static String token;

    private NodeRunner() {}

    /**
     * The secret for this run of the app. The server answers only requests that
     * carry it, and only the app's own WebView is given it (as a cookie), so
     * other apps on the phone cannot use the server on 127.0.0.1.
     */
    static synchronized String token() {
        if (token == null) {
            byte[] b = new byte[32];
            new SecureRandom().nextBytes(b);
            StringBuilder sb = new StringBuilder(64);
            for (byte x : b) sb.append(String.format("%02x", x));
            token = sb.toString();
        }
        return token;
    }

    /** Start Node on its own thread with this script and arguments. Later calls do nothing. */
    static synchronized boolean start(final String script, final String... args) {
        if (started) return false;
        started = true;
        final String[] argv = new String[args.length + 2];
        argv[0] = "node";
        argv[1] = script;
        System.arraycopy(args, 0, argv, 2, args.length);
        // Node's main thread needs a real stack; a Java thread's default is too small.
        Thread t = new Thread(null, () -> {
            try {
                startNodeWithArguments(argv);
            } finally {
                exited = true; // Node cannot be started twice in one process
            }
        }, "varuna-node", 8L * 1024 * 1024);
        t.setDaemon(true);
        t.start();
        return true;
    }

    static synchronized boolean isStarted() {
        return started;
    }

    /** True once Node has stopped: the app then needs a fresh process. */
    static boolean hasExited() {
        return exited;
    }

    private static native int startNodeWithArguments(String[] arguments);
}
