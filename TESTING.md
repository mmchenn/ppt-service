# PPT Service — 测试指南

## 项目文件一览

| 文件 | 作用 |
|------|------|
| [index.html](index.html) | 前端页面，提交表单后自动调本地 webhook |
| [functions/api/submit.js](functions/api/submit.js) | Cloudflare Worker，接收表单 + 存 R2 + 生成提示词 |
| [kimi-cdp.mjs](kimi-cdp.mjs) | **核心** — CDP 自动化: 输入提示词 → 点击发送 → 等待生成 → 下载 PPT → 发邮件给客户 |
| [server.mjs](server.mjs) | 本地 Webhook 服务，接收 Worker 请求后调 CDP |
| [test-connection.mjs](test-connection.mjs) | 只读连接测试 |
| [TESTING.md](TESTING.md) | 本文件 |

---

## 前置条件

1. **Edge 浏览器已启动并开启调试端口 9222**
   - 确认方法 — 运行 `curl http://localhost:9222/json/version`
   - 返回 JSON 包含 `"Browser": "Edg/..."` 即正常
   - 如果未启动，重新用调试模式打开：
     ```
     "C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe" \
       --remote-debugging-port=9222 \
       --user-data-dir="C:\Users\Administrator\.claude-edge-debug"
     ```

2. **Kimi 已登录** — 在 Edge 中打开 `https://www.kimi.com/slides` 并确认已登录

3. **Node.js 依赖已安装**
   ```
   cd C:\Users\Administrator\ppt-service
   npm install
   ```
   应安装 `chrome-remote-interface` 和 `ws`

---

## 测试步骤

### 第 1 步：只读连接检查（先验证环境）

运行以下命令检查 Edge 调试端口和 Kimi 页面状态：

```bash
cd C:\Users\Administrator\ppt-service && node -e "
const CDP = require('chrome-remote-interface');
async function main() {
  // 1. 列出所有标签页
  const tabs = await CDP.List({ port: 9222 });
  console.log('=== Edge 标签页列表 ===');
  tabs.forEach(t => console.log(' ', t.title?.slice(0,40) || '(无标题)', '|', t.url?.slice(0,70)));

  // 2. 找 Kimi Slides
  const slides = tabs.find(t => t.url.includes('kimi.com/slides'));
  if (!slides) { console.log('\\n❌ 未找到 Kimi Slides 标签页，请先打开 https://www.kimi.com/slides'); return; }
  console.log('\\n✅ 找到 Kimi Slides:', slides.title);

  // 3. 连接并检查页面状态
  const tab = await CDP({ port: 9222, target: () => slides });
  const { Page, Runtime } = tab;
  await Page.enable();
  const r = await Runtime.evaluate({
    expression: JSON.stringify({
      editorExists: !!document.querySelector('.chat-input-editor'),
      sendButtonClass: document.querySelector('.send-button-container')?.className,
      currentMode: document.querySelector('.select-option.is-active')?.textContent?.trim()?.slice(0,20),
      pageTitle: document.title,
    }),
    returnByValue: false
  });
  // 需要 JSON.parse 取结果
  const val = await Runtime.evaluate({ expression: r.result.value, returnByValue: false });
  console.log('\\n=== 页面状态 ===');
  console.log('  编辑器:', val.result.value.editorExists ? '✅ 存在' : '❌ 未找到');
  console.log('  发送按钮:', val.result.value.sendButtonClass);
  console.log('  当前模式:', val.result.value.currentMode);
  console.log('  页面标题:', val.result.value.pageTitle);
  await tab.close();
  console.log('\\n✅ 只读检查完成');
}
main().catch(e => console.error('Error:', e.message));
"
```

**预期输出**：编辑器存在、发送按钮显示 `send-button-container disabled`、模式显示当前选中

---

### 第 2 步：测试文本输入 + 发送按钮激活

