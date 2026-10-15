using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Net;
using System.Net.NetworkInformation;
using System.Net.Sockets;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using System.Web.Script.Serialization;

// Network transport only. The shared TypeScript session owns all game rules and identity.
internal sealed class LanService : IDisposable {
    internal const int DiscoveryPort=42170, DefaultPort=42171, MaxFrameBytes=65536;
    const string Magic="ORBBOUND_LAN_1";
    const int MaxPeers=8;
    static readonly UTF8Encoding Utf8=new UTF8Encoding(false,true);
    readonly object sync=new object();
    readonly Dictionary<string,Peer> peers=new Dictionary<string,Peer>();
    readonly HashSet<TcpClient> connecting=new HashSet<TcpClient>();
    readonly Action<Dictionary<string,object>> publish;
    readonly SemaphoreSlim actions=new SemaphoreSlim(1,1);
    TcpListener listener;
    UdpClient advertiser;
    Scan discovery;
    Advertisement advertisement;
    CancellationTokenSource advertisingCancellation;
    int hostGeneration, advertisementRetries;
    readonly Func<LanPath[]> enumeratePaths;
    readonly Action<UdpClient,byte[],IPEndPoint> sendDatagram;
    bool disposed;

    internal LanService(Action<Dictionary<string,object>> publishEvent) : this(publishEvent,EnumeratePaths,null) { }
    internal LanService(Action<Dictionary<string,object>> publishEvent,Func<LanPath[]> paths,Action<UdpClient,byte[],IPEndPoint> sender=null) {
        publish=publishEvent;enumeratePaths=paths;
        sendDatagram=sender??delegate(UdpClient udp,byte[] bytes,IPEndPoint endpoint) { udp.Send(bytes,bytes.Length,endpoint); };
    }
    static Dictionary<string,object> Map(params object[] values) {
        var result=new Dictionary<string,object>();
        for(int i=0;i<values.Length;i+=2)result.Add((string)values[i],values[i+1]);
        return result;
    }
    static string StringField(IDictionary<string,object> payload,string key,int maximum) {
        object value;string text=payload.TryGetValue(key,out value)?value as string:null;
        if(String.IsNullOrWhiteSpace(text)||text.Length>maximum||text.Any(Char.IsControl))throw new ArgumentException("无效的 "+key);
        return text;
    }
    static int PortField(IDictionary<string,object> payload,int fallback) {
        object value;if(!payload.TryGetValue("port",out value))return fallback;
        if(!(value is int)||((int)value)<1||((int)value)>65535)throw new ArgumentException("端口须为 1–65535");
        return (int)value;
    }
    void EnsureAlive() { lock(sync) { if(disposed)throw new ObjectDisposedException("LAN","联机服务已关闭"); } }
    void Emit(string kind,params object[] fields) {
        lock(sync) { if(disposed)return; }
        var evt=Map("type","lan-event","event",kind);
        for(int i=0;i<fields.Length;i+=2)evt[(string)fields[i]]=fields[i+1];
        try { publish(evt); } catch { /* A destroyed UI must not escape a socket worker. */ }
    }

    internal async Task<object> Handle(string action,Dictionary<string,object> payload) {
        if(payload==null)payload=new Dictionary<string,object>();
        // Serial lifecycle operations prevent an in-flight connection escaping dispose/stop.
        await actions.WaitAsync().ConfigureAwait(false);
        try {
            if(action=="dispose") { Dispose();return Map(); }
            EnsureAlive();
            switch(action) {
                case "startHost":return StartHost(payload);
                case "stopHost":StopHost();break;
                case "connect":return await Connect(payload).ConfigureAwait(false);
                case "send": {
                    string id=StringField(payload,"connectionId",128);object value;
                    string message=payload.TryGetValue("message",out value)?value as string:null;
                    if(message==null)throw new ArgumentException("缺少消息内容");
                    Peer peer;lock(sync) { if(!peers.TryGetValue(id,out peer))throw new IOException("连接已断开"); }
                    peer.Send(message);break;
                }
                case "disconnect": {
                    string id=StringField(payload,"connectionId",128);Peer peer;
                    lock(sync)peers.TryGetValue(id,out peer);
                    if(peer!=null)peer.Close(null);break;
                }
                case "discover":StartDiscovery(payload);break;
                case "stopDiscovery":StopDiscovery(payload);break;
                case "updateAdvertisement":UpdateAdvertisement(payload);break;
                default:throw new ArgumentException("未知的联机操作");
            }
            return Map();
        } finally { actions.Release(); }
    }

