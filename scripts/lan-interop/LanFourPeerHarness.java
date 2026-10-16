package com.orbbound.game;

import java.net.InetAddress;
import java.net.Socket;
import java.nio.charset.StandardCharsets;
import java.util.*;
import java.util.concurrent.ArrayBlockingQueue;
import java.util.concurrent.TimeUnit;

/** Four independent desktop processes; production Android TCP service, not Android device QA. */
public final class LanFourPeerHarness {
    static final int INITIAL = 44, CONTINUED = 22;
    static final class Events implements LanTcpService.Listener {
        final ArrayBlockingQueue<String[]> queue = new ArrayBlockingQueue<>(2048);
        public void onEvent(String event, String id, String message, String error) {
            if (!queue.offer(new String[] { event, id, message, error })) throw new IllegalStateException("Event overflow");
        }
        String[] next() throws Exception {
            String[] event = queue.poll(10, TimeUnit.SECONDS);
            if (event == null) throw new IllegalStateException("TCP event timeout");
            if ("error".equals(event[0])) throw new IllegalStateException("Native error " + event[3]);
            return event;
        }
        String[] next(String type) throws Exception {
            String[] event = next();
            if (!type.equals(event[0])) throw new IllegalStateException("Expected " + type + ", got " + event[0]);
            return event;
        }
    }
    static final class Stats {
        int sent, received, controlsSent, controlsReceived; long bytesSent, bytesReceived;
        void sent(String value, boolean control) { if (control) controlsSent++; else { sent++; bytesSent += bytes(value); } }
        void received(String value, boolean control) { if (control) controlsReceived++; else { received++; bytesReceived += bytes(value); } }
        String json(String role) { return "{\"runtime\":\"Java\",\"role\":\"" + role + "\",\"dataSent\":" + sent + ",\"dataReceived\":" + received + ",\"controlsSent\":" + controlsSent + ",\"controlsReceived\":" + controlsReceived + ",\"bytesSent\":" + bytesSent + ",\"bytesReceived\":" + bytesReceived + "}"; }
    }
    static int bytes(String value) { return value.getBytes(StandardCharsets.UTF_8).length; }
    static String repeat(char value, int count) { char[] chars = new char[count]; Arrays.fill(chars, value); return new String(chars); }
    static void require(boolean condition, String message) { if (!condition) throw new IllegalStateException(message); }
    static String payload(String direction, int seat, String phase, int sequence) {
        String prefix = direction + "|" + seat + "|" + phase + "|" + sequence + "|";
        if (("A".equals(phase) && sequence == 2) || ("B".equals(phase) && sequence == 1)) return prefix + repeat('a', 65536 - bytes(prefix));
        if ("A".equals(phase) && sequence == 3) return prefix + repeat('球', 20000);
        return prefix + (sequence == 0 ? "中文身份" : sequence == 1 ? "你好🌈🎮" : "顺序球🙂");
    }
    static void send(LanTcpService service, Stats stats, String connection, String message, boolean control) throws Exception { service.send(connection, message); stats.sent(message, control); }
    static void phase(LanTcpService service, Stats stats, String connection, int seat, String phase, String direction, int count) throws Exception {
        for (int index = 0; index < count; index++) send(service, stats, connection, payload(direction, seat, phase, index), false);
    }
    static void receive(LanTcpService service, Events events, Stats stats, String connection, int seat, String phase, int count) throws Exception {
        for (int index = 0; index < count; index++) {
            String[] event = events.next("message"); String expected = payload("H", seat, phase, index);
            require(connection.equals(event[1]) && expected.equals(event[2]), "Guest identity/order/content mismatch at " + seat + "/" + phase + "/" + index);
            stats.received(event[2], false);
        }
    }
    static void control(Events events, Stats stats, String connection, String expected) throws Exception {
        String[] event = events.next("message");
        require(connection.equals(event[1]) && expected.equals(event[2]), "Expected control " + expected);
        stats.received(event[2], true);
    }
    static void host(LanTcpService service, Events events, Stats stats) throws Exception {
        int port = service.startHost(InetAddress.getByName("127.0.0.1"), 0);
        System.out.println("READY " + port); System.out.flush();
        Set<String> connected = new HashSet<>(), disconnected = new HashSet<>();
        Map<String, Integer> seats = new HashMap<>(); String[] connections = new String[3];
        int[] initial = new int[3], continued = new int[3]; Set<Integer> ready = new HashSet<>(), finalReady = new HashSet<>();
        boolean started = false, dropRequested = false, continuedStarted = false, finishRequested = false;
        while (disconnected.size() < 3) {
            String[] event = events.next(); String type = event[0], connection = event[1], message = event[2];
            if ("connected".equals(type)) {
                require(connected.add(connection) && connected.size() <= 3, "Duplicate/excess connection");
            } else if ("message".equals(type)) {
                require(connected.contains(connection), "Message before connection or after disconnect");
                if (message.startsWith("HELLO|")) {
                    int seat = Integer.parseInt(message.substring(6));
                    require(!seats.containsKey(connection) && seat >= 0 && seat < 3 && connections[seat] == null, "Identity collision");
                    seats.put(connection, seat); connections[seat] = connection; stats.received(message, true);
                    if (seats.size() == 3) {
                        require(connected.size() == 3, "Three peers were not simultaneous"); started = true;
                        for (int i = 0; i < 3; i++) { send(service, stats, connections[i], "START|" + i, true); phase(service, stats, connections[i], i, "A", "H", INITIAL); }
                        System.out.println("CHECK Java host concurrentPeers=3 distinctConnectionIds=3");
                    }
                    continue;
                }
                Integer seatValue = seats.get(connection); require(seatValue != null && started, "Unauthenticated payload"); int seat = seatValue;
                if (message.startsWith("READY_EXIT|")) {
                    require(message.equals("READY_EXIT|" + seat) && initial[seat] == INITIAL && ready.add(seat), "Invalid initial completion"); stats.received(message, true);
                    if (ready.size() == 3) { dropRequested = true; send(service, stats, connections[0], "EXIT|0", true); }
                } else if (message.startsWith("FINAL_READY|")) {
                    require(message.equals("FINAL_READY|" + seat) && seat != 0 && continued[seat] == CONTINUED && finalReady.add(seat), "Invalid continued completion"); stats.received(message, true);
                    if (finalReady.size() == 2) { finishRequested = true; for (int i = 1; i < 3; i++) send(service, stats, connections[i], "EXIT|" + i, true); }
                } else {
                    String phase = continuedStarted ? "B" : "A"; int[] counters = continuedStarted ? continued : initial; int count = continuedStarted ? CONTINUED : INITIAL;
                    require(!continuedStarted || seat != 0, "Disconnected peer sent continued traffic");
                    require(counters[seat] < count && message.equals(payload("C", seat, phase, counters[seat])), "Host identity/order/content mismatch at " + seat + "/" + phase + "/" + counters[seat]);
                    counters[seat]++; stats.received(message, false);
                    if (counters[seat] == count) send(service, stats, connection, phase + "_DONE|" + seat, true);
                }
            } else if ("disconnected".equals(type)) {
                Integer seatValue = seats.get(connection); require(seatValue != null && connected.remove(connection) && disconnected.add(connection), "Unknown duplicate disconnect"); int seat = seatValue;
                if (seat == 0) {
                    require(dropRequested && !continuedStarted && connected.size() == 2 && service.connectionCount() == 2, "First disconnect affected other peers"); continuedStarted = true;
                    for (int i = 1; i < 3; i++) { send(service, stats, connections[i], "CONTINUE|" + i, true); phase(service, stats, connections[i], i, "B", "H", CONTINUED); }
                    System.out.println("CHECK Java host disconnectedSeat=0 remainingPeers=2 continuedBidirectional=true");
                } else require(finishRequested, "Remaining peer disconnected before continued transfer completed");
            } else throw new IllegalStateException("Unexpected native event " + type);
        }
        require(service.connectionCount() == 0 && connected.isEmpty(), "Connection leak");
        require(stats.sent == 176 && stats.received == 176 && stats.controlsSent == 13 && stats.controlsReceived == 8, "Host totals mismatch");
    }
    static void guest(LanTcpService service, Events events, Stats stats, int port, int seat) throws Exception {
        String connection = service.connect("127.0.0.1", port, Socket::new);
        require(connection.equals(events.next("connected")[1]), "Guest connection identity mismatch");
        send(service, stats, connection, "HELLO|" + seat, true); control(events, stats, connection, "START|" + seat);
        phase(service, stats, connection, seat, "A", "C", INITIAL); receive(service, events, stats, connection, seat, "A", INITIAL);
        control(events, stats, connection, "A_DONE|" + seat); send(service, stats, connection, "READY_EXIT|" + seat, true);
        if (seat != 0) {
            control(events, stats, connection, "CONTINUE|" + seat);
            phase(service, stats, connection, seat, "B", "C", CONTINUED); receive(service, events, stats, connection, seat, "B", CONTINUED);
            control(events, stats, connection, "B_DONE|" + seat); send(service, stats, connection, "FINAL_READY|" + seat, true);
        }
        control(events, stats, connection, "EXIT|" + seat); service.disconnect(connection);
        require(connection.equals(events.next("disconnected")[1]) && service.connectionCount() == 0, "Guest disconnect identity/leak");
    }
    public static void main(String[] args) throws Exception {
        Events events = new Events(); Stats stats = new Stats();
        try (LanTcpService service = new LanTcpService(events)) {
            if ("host".equals(args[0])) host(service, events, stats);
            else guest(service, events, stats, Integer.parseInt(args[1]), Integer.parseInt(args[2]));
        }
        System.out.println("RESULT " + stats.json(args[0]));
        System.out.println("PASS Java " + args[0] + " desktop-loopback-only");
    }
}
