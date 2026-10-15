package com.orbbound.game;

import static org.junit.Assert.*;
import java.io.IOException;
import java.net.BindException;
import java.net.DatagramPacket;
import java.net.DatagramSocket;
import java.net.Inet4Address;
import java.net.InetAddress;
import java.net.InetSocketAddress;
import java.net.SocketException;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.LinkedBlockingQueue;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.function.Predicate;
import org.json.JSONObject;
import org.junit.Test;

public class LanDiscoveryTest {
    private static LanService.Selection path(String address, int prefix) throws Exception {
        return new LanService.Selection(null, (Inet4Address) InetAddress.getByName(address), prefix, "test");
    }
    private static final class Events implements LanService.Listener {
        final LinkedBlockingQueue<Map<String, Object>> queue = new LinkedBlockingQueue<>();
        final List<Map<String, Object>> all = new CopyOnWriteArrayList<>();
        @Override public void onEvent(String event, String id, String message, JSONObject room, String error) { }
        @Override public void onDiscoveryEvent(Map<String, Object> event) { all.add(event); queue.add(event); }
        Map<String, Object> await(Predicate<Map<String, Object>> predicate) throws Exception {
            long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(5);
            while (System.nanoTime() < deadline) {
                Map<String, Object> event = queue.poll(100, TimeUnit.MILLISECONDS);
                if (event != null && predicate.test(event)) return event;
            }
            fail("Timed out waiting for discovery event; received " + all); return null;
        }
        Map<String, Object> status(String id, String state) throws Exception {
            return await(e -> id.equals(e.get("scanId")) && state.equals(e.get("status")));
        }
    }
    // Only JSON is replaced for JVM tests: production lifecycle, socket I/O, routing and metadata stay in use.
    private static final class Codec implements LanService.DiscoveryCodec {
        public byte[] query(String token) { return token.getBytes(StandardCharsets.UTF_8); }
        public String readQuery(byte[] bytes) { return new String(bytes, StandardCharsets.UTF_8); }
        public byte[] reply(String token, LanService.Advertisement room) {
            return (token + "|" + room.name + "|" + room.port + "|" + room.metadata.get("mode")).getBytes(StandardCharsets.UTF_8);
        }
        public Map<String, Object> readReply(byte[] bytes, String token, String source) {
            String[] fields = new String(bytes, StandardCharsets.UTF_8).split("\\|", -1);
            if (fields.length != 4 || !token.equals(fields[0])) return null;
            Map<String, Object> room = new LinkedHashMap<>();
            room.put("name", fields[1]); room.put("port", Integer.parseInt(fields[2])); room.put("address", source);
            room.put("metadata", metadata(fields[3])); return room;
        }
    }
    private static Map<String, Object> metadata(String mode) {
        Map<String, Object> data = new LinkedHashMap<>();
        data.put("roomId", "test-room"); data.put("protocolVersion", 2); data.put("rulesHash", "test-hash"); data.put("mode", mode);
        return data;
    }
    private static class RecordingSocket extends DatagramSocket {
        final List<String> targets = new CopyOnWriteArrayList<>();
        boolean failBroadcast, failRead;
        RecordingSocket(LanService.Selection path) throws IOException {
            super((java.net.SocketAddress) null); bind(new InetSocketAddress(path.address, 0)); setSoTimeout(20);
        }
        @Override public void send(DatagramPacket packet) throws IOException {
            String target = packet.getAddress().getHostAddress(); targets.add(target);
            if (failBroadcast && "255.255.255.255".equals(target)) throw new IOException("Injected destination failure");
        }
        @Override public synchronized void receive(DatagramPacket packet) throws IOException {
            if (failRead) throw new IOException("Injected receiver failure");
            super.receive(packet);
        }
    }
    private static LanService service(Events events, List<LanService.Selection> paths, LanService.DatagramFactory sockets,
                                      long duration, long[] queries, long[] retries) {
        return new LanService(events, () -> paths, sockets, new Codec(), duration, queries, retries);
    }

    @Test public void recentAddressesRespectSubnetMasksLimitAndInvalidTargets() throws Exception {
        LanService.Selection lan = path("192.168.5.10", 24);
        List<String> recent = new ArrayList<>(Arrays.asList("8.8.8.8", "192.168.6.2", "bad", "192.168.5.0",
            "192.168.5.255", "192.168.5.10", "192.168.5.1:44444", "192.168.5.1:42171"));
        for (int i = 2; i < 20; i++) recent.add("192.168.5." + i);
        List<InetAddress> targets = LanService.recentTargets(lan, recent);
        assertEquals(10, targets.size()); // two broadcasts plus at most eight unique valid recent addresses
        assertEquals("192.168.5.255", targets.get(0).getHostAddress());
        assertEquals("255.255.255.255", targets.get(1).getHostAddress());
        for (int i = 2; i < targets.size(); i++) assertTrue(lan.sameSubnet(targets.get(i)));
        assertEquals("192.168.15.255", path("192.168.5.10", 20).broadcasts().get(0).getHostAddress());
        assertEquals(2, LanService.recentTargets(path("192.168.5.10", 31), Arrays.asList("192.168.5.11")).size());
    }