```bash
cd C:\Users\Administrator\ppt-service && node -e "
const CDP = require('chrome-remote-interface');
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function main() {
  const tab = await CDP({ port: 9222, target: t => t.url.includes('kimi.com/slides') });
  const { Page, Runtime, Input } = tab;
  await Page.enable();

  // 1. 聚焦编辑器
  await Runtime.evaluate({ expression: 'document.querySelector(\".chat-input-editor\")?.focus()' });
  await sleep(300);

  // 2. 清空
  await Runtime.evaluate({ expression: 'document.querySelector(\".chat-input-editor\").innerHTML = \"<p><br></p>\"' });
  await Runtime.evaluate({ expression: 'document.querySelector(\".chat-input-editor\")?.dispatchEvent(new Event(\"input\", {bubbles:true}))' });
  await sleep(300);

  // 3. 输入文本（模拟真实键盘）
  await Input.insertText({ text: '请生成一份关于2026年人工智能发展趋势的PPT' });
  await sleep(500);
  await Runtime.evaluate({ expression: 'document.querySelector(\".chat-input-editor\")?.dispatchEvent(new Event(\"input\", {bubbles:true}))' });

  // 4. 等待 Vue 响应
  await sleep(2000);

  // 5. 检查结果
  const r1 = await Runtime.evaluate({
    expression: '({btnClass: document.querySelector(\".send-button-container\")?.className, textLen: document.querySelector(\".chat-input-editor\")?.innerText?.length})',
    returnByValue: true
  });
  console.log('=== 输入后状态 ===');
  console.log('  编辑器内容长度:', r1.result.value.textLen, '字符');
  console.log('  发送按钮:', r1.result.value.btnClass);

  if (r1.result.value.btnClass?.includes('send-button-container disabled')) {
    console.log('\\n📝 发送按钮仍是 disabled — 可能需要额外触发事件');
    console.log('尝试强制启用...');
    await Runtime.evaluate({ expression: 'document.querySelector(\".send-button-container\")?.classList.remove(\"disabled\")' });
    const r2 = await Runtime.evaluate({ expression: 'document.querySelector(\".send-button-container\")?.className', returnByValue: true });
    console.log('  强制后:', r2.result.value);
  } else if (r1.result.value.btnClass?.includes('send-button-container') && !r1.result.value.btnClass.includes('disabled')) {
    console.log('\\n✅ 发送按钮已激活！可继续下一步');
  }

  await tab.close();
}
main().catch(e => console.error('Error:', e.message));
"
```

**注意**：如果发送按钮未自动激活，`kimi-cdp.mjs` 的 `clickSend()` 函数有强制启用后备机制。

---

### 第 3 步：启动 Webhook 服务（独立终端）

```bash
cd C:\Users\Administrator\ppt-service && node server.mjs
```

**预期输出**：
```
2026-06-06 xx:xx:xx 📌 ==================================================
2026-06-06 xx:xx:xx 📌 PPT Service Local Webhook Server
2026-06-06 xx:xx:xx 📌 ==================================================
2026-06-06 xx:xx:xx 📌 监听端口: 3456
2026-06-06 xx:xx:xx 📌 Webhook URL: http://localhost:3456/webhook
2026-06-06 xx:xx:xx 📌 临时目录: ...\AppData\Local\Temp\ppt-service
```

验证服务运行：
```bash
curl http://localhost:3456/health
```
返回 `{"status":"running","port":3456,...}`

---

### 第 4 步：模拟 Worker 调用 Webhook

在另一个终端执行：

```bash
curl -X POST http://localhost:3456/webhook \
  -H "Content-Type: application/json" \
  -d "{
    \"name\": \"测试客户\",
    \"email\": \"test@example.com\",
    \"topic\": \"2026年人工智能发展趋势\",
    \"pages\": \"15\",
    \"deadline\": \"2026-06-10\",
    \"style\": \"商务简约\",
    \"notes\": \"目标受众：公司高管\\n重点内容：技术趋势、商业应用、政策法规、人才挑战\\n配色：蓝色为主\"
  }"
```

**预期效果**：
1. Webhook 返回 `202 {"success":true,"message":"已接收请求","requestId":"..."}`
2. Webhook 服务自动启动 `kimi-cdp.mjs`
3. CDP 脚本操作 Kimi 页面，填入提示词并发送
4. Kimi 开始生成 PPT

---

### 第 5 步：测试附件上传（可选）

先准备一个测试文件：

```bash
echo "测试附件内容" > C:\Users\Administrator\AppData\Local\Temp\test-attachment.txt
```

然后测试 CDP 附件上传：

```bash
cd C:\Users\Administrator\ppt-service && node kimi-cdp.mjs \
  --prompt "请生成一份关于2026年人工智能发展趋势的PPT，包含技术、应用、挑战三个部分，约15页" \
  --files "C:\Users\Administrator\AppData\Local\Temp\test-attachment.txt" \
  --mode "智能布局"
```

