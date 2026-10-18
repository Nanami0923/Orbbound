using System;
using System.IO;
using System.Linq;
using System.Drawing;
using System.Diagnostics;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Threading;
using System.Threading.Tasks;
using System.Web.Script.Serialization;
using System.Windows.Forms;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;
using Microsoft.Win32;

internal static class Program {
    internal static readonly JavaScriptSerializer Json = new JavaScriptSerializer { MaxJsonLength = 2500000 };
    internal static string DataRoot;
    internal static uint ActivateMessage;
    [DllImport("user32.dll")] static extern bool SetProcessDpiAwarenessContext(IntPtr value);
    [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern uint RegisterWindowMessage(string name);
    [DllImport("user32.dll")] static extern bool PostMessage(IntPtr hwnd, uint msg, IntPtr w, IntPtr l);
    [STAThread] static void Main(string[] args) {
        try { SetProcessDpiAwarenessContext(new IntPtr(-4)); } catch { }
        Application.EnableVisualStyles(); Application.SetCompatibleTextRenderingDefault(false);
        try { DataRoot=NativeShellPolicy.DataDirectory(args); Directory.CreateDirectory(DataRoot); }
        catch(Exception error) { MessageBox.Show("存档目录不可用："+error.Message,"Orbbound",MessageBoxButtons.OK,MessageBoxIcon.Error);return; }
        string identity;
        using (var sha=System.Security.Cryptography.SHA256.Create()) identity=BitConverter.ToString(sha.ComputeHash(System.Text.Encoding.UTF8.GetBytes(DataRoot.ToLowerInvariant()))).Replace("-", "");
        ActivateMessage=RegisterWindowMessage("Orbbound.Activate."+identity);
        bool first;
        using(var mutex=new Mutex(true,"Local\\Orbbound."+identity,out first)) {
            if (!first) { PostMessage(new IntPtr(0xffff),ActivateMessage,IntPtr.Zero,IntPtr.Zero); return; }
            try { Application.Run(new GameWindow(args)); }
            catch(Exception error) { MessageBox.Show("启动失败："+error.Message,"Orbbound",MessageBoxButtons.OK,MessageBoxIcon.Error); }
        }
    }
}

internal static class NativeShellPolicy {
    internal static string DataDirectory(string[] arguments) {
        string custom=arguments.FirstOrDefault(a=>a.StartsWith("--user-data-dir=",StringComparison.Ordinal)||a.StartsWith("--data-dir=",StringComparison.Ordinal));
        if(custom==null)return Path.GetFullPath(Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),"Orbbound"));
        string value=custom.Substring(custom.IndexOf('=')+1);
        if(String.IsNullOrWhiteSpace(value)||!Path.IsPathRooted(value)||Path.GetPathRoot(value).Length<3)throw new ArgumentException("测试目录必须是绝对路径");
        return Path.GetFullPath(value);
    }
    internal static string Recovery(CoreWebView2ProcessFailedKind kind) {
        switch(kind) {
            case CoreWebView2ProcessFailedKind.GpuProcessExited:
            case CoreWebView2ProcessFailedKind.UtilityProcessExited:
            case CoreWebView2ProcessFailedKind.SandboxHelperProcessExited:
            case CoreWebView2ProcessFailedKind.PpapiPluginProcessExited:
            case CoreWebView2ProcessFailedKind.PpapiBrokerProcessExited:return "runtime";
            case CoreWebView2ProcessFailedKind.BrowserProcessExited:return "recreate";
            case CoreWebView2ProcessFailedKind.RenderProcessUnresponsive:return "wait";
            default:return "reload";
        }
    }
    internal static bool Background(bool active,bool minimized,bool locked,bool sleeping) { return !active||minimized||locked||sleeping; }
    internal static bool CanSuspend(bool minimized,bool locked,bool sleeping) { return minimized||locked||sleeping; }
}

