package com.orbbound.game;

import android.media.AudioManager;
import android.os.Bundle;
import android.os.Build;
import android.graphics.Color;
import android.view.View;
import androidx.core.graphics.Insets;
import androidx.core.view.ViewCompat;
import androidx.core.view.WindowCompat;
import androidx.core.view.WindowInsetsCompat;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(GameFeedbackPlugin.class);
        registerPlugin(LanMultiplayerPlugin.class);
        super.onCreate(savedInstanceState);
        // Long presses belong to aiming, not WebView image/context actions.
        getBridge().getWebView().setOnLongClickListener(view -> true);
        getBridge().getWebView().setLongClickable(false);
        // The hardware volume keys should adjust the game's media audio.
        setVolumeControlStream(AudioManager.STREAM_MUSIC);
        // Draw the WebView behind both bars; CSS protects controls using these insets.
        WindowCompat.setDecorFitsSystemWindows(getWindow(), false);
        View content = findViewById(android.R.id.content);
        // Paint the same navy behind system bars and the WebView. Insets protect
        // controls without turning the status area into a separate black strip.
        content.setBackgroundColor(0xff111a2d);
        getWindow().setStatusBarColor(Color.TRANSPARENT);
        getWindow().setNavigationBarColor(Color.TRANSPARENT);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            getWindow().setStatusBarContrastEnforced(false);
            getWindow().setNavigationBarContrastEnforced(false);
        }
        WindowCompat.getInsetsController(getWindow(), content).setAppearanceLightStatusBars(false);
        WindowCompat.getInsetsController(getWindow(), content).setAppearanceLightNavigationBars(false);
        ViewCompat.setOnApplyWindowInsetsListener(content, (view, windowInsets) -> {
            // SystemBars owns padding and CSS safe areas. Observe the original
            // window state only; consuming it here breaks WebView recalculation.
            WindowInsetsCompat rootInsets = ViewCompat.getRootWindowInsets(view);
            WindowInsetsCompat observed = rootInsets != null ? rootInsets : windowInsets;
            Insets safe = observed.getInsets(WindowInsetsCompat.Type.systemBars()
                | WindowInsetsCompat.Type.displayCutout() | WindowInsetsCompat.Type.systemGestures());
            com.getcapacitor.PluginHandle handle = getBridge().getPlugin("GameFeedback");
            if (handle != null) {
                GameFeedbackPlugin feedback = (GameFeedbackPlugin) handle.getInstance();
                feedback.updateInsets(safe);
                feedback.updateKeyboardState(observed.isVisible(WindowInsetsCompat.Type.ime()),
                    observed.getInsets(WindowInsetsCompat.Type.ime()).bottom);
            }
            return windowInsets;
        });
        ViewCompat.requestApplyInsets(content);
    }
}
