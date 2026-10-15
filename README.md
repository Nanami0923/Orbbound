# Orbbound

本地目录已按源码、文档、平台交付整理。Android 与 Windows 最新测试版均为 **4.3.1**，正式版保留 **4.3.0**。本次改善局域网检索、增加快捷填入与「连锁对战」，补齐联机动画及危险 BGM 加速。保留同图竞分、单机模式、30 个高难度关卡与旧存档。

## 交付位置

| 平台 | 最新版本 | 交付目录 | 主要文件 |
| --- | --- | --- | --- |
| Android | 4.3.1 测试版 | [Android 交付目录](最终交付/Android/Orbbound-4.3.1/) | APK、SHA-256、更新说明 |
| Windows | 4.3.1 测试版 | [Windows 交付目录](最终交付/Windows/Orbbound-Windows-4.3.1/) | 轻量 ZIP、SHA-256、完整 Orbbound 运行目录 |

所有旧版本保留在对应平台目录内。Windows 1.0.0 的两个不同本地构建按原来源分别保存，不将其视作同一文件。

测试版下载：[Windows 4.3.1 ZIP](https://github.com/Nanami0923/Orbbound/releases/download/v4.3.1/Orbbound-Windows-4.3.1-x64.zip) · [Android 4.3.1 APK](https://github.com/Nanami0923/Orbbound/releases/download/v4.3.1/Orbbound-4.3.1-Android.apk) · [4.3.1 发布页](https://github.com/Nanami0923/Orbbound/releases/tag/v4.3.1)。[4.3.0 正式版](https://github.com/Nanami0923/Orbbound/releases/tag/v4.3.0)仍可下载。

[4.3.1 更新说明](docs/releases/4.3.1-notes.md) · [验证记录](docs/releases/4.3.1-validation.md) · [本次实现方案](docs/design/4.3.0双端联机检索优化与对战模式更新方案.md)

Windows 请完整解压 ZIP 后运行 `Orbbound/Orbbound.exe`。轻量包不包含运行环境，使用本机 .NET Framework 4.8 和共享 WebView2 Evergreen Runtime；具备环境后可离线游玩。缺少 WebView2 时程序提供[微软官方补装入口](https://developer.microsoft.com/en-us/microsoft-edge/webview2#download-section)，本次发布不上传环境安装包。

本版联机需双方安装 4.3.1 并连接同一路由器或可互通热点，在首页选择「局域网联机」。扫描 8 秒后可在房间卡片「填入地址」或「加入」；找不到时输入房主 IPv4 并选择「按地址检索」，也可直接输入完整地址与端口。Windows 防火墙需允许应用在专用网络通信；手动地址不能绕过网络隔离。普通网页预览不提供原生联网。

已通过 313 项共用测试、22 项 Android JVM 测试和 125 项 Windows 原生检查。真实 Android 与 Windows 服务互换房主，指定地址检索共 20 轮及 TCP 互通通过；当前 Wi-Fi 的纯广播查询未收到应答。完整 APK/EXE 界面对局、热点矩阵与实际听测仍待完成，因此先发布测试版，范围详见验证记录。

Windows 从 3.0.0 升级后，在「设置 → 存档备份与迁移 → 导入旧版存档」读取旧数据。旧目录 `%APPDATA%/orbbound` 保留，新版数据位于 `%LOCALAPPDATA%/Orbbound`。迁移前关闭旧版，导入前会保留恢复备份；也可导出 JSON 备份用于换机。Android 沿用原签名，可直接覆盖安装保留数据。

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
