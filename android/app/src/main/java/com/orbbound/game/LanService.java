package com.orbbound.game;

import android.content.Context;
import android.net.ConnectivityManager;
import android.net.LinkAddress;
import android.net.LinkProperties;
import android.net.Network;
import android.net.NetworkCapabilities;
import android.net.NetworkRequest;
import java.io.Closeable;
import java.io.IOException;
import java.net.BindException;
import java.net.DatagramPacket;
import java.net.DatagramSocket;
import java.net.Inet4Address;
import java.net.InetAddress;
import java.net.InetSocketAddress;
import java.net.InterfaceAddress;
import java.net.NetworkInterface;
import java.net.PortUnreachableException;
import java.net.Socket;
import java.net.SocketTimeoutException;
import java.nio.charset.StandardCharsets;
import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collections;
import java.util.Comparator;
import java.util.Deque;
import java.util.HashSet;
import java.util.Iterator;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.ArrayBlockingQueue;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.ScheduledFuture;
import java.util.concurrent.ThreadPoolExecutor;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
import org.json.JSONException;
import org.json.JSONObject;

/** Android network selection and bounded per-interface discovery. TCP game payloads remain opaque. */
public final class LanService implements Closeable {
    static final int DISCOVERY_PORT = 42170, MAX_PATHS = 8, MAX_DIAGNOSTICS = 200;
    private static final String MAGIC = "ORBBOUND_LAN_1";
    private static final long[] QUERY_DELAYS = { 0, 1000, 2500, 5000 }, RETRY_DELAYS = { 500, 1000, 2000 };
    private final Listener listener;
    private final ConnectivityManager connectivity;
    private final LanTcpService tcp;
    private final PathProvider pathProvider;
    private final DatagramFactory socketFactory;
    private final DiscoveryCodec codec;
    private final long scanDuration;
    private final long[] queryDelays, retryDelays;
    private final ExecutorService datagrams = new ThreadPoolExecutor(MAX_PATHS + 1, MAX_PATHS + 1, 0,
        TimeUnit.MILLISECONDS, new ArrayBlockingQueue<>(32));
    private final ScheduledExecutorService scheduler = Executors.newSingleThreadScheduledExecutor();
    private final Deque<String> diagnostics = new ArrayDeque<>();
    private final Map<String, DatagramSocket> replySockets = new LinkedHashMap<>();
    private volatile Selection selection;
    private volatile List<Selection> hostPaths = Collections.emptyList();
    private volatile Advertisement advertisement;
    private volatile DatagramSocket hostDiscovery;
    private volatile Scan scan;
    private volatile boolean closed, hostAvailable;
    private int hostGeneration, hostRetries;
    private ScheduledFuture<?> hostRetry;
    private boolean callbackRegistered;

    public interface Listener {
        void onEvent(String event, String connectionId, String message, JSONObject room, String error);
        default void onDiscoveryEvent(Map<String, Object> event) { }
    }
    interface PathProvider { List<Selection> paths() throws IOException; }
    interface DatagramFactory { DatagramSocket open(Selection path, boolean host) throws IOException; }
    interface DiscoveryCodec {
        byte[] query(String queryId) throws IOException;
        String readQuery(byte[] bytes) throws IOException;
        byte[] reply(String queryId, Advertisement advertisement) throws IOException;
        Map<String, Object> readReply(byte[] bytes, String queryId, String source) throws IOException;
    }
    public static final class HostInfo {
        public final String[] addresses;
        public final int port;
        public final boolean discoveryAvailable;
        HostInfo(String[] addresses, int port, boolean discoveryAvailable) {
            this.addresses = addresses; this.port = port; this.discoveryAvailable = discoveryAvailable;
        }
    }
    static final class Advertisement {
        final String name;
        final Map<String, Object> metadata;
        final int port;
        Advertisement(String name, Map<String, Object> metadata, int port) {
            this.name = name; this.metadata = Collections.unmodifiableMap(new LinkedHashMap<>(metadata)); this.port = port;
        }
    }
    private ConnectivityManager.NetworkCallback networkCallback;