internal sealed class GameWindow : Form {
    const string Home="https://orbbound.local/index.html";
    WebView2 web=new WebView2();
    readonly Label status=new Label { Text="正在准备 ORBBOUND…", Dock=DockStyle.Fill, TextAlign=ContentAlignment.MiddleCenter, ForeColor=Color.FromArgb(190,207,223), Font=new Font("Microsoft YaHei",12) };
    readonly Panel recovery=new Panel { Dock=DockStyle.Fill };
    readonly FlowLayoutPanel recoveryActions=new FlowLayoutPanel { Dock=DockStyle.Bottom, Height=64, FlowDirection=FlowDirection.LeftToRight, WrapContents=false, Padding=new Padding(16,8,16,8) };
    readonly Button retryButton=new Button { Text="重试", Width=120, Height=40 };
    readonly Button waitButton=new Button { Text="继续等待", Width=120, Height=40, Visible=false };
    readonly Button exitButton=new Button { Text="退出游戏", Width=120, Height=40 };
    readonly System.Windows.Forms.Timer loadTimeout=new System.Windows.Forms.Timer { Interval=20000 };
    readonly System.Windows.Forms.Timer displayDelay=new System.Windows.Forms.Timer { Interval=150 };
    Button runtimeLink;
    readonly string[] args;
    readonly string windowFile=Path.Combine(Program.DataRoot,"window.json");
    bool ready, closing, fullscreen, migrationBusy, initializing, recreateRequired, lifecycleBusy, windowActive, sessionLocked, systemSleeping, waiting;
    int recoveryAttempts, lifecycleVersion, transientFailures;
    DateTime transientWindow=DateTime.UtcNow;
    string lastDisplayInfo;
    LanService lan;
    int lanGeneration;
    readonly object lanEventsLock=new object();
    readonly Queue<Dictionary<string,object>> lanEvents=new Queue<Dictionary<string,object>>();
    bool lanEventsScheduled;
    IntPtr powerNotification;
    Rectangle fullRestore;
    FormWindowState fullState;
    public GameWindow(string[] arguments) {
        args=arguments; Text="ORBBOUND "+System.Reflection.Assembly.GetExecutingAssembly().GetName().Version.ToString(3); BackColor=Color.FromArgb(13,18,33); StartPosition=FormStartPosition.Manual;
        MinimumSize=new Size(Math.Min(780,Screen.PrimaryScreen.WorkingArea.Width),Math.Min(500,Screen.PrimaryScreen.WorkingArea.Height));
        RestoreWindow(); MountWebView();ResetLan();
        recovery.BackColor=BackColor; recovery.Controls.Add(status); recovery.Controls.Add(recoveryActions);
        recoveryActions.Controls.Add(retryButton);recoveryActions.Controls.Add(waitButton);recoveryActions.Controls.Add(exitButton);
        recoveryActions.Visible=false; Controls.Add(recovery); recovery.BringToFront();
        retryButton.Click+=async delegate { await RetryView(); };waitButton.Click+=async delegate { await WaitForView(); };exitButton.Click+=delegate { Close(); };
        loadTimeout.Tick+=delegate { loadTimeout.Stop(); if(!ready)ShowRecovery("页面加载未完成。可以重试，或退出后重新打开。",false,false); };
        displayDelay.Tick+=delegate { displayDelay.Stop(); PublishDisplayInfo(false); };
        Shown+=async delegate { await Initialize(); };
        Activated+=delegate { windowActive=true;QueueLifecycle();ScheduleDisplayInfo(); };
        Deactivate+=delegate { windowActive=false;QueueLifecycle(); };
        Resize+=delegate { QueueLifecycle();ScheduleDisplayInfo(); };
        Move+=delegate { ScheduleDisplayInfo(); };
        SystemEvents.SessionSwitch+=OnSessionSwitch;SystemEvents.PowerModeChanged+=OnPowerModeChanged;SystemEvents.DisplaySettingsChanged+=OnDisplaySettingsChanged;
        FormClosing+=OnClosing;
    }
    void MountWebView() { web.Dock=DockStyle.Fill;web.DefaultBackgroundColor=BackColor;web.Visible=false;Controls.Add(web);web.SendToBack(); }
    protected override void OnHandleCreated(EventArgs e) {
        base.OnHandleCreated(e);
        var saver=new Guid("E00958C0-C213-4ACE-AC77-FECCED2EEEA5");
        powerNotification=RegisterPowerSettingNotification(Handle,ref saver,0);
    }
    protected override void OnHandleDestroyed(EventArgs e) {
        if(powerNotification!=IntPtr.Zero) { UnregisterPowerSettingNotification(powerNotification);powerNotification=IntPtr.Zero; }
        base.OnHandleDestroyed(e);
    }
    protected override void WndProc(ref Message m) {
        if(m.Msg==Program.ActivateMessage) { if(WindowState==FormWindowState.Minimized)WindowState=FormWindowState.Normal; Show(); Activate(); }
        base.WndProc(ref m);
        if(m.Msg==0x007e||m.Msg==0x02e0)ScheduleDisplayInfo(); // WM_DISPLAYCHANGE / WM_DPICHANGED
        if(m.Msg==0x0218&&m.WParam.ToInt64()==0x8013)ScheduleDisplayInfo(); // Battery saver setting changed.
    }
    async Task Initialize() {
        if(initializing||closing)return;initializing=true;
        try {
            if(args.Contains("--test-missing-runtime")) throw new WebView2RuntimeNotFoundException();
            CoreWebView2Environment.GetAvailableBrowserVersionString();
            string debug=args.FirstOrDefault(a=>a.StartsWith("--remote-debugging-port="));
            var options=new CoreWebView2EnvironmentOptions("--autoplay-policy=no-user-gesture-required"+(debug==null?"":" "+debug));
            var env=await WaitForInitialization(CoreWebView2Environment.CreateAsync(null,Path.Combine(Program.DataRoot,"WebView2"),options));
            await WaitForInitialization(web.EnsureCoreWebView2Async(env));
            var core=web.CoreWebView2;
            core.Settings.AreDefaultContextMenusEnabled=false;
            core.Settings.AreDevToolsEnabled=debug!=null;
            core.Settings.IsStatusBarEnabled=false;
            core.Settings.IsZoomControlEnabled=false;
            core.Settings.AreBrowserAcceleratorKeysEnabled=false;
            core.SetVirtualHostNameToFolderMapping("orbbound.local",Path.Combine(AppDomain.CurrentDomain.BaseDirectory,"web"),CoreWebView2HostResourceAccessKind.DenyCors);
            core.NavigationStarting+=delegate(object sender,CoreWebView2NavigationStartingEventArgs e) { if(!TrustedSource(e.Uri))e.Cancel=true;else ResetLan(); };
            core.NewWindowRequested+=delegate(object sender,CoreWebView2NewWindowRequestedEventArgs e) { e.Handled=true; };
            core.PermissionRequested+=delegate(object sender,CoreWebView2PermissionRequestedEventArgs e) { e.State=CoreWebView2PermissionState.Deny; };
            core.WebMessageReceived+=OnMessage;
            core.ProcessFailed+=OnProcessFailed;
            core.NavigationCompleted+=delegate(object sender,CoreWebView2NavigationCompletedEventArgs e) { if(!e.IsSuccess&&!closing)ShowRecovery("页面未能载入。请重试。",false,false); };
            web.Visible=true;
            recovery.BringToFront();
            core.Navigate(Home);
            loadTimeout.Start();recreateRequired=false;
        } catch(WebView2RuntimeNotFoundException) { MissingRuntime(); }
        catch(Exception error) { Log("initialize: "+error.Message);ShowRecovery("启动未完成："+error.Message,true,false); }
        finally { initializing=false;if(!ready&&!loadTimeout.Enabled)retryButton.Enabled=recoveryAttempts<3; }
    }
    async Task WaitForInitialization(Task task) {
        if(await Task.WhenAny(task,Task.Delay(15000))!=task) {
            ObserveLateInitialization(task);
            throw new TimeoutException("运行环境准备超时，请重试");
        }
        await task;
    }
    async void ObserveLateInitialization(Task task) { try { await task; } catch(Exception error) { Log("late initialization: "+error.Message); } }
    async Task<T> WaitForInitialization<T>(Task<T> task) { await WaitForInitialization((Task)task);return await task; }
    void MissingRuntime() {
        ShowRecovery("未检测到 Microsoft WebView2 运行环境。\n安装后点击重试即可离线游玩。",true,false);
        if(runtimeLink!=null)return;
        runtimeLink=new Button { Text="微软官方补装页面", Width=180, Height=40 };
        runtimeLink.Click+=delegate { Process.Start(new ProcessStartInfo("https://developer.microsoft.com/en-us/microsoft-edge/webview2#download-section") { UseShellExecute=true }); }; recoveryActions.Controls.Add(runtimeLink);
    }
    async void OnMessage(object sender,CoreWebView2WebMessageReceivedEventArgs e) {
        if(sender!=web.CoreWebView2||!TrustedSource(e.Source))return;
        try {
            var message=Program.Json.Deserialize<Dictionary<string,object>>(e.WebMessageAsJson);
            string type=message.ContainsKey("type")?message["type"] as string:null;
            if(type=="lan") { await HandleLan(message,e.WebMessageAsJson.Length); }
            else if(type=="ready") { ready=true;recoveryAttempts=0;loadTimeout.Stop();recovery.Visible=false;web.Visible=true;if(windowActive)web.Focus();PublishDisplayInfo(true);QueueLifecycle(); }
            else if(type=="fullscreen") ToggleFullscreen();
            else if(type=="close") Close();
            else if(type=="display-info") PublishDisplayInfo(true);
            else if(type=="export") {
                string text=message["text"] as string;
                if(text==null || System.Text.Encoding.UTF8.GetByteCount(text)>2000000)throw new Exception("备份文件超过 2 MB");
                using(var dialog=new SaveFileDialog { Filter="ORBBOUND 备份 (*.json)|*.json", FileName="Orbbound-"+DateTime.Now.ToString("yyyyMMdd-HHmm")+".json" }) {
                    if(dialog.ShowDialog(this)==DialogResult.OK) { File.WriteAllText(dialog.FileName,text,System.Text.Encoding.UTF8); Notice("备份已导出"); }
                }
            } else if(type=="import") {
                using(var dialog=new OpenFileDialog { Filter="ORBBOUND 备份 (*.json)|*.json" }) {
                    if(dialog.ShowDialog(this)==DialogResult.OK) { if(new FileInfo(dialog.FileName).Length>2000000)throw new Exception("备份文件过大"); Post("import",File.ReadAllText(dialog.FileName)); }
                }
            } else if(type=="legacy" && !migrationBusy) { await ImportLegacy(); }
        } catch(Exception error) { Notice("操作未完成："+error.Message); }
    }
    void Post(string type,string text) { if(!closing&&web.CoreWebView2!=null)web.CoreWebView2.PostWebMessageAsJson(Program.Json.Serialize(new {type=type,text=text})); }
    void Notice(string text) { Post("notice",text); }

