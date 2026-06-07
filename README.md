# PPT Service — 全自动生成系统

**客户网页表单 → Kimi AgentPPT 生成 → 自动导出下载 → QQ 邮件发送客户**

项目地址: https://github.com/mmchenn/ppt-service
在线表单: https://ppt-service.pages.dev/

---

## 系统架构

```
┌──────────────┐     ┌──────────────────┐     ┌──────────────────┐
│  客户提交表单  │ ──▶ │  Cloudflare Worker │ ──▶ │ 本地 Webhook 服务 │
│ ppt-service   │     │ (functions/api/   │     │ (server.mjs)     │
│ .pages.dev    │     │  submit.js)       │     │ port 3456        │
└──────────────┘     └──────────────────┘     └────────┬─────────┘
                                                        │
                                                        ▼
┌──────────────┐     ┌──────────────────┐     ┌──────────────────┐
│  QQ 邮件发送   │ ◀── │  PPT 下载到本地   │ ◀── │ CDP 操作 Edge    │
│  (带附件)     │     │  M:/资料/        │     │ (kimi-cdp.mjs)   │
└──────────────┘     └──────────────────┘     └──────────────────┘
                                                        │
                                                        ▼
                                               ┌──────────────────┐
                                               │  Kimi AgentPPT   │
                                               │  www.kimi.com/   │
                                               │  slides          │
                                               └──────────────────┘
```

## 核心流程

```
1. 客户在 https://ppt-service.pages.dev/ 填写需求
   → 自动提交到 Cloudflare Worker 保存

2. Worker 转发到本地 Webhook (server.mjs)

3. CDP 自动化 (kimi-cdp.mjs) 操作 Edge 浏览器:
   a. 打开 Kimi Slides 页面
   b. 选择模式（智能布局 / 经典模板）
   c. 输入提示词 → 点击发送
   d. 等待生成完成（检测预览卡片）
   e. 点击卡片进入编辑器
   f. 点击"导出"按钮
   g. 点击"直接下载"
   h. PPT 保存到 M:\资料\

4. 通过 QQ 邮箱 SMTP 发送邮件给客户（含 PPTX 附件）
```

---

## 文件说明

| 文件 | 作用 |
|------|------|
| [index.html](index.html) | 前端落地页，客户填写 PPT 需求表单 |
| [functions/api/submit.js](functions/api/submit.js) | Cloudflare Worker，接收+存储表单数据 |
| [kimi-cdp.mjs](kimi-cdp.mjs) | **核心** — CDP 浏览器自动化脚本 |
| [server.mjs](server.mjs) | 本地 Webhook 中转服务 |
| [test-connection.mjs](test-connection.mjs) | 环境检测工具 |
| [.env](.env) | 配置文件（SMTP 密码 + API Key） |
| [启动Kimi自动化.bat](启动Kimi自动化.bat) | 桌面快捷方式（在桌面上） |
| [PPT全自动流程.bat](PPT全自动流程.bat) | 桌面快捷方式（在桌面上） |

---

## 电脑环境要求

| 项目 | 要求 |
|------|------|
| 操作系统 | Windows 10 / 11 |
| Node.js | v18+（推荐 v22+） |
| 浏览器 | Microsoft Edge（最新版） |
| NPM | 随 Node.js 自带 |

### 依赖安装

```powershell
cd C:\Users\Administrator\ppt-service
npm install
```

会自动安装: `chrome-remote-interface`、`nodemailer`、`ws`

---

## 使用方法

### 第一步：启动 Edge（调试模式）

**方式 A：双击桌面快捷方式** `启动Kimi自动化.bat`

**方式 B：手动运行**
```powershell
taskkill /F /IM msedge.exe
"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe" ^
  --remote-debugging-port=9222 ^
  --user-data-dir="C:\Users\Administrator\.claude-edge-debug" ^
  https://www.kimi.com/slides
```

### 第二步：在 Edge 中操作

1. 打开 https://www.kimi.com/slides
2. 登录 Kimi（如未登录）
3. 输入你需要的 PPT 提示词
4. 选择模式（经典模板/智能布局）
5. 点击发送，等待生成完成（出现预览卡片）

### 第三步：运行自动化脚本

```powershell
cd C:\Users\Administrator\ppt-service
node kimi-cdp.mjs --prompt "2026年人工智能发展趋势PPT" --mode "经典模板" --email "客户邮箱@qq.com" --customer "客户称呼"
```

脚本会自动：
- 检测到预览卡片 → 进入编辑器
- 点击导出 → 点击直接下载
- PPT 保存到 M:\资料\
- 自动发邮件给客户（带 PPTX 附件）

---

## 邮件配置

### QQ 邮箱 SMTP

1. 登录 https://mail.qq.com
2. 设置 → 账户 → 生成授权码
3. 将授权码填入 [.env](.env)：
```
SMTP_USER=934409302@qq.com
SMTP_PASS=你的授权码
```

### 管理员邮箱

在 [.env](.env) 中设置：
```
ADMIN_EMAIL=你的邮箱@qq.com
```
所有客户邮件会自动抄送管理员。

---

## 配置文件（.env）

```env
RESEND_API_KEY=re_xxxxxxxx         # Resend 备用发信（可不填）
ADMIN_EMAIL=admin@example.com       # 管理员通知邮箱
DOWNLOAD_DIR=M:/资料                 # PPT 下载路径
SMTP_HOST=smtp.qq.com               # SMTP 服务器
SMTP_PORT=465                       # SMTP 端口
SMTP_USER=934409302@qq.com          # QQ 邮箱账号
SMTP_PASS=xxxxxxxxxxxxxx            # QQ 邮箱授权码
```

---

## 命令行参数

```powershell
node kimi-cdp.mjs [参数]

--prompt "提示词"       必填，PPT 内容描述
--mode "智能布局|经典模板"   可选，默认智能布局
--email "客户邮箱"       可选，自动发邮件
--customer "客户称呼"    可选，邮件中的称呼
--files "附件路径"       可选，逗号分隔
```

---

## npm 快捷命令

```powershell
npm run check    # 环境检测（Edge 是否在线）
npm run cdp      # CDP 自动化（交互式）
npm run webhook  # 启动 Webhook 服务
npm start        # 启动 Webhook 服务
```

---

## 开发相关

- Cloudflare Pages: https://ppt-service.pages.dev/
- GitHub 仓库: https://github.com/mmchenn/ppt-service
- Kimi Slides: https://www.kimi.com/slides
- Edge 调试端口: 9222
