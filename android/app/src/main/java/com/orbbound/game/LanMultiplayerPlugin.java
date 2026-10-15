package com.orbbound.game;

import android.os.Handler;
import android.os.Looper;
import android.view.WindowManager;
import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.IOException;
import java.util.HashSet;
import java.util.Set;
import java.util.concurrent.ArrayBlockingQueue;
import java.util.concurrent.RejectedExecutionException;
import java.util.concurrent.ThreadPoolExecutor;
import java.util.concurrent.TimeUnit;
import org.json.JSONObject;

@CapacitorPlugin(name = "LanMultiplayer")
public class LanMultiplayerPlugin extends Plugin {
    private final Handler main = new Handler(Looper.getMainLooper());
    private final ThreadPoolExecutor operations = new ThreadPoolExecutor(1, 1, 0, TimeUnit.MILLISECONDS,
        new ArrayBlockingQueue<>(64));
    private final ArrayBlockingQueue<JSObject> events = new ArrayBlockingQueue<>(128);
    private final Set<String> connections = new HashSet<>();
    private volatile LanService service;
    private volatile int generation;
    private volatile boolean destroyed, active = true;
    private boolean hosting, draining;

    @FunctionalInterface private interface Operation { void run() throws Exception; }

    private synchronized LanService service() {
        if (service == null || service.isClosed()) {
            final int token = ++generation;
            service = new LanService(getContext(), (event, connectionId, message, room, error) -> {
                if (destroyed || token != generation) return;
                JSObject data = new JSObject().put("type", "lan-event").put("event", event);
                if (connectionId != null) data.put("connectionId", connectionId);
                if (message != null) data.put("message", message);
                if (room != null) data.put("room", room);
                if (error != null) data.put("error", error);
                queueEvent(data);
            });
        }
        return service;
    }

    private void perform(PluginCall call, Operation operation) {
        if (destroyed) { call.reject("联机服务已关闭", "DISPOSED"); return; }
        try {
            operations.execute(() -> {
                if (destroyed) { call.reject("联机服务已关闭", "DISPOSED"); return; }
                try { operation.run(); }
                catch (SecurityException error) { call.reject("请允许应用访问本地网络", "PERMISSION_DENIED", error); }
                catch (Exception error) {
                    String code = error.getMessage();
                    if (code == null || !code.matches("[A-Z_]{2,40}")) code = error instanceof java.net.SocketTimeoutException ? "CONNECT_TIMEOUT" : "NETWORK_ERROR";
                    call.reject(code, code, error);
                }
            });
        } catch (RejectedExecutionException error) { call.reject("联机操作过于频繁，请稍后重试", "QUEUE_FULL"); }
    }

    @PluginMethod public void startHost(PluginCall call) {
        perform(call, () -> {
            String name = call.getString("name", "").trim();
            if (name.isEmpty() || name.codePointCount(0, name.length()) > 24 || containsControl(name)) throw new IOException("INVALID_NAME");
            JSONObject metadata = call.getObject("metadata");
            if (metadata == null || metadata.toString().length() > 1024
                || metadata.optInt("protocolVersion", 0) != 1
                || metadata.optString("roomId", "").isEmpty() || metadata.optString("roomId").length() > 80
                || metadata.optString("rulesHash", "").isEmpty() || metadata.optString("rulesHash").length() > 128) throw new IOException("INVALID_METADATA");
            LanService.HostInfo result = service().startHost(name, metadata, call.getInt("port", LanTcpService.DEFAULT_PORT));
            main.post(() -> { hosting = true; updateAwake(); });
            call.resolve(new JSObject().put("addresses", new JSArray().put(result.address)).put("port", result.port)
                .put("discoveryAvailable", result.discoveryAvailable));
        });
    }

    @PluginMethod public void stopHost(PluginCall call) {
        perform(call, () -> {
            if (service != null) service.stopHost();
            main.post(() -> { hosting = false; updateAwake(); });
            call.resolve();
        });
    }

