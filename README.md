# Orbbound

Android 与 Windows 最新测试版均为 **4.7.0**，稳定正式版保留 **4.3.0**。本次修正首页演示落点，统一结算与菜单关闭返回、标题和按钮居中、四模式下一球预览，并重排联机顶部信息。补充终局记录幂等与保存失败保护，保留单机模式、30 个高难度关卡、2–4 人局域网联机与旧存档。

## 交付位置

| 平台 | 最新版本 | 交付目录 | 主要文件 |
| --- | --- | --- | --- |
| Android | 4.7.0 测试版 | [Android 交付目录](最终交付/Android/Orbbound-4.7.0/) | APK、SHA-256、更新说明 |
| Windows | 4.7.0 测试版 | [Windows 交付目录](最终交付/Windows/Orbbound-Windows-4.7.0/) | 轻量 ZIP、SHA-256、完整 Orbbound 运行目录 |

所有旧版本保留在对应平台目录内。Windows 1.0.0 的两个不同本地构建按原来源分别保存，不将其视作同一文件。

测试版下载：[Windows 4.7.0 ZIP](https://github.com/Nanami0923/Orbbound/releases/download/v4.7.0/Orbbound-Windows-4.7.0-x64.zip) · [Android 4.7.0 APK](https://github.com/Nanami0923/Orbbound/releases/download/v4.7.0/Orbbound-4.7.0-Android.apk) · [4.7.0 发布入口](https://github.com/Nanami0923/Orbbound/releases/tag/v4.7.0)。[4.3.0 稳定正式版](https://github.com/Nanami0923/Orbbound/releases/tag/v4.3.0)继续保留。

[4.7.0 更新说明](docs/releases/4.7.0-notes.md) · [验证记录](docs/releases/4.7.0-validation.md) · [本次实施方案](docs/design/4.7.0界面排版与关闭返回逻辑更新方案.md)

Windows 请完整解压 ZIP 后运行 `Orbbound/Orbbound.exe`。轻量包不包含运行环境，使用本机 .NET Framework 4.8 和共享 WebView2 Evergreen Runtime；具备环境后可离线游玩。缺少 WebView2 时程序提供[微软官方补装入口](https://developer.microsoft.com/en-us/microsoft-edge/webview2#download-section)，本次发布不上传环境安装包。

联机时连接同一路由器或可互通热点，在首页选择「局域网联机」。房间容量可选 2 / 3 / 4，至少两人且全员准备即可开局；同图竞分和连锁对战均支持四人。**4.7.0 沿用 4.6.0 的消息封装 v3、规则指纹 `4e2a4139` 和内容指纹 `f942c2f9`**；同机生产 C# 服务搭配真实游戏会话的 4.6 / 4.7 双向混连已通过，实体终端范围见验证记录。不能与 4.5.0 等旧规则版本混连。大厅首屏显示实际 `IPv4:端口` 和复制按钮；加入默认展开地址输入，直连不等待广播扫描，附近、最近与诊断入口继续保留。Windows 防火墙需允许应用在专用网络通信；手动地址不能绕过网络隔离。普通网页预览不提供原生联网。

局内「暂停 / 设置」不限成功次数，并取消整局累计 120 秒预算；同一选手的两个入口共用 15 秒申请冷却。成功申请的冷却从实际恢复比赛起算，拒绝、取消或投票过期从结果确定起算。其他在赛选手须在最多 10 秒内全员同意，单次暂停仍最多 60 秒；设置关闭确认、全员准备和倒计时恢复继续保留。

双端延续默认 **60 FPS**，保留手动 **30 / 60 / 90 / 120**；已有合法手动值继续保留，自动画质独立存在。联机保留连续展示时钟、球素材/静态棋盘/消除过渡缓存和按玩家状态更新。主图和观察主视图按所选目标调度，对手小图最多约 20 FPS，静止画面按需绘制。展示时间不改变权威计时、发射门槛或比赛结果；默认 60 不代表所有设备和负载下必然达到 60 FPS。

首页左侧演示球落到两球中间并同时相切。单机结果页的顶部关闭、底部首页、Esc、Android 返回和允许的遮罩关闭统一回首页；菜单设置/历史、关卡详情等按来源返回父页。首次成功终局记录保持结束时间与结果不变；保存失败时保留可恢复副本、提供重试并显示真实保存状态，已结算的旧检查点不能重新续玩。

标题与按钮使用对称空间居中，联机和三种单机共用同平台、同布局档位的下一球组件，并保持飞行、装填和观战阶段的颜色正确。联机时间、延迟、状态与操作分组，对手区按人数和屏幕布局调整。设置仍分四类并实时应用，普通弹层分页、设置详情单滚动，桌面联机保留鼠标与键盘操作。

**本版保持 prerelease 测试版。** 当前 52 个文件、574 项共用测试通过，包含导航、演示几何、预览阶段与模拟存储失败回归。构建、签名、浏览器、原生和实体设备的最终验收范围见[4.7.0 验证记录](docs/releases/4.7.0-validation.md)。低性能设备、完整 Windows DPI、四台独立实体终端及长时升温矩阵尚未完整验收；不将同机服务驱动或自动测试等同于完整真机通过。

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