    internal static bool TrustedSource(string source) {
        Uri uri;return Uri.TryCreate(source,UriKind.Absolute,out uri)&&uri.Scheme=="https"&&uri.Host=="orbbound.local"&&uri.Port==443&&String.IsNullOrEmpty(uri.UserInfo);
    }
    void ResetLan() {
        Interlocked.Increment(ref lanGeneration);
        if(lan!=null)lan.Dispose();
        lock(lanEventsLock) { lanEvents.Clear();lanEventsScheduled=false; }
        int generation=lanGeneration;string owner=lanClientId;
        lan=new LanService(delegate(Dictionary<string,object> evt) { evt["clientId"]=owner;QueueLanEvent(evt,generation); });
    }
    void QueueLanEvent(Dictionary<string,object> evt,int generation) {
        bool schedule=false;LanService overflowService=null;
        lock(lanEventsLock) {
            if(closing||generation!=lanGeneration)return;
            if(lanEvents.Count>=256) {
                lanEvents.Clear();overflowService=lan;
                evt=new Dictionary<string,object> { {"type","lan-event"},{"event","error"},{"error","联机消息积压，连接已关闭，请重新进入房间"},{"clientId",lanClientId} };
            }
            lanEvents.Enqueue(evt);
            if(!lanEventsScheduled) { lanEventsScheduled=true;schedule=true; }
        }
        if(overflowService!=null)overflowService.Dispose();
        if(schedule)OnUi(delegate { DrainLanEvents(generation); });
    }
    void DrainLanEvents(int generation) {
        if(generation!=lanGeneration||closing)return;
        for(int count=0;count<32;count++) {
            Dictionary<string,object> evt;
            lock(lanEventsLock) {
                if(lanEvents.Count==0) { lanEventsScheduled=false;return; }
                evt=lanEvents.Dequeue();
            }
            try { if(ready&&web.CoreWebView2!=null&&!web.CoreWebView2.IsSuspended)web.CoreWebView2.PostWebMessageAsJson(Program.Json.Serialize(evt)); }
            catch(Exception error) { Log("lan event: "+error.Message); }
        }
        // Yield the UI thread even when a remote sender continuously produces packets.
        if(!closing&&IsHandleCreated)BeginInvoke(new Action(delegate { DrainLanEvents(generation); }));
    }
    string lanClientId="";
    async Task HandleLan(Dictionary<string,object> message,int rawLength) {
        object raw;string requestId=message.TryGetValue("requestId",out raw)?raw as string:null;
        if(String.IsNullOrEmpty(requestId)||requestId.Length>128)return;
        int generation=lanGeneration;var source=web.CoreWebView2;var service=lan;
        object response;
        try {
            if(rawLength>400000)throw new ArgumentException("联机请求过大");
            string action=message.TryGetValue("action",out raw)?raw as string:null;
            if(String.IsNullOrEmpty(action)||action.Length>32)throw new ArgumentException("无效的联机操作");
            Dictionary<string,object> payload=null;
            if(message.TryGetValue("payload",out raw)) { payload=raw as Dictionary<string,object>;if(payload==null)throw new ArgumentException("无效的联机参数"); }
            string clientId=payload!=null&&payload.TryGetValue("_clientId",out raw)?raw as string:null;
            if(action=="claim") {
                if(String.IsNullOrEmpty(clientId)||clientId.Length>128)throw new ArgumentException("无效的联机会话");
                lanClientId=clientId;ResetLan();
                source.PostWebMessageAsJson(Program.Json.Serialize(new {type="lan-response",requestId=requestId,ok=true,result=(object)null}));
                return;
            }
            if(clientId!=lanClientId&&!(String.IsNullOrEmpty(clientId)&&String.IsNullOrEmpty(lanClientId)))throw new ArgumentException("联机会话已更换，请重新进入");
            object result=await service.Handle(action,payload);
            response=new {type="lan-response",requestId=requestId,ok=true,result=result};
            // A disposed transport can be recreated when the user opens LAN again.
            if(action=="dispose"&&generation==lanGeneration&&service==lan) { ResetLan();generation=lanGeneration; }
        } catch(Exception error) { response=new {type="lan-response",requestId=requestId,ok=false,error=error.Message}; }
        if(!closing&&source==web.CoreWebView2&&generation==lanGeneration)
            source.PostWebMessageAsJson(Program.Json.Serialize(response));
    }