    public LanService(Context context, Listener listener) {
        this.listener = listener;
        connectivity = (ConnectivityManager) context.getSystemService(Context.CONNECTIVITY_SERVICE);
        tcp = new LanTcpService((event, id, message, error) -> listener.onEvent(event, id, message, null, error));
        pathProvider = this::enumeratePaths; socketFactory = LanService::openDatagram; codec = new JsonCodec();
        scanDuration = 8000; queryDelays = QUERY_DELAYS; retryDelays = RETRY_DELAYS;
        networkCallback = new ConnectivityManager.NetworkCallback() {
            @Override public void onLost(Network network) { if (usesNetwork(network, null)) networkChanged(); }
            @Override public void onLinkPropertiesChanged(Network network, LinkProperties properties) {
                if (usesNetwork(network, properties)) networkChanged();
            }
        };
        if (connectivity != null) {
            try {
                connectivity.registerNetworkCallback(new NetworkRequest.Builder()
                    .addTransportType(NetworkCapabilities.TRANSPORT_WIFI)
                    .addTransportType(NetworkCapabilities.TRANSPORT_ETHERNET).build(), networkCallback);
                callbackRegistered = true;
            } catch (RuntimeException error) { diagnostic("network", "CALLBACK_UNAVAILABLE"); }
        }
    }

    /** Injectable UDP boundaries let JVM tests exercise real sockets without Android framework mocks. */
    LanService(Listener listener, PathProvider paths, DatagramFactory sockets, DiscoveryCodec codec,
               long duration, long[] sends, long[] retries) {
        this.listener = listener; connectivity = null;
        tcp = new LanTcpService((event, id, message, error) -> listener.onEvent(event, id, message, null, error));
        pathProvider = paths; socketFactory = sockets; this.codec = codec;
        scanDuration = duration; queryDelays = sends.clone(); retryDelays = retries.clone();
    }

    private synchronized boolean usesNetwork(Network network, LinkProperties properties) {
        List<Selection> used = new ArrayList<>(hostPaths);
        Selection connected = selection; if (connected != null) used.add(connected);
        Scan current = scan; if (current != null) for (ScanPath path : current.paths) used.add(path.selection);
        for (Selection path : used) {
            if (!network.equals(path.network)) continue;
            if (properties == null) return true;
            boolean present = false;
            for (LinkAddress address : properties.getLinkAddresses()) if (path.address.equals(address.getAddress())) present = true;
            if (!present) return true;
        }
        return false;
    }
    private synchronized void networkChanged() {
        if (closed) return;
        if (scan != null) finishScan(scan, "failed", "NETWORK_CHANGED");
        if (advertisement != null) advertisementStatus(false, "NETWORK_CHANGED");
        listener.onEvent("error", null, null, null, "NETWORK_CHANGED");
        close();
    }
    public boolean isClosed() { return closed; }

