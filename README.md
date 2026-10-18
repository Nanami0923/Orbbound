# Orbbound

Android 与 Windows 最新测试版均为 **4.5.0**，正式版保留 **4.3.0**。本次恢复 Android 首页演示，修复 Windows 模式卡圆角裁切和过长菜单，重做语义分页，并处理已定位的联机等待、设置重绘和加载竞态。保留单机模式、30 个高难度关卡、2–4 人局域网联机与旧存档。

## 交付位置

| 平台 | 最新版本 | 交付目录 | 主要文件 |
| --- | --- | --- | --- |
| Android | 4.5.0 测试版 | [Android 交付目录](最终交付/Android/Orbbound-4.5.0/) | APK、SHA-256、更新说明 |
| Windows | 4.5.0 测试版 | [Windows 交付目录](最终交付/Windows/Orbbound-Windows-4.5.0/) | 轻量 ZIP、SHA-256、完整 Orbbound 运行目录 |

所有旧版本保留在对应平台目录内。Windows 1.0.0 的两个不同本地构建按原来源分别保存，不将其视作同一文件。

测试版下载：[Windows 4.5.0 ZIP](https://github.com/Nanami0923/Orbbound/releases/download/v4.5.0/Orbbound-Windows-4.5.0-x64.zip) · [Android 4.5.0 APK](https://github.com/Nanami0923/Orbbound/releases/download/v4.5.0/Orbbound-4.5.0-Android.apk) · [4.5.0 发布页](https://github.com/Nanami0923/Orbbound/releases/tag/v4.5.0)。[4.3.0 正式版](https://github.com/Nanami0923/Orbbound/releases/tag/v4.3.0)仍可下载。

[4.5.0 更新说明](docs/releases/4.5.0-notes.md) · [验证记录](docs/releases/4.5.0-validation.md) · [本次实施方案](docs/design/4.5.0双端布局与稳定性修复方案.md)

Windows 请完整解压 ZIP 后运行 `Orbbound/Orbbound.exe`。轻量包不包含运行环境，使用本机 .NET Framework 4.8 和共享 WebView2 Evergreen Runtime；具备环境后可离线游玩。缺少 WebView2 时程序提供[微软官方补装入口](https://developer.microsoft.com/en-us/microsoft-edge/webview2#download-section)，本次发布不上传环境安装包。

联机建议所有人安装 **4.5.0**，连接同一路由器或可互通热点，在首页选择「局域网联机」。房间容量可选 2 / 3 / 4，至少两人且全员准备即可开局；同图竞分和连锁对战均支持四人。协议仍为 v3，不能与 4.3.x 混用；4.4.0 与 4.5.0 混用尚未验证。扫描后可在房间卡片「填入地址」或「加入」；找不到时输入房主 IPv4 并选择「按地址检索」，也可直接输入完整地址与端口。Windows 防火墙需允许应用在专用网络通信；手动地址不能绕过网络隔离。普通网页预览不提供原生联网。

局内选择「暂停 / 设置」后，其他在赛选手会收到投票。全员同意后申请者自动进入设置；完成设置返回暂停面板，全员准备后倒计时恢复。设置分为「声音与音乐」「操作与辅助」「画面与性能」「数据与维护」，修改实时应用。首页采用四入口 2×2 排列；选关、记录及普通弹层使用分页，只有设置详情允许纵向滚动。Windows 联机沿用桌面的左右键按住瞄准、松开发射和键盘操作。

已通过 **439 项共用测试（41 个文件）、22 项 Android JVM 测试和 125 项 Windows 原生检查**。Android 16 实体机从 4.4.0 同签名覆盖成功，旧存档、首页演示、菜单与真实键盘编辑复测通过；320×568 浏览器完成四类页面共 200 次往返及按钮边界/命中检查。Windows 模式五个 CSS 视口检查通过，原生程序已启动并读到旧存档，但截图/输入几何接口受限，未完成原生视觉和完整 DPI 验收。本次手机没有可用局域网，未完成跨端对局；低性能机、字体放大、横屏重复压力及四实体网络范围见[验证记录](docs/releases/4.5.0-validation.md)。**本版保持 prerelease 测试版，尚不能宣称所有卡死反馈均已解决。**

Windows 旧版数据迁移入口现为「设置 → 数据与维护 → 导入旧 Windows 存档」。旧目录 `%APPDATA%/orbbound` 保留，新版数据位于 `%LOCALAPPDATA%/Orbbound`。迁移前关闭旧版，导入前会保留恢复备份；也可导出 JSON 备份用于换机。Android 沿用原签名，可直接覆盖安装保留数据。

## 开发与打包

### Windows USB 真机测试

手机开启 USB 调试、解锁并接入数据线后，在项目目录执行：

```powershell
.\run-android-device.bat
```

自动查找 SDK / ADB / JDK → 检测设备 → 构建网页并同步 Capacitor → 构建 Debug APK → `adb install -r` → 启动并检查前台 Activity 和进程 → 显示应用日志。详细说明和故障处理见 [Android 真机测试](docs/android-device-testing.md)。

```powershell
.\run-android-device.bat -Serial 手机序列号  # 多设备时必须明确指定
.\run-android-device.bat -BuildOnly        # 没有手机也能构建 APK
.\run-android-device.bat -NoLogStream      # 安装验证后退出
.\run-android-device.bat -LogsOnly         # 不构建、不安装，只看当前应用日志
```

Debug APK 位于 `android/app/build/outputs/apk/debug/app-debug.apk`。覆盖安装保留数据；如已安装正式签名版本导致签名冲突，脚本会停止，不会卸载或清数据。

```powershell
npm ci
npm run dev
npm test
npm run package:android
npm run package:win
```

Android 打包需配置 JDK 21 与 Android SDK；签名仍在仓库外的 `%LOCALAPPDATA%/Orbbound/signing`。Windows 运行目录必须完整保留，不能只复制 EXE。

两个打包命令只生成本地文件，不上传。版本号以 `package.json` 为准，与 `electron/windows-package.json`、`windows/app.manifest`、`android/app/build.gradle` 保持一致。Windows 使用系统 .NET Framework C# 编译器；首次构建下载并校验 WebView2 SDK 到忽略目录 `.build/webview2-sdk/`，仅将接口 DLL 和加载器打包，不下载或打包运行环境。

## 导航

- [目录与平台边界](docs/目录说明.md)
- [完整历史版本说明](docs/releases/版本历史.md)
- [Android 各版本说明](docs/releases/Android/)
- [Windows 各版本说明](docs/releases/Windows/)
- [本地交付文件索引与校验值](最终交付/版本索引.md)
- [最初设计方案](docs/design/Snood现代化重构方案.md)

3.2.0：Windows 调整局内布局、增加可配置快捷键并修复进场音频延迟；Android 增加棋盘按住瞄准、松手发射的沉浸模式。[Windows 说明](docs/releases/Windows/windows-3.2.0-notes.md) · [Android 说明](docs/releases/Android/android-3.2.0-notes.md) · [验证记录](docs/releases/3.2.0-validation.md)。

Android 3.4.0：修正首页球组排列、稍加快动画，普通模式与沉浸模式统一下一球布局。[更新说明](docs/releases/Android/android-3.4.0-notes.md)。
