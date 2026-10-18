package com.orbbound.game;

import android.content.Context;
import android.app.Activity;
import android.content.BroadcastReceiver;
import android.content.Intent;
import android.content.IntentFilter;
import android.hardware.display.DisplayManager;
import android.net.Uri;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import android.os.PowerManager;
import android.os.VibrationEffect;
import android.os.Vibrator;
import android.view.Display;
import android.view.WindowManager;
import androidx.activity.result.ActivityResult;
import androidx.core.graphics.Insets;
import androidx.core.view.ViewCompat;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.ActivityCallback;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.InputStream;
import java.io.OutputStream;
import java.util.TreeSet;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import org.json.JSONArray;
import org.json.JSONObject;

@CapacitorPlugin(name = "GameFeedback")
public class GameFeedbackPlugin extends Plugin {
    private volatile Insets safeInsets = Insets.NONE;
    private volatile boolean insetsReady;
    private volatile boolean keyboardReady, keyboardVisible;
    private volatile int keyboardHeight;
    private final Handler main = new Handler(Looper.getMainLooper());
    private final ExecutorService documents = Executors.newSingleThreadExecutor();
    private DisplayManager displayManager;
    private PowerManager powerManager;
    private PowerManager.OnThermalStatusChangedListener thermalListener;
    private boolean receiverRegistered, documentBusy, destroyed, active = true;
    private int requestedRefreshRate, configuredRefreshRate;
    private String lastDisplayInfo;
    private final Runnable sendDisplayInfo = () -> {
        if (destroyed) return;
        JSObject data = displayInfo();
        String value = data.toString();
        if (!value.equals(lastDisplayInfo)) {
            lastDisplayInfo = value;
            notifyListeners("displayInfoChanged", data, true);
        }
    };
    private final DisplayManager.DisplayListener displayListener = new DisplayManager.DisplayListener() {
        @Override public void onDisplayAdded(int id) { scheduleDisplayInfo(); }
        @Override public void onDisplayRemoved(int id) { scheduleDisplayInfo(); }
        @Override public void onDisplayChanged(int id) { scheduleDisplayInfo(); }
    };
    private final BroadcastReceiver powerReceiver = new BroadcastReceiver() {
        @Override public void onReceive(Context context, Intent intent) { scheduleDisplayInfo(); }
    };