    @Test(timeout = 5000) public void oneFailedTargetDoesNotSkipOtherInterfacesOrRecentUnicast() throws Exception {
        Events events = new Events(); List<RecordingSocket> sockets = new CopyOnWriteArrayList<>();
        try (LanService service = service(events, Arrays.asList(path("127.0.0.1", 8), path("127.0.0.2", 8)), (p, host) -> {
            RecordingSocket socket = new RecordingSocket(p); socket.failBroadcast = true; sockets.add(socket); return socket;
        }, 220, new long[] { 0, 40, 80, 120 }, new long[] { 10, 20, 30 })) {
            service.discover("targets", Arrays.asList("127.0.0.3"));
            Map<String, Object> finished = events.status("targets", "completed");
            assertEquals(2, finished.get("paths")); assertEquals(16, finished.get("sent")); assertEquals(8, finished.get("errors"));
            assertEquals(2, sockets.size());
            for (RecordingSocket socket : sockets) {
                assertTrue(socket.targets.contains("127.0.0.3"));
                assertEquals(12, socket.targets.size()); assertTrue(socket.isClosed());
            }
        }
    }

    @Test(timeout = 5000) public void noPathsFinishesImmediatelyWithoutSockets() throws Exception {
        Events events = new Events(); AtomicInteger opened = new AtomicInteger();
        try (LanService service = service(events, Collections.emptyList(), (p, host) -> { opened.incrementAndGet(); throw new IOException(); },
            200, new long[] { 0 }, new long[] { 10 })) {
            service.discover("none", Collections.emptyList());
            Map<String, Object> failed = events.status("none", "failed");
            assertEquals("NO_LOCAL_NETWORK", failed.get("error")); assertEquals(0, opened.get());
        }
    }

    @Test(timeout = 5000) public void replacingAndCancellingScansCloseResourcesAndSuppressLateCompletion() throws Exception {
        Events events = new Events(); List<RecordingSocket> sockets = new CopyOnWriteArrayList<>();
        try (LanService service = service(events, Arrays.asList(path("127.0.0.1", 8)), (p, host) -> {
            RecordingSocket socket = new RecordingSocket(p); sockets.add(socket); return socket;
        }, 160, new long[] { 0, 60, 100 }, new long[] { 10 })) {
            service.discover("old", Collections.emptyList());
            service.discover("new", Collections.emptyList());
            events.status("old", "cancelled"); events.status("new", "completed");
            assertTrue(sockets.stream().allMatch(DatagramSocket::isClosed));
            assertFalse(events.all.stream().anyMatch(e -> "old".equals(e.get("scanId")) && "completed".equals(e.get("status"))));
            service.discover("cancel", Collections.emptyList()); service.stopDiscovery();
            events.status("cancel", "cancelled");
            assertTrue(sockets.stream().allMatch(DatagramSocket::isClosed));
        }
    }

    @Test(timeout = 5000) public void failedBindRetriesAreBoundedAndEndInFailure() throws Exception {
        Events events = new Events(); AtomicInteger attempts = new AtomicInteger();
        try (LanService service = service(events, Arrays.asList(path("127.0.0.1", 8)), (p, host) -> {
            attempts.incrementAndGet(); throw new BindException("Injected bind failure");
        }, 1000, new long[] { 0, 100 }, new long[] { 10, 20, 30 })) {
            service.discover("failed", Collections.emptyList());
            Map<String, Object> failed = events.status("failed", "failed");
            assertEquals(4, attempts.get()); assertEquals(4, failed.get("errors")); assertEquals(0, failed.get("sent"));
        }
    }

    @Test(timeout = 5000) public void failedReceiverRebuildsItsPathWithoutStoppingOtherPath() throws Exception {
        Events events = new Events(); AtomicInteger attempts = new AtomicInteger(); List<RecordingSocket> sockets = new CopyOnWriteArrayList<>();
        try (LanService service = service(events, Arrays.asList(path("127.0.0.1", 8), path("127.0.0.2", 8)), (p, host) -> {
            RecordingSocket socket = new RecordingSocket(p); socket.failRead = attempts.getAndIncrement() == 0; sockets.add(socket); return socket;
        }, 200, new long[] { 0, 50, 100 }, new long[] { 10, 20, 30 })) {
            service.discover("receiver", Collections.emptyList());
            Map<String, Object> done = events.status("receiver", "completed");
            assertEquals(3, attempts.get()); assertTrue((Integer) done.get("sent") >= 8); assertEquals(1, done.get("errors"));
            assertTrue(sockets.stream().allMatch(DatagramSocket::isClosed));
        }
    }

