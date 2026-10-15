using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Net;
using System.Net.Sockets;
using System.Text;
using System.Threading;
using System.Threading.Tasks;

internal static class LanServiceTests {
    static int checks;
    static void Assert(bool value,string name) { if(!value)throw new Exception(name);checks++; }
    static Dictionary<string,object> Map(params object[] values) {
        var result=new Dictionary<string,object>();for(int i=0;i<values.Length;i+=2)result[(string)values[i]]=values[i+1];return result;
    }
    sealed class Events {
        readonly List<Dictionary<string,object>> items=new List<Dictionary<string,object>>();
        internal void Add(Dictionary<string,object> item) { lock(items)items.Add(item); }
        internal Dictionary<string,object> Wait(string kind,string text=null,int timeout=7000) {
            var end=DateTime.UtcNow.AddMilliseconds(timeout);
            while(DateTime.UtcNow<end) {
                lock(items) {
                    var found=items.FirstOrDefault(e=>Equals(e["event"],kind)&&(text==null||e.ContainsKey("message")&&Equals(e["message"],text)));
                    if(found!=null) { items.Remove(found);return found; }
                }
                Thread.Sleep(10);
            }
            throw new Exception("Timed out waiting for "+kind+" "+text);
        }
        internal int Count { get { lock(items)return items.Count; } }
        internal Dictionary<string,object>[] Snapshot() { lock(items)return items.ToArray(); }
        internal Dictionary<string,object> Status(string scanId,string status,int timeout=10000) {
            var end=DateTime.UtcNow.AddMilliseconds(timeout);
            while(DateTime.UtcNow<end) {
                lock(items) {
                    var found=items.FirstOrDefault(e=>Equals(e["event"],"discovery-status")&&Equals(e["scanId"],scanId)&&Equals(e["status"],status));
                    if(found!=null)return found;
                }
                Thread.Sleep(10);
            }
            throw new Exception("Timed out waiting for discovery "+scanId+" "+status);
        }
    }
    sealed class Pair : IDisposable {
        internal readonly TcpClient Writer,Reader;
        readonly TcpListener server;
        internal Pair() {
            server=new TcpListener(IPAddress.Loopback,0);server.Start();
            Writer=new TcpClient();Writer.Connect(IPAddress.Loopback,((IPEndPoint)server.LocalEndpoint).Port);
            Reader=server.AcceptTcpClient();server.Stop();
        }
        public void Dispose() { Writer.Close();Reader.Close();server.Stop(); }
    }
    static object Call(LanService service,string action,Dictionary<string,object> payload=null) { return service.Handle(action,payload).GetAwaiter().GetResult(); }
    static void RejectFrame(byte[] bytes,string label,bool partial=false) {
        using(var pair=new Pair()) {
            var writer=pair.Writer.GetStream();writer.Write(bytes,0,bytes.Length);if(partial)pair.Writer.Client.Shutdown(SocketShutdown.Send);
            bool rejected=false;try { LanService.ReadFrame(pair.Reader.GetStream()); } catch(IOException) { rejected=true; } catch(DecoderFallbackException) { rejected=true; }
            Assert(rejected,label);
        }
    }
    static void FrameTests() {
        string text="{\"text\":\"你好，世界 🎮\"}";byte[] frame=LanService.EncodeFrame(text);
        Assert(frame.Length==Encoding.UTF8.GetByteCount(text)+4,"Frame length counts UTF-8 bytes");
        using(var pair=new Pair()) {
            Task writer=Task.Run(delegate {
                foreach(byte value in frame) { pair.Writer.GetStream().WriteByte(value);Thread.Sleep(1); }
                byte[] combined=frame.Concat(LanService.EncodeFrame("{}" )).ToArray();pair.Writer.GetStream().Write(combined,0,combined.Length);
                pair.Writer.Client.Shutdown(SocketShutdown.Send);
            });
            Assert(LanService.ReadFrame(pair.Reader.GetStream())==text,"Split header/body and multibyte UTF-8");
            Assert(LanService.ReadFrame(pair.Reader.GetStream())==text,"First coalesced frame");
            Assert(LanService.ReadFrame(pair.Reader.GetStream())=="{}","Second coalesced frame");
            Assert(LanService.ReadFrame(pair.Reader.GetStream())==null,"Clean EOF");writer.Wait();
        }
        RejectFrame(new byte[]{0,0,0,0},"Zero frame rejected");
        RejectFrame(new byte[]{0,1,0,1},"Oversize frame rejected before allocation");
        RejectFrame(new byte[]{255,255,255,255},"Unsigned length overflow rejected");
        RejectFrame(new byte[]{0,0,0,2,0xc3,0x28},"Invalid UTF-8 rejected");
        RejectFrame(new byte[]{0,0},"Partial header EOF rejected",true);
        RejectFrame(new byte[]{0,0,0,3,0x41},"Partial body EOF rejected",true);
        using(var pair=new Pair()) {
            pair.Writer.GetStream().WriteByte(0);var start=DateTime.UtcNow;bool rejected=false;
            try { LanService.ReadFrame(pair.Reader.GetStream()); } catch(IOException) { rejected=true; }
            Assert(rejected&&(DateTime.UtcNow-start).TotalSeconds<8,"Partial frame deadline closes stalled sender");
        }
        Assert(LanService.EncodeFrame(new string('a',65536)).Length==65540,"64 KiB frame accepted");
        bool invalid=false;try { LanService.EncodeFrame(new string('a',65537)); } catch(ArgumentException) { invalid=true; }
        Assert(invalid,"Oversize outgoing message rejected");
        invalid=false;try { LanService.EncodeFrame(""); } catch(ArgumentException) { invalid=true; }
        Assert(invalid,"Empty outgoing message rejected");
    }
    static Dictionary<string,object> HostPayload(string name) { return Map("name",name,"metadata",Map("roomId","room-test","protocolVersion",1,"rulesHash","test-hash")); }
    static void DatagramResetTests() {
        using(var listener=new UdpClient(new IPEndPoint(IPAddress.Loopback,0))) {
            LanService.ConfigureDatagramSocket(listener.Client);
            var destination=(IPEndPoint)listener.Client.LocalEndPoint;
            byte[] query=Encoding.UTF8.GetBytes("query");IPEndPoint remote=new IPEndPoint(IPAddress.Any,0);
            using(var departed=new UdpClient(new IPEndPoint(IPAddress.Loopback,0))) {
                departed.Send(query,query.Length,destination);listener.Receive(ref remote);
            }
            // The sender is already closed, so this response deterministically elicits ICMP.
            listener.Send(query,query.Length,remote);listener.Client.ReceiveTimeout=300;
            SocketError error=SocketError.Success;
            try { listener.Receive(ref remote); } catch(SocketException exception) { error=exception.SocketErrorCode; }
            Assert(error==SocketError.TimedOut,"UDP ignores ICMP Port Unreachable from a departed scanner");
            using(var next=new UdpClient(new IPEndPoint(IPAddress.Loopback,0))) {
                next.Send(query,query.Length,destination);
                Assert(Encoding.UTF8.GetString(listener.Receive(ref remote))=="query","UDP discovery socket remains available after departed scanner");
            }
        }
    }
    static void SocketTests() {
        var hostEvents=new Events();var guestEvents=new Events();var secondEvents=new Events();
        using(var host=new LanService(hostEvents.Add))
        using(var guest=new LanService(guestEvents.Add))
        using(var second=new LanService(secondEvents.Add)) {
            var info=(Dictionary<string,object>)Call(host,"startHost",HostPayload("原生测试 🎮"));
            int port=(int)info["port"];
            Assert(port>0,"TCP host starts");Assert(((string[])info["addresses"]).Length>0,"Host reports local addresses");
            Assert((bool)info["discoveryAvailable"],"UDP discovery binds");
            var secondInfo=(Dictionary<string,object>)Call(second,"startHost",HostPayload("第二个房间"));
            Assert((int)secondInfo["port"]!=port,"Conflicting TCP port gets dynamic fallback");
            Assert(!(bool)secondInfo["discoveryAvailable"],"Conflicting UDP port degrades to manual connection");
            Call(second,"stopHost");
            Call(guest,"discover");
            var discovered=guestEvents.Wait("discovered");var room=(Dictionary<string,object>)discovered["room"];
            Assert((string)room["name"]=="原生测试 🎮"&&(int)room["port"]==port,"UDP round-trip discovers name/port");
            Assert(((Dictionary<string,object>)room["metadata"])["roomId"].Equals("room-test"),"UDP metadata round-trip");
            IPAddress source;Assert(IPAddress.TryParse((string)room["address"],out source),"Discovery address comes from UDP source");
            Call(guest,"stopDiscovery");
            var connection=(Dictionary<string,object>)Call(guest,"connect",Map("address","127.0.0.1","port",port));
            string guestId=(string)connection["connectionId"],hostId=(string)hostEvents.Wait("connected")["connectionId"];
            Assert(guestEvents.Wait("connected")["connectionId"].Equals(guestId),"Outgoing response/event connection identity");
            string text="{\"kind\":\"测试\",\"emoji\":\"🎮\"}";
            Call(guest,"send",Map("connectionId",guestId,"message",text));
            Assert(hostEvents.Wait("message",text)["connectionId"].Equals(hostId),"Guest-to-host message delivery");
            Call(host,"send",Map("connectionId",hostId,"message","{\"reply\":true}"));
            Assert(guestEvents.Wait("message","{\"reply\":true}")["connectionId"].Equals(guestId),"Host-to-guest message delivery");
            for(int i=0;i<40;i++)Call(guest,"send",Map("connectionId",guestId,"message","{\"seq\":"+i+"}"));
            for(int i=0;i<40;i++)Assert(hostEvents.Wait("message")["message"].Equals("{\"seq\":"+i+"}"),"Serialized write ordering "+i);
            Call(guest,"disconnect",Map("connectionId",guestId));
            Assert(guestEvents.Wait("disconnected")["connectionId"].Equals(guestId),"Local disconnect event");
            Assert(hostEvents.Wait("disconnected")["connectionId"].Equals(hostId),"Remote EOF disconnect event");
            Call(guest,"disconnect",Map("connectionId",guestId));
            Call(guest,"connect",Map("address","127.0.0.1","port",port));hostEvents.Wait("connected");guestEvents.Wait("connected");
            Call(host,"stopHost");hostEvents.Wait("disconnected");guestEvents.Wait("disconnected");
            using(var udp=new UdpClient(AddressFamily.InterNetwork)) { udp.ExclusiveAddressUse=true;udp.Client.Bind(new IPEndPoint(IPAddress.Any,LanService.DiscoveryPort));Assert(true,"Stopping host releases UDP port"); }
            bool refused=false;try { Call(guest,"connect",Map("address","127.0.0.1","port",port)); } catch(SocketException) { refused=true; }
            Assert(refused,"Stopping host releases listener and refuses connections");
            Call(host,"startHost",HostPayload("重建房间"));
            Call(host,"dispose");bool closed=false;try { Call(host,"discover"); } catch(ObjectDisposedException) { closed=true; }
            Assert(closed,"Disposed service rejects new operations");
            Assert(!hostEvents.Snapshot().Any(e=>!Equals(e["event"],"advertisement-status")),"Dispose suppresses stale callbacks");
        }
    }
    static LanService.LanPath[] LoopbackPaths() {
        return new[]{new LanService.LanPath("loopback-one",IPAddress.Parse("127.0.0.1"),IPAddress.Parse("255.0.0.0")),
            new LanService.LanPath("loopback-two",IPAddress.Parse("127.0.0.2"),IPAddress.Parse("255.0.0.0"))};
    }
    static void DiscoveryTests() {
        var local=new LanService.LanPath("ethernet",IPAddress.Parse("192.168.7.12"),IPAddress.Parse("255.255.255.0"));
        var targets=LanService.Targets(local,new[]{"192.168.7.20","192.168.8.20","203.0.113.1","192.168.7.21","192.168.7.22","192.168.7.23","192.168.7.24","192.168.7.25","192.168.7.26"}).Select(ip=>ip.ToString()).ToArray();
        Assert(targets.Contains("192.168.7.255")&&targets.Contains("255.255.255.255"),"Discovery sends actual subnet and limited broadcasts");
        Assert(targets.Contains("192.168.7.20")&&!targets.Contains("192.168.8.20")&&!targets.Contains("203.0.113.1"),"Recent UDP probes remain in the bound subnet");
        Assert(!targets.Contains("192.168.7.26"),"Recent addresses are bounded to eight");
        Assert(new LanService.LanPath("point-to-point",IPAddress.Parse("192.168.7.12"),IPAddress.Parse("255.255.255.254")).Broadcast()==null,"A /31 network has no invented directed broadcast");
        var none=new Events();using(var noNetwork=new LanService(none.Add,delegate { return new LanService.LanPath[0]; })) {
            Call(noNetwork,"discover",Map("scanId","no-network"));var status=none.Status("no-network","failed");
            Assert(Equals(status["error"],"NO_LOCAL_NETWORK")&&(int)status["paths"]==0,"No LAN paths fail immediately with a useful reason");
        }
        var hostEvents=new Events();var scannerEvents=new Events();
        var sent=new List<Tuple<string,string,long>>();var clock=System.Diagnostics.Stopwatch.StartNew();
        Action<UdpClient,byte[],IPEndPoint> failingBroadcast=delegate(UdpClient socket,byte[] bytes,IPEndPoint endpoint) {
            string source=((IPEndPoint)socket.Client.LocalEndPoint).Address.ToString();
            lock(sent)sent.Add(Tuple.Create(source,endpoint.Address.ToString(),clock.ElapsedMilliseconds));
            if(endpoint.Address.Equals(IPAddress.Broadcast)||endpoint.Address.Equals(IPAddress.Parse("127.255.255.255")))throw new SocketException((int)SocketError.NetworkUnreachable);
            socket.Send(bytes,bytes.Length,endpoint);
        };
        using(var host=new LanService(hostEvents.Add))
        using(var scanner=new LanService(scannerEvents.Add,LoopbackPaths,failingBroadcast)) {
            var hostPayload=HostPayload("更新前");((Dictionary<string,object>)hostPayload["metadata"])["protocolVersion"]=2;
            var info=(Dictionary<string,object>)Call(host,"startHost",hostPayload);int port=(int)info["port"];
            Call(scanner,"discover",Map("scanId","bounded-scan","recentAddresses",new[]{"127.0.0.1:61234","192.0.2.10"}));
            var found=scannerEvents.Wait("discovered");
            Assert(Equals(found["scanId"],"bounded-scan"),"Discovery result carries the UI scan generation");
            Assert(Equals(((Dictionary<string,object>)found["room"])["port"],port),"Discovery uses advertised TCP port, never recent history's port");
            Assert(Equals(((Dictionary<string,object>)((Dictionary<string,object>)found["room"])["metadata"])["protocolVersion"],2),"Native advertising passes protocol v2 through for shared-session compatibility checks");
            var metadata=Map("roomId","room-test","protocolVersion",2,"rulesHash","updated-hash","platform","windows","mode","battle","players",2,"joinable",false);
            Call(host,"updateAdvertisement",Map("name","更新后","metadata",metadata));
            Dictionary<string,object> updated=null;var limit=DateTime.UtcNow.AddSeconds(4);
            while(DateTime.UtcNow<limit&&updated==null) {
                var evt=scannerEvents.Wait("discovered");var room=(Dictionary<string,object>)evt["room"];
                if(Equals(room["name"],"更新后"))updated=room;
            }
            Assert(updated!=null&&Equals(updated["port"],port),"Advertisement updates without changing TCP port");
            var advertised=(Dictionary<string,object>)updated["metadata"];
            Assert(Equals(advertised["mode"],"battle")&&Equals(advertised["players"],2)&&Equals(advertised["joinable"],false),"Dynamic advertisement metadata is retained in replies");
            using(var socket=new TcpClient()) { socket.Connect(IPAddress.Loopback,port);Assert(socket.Connected,"Metadata update leaves TCP listener available"); }
            Call(scanner,"stopDiscovery",Map("scanId","an-older-scan"));
            var completed=scannerEvents.Status("bounded-scan","completed");
            Assert((int)completed["paths"]==2,"Each local IPv4 has an independently bound scan socket");
            Assert((int)completed["sent"]==8&&(int)completed["errors"]==16,"Each target failure is isolated; four scheduled bursts still send on both paths");
            Assert((int)completed["received"]>=2,"Receive counters report responses despite broadcast failures");
            Assert(((string[])completed["diagnostics"]).Length<=200,"Diagnostics remain bounded");
            Tuple<string,string,long>[] attempts;lock(sent)attempts=sent.ToArray();
            Assert(attempts.Any(x=>x.Item1=="127.0.0.1")&&attempts.Any(x=>x.Item1=="127.0.0.2"),"UDP source addresses match each configured interface");
            var bursts=attempts.Where(x=>x.Item1=="127.0.0.1"&&x.Item2=="127.0.0.1").Select(x=>x.Item3).ToArray();
            Assert(bursts.Length==4&&bursts[1]-bursts[0]>=800&&bursts[2]-bursts[0]>=2300&&bursts[3]-bursts[0]>=4800,"Queries follow the 0/1/2.5/5 second schedule");
            int afterComplete;lock(sent)afterComplete=sent.Count;Thread.Sleep(150);
            lock(sent)Assert(sent.Count==afterComplete,"Completed scan sends no residual queries");
            Call(scanner,"discover",Map("scanId","cancel-old","recentAddresses",new[]{"127.0.0.1"}));
            Call(scanner,"discover",Map("scanId","cancel-new","recentAddresses",new[]{"127.0.0.1"}));
            scannerEvents.Status("cancel-old","cancelled");scannerEvents.Status("cancel-new","scanning");
            Call(scanner,"stopDiscovery");scannerEvents.Status("cancel-new","cancelled");Thread.Sleep(100);
            var events=scannerEvents.Snapshot();
            foreach(string id in new[]{"cancel-old","cancel-new"}) {
                int end=Array.FindIndex(events,e=>Equals(e["event"],"discovery-status")&&Equals(e["scanId"],id)&&Equals(e["status"],"cancelled"));
                Assert(!events.Skip(end+1).Any(e=>e.ContainsKey("scanId")&&Equals(e["scanId"],id)),"No stale callbacks follow cancellation: "+id);
            }
        }
        var failureEvents=new Events();
        using(var failed=new LanService(failureEvents.Add,delegate { return new[]{new LanService.LanPath("absent",IPAddress.Parse("192.0.2.8"),IPAddress.Parse("255.255.255.0"))}; })) {
            Call(failed,"discover",Map("scanId","bind-failure"));
            Assert(Equals(failureEvents.Status("bind-failure","failed")["error"],"DISCOVERY_BIND_FAILED"),"All interface binding failures report their stage");
        }
    }
    static void AdvertisementRecoveryTests() {
        var events=new Events();
        using(var owner=new UdpClient(AddressFamily.InterNetwork))
        using(var host=new LanService(events.Add)) {
            owner.ExclusiveAddressUse=true;owner.Client.Bind(new IPEndPoint(IPAddress.Any,LanService.DiscoveryPort));
            var info=(Dictionary<string,object>)Call(host,"startHost",HostPayload("等待端口"));
            Assert(!(bool)info["discoveryAvailable"],"Occupied advertisement port preserves manual hosting");
            owner.Close();Thread.Sleep(650);
            Assert(events.Snapshot().Any(e=>Equals(e["event"],"advertisement-status")&&Equals(e["discoveryAvailable"],true)),"Host advertisement recovers after the occupied port is released");
            using(var probe=new UdpClient(new IPEndPoint(IPAddress.Loopback,0))) {
                probe.Client.ReceiveTimeout=2000;byte[] query=Encoding.UTF8.GetBytes("{\"magic\":\"ORBBOUND_LAN_1\",\"queryId\":\"probe\"}");
                probe.Send(query,query.Length,new IPEndPoint(IPAddress.Loopback,LanService.DiscoveryPort));var source=new IPEndPoint(IPAddress.Any,0);
                Assert(Encoding.UTF8.GetString(probe.Receive(ref source)).Contains("等待端口"),"Recovered advertiser answers a real UDP query");
            }
        }
    }
    static int Main() {
        try { FrameTests();DatagramResetTests();SocketTests();DiscoveryTests();AdvertisementRecoveryTests();Console.WriteLine(checks+" native LAN checks passed (real TCP/UDP loopback)");return 0; }
        catch(Exception error) { Console.Error.WriteLine(error);return 1; }
    }
}