    void Log(string message) {
        try {
            string directory=Path.Combine(Program.DataRoot,"diagnostics");Directory.CreateDirectory(directory);
            string file=Path.Combine(directory,"host.log");
            if(File.Exists(file)&&new FileInfo(file).Length>1000000)File.WriteAllText(file,"");
            File.AppendAllText(file,DateTime.UtcNow.ToString("o")+" "+message+Environment.NewLine,System.Text.Encoding.UTF8);
        } catch { }
    }

    void OnProcessFailed(object sender,CoreWebView2ProcessFailedEventArgs e) {
        if(closing)return;
        Log("process-failed kind="+e.ProcessFailedKind+" reason="+e.Reason+" exit="+e.ExitCode);
        string action=NativeShellPolicy.Recovery(e.ProcessFailedKind);
        if(action=="runtime") {
            // WebView2 recreates auxiliary processes itself; leave the game usable.
            if((DateTime.UtcNow-transientWindow).TotalSeconds>60) { transientWindow=DateTime.UtcNow;transientFailures=0; }
            if(++transientFailures<3)return;
            ShowRecovery("显示服务多次中断。可以重试，最近成功存档仍保存在本机。",false,false);
        } else if(action=="recreate")ShowRecovery("游戏运行环境已退出。点击重试重新打开，继续最近成功存档。",true,false);
        else if(action=="wait")ShowRecovery("游戏视图暂时没有响应。可以继续等待，或重试载入最近成功存档。",false,ready);
        else ShowRecovery("游戏视图已退出。点击重试载入最近成功存档。",false,false);
    }

