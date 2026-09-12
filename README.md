# Orbbound

本地目录已按源码、文档、平台交付整理。当前 Android 为 **2.3.0**，Windows 为 **1.5.0**，两个平台独立编号。

## 交付位置

| 平台 | 最新版本 | 交付目录 | 主要文件 |
| --- | --- | --- | --- |
| Android | 2.3.0 | [Android 交付目录](最终交付/Android/Orbbound-2.3.0/) | APK、SHA-256、更新说明 |
| Windows | 1.5.0 | [Windows 交付目录](最终交付/Windows/Orbbound-Windows-1.5.0/) | 单文件便携 EXE、7z、SHA-256、完整 win-unpacked 运行目录 |

所有旧版本保留在对应平台目录内。Windows 1.0.0 的两个不同本地构建按原来源分别保存，不将其视作同一文件。

下载：[Windows 1.5.0 单文件 EXE](https://github.com/Nanami0923/Orbbound/releases/download/windows-v1.5.0/Orbbound-Windows-1.5.0-Portable-x64.exe) · [完整游戏目录 7z](https://github.com/Nanami0923/Orbbound/releases/download/windows-v1.5.0/Orbbound-Windows-1.5.0-x64.7z)

## 开发与打包

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

Windows 1.5.0 调换当前球与下一球提示位置，移除桌面转向按钮，保留鼠标 / 键盘操作和已有模式、存档及排行榜功能。[Windows 1.5.0 更新说明](docs/releases/Windows/windows-1.5.0-notes.md)。

单 EXE 为自解压便携程序，无需安装或联网；运行时使用临时目录，退出后清理。存档仍在 `%APPDATA%/orbbound`，不会因临时目录清理而删除。
