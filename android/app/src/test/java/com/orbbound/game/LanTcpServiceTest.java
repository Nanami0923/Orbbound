package com.orbbound.game;

import static org.junit.Assert.*;
import java.io.IOException;
import java.net.InetAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.util.Arrays;
import java.util.concurrent.LinkedBlockingQueue;
import java.util.concurrent.TimeUnit;
import org.junit.Test;

public class LanTcpServiceTest {
    private static InetAddress loopback() throws Exception { return InetAddress.getByName("127.0.0.1"); }

    private static final class Events implements LanTcpService.Listener {
        final LinkedBlockingQueue<String[]> received = new LinkedBlockingQueue<>();
        @Override public void onEvent(String event, String id, String message, String error) { received.add(new String[] { event, id, message, error }); }
        String[] next(String expected) throws Exception {
            String[] event = received.poll(8, TimeUnit.SECONDS);
            assertNotNull("Expected event: " + expected, event);
            assertEquals(expected, event[0]);
            return event;
        }
    }

    @Test(timeout = 15000) public void realSocketsExchangeOrderedUnicodeAndReleaseOnDisconnect() throws Exception {
        Events hostEvents = new Events(), guestEvents = new Events();
        try (LanTcpService host = new LanTcpService(hostEvents); LanTcpService guest = new LanTcpService(guestEvents)) {
            int port = host.startHost(loopback(), 0);
            String guestId = guest.connect("127.0.0.1", port, Socket::new);
            String hostId = hostEvents.next("connected")[1];
            assertEquals(guestId, guestEvents.next("connected")[1]);
            for (int i = 0; i < 20; i++) {
                host.send(hostId, "{\"host\":\"球" + i + "\"}");
                guest.send(guestId, "{\"guest\":\"🟢" + i + "\"}");
            }
            for (int i = 0; i < 20; i++) {
                assertEquals("{\"guest\":\"🟢" + i + "\"}", hostEvents.next("message")[2]);
                assertEquals("{\"host\":\"球" + i + "\"}", guestEvents.next("message")[2]);
            }
            guest.disconnect(guestId);
            assertEquals(guestId, guestEvents.next("disconnected")[1]);
            assertEquals(hostId, hostEvents.next("disconnected")[1]);
            assertEquals(0, guest.connectionCount());
            assertEquals(0, host.connectionCount());
        }
    }

    @Test(timeout = 15000) public void nativeReceiverReassemblesSingleByteWritesAndRejectsOversizePrefix() throws Exception {
        Events events = new Events();
        try (LanTcpService host = new LanTcpService(events)) {
            int port = host.startHost(loopback(), 0);
            try (Socket client = new Socket(loopback(), port)) {
                events.next("connected");
                byte[] frame = LanFrameCodec.encode("{\"name\":\"球\"}");
                for (byte value : frame) { client.getOutputStream().write(value); client.getOutputStream().flush(); }
                assertEquals("{\"name\":\"球\"}", events.next("message")[2]);
                client.getOutputStream().write(new byte[] { 0, 1, 0, 1 });
                client.getOutputStream().flush();
                events.next("disconnected");
                assertEquals(0, host.connectionCount());
            }
        }
    }

    @Test(timeout = 15000) public void halfFrameHasAbsoluteDeadlineEvenWithoutClosingPeer() throws Exception {
        Events events = new Events();
        try (LanTcpService host = new LanTcpService(events)) {
            int port = host.startHost(loopback(), 0);
            try (Socket client = new Socket(loopback(), port)) {
                events.next("connected");
                client.getOutputStream().write(0);
                client.getOutputStream().flush();
                String[] disconnected = events.next("disconnected");
                assertEquals("IO_TIMEOUT", disconnected[3]);
                assertEquals(0, host.connectionCount());
            }
        }
    }

    @Test(timeout = 15000) public void occupiedPortFallsBackAndDisposalReleasesListenerAndConnections() throws Exception {
        Events events = new Events();
        try (ServerSocket occupied = new ServerSocket(0, 1, loopback())) {
            LanTcpService host = new LanTcpService(events);
            int port;
            try {
                port = host.startHost(loopback(), occupied.getLocalPort());
                assertNotEquals(occupied.getLocalPort(), port);
                try (Socket client = new Socket(loopback(), port)) {
                    events.next("connected");
                    host.close();
                    events.next("disconnected");
                    client.setSoTimeout(1000);
                    assertEquals(-1, client.getInputStream().read());
                    assertEquals(0, host.connectionCount());
                }
                try (ServerSocket reused = new ServerSocket()) {
                    reused.setReuseAddress(true);
                    reused.bind(new java.net.InetSocketAddress(loopback(), port));
                    assertEquals(port, reused.getLocalPort());
                }
            } finally { host.close(); }
        }
    }

    @Test(timeout = 15000) public void slowPeerCannotCreateUnboundedSendQueue() throws Exception {
        Events events = new Events();
        try (ServerSocket server = new ServerSocket(0, 1, loopback()); LanTcpService guest = new LanTcpService(events)) {
            String id = guest.connect("127.0.0.1", server.getLocalPort(), () -> {
                Socket socket = new Socket();
                socket.setSendBufferSize(1024);
                return socket;
            });
            try (Socket peer = server.accept()) {
                peer.setReceiveBufferSize(1024);
                events.next("connected");
                char[] chars = new char[65536];
                Arrays.fill(chars, 'a');
                String payload = new String(chars);
                boolean rejected = false;
                for (int i = 0; i < 128; i++) {
                    try { guest.send(id, payload); }
                    catch (IOException error) { rejected = true; break; }
                }
                assertTrue("Slow consumers must hit the bounded queue", rejected);
                events.next("disconnected");
                assertEquals(0, guest.connectionCount());
            }
        }
    }
}
