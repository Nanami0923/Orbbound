# Windows 4.3.0

加入双人局域网「同图竞分」。Windows 可创建房间，也可加入 Android 或另一台 Windows 创建的房间；支持附近房间发现和手动输入 IPv4 地址与端口，双方均需使用 4.3.0。

房主选择简单 / 普通 / 困难，以及 3 / 5 分钟。双方准备后同时开始，在独立棋盘上从相同编号波次开局；清盘累计得分并进入下一波。到时先比分数、再比完成波次，仍相同则平局。触底保留得分并观看对手，后续球序会随各自操作变化。

新增联机等待室、双方分数、对手缩略棋盘和连接状态，保留鼠标、键盘与自定义快捷键。暂停需双方同意；最小化、锁屏或短时掉线进入冻结与恢复流程。恢复后双方确认再倒计时；主动离开需确认并按认输处理，非主动中断不计胜负。联机记录与单机排行、存档及闯关进度分开。

轻量 WebView2 外壳新增原生 TCP 传输与 UDP 房间发现。默认 TCP 42171 被占用时换用其他端口并显示实际地址；UDP 42170 不可用时可尝试手动加入。首次建房可能需要在可信专用网络允许游戏通信；访客网络隔离或热点限制仍可能阻止连接。

继续使用 .NET Framework 4.8 与系统共享 WebView2 Runtime，完整解压后运行 `Orbbound/Orbbound.exe`；不附带运行环境安装包。4.3.0 不包含公网匹配、房主迁移、进程重启后续局、连锁对战或协作接力。

本次包含 Java / C# 两种房主方向的桌面真实 TCP 回环互通测试；不同实体电脑、Android 真机、热点及实际防火墙环境仍需实测。本次自动测试不能视作 Windows ↔ Android 真机验收。

[完整更新说明](https://github.com/Nanami0923/Orbbound/blob/v4.3.0/docs/releases/4.3.0-notes.md) · [验证记录](https://github.com/Nanami0923/Orbbound/blob/v4.3.0/docs/releases/4.3.0-validation.md) · [联机设计方案](https://github.com/Nanami0923/Orbbound/blob/v4.3.0/docs/design/%E5%8F%8C%E7%AB%AF%E5%B1%80%E5%9F%9F%E7%BD%91%E8%81%94%E6%9C%BA%E7%8E%A9%E6%B3%95%E4%B8%8E%E5%AE%9E%E7%8E%B0%E6%96%B9%E6%A1%88.md)。