    public HostInfo startHost(String name, JSONObject metadata, int requestedPort) throws IOException {
        return startHost(name, objectMap(metadata), requestedPort);
    }
    synchronized HostInfo startHost(String name, Map<String, Object> metadata, int requestedPort) throws IOException {
        checkOpen(); stopHost();
        hostPaths = boundedPaths();
        if (hostPaths.isEmpty()) throw new IOException("NO_LOCAL_NETWORK");
        // Every advertised LAN address must reach this room, including tethering and Wi-Fi together.
        int port = tcp.startHost(InetAddress.getByName("0.0.0.0"), requestedPort);
        advertisement = new Advertisement(name, metadata, port); hostRetries = 0;
        int generation = ++hostGeneration;
        openHost(generation);
        String[] addresses = new String[hostPaths.size()];
        for (int index = 0; index < addresses.length; index++) addresses[index] = hostPaths.get(index).address.getHostAddress();
        return new HostInfo(addresses, port, hostAvailable);
    }
    public void updateAdvertisement(String name, JSONObject metadata) throws IOException {
        updateAdvertisement(name, objectMap(metadata));
    }
    synchronized void updateAdvertisement(String name, Map<String, Object> metadata) throws IOException {
        checkOpen();
        Advertisement previous = advertisement;
        if (previous == null) throw new IOException("NOT_HOSTING");
        if (!previous.metadata.get("roomId").equals(metadata.get("roomId"))
            || !previous.metadata.get("protocolVersion").equals(metadata.get("protocolVersion"))) throw new IOException("ROOM_ID_CHANGED");
        advertisement = new Advertisement(name == null ? previous.name : name, metadata, previous.port);
    }
    public synchronized void stopHost() {
        hostGeneration++; advertisement = null; hostAvailable = false; hostPaths = Collections.emptyList();
        if (hostRetry != null) hostRetry.cancel(false);
        hostRetry = null;
        closeHostSockets(); tcp.stopHost();
    }
    private void closeHostSockets() {
        DatagramSocket previous = hostDiscovery; hostDiscovery = null;
        if (previous != null) previous.close();
        for (DatagramSocket socket : replySockets.values()) socket.close();
        replySockets.clear();
    }
    private synchronized void openHost(int generation) {
        if (closed || generation != hostGeneration || advertisement == null) return;
        DatagramSocket socket = null;
        try {
            socket = socketFactory.open(null, true);
            final DatagramSocket listening = socket;
            hostDiscovery = socket;
            datagrams.execute(() -> hostLoop(listening, generation));
            advertisementStatus(true, null);
        } catch (IOException | RuntimeException error) {
            if (socket != null) socket.close();
            hostDiscovery = null;
            retryHost(generation, error instanceof BindException ? "DISCOVERY_PORT_IN_USE" : "DISCOVERY_BIND_FAILED");
        }
    }
    private synchronized void retryHost(int generation, String error) {
        if (closed || generation != hostGeneration || advertisement == null) return;
        closeHostSockets(); diagnostic("host", error); advertisementStatus(false, error);
        if (hostRetries >= retryDelays.length) return;
        hostRetry = scheduler.schedule(() -> openHost(generation), retryDelays[hostRetries++], TimeUnit.MILLISECONDS);
    }
    private void advertisementStatus(boolean available, String error) {
        hostAvailable = available;
        Map<String, Object> event = event("advertisement-status"); event.put("discoveryAvailable", available);
        if (error != null) event.put("error", error);
        emit(event);
    }
    private void hostLoop(DatagramSocket socket, int generation) {
        byte[] buffer = new byte[2049]; long window = System.nanoTime(); int requests = 0;
        while (!socket.isClosed() && !closed) {
            try {
                DatagramPacket packet = new DatagramPacket(buffer, buffer.length); socket.receive(packet);
                if (packet.getLength() > 2048) { diagnostic("host", "REJECT_OVERSIZE"); continue; }
                Selection path = replyPath(packet.getAddress());
                if (path == null) { diagnostic("host", "REJECT_NON_LAN_SOURCE"); continue; }
                long now = System.nanoTime(); if (now - window >= 1000000000L) { window = now; requests = 0; }
                if (++requests > 30) continue;
                String token;
                try { token = codec.readQuery(Arrays.copyOfRange(packet.getData(), packet.getOffset(), packet.getOffset() + packet.getLength())); }
                catch (IOException error) { diagnostic("host", "REJECT_QUERY"); continue; }
                if (token == null) { diagnostic("host", "REJECT_QUERY"); continue; }
                Advertisement current = advertisement;
                if (current == null || generation != hostGeneration) return;
                byte[] reply = codec.reply(token, current);
                try {
                    DatagramSocket sender = replySocket(path, generation);
                    if (sender != null) sender.send(new DatagramPacket(reply, reply.length, packet.getAddress(), packet.getPort()));
                } catch (IOException error) {
                    diagnostic("host", "REPLY_FAILED " + path.label());
                    synchronized (this) { DatagramSocket failed = replySockets.remove(path.key()); if (failed != null) failed.close(); }
                    // A failed destination must not stop the listener for every other peer.
                }
            } catch (SocketTimeoutException ignored) { }
            catch (PortUnreachableException ignored) { diagnostic("host", "UDP_UNREACHABLE"); }
            catch (IOException | RuntimeException error) {
                if (!socket.isClosed()) retryHost(generation, "DISCOVERY_RECEIVE_FAILED");
                return;
            }
        }
    }
    private Selection replyPath(InetAddress remote) {
        Selection best = null;
        for (Selection path : hostPaths) if (path.sameSubnet(remote) && (best == null || path.prefix > best.prefix)) best = path;
        return best;
    }
    private synchronized DatagramSocket replySocket(Selection path, int generation) throws IOException {
        if (closed || generation != hostGeneration) return null;
        DatagramSocket socket = replySockets.get(path.key());
        if (socket == null || socket.isClosed()) { socket = socketFactory.open(path, false); replySockets.put(path.key(), socket); }
        return socket;
    }

