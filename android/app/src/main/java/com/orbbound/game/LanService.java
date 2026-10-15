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
import java.net.DatagramPacket;
import java.net.DatagramSocket;
import java.net.Inet4Address;
import java.net.InetAddress;
import java.net.InetSocketAddress;
import java.net.InterfaceAddress;
import java.net.NetworkInterface;
import java.net.Socket;
import java.net.SocketTimeoutException;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Collections;
import java.util.Comparator;
import java.util.HashSet;
import java.util.List;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.ArrayBlockingQueue;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.ScheduledFuture;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.ThreadPoolExecutor;
import org.json.JSONException;
import org.json.JSONObject;

/** Android interface selection and UDP discovery; game payloads stay opaque in TCP. */
public final class LanService implements Closeable {
    private static final int DISCOVERY_PORT = 42170;
    private static final String MAGIC = "ORBBOUND_LAN_1";
    private final Listener listener;
    private final ConnectivityManager connectivity;
    private final LanTcpService tcp;
    private final ExecutorService datagrams = new ThreadPoolExecutor(2, 2, 0, TimeUnit.MILLISECONDS, new ArrayBlockingQueue<>(8));
    private final ScheduledExecutorService scheduler = Executors.newSingleThreadScheduledExecutor();
    private volatile Selection selection;
    private volatile DatagramSocket hostDiscovery, clientDiscovery;
    private volatile boolean closed;
    private ScheduledFuture<?> queryTask;
    private String queryId;
    private boolean callbackRegistered;

    public interface Listener {
        void onEvent(String event, String connectionId, String message, JSONObject room, String error);
    }

    public static final class HostInfo {
        public final String address;
        public final int port;
        public final boolean discoveryAvailable;
        HostInfo(String address, int port, boolean discoveryAvailable) {
            this.address = address; this.port = port; this.discoveryAvailable = discoveryAvailable;
        }
    }

    private final ConnectivityManager.NetworkCallback networkCallback = new ConnectivityManager.NetworkCallback() {
        @Override public void onLost(Network network) {
            Selection current = selection;
            if (current != null && network.equals(current.network)) networkChanged();
        }
        @Override public void onLinkPropertiesChanged(Network network, LinkProperties properties) {
            Selection current = selection;
            if (current == null || !network.equals(current.network)) return;
            boolean addressPresent = false;
            for (LinkAddress address : properties.getLinkAddresses()) {
                if (address.getAddress().equals(current.address)) addressPresent = true;
            }
            if (!addressPresent) networkChanged();
        }
    };

    public LanService(Context context, Listener listener) {
        this.listener = listener;
        this.connectivity = (ConnectivityManager) context.getSystemService(Context.CONNECTIVITY_SERVICE);
        tcp = new LanTcpService((event, id, message, error) -> listener.onEvent(event, id, message, null, error));
        if (connectivity != null) {
            try {
                connectivity.registerNetworkCallback(new NetworkRequest.Builder()
                    .addTransportType(NetworkCapabilities.TRANSPORT_WIFI)
                    .addTransportType(NetworkCapabilities.TRANSPORT_ETHERNET).build(), networkCallback);
                callbackRegistered = true;
            } catch (RuntimeException ignored) { /* Socket errors still expose permission/network failure. */ }
        }
    }

    private synchronized void networkChanged() {
        if (closed) return;
        listener.onEvent("error", null, null, null, "NETWORK_CHANGED");
        close();
    }

    public boolean isClosed() { return closed; }

    public synchronized HostInfo startHost(String name, JSONObject metadata, int requestedPort) throws IOException {
        checkOpen();
        stopHost();
        Selection selected = chooseNetwork(null);
        selection = selected;
        int port = tcp.startHost(selected.address, requestedPort);
        boolean discoveryAvailable = false;
        DatagramSocket socket = null;
        try {
            socket = datagram(selected, DISCOVERY_PORT);
            final DatagramSocket listening = socket;
            hostDiscovery = listening;
            datagrams.execute(() -> hostDiscoveryLoop(listening, selected, name, metadata, port));
            discoveryAvailable = true;
        } catch (IOException | RuntimeException error) {
            if (socket != null) socket.close();
            hostDiscovery = null;
        }
        return new HostInfo(selected.address.getHostAddress(), port, discoveryAvailable);
    }

    public synchronized void stopHost() {
        DatagramSocket previous = hostDiscovery;
        hostDiscovery = null;
        if (previous != null) previous.close();
        tcp.stopHost();
    }

    public String connect(String address, int port) throws IOException {
        checkOpen();
        validateIpv4(address);
        Selection selected = chooseNetwork(address);
        selection = selected;
        return tcp.connect(address, port, () -> {
            if (selected.network != null) return selected.network.getSocketFactory().createSocket();
            Socket socket = new Socket();
            socket.bind(new InetSocketAddress(selected.address, 0));
            return socket;
        });
    }

    public void send(String connectionId, String message) throws IOException { checkOpen(); tcp.send(connectionId, message); }
    public void disconnect(String connectionId) { tcp.disconnect(connectionId); }