    void ShowRecovery(string message,bool recreate,bool allowWait) {
        if(closing)return;
        ready=false;recreateRequired=recreate;loadTimeout.Stop();
        status.Text=message;web.Visible=false;recovery.Visible=true;recoveryActions.Visible=true;
        waitButton.Visible=allowWait;retryButton.Enabled=recoveryAttempts<3&&!initializing;
        if(recoveryAttempts>=3)status.Text+="\n连续重试未成功，请退出后重新启动。";
        recovery.BringToFront();if(windowActive) { if(allowWait)waitButton.Focus();else retryButton.Focus(); }
    }

    async Task RetryView() {
        if(initializing||waiting||closing||recoveryAttempts>=3)return;
        recoveryAttempts++;retryButton.Enabled=false;waitButton.Visible=false;status.Text="正在重新载入 ORBBOUND…";ResetLan();
        try {
            if(recreateRequired||web.CoreWebView2==null) {
                Controls.Remove(web);web.Dispose();web=new WebView2();MountWebView();
                await Initialize();
            } else {
                ready=false;web.CoreWebView2.Resume();web.Visible=true;
                web.CoreWebView2.Reload();loadTimeout.Start();
            }
        } catch(Exception error) { Log("retry: "+error.Message);ShowRecovery("重试未完成。请再次重试或退出。",true,false); }
        finally { if(!ready&&!loadTimeout.Enabled)retryButton.Enabled=recoveryAttempts<3; }
    }

    async Task WaitForView() {
        if(waiting||initializing||closing)return;
        waiting=true;waitButton.Enabled=false;retryButton.Enabled=false;status.Text="正在等待游戏视图响应…";
        try {
            var check=web.CoreWebView2.ExecuteScriptAsync("document.readyState");
            if(await Task.WhenAny(check,Task.Delay(5000))!=check) { Log("renderer remains unresponsive");status.Text="游戏视图仍未响应。可以再等待，或重试最近存档。";return; }
            await check;ready=true;recovery.Visible=false;web.Visible=true;QueueLifecycle();
        } catch(Exception error) { Log("wait: "+error.Message);ShowRecovery("游戏视图未恢复，请点击重试。",true,false); }
        finally { waiting=false;waitButton.Enabled=true;retryButton.Enabled=recoveryAttempts<3; }
    }

