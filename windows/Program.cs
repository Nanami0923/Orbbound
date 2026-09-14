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
        DataRoot = Path.GetFullPath(args.FirstOrDefault(a=>a.StartsWith("--user-data-dir=")) == null ? Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),"Orbbound") : args.First(a=>a.StartsWith("--user-data-dir=")).Substring(16));
        Directory.CreateDirectory(DataRoot);
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

internal sealed class GameWindow : Form {
    const string Home="https://orbbound.local/index.html";
    readonly WebView2 web=new WebView2();
    readonly Label status=new Label { Text="正在准备 ORBBOUND…", Dock=DockStyle.Fill, TextAlign=ContentAlignment.MiddleCenter, ForeColor=Color.FromArgb(190,207,223), Font=new Font("Microsoft YaHei",12) };
    readonly string[] args;
    readonly string windowFile=Path.Combine(Program.DataRoot,"window.json");
    bool ready, closing, fullscreen, migrationBusy;
    Rectangle fullRestore;
    FormWindowState fullState;
    public GameWindow(string[] arguments) {
        args=arguments; Text="ORBBOUND "+System.Reflection.Assembly.GetExecutingAssembly().GetName().Version.ToString(3); BackColor=Color.FromArgb(13,18,33); StartPosition=FormStartPosition.Manual;
        MinimumSize=new Size(Math.Min(780,Screen.PrimaryScreen.WorkingArea.Width),Math.Min(500,Screen.PrimaryScreen.WorkingArea.Height));
        RestoreWindow(); web.Dock=DockStyle.Fill; web.DefaultBackgroundColor=BackColor; web.Visible=false;
        Controls.Add(web); Controls.Add(status); Shown+=async delegate { await Initialize(); };
        Resize+=delegate { if(ready) SendLifecycle(WindowState==FormWindowState.Minimized); };
        FormClosing+=OnClosing;
    }
    protected override void WndProc(ref Message m) {
        if(m.Msg==Program.ActivateMessage) { if(WindowState==FormWindowState.Minimized)WindowState=FormWindowState.Normal; Show(); Activate(); }
        base.WndProc(ref m);
    }
    async Task Initialize() {
        try {
            if(args.Contains("--test-missing-runtime")) throw new WebView2RuntimeNotFoundException();
            CoreWebView2Environment.GetAvailableBrowserVersionString();
            string debug=args.FirstOrDefault(a=>a.StartsWith("--remote-debugging-port="));
            var options=new CoreWebView2EnvironmentOptions("--autoplay-policy=no-user-gesture-required"+(debug==null?"":" "+debug));
            var env=await CoreWebView2Environment.CreateAsync(null,Path.Combine(Program.DataRoot,"WebView2"),options);
            await web.EnsureCoreWebView2Async(env);
            var core=web.CoreWebView2;
            core.Settings.AreDefaultContextMenusEnabled=false;
            core.Settings.AreDevToolsEnabled=debug!=null;
            core.Settings.IsStatusBarEnabled=false;
            core.Settings.IsZoomControlEnabled=false;
            core.SetVirtualHostNameToFolderMapping("orbbound.local",Path.Combine(AppDomain.CurrentDomain.BaseDirectory,"web"),CoreWebView2HostResourceAccessKind.DenyCors);
            core.NavigationStarting+=delegate(object sender,CoreWebView2NavigationStartingEventArgs e) { if(!e.Uri.StartsWith("https://orbbound.local/",StringComparison.Ordinal)) e.Cancel=true; };
            core.NewWindowRequested+=delegate(object sender,CoreWebView2NewWindowRequestedEventArgs e) { e.Handled=true; };
            core.PermissionRequested+=delegate(object sender,CoreWebView2PermissionRequestedEventArgs e) { e.State=CoreWebView2PermissionState.Deny; };
            core.WebMessageReceived+=OnMessage;
            core.ProcessFailed+=delegate { ready=false; web.Visible=false; status.Text="游戏视图已退出，请关闭后重新打开。存档保存在本机。"; status.Visible=true; };
            web.Visible=true;
            status.BringToFront();
            core.Navigate(Home);
            var timeout=new System.Windows.Forms.Timer { Interval=20000 };
            timeout.Tick+=delegate { timeout.Stop(); timeout.Dispose(); if(!ready)status.Text="页面加载未完成，请关闭后重新打开。"; }; timeout.Start();
        } catch(WebView2RuntimeNotFoundException) { MissingRuntime(); }
        catch(Exception error) { status.Text="启动失败："+error.Message; }
    }
    void MissingRuntime() {
        status.Text="未检测到 Microsoft WebView2 运行环境。\n本轻量包不携带运行环境，安装后即可离线游玩。";
        var link=new Button { Text="打开微软官方补装页面", Dock=DockStyle.Bottom, Height=52, BackColor=Color.FromArgb(30,48,65), ForeColor=Color.White, FlatStyle=FlatStyle.Flat };
        link.Click+=delegate { Process.Start(new ProcessStartInfo("https://developer.microsoft.com/en-us/microsoft-edge/webview2#download-section") { UseShellExecute=true }); }; Controls.Add(link);
    }
    async void OnMessage(object sender,CoreWebView2WebMessageReceivedEventArgs e) {
        if(!e.Source.StartsWith("https://orbbound.local/",StringComparison.Ordinal))return;
        try {
            var message=Program.Json.Deserialize<Dictionary<string,object>>(e.WebMessageAsJson);
            string type=message.ContainsKey("type")?message["type"] as string:null;
            if(type=="ready") { ready=true; status.Visible=false; web.Visible=true; web.Focus(); }
            else if(type=="fullscreen") ToggleFullscreen();
            else if(type=="close") Close();
            else if(type=="export") {
                string text=message["text"] as string;
                if(text==null || text.Length>2000000)return;
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
    void Post(string type,string text) { web.CoreWebView2.PostWebMessageAsJson(Program.Json.Serialize(new {type=type,text=text})); }
    void Notice(string text) { Post("notice",text); }
    void SendLifecycle(bool background) {
        if(web.CoreWebView2!=null) { var ignored=web.CoreWebView2.ExecuteScriptAsync("window.dispatchEvent(new Event('orbbound-host-"+(background?"background":"foreground")+"'))"); }
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
            if(ready)await Task.WhenAny(web.CoreWebView2.ExecuteScriptAsync("window.dispatchEvent(new Event('orbbound-host-background'))"),Task.Delay(1000));
        } catch { }
        web.Dispose();Close();
    }
}