    @Override
    public void load() {
        displayManager = (DisplayManager) getContext().getSystemService(Context.DISPLAY_SERVICE);
        powerManager = (PowerManager) getContext().getSystemService(Context.POWER_SERVICE);
        if (displayManager != null) displayManager.registerDisplayListener(displayListener, main);
        IntentFilter filter = new IntentFilter(PowerManager.ACTION_POWER_SAVE_MODE_CHANGED);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) getContext().registerReceiver(powerReceiver, filter, Context.RECEIVER_NOT_EXPORTED);
        else getContext().registerReceiver(powerReceiver, filter);
        receiverRegistered = true;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q && powerManager != null) {
            thermalListener = status -> scheduleDisplayInfo();
            powerManager.addThermalStatusListener(getContext().getMainExecutor(), thermalListener);
        }
        scheduleDisplayInfo();
    }

    private void scheduleDisplayInfo() {
        main.removeCallbacks(sendDisplayInfo);
        main.postDelayed(sendDisplayInfo, 150);
    }

    private JSObject insetData() {
        JSObject data = new JSObject();
        data.put("top", safeInsets.top);
        data.put("right", safeInsets.right);
        data.put("bottom", safeInsets.bottom);
        data.put("left", safeInsets.left);
        data.put("ready", insetsReady);
        return data;
    }

    public void updateInsets(Insets insets) {
        if (insetsReady && safeInsets.equals(insets)) return;
        safeInsets = insets;
        insetsReady = true;
        notifyListeners("safeAreaChanged", insetData(), true);
    }

    @PluginMethod
    public void getSafeArea(PluginCall call) {
        if (!insetsReady) main.post(() -> ViewCompat.requestApplyInsets(getActivity().findViewById(android.R.id.content)));
        call.resolve(insetData());
    }

    private JSObject keyboardData() {
        return new JSObject().put("visible", keyboardVisible).put("height", keyboardHeight).put("ready", keyboardReady);
    }

    /** Read-only IME state. SystemBars remains the sole window-layout owner. */
    public void updateKeyboardState(boolean visible, int height) {
        int nextHeight = visible ? Math.max(0, height) : 0;
        if (keyboardReady && keyboardVisible == visible && keyboardHeight == nextHeight) return;
        keyboardVisible = visible;
        keyboardHeight = nextHeight;
        keyboardReady = true;
        notifyListeners("keyboardStateChanged", keyboardData(), true);
    }

    @PluginMethod
    public void getKeyboardState(PluginCall call) {
        main.post(() -> {
            if (!keyboardReady) ViewCompat.requestApplyInsets(getActivity().findViewById(android.R.id.content));
            call.resolve(keyboardData());
        });
    }

    @SuppressWarnings("deprecation")
    private JSObject displayInfo() {
        Display display = getActivity().getWindowManager().getDefaultDisplay();
        JSObject data = new JSObject();
        data.put("platform", "android");
        data.put("displayId", display.getDisplayId());
        data.put("refreshRate", (double) display.getRefreshRate());
        TreeSet<Double> rates = new TreeSet<>();
        Display.Mode current = display.getMode();
        for (Display.Mode mode : display.getSupportedModes()) {
            // A frame-rate preference must never switch the panel resolution.
            if (mode.getPhysicalWidth() == current.getPhysicalWidth() && mode.getPhysicalHeight() == current.getPhysicalHeight()) rates.add((double) mode.getRefreshRate());
        }
        data.put("supportedRefreshRates", new JSONArray(rates));
        data.put("powerSave", powerManager != null && powerManager.isPowerSaveMode());
        data.put("thermalStatus", Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q && powerManager != null ? powerManager.getCurrentThermalStatus() : JSONObject.NULL);
        Vibrator vibrator = (Vibrator) getContext().getSystemService(Context.VIBRATOR_SERVICE);
        data.put("supportsHaptics", vibrator != null && vibrator.hasVibrator());
        data.put("supportsRefreshRateRequest", true);
        data.put("requestedRefreshRate", requestedRefreshRate);
        return data;
    }

    @PluginMethod
    public void getDisplayInfo(PluginCall call) { main.post(() -> call.resolve(displayInfo())); }

    /** A window preference, not a system display-setting change or a guaranteed FPS. */
    @PluginMethod
    @SuppressWarnings("deprecation")
    public void requestRefreshRate(PluginCall call) {
        int fps = call.getInt("refreshRate", 0);
        if (fps != 0 && fps != 30 && fps != 60 && fps != 90 && fps != 120) { call.reject("不支持的帧率档位", "INVALID_RATE"); return; }
        main.post(() -> {
            try {
                configuredRefreshRate = fps;
                applyRefreshPreference(active ? fps : 0);
                call.resolve(displayInfo());
                scheduleDisplayInfo();
            } catch (RuntimeException error) { call.reject("显示刷新率请求未生效", "DISPLAY_REQUEST_FAILED", error); }
        });
    }

    @SuppressWarnings("deprecation")
    private void applyRefreshPreference(int fps) {
        Display display = getActivity().getWindowManager().getDefaultDisplay();
        WindowManager.LayoutParams attributes = getActivity().getWindow().getAttributes();
        attributes.preferredRefreshRate = fps;
        attributes.preferredDisplayModeId = 0;
        if (fps != 0) {
            Display.Mode current = display.getMode(), best = null;
            for (Display.Mode mode : display.getSupportedModes()) {
                if (mode.getPhysicalWidth() != current.getPhysicalWidth() || mode.getPhysicalHeight() != current.getPhysicalHeight()) continue;
                if (best == null || Math.abs(mode.getRefreshRate() - fps) < Math.abs(best.getRefreshRate() - fps)
                    || (Math.abs(mode.getRefreshRate() - fps) == Math.abs(best.getRefreshRate() - fps) && mode.getRefreshRate() > best.getRefreshRate())) best = mode;
            }
            if (best != null) attributes.preferredDisplayModeId = best.getModeId();
        }
        getActivity().getWindow().setAttributes(attributes);
        requestedRefreshRate = fps;
    }

    @PluginMethod
    public void exportBackup(PluginCall call) {
        try { BackupDocuments.encode(call.getString("text")); }
        catch (Exception error) { call.reject(error.getMessage(), "INVALID_BACKUP", error); return; }
        openDocument(call, new Intent(Intent.ACTION_CREATE_DOCUMENT).setType("application/json")
            .addCategory(Intent.CATEGORY_OPENABLE).putExtra(Intent.EXTRA_TITLE, BackupDocuments.fileName(call.getString("fileName"))), "exportResult");
    }

    @PluginMethod
    public void importBackup(PluginCall call) {
        openDocument(call, new Intent(Intent.ACTION_OPEN_DOCUMENT).setType("*/*")
            .putExtra(Intent.EXTRA_MIME_TYPES, new String[] { "application/json", "text/plain", "application/octet-stream" })
            .addCategory(Intent.CATEGORY_OPENABLE), "importResult");
    }

    private void openDocument(PluginCall call, Intent intent, String callback) {
        main.post(() -> {
            if (documentBusy) { call.reject("请先完成当前文件选择", "BUSY"); return; }
            documentBusy = true;
            try { startActivityForResult(call, intent, callback); }
            catch (RuntimeException error) { documentBusy = false; call.reject("无法打开系统文件选择器", "PICKER_UNAVAILABLE", error); }
        });
    }

    private Uri documentUri(PluginCall call, ActivityResult result) {
        if (call == null) { documentBusy = false; return null; }
        if (result.getResultCode() != Activity.RESULT_OK || result.getData() == null || result.getData().getData() == null) {
            documentBusy = false;
            call.resolve(new JSObject().put("cancelled", true));
            return null;
        }
        Uri uri = result.getData().getData();
        if (!"content".equals(uri.getScheme())) { documentBusy = false; call.reject("请选择系统文档提供的文件", "INVALID_DOCUMENT"); return null; }
        return uri;
    }

    @ActivityCallback
    private void exportResult(PluginCall call, ActivityResult result) {
        Uri uri = documentUri(call, result);
        if (uri == null) return;
        documents.execute(() -> {
            try {
                try (OutputStream output = getContext().getContentResolver().openOutputStream(uri, "wt")) {
                    if (output == null) throw new java.io.IOException("无法写入所选位置");
                    output.write(BackupDocuments.encode(call.getString("text")));
                    output.flush();
                }
                call.resolve(new JSObject().put("cancelled", false));
            } catch (Exception error) { call.reject("备份未能导出：" + error.getMessage(), "EXPORT_FAILED", error); }
            finally { main.post(() -> documentBusy = false); }
        });
    }

    @ActivityCallback
    private void importResult(PluginCall call, ActivityResult result) {
        Uri uri = documentUri(call, result);
        if (uri == null) return;
        documents.execute(() -> {
            try {
                String text;
                try (InputStream input = getContext().getContentResolver().openInputStream(uri)) { text = BackupDocuments.read(input); }
                call.resolve(new JSObject().put("cancelled", false).put("text", text));
            } catch (Exception error) { call.reject("备份未能读取：" + error.getMessage(), "IMPORT_FAILED", error); }
            finally { main.post(() -> documentBusy = false); }
        });
    }

    @Override protected void handleOnResume() {
        active = true;
        try { applyRefreshPreference(configuredRefreshRate); }
        catch (RuntimeException error) { android.util.Log.w("Orbbound", "Display preference could not be restored", error); }
        scheduleDisplayInfo();
    }

    @Override protected void handleOnPause() {
        active = false;
        try { applyRefreshPreference(0); }
        catch (RuntimeException error) { android.util.Log.w("Orbbound", "Display preference could not be released", error); }
        scheduleDisplayInfo();
    }

    @Override
    protected void handleOnDestroy() {
        destroyed = true;
        main.removeCallbacks(sendDisplayInfo);
        if (displayManager != null) displayManager.unregisterDisplayListener(displayListener);
        if (receiverRegistered) getContext().unregisterReceiver(powerReceiver);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q && powerManager != null && thermalListener != null) powerManager.removeThermalStatusListener(thermalListener);
        documents.shutdownNow();
    }

    @PluginMethod
    @SuppressWarnings("deprecation")
    public void pulse(PluginCall call) {
        Vibrator vibrator = (Vibrator) getContext().getSystemService(Context.VIBRATOR_SERVICE);
        int duration = Math.max(1, Math.min(30, call.getInt("duration", 12)));
        if (vibrator != null && vibrator.hasVibrator()) {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                vibrator.vibrate(VibrationEffect.createOneShot(duration, VibrationEffect.DEFAULT_AMPLITUDE));
            } else {
                vibrator.vibrate(duration);
            }
        }
        call.resolve();
    }
}
