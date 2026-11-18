# SlimSSH

SlimSSH 是一个面向 Windows 的 SSH 终端客户端，使用 Tauri、React、TypeScript 和 Rust 构建。

## 功能

- 保存连接配置，按连接名或 IP 搜索
- 密码与私钥认证，同一连接可打开多个会话
- 标签拖动排序，左右分屏，多会话切换
- 日志语义高亮、时间戳和行号
- 深色与浅色主题，可调整终端、行号和标签字体大小
- Ctrl+V 和右键粘贴
- SFTP 文件上传、下载及文本预览，支持拖放本地文件上传
- 可选 X11 转发，在 Windows 上显示远程图形应用

## 本地开发

准备 Windows、Node.js 22 或更新版本、npm、Rust 1.95 或更新版本，以及 Visual Studio 2022 Build Tools 的“使用 C++ 的桌面开发”和 Windows SDK。运行桌面应用需要 WebView2 Runtime。

安装依赖并启动开发窗口。

```powershell
npm ci
npm run dev:tauri
```

## 验证与构建

```powershell
npm test
npm run build
npm run build:tauri -- --no-bundle --ci -- --locked
```

可执行文件位于 `src-tauri/target/release/slimssh.exe`。

如需使用项目提供的安装脚本，先安装 NSIS，然后在 `installer` 目录运行以下命令。

```powershell
makensis slimssh.nsi
```

生成的安装包为 `installer/SlimSSH-Setup-0.1.0.exe`。也可以运行 `npm run build:tauri`，由 Tauri 生成安装包。

## 使用

创建连接后点击连接按钮。打开至少两个会话后可启用左右分屏，新会话默认在左侧新增标签。

在文件栏单击选中，双击进入文件夹或预览文本。右键文件可下载，上传按钮或拖放本地文件可上传普通文件。

X11 转发需要 Windows 安装 VcXsrv，并在远端 SSH 服务启用 X11 转发和安装 xauth。当前实现支持在本机启动 VcXsrv。

文本预览支持 UTF-8，最多显示前 64 KiB。文件夹传输尚未实现。

## 数据存储

连接配置和主机指纹保存在应用数据目录。Windows 下密码和私钥口令使用系统凭据管理器保存。请保管自己的连接配置和凭据。

## 许可证

项目代码采用 MIT 许可证，详见 [LICENSE](LICENSE)。第三方依赖遵循各自的许可证。