    object StartHost(Dictionary<string,object> payload) {
        string name=StringField(payload,"name",96);
        var safeMetadata=AdvertisementMetadata(payload);
        int port=PortField(payload,DefaultPort);
        StopHost();
        var server=new TcpListener(IPAddress.Any,port);
        server.Server.ExclusiveAddressUse=true;
        try { server.Start(8); }
        catch(SocketException) {
            server.Stop();server=new TcpListener(IPAddress.Any,0);server.Server.ExclusiveAddressUse=true;server.Start(8);
        }
        int generation;
        lock(sync) {
            if(disposed) { server.Stop();throw new ObjectDisposedException("LAN"); }
            listener=server;generation=++hostGeneration;advertisementRetries=0;advertisingCancellation=new CancellationTokenSource();
        }
        int actualPort=((IPEndPoint)server.LocalEndpoint).Port;
        Task.Run(delegate { AcceptLoop(server,generation); });
        lock(sync)advertisement=new Advertisement(name,actualPort,safeMetadata);
        bool available=StartAdvertiser(generation);
        return Map("addresses",LocalAddresses(),"port",actualPort,"discoveryAvailable",available);
    }
    static string[] LocalAddresses() {
        var result=new List<string>();
        try {
            foreach(var nic in NetworkInterface.GetAllNetworkInterfaces()) {
                if(nic.OperationalStatus!=OperationalStatus.Up||nic.NetworkInterfaceType==NetworkInterfaceType.Loopback)continue;
                foreach(var ip in nic.GetIPProperties().UnicastAddresses)
                    if(ip.Address.AddressFamily==AddressFamily.InterNetwork&&!IPAddress.IsLoopback(ip.Address)&&!result.Contains(ip.Address.ToString()))result.Add(ip.Address.ToString());
            }
        } catch(NetworkInformationException) { }
        if(result.Count==0)result.Add("127.0.0.1");
        return result.ToArray();
    }
    void AcceptLoop(TcpListener server,int generation) {
        try {
            while(true) {
                TcpClient client=server.AcceptTcpClient();
                lock(sync) {
                    if(disposed||generation!=hostGeneration||peers.Count>=MaxPeers) { client.Close();continue; }
                }
                try { AddPeer(client,true,generation); }
                catch(SocketException) { client.Close(); }
                catch(IOException) { client.Close(); }
            }
        } catch(SocketException) { }
        catch(ObjectDisposedException) { }
        catch(Exception error) { Emit("error","error","监听失败："+error.Message); }
    }
    async Task<object> Connect(Dictionary<string,object> payload) {
        string address=StringField(payload,"address",64);int port=PortField(payload,DefaultPort);
        IPAddress ip;
        if(!IPAddress.TryParse(address,out ip)||ip.AddressFamily!=AddressFamily.InterNetwork||ip.Equals(IPAddress.Any)||ip.Equals(IPAddress.Broadcast)||ip.GetAddressBytes()[0]>=224)throw new ArgumentException("请输入有效的 IPv4 地址");
        lock(sync) { if(peers.Count>=MaxPeers)throw new IOException("连接数量已达上限"); }
        var client=new TcpClient(AddressFamily.InterNetwork);
        lock(sync) {
            if(disposed) { client.Close();throw new ObjectDisposedException("LAN"); }
            connecting.Add(client);
        }
        try {
            var connect=client.ConnectAsync(ip,port);
            if(await Task.WhenAny(connect,Task.Delay(5000)).ConfigureAwait(false)!=connect) {
                client.Close();Observe(connect);throw new TimeoutException("连接超时，请确认同一网络、地址和防火墙设置");
            }
            await connect.ConfigureAwait(false);
            string id=AddPeer(client,false,0);
            if(id==null)throw new IOException("联机服务已关闭");
            return Map("connectionId",id);
        } catch { client.Close();throw; }
        finally { lock(sync)connecting.Remove(client); }
    }
    static async void Observe(Task task) { try { await task.ConfigureAwait(false); } catch { } }
    string AddPeer(TcpClient client,bool accepted,int generation) {
        var peer=new Peer(this,client,accepted);
        lock(sync) {
            if(disposed||peers.Count>=MaxPeers||(accepted&&generation!=hostGeneration)) { client.Close();return null; }
            peers.Add(peer.Id,peer);
        }
        Emit("connected","connectionId",peer.Id);
        peer.Start();return peer.Id;
    }
    void RemovePeer(Peer peer,string error) {
        bool removed;lock(sync)removed=peers.Remove(peer.Id);
        if(removed) {
            if(error==null)Emit("disconnected","connectionId",peer.Id);
            else Emit("disconnected","connectionId",peer.Id,"error",error);
        }
    }
    void StopHost() {
        TcpListener server;UdpClient udp;Peer[] accepted;CancellationTokenSource cancellation;
        lock(sync) {
            hostGeneration++;server=listener;listener=null;udp=advertiser;advertiser=null;
            advertisement=null;cancellation=advertisingCancellation;advertisingCancellation=null;
            accepted=peers.Values.Where(p=>p.Accepted).ToArray();
        }
        if(server!=null)server.Stop();if(udp!=null)udp.Close();
        if(cancellation!=null) { cancellation.Cancel();cancellation.Dispose(); }
        foreach(var peer in accepted)peer.Close(null);
    }
    static JavaScriptSerializer Serializer() { return new JavaScriptSerializer { MaxJsonLength=8192,RecursionLimit=8 }; }
    internal static void ConfigureDatagramSocket(Socket socket) {
        // A scanner may close its ephemeral port before our reply reaches it. Windows
        // otherwise turns the resulting ICMP Port Unreachable into a fatal Receive error.
        socket.IOControl(-1744830452,new byte[4],null); // SIO_UDP_CONNRESET = false.
    }
    static Dictionary<string,object> ParseDiscovery(byte[] bytes) {
        if(bytes.Length==0||bytes.Length>4096)return null;
        try { return Serializer().Deserialize<Dictionary<string,object>>(Utf8.GetString(bytes)); } catch { return null; }
    }
    sealed class Advertisement {
        internal readonly string Name;internal readonly int Port;internal readonly Dictionary<string,object> Metadata;
        internal Advertisement(string name,int port,Dictionary<string,object> metadata) { Name=name;Port=port;Metadata=metadata; }
    }
    static Dictionary<string,object> AdvertisementMetadata(Dictionary<string,object> payload) {
        object raw;var metadata=payload.TryGetValue("metadata",out raw)?raw as Dictionary<string,object>:null;
        if(metadata==null)throw new ArgumentException("缺少房间信息");
        StringField(metadata,"roomId",80);StringField(metadata,"rulesHash",128);
        object protocol;if(!metadata.TryGetValue("protocolVersion",out protocol)||!(protocol is int)||(int)protocol<1||(int)protocol>65535)throw new ArgumentException("无效的发现协议版本");
        string json=Serializer().Serialize(metadata);
        if(Utf8.GetByteCount(json)>1024)throw new ArgumentException("房间信息过大");
        return Serializer().Deserialize<Dictionary<string,object>>(json);
    }
    void UpdateAdvertisement(Dictionary<string,object> payload) {
        var metadata=AdvertisementMetadata(payload);
        lock(sync) {
            if(advertisement==null||listener==null)throw new IOException("尚未创建房间");
            if(!Equals(metadata["roomId"],advertisement.Metadata["roomId"]))throw new ArgumentException("不能更改房间身份");
            string name=payload.ContainsKey("name")?StringField(payload,"name",96):advertisement.Name;
            advertisement=new Advertisement(name,advertisement.Port,metadata);
        }
    }
    bool HostCurrent(int generation) { return !disposed&&generation==hostGeneration&&listener!=null&&advertisement!=null; }
    bool StartAdvertiser(int generation) {
        UdpClient udp=null;
        try {
            udp=new UdpClient(AddressFamily.InterNetwork);ConfigureDatagramSocket(udp.Client);
            udp.ExclusiveAddressUse=true;udp.Client.Bind(new IPEndPoint(IPAddress.Any,DiscoveryPort));
            lock(sync) {
                if(!HostCurrent(generation)) { udp.Close();return false; }
                advertiser=udp;
                Emit("advertisement-status","discoveryAvailable",true);
            }
            Observe(AdvertiseLoop(udp,generation));return true;
        } catch(SocketException error) {
            if(udp!=null)udp.Close();AdvertisementFailed(generation,error.SocketErrorCode.ToString());return false;
        } catch(ObjectDisposedException) { if(udp!=null)udp.Close();return false; }
    }
    void AdvertisementFailed(int generation,string reason) {
        int attempt;CancellationToken cancellation;
        lock(sync) {
            if(!HostCurrent(generation))return;
            Emit("advertisement-status","discoveryAvailable",false,"error",reason);
            if(advertisementRetries>=3)return;
            attempt=advertisementRetries++;cancellation=advertisingCancellation.Token;
        }
        Observe(RetryAdvertisement(generation,attempt,cancellation));
    }
    async Task RetryAdvertisement(int generation,int attempt,CancellationToken cancellation) {
        try { await Task.Delay(new[]{500,1000,2000}[attempt],cancellation).ConfigureAwait(false); }
        catch(OperationCanceledException) { return; }
        lock(sync) { if(!HostCurrent(generation)||advertiser!=null)return; }
        StartAdvertiser(generation);
    }
    async Task AdvertiseLoop(UdpClient udp,int generation) {
        var throttle=Stopwatch.StartNew();int inWindow=0;string failure=null;
        try {
            while(true) {
                var datagram=await udp.ReceiveAsync().ConfigureAwait(false);var endpoint=datagram.RemoteEndPoint;
                lock(sync) { if(!HostCurrent(generation)||advertiser!=udp)return; }
                if(throttle.ElapsedMilliseconds>=1000) { throttle.Restart();inWindow=0; }
                if(++inWindow>30)continue;
                var query=ParseDiscovery(datagram.Buffer);object magic,queryId;
                if(query==null||!query.TryGetValue("magic",out magic)||!Equals(magic,Magic)||!query.TryGetValue("queryId",out queryId)||!(queryId is string)||String.IsNullOrEmpty((string)queryId)||((string)queryId).Length>80)continue;
                Advertisement current;lock(sync)current=advertisement;
                if(current==null)return;
                byte[] reply=Utf8.GetBytes(Serializer().Serialize(Map("magic",Magic,"queryId",queryId,"name",current.Name,"port",current.Port,"metadata",current.Metadata)));
                udp.Send(reply,reply.Length,endpoint);
            }
        } catch(SocketException error) { failure=error.SocketErrorCode.ToString(); }
        catch(ObjectDisposedException) { }
        finally {
            udp.Close();
            lock(sync) { if(advertiser==udp)advertiser=null; }
            if(failure!=null)AdvertisementFailed(generation,failure);
        }
    }
    internal sealed class LanPath {
        internal readonly IPAddress Address,Mask;internal readonly string Name;
        internal LanPath(string name,IPAddress address,IPAddress mask) { Name=name;Address=address;Mask=mask; }
        internal bool SameSubnet(IPAddress target) {
            if(target.AddressFamily!=AddressFamily.InterNetwork)return false;
            byte[] local=Address.GetAddressBytes(),other=target.GetAddressBytes(),mask=Mask.GetAddressBytes();
            for(int i=0;i<4;i++)if((local[i]&mask[i])!=(other[i]&mask[i]))return false;
            return true;
        }
        internal IPAddress Broadcast() {
            byte[] address=Address.GetAddressBytes(),mask=Mask.GetAddressBytes();int hostBits=0;
            for(int i=0;i<4;i++) { for(int bit=0;bit<8;bit++)if((mask[i]&(1<<bit))==0)hostBits++;address[i]=(byte)(address[i]|(byte)~mask[i]); }
            return hostBits>=2&&hostBits<32?new IPAddress(address):null;
        }
    }
    static LanPath[] EnumeratePaths() {
        var result=new List<LanPath>();var known=new HashSet<string>();
        foreach(var nic in NetworkInterface.GetAllNetworkInterfaces()) {
            try {
                if(nic.OperationalStatus!=OperationalStatus.Up||nic.NetworkInterfaceType==NetworkInterfaceType.Loopback||nic.NetworkInterfaceType==NetworkInterfaceType.Tunnel||nic.NetworkInterfaceType==NetworkInterfaceType.Ppp)continue;
                foreach(var entry in nic.GetIPProperties().UnicastAddresses) {
                    if(entry.Address.AddressFamily!=AddressFamily.InterNetwork||IPAddress.IsLoopback(entry.Address)||entry.Address.Equals(IPAddress.Any)||entry.IPv4Mask==null||entry.IPv4Mask.Equals(IPAddress.Any)||!known.Add(entry.Address.ToString()))continue;
                    result.Add(new LanPath(nic.Name,entry.Address,entry.IPv4Mask));if(result.Count==32)return result.ToArray();
                }
            } catch(NetworkInformationException) { /* A removed interface must not hide other LAN paths. */ }
        }
        return result.ToArray();
    }
    sealed class ScanSocket {
        internal readonly LanPath Path;internal readonly UdpClient Socket;internal bool Failed;
        internal ScanSocket(LanPath path,UdpClient socket) { Path=path;Socket=socket; }
    }
    sealed class Scan {
        internal readonly string Id,QueryId=Guid.NewGuid().ToString("N");
        internal readonly CancellationTokenSource Cancellation=new CancellationTokenSource();
        internal readonly Stopwatch Clock=Stopwatch.StartNew();
        internal readonly List<ScanSocket> Sockets=new List<ScanSocket>();
        internal readonly List<string> Diagnostics=new List<string>();
        internal readonly Dictionary<string,long> Seen=new Dictionary<string,long>();
        internal readonly string[] Recent;
        internal int Sent,Received,Errors,ReceiveWindowCount;internal long LastStatus,ReceiveWindow;internal bool Finished;
        internal Scan(string id,string[] recent) { Id=id;Recent=recent; }
    }
    static string[] RecentAddresses(Dictionary<string,object> payload) {
        object value;if(!payload.TryGetValue("recentAddresses",out value))return new string[0];
        var values=value as System.Collections.IEnumerable;
        if(values==null||value is string)throw new ArgumentException("最近地址列表无效");
        var addresses=new List<string>();int inspected=0;
        foreach(object item in values) {
            if(++inspected>8)break;
            string text=item as string;if(text==null||text.Length>64)continue;
            string host=text.Split(':')[0];IPAddress ip;
            if(host.Split('.').Length!=4||!IPAddress.TryParse(host,out ip)||ip.AddressFamily!=AddressFamily.InterNetwork||ip.Equals(IPAddress.Any)||ip.Equals(IPAddress.Broadcast)||ip.GetAddressBytes()[0]>=224)continue;
            if(!addresses.Contains(ip.ToString()))addresses.Add(ip.ToString());
        }
        return addresses.ToArray();
    }
    bool ScanCurrent(Scan scan) { return !disposed&&discovery==scan&&!scan.Finished; }
    void ScanDiagnostic(Scan scan,string detail,bool error) {
        if(error)scan.Errors++;
        if(scan.Diagnostics.Count==200)scan.Diagnostics.RemoveAt(0);
        scan.Diagnostics.Add(detail);
    }
    void ScanStatus(Scan scan,string status,string error=null) {
        var evt=Map("type","lan-event","event","discovery-status","scanId",scan.Id,"status",status,"paths",scan.Sockets.Count,"sent",scan.Sent,"received",scan.Received,"errors",scan.Errors,"diagnostics",scan.Diagnostics.ToArray());
        if(error!=null)evt["error"]=error;
        try { publish(evt); } catch { }
        scan.LastStatus=scan.Clock.ElapsedMilliseconds;
    }
    void StartDiscovery(Dictionary<string,object> payload) {
        string scanId=payload.ContainsKey("scanId")?StringField(payload,"scanId",80):Guid.NewGuid().ToString("N");
        var scan=new Scan(scanId,RecentAddresses(payload));StopDiscovery(null);
        lock(sync) { if(disposed) { scan.Cancellation.Dispose();throw new ObjectDisposedException("LAN"); }discovery=scan; }
        LanPath[] paths;
        try { paths=enumeratePaths(); }
        catch(NetworkInformationException error) { paths=new LanPath[0];lock(sync)ScanDiagnostic(scan,"interfaces:"+error.ErrorCode,true); }
        foreach(var path in paths.Take(32)) {
            UdpClient udp=null;
            try {
                udp=new UdpClient(AddressFamily.InterNetwork);ConfigureDatagramSocket(udp.Client);udp.EnableBroadcast=true;
                udp.Client.SendTimeout=250;udp.Client.Bind(new IPEndPoint(path.Address,0));
                lock(sync) {
                    if(!ScanCurrent(scan)) { udp.Close();break; }
                    scan.Sockets.Add(new ScanSocket(path,udp));ScanDiagnostic(scan,"bound:"+path.Name+":"+path.Address,false);
                }
            } catch(SocketException error) { if(udp!=null)udp.Close();lock(sync)ScanDiagnostic(scan,"bind:"+path.Address+":"+error.SocketErrorCode,true); }
        }
        lock(sync) { if(!ScanCurrent(scan)) { scan.Cancellation.Dispose();return; }ScanStatus(scan,"scanning"); }
        if(scan.Sockets.Count==0) { FinishScan(scan,"failed",paths.Length==0?"NO_LOCAL_NETWORK":"DISCOVERY_BIND_FAILED");scan.Cancellation.Dispose();return; }
        foreach(var path in scan.Sockets)Observe(DiscoveryLoop(scan,path));
        Observe(Task.Run(delegate { return RunScan(scan); }));
    }
    async Task RunScan(Scan scan) {
        try {
            byte[] request=Utf8.GetBytes(Serializer().Serialize(Map("magic",Magic,"queryId",scan.QueryId)));
            foreach(int due in new[]{0,1000,2500,5000}) {
                int delay=due-(int)scan.Clock.ElapsedMilliseconds;
                if(delay>0)await Task.Delay(delay,scan.Cancellation.Token).ConfigureAwait(false);
                lock(sync) { if(!ScanCurrent(scan))return; }
                foreach(var path in scan.Sockets)SendDiscovery(scan,path,request);
                lock(sync) { if(ScanCurrent(scan))ScanStatus(scan,"scanning"); }
            }
            int remaining=8000-(int)scan.Clock.ElapsedMilliseconds;
            if(remaining>0)await Task.Delay(remaining,scan.Cancellation.Token).ConfigureAwait(false);
            FinishScan(scan,scan.Sent==0?"failed":"completed",scan.Sent==0?"DISCOVERY_SEND_FAILED":null);
        } catch(OperationCanceledException) { }
        finally { scan.Cancellation.Dispose(); }
    }
    internal static IPAddress[] Targets(LanPath path,string[] recent) {
        var result=new List<IPAddress>();var broadcast=path.Broadcast();if(broadcast!=null)result.Add(broadcast);
        if(!result.Contains(IPAddress.Broadcast))result.Add(IPAddress.Broadcast);
        foreach(string address in recent.Take(8)) {
            IPAddress target;if(!IPAddress.TryParse(address,out target)||!path.SameSubnet(target)||target.Equals(IPAddress.Any)||target.Equals(IPAddress.Broadcast)||target.GetAddressBytes()[0]>=224)continue;
            if(!result.Contains(target))result.Add(target);
        }
        return result.ToArray();
    }
    void SendDiscovery(Scan scan,ScanSocket path,byte[] request) {
        foreach(var target in Targets(path.Path,scan.Recent)) {
            lock(sync) { if(!ScanCurrent(scan)||path.Failed||scan.Clock.ElapsedMilliseconds>=8000)return; }
            try {
                sendDatagram(path.Socket,request,new IPEndPoint(target,DiscoveryPort));
                lock(sync) { if(!ScanCurrent(scan))return;scan.Sent++;ScanDiagnostic(scan,"sent:"+path.Path.Address+">"+target,false); }
            } catch(SocketException error) { lock(sync) { if(ScanCurrent(scan))ScanDiagnostic(scan,"send:"+path.Path.Address+">"+target+":"+error.SocketErrorCode,true); } }
            catch(ObjectDisposedException) { return; }
        }
    }
    async Task DiscoveryLoop(Scan scan,ScanSocket path) {
        try {
            while(true) {
                var datagram=await path.Socket.ReceiveAsync().ConfigureAwait(false);
                var endpoint=datagram.RemoteEndPoint;var packet=ParseDiscovery(datagram.Buffer);
                lock(sync) {
                    if(!ScanCurrent(scan))return;scan.Received++;
                    long now=scan.Clock.ElapsedMilliseconds;
                    if(now-scan.ReceiveWindow>=1000) { scan.ReceiveWindow=now;scan.ReceiveWindowCount=0; }
                    if(++scan.ReceiveWindowCount>60)continue;
                    object magic,id,rawName,rawPort,metadata;
                    if(packet==null||!packet.TryGetValue("magic",out magic)||!Equals(magic,Magic)||!packet.TryGetValue("queryId",out id)||!Equals(id,scan.QueryId)||!packet.TryGetValue("name",out rawName)||!(rawName is string)||((string)rawName).Length>96||((string)rawName).Any(Char.IsControl)||!packet.TryGetValue("port",out rawPort)||!(rawPort is int)||(int)rawPort<1||(int)rawPort>65535||!packet.TryGetValue("metadata",out metadata)||!(metadata is Dictionary<string,object>)) {
                        ScanDiagnostic(scan,"receive:invalid-reply",false);continue;
                    }
                    string key=endpoint.Address+":"+rawPort;long last;
                    if(scan.Seen.TryGetValue(key,out last)&&now-last<500)continue;
                    if(scan.Seen.Count>=64&&!scan.Seen.ContainsKey(key))continue;scan.Seen[key]=now;
                    Emit("discovered","scanId",scan.Id,"room",Map("name",rawName,"address",endpoint.Address.ToString(),"port",rawPort,"metadata",metadata));
                    if(now-scan.LastStatus>=250)ScanStatus(scan,"scanning");
                }
            }
        } catch(SocketException error) {
            bool failed=false;
            lock(sync) {
                if(ScanCurrent(scan)) { path.Failed=true;ScanDiagnostic(scan,"receive:"+path.Path.Address+":"+error.SocketErrorCode,true);failed=scan.Sockets.All(item=>item.Failed); }
            }
            if(failed)FinishScan(scan,"failed","DISCOVERY_RECEIVE_FAILED");
        } catch(ObjectDisposedException) { }
        finally { path.Socket.Close(); }
    }
    void FinishScan(Scan scan,string status,string error=null) {
        lock(sync) {
            if(discovery!=scan||scan.Finished)return;
            scan.Finished=true;discovery=null;scan.Cancellation.Cancel();
            foreach(var path in scan.Sockets)path.Socket.Close();
            if(!disposed)ScanStatus(scan,status,error);
        }
    }
    void StopDiscovery(Dictionary<string,object> payload) {
        Scan scan;lock(sync)scan=discovery;
        if(scan==null)return;
        if(payload!=null&&payload.ContainsKey("scanId")&&!Equals(payload["scanId"],scan.Id))return;
        FinishScan(scan,"cancelled");
    }
    public void Dispose() {
        Peer[] connected;TcpClient[] pending;
        lock(sync) { if(disposed)return;disposed=true;connected=peers.Values.ToArray();pending=connecting.ToArray(); }
        foreach(var client in pending)client.Close();
        StopHost();StopDiscovery(null);foreach(var peer in connected)peer.Close(null);
    }

