using System;
using System.IO;
using Microsoft.Web.WebView2.Core;

internal static class NativeShellTests {
    static void Assert(bool value,string name) { if(!value)throw new Exception(name); }
    [STAThread] static int Main() {
        Assert(NativeShellPolicy.Recovery(CoreWebView2ProcessFailedKind.GpuProcessExited)=="runtime","GPU self recovery");
        Assert(NativeShellPolicy.Recovery(CoreWebView2ProcessFailedKind.UtilityProcessExited)=="runtime","Utility self recovery");
        Assert(NativeShellPolicy.Recovery(CoreWebView2ProcessFailedKind.RenderProcessExited)=="reload","Renderer reload");
        Assert(NativeShellPolicy.Recovery(CoreWebView2ProcessFailedKind.BrowserProcessExited)=="recreate","Browser rebuild");
        Assert(NativeShellPolicy.Recovery(CoreWebView2ProcessFailedKind.RenderProcessUnresponsive)=="wait","Unresponsive wait");
        Assert(!NativeShellPolicy.Background(true,false,false,false),"Foreground");
        Assert(NativeShellPolicy.Background(false,false,false,false),"Deactivate pauses");
        Assert(!NativeShellPolicy.CanSuspend(false,false,false),"Visible inactive window must not suspend");
        Assert(NativeShellPolicy.CanSuspend(true,false,false),"Minimize suspends");
        Assert(NativeShellPolicy.CanSuspend(false,true,false),"Lock suspends");
        Assert(NativeShellPolicy.CanSuspend(false,false,true),"Sleep suspends");
        string profile=Path.Combine(Path.GetTempPath(),"Orbbound-native-test-profile");
        Assert(NativeShellPolicy.DataDirectory(new[]{"--user-data-dir="+profile})==Path.GetFullPath(profile),"Isolated profile");
        Assert(NativeShellPolicy.DataDirectory(new[]{"--data-dir="+profile})==Path.GetFullPath(profile),"Profile alias");
        bool rejected=false;
        try { NativeShellPolicy.DataDirectory(new[]{"--user-data-dir=relative"}); } catch(ArgumentException) { rejected=true; }
        Assert(rejected,"Relative test profiles are rejected");
        rejected=false;
        try { NativeShellPolicy.DataDirectory(new[]{"--data-dir=C:relative"}); } catch(ArgumentException) { rejected=true; }
        Assert(rejected,"Drive-relative profiles are rejected");
        Console.WriteLine("15 native shell policy checks passed");return 0;
    }
}