    void OnUi(Action action) {
        if(closing||IsDisposed||!IsHandleCreated)return;
        try { if(InvokeRequired)BeginInvoke(action);else action(); } catch(InvalidOperationException) { }
    }
    void OnSessionSwitch(object sender,SessionSwitchEventArgs e) {
        OnUi(delegate { if(e.Reason==SessionSwitchReason.SessionLock)sessionLocked=true;else if(e.Reason==SessionSwitchReason.SessionUnlock)sessionLocked=false;QueueLifecycle(); });
    }
    void OnPowerModeChanged(object sender,PowerModeChangedEventArgs e) {
        OnUi(delegate { if(e.Mode==PowerModes.Suspend)systemSleeping=true;else if(e.Mode==PowerModes.Resume)systemSleeping=false;QueueLifecycle();ScheduleDisplayInfo(); });
    }
    void OnDisplaySettingsChanged(object sender,EventArgs e) { OnUi(ScheduleDisplayInfo); }
    bool IsBackground { get { return NativeShellPolicy.Background(windowActive,WindowState==FormWindowState.Minimized,sessionLocked,systemSleeping); } }
    bool CanSuspend { get { return NativeShellPolicy.CanSuspend(WindowState==FormWindowState.Minimized,sessionLocked,systemSleeping); } }
    void QueueLifecycle() { lifecycleVersion++;if(ready&&!lifecycleBusy&&!closing)ApplyLifecycle(); }

    async void ApplyLifecycle() {
        lifecycleBusy=true;
        int handled=-1;
        try {
            while(!closing&&ready&&handled!=lifecycleVersion) {
                handled=lifecycleVersion;
                var currentWeb=web;var core=currentWeb.CoreWebView2;if(core==null)return;
                if(IsBackground) {
                    bool saved=core.IsSuspended;
                    if(!saved) {
                        core.PostWebMessageAsJson(Program.Json.Serialize(new {type="lan-event",@event="background"}));
                        var save=core.ExecuteScriptAsync("window.dispatchEvent(new Event('orbbound-host-background'))");
                        if(await Task.WhenAny(save,Task.Delay(1000))==save) { await save;saved=true; }
                        else Log("background-save acknowledgement timed out; suspension skipped");
                    }
                    if(closing||!ready||currentWeb!=web)return;
                    if(saved&&handled==lifecycleVersion&&CanSuspend) {
                        // DOM listeners finish their synchronous save before visibility changes.
                        currentWeb.Visible=false;
                        bool suspended=await core.TrySuspendAsync();
                        if(!suspended)Log("TrySuspendAsync returned false");
                    }
                } else {
                    core.Resume();currentWeb.Visible=true;
                    core.PostWebMessageAsJson(Program.Json.Serialize(new {type="lan-event",@event="foreground"}));
                    await core.ExecuteScriptAsync("window.dispatchEvent(new Event('orbbound-host-foreground'))");
                    ScheduleDisplayInfo();
                }
            }
        } catch(Exception error) { Log("lifecycle: "+error.Message); }
        finally { lifecycleBusy=false;if(!closing&&ready&&handled!=lifecycleVersion)ApplyLifecycle(); }
    }

