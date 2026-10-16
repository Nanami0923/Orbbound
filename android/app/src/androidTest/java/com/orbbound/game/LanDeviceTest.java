package com.orbbound.game;

import static org.junit.Assert.*;
import android.os.Bundle;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;
import java.util.Arrays;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.concurrent.LinkedBlockingQueue;
import java.util.concurrent.TimeUnit;
import org.json.JSONObject;
import org.junit.Test;
import org.junit.runner.RunWith;

/** Run only in the -PlanDeviceTest build with the standalone Windows LanDeviceHarness. */
@RunWith(AndroidJUnit4.class)
public class LanDeviceTest {
    private static final class Events implements LanService.Listener {
        final LinkedBlockingQueue<Map<String, Object>> events = new LinkedBlockingQueue<>(512);
        @Override public void onEvent(String event, String id, String message, JSONObject room, String error) {
            Map<String, Object> value = new LinkedHashMap<>(); value.put("event", event);
            if (id != null) value.put("connectionId", id);
            if (message != null) value.put("message", message);
            if (error != null) value.put("error", error);
            assertTrue("Device event queue overflow", events.offer(value));
        }
        @Override public void onDiscoveryEvent(Map<String, Object> event) { assertTrue("Device event queue overflow", events.offer(event)); }
        Map<String, Object> next(String type, long timeoutMs) throws Exception {
            long deadline = System.nanoTime() + TimeUnit.MILLISECONDS.toNanos(timeoutMs);
            while (System.nanoTime() < deadline) {
                Map<String, Object> event = events.poll(Math.max(1, TimeUnit.NANOSECONDS.toMillis(deadline - System.nanoTime())), TimeUnit.MILLISECONDS);
                if (event == null) break;
                if (type.equals(event.get("event"))) return event;
                if ("discovery-status".equals(event.get("event"))) {
                    report("SCAN " + new JSONObject(event));
                    if ("failed".equals(event.get("status"))) fail("Discovery failed: " + event);
                }
                if ("error".equals(event.get("event"))) fail("Native failure: " + event.get("error"));
            }
            throw new AssertionError("Timed out waiting for " + type);
        }
    }
    private static void report(String text) {
        Bundle data = new Bundle(); data.putString("stream", "\n" + text + "\n");
        InstrumentationRegistry.getInstrumentation().sendStatus(0, data);
    }
    private static String[] payloads() {
        char[] chars = new char[65536]; Arrays.fill(chars, 'a');
        return new String[] { "设备互通✓🎮", new String(chars), "{\"v\":3,\"mode\":\"battle\",\"eventSeq\":7}" };
    }
    @Test(timeout = 180000) public void androidWindowsDiscoveryAndFrames() throws Exception {
        String applicationId = InstrumentationRegistry.getInstrumentation().getTargetContext().getPackageName();
        assertTrue("Use -PlanDeviceTest so QA cannot replace the user's game", applicationId.endsWith(".lantest"));
        String role = InstrumentationRegistry.getArguments().getString("role", "guest");
        Events events = new Events();
        try (LanService service = new LanService(InstrumentationRegistry.getInstrumentation().getTargetContext(), events)) {
            if ("host".equals(role)) {
                JSONObject metadata = new JSONObject().put("roomId", "device-test-android").put("protocolVersion", 3)
                    .put("rulesHash", "device-check").put("mode", "battle").put("platform", "Android").put("players", 1).put("phase", "lobby");
                LanService.HostInfo info = service.startHost("Android设备网络验证", metadata, 42179);
                report("READY Android addresses=" + Arrays.toString(info.addresses) + " port=" + info.port + " discovery=" + info.discoveryAvailable);
                assertTrue("Android discovery must be available", info.discoveryAvailable);
                String connection = (String) events.next("connected", 120000).get("connectionId");
                while (true) {
                    Map<String, Object> received = events.next("message", 30000);
                    String message = (String) received.get("message");
                    connection = (String) received.get("connectionId");
                    service.send(connection, message);
                    if ("__DONE__".equals(message)) break;
                    report("ECHO Android bytes=" + message.getBytes(java.nio.charset.StandardCharsets.UTF_8).length);
                }
                events.next("disconnected", 15000);
            } else {
                Map<?, ?> room = null;
                for (int round = 0; round < 10; round++) {
                    String scanId = "device-android-" + round;
                    String recentAddress = InstrumentationRegistry.getArguments().getString("recentAddress", "");
                    service.discover(scanId, recentAddress.isEmpty() ? Collections.emptyList() : Collections.singletonList(recentAddress));
                    long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(10);
                    do {
                        Map<String, Object> discovered = events.next("discovered", 10000);
                        if (!scanId.equals(discovered.get("scanId"))) continue;
                        Map<?, ?> candidate = (Map<?, ?>) discovered.get("room");
                        if ("device-test-windows".equals(((Map<?, ?>) candidate.get("metadata")).get("roomId"))) { room = candidate; break; }
                    } while (System.nanoTime() < deadline);
                    assertNotNull("Windows host must be discovered", room); service.stopDiscovery();
                    report("FOUND Android round=" + (round + 1) + " address=" + room.get("address") + ":" + room.get("port"));
                }
                String connection = service.connect((String) room.get("address"), ((Number) room.get("port")).intValue());
                assertEquals(connection, events.next("connected", 10000).get("connectionId"));
                for (String message : payloads()) {
                    service.send(connection, message); assertEquals(message, events.next("message", 20000).get("message"));
                    report("ROUNDTRIP Android bytes=" + message.getBytes(java.nio.charset.StandardCharsets.UTF_8).length);
                }
                service.send(connection, "__DONE__"); assertEquals("__DONE__", events.next("message", 10000).get("message"));
                service.disconnect(connection); events.next("disconnected", 10000);
            }
        }
        report("PASS Android device " + role);
    }
}
