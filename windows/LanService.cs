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
    UdpClient advertiser, discovery;
    System.Threading.Timer discoveryTimer;
    int hostGeneration, discoveryGeneration;
    bool disposed;

    internal LanService(Action<Dictionary<string,object>> publishEvent) { publish=publishEvent; }
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
                case "discover":StartDiscovery();break;
                case "stopDiscovery":StopDiscovery();break;
                default:throw new ArgumentException("未知的联机操作");
            }
            return Map();
        } finally { actions.Release(); }
    }

    object StartHost(Dictionary<string,object> payload) {
        string name=StringField(payload,"name",96);
        object raw;var metadata=payload.TryGetValue("metadata",out raw)?raw as Dictionary<string,object>:null;
        if(metadata==null)throw new ArgumentException("缺少房间信息");
        string roomId=StringField(metadata,"roomId",128),rulesHash=StringField(metadata,"rulesHash",128);
        object protocol;if(!metadata.TryGetValue("protocolVersion",out protocol)||!(protocol is int)||(int)protocol!=1)throw new ArgumentException("不兼容的发现协议");
        var safeMetadata=Map("roomId",roomId,"protocolVersion",1,"rulesHash",rulesHash);
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
            listener=server;generation=++hostGeneration;
        }
        int actualPort=((IPEndPoint)server.LocalEndpoint).Port;
        Task.Run(delegate { AcceptLoop(server,generation); });
        bool available=false;
        try {
            var udp=new UdpClient(AddressFamily.InterNetwork);
            try { ConfigureDatagramSocket(udp.Client);udp.ExclusiveAddressUse=true;udp.Client.Bind(new IPEndPoint(IPAddress.Any,DiscoveryPort)); }
            catch { udp.Close();throw; }
            lock(sync) {
                if(disposed||generation!=hostGeneration) { udp.Close();throw new ObjectDisposedException("LAN"); }
                advertiser=udp;
            }
            Task.Run(delegate { AdvertiseLoop(udp,generation,name,actualPort,safeMetadata); });available=true;
        } catch(SocketException) { /* Discovery can be occupied; the TCP address remains usable. */ }
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
        TcpListener server;UdpClient udp;Peer[] accepted;
        lock(sync) {
            hostGeneration++;server=listener;listener=null;udp=advertiser;advertiser=null;
            accepted=peers.Values.Where(p=>p.Accepted).ToArray();
        }
        if(server!=null)server.Stop();if(udp!=null)udp.Close();
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
    void AdvertiseLoop(UdpClient udp,int generation,string name,int port,Dictionary<string,object> metadata) {
        var throttle=Stopwatch.StartNew();int inWindow=0;
        try {
            while(true) {
                var endpoint=new IPEndPoint(IPAddress.Any,0);byte[] bytes=udp.Receive(ref endpoint);
                lock(sync) { if(disposed||generation!=hostGeneration)return; }
                if(throttle.ElapsedMilliseconds>=1000) { throttle.Restart();inWindow=0; }
                if(++inWindow>30)continue;
                var query=ParseDiscovery(bytes);object magic,queryId;
                if(query==null||!query.TryGetValue("magic",out magic)||!(magic is string)||(string)magic!=Magic||!query.TryGetValue("queryId",out queryId)||!(queryId is string)||((string)queryId).Length>128)continue;
                byte[] reply=Utf8.GetBytes(Serializer().Serialize(Map("magic",Magic,"queryId",queryId,"name",name,"port",port,"metadata",metadata)));
                udp.Send(reply,reply.Length,endpoint);
            }
        } catch(SocketException) { }
        catch(ObjectDisposedException) { }
    }
    void StartDiscovery() {
        StopDiscovery();
        var udp=new UdpClient(AddressFamily.InterNetwork);
        try { ConfigureDatagramSocket(udp.Client);udp.Client.Bind(new IPEndPoint(IPAddress.Any,0));udp.EnableBroadcast=true; }
        catch { udp.Close();throw; }
        string queryId=Guid.NewGuid().ToString("N");
        byte[] request=Utf8.GetBytes(Serializer().Serialize(Map("magic",Magic,"queryId",queryId)));
        int generation;
        lock(sync) {
            if(disposed) { udp.Close();throw new ObjectDisposedException("LAN"); }
            discovery=udp;generation=++discoveryGeneration;
            discoveryTimer=new System.Threading.Timer(delegate { SendDiscovery(udp,generation,request); },null,0,2000);
        }
        Task.Run(delegate { DiscoveryLoop(udp,generation,queryId); });
    }
    void SendDiscovery(UdpClient udp,int generation,byte[] request) {
        lock(sync) { if(disposed||generation!=discoveryGeneration)return; }
        try {
            udp.Send(request,request.Length,new IPEndPoint(IPAddress.Broadcast,DiscoveryPort));
            // Directed subnet broadcasts cover multi-interface PCs; loopback supports local QA.
            var targets=new HashSet<string>();targets.Add("127.0.0.1");
            foreach(var nic in NetworkInterface.GetAllNetworkInterfaces()) {
                if(nic.OperationalStatus!=OperationalStatus.Up)continue;
                foreach(var entry in nic.GetIPProperties().UnicastAddresses) {
                    if(entry.Address.AddressFamily!=AddressFamily.InterNetwork||entry.IPv4Mask==null)continue;
                    byte[] ip=entry.Address.GetAddressBytes(),mask=entry.IPv4Mask.GetAddressBytes();
                    for(int i=0;i<4;i++)ip[i]=(byte)(ip[i]|(byte)~mask[i]);
                    targets.Add(new IPAddress(ip).ToString());
                }
            }
            foreach(string target in targets) {
                try { udp.Send(request,request.Length,new IPEndPoint(IPAddress.Parse(target),DiscoveryPort)); } catch(SocketException) { }
            }
        } catch(SocketException) { }
        catch(ObjectDisposedException) { }
        catch(NetworkInformationException) { }
    }
    void DiscoveryLoop(UdpClient udp,int generation,string queryId) {
        var announced=new Dictionary<string,long>();var timer=Stopwatch.StartNew();
        try {
            while(true) {
                var endpoint=new IPEndPoint(IPAddress.Any,0);var packet=ParseDiscovery(udp.Receive(ref endpoint));
                lock(sync) { if(disposed||generation!=discoveryGeneration)return; }
                if(packet==null)continue;
                object magic,id,rawName,rawPort,metadata;
                if(!packet.TryGetValue("magic",out magic)||!Equals(magic,Magic)||!packet.TryGetValue("queryId",out id)||!Equals(id,queryId)||!packet.TryGetValue("name",out rawName)||!(rawName is string)||((string)rawName).Length>96||((string)rawName).Any(Char.IsControl)||!packet.TryGetValue("port",out rawPort)||!(rawPort is int)||(int)rawPort<1||(int)rawPort>65535||!packet.TryGetValue("metadata",out metadata)||!(metadata is Dictionary<string,object>))continue;
                string key=endpoint.Address+":"+rawPort;long last;
                if(announced.TryGetValue(key,out last)&&timer.ElapsedMilliseconds-last<1500)continue;
                if(announced.Count>=128)announced.Clear();announced[key]=timer.ElapsedMilliseconds;
                Emit("discovered","room",Map("name",rawName,"address",endpoint.Address.ToString(),"port",rawPort,"metadata",metadata));
            }
        } catch(SocketException) { }
        catch(ObjectDisposedException) { }
    }
    void StopDiscovery() {
        UdpClient udp;System.Threading.Timer timer;
        lock(sync) { discoveryGeneration++;udp=discovery;discovery=null;timer=discoveryTimer;discoveryTimer=null; }
        if(timer!=null)timer.Dispose();if(udp!=null)udp.Close();
    }
    public void Dispose() {
        Peer[] connected;TcpClient[] pending;
        lock(sync) { if(disposed)return;disposed=true;connected=peers.Values.ToArray();pending=connecting.ToArray(); }
        foreach(var client in pending)client.Close();
        StopHost();StopDiscovery();foreach(var peer in connected)peer.Close(null);
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
