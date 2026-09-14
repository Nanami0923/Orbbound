const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const { path7za } = require('7zip-bin');
const root = path.resolve(__dirname, '..');
const sdkVersion = '1.0.4022.49';
const sdkHash = 'ee9de67e5bb9ef3a96c5689b2efc8188e2df160a0e79234c0404243782fde5fb';
function run(command, args, cwd = root) {
  const result = spawnSync(command, args, { cwd, stdio: 'inherit', windowsHide: true });
  if (result.status !== 0) throw new Error(`Build command failed: ${command}`);
}
async function main() {
  const version = require('../package.json').version;
  if (require('../electron/windows-package.json').version !== version) throw new Error('Platform versions must match');
  const sdkRoot = path.join(root, '.build', 'webview2-sdk');
  const sdk = path.join(sdkRoot, sdkVersion);
  if (!fs.existsSync(path.join(sdk, 'lib/net462/Microsoft.Web.WebView2.Core.dll'))) {
    fs.mkdirSync(sdkRoot, { recursive: true });
    const response = await fetch(`https://api.nuget.org/v3-flatcontainer/microsoft.web.webview2/${sdkVersion}/microsoft.web.webview2.${sdkVersion}.nupkg`);
    if (!response.ok) throw new Error(`WebView2 SDK download failed: ${response.status}`);
    const bytes = Buffer.from(await response.arrayBuffer());
    if (createHash('sha256').update(bytes).digest('hex') !== sdkHash) throw new Error('WebView2 SDK checksum mismatch');
    const archive = path.join(sdkRoot, 'sdk.zip'); fs.writeFileSync(archive, bytes);
    run(path7za, ['x', archive, `-o${sdk}`, '-y']);
  }
  const output = path.join(root, '最终交付', 'Windows', `Orbbound-Windows-${version}`);
  const game = path.join(output, 'Orbbound');
  const stagingRoot = path.join(root, '.build', 'windows'); fs.mkdirSync(stagingRoot, { recursive:true });
  const staging = fs.mkdtempSync(path.join(stagingRoot, 'webview2-app-'));
  fs.cpSync(path.join(stagingRoot, 'web'), path.join(staging, 'web'), { recursive: true });
  const libraries = ['Microsoft.Web.WebView2.Core.dll', 'Microsoft.Web.WebView2.WinForms.dll'];
  for (const name of libraries) fs.copyFileSync(path.join(sdk, 'lib/net462', name), path.join(staging, name));
  fs.copyFileSync(path.join(sdk, 'runtimes/win-x64/native/WebView2Loader.dll'), path.join(staging, 'WebView2Loader.dll'));
  const metadata = path.join(stagingRoot, 'AssemblyInfo.cs');
  fs.writeFileSync(metadata, `using System.Reflection;\n[assembly:AssemblyTitle("Orbbound")]\n[assembly:AssemblyProduct("Orbbound")]\n[assembly:AssemblyVersion("${version}.0")]\n[assembly:AssemblyFileVersion("${version}.0")]\n`);
  const compiler = path.join(process.env.WINDIR || 'C:/Windows', 'Microsoft.NET/Framework64/v4.0.30319/csc.exe');
  run(compiler, ['/nologo', '/target:winexe', '/platform:x64', '/optimize+', `/out:${path.join(staging, 'Orbbound.exe')}`, `/win32manifest:${path.join(root, 'windows/app.manifest')}`, '/reference:System.Windows.Forms.dll', '/reference:System.Drawing.dll', '/reference:System.Web.Extensions.dll', ...libraries.map(name => `/reference:${path.join(staging, name)}`), path.join(root, 'windows/Program.cs'), metadata]);
  fs.writeFileSync(path.join(staging, 'Orbbound.exe.config'), '<?xml version="1.0"?><configuration><startup><supportedRuntime version="v4.0" sku=".NETFramework,Version=v4.8"/></startup></configuration>');
  fs.writeFileSync(path.join(staging, '开始游戏.txt'), `Orbbound ${version} · Windows 10/11 x64\r\n解压完整目录，双击 Orbbound.exe。无需安装游戏。\r\n本包不含 Electron、Chromium、WebView2 Runtime 或 .NET 安装环境；使用系统 .NET Framework 4.8 和共享 WebView2 Evergreen。缺失时游戏提供微软官方补装入口。\r\nWebView2 官方补装：https://developer.microsoft.com/en-us/microsoft-edge/webview2#download-section\r\n保存于 %LOCALAPPDATA%/Orbbound。旧版数据保留在 %APPDATA%/orbbound，可在设置→存档备份与迁移中导入。F11 切换全屏。\r\n`);
  fs.copyFileSync(path.join(sdk, 'LICENSE.txt'), path.join(staging, 'WebView2-SDK-LICENSE.txt'));
  fs.copyFileSync(path.join(sdk, 'NOTICE.txt'), path.join(staging, 'WebView2-SDK-NOTICE.txt'));
  const licenses = ['phaser/LICENSE.md', '@capacitor/core/LICENSE', '@capacitor/app/LICENSE'];
  fs.writeFileSync(path.join(staging, 'Game-LICENSES.txt'), licenses.map(file => `${file}\n\n${fs.readFileSync(path.join(root, 'node_modules', file), 'utf8')}`).join('\n\n---\n\n'));
  fs.mkdirSync(output, { recursive: true });
  if (path.dirname(path.resolve(game)) !== path.resolve(output)) throw new Error('Invalid output directory');
  if (fs.existsSync(game)) fs.rmSync(game, { recursive: true });
  fs.renameSync(staging, game);
  const archive = path.join(output, `Orbbound-Windows-${version}-x64.zip`);
  if (fs.existsSync(archive)) fs.unlinkSync(archive);
  run(path7za, ['a', '-tzip', '-mx=9', archive, 'Orbbound'], output);
  const hash = createHash('sha256').update(fs.readFileSync(archive)).digest('hex');
  fs.writeFileSync(`${archive}.sha256`, `${hash}  ${path.basename(archive)}\n`);
  console.log(JSON.stringify({ version, archive, bytes: fs.statSync(archive).size, sha256: hash, bundledRuntime: false }));
}
main().catch(error => { console.error(error); process.exitCode = 1; });
