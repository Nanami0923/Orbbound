package com.orbbound.game;

import android.media.AudioManager;
import android.os.Bundle;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(GameFeedbackPlugin.class);
        super.onCreate(savedInstanceState);
        // The hardware volume keys should adjust the game's media audio.
        setVolumeControlStream(AudioManager.STREAM_MUSIC);
    }
}