    public synchronized void discover() throws IOException {
        checkOpen();
        stopDiscovery();
        Selection selected = chooseNetwork(null);
        selection = selected;
        final DatagramSocket socket = datagram(selected, 0);
        clientDiscovery = socket;
        final String token = UUID.randomUUID().toString();
        queryId = token;
        try {
            datagrams.execute(() -> clientDiscoveryLoop(socket, token));
            queryTask = scheduler.scheduleAtFixedRate(() -> {
                try {
                    byte[] data = new JSONObject().put("magic", MAGIC).put("queryId", token).toString().getBytes(StandardCharsets.UTF_8);
                    for (InetAddress target : selected.broadcasts()) {
                        if (socket.isClosed()) return;
                        socket.send(new DatagramPacket(data, data.length, target, DISCOVERY_PORT));
                    }
                } catch (IOException | JSONException error) {
                    if (!socket.isClosed()) listener.onEvent("error", null, null, null, "DISCOVERY_FAILED");
                }
            }, 0, 2, TimeUnit.SECONDS);
        } catch (RuntimeException error) { stopDiscovery(); throw new IOException("BUSY", error); }
    }

    public synchronized void stopDiscovery() {
        if (queryTask != null) queryTask.cancel(false);
        queryTask = null;
        queryId = null;
        DatagramSocket previous = clientDiscovery;
        clientDiscovery = null;
        if (previous != null) previous.close();
    }

    private DatagramSocket datagram(Selection selected, int port) throws IOException {
        DatagramSocket socket = new DatagramSocket(null);
        try {
            socket.setReuseAddress(false);
            socket.setBroadcast(true);
            if (selected.network != null) selected.network.bindSocket(socket);
            // UDP listeners bind wildcard to receive broadcasts; replies are restricted to this subnet.
            socket.bind(new InetSocketAddress(port));
            socket.setSoTimeout(1000);
            return socket;
        } catch (IOException | RuntimeException error) { socket.close(); throw error; }
    }

    private void hostDiscoveryLoop(DatagramSocket socket, Selection selected, String name, JSONObject metadata, int port) {
        byte[] bytes = new byte[2049];
        long window = System.nanoTime();
        int requests = 0;
        while (!socket.isClosed()) {
            try {
                DatagramPacket packet = new DatagramPacket(bytes, bytes.length);
                socket.receive(packet);
                if (packet.getLength() > 2048 || !selected.sameSubnet(packet.getAddress())) continue;
                long now = System.nanoTime();
                if (now - window > 1000000000L) { window = now; requests = 0; }
                if (++requests > 20) continue;
                JSONObject query = new JSONObject(new String(packet.getData(), packet.getOffset(), packet.getLength(), StandardCharsets.UTF_8));
                Object token = query.opt("queryId");
                if (!MAGIC.equals(query.optString("magic")) || !(token instanceof String)
                    || ((String) token).length() < 1 || ((String) token).length() > 80) continue;
                byte[] reply = new JSONObject().put("magic", MAGIC).put("queryId", token)
                    .put("name", name).put("port", port).put("metadata", metadata).toString().getBytes(StandardCharsets.UTF_8);
                socket.send(new DatagramPacket(reply, reply.length, packet.getAddress(), packet.getPort()));
            } catch (SocketTimeoutException ignored) { }
            catch (JSONException ignored) { }
            catch (IOException | RuntimeException error) {
                if (!socket.isClosed()) listener.onEvent("error", null, null, null, "DISCOVERY_FAILED");
                return;
            }
        }
    }

    private void clientDiscoveryLoop(DatagramSocket socket, String token) {
        byte[] bytes = new byte[2049];
        long window = System.nanoTime();
        int responses = 0;
        while (!socket.isClosed()) {
            try {
                DatagramPacket packet = new DatagramPacket(bytes, bytes.length);
                socket.receive(packet);
                if (packet.getLength() > 2048 || !(packet.getAddress() instanceof Inet4Address)) continue;
                long now = System.nanoTime();
                if (now - window > 1000000000L) { window = now; responses = 0; }
                if (++responses > 30) continue;
                JSONObject reply = new JSONObject(new String(packet.getData(), packet.getOffset(), packet.getLength(), StandardCharsets.UTF_8));
                int port = reply.optInt("port", 0);
                JSONObject metadata = reply.optJSONObject("metadata");
                String name = reply.optString("name", "");
                if (!token.equals(queryId) || !MAGIC.equals(reply.optString("magic"))
                    || !token.equals(reply.optString("queryId")) || port < 1 || port > 65535
                    || name.length() < 1 || name.codePointCount(0, name.length()) > 24 || metadata == null
                    || metadata.toString().length() > 1024) continue;
                JSONObject room = new JSONObject().put("name", name).put("address", packet.getAddress().getHostAddress())
                    .put("port", port).put("metadata", metadata);
                listener.onEvent("discovered", null, null, room, null);
            } catch (SocketTimeoutException ignored) { }
            catch (JSONException ignored) { }
            catch (IOException | RuntimeException error) {
                if (!socket.isClosed()) listener.onEvent("error", null, null, null, "DISCOVERY_FAILED");
                return;
            }
        }
    }