    // Deadline applies to the entire partial frame, not separately to each byte.
    internal static string ReadFrame(NetworkStream stream) {
        stream.ReadTimeout=30000;
        int first=stream.ReadByte();if(first<0)return null;
        var deadline=Stopwatch.StartNew();byte[] prefix=new byte[4];prefix[0]=(byte)first;
        ReadExact(stream,prefix,1,3,deadline);
        uint length=((uint)prefix[0]<<24)|((uint)prefix[1]<<16)|((uint)prefix[2]<<8)|prefix[3];
        if(length==0||length>MaxFrameBytes)throw new IOException("消息长度无效");
        byte[] body=new byte[(int)length];ReadExact(stream,body,0,body.Length,deadline);
        return Utf8.GetString(body);
    }
    static void ReadExact(NetworkStream stream,byte[] bytes,int offset,int count,Stopwatch deadline) {
        while(count>0) {
            int remaining=5000-(int)deadline.ElapsedMilliseconds;
            if(remaining<=0)throw new IOException("接收消息超时");
            stream.ReadTimeout=remaining;
            int read=stream.Read(bytes,offset,count);if(read<=0)throw new IOException("消息接收中断");
            offset+=read;count-=read;
        }
    }
    internal static byte[] EncodeFrame(string message) {
        int size=Utf8.GetByteCount(message);
        if(size==0||size>MaxFrameBytes)throw new ArgumentException("单条联机消息须为 1–65536 字节");
        byte[] frame=new byte[size+4];frame[0]=(byte)(size>>24);frame[1]=(byte)(size>>16);frame[2]=(byte)(size>>8);frame[3]=(byte)size;
        Utf8.GetBytes(message,0,message.Length,frame,4);return frame;
    }
    sealed class Peer {
        internal readonly string Id=Guid.NewGuid().ToString("N");
        internal readonly bool Accepted;
        readonly LanService owner;
        readonly TcpClient client;
        readonly NetworkStream stream;
        readonly BlockingCollection<byte[]> outgoing=new BlockingCollection<byte[]>(64);
        readonly object sendLock=new object();
        int closed,queuedBytes;
        internal Peer(LanService service,TcpClient socket,bool accepted) {
            owner=service;client=socket;Accepted=accepted;
            client.NoDelay=true;client.SendTimeout=5000;stream=client.GetStream();stream.WriteTimeout=5000;
        }
        internal void Start() { Task.Run((Action)ReadLoop);Task.Run((Action)WriteLoop); }
        internal void Send(string message) {
            byte[] frame=EncodeFrame(message);bool accepted=false;
            lock(sendLock) {
                if(closed!=0)throw new IOException("连接已断开");
                if(queuedBytes+frame.Length<=1048576) {
                    queuedBytes+=frame.Length;
                    try { accepted=outgoing.TryAdd(frame); } catch(InvalidOperationException) { }
                    if(!accepted)queuedBytes-=frame.Length;
                }
            }
            if(!accepted) { Close("发送队列已满，请重新连接");throw new IOException("发送队列已满"); }
        }
        void ReadLoop() {
            try {
                while(closed==0) {
                    string message=ReadFrame(stream);if(message==null)break;
                    owner.Emit("message","connectionId",Id,"message",message);
                }
                Close(null);
            } catch(Exception error) { Close(error is DecoderFallbackException?"收到无效的 UTF-8 消息":"连接中断或消息接收超时"); }
        }
        void WriteLoop() {
            try {
                foreach(var frame in outgoing.GetConsumingEnumerable()) {
                    lock(sendLock)queuedBytes-=frame.Length;
                    if(closed!=0)break;
                    stream.Write(frame,0,frame.Length);
                }
            } catch { Close("消息发送失败或超时"); }
        }
        internal void Close(string error) {
            if(Interlocked.Exchange(ref closed,1)!=0)return;
            lock(sendLock)outgoing.CompleteAdding();
            client.Close();owner.RemovePeer(this,error);
        }
    }
}
