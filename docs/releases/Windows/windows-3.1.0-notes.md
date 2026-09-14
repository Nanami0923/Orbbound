# Windows 3.1.0

- 修复启动时短暂闪现旧首页：删除旧首页内容，统一深色启动背景，首页准备好再显示。首次进入对局显示加载状态，准备完成后才显示棋盘。
- 「设置 → 声音 → 局内音乐加速」可选择是否随棋盘压力加速；默认开启，关闭后保持原速，设置重启保留。
- 游戏引擎按需加载，首页不执行 Phaser；设置和记录优先响应。缓存记录解析、排序与日期格式器，移除模态窗口高成本背景模糊。
- 改为 .NET Framework 4.8 + 共享 WebView2 Evergreen 外壳。ZIP 621,614 字节，完整游戏目录 2,576,785 字节；不携带 Electron、Chromium、WebView2 或 .NET 运行环境。
- 增加旧版存档迁移、JSON 导入导出与导入前恢复备份；导入校验格式、版本和数据范围，存储写入失败显示反馈。
- 保存窗口位置、大小与最大化状态，恢复时约束到显示器工作区；保留单实例、F11 全屏、鼠标和键盘操作。小窗口及高缩放下保持桌面分栏。

## 下载与升级

[下载 ZIP](https://github.com/Nanami0923/Orbbound/releases/download/v3.1.0/Orbbound-Windows-3.1.0-x64.zip)。完整解压后运行 `Orbbound/Orbbound.exe`，不能只复制 EXE。发布不附带环境安装包；缺少 WebView2 时可通过程序提示打开[微软官方安装页面](https://developer.microsoft.com/en-us/microsoft-edge/webview2#download-section)。已具备环境时无需联网运行游戏。

从 3.0.0 升级：关闭旧版，在「设置 → 存档备份与迁移 → 导入旧版存档」确认导入。默认读取 `%APPDATA%/orbbound`，未找到时可选目录；原目录保持不变。新版数据在 `%LOCALAPPDATA%/Orbbound`，迁移副本与恢复文件保存在其中的 `MigrationBackups`。本地存储还保留最近一次导入前的 `orbbound-backup-before-import` 快照；日常备份请使用「导出备份」。

本版为 x64；验证平台为当前 Windows 电脑与已安装的 WebView2。缺失环境分支使用测试开关验证，没有卸载系统环境。[详细验证](../3.1.0-validation.md)。
