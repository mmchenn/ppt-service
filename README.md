# PPT 智能生成服务 · 桌面版

把 Kimi + AgentPPT 自动生成 PPT 的工作流程打包成一个小软件。

客户网页表单 → Kimi AgentPPT 自动生成 → 下载到本地 → 邮件发送客户

## 两种使用方式

### 🅰 浏览器版（推荐，最稳定）

```bash
cd C:\Users\Administrator\ppt-service
node server.mjs
```

打开浏览器访问 **http://localhost:3456** 即可使用完整控制台。

**静默后台运行（关掉终端窗口也不影响）**：
- 双击 `start-silent.vbs` — **完全不弹窗口**
- 双击 `start-backend.bat` — 弹窗但不影响服务

**关闭服务**：双击 `stop-backend.bat`

### 🅱 Electron 桌面版（有系统托盘）

```bash
npm start
```

弹出桌面窗口，右下角有托盘图标。关掉窗口不会退出，后台继续运行。

**打包成独立 exe：**
```bash
npm run pack
```
输出在 `release/PPT智能生成-1.0.0.exe`

## 控制台功能

| 面板 | 功能 |
|---|---|
| 📊 控制台 | 状态查看（服务器/CDP/Edge）、环境检查、一键启动 Edge |
| 📋 新建订单 | 填写客户需求 + 上传附件 → 一键提交到 Kimi 自动生成 |
| 📜 运行日志 | SSE 实时推送的彩色日志 |
| ⚙️ 设置 | 端口、下载目录、SMTP 邮件配置 |

## 前置条件

1. **Edge 浏览器** 以远程调试模式启动：
   ```
   "C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe" --remote-debugging-port=9222
   ```
   或者在控制台点"🚀 启动 Edge"按钮自动启动。

2. **Kimi Slides** 已打开并登录：
   `https://www.kimi.com/slides`

## 架构

```
浏览器打开 http://localhost:3456
    ↓（同源 fetch / SSE）
server.mjs（全能后端）
    ├─ 托管 Web UI (dashboard.html)
    ├─ REST API (/api/status, /api/settings, /api/cdp/run...)
    ├─ SSE 实时日志 (/api/logs/stream)
    ├─ 文件上传接收 (/api/submit)
    └─ 调用 kimi-cdp.mjs
         └─ Edge CDP → Kimi AgentPPT → 下载 → 发邮件
```

## 关键改进

- **不再是终端黑框** — 浏览器访问，关掉浏览器服务仍在
- **崩溃自愈** — 服务器挂了自动重启（2s→4s→6s 递增等待）
- **静默启动** — VBS 脚本完全不弹窗口，适合开机自启
- **Electron 变可选** — 不装 Electron 也能用
