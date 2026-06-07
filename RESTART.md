# PPT Service — 重启后启动流程

## 一键启动（推荐）

**以管理员身份**打开 PowerShell，执行：

```
C:\Users\Administrator\ppt-service\start-ppt-service.ps1
```

如果提示执行策略禁止运行，先执行：
```
Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass
```

脚本会自动完成：
1. ✅ 启动 `server.mjs`（监听 3456 端口）
2. ✅ 启动 `cloudflared tunnel`
3. ✅ 自动获取隧道 URL
4. ✅ 更新 `submit.js` 的 `TUNNEL_URL`
5. ✅ 自动 `git push` 部署

**之后还需要手动做：**

### 6. 等 Pages 部署完成
访问 https://dash.cloudflare.com/ → Workers & Pages → ppt-service → Deployments 看状态

### 7. 启动 Edge 远程调试
```
"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe" --remote-debugging-port=9222
```

### 8. 登录 Kimi
在 Edge 中打开 https://www.kimi.com/slides 并登录

---

## 手动流程（脚本不能用时）

1. `cd C:\Users\Administrator\ppt-service`
2. `Start-Job { node server.mjs }`
3. `Start-Job { C:\Users\Administrator\cloudflared.exe tunnel --url http://localhost:3456 }`
4. 等几秒后，从 cloudflared 日志中找到 `https://xxx.trycloudflare.com` 记下来
5. 用记事本打开 `functions\api\submit.js`，把第 13 行的 URL 换成上面的
6. `git add .\functions\api\submit.js; git commit -m "update tunnel url"; git push origin main`
7. 等 Pages 部署完成
8. 启动 Edge `--remote-debugging-port=9222` 并登录 Kimi