    [StructLayout(LayoutKind.Sequential,CharSet=CharSet.Unicode)]
    struct DisplayMode {
        [MarshalAs(UnmanagedType.ByValTStr,SizeConst=32)] public string dmDeviceName;
        public ushort dmSpecVersion,dmDriverVersion,dmSize,dmDriverExtra;
        public uint dmFields;
        public int dmPositionX,dmPositionY;
        public uint dmDisplayOrientation,dmDisplayFixedOutput;
        public short dmColor,dmDuplex,dmYResolution,dmTTOption,dmCollate;
        [MarshalAs(UnmanagedType.ByValTStr,SizeConst=32)] public string dmFormName;
        public ushort dmLogPixels;
        public uint dmBitsPerPel,dmPelsWidth,dmPelsHeight,dmDisplayFlags,dmDisplayFrequency,dmICMMethod,dmICMIntent,dmMediaType,dmDitherType,dmReserved1,dmReserved2,dmPanningWidth,dmPanningHeight;
    }
    [StructLayout(LayoutKind.Sequential)]
    struct PowerStatus {
        public byte ACLineStatus,BatteryFlag,BatteryLifePercent,SystemStatusFlag;
        public uint BatteryLifeTime,BatteryFullLifeTime;
    }
    [DllImport("user32.dll",CharSet=CharSet.Unicode)] static extern bool EnumDisplaySettings(string deviceName,int modeNum,ref DisplayMode mode);
    [DllImport("kernel32.dll")] static extern bool GetSystemPowerStatus(out PowerStatus status);
    [DllImport("user32.dll",SetLastError=true)] static extern IntPtr RegisterPowerSettingNotification(IntPtr recipient,ref Guid setting,uint flags);
    [DllImport("user32.dll")] static extern bool UnregisterPowerSettingNotification(IntPtr handle);
    object DisplayInfo() {
        string device=Screen.FromControl(this).DeviceName;
        var current=new DisplayMode { dmSize=(ushort)Marshal.SizeOf(typeof(DisplayMode)) };
        bool known=EnumDisplaySettings(device,-1,ref current)&&current.dmDisplayFrequency>1;
        var rates=new SortedSet<uint>();
        if(known) {
            rates.Add(current.dmDisplayFrequency);
            for(int i=0;i<512;i++) {
                var mode=new DisplayMode { dmSize=(ushort)Marshal.SizeOf(typeof(DisplayMode)) };
                if(!EnumDisplaySettings(device,i,ref mode))break;
                if(mode.dmPelsWidth==current.dmPelsWidth&&mode.dmPelsHeight==current.dmPelsHeight&&mode.dmDisplayFrequency>1)rates.Add(mode.dmDisplayFrequency);
            }
        }
        PowerStatus power;bool hasPower=GetSystemPowerStatus(out power);
        return new { platform="windows",displayId=device,refreshRate=known?(double)current.dmDisplayFrequency:60d,supportedRefreshRates=rates.ToArray(),powerSave=hasPower&&power.SystemStatusFlag==1,thermalStatus=(int?)null,refreshRateKnown=known,supportsRefreshRateRequest=false };
    }
    void ScheduleDisplayInfo() { if(!closing&&!IsDisposed) { displayDelay.Stop();displayDelay.Start(); } }
    void PublishDisplayInfo(bool force) {
        if(!ready||closing||web.CoreWebView2==null||web.CoreWebView2.IsSuspended)return;
        try {
            var info=DisplayInfo();string text=Program.Json.Serialize(info);
            if(!force&&text==lastDisplayInfo)return;
            lastDisplayInfo=text;web.CoreWebView2.PostWebMessageAsJson(Program.Json.Serialize(new {type="display-info",info=info}));
        } catch(Exception error) { Log("display-info: "+error.Message); }
    }

