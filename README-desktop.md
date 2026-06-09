# PPT Service — 桌面整合版

将整个工作流程打包成一个 **Electron 桌面小软件**，一键启动所有服务。

## 功能

- 📊 **控制台** — 服务状态监控、CDP 连接检测、一键启停
- 📋 **新建订单** — 内置表单 + 文件上传，直接提交到 Kimi 自动生成
- 📜 **运行日志** — 完整实时日志，带颜色分类
- ⚙️ **设置** — 端口、下载目录、SMTP 邮件配置
- 🖥️ **系统托盘** — 最小化到托盘，后台运行

## 启动方式

### 开发模式
```bash
cd C:\Users\Administrator\ppt-service
npx electron electron.mjs
```

### 打包为独立 exe
```bash
npx electron-builder build --win portable
```
输出在 `release/` 目录，单个 exe 文件，无需安装。

## 前置条件

1. **Edge 浏览器** 以远程调试模式启动：
   ```
   "C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe" --remote-debugging-port=9222
   ```

2. **Kimi Slides** 页面已打开并登录：
   `https://www.kimi.com/slides`

3. **node_modules** 已安装：
   ```bash
   npm install
   ```

## 目录结构

```
ppt-service/
├── electron.mjs        # Electron 主进程（窗口、托盘、子进程管理）
├── preload.mjs          # IPC 安全桥接
├── dashboard.html       # 暗色仪表盘 UI
├── server.mjs           # HTTP 服务器（接收表单+附件）
├── kimi-cdp.mjs         # CDP 自动化脚本
├── index.html           # 独立前端页面（可选，用于部署到 Pages）
├── start-desktop.bat    # 一键启动脚本
├── package.json         # 依赖 + electron-builder 打包配置
├── assets/icon.svg      # 应用图标
└── settings.json        # 持久化设置（自动生成）
```

## 工作流程

```
表单填写 → 控制台"提交订单"
    ↓
本地服务器 server.mjs（:3456）
    ↓ 保存附件 + 构造提示词
kimi-cdp.mjs（CDP 自动化）
    ↓ 输入提示词 → 上传文件 → 选模式 → 发送 → 等待生成 → 下载 → 发邮件
    ↓
成品 PPT 到下载目录 + 客户邮箱
```
