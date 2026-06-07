# PPT Service — 测试指南（直连模式）

## 项目文件一览

| 文件 | 作用 |
|------|------|
| [index.html](index.html) | 前端页面，提交表单到 `http://localhost:3456/api/submit` |
| [functions/api/submit.js](functions/api/submit.js) | Cloudflare Worker（简化版，仅邮件通知） |
| [server.mjs](server.mjs) | **核心** — 本地 HTTP 服务: 接收表单 → 存文件 → 调 CDP |
| [kimi-cdp.mjs](kimi-cdp.mjs) | CDP 自动化: 输入原文 → 上传真实文件 → 发送 → 等待 → 下载 |
| [test-connection.mjs](test-connection.mjs) | 只读连接测试 |

---

## 架构（最简版）

```
用户浏览器 → http://localhost:3456/api/submit (FormData + 文件)
                ↓
         本机 server.mjs
            → 保存附件到临时目录
            → 构造提示词（原文原样）
            → 调 CDP: insertText + DOM.setFileInputFiles
            → 返回成功给浏览器
```

**不需要 Cloudflare R2，不需要轮询，不需要 POLL_SECRET。**

---

## 前置条件

1. **Edge 浏览器已启动并开启调试端口 9222**
   ```
   "C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe" ^
     --remote-debugging-port=9222 ^
     --user-data-dir="C:\Users\Administrator\.claude-edge-debug"
   ```
   确认方法: `curl http://localhost:9222/json/version` 返回 JSON

2. **Kimi 已登录** — 在 Edge 中打开 `https://www.kimi.com/slides` 并确认已登录

3. **Node.js 依赖已安装**
   ```
   cd C:\Users\Administrator\ppt-service
   npm install
   ```

---

## 快速测试步骤

### 第 1 步：启动本地服务

```powershell
cd C:\Users\Administrator\ppt-service
node server.mjs
```

预期输出：
```
PPT Service — 本地直收模式
监听端口: 3456
接收地址: http://localhost:3456/api/submit
服务已启动: http://localhost:3456
```

### 第 2 步：用 curl 模拟提交（先不打开浏览器）

```powershell
# 创建测试文件
echo "市场数据：2026年Q1营收增长15%" > "%TEMP%/市场数据.txt"

# 模拟表单提交
curl -X POST http://localhost:3456/api/submit ^
  -F "name=张三" ^
  -F "email=test@example.com" ^
  -F "topic=2026年市场分析报告" ^
  -F "pages=15" ^
  -F "deadline=2026-06-15" ^
  -F "style=商务简约" ^
  -F "notes=目标受众：公司高管，重点分析市场趋势" ^
  -F "attachments=@%TEMP%/市场数据.txt"
```

**预期效果：**
- server.mjs 日志显示接收并保存附件
- CDP 自动填入提示词 + 上传文件到 Kimi
- Kimi 页面出现文件列表并开始生成

### 第 3 步：打开网页提交

确保 server.mjs 在运行，然后打开 `https://ppt-service.pages.dev/`，填表上传文件提交。

或者你也可以直接打开本地 HTML 文件：
```
file:///C:/Users/Administrator/ppt-service/index.html
```

**注意：** 因为浏览器安全策略，`http://localhost` 是允许跨域请求的，所以前端 `fetch('http://localhost:3456/api/submit')` 可以正常工作。

---

## 常见问题

| 问题 | 原因 | 解决 |
|------|------|------|
| 前端提交后提示"跨域" | 但 `localhost` 跨域是浏览器允许的 | 确认 server.mjs 在 3456 端口运行 |
| `ECONNREFUSED 127.0.0.1:9222` | Edge 未以调试模式启动 | 重新启动 Edge（加 `--remote-debugging-port=9222`） |
| "未找到 Kimi 标签页" | 未打开 slides 页面 | 在 Edge 中打开 `https://www.kimi.com/slides` |
| 发送按钮一直 disabled | Vue 状态未更新 | kimi-cdp.mjs 有强制启用后备，稍等几秒 |
| 文件上传失败 | Kimi 页面结构变化 | 检查 server.mjs 日志中的选择器命中情况 |

---

## 完整自动化流程

```
用户提交表单
  → server.mjs 接收 FormData + 附件
    → 保存附件到 %TEMP%/ppt-service/{submission_id}/
    → 构造提示词（客户原文）
    → 调用 kimi-cdp.mjs:
      1. insertText 填入提示词（原文）
      2. DOM.setFileInputFiles 上传真实附件
      3. 选择模式（智能布局/经典模板）
      4. 点击发送
      5. 轮询等待 Kimi 生成（最长 60 分钟）
      6. 检测到完成 → 下载 PPT 到 M:/资料
    → 返回 { success, agent_prompt } 给前端
    → 清理临时文件
```
