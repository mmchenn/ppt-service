# PPT Service — 重启后完整流程

## 准备工作

电脑重启后，需要确保：
- 能上网（WIFI/网线）
- Edge 浏览器正常

---

## 🔶 一键启动脚本

**以管理员身份**打开 PowerShell，逐条执行：

```powershell
Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass
C:\Users\Administrator\ppt-service\start-ppt-service.ps1
```

脚本会自动完成：
1. ✅ 检查依赖
2. ✅ 启动 `server.mjs`（监听 3456 端口）
3. ✅ 启动 `cloudflared tunnel`
4. ✅ 自动获取新隧道 URL
5. ✅ 更新 `submit.js` 的 `TUNNEL_URL`

---

## 🔶 手动步骤（复制粘贴执行）

### ① 提交并部署到 Cloudflare Pages

```powershell
cd C:\Users\Administrator\ppt-service
git add .
git commit -m "fix: update tunnel url"
git push origin main
```

### ② 等部署完成（1-2 分钟）

打开 https://dash.cloudflare.com/ → Workers & Pages → ppt-service → **Deployments**

看到绿色 **Success** 即可继续。

### ③ 启动 Edge 远程调试

```powershell
& "C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe" --remote-debugging-port=9222
```

### ④ 登录 Kimi

在 Edge 中打开 **https://kimi.com/slides**，扫码或账号登录。

### ⑤ 验证

访问 **https://ppt-service.pages.dev/**，填写表单并提交，看是否成功。

> ⚠️ 首次提交后 Kimi 生成需要 **1-5 分钟**，请等待。
> 完成后客户邮箱将收到附有 PPT 的邮件。

---

## 🔶 停止服务

用完关闭所有 PowerShell 窗口，或执行：

```powershell
taskkill /F /IM node.exe /T 2>$null
taskkill /F /IM cloudflared.exe /T 2>$null
```

---

## 🔶 故障排查

| 问题 | 解决方法 |
|:--|:--|
| `failed to fetch` | 隧道 URL 变了 → 重新跑脚本 → 重新 git push 部署 |
| `git push` 提示 up-to-date | 先 `git add .` 再 `git commit`，确保有修改 |
| Cloudflared 没启动 | 手动跑：`C:\Users\Administrator\cloudflared.exe tunnel --url http://localhost:3456` |
| server.mjs 端口被占用 | `taskkill /F /IM node.exe /T` 再重试 |
| Pages 部署失败 | 去 Cloudflare Dashboard 看部署日志 |
| 邮件没附件 | 确认已用最新代码（包含附件路径修复） |