    public String connect(String address, int port) throws IOException {
        checkOpen(); validateIpv4(address);
        List<Selection> paths = boundedPaths();
        if (paths.isEmpty()) throw new IOException("NO_LOCAL_NETWORK");
        InetAddress remote = InetAddress.getByName(address); Selection chosen = paths.get(0);
        for (Selection path : paths) if (path.sameSubnet(remote)) { chosen = path; break; }
        final Selection selected = chosen; selection = selected;
        return tcp.connect(address, port, () -> {
            if (selected.network != null) return selected.network.getSocketFactory().createSocket();
            Socket socket = new Socket(); socket.bind(new InetSocketAddress(selected.address, 0)); return socket;
        });
    }
    public void send(String connectionId, String message) throws IOException { checkOpen(); tcp.send(connectionId, message); }
    public void disconnect(String connectionId) { tcp.disconnect(connectionId); }

    public synchronized void discover(String scanId, List<String> recentAddresses) throws IOException {
        checkOpen();
        if (scanId == null || !scanId.matches("[A-Za-z0-9_-]{1,80}")) throw new IOException("INVALID_SCAN_ID");
        stopDiscovery();
        Scan current = new Scan(scanId); scan = current;
        List<Selection> available;
        try { available = boundedPaths(); }
        catch (IOException | RuntimeException error) { current.errors.incrementAndGet(); diagnostic(scanId, "ENUMERATE_FAILED"); finishScan(current, "failed", "NO_LOCAL_NETWORK"); return; }
        List<String> recent = recentAddresses == null ? Collections.emptyList()
            : recentAddresses.subList(0, Math.min(8, recentAddresses.size()));
        for (Selection path : available) current.paths.add(new ScanPath(path, recentTargets(path, recent)));
        scanStatus(current, "scanning", null);
        if (current.paths.isEmpty()) { finishScan(current, "failed", "NO_LOCAL_NETWORK"); return; }
        for (ScanPath path : current.paths) openScanPath(current, path, false);
        if (scan != current || current.finished) return;
        for (long delay : queryDelays) current.tasks.add(scheduler.schedule(() -> sendRound(current), delay, TimeUnit.MILLISECONDS));
        current.tasks.add(scheduler.schedule(() -> finishScan(current, current.sent.get() == 0 ? "failed" : "completed",
            current.sent.get() == 0 ? "ALL_QUERIES_FAILED" : null), scanDuration, TimeUnit.MILLISECONDS));
    }
    public synchronized void stopDiscovery() { if (scan != null) finishScan(scan, "cancelled", null); }
    private synchronized void openScanPath(Scan current, ScanPath path, boolean retry) {
        if (closed || current != scan || current.finished) return;
        DatagramSocket socket = null;
        try {
            socket = socketFactory.open(path.selection, false); path.socket = socket;
            final DatagramSocket listening = socket;
            datagrams.execute(() -> scanLoop(current, path, listening));
            diagnostic(current.id, "BOUND " + path.selection.label());
            if (retry) scheduler.execute(() -> sendPath(current, path));
        } catch (IOException | RuntimeException error) {
            if (socket != null) socket.close(); path.socket = null;
            retryScanPath(current, path, "BIND_FAILED");
        }
    }
    private synchronized void retryScanPath(Scan current, ScanPath path, String reason) {
        if (closed || scan != current || current.finished) return;
        DatagramSocket socket = path.socket; path.socket = null; if (socket != null) socket.close();
        current.errors.incrementAndGet(); diagnostic(current.id, reason + " " + path.selection.label());
        if (path.retries < retryDelays.length) {
            long delay = retryDelays[path.retries++];
            current.tasks.add(scheduler.schedule(() -> openScanPath(current, path, true), delay, TimeUnit.MILLISECONDS));
        } else {
            path.exhausted = true;
            boolean allFailed = true;
            for (ScanPath other : current.paths) if (!other.exhausted) allFailed = false;
            if (allFailed) finishScan(current, "failed", "DISCOVERY_RECEIVE_FAILED");
        }
    }
    private void sendRound(Scan current) {
        for (ScanPath path : current.paths) sendPath(current, path);
        synchronized (this) { if (scan == current && !current.finished) scanStatus(current, "scanning", null); }
    }
    private void sendPath(Scan current, ScanPath path) {
        DatagramSocket socket = path.socket;
        if (closed || scan != current || current.finished || socket == null || socket.isClosed()) return;
        byte[] query;
        try { query = codec.query(current.queryId); }
        catch (IOException error) { finishScan(current, "failed", "DISCOVERY_ENCODE_FAILED"); return; }
        for (InetAddress target : path.targets) {
            if (current.finished || scan != current || socket.isClosed()) return;
            try {
                socket.send(new DatagramPacket(query, query.length, target, DISCOVERY_PORT)); current.sent.incrementAndGet();
                diagnostic(current.id, "SENT " + path.selection.address.getHostAddress() + " -> " + target.getHostAddress());
            } catch (IOException | RuntimeException error) {
                if (current.finished || scan != current || socket.isClosed()) return;
                current.errors.incrementAndGet(); diagnostic(current.id, "SEND_FAILED " + path.selection.address.getHostAddress() + " -> " + target.getHostAddress());
            }
        }
    }
    private void scanLoop(Scan current, ScanPath path, DatagramSocket socket) {
        byte[] bytes = new byte[2049]; long window = System.nanoTime(); int receivedInWindow = 0;
        while (!socket.isClosed() && !current.finished) {
            try {
                DatagramPacket packet = new DatagramPacket(bytes, bytes.length); socket.receive(packet);
                if (current != scan || socket != path.socket || current.finished) return;
                long now = System.nanoTime(); if (now - window >= 1000000000L) { window = now; receivedInWindow = 0; }
                if (++receivedInWindow > 30) continue;
                current.received.incrementAndGet();
                if (packet.getLength() > 2048 || !path.selection.sameSubnet(packet.getAddress())) { diagnostic(current.id, "REJECT_SOURCE_OR_SIZE"); continue; }
                Map<String, Object> room;
                try { room = codec.readReply(Arrays.copyOfRange(packet.getData(), packet.getOffset(), packet.getOffset() + packet.getLength()), current.queryId, packet.getAddress().getHostAddress()); }
                catch (IOException error) { diagnostic(current.id, "REJECT_REPLY"); continue; }
                if (room == null) { diagnostic(current.id, "REJECT_REPLY"); continue; }
                synchronized (this) {
                    if (scan != current || current.finished || socket != path.socket) return;
                    Map<String, Object> event = event("discovered"); event.put("scanId", current.id); event.put("room", room); emit(event);
                }
            } catch (SocketTimeoutException ignored) { }
            catch (PortUnreachableException ignored) { current.errors.incrementAndGet(); diagnostic(current.id, "UDP_UNREACHABLE"); }
            catch (IOException | RuntimeException error) {
                if (!socket.isClosed()) retryScanPath(current, path, "RECEIVE_FAILED");
                return;
            }
        }
    }
    private synchronized void finishScan(Scan current, String status, String error) {
        if (current != scan || current.finished) return;
        current.finished = true; scan = null;
        for (ScheduledFuture<?> task : current.tasks) task.cancel(false);
        for (ScanPath path : current.paths) { DatagramSocket socket = path.socket; path.socket = null; if (socket != null) socket.close(); }
        scanStatus(current, status, error);
    }
    private void scanStatus(Scan current, String status, String error) {
        Map<String, Object> event = event("discovery-status");
        event.put("scanId", current.id); event.put("status", status); event.put("paths", current.paths.size());
        event.put("sent", current.sent.get()); event.put("received", current.received.get()); event.put("errors", current.errors.get());
        event.put("diagnostics", diagnosticSnapshot()); if (error != null) event.put("error", error); emit(event);
    }
    private static final class Scan {
        final String id, queryId = UUID.randomUUID().toString();
        final List<ScanPath> paths = new ArrayList<>(); final List<ScheduledFuture<?>> tasks = new ArrayList<>();
        final AtomicInteger sent = new AtomicInteger(), received = new AtomicInteger(), errors = new AtomicInteger();
        volatile boolean finished;
        Scan(String id) { this.id = id; }
    }
    private static final class ScanPath {
        final Selection selection; final List<InetAddress> targets;
        volatile DatagramSocket socket; int retries; boolean exhausted;
        ScanPath(Selection selection, List<InetAddress> targets) { this.selection = selection; this.targets = targets; }
    }