    @Test(timeout = 5000) public void realUdpRespondsWithActualSourcePortAndLiveMetadata() throws Exception {
        Events hostEvents = new Events(), guestEvents = new Events(); AtomicInteger hostPort = new AtomicInteger();
        LanService.DatagramFactory factory = (p, host) -> {
            if (host) {
                DatagramSocket socket = new DatagramSocket(new InetSocketAddress("127.0.0.1", 0));
                socket.setSoTimeout(20); hostPort.set(socket.getLocalPort()); return socket;
            }
            return new DatagramSocket(new InetSocketAddress(p.address, 0)) {
                { setSoTimeout(20); setBroadcast(true); }
                @Override public void send(DatagramPacket packet) throws IOException {
                    if (packet.getPort() == LanService.DISCOVERY_PORT) {
                        DatagramPacket routed = new DatagramPacket(packet.getData(), packet.getOffset(), packet.getLength(),
                            InetAddress.getByName("127.0.0.1"), hostPort.get());
                        super.send(routed);
                    } else super.send(packet);
                }
            };
        };
        try (LanService host = service(hostEvents, Arrays.asList(path("127.0.0.1", 8)), factory, 400, new long[] { 0, 70, 140, 210 }, new long[] { 10 });
             LanService guest = service(guestEvents, Arrays.asList(path("127.0.0.2", 8)), factory, 400, new long[] { 0, 70, 140, 210 }, new long[] { 10 })) {
            LanService.HostInfo info = host.startHost("中文房间", metadata("score-race"), 0);
            assertTrue(info.discoveryAvailable);
            guest.discover("udp", Collections.emptyList());
            Map<String, Object> first = guestEvents.await(e -> "discovered".equals(e.get("event")));
            Map<?, ?> room = (Map<?, ?>) first.get("room");
            assertEquals("127.0.0.1", room.get("address")); assertEquals(info.port, room.get("port"));
            assertEquals("中文房间", room.get("name")); assertEquals("udp", first.get("scanId"));
            host.updateAdvertisement("新房间", metadata("battle"));
            Map<String, Object> updated = guestEvents.await(e -> "discovered".equals(e.get("event"))
                && "新房间".equals(((Map<?, ?>) e.get("room")).get("name")));
            Map<?, ?> newRoom = (Map<?, ?>) updated.get("room");
            assertEquals("battle", ((Map<?, ?>) newRoom.get("metadata")).get("mode"));
            assertEquals(info.port, newRoom.get("port")); guestEvents.status("udp", "completed");
            Map<String, Object> invalid = metadata("battle"); invalid.put("roomId", "different-room");
            try { host.updateAdvertisement(null, invalid); fail("Room identity must stay unchanged"); }
            catch (IOException expected) { assertEquals("ROOM_ID_CHANGED", expected.getMessage()); }
        }
    }

    @Test(timeout = 5000) public void hostPortConflictReportsUnavailableThenRecoversWithBoundedRetry() throws Exception {
        Events events = new Events(); AtomicInteger binds = new AtomicInteger();
        try (LanService service = service(events, Arrays.asList(path("127.0.0.1", 8)), (p, host) -> {
            if (host && binds.incrementAndGet() < 3) throw new BindException("Occupied");
            DatagramSocket socket = new DatagramSocket(new InetSocketAddress("127.0.0.1", 0)); socket.setSoTimeout(20); return socket;
        }, 300, new long[] { 0 }, new long[] { 10, 20, 30 })) {
            LanService.HostInfo info = service.startHost("test", metadata("battle"), 0);
            assertFalse(info.discoveryAvailable);
            events.await(e -> "advertisement-status".equals(e.get("event")) && Boolean.TRUE.equals(e.get("discoveryAvailable")));
            assertEquals(3, binds.get());
            assertTrue(events.all.stream().anyMatch(e -> "DISCOVERY_PORT_IN_USE".equals(e.get("error"))));
        }
    }

    @Test(timeout = 5000) public void diagnosticsAreBoundedWithoutRecordingPayloads() throws Exception {
        Events events = new Events(); List<LanService.Selection> paths = new ArrayList<>();
        for (int i = 1; i <= 8; i++) paths.add(path("127.0.0." + i, 8));
        try (LanService service = service(events, paths, (p, host) -> new RecordingSocket(p),
            160, new long[] { 0, 30, 60, 90 }, new long[] { 10 })) {
            service.discover("diag", Arrays.asList("127.0.1.1", "127.0.1.2", "127.0.1.3", "127.0.1.4",
                "127.0.1.5", "127.0.1.6", "127.0.1.7", "127.0.1.8", "127.0.1.9"));
            Map<String, Object> done = events.status("diag", "completed");
            assertEquals(320, done.get("sent"));
            assertEquals(200, ((List<?>) done.get("diagnostics")).size());
            assertEquals(200, service.diagnosticSnapshot().size());
        }
    }
}