    private Selection chooseNetwork(String remoteAddress) throws IOException {
        List<Selection> candidates = new ArrayList<>();
        Set<InetAddress> known = new HashSet<>();
        // Internet validation and the default network are deliberately irrelevant for LAN play.
        if (connectivity != null) {
            for (Network network : connectivity.getAllNetworks()) {
                NetworkCapabilities caps = connectivity.getNetworkCapabilities(network);
                LinkProperties properties = connectivity.getLinkProperties(network);
                if (caps == null || properties == null || caps.hasTransport(NetworkCapabilities.TRANSPORT_VPN)
                    || (!caps.hasTransport(NetworkCapabilities.TRANSPORT_WIFI) && !caps.hasTransport(NetworkCapabilities.TRANSPORT_ETHERNET))) continue;
                for (LinkAddress link : properties.getLinkAddresses()) {
                    if (usable(link.getAddress()) && known.add(link.getAddress()))
                        candidates.add(new Selection(network, (Inet4Address) link.getAddress(), link.getPrefixLength()));
                }
            }
        }
        // Tethering interfaces may not appear as Android Network objects. Do not hardcode hotspot IPs.
        java.util.Enumeration<NetworkInterface> available = NetworkInterface.getNetworkInterfaces();
        List<NetworkInterface> interfaces = available == null ? new ArrayList<>() : Collections.list(available);
        interfaces.sort(Comparator.comparing(NetworkInterface::getName));
        for (NetworkInterface network : interfaces) {
            String name = network.getName().toLowerCase(java.util.Locale.ROOT);
            if (!network.isUp() || network.isLoopback() || network.isPointToPoint()
                || name.startsWith("rmnet") || name.startsWith("ccmni") || name.startsWith("pdp")
                || name.startsWith("tun") || name.startsWith("ipsec") || name.startsWith("vti")) continue;
            for (InterfaceAddress link : network.getInterfaceAddresses()) {
                if (usable(link.getAddress()) && known.add(link.getAddress())) {
                    Selection candidate = new Selection(null, (Inet4Address) link.getAddress(), link.getNetworkPrefixLength());
                    // Prefer the actual tethering interface when Wi-Fi sharing keeps an upstream Wi-Fi alive.
                    if (name.startsWith("ap") || name.startsWith("softap") || name.startsWith("swlan")) candidates.add(0, candidate);
                    else candidates.add(candidate);
                }
            }
        }
        if (remoteAddress != null) {
            InetAddress remote = InetAddress.getByName(remoteAddress);
            for (Selection candidate : candidates) if (candidate.sameSubnet(remote)) return candidate;
        }
        if (!candidates.isEmpty()) return candidates.get(0);
        throw new IOException("NO_LOCAL_NETWORK");
    }

    private static boolean usable(InetAddress address) {
        return address instanceof Inet4Address && !address.isLoopbackAddress() && !address.isAnyLocalAddress()
            && !address.isMulticastAddress();
    }

    private static void validateIpv4(String address) throws IOException {
        if (address == null || !address.matches("[0-9]{1,3}(\\.[0-9]{1,3}){3}")) throw new IOException("INVALID_ADDRESS");
        for (String part : address.split("\\.")) if (Integer.parseInt(part) > 255) throw new IOException("INVALID_ADDRESS");
        InetAddress parsed = InetAddress.getByName(address);
        if (!usable(parsed)) throw new IOException("INVALID_ADDRESS");
    }

    private void checkOpen() throws IOException { if (closed) throw new IOException("DISPOSED"); }

    @Override public synchronized void close() {
        if (closed) return;
        closed = true;
        stopDiscovery();
        stopHost();
        tcp.close();
        datagrams.shutdownNow();
        scheduler.shutdownNow();
        if (connectivity != null && callbackRegistered) {
            try { connectivity.unregisterNetworkCallback(networkCallback); } catch (RuntimeException ignored) { }
            callbackRegistered = false;
        }
        selection = null;
    }

    private static final class Selection {
        final Network network;
        final Inet4Address address;
        final int prefix;
        Selection(Network network, Inet4Address address, int prefix) {
            this.network = network; this.address = address; this.prefix = Math.max(0, Math.min(32, prefix));
        }
        boolean sameSubnet(InetAddress other) {
            if (!(other instanceof Inet4Address)) return false;
            byte[] mine = address.getAddress(), theirs = other.getAddress();
            for (int bit = 0; bit < prefix; bit++) if (((mine[bit / 8] ^ theirs[bit / 8]) & (1 << (7 - bit % 8))) != 0) return false;
            return true;
        }
        Set<InetAddress> broadcasts() throws IOException {
            Set<InetAddress> addresses = new HashSet<>();
            addresses.add(InetAddress.getByName("255.255.255.255"));
            if (prefix <= 30) {
                byte[] broadcast = address.getAddress();
                for (int bit = prefix; bit < 32; bit++) broadcast[bit / 8] |= (byte) (1 << (7 - bit % 8));
                addresses.add(InetAddress.getByAddress(broadcast));
            }
            return addresses;
        }
    }
}
