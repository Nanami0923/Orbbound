package com.orbbound.game;

import java.io.Closeable;
import java.io.IOException;
import java.net.BindException;
import java.net.InetAddress;
import java.net.InetSocketAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.net.SocketTimeoutException;
import java.util.ArrayList;
import java.util.UUID;
import java.util.concurrent.ArrayBlockingQueue;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.ThreadPoolExecutor;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicInteger;

/** Plain Java transport, deliberately unaware of game messages or Android. */
public final class LanTcpService implements Closeable {
    public static final int DEFAULT_PORT = 42171;
    private static final int MAX_CONNECTIONS = 4;
    private static final int MAX_QUEUE_BYTES = 1024 * 1024;
    private static final int IO_TIMEOUT_MS = 5000;
    private final Listener listener;
    private final ConcurrentHashMap<String, Connection> connections = new ConcurrentHashMap<>();
    private final ExecutorService workers = new ThreadPoolExecutor(MAX_CONNECTIONS * 2 + 1, MAX_CONNECTIONS * 2 + 1,
        0, TimeUnit.MILLISECONDS, new ArrayBlockingQueue<>(32));
    private final ScheduledExecutorService watchdog = Executors.newSingleThreadScheduledExecutor();
    private volatile ServerSocket server;
    private boolean closed;

    public interface Listener {
        void onEvent(String event, String connectionId, String message, String error);
    }

    public interface SocketFactory { Socket create() throws IOException; }

    public LanTcpService(Listener listener) {
        this.listener = listener;
        watchdog.scheduleAtFixedRate(() -> {
            long now = System.nanoTime();
            for (Connection connection : connections.values()) {
                if ((connection.readStarted != 0 && now - connection.readStarted > IO_TIMEOUT_MS * 1000000L)
                    || (connection.writeStarted != 0 && now - connection.writeStarted > IO_TIMEOUT_MS * 1000000L)) {
                    connection.close("IO_TIMEOUT");
                }
            }
        }, 1, 1, TimeUnit.SECONDS);
    }

    public synchronized int startHost(InetAddress address, int port) throws IOException {
        checkOpen();
        if (port < 0 || port > 65535) throw new IOException("INVALID_PORT");
        stopHost();
        ServerSocket candidate = new ServerSocket();
        candidate.setReuseAddress(true);
        try { candidate.bind(new InetSocketAddress(address, port), MAX_CONNECTIONS); }
        catch (BindException busy) {
            closeQuietly(candidate);
            candidate = new ServerSocket();
            candidate.setReuseAddress(true);
            try { candidate.bind(new InetSocketAddress(address, 0), MAX_CONNECTIONS); }
            catch (IOException failure) { closeQuietly(candidate); throw failure; }
        } catch (IOException failure) { closeQuietly(candidate); throw failure; }
        final ServerSocket listening = candidate;
        server = listening;
        try { workers.execute(() -> acceptLoop(listening)); }
        catch (RuntimeException error) { server = null; closeQuietly(listening); throw new IOException("BUSY", error); }
        return listening.getLocalPort();
    }

    public synchronized void stopHost() {
        ServerSocket previous = server;
        server = null;
        closeQuietly(previous);
        for (Connection connection : new ArrayList<>(connections.values())) {
            if (connection.accepted) connection.close(null);
        }
    }

    public String connect(String address, int port, SocketFactory factory) throws IOException {
        if (port < 1 || port > 65535) throw new IOException("INVALID_PORT");
        synchronized (this) { checkOpen(); }
        Socket socket = factory.create();
        try {
            socket.connect(new InetSocketAddress(address, port), IO_TIMEOUT_MS);
            return register(socket, false);
        } catch (IOException | RuntimeException error) { closeQuietly(socket); throw error; }
    }

    public void send(String connectionId, String message) throws IOException {
        Connection connection = connections.get(connectionId);
        if (connection == null || !connection.open.get()) throw new IOException("NOT_CONNECTED");
        byte[] frame = LanFrameCodec.encode(message);
        synchronized (connection) {
            if (!connection.open.get()) throw new IOException("NOT_CONNECTED");
            if (connection.queuedBytes.get() + frame.length > MAX_QUEUE_BYTES) {
                connection.close("SEND_QUEUE_FULL");
                throw new IOException("SEND_QUEUE_FULL");
            }
            connection.queuedBytes.addAndGet(frame.length);
            if (!connection.outbound.offer(frame)) {
                connection.queuedBytes.addAndGet(-frame.length);
                connection.close("SEND_QUEUE_FULL");
                throw new IOException("SEND_QUEUE_FULL");
            }
        }
    }

