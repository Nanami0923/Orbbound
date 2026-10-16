using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Text;
using System.Web.Script.Serialization;

// Device QA only. Compiled outside the app; uses the production Windows service.
internal static class LanDeviceHarness {
    static readonly JavaScriptSerializer Json = new JavaScriptSerializer();
    static readonly BlockingCollection<Dictionary<string,object>> Events = new BlockingCollection<Dictionary<string,object>>(512);
    static Dictionary<string,object> Map(params object[] fields) { var value=new Dictionary<string,object>();for(int i=0;i<fields.Length;i+=2)value.Add((string)fields[i],fields[i+1]);return value; }
    static object Call(LanService service,string action,Dictionary<string,object> payload=null) { return service.Handle(action,payload??Map()).GetAwaiter().GetResult(); }
    static Dictionary<string,object> Next(string type,int timeout=20000) {
        var timer=System.Diagnostics.Stopwatch.StartNew();Dictionary<string,object> value;
        while(timer.ElapsedMilliseconds<timeout) {
            if(!Events.TryTake(out value,Math.Max(1,timeout-(int)timer.ElapsedMilliseconds)))break;
            if(Equals(value["event"],type))return value;
            if(Equals(value["event"],"discovery-status"))Console.WriteLine("SCAN "+Json.Serialize(value));
            if(Equals(value["event"],"error"))throw new Exception(Json.Serialize(value));
        }
        throw new Exception("Timeout waiting for "+type);
    }
    static string[] Payloads() { return new[]{"设备互通✓🎮",new string('a',65536),"{\"v\":3,\"mode\":\"battle\",\"eventSeq\":7}"}; }
    static int Main(string[] args) {
        Console.OutputEncoding=new UTF8Encoding(false);
        try {
            using(var service=new LanService(evt=>Events.TryAdd(evt))) {
                if(args.Length==0||args[0]=="host") {
                    var info=Call(service,"startHost",Map("name","设备网络验证","port",42179,"metadata",Map("roomId","device-test-windows","protocolVersion",3,"rulesHash","device-check","mode","battle","platform","Windows","players",1,"phase","lobby")));
                    Console.WriteLine("READY "+Json.Serialize(info));Console.Out.Flush();
                    string connection=(string)Next("connected",120000)["connectionId"];
                    while(true) {
                        var evt=Next("message",30000);string message=(string)evt["message"];
                        Call(service,"send",Map("connectionId",connection,"message",message));
                        if(message=="__DONE__")break;
                    }
                    Next("disconnected");
                } else {
                    Dictionary<string,object> room=null;
                    for(int round=0;round<10;round++) {
                        string scan="device-win-"+round;
                        Call(service,"discover",args.Length>1?Map("scanId",scan,"recentAddresses",new[]{args[1]}):Map("scanId",scan));
                        var timer=System.Diagnostics.Stopwatch.StartNew();
                        do {
                            var evt=Next("discovered",9000);
                            room=(Dictionary<string,object>)evt["room"];
                            var metadata=(Dictionary<string,object>)room["metadata"];
                            if(Equals(metadata["roomId"],"device-test-android"))break;
                            room=null;
                        } while(timer.ElapsedMilliseconds<9000);
                        if(room==null)throw new Exception("Android room not found");
                        Call(service,"stopDiscovery");Console.WriteLine("FOUND round="+(round+1));
                    }
                    var info=(Dictionary<string,object>)Call(service,"connect",Map("address",room["address"],"port",room["port"]));
                    string connection=(string)info["connectionId"];Next("connected");
                    foreach(string payload in Payloads()) {
                        Call(service,"send",Map("connectionId",connection,"message",payload));
                        if(!payload.Equals(Next("message")["message"]))throw new Exception("Payload mismatch");
                    }
                    Call(service,"send",Map("connectionId",connection,"message","__DONE__"));
                    if(!Equals(Next("message")["message"],"__DONE__"))throw new Exception("Completion mismatch");
                    Call(service,"disconnect",Map("connectionId",connection));
                }
            }
            Console.WriteLine("PASS device Windows "+(args.Length==0?"host":args[0]));return 0;
        } catch(Exception error) { Console.Error.WriteLine(error);return 1; }
    }
}