    private List<Selection> boundedPaths() throws IOException {
        List<Selection> found = pathProvider.paths();
        return new ArrayList<>(found.subList(0, Math.min(MAX_PATHS, found.size())));
    }
    private List<Selection> enumeratePaths() throws IOException {
        List<Selection> candidates = new ArrayList<>(); Set<InetAddress> known = new HashSet<>();
        if (connectivity != null) {
            for (Network network : connectivity.getAllNetworks()) {
                NetworkCapabilities caps = connectivity.getNetworkCapabilities(network); LinkProperties properties = connectivity.getLinkProperties(network);
                if (caps == null || properties == null || caps.hasTransport(NetworkCapabilities.TRANSPORT_VPN)
                    || (!caps.hasTransport(NetworkCapabilities.TRANSPORT_WIFI) && !caps.hasTransport(NetworkCapabilities.TRANSPORT_ETHERNET))) continue;
                for (LinkAddress link : properties.getLinkAddresses()) if (usable(link.getAddress()) && known.add(link.getAddress()))
                    candidates.add(new Selection(network, (Inet4Address) link.getAddress(), link.getPrefixLength(), "network:" + properties.getInterfaceName()));
            }
        }
        java.util.Enumeration<NetworkInterface> available = NetworkInterface.getNetworkInterfaces();
        List<NetworkInterface> interfaces = available == null ? new ArrayList<>() : Collections.list(available);
        interfaces.sort(Comparator.comparing(NetworkInterface::getName));
        for (NetworkInterface network : interfaces) {
            String name = network.getName().toLowerCase(java.util.Locale.ROOT);
            if (!network.isUp() || network.isLoopback() || network.isPointToPoint()
                || name.startsWith("rmnet") || name.startsWith("ccmni") || name.startsWith("pdp")
                || name.startsWith("tun") || name.startsWith("ipsec") || name.startsWith("vti")) continue;
            for (InterfaceAddress link : network.getInterfaceAddresses()) if (usable(link.getAddress()) && known.add(link.getAddress()))
                candidates.add(new Selection(null, (Inet4Address) link.getAddress(), link.getNetworkPrefixLength(), "interface:" + network.getName()));
        }
        return candidates;
    }
    static DatagramSocket openDatagram(Selection selected, boolean host) throws IOException {
        DatagramSocket socket = new DatagramSocket(null);
        try {
            socket.setReuseAddress(false); socket.setBroadcast(true);
            if (selected != null && selected.network != null) selected.network.bindSocket(socket);
            socket.bind(host ? new InetSocketAddress(DISCOVERY_PORT) : new InetSocketAddress(selected.address, 0));
            socket.setSoTimeout(1000); return socket;
        } catch (IOException | RuntimeException error) { socket.close(); throw error; }
    }
    static List<InetAddress> recentTargets(Selection path, List<String> recent) throws IOException {
        LinkedHashSet<InetAddress> targets = new LinkedHashSet<>(path.broadcasts()); int accepted = 0;
        if (recent != null) for (String value : recent) {
            if (accepted >= 8) break;
            if (value == null || value.length() > 64) continue;
            String address = value.split(":", 2)[0];
            try {
                InetAddress parsed = numericIpv4(address);
                if (!path.sameSubnet(parsed) || parsed.equals(path.address) || !unicastOnPath(path, parsed)) continue;
                if (targets.add(parsed)) accepted++;
            } catch (IOException ignored) { }
        }
        return new ArrayList<>(targets);
    }
    private static boolean unicastOnPath(Selection path, InetAddress address) {
        if (address.isAnyLocalAddress() || address.isMulticastAddress()) return false;
        byte[] bytes = address.getAddress();
        if ((bytes[0] & 255) == 0 || (bytes[0] & 255) >= 224) return false;
        if (path.prefix >= 31) return true;
        boolean zero = true, one = true;
        for (int bit = path.prefix; bit < 32; bit++) { boolean set = (bytes[bit / 8] & (1 << (7 - bit % 8))) != 0; zero &= !set; one &= set; }
        return !zero && !one;
    }
    static final class Selection {
        final Network network; final Inet4Address address; final int prefix; final String source;
        Selection(Network network, Inet4Address address, int prefix, String source) {
            this.network = network; this.address = address; this.prefix = Math.max(0, Math.min(32, prefix)); this.source = source;
        }
        String key() { return address.getHostAddress(); }
        String label() { return source + " " + address.getHostAddress() + "/" + prefix; }
        boolean sameSubnet(InetAddress other) {
            if (!(other instanceof Inet4Address)) return false;
            byte[] mine = address.getAddress(), theirs = other.getAddress();
            for (int bit = 0; bit < prefix; bit++) if (((mine[bit / 8] ^ theirs[bit / 8]) & (1 << (7 - bit % 8))) != 0) return false;
            return true;
        }
        List<InetAddress> broadcasts() throws IOException {
            LinkedHashSet<InetAddress> targets = new LinkedHashSet<>();
            if (prefix <= 30) {
                byte[] addressBytes = address.getAddress();
                for (int bit = prefix; bit < 32; bit++) addressBytes[bit / 8] |= (byte) (1 << (7 - bit % 8));
                targets.add(InetAddress.getByAddress(addressBytes));
            }
            targets.add(InetAddress.getByName("255.255.255.255")); return new ArrayList<>(targets);
        }
    }
    private static boolean usable(InetAddress address) {
        return address instanceof Inet4Address && !address.isLoopbackAddress() && !address.isAnyLocalAddress() && !address.isMulticastAddress();
    }
    private static InetAddress numericIpv4(String address) throws IOException {
        if (address == null || !address.matches("[0-9]{1,3}(\\.[0-9]{1,3}){3}")) throw new IOException("INVALID_ADDRESS");
        for (String part : address.split("\\.")) if (Integer.parseInt(part) > 255) throw new IOException("INVALID_ADDRESS");
        return InetAddress.getByName(address);
    }
    private static void validateIpv4(String address) throws IOException { if (!usable(numericIpv4(address))) throw new IOException("INVALID_ADDRESS"); }
    private void checkOpen() throws IOException { if (closed) throw new IOException("DISPOSED"); }
    private void diagnostic(String id, String value) {
        synchronized (diagnostics) { while (diagnostics.size() >= MAX_DIAGNOSTICS) diagnostics.removeFirst(); diagnostics.addLast(id + " " + value); }
    }
    List<String> diagnosticSnapshot() { synchronized (diagnostics) { return new ArrayList<>(diagnostics); } }
    private static Map<String, Object> event(String name) { Map<String, Object> event = new LinkedHashMap<>(); event.put("type", "lan-event"); event.put("event", name); return event; }
    private void emit(Map<String, Object> event) { try { listener.onDiscoveryEvent(event); } catch (RuntimeException ignored) { } }