    @PluginMethod public void connect(PluginCall call) {
        perform(call, () -> {
            String id = service().connect(call.getString("address"), call.getInt("port", LanTcpService.DEFAULT_PORT));
            call.resolve(new JSObject().put("connectionId", id));
        });
    }

    @PluginMethod public void send(PluginCall call) {
        perform(call, () -> {
            service().send(connectionId(call), call.getString("message"));
            call.resolve();
        });
    }

    @PluginMethod public void disconnect(PluginCall call) {
        perform(call, () -> {
            String id = connectionId(call);
            if (service != null) service.disconnect(id);
            call.resolve();
        });
    }

    @PluginMethod public void discover(PluginCall call) {
        perform(call, () -> { service().discover(); call.resolve(); });
    }

    @PluginMethod public void stopDiscovery(PluginCall call) {
        perform(call, () -> { if (service != null) service.stopDiscovery(); call.resolve(); });
    }

    @PluginMethod public void dispose(PluginCall call) {
        perform(call, () -> { disposeService(); call.resolve(); });
    }

    private static String connectionId(PluginCall call) throws IOException {
        String id = call.getString("connectionId");
        if (id == null || id.length() > 80 || id.isEmpty()) throw new IOException("INVALID_CONNECTION");
        return id;
    }

    private static boolean containsControl(String value) {
        for (int index = 0; index < value.length(); index++) if (Character.isISOControl(value.charAt(index))) return true;
        return false;
    }

    private void queueEvent(JSObject event) {
        if (destroyed) return;
        // A suspended WebView receives a fresh authoritative snapshot on resume, not a replay backlog.
        if (!active && ("message".equals(event.optString("event")) || "discovered".equals(event.optString("event")))) return;
        if (!events.offer(event)) {
            events.clear();
            events.offer(new JSObject().put("type", "lan-event").put("event", "error").put("error", "EVENT_QUEUE_FULL"));
            LanService current = service;
            if (current != null) main.post(() -> { if (current == service) current.close(); });
        }
        synchronized (events) {
            if (draining || !active) return;
            draining = true;
        }
        main.post(drainEvents);
    }

    private final Runnable drainEvents = new Runnable() {
        @Override public void run() {
            if (destroyed) return;
            if (!active) { synchronized (events) { draining = false; } return; }
            int delivered = 0;
            JSObject event;
            while (delivered++ < 32 && (event = events.poll()) != null) {
                String kind = event.optString("event");
                if ("connected".equals(kind)) connections.add(event.optString("connectionId"));
                if ("disconnected".equals(kind)) connections.remove(event.optString("connectionId"));
                if ("error".equals(kind) && "NETWORK_CHANGED".equals(event.optString("error"))) hosting = false;
                notifyListeners("lanEvent", event, false);
            }
            updateAwake();
            synchronized (events) {
                if (events.isEmpty()) { draining = false; return; }
            }
            main.post(this);
        }
    };

    private void updateAwake() {
        if (getActivity() == null) return;
        if (!destroyed && active && (hosting || !connections.isEmpty())) getActivity().getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        else getActivity().getWindow().clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
    }

    private synchronized void disposeService() {
        ++generation;
        if (service != null) service.close();
        service = null;
        events.clear();
        main.post(() -> { hosting = false; connections.clear(); updateAwake(); });
    }

    @Override protected void handleOnPause() {
        if (destroyed) return;
        notifyListeners("lanEvent", new JSObject().put("type", "lan-event").put("event", "background"), false);
        active = false;
        updateAwake();
    }

    @Override protected void handleOnResume() {
        if (destroyed) return;
        active = true;
        queueEvent(new JSObject().put("type", "lan-event").put("event", "foreground"));
        updateAwake();
    }

    @Override protected void handleOnDestroy() {
        destroyed = true;
        disposeService();
        main.removeCallbacks(drainEvents);
        operations.shutdownNow();
    }
}
