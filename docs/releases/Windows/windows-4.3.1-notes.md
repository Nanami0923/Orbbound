# Windows 4.3.1（测试版）

新增按网络接口绑定的房间检索、可取消扫描、按地址检索与快捷填入；新增连锁对战、权威消除/掉落/下压动画，以及随自己的棋盘接近底线而加速的 BGM。沿用鼠标、键盘与自定义快捷键。

完整解压后运行 `Orbbound/Orbbound.exe`；使用 .NET Framework 4.8 与共享 WebView2 Runtime。联机双方须更新到兼容的 v2 协议版本，默认 TCP 42171 / UDP 42170，端口冲突时使用界面实际地址。

125 项原生检查通过；生产网络服务与真实 Android 测试包互换房主，指定地址查询各成功 10 轮并完成最大 64 KiB 消息往返。当前 Wi-Fi 广播无应答，完整 EXE 界面对局及更多网络矩阵仍待验证。

[完整更新说明](https://github.com/Nanami0923/Orbbound/blob/v4.3.1/docs/releases/4.3.1-notes.md) · [验证记录](https://github.com/Nanami0923/Orbbound/blob/v4.3.1/docs/releases/4.3.1-validation.md)