    @Override public synchronized void close() {
        if (closed) return;
        stopDiscovery(); closed = true; stopHost(); tcp.close(); datagrams.shutdownNow(); scheduler.shutdownNow();
        if (connectivity != null && callbackRegistered) {
            try { connectivity.unregisterNetworkCallback(networkCallback); } catch (RuntimeException ignored) { }
            callbackRegistered = false;
        }
        selection = null;
    }
    private static Map<String, Object> objectMap(JSONObject object) throws IOException {
        if (object == null) throw new IOException("INVALID_METADATA");
        Map<String, Object> result = new LinkedHashMap<>(); Iterator<String> keys = object.keys();
        while (keys.hasNext()) { String key = keys.next(); result.put(key, object.opt(key)); }
        return result;
    }
    private static final class JsonCodec implements DiscoveryCodec {
        public byte[] query(String queryId) throws IOException {
            try { return new JSONObject().put("magic", MAGIC).put("queryId", queryId).toString().getBytes(StandardCharsets.UTF_8); }
            catch (JSONException error) { throw new IOException("ENCODE_FAILED", error); }
        }
        public String readQuery(byte[] bytes) throws IOException {
            try {
                JSONObject query = new JSONObject(new String(bytes, StandardCharsets.UTF_8)); Object token = query.opt("queryId");
                return MAGIC.equals(query.optString("magic")) && token instanceof String && ((String) token).length() > 0
                    && ((String) token).length() <= 80 ? (String) token : null;
            } catch (JSONException error) { throw new IOException("INVALID_QUERY", error); }
        }
        public byte[] reply(String queryId, Advertisement advertisement) throws IOException {
            try { return new JSONObject().put("magic", MAGIC).put("queryId", queryId).put("name", advertisement.name)
                .put("port", advertisement.port).put("metadata", new JSONObject(advertisement.metadata)).toString().getBytes(StandardCharsets.UTF_8); }
            catch (JSONException error) { throw new IOException("ENCODE_FAILED", error); }
        }
        public Map<String, Object> readReply(byte[] bytes, String queryId, String source) throws IOException {
            try {
                JSONObject reply = new JSONObject(new String(bytes, StandardCharsets.UTF_8));
                int port = reply.optInt("port", 0); JSONObject metadata = reply.optJSONObject("metadata"); String name = reply.optString("name", "");
                if (!MAGIC.equals(reply.optString("magic")) || !queryId.equals(reply.optString("queryId")) || port < 1 || port > 65535
                    || name.isEmpty() || name.codePointCount(0, name.length()) > 24 || metadata == null || metadata.toString().length() > 1024) return null;
                Map<String, Object> room = new LinkedHashMap<>(); room.put("name", name); room.put("address", source);
                room.put("port", port); room.put("metadata", objectMap(metadata)); return room;
            } catch (JSONException error) { throw new IOException("INVALID_REPLY", error); }
        }
    }
}
