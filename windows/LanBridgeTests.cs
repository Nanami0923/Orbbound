using System;

internal static class LanBridgeTests {
    static int Main() {
        string[] trusted={"https://orbbound.local/index.html","https://orbbound.local:443/index.html#lan","https://ORBBOUND.LOCAL/index.html"};
        string[] blocked={"https://orbbound.local.evil.test/index.html","https://evil.test/orbbound.local/","https://attacker@orbbound.local/index.html","http://orbbound.local/index.html","https://orbbound.local:8443/index.html","file:///index.html","javascript:alert(1)","orbbound.local/index.html",null};
        foreach(string value in trusted)if(!GameWindow.TrustedSource(value))throw new Exception("Rejected trusted origin: "+value);
        foreach(string value in blocked)if(GameWindow.TrustedSource(value))throw new Exception("Accepted untrusted origin: "+value);
        Console.WriteLine("12 native LAN bridge origin checks passed");return 0;
    }
}
