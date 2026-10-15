package com.orbbound.game;

import java.net.InetAddress;
import java.net.Socket;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;
import java.util.concurrent.ArrayBlockingQueue;
import java.util.concurrent.TimeUnit;

/** Desktop JVM harness for the production Android transport core, not an Android device test. */
public final class LanInteropHarness {
    private static final class Events implements LanTcpService.Listener {
        final ArrayBlockingQueue<String[]> queue = new ArrayBlockingQueue<>(128);
        @Override public void onEvent(String event, String id, String message, String error) {
            if (!queue.offer(new String[] { event, id, message, error })) throw new IllegalStateException("Event overflow");
        }
        String[] next(String kind) throws Exception {
            String[] event = queue.poll(10, TimeUnit.SECONDS);
            if (event == null || !kind.equals(event[0])) throw new IllegalStateException("Expected " + kind + ", received " + Arrays.toString(event));
            return event;
        }
    }

    private static String repeat(char value, int count) {
        char[] chars = new char[count]; Arrays.fill(chars, value); return new String(chars);
    }
    private static List<String> messages() {
        List<String> messages = new ArrayList<>();
        messages.add("{\"name\":\"球\"}");
        messages.add("{\"text\":\"你好 🌈🎮\"}");
        messages.add("{\"data\":\"" + repeat('a', 65525) + "\"}");
        messages.add("{\"data\":\"" + repeat('球', 20000) + "\"}");
        for (int index = 0; index < 40; index++) messages.add("{\"seq\":" + index + "}");
        return messages;
    }

    public static void main(String[] args) throws Exception {
        Events events = new Events();
        List<String> messages = messages();
        int bytes = 0;
        for (String message : messages) bytes += message.getBytes(StandardCharsets.UTF_8).length;
        try (LanTcpService service = new LanTcpService(events)) {
            if ("host".equals(args[0])) {
                int port = service.startHost(InetAddress.getByName("127.0.0.1"), 0);
                System.out.println("READY " + port); System.out.flush();
                String id = events.next("connected")[1];
                for (String expected : messages) {
                    String[] received = events.next("message");
                    if (!expected.equals(received[2])) throw new IllegalStateException("Host payload/order mismatch");
                    service.send(id, received[2]);
                }
                events.next("disconnected");
            } else {
                String id = service.connect("127.0.0.1", Integer.parseInt(args[1]), Socket::new);
                if (!id.equals(events.next("connected")[1])) throw new IllegalStateException("Connection identity mismatch");
                for (String message : messages) service.send(id, message);
                for (String expected : messages) {
                    if (!expected.equals(events.next("message")[2])) throw new IllegalStateException("Guest payload/order mismatch");
                }
                service.disconnect(id);
                events.next("disconnected");
            }
            if (service.connectionCount() != 0) throw new IllegalStateException("Leaked connection");
        }
        System.out.println("PASS Java " + args[0] + " frames=" + messages.size() + " bytesEachDirection=" + bytes + " maxFrame=65536");
    }
}