    async Task ImportLegacy() {
        migrationBusy=true;
        try {
            string legacy=Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData),"orbbound");
            string explicitLegacy=args.FirstOrDefault(a=>a.StartsWith("--legacy-data-dir="));
            if(explicitLegacy!=null)legacy=Path.GetFullPath(explicitLegacy.Substring(18));
            if(!Directory.Exists(Path.Combine(legacy,"Local Storage","leveldb"))) {
                using(var picker=new FolderBrowserDialog { Description="选择旧版 orbbound 存档目录（包含 Local Storage 文件夹）", SelectedPath=legacy }) { if(picker.ShowDialog(this)!=DialogResult.OK)return; legacy=picker.SelectedPath; }
            }
            string source=Path.Combine(legacy,"Local Storage","leveldb");
            if(!File.Exists(Path.Combine(source,"CURRENT")))throw new Exception("该目录中没有旧版存档");
            foreach(var process in Process.GetProcessesByName("Orbbound")) {
                try { if(process.Id!=Process.GetCurrentProcess().Id && !String.Equals(process.MainModule.FileName,Application.ExecutablePath,StringComparison.OrdinalIgnoreCase))throw new IOException("请先关闭旧版游戏，再导入存档"); }
                finally { process.Dispose(); }
            }
            Notice("正在读取旧版存档，原目录保持不变…");
            string scratch=Path.Combine(Program.DataRoot,"MigrationBackups",DateTime.UtcNow.ToString("yyyyMMdd-HHmmss")+"-"+Guid.NewGuid().ToString("N"));
            string target=Path.Combine(scratch,"EBWebView","Default","Local Storage","leveldb");Directory.CreateDirectory(target);
            var snapshot=Directory.GetFiles(source).Where(file=>Path.GetFileName(file)!="LOCK").Select(file=>new { FullName=file, Name=Path.GetFileName(file), Length=new FileInfo(file).Length, Modified=File.GetLastWriteTimeUtc(file) }).ToArray();
            foreach(var file in snapshot)File.Copy(file.FullName,Path.Combine(target,file.Name));
            foreach(var file in snapshot) { var current=new FileInfo(file.FullName);if(current.Length!=file.Length||current.LastWriteTimeUtc!=file.Modified)throw new IOException("旧存档正在变化，请关闭旧版后重试"); }
            using(var migration=new WebView2 { Size=new Size(1,1), Visible=false }) {
                Controls.Add(migration);
                var env=await CoreWebView2Environment.CreateAsync(null,scratch);
                await migration.EnsureCoreWebView2Async(env);
                var completed=new TaskCompletionSource<bool>();
                migration.CoreWebView2.NavigationCompleted+=delegate(object s,CoreWebView2NavigationCompletedEventArgs n) { completed.TrySetResult(n.IsSuccess); };
                string page=Path.Combine(scratch,"read.html");File.WriteAllText(page,"<!doctype html><meta charset=utf-8>");
                migration.CoreWebView2.Navigate(new Uri(page).AbsoluteUri);
                if(await Task.WhenAny(completed.Task,Task.Delay(15000))!=completed.Task || !await completed.Task)throw new Exception("旧存档读取超时，请关闭旧版后重试");
                string result=await migration.CoreWebView2.ExecuteScriptAsync("JSON.stringify(Object.fromEntries(['orbbound-save-v1','orbbound-timed-active-v2','orbbound-settings-v1','orbbound-high-score-v1','orbbound-history-v1'].map(k=>[k,localStorage.getItem(k)]).filter(x=>x[1]!==null)))");
                string values=Program.Json.Deserialize<string>(result);
                if(values=="{}")throw new Exception("未读取到可迁移数据；请确认选中的是旧版存档目录");
                string backup="{\"app\":\"orbbound\",\"version\":1,\"values\":"+values+"}";
                File.WriteAllText(Path.Combine(scratch,"Orbbound-legacy-backup.json"),backup);
                Controls.Remove(migration); Post("import",backup);
            }
        } finally { migrationBusy=false; }
    }
    void RestoreWindow() {
        Rectangle area=Screen.PrimaryScreen.WorkingArea;
        Bounds=new Rectangle(area.X+Math.Max(0,(area.Width-1280)/2),area.Y+Math.Max(0,(area.Height-860)/2),Math.Min(1280,area.Width),Math.Min(860,area.Height));
        try {
            var saved=Program.Json.Deserialize<Dictionary<string,int>>(File.ReadAllText(windowFile));
            var old=new Rectangle(saved["x"],saved["y"],saved["width"],saved["height"]);
            area=Screen.FromRectangle(old).WorkingArea;
            MinimumSize=new Size(Math.Min(780,area.Width),Math.Min(500,area.Height));
            old.Width=Math.Max(MinimumSize.Width,Math.Min(old.Width,area.Width));old.Height=Math.Max(MinimumSize.Height,Math.Min(old.Height,area.Height));
            old.X=Math.Max(area.Left,Math.Min(old.X,area.Right-old.Width));old.Y=Math.Max(area.Top,Math.Min(old.Y,area.Bottom-old.Height));Bounds=old;
            if(saved["maximized"]==1)WindowState=FormWindowState.Maximized;
        } catch { }
    }
    void ToggleFullscreen() {
        if(!fullscreen) { fullRestore=Bounds;fullState=WindowState;WindowState=FormWindowState.Normal;FormBorderStyle=FormBorderStyle.None;Bounds=Screen.FromControl(this).Bounds;fullscreen=true; }
        else { FormBorderStyle=FormBorderStyle.Sizable;Bounds=fullRestore;WindowState=fullState;fullscreen=false; }
    }
    async void OnClosing(object sender,FormClosingEventArgs e) {
        if(closing)return;e.Cancel=true;closing=true;
        try {
            Rectangle b=fullscreen?fullRestore:WindowState==FormWindowState.Normal?Bounds:RestoreBounds;
            File.WriteAllText(windowFile,Program.Json.Serialize(new {x=b.X,y=b.Y,width=b.Width,height=b.Height,maximized=(fullscreen?fullState:WindowState)==FormWindowState.Maximized?1:0}));
            if(ready&&!web.CoreWebView2.IsSuspended)await Task.WhenAny(web.CoreWebView2.ExecuteScriptAsync("window.dispatchEvent(new Event('orbbound-host-background'))"),Task.Delay(1000));
        } catch { }
        if(lan!=null)lan.Dispose();web.Dispose();Close();
    }
    protected override void Dispose(bool disposing) {
        if(disposing) {
            Interlocked.Increment(ref lanGeneration);if(lan!=null)lan.Dispose();
            SystemEvents.SessionSwitch-=OnSessionSwitch;SystemEvents.PowerModeChanged-=OnPowerModeChanged;SystemEvents.DisplaySettingsChanged-=OnDisplaySettingsChanged;
            loadTimeout.Dispose();displayDelay.Dispose();
        }
        base.Dispose(disposing);
    }
}
