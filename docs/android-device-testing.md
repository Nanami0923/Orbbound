# Windows Android 真机测试

## 入口与构建

在项目根目录运行 `.\run-android-device.bat`。也可以在资源管理器中双击；推荐终端执行，以便错误输出保留。

项目使用 Vite / TypeScript + Capacitor 8；脚本调用 `npm run sync:android`，然后使用项目的 Gradle Wrapper 执行 `assembleDebug`。首次获取项目先执行 `npm ci`。不调用正式版签名流程。

构建要求：JDK 21、Gradle 8.14.3（Wrapper 自动获取）、Android Gradle Plugin 8.13.0、Android SDK Platform 36。当前 Gradle 默认选择 Build Tools 35.0.0，仓库正式打包流程另用 36.0.0；本机两者均已安装。当前项目无需单独安装 NDK。

脚本从环境变量 `ANDROID_HOME` / `ANDROID_SDK_ROOT`、`android/local.properties`、Android Studio 常见 SDK 目录查找 SDK；从 `JAVA_HOME`、Android Studio JBR、常见 JDK 安装目录和 PATH 查找 JDK。ADB 支持 `ADB` 环境变量指定完整文件路径，再检查 SDK platform-tools、PATH，以及已有 MuMu 安装目录。不修改全局环境变量，不依赖特定用户名。构建时只更新被 Git 忽略的 `android/local.properties` 中 SDK 路径，保留其他键。

APK 路径读取 Gradle 的 `output-metadata.json`，随后使用 SDK `aapt dump badging` 读取 APK 最终包名和启动 Activity，避免依赖猜测。当前输出为 `android/app/build/outputs/apk/debug/app-debug.apk`，包名 `com.orbbound.game`，Activity `com.orbbound.game.MainActivity`。脚本针对当前单一 debug 变体；将来添加 flavors / split APK 时需扩展输出选择逻辑。

## 常用命令

```powershell
.\run-android-device.bat
.\run-android-device.bat -Serial 序列号
.\run-android-device.bat -BuildOnly
.\run-android-device.bat -NoLogStream
.\run-android-device.bat -LogsOnly
.\run-android-device.bat -LogsOnly -Serial 序列号
```

默认没有设备时返回非零状态并停止；`-BuildOnly` 可以无设备构建。连接多个设备时列出设备并要求 `-Serial`，不会自动选第一台；模拟器或无线连接需显式指定。明确指定后，其他设备的未授权或离线状态不影响所选设备。

安装仅使用 `adb install -r`，不执行 uninstall、pm clear 或降级。启动使用 `am start -W`，等待至少 5 秒，再同时检查进程仍存活、应用 Activity 已 resumed。手机锁屏或其他界面遮挡时可能验证失败，应解锁重试；这不等于必然崩溃。

## 日志与崩溃

日志保存在 `.build/android-device/时间戳-*.log`，不提交到 Git。日常输出使用应用 UID 过滤 main / system / crash 缓冲区，避免整个系统刷屏，且可覆盖应用自己的多个进程。默认测试模式会监测主进程退出，停止日志子进程并保存诊断信息；Ctrl+C 结束查看。`-LogsOnly` 持续跟随 UID 日志，不重新安装或启动。

- `*-app.log`：启动阶段应用日志及错误时快照。
- `*-live.log`：默认模式持续写入的应用日志。
- `*-crash.log`：启动失败、运行进程退出等错误时保存的本次时间窗口内完整 crash 缓冲区。Native 的 debuggerd/crash_dump 来自其他 UID，因此这个文件可能包含同期其他应用崩溃；请用包名、PID、时间核对归属，不直接认定全部属于当前应用。
- `*-logcat-error.log`：日志连接异常。

Java/Kotlin 重点看 `FATAL EXCEPTION`、异常类型、`Caused by` 与第一条项目栈帧。Native 看 `Fatal signal`、`Abort message` 和 `backtrace`；没有匹配版本的未剥离符号时不能还原完整源码行。WebView / JavaScript 看 `chromium`、`CONSOLE`、`Capacitor`、资源加载错误；独立沙箱渲染进程不一定包含在应用 UID 中。进程仍在但画面异常时，可通过桌面 Chrome 的 `chrome://inspect/#devices` 检查允许调试的 WebView；压缩 JS 的源码定位可能还需要 source map。脚本不会为此修改业务代码或启用生产调试配置。

## 故障处理

- `unauthorized`：解锁手机，确认“允许 USB 调试”，必要时撤销 USB 调试授权再重连。
- `offline`：重插数据线、重开 USB 调试；用脚本打印的 ADB 完整路径执行 `kill-server` 后重试。
- 没有设备：确认数据线支持传输、USB 调试已开启；必要时安装手机厂商的 Windows USB 驱动。
- `INSTALL_FAILED_UPDATE_INCOMPATIBLE`：现有正式 APK 和默认 Debug APK 的签名不同。必须使用与已安装应用相同的签名构建，才能保留数据覆盖；脚本不会自动卸载。
- `INSTALL_FAILED_VERSION_DOWNGRADE`：需要调整项目 versionCode 或安装更高版本；不自动强制降级。
- 构建失败：查看最先出现的 TypeScript / Gradle 错误；网络下载失败时检查网络，缺 SDK 组件时用 SDK Manager 补齐。构建失败不会继续安装旧 APK。

Android 工具来源：[官方 Android 下载页](https://developer.android.com/studio)。

## 本次验证（2026-09-14）

找到并实际调用了既有 MuMu ADB 36.0.0；设备列表为空。原 `local.properties` 指向已不存在的 SDK。本次将官方命令行工具及 Platform 36、Build Tools 36.0.0 安装至 `%LOCALAPPDATA%/Android/Sdk`，下载包 SHA-256 与官方一致。Gradle 构建又自动补齐默认 Build Tools 35.0.0 和 Platform-Tools 37.0.1；脚本此后优先使用该标准 SDK 中的 ADB。使用已有 JDK 21，无需另装 Java。

`-BuildOnly` 实测构建成功：版本 3.0.0 / versionCode 30000，APK 4,577,623 字节；通过实际 APK 确认包名和启动 Activity。默认入口已实测执行到设备检测并明确报告无设备；安装、启动、手机上的日志过滤及崩溃捕获尚未实机验证。
