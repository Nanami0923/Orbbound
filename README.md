# Orbbound

本地目录已按源码、文档、平台交付整理。当前 Android 为 **3.0.0**，Windows 为 **1.7.0**，两个平台独立编号。

## 交付位置

| 平台 | 最新版本 | 交付目录 | 主要文件 |
| --- | --- | --- | --- |
| Android | 3.0.0 | [Android 交付目录](最终交付/Android/Orbbound-3.0.0/) | APK、SHA-256、更新说明 |
| Windows | 1.7.0 | [Windows 交付目录](最终交付/Windows/Orbbound-Windows-1.7.0/) | 单文件便携 EXE、7z、SHA-256、完整 win-unpacked 运行目录 |

所有旧版本保留在对应平台目录内。Windows 1.0.0 的两个不同本地构建按原来源分别保存，不将其视作同一文件。

下载：[Windows 1.7.0 单文件 EXE](https://github.com/Nanami0923/Orbbound/releases/download/windows-v1.7.0/Orbbound-Windows-1.7.0-Portable-x64.exe) · [完整游戏目录 7z](https://github.com/Nanami0923/Orbbound/releases/download/windows-v1.7.0/Orbbound-Windows-1.7.0-x64.7z)

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

两个打包命令只生成本地文件，不上传。Windows 版本号读取 `electron/windows-package.json`，Android 版本号读取 `package.json`，并须与 `android/app/build.gradle` 一致；正式发布前应分别更新对应平台的版本信息。

## 导航

- [目录与平台边界](docs/目录说明.md)
- [完整历史版本说明](docs/releases/版本历史.md)
- [Android 各版本说明](docs/releases/Android/)
- [Windows 各版本说明](docs/releases/Windows/)
- [本地交付文件索引与校验值](最终交付/版本索引.md)
- [最初设计方案](docs/design/Snood现代化重构方案.md)

Windows 1.7.0 修复限时触底后重开，统一原版 BGM 并随棋盘高度加速，同步分级设置与音频修复，继续使用鼠标 / 键盘操作。[更新说明](docs/releases/Windows/windows-1.7.0-notes.md)。

单 EXE 为自解压便携程序，无需安装或联网；运行时使用临时目录，退出后清理。存档仍在 `%APPDATA%/orbbound`，不会因临时目录清理而删除。

Android 2.8.0：[APK 下载](https://github.com/Nanami0923/Orbbound/releases/download/v2.8.0/Orbbound-2.8.0-Android.apk) · [更新说明](docs/releases/Android/android-2.8.0-notes.md)。

Android 3.0.0：手机首页与操作区重构、原生系统安全区域、连续音乐和音效淡出修复。[本地 APK](最终交付/Android/Orbbound-3.0.0/Orbbound-3.0.0-Android.apk) · [更新与验证说明](docs/releases/Android/android-3.0.0-notes.md)。
