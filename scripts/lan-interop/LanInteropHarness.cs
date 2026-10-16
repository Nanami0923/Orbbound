using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Diagnostics;
using System.Net;
using System.Net.Sockets;
using System.Text;

internal static class LanInteropHarness {
    static Dictionary<string,object> Map(params object[] fields) {
        var result=new Dictionary<string,object>();
        for(int i=0;i<fields.Length;i+=2)result.Add((string)fields[i],fields[i+1]);
        return result;
    }
    static object Call(LanService service,string action,Dictionary<string,object> payload=null) {
        return service.Handle(action,payload??Map()).GetAwaiter().GetResult();
    }
    sealed class Events {
        readonly BlockingCollection<Dictionary<string,object>> queue=new BlockingCollection<Dictionary<string,object>>(128);
        internal void Add(Dictionary<string,object> evt) { if(!queue.TryAdd(evt))throw new Exception("Event overflow"); }
        internal Dictionary<string,object> Next(string kind) {
            var timeout=Stopwatch.StartNew();
            while(timeout.ElapsedMilliseconds<10000) {
                Dictionary<string,object> evt;
                if(!queue.TryTake(out evt,(int)(10000-timeout.ElapsedMilliseconds)))break;
                // Discovery health notifications are independent of the TCP stream under test.
                if("advertisement-status".Equals(evt["event"]))continue;
                if(!kind.Equals(evt["event"]))throw new Exception("Expected "+kind+", received "+evt["event"]);
                return evt;
            }
            throw new Exception("Timed out waiting for "+kind);
        }
    }
    static List<string> Messages() {
        var result=new List<string> {
            "{\"name\":\"球\"}", "{\"text\":\"你好 🌈🎮\"}",
            "{\"data\":\""+new string('a',65525)+"\"}", "{\"data\":\""+new string('球',20000)+"\"}"
        };
        for(int i=0;i<40;i++)result.Add("{\"seq\":"+i+"}");
        return result;
    }
    static int FreePort() {
        var listener=new TcpListener(IPAddress.Loopback,0);listener.Start();
        int port=((IPEndPoint)listener.LocalEndpoint).Port;listener.Stop();return port;
    }
    static int Main(string[] args) {
        Console.OutputEncoding=new UTF8Encoding(false);
        try {
            var events=new Events();var messages=Messages();int bytes=0;
            foreach(string message in messages)bytes+=Encoding.UTF8.GetByteCount(message);
            using(var service=new LanService(events.Add)) {
                if(args[0]=="host") {
                    var info=(Dictionary<string,object>)Call(service,"startHost",Map("name","互通测试","port",FreePort(),
                        "metadata",Map("roomId","interop-test","protocolVersion",3,"rulesHash","interop-v3")));
                    Console.WriteLine("READY "+info["port"]);Console.Out.Flush();
                    string id=(string)events.Next("connected")["connectionId"];
                    foreach(string expected in messages) {
                        var received=events.Next("message");
                        if(!expected.Equals(received["message"]))throw new Exception("Host payload/order mismatch");
                        Call(service,"send",Map("connectionId",id,"message",received["message"]));
                    }
                    events.Next("disconnected");
                } else {
                    var info=(Dictionary<string,object>)Call(service,"connect",Map("address","127.0.0.1","port",Int32.Parse(args[1])));
                    string id=(string)info["connectionId"];
                    if(!id.Equals(events.Next("connected")["connectionId"]))throw new Exception("Connection identity mismatch");
                    foreach(string message in messages)Call(service,"send",Map("connectionId",id,"message",message));
                    foreach(string expected in messages) {
                        if(!expected.Equals(events.Next("message")["message"]))throw new Exception("Guest payload/order mismatch");
                    }
                    Call(service,"disconnect",Map("connectionId",id));events.Next("disconnected");
                }
            }
            Console.WriteLine("PASS CSharp "+args[0]+" frames="+messages.Count+" bytesEachDirection="+bytes+" maxFrame=65536");return 0;
        } catch(Exception error) { Console.Error.WriteLine(error);return 1; }
    }
}