    public void disconnect(String connectionId) {
        Connection connection = connections.get(connectionId);
        if (connection != null) connection.close(null);
    }

    public int connectionCount() { return connections.size(); }

    private void acceptLoop(ServerSocket listening) {
        while (!listening.isClosed()) {
            Socket accepted = null;
            try {
                accepted = listening.accept();
                synchronized (this) {
                    if (server != listening) { closeQuietly(accepted); continue; }
                    register(accepted, true);
                }
            } catch (IOException | RuntimeException error) {
                closeQuietly(accepted);
                if (!listening.isClosed()) listener.onEvent("error", null, null, "ACCEPT_FAILED");
            }
        }
    }

    private synchronized String register(Socket socket, boolean accepted) throws IOException {
        checkOpen();
        if (connections.size() >= MAX_CONNECTIONS) throw new IOException("ROOM_FULL");
        socket.setTcpNoDelay(true);
        socket.setKeepAlive(true);
        socket.setSoTimeout(15000);
        Connection connection = new Connection(socket, accepted);
        connections.put(connection.id, connection);
        // Connected must precede all messages, including an immediately received HELLO.
        listener.onEvent("connected", connection.id, null, null);
        try {
            workers.execute(connection::readLoop);
            workers.execute(connection::writeLoop);
        } catch (RuntimeException error) { connection.close("BUSY"); throw new IOException("BUSY", error); }
        return connection.id;
    }

    private void checkOpen() throws IOException { if (closed) throw new IOException("DISPOSED"); }

    @Override public synchronized void close() {
        if (closed) return;
        closed = true;
        stopHost();
        for (Connection connection : new ArrayList<>(connections.values())) connection.close(null);
        watchdog.shutdownNow();
        workers.shutdownNow();
    }

    private static void closeQuietly(Closeable socket) {
        if (socket != null) try { socket.close(); } catch (IOException ignored) { }
    }

    private final class Connection {
        final String id = UUID.randomUUID().toString();
        final Socket socket;
        final boolean accepted;
        final AtomicBoolean open = new AtomicBoolean(true);
        final AtomicInteger queuedBytes = new AtomicInteger();
        final ArrayBlockingQueue<byte[]> outbound = new ArrayBlockingQueue<>(64);
        volatile long readStarted, writeStarted;

        Connection(Socket socket, boolean accepted) { this.socket = socket; this.accepted = accepted; }

        void readLoop() {
            String failure = null;
            long rateWindow = System.nanoTime();
            int frames = 0;
            try {
                while (open.get()) {
                    String message = LanFrameCodec.read(socket.getInputStream(), () -> readStarted = System.nanoTime());
                    readStarted = 0;
                    if (message == null) break;
                    long now = System.nanoTime();
                    if (now - rateWindow >= 1000000000L) { frames = 0; rateWindow = now; }
                    if (++frames > 240) throw new IOException("RATE_LIMIT");
                    listener.onEvent("message", id, message, null);
                }
            } catch (IOException | RuntimeException error) {
                failure = error instanceof SocketTimeoutException ? "READ_TIMEOUT" : "CONNECTION_LOST";
            } finally { close(failure); }
        }

        void writeLoop() {
            String failure = null;
            try {
                while (open.get()) {
                    byte[] frame = outbound.poll(1, TimeUnit.SECONDS);
                    if (frame == null) continue;
                    // Keep the in-flight bytes within the bound until the write completes.
                    writeStarted = System.nanoTime();
                    socket.getOutputStream().write(frame);
                    socket.getOutputStream().flush();
                    writeStarted = 0;
                    queuedBytes.addAndGet(-frame.length);
                }
            } catch (InterruptedException error) { Thread.currentThread().interrupt(); }
            catch (IOException | RuntimeException error) { failure = "CONNECTION_LOST"; }
            finally { close(failure); }
        }

        void close(String error) {
            if (!open.compareAndSet(true, false)) return;
            closeQuietly(socket);
            outbound.clear();
            // Wake a writer waiting on an empty queue immediately when a connection is released.
            outbound.offer(new byte[0]);
            connections.remove(id, this);
            listener.onEvent("disconnected", id, null, error);
        }
    }
}
