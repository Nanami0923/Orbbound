using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Diagnostics;
using System.Net;
using System.Net.Sockets;
using System.Text;
using System.Web.Script.Serialization;

// Four independent desktop processes; production Windows LAN service, not device/network QA.
internal static class LanFourPeerHarness {
    const int Initial=44, Continued=22;
    static Dictionary<string,object> Map(params object[] fields) { var result=new Dictionary<string,object>(); for(int i=0;i<fields.Length;i+=2)result.Add((string)fields[i],fields[i+1]);return result; }
    static object Call(LanService service,string action,Dictionary<string,object> data=null) { return service.Handle(action,data??Map()).GetAwaiter().GetResult(); }
    static void Require(bool condition,string message) { if(!condition)throw new Exception(message); }
    sealed class Events {
        readonly BlockingCollection<Dictionary<string,object>> queue=new BlockingCollection<Dictionary<string,object>>(2048);
        internal void Add(Dictionary<string,object> evt) { if(!queue.TryAdd(evt))throw new Exception("Event overflow"); }
        internal Dictionary<string,object> Next() {
            var clock=Stopwatch.StartNew();
            while(clock.ElapsedMilliseconds<10000) {
                Dictionary<string,object> evt;
                if(!queue.TryTake(out evt,Math.Max(1,10000-(int)clock.ElapsedMilliseconds)))break;
                if(Equals(evt["event"],"advertisement-status"))continue;
                if(Equals(evt["event"],"error"))throw new Exception("Native error "+evt["error"]);
                return evt;
            }
            throw new Exception("TCP event timeout");
        }
        internal Dictionary<string,object> Next(string type) { var evt=Next();Require(Equals(evt["event"],type),"Expected "+type+", got "+evt["event"]);return evt; }
    }
    sealed class Stats {
        internal int Sent,Received,ControlsSent,ControlsReceived; internal long BytesSent,BytesReceived;
        internal void OnSent(string value,bool control) { if(control)ControlsSent++;else { Sent++;BytesSent+=Encoding.UTF8.GetByteCount(value); } }
        internal void OnReceived(string value,bool control) { if(control)ControlsReceived++;else { Received++;BytesReceived+=Encoding.UTF8.GetByteCount(value); } }
        internal string Json(string role) { return new JavaScriptSerializer().Serialize(Map("runtime","CSharp","role",role,"dataSent",Sent,"dataReceived",Received,"controlsSent",ControlsSent,"controlsReceived",ControlsReceived,"bytesSent",BytesSent,"bytesReceived",BytesReceived)); }
    }
    static string Payload(string direction,int seat,string phase,int sequence) {
        string prefix=direction+"|"+seat+"|"+phase+"|"+sequence+"|";
        if((phase=="A"&&sequence==2)||(phase=="B"&&sequence==1))return prefix+new string('a',65536-Encoding.UTF8.GetByteCount(prefix));
        if(phase=="A"&&sequence==3)return prefix+new string('球',20000);
        return prefix+(sequence==0?"中文身份":sequence==1?"你好🌈🎮":"顺序球🙂");
    }
    static void Send(LanService service,Stats stats,string connection,string message,bool control) { Call(service,"send",Map("connectionId",connection,"message",message));stats.OnSent(message,control); }
    static void Phase(LanService service,Stats stats,string connection,int seat,string phase,string direction,int count) { for(int index=0;index<count;index++)Send(service,stats,connection,Payload(direction,seat,phase,index),false); }
    static void Receive(Events events,Stats stats,string connection,int seat,string phase,int count) {
        for(int index=0;index<count;index++) { var evt=events.Next("message");string message=(string)evt["message"];
            Require(Equals(evt["connectionId"],connection)&&message==Payload("H",seat,phase,index),"Guest identity/order/content mismatch at "+seat+"/"+phase+"/"+index);stats.OnReceived(message,false); }
    }
    static void Control(Events events,Stats stats,string connection,string expected) { var evt=events.Next("message");Require(Equals(evt["connectionId"],connection)&&Equals(evt["message"],expected),"Expected control "+expected);stats.OnReceived((string)evt["message"],true); }
    static int FreePort() { var listener=new TcpListener(IPAddress.Loopback,0);listener.Start();int port=((IPEndPoint)listener.LocalEndpoint).Port;listener.Stop();return port; }
    static void Host(LanService service,Events events,Stats stats) {
        var info=(Dictionary<string,object>)Call(service,"startHost",Map("name","四端回环验证","port",FreePort(),"metadata",Map("roomId","four-peer-test","protocolVersion",3,"rulesHash","interop-v3","players",1,"capacity",4)));
        Console.WriteLine("READY "+info["port"]);Console.Out.Flush();
        var connected=new HashSet<string>();var disconnected=new HashSet<string>();var seats=new Dictionary<string,int>();var connections=new string[3];
        var initial=new int[3];var continued=new int[3];var ready=new HashSet<int>();var finalReady=new HashSet<int>();
        bool started=false,dropRequested=false,continuedStarted=false,finishRequested=false;
        while(disconnected.Count<3) {
            var evt=events.Next();string type=(string)evt["event"],connection=(string)evt["connectionId"];
            if(type=="connected")Require(connected.Add(connection)&&connected.Count<=3,"Duplicate/excess connection");
            else if(type=="message") {
                string message=(string)evt["message"];Require(connected.Contains(connection),"Message before connection or after disconnect");
                if(message.StartsWith("HELLO|")) {
                    int seat=Int32.Parse(message.Substring(6));Require(!seats.ContainsKey(connection)&&seat>=0&&seat<3&&connections[seat]==null,"Identity collision");
                    seats.Add(connection,seat);connections[seat]=connection;stats.OnReceived(message,true);
                    if(seats.Count==3) { Require(connected.Count==3,"Three peers were not simultaneous");started=true;
                        for(int i=0;i<3;i++) { Send(service,stats,connections[i],"START|"+i,true);Phase(service,stats,connections[i],i,"A","H",Initial); }
                        Console.WriteLine("CHECK CSharp host concurrentPeers=3 distinctConnectionIds=3"); }
                    continue;
                }
                int peer;Require(seats.TryGetValue(connection,out peer)&&started,"Unauthenticated payload");
                if(message.StartsWith("READY_EXIT|")) {
                    Require(message=="READY_EXIT|"+peer&&initial[peer]==Initial&&ready.Add(peer),"Invalid initial completion");stats.OnReceived(message,true);
                    if(ready.Count==3) { dropRequested=true;Send(service,stats,connections[0],"EXIT|0",true); }
                } else if(message.StartsWith("FINAL_READY|")) {
                    Require(message=="FINAL_READY|"+peer&&peer!=0&&continued[peer]==Continued&&finalReady.Add(peer),"Invalid continued completion");stats.OnReceived(message,true);
                    if(finalReady.Count==2) { finishRequested=true;for(int i=1;i<3;i++)Send(service,stats,connections[i],"EXIT|"+i,true); }
                } else {
                    string phase=continuedStarted?"B":"A";int[] counters=continuedStarted?continued:initial;int count=continuedStarted?Continued:Initial;
                    Require(!continuedStarted||peer!=0,"Disconnected peer sent continued traffic");
                    Require(counters[peer]<count&&message==Payload("C",peer,phase,counters[peer]),"Host identity/order/content mismatch at "+peer+"/"+phase+"/"+counters[peer]);
                    counters[peer]++;stats.OnReceived(message,false);if(counters[peer]==count)Send(service,stats,connection,phase+"_DONE|"+peer,true);
                }
            } else if(type=="disconnected") {
                int seat;Require(seats.TryGetValue(connection,out seat)&&connected.Remove(connection)&&disconnected.Add(connection),"Unknown duplicate disconnect");
                if(seat==0) { Require(dropRequested&&!continuedStarted&&connected.Count==2,"First disconnect affected other peers");continuedStarted=true;
                    for(int i=1;i<3;i++) { Send(service,stats,connections[i],"CONTINUE|"+i,true);Phase(service,stats,connections[i],i,"B","H",Continued); }
                    Console.WriteLine("CHECK CSharp host disconnectedSeat=0 remainingPeers=2 continuedBidirectional=true");
                } else Require(finishRequested,"Remaining peer disconnected before continued transfer completed");
            } else throw new Exception("Unexpected native event "+type);
        }
        Require(connected.Count==0,"Connection leak");Require(stats.Sent==176&&stats.Received==176&&stats.ControlsSent==13&&stats.ControlsReceived==8,"Host totals mismatch");
    }
    static void Guest(LanService service,Events events,Stats stats,int port,int seat) {
        var info=(Dictionary<string,object>)Call(service,"connect",Map("address","127.0.0.1","port",port));string connection=(string)info["connectionId"];
        Require(Equals(events.Next("connected")["connectionId"],connection),"Guest connection identity mismatch");
        Send(service,stats,connection,"HELLO|"+seat,true);Control(events,stats,connection,"START|"+seat);
        Phase(service,stats,connection,seat,"A","C",Initial);Receive(events,stats,connection,seat,"A",Initial);
        Control(events,stats,connection,"A_DONE|"+seat);Send(service,stats,connection,"READY_EXIT|"+seat,true);
        if(seat!=0) { Control(events,stats,connection,"CONTINUE|"+seat);Phase(service,stats,connection,seat,"B","C",Continued);Receive(events,stats,connection,seat,"B",Continued);
            Control(events,stats,connection,"B_DONE|"+seat);Send(service,stats,connection,"FINAL_READY|"+seat,true); }
        Control(events,stats,connection,"EXIT|"+seat);Call(service,"disconnect",Map("connectionId",connection));Require(Equals(events.Next("disconnected")["connectionId"],connection),"Guest disconnect identity");
    }
    static int Main(string[] args) {
        Console.OutputEncoding=new UTF8Encoding(false);
        try { var events=new Events();var stats=new Stats();using(var service=new LanService(events.Add)) {
            if(args[0]=="host")Host(service,events,stats);else Guest(service,events,stats,Int32.Parse(args[1]),Int32.Parse(args[2])); }
            Console.WriteLine("RESULT "+stats.Json(args[0]));Console.WriteLine("PASS CSharp "+args[0]+" desktop-loopback-only");return 0;
        } catch(Exception error) { Console.Error.WriteLine(error);return 1; }
    }
}