---

### 第 6 步：全自动流程（从网页表单到 Kimi 生成）

确保 Webhook 服务运行中，然后：

1. 访问 https://ppt-service.pages.dev/
2. 填写表单并提交
3. 前端会：
   - 先调用 Cloudflare Worker `/api/submit` 保存数据
   - 再调用本地 `http://localhost:3456/webhook`
   - Webhook 触发 CDP 自动提交到 Kimi

---

## 完整自动化流程（输入 → 生成 → 下载 → 发邮件）

在 `kimi-cdp.mjs` 中已内置完整流程：

```
用户提交表单（或 CLI 调用）
  → CDP 连接到 Kimi Slides 页面
    → 选择模式（智能布局/经典模板）
    → 输入提示词
    → 点击发送按钮
    → 轮询等待 Kimi 生成完成（最长 60 分钟）
    → 检测到"下载"按钮出现 → 点击下载
    → PPT 文件保存到本地 DOWNLOAD_DIR
    → （可选）通过 Resend API 发送邮件给客户（含附件）
    → 同时发通知给管理员
```

### 设置自动发邮件

需要两个环境变量：

```powershell
# 方法 1：直接在 PowerShell 中设
$env:RESEND_API_KEY="re_xxxxxxxxxxxxx"
$env:ADMIN_EMAIL="admin@example.com"
node kimi-cdp.mjs --prompt "..." --email "client@example.com" --customer "张三" --topic "年度总结"

# 方法 2：每次启动 webhook 服务前设
$env:RESEND_API_KEY="re_xxxxxxxxxxxxx" ; node server.mjs
```

### 下载目录

PPT 默认下载到 `%TEMP%/ppt-service/downloads/`，可通过环境变量修改：

```powershell
$env:DOWNLOAD_DIR="D:\PPT_成品"
```

---

## kimi-cdp.mjs 命令行参数（完整版）

```
--prompt "提示词"       必填，PPT 提示词内容
--files "f1,f2"         可选，附件路径，逗号分隔
--mode "智能布局|经典模板"   可选，默认智能布局
--pages "15"            可选，页数，默认自动
--email "客户邮箱"       可选，生成完成自动发送邮件
--customer "客户称呼"     可选，邮件中使用的称呼
--topic "主题名"         可选，邮件标题用

环境变量:
  RESEND_API_KEY     Resend 邮件 API Key（设置后才能发邮件）
  ADMIN_EMAIL        管理员通知邮箱（同时抄送）
  DOWNLOAD_DIR       PPT 下载目录（默认 %TEMP%/ppt-service/downloads）
```

示例：
```powershell
# 仅输入文本
node kimi-cdp.mjs --prompt "关于区块链的科普PPT，10页"

# 完整流程：输入 → 生成 → 下载 → 发邮件
set RESEND_API_KEY=re_xxxxxxxx
node kimi-cdp.mjs --prompt "公司年度工作总结PPT，15页" --mode "智能布局" --email "client@example.com" --customer "张三" --topic "2026年度工作总结"

# 附带附件
node kimi-cdp.mjs --prompt "主题" --files "data.docx" --mode "经典模板"

# 交互模式（不传参数时）
node kimi-cdp.mjs
```

---

## 常见问题

| 问题 | 原因 | 解决 |
|------|------|------|
| `ECONNREFUSED 127.0.0.1:9222` | Edge 未以调试模式启动 | 重新启动 Edge（加 `--remote-debugging-port=9222`） |
| "未找到 Kimi 标签页" | 未打开 slides 页面 | 在 Edge 中打开 `https://www.kimi.com/slides` |
| "Error: ... kimi.com" 超时 | CDP 连接出错 | 重新运行脚本，或刷新 Kimi 页面 |
| 发送按钮一直 disabled | Vue 状态未更新 | 脚本有强制启用后备，稍等几秒会自动触发 |
| 附件上传失败 | 页面无标准 `<input type=file>` | 附件路径会被注入到提示词文本中告知 Kimi |

## 调试技巧

1. 在 Edge 中打开 DevTools (`F12`)，观察控制台日志
2. CDP 脚本的输出会打印每个步骤的状态
3. Webhook 服务的日志会显示请求和 CDP 调用的详细输出
4. Webhook 返回 202 表示已接收，实际结果在服务端日志查看
