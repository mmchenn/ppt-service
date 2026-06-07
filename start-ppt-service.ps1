# start-ppt-service.ps1
# PPT Service 一键启动脚本
# 用法：以管理员身份运行 PowerShell，执行本脚本
# 或：powershell -ExecutionPolicy Bypass -File start-ppt-service.ps1

$ErrorActionPreference = "Continue"
$ProjectDir = "C:\Users\Administrator\ppt-service"
$CloudflaredPath = "C:\Users\Administrator\cloudflared.exe"

Write-Host "`n" -NoNewline
Write-Host "╔══════════════════════════════════════════╗" -ForegroundColor Cyan
Write-Host "║   PPT Service — 一键启动                 ║" -ForegroundColor Cyan
Write-Host "╚══════════════════════════════════════════╝" -ForegroundColor Cyan
Write-Host ""

# ---- 1. 检查必要依赖 ----
Write-Host "▶ [1/6] 检查环境..." -ForegroundColor Yellow

if (-not (Test-Path $ProjectDir)) {
    Write-Host "  ❌ 项目目录不存在: $ProjectDir" -ForegroundColor Red
    exit 1
}
if (-not (Test-Path "$ProjectDir\server.mjs")) {
    Write-Host "  ❌ server.mjs 不存在" -ForegroundColor Red
    exit 1
}
if (-not (Test-Path $CloudflaredPath)) {
    Write-Host "  ❌ cloudflared 不存在: $CloudflaredPath" -ForegroundColor Red
    Write-Host "  请从 https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/ 下载"
    exit 1
}
Write-Host "  ✅ 环境检查通过" -ForegroundColor Green

# ---- 2. 启动 server.mjs ----
Write-Host "`n▶ [2/6] 启动 server.mjs (端口 3456)..." -ForegroundColor Yellow

# 先检查是否已在运行
$existing = Get-Process -Name "node" -ErrorAction SilentlyContinue | Where-Object { $_.CommandLine -like "*server.mjs*" }
if ($existing) {
    Write-Host "  ⚠️  server.mjs 已在运行 (PID: $($existing.Id))" -ForegroundColor Yellow
} else {
    $serverJob = Start-Job -Name "ppt-server" -ScriptBlock {
        param($dir)
        Set-Location $dir
        node server.mjs
    } -ArgumentList $ProjectDir
    Start-Sleep -Seconds 2
    $serverJob | Out-Null
    Write-Host "  ✅ server.mjs 已启动 (后台 Job: ppt-server)" -ForegroundColor Green
}

# ---- 3. 启动 cloudflared 隧道 ----
Write-Host "`n▶ [3/6] 启动 cloudflared 隧道..." -ForegroundColor Yellow

$existingCf = Get-Process -Name "cloudflared" -ErrorAction SilentlyContinue
if ($existingCf) {
    Write-Host "  ⚠️  cloudflared 已在运行 (PID: $($existingCf.Id))，先停止旧进程..." -ForegroundColor Yellow
    $existingCf | Stop-Process -Force -ErrorAction SilentlyContinue
    Start-Sleep -Seconds 2
}

$tunnelJob = Start-Job -Name "ppt-tunnel" -ScriptBlock {
    param($cfPath)
    & $cfPath tunnel --url http://localhost:3456 2>&1
} -ArgumentList $CloudflaredPath

# 等待隧道 URL 出现
Write-Host "  正在等待隧道地址..." -ForegroundColor Gray
$tunnelUrl = $null
for ($i = 0; $i -lt 30; $i++) {
    Start-Sleep -Seconds 1
    $output = Receive-Job -Job $tunnelJob -Keep -ErrorAction SilentlyContinue
    if ($output -match "https://([a-z0-9-]+\.trycloudflare\.com)") {
        $tunnelUrl = $matches[0]
        break
    }
    Write-Host "  ." -NoNewline -ForegroundColor Gray
}

if (-not $tunnelUrl) {
    Write-Host "`n  ❌ 未能获取隧道地址" -ForegroundColor Red
    Write-Host "  请手动运行: $CloudflaredPath tunnel --url http://localhost:3456" -ForegroundColor Yellow
    exit 1
}

Write-Host "`n  ✅ 隧道已建立: $tunnelUrl" -ForegroundColor Green

# ---- 4. 更新 submit.js 中的 TUNNEL_URL ----
Write-Host "`n▶ [4/6] 更新 submit.js 中的隧道地址..." -ForegroundColor Yellow

$submitJs = "$ProjectDir\functions\api\submit.js"
$content = Get-Content $submitJs -Raw

if ($content -match "const TUNNEL_URL = 'https://[^']+'") {
    $newContent = $content -replace "const TUNNEL_URL = 'https://[^']+'", "const TUNNEL_URL = '$tunnelUrl'"
    Set-Content -Path $submitJs -Value $newContent -NoNewline
    Write-Host "  ✅ submit.js 已更新为: $tunnelUrl" -ForegroundColor Green
} else {
    Write-Host "  ⚠️  submit.js 中未找到 TUNNEL_URL，请手动检查" -ForegroundColor Yellow
}

# ---- 5. 提交并推送 ----
Write-Host "`n▶ [5/6] 提交并推送代码到 GitHub..." -ForegroundColor Yellow

Set-Location $ProjectDir
git add functions/api/submit.js 2>&1 | ForEach-Object { Write-Host "  $_" -ForegroundColor Gray }
git commit -m "fix: update tunnel URL to $tunnelUrl" 2>&1 | ForEach-Object { Write-Host "  $_" -ForegroundColor Gray }
git push origin main 2>&1 | ForEach-Object { Write-Host "  $_" -ForegroundColor Gray }

if ($LASTEXITCODE -eq 0) {
    Write-Host "  ✅ 代码已推送，Cloudflare Pages 自动构建中..." -ForegroundColor Green
} else {
    Write-Host "  ⚠️  git push 可能有异常，请检查" -ForegroundColor Yellow
}

# ---- 6. 最终提示 ----
Write-Host "`n▶ [6/6] 后续步骤..." -ForegroundColor Yellow
Write-Host ""
Write-Host "╔══════════════════════════════════════════════════════╗" -ForegroundColor Cyan
Write-Host "║              ✅ 启动完成！                           ║" -ForegroundColor Cyan
Write-Host "╠══════════════════════════════════════════════════════╣" -ForegroundColor Cyan
Write-Host "║                                                    ║" -ForegroundColor Cyan
Write-Host "║  隧道地址: $tunnelUrl" -ForegroundColor Cyan
Write-Host "║  Pages:   https://ppt-service.pages.dev/api/submit ║" -ForegroundColor Cyan
Write-Host "║                                                    ║" -ForegroundColor Cyan
Write-Host "╠══════════════════════════════════════════════════════╣" -ForegroundColor Cyan
Write-Host "║  ⚠️  还需要手动做：                                  ║" -ForegroundColor Cyan
Write-Host "║  1. 等待 Cloudflare Pages 部署完成 (1-2分钟)       ║" -ForegroundColor Cyan
Write-Host "║     访问 https://dash.cloudflare.com/ 查看状态     ║" -ForegroundColor Cyan
Write-Host "║  2. 确保 Edge 已启动远程调试端口:                  ║" -ForegroundColor Cyan
Write-Host "║     msedge.exe --remote-debugging-port=9222        ║" -ForegroundColor Cyan
Write-Host "║  3. 在 Edge 中打开 https://www.kimi.com/slides    ║" -ForegroundColor Cyan
Write-Host "║     并登录 Kimi 账号                               ║" -ForegroundColor Cyan
Write-Host "║                                                    ║" -ForegroundColor Cyan
Write-Host "╚══════════════════════════════════════════════════════╝" -ForegroundColor Cyan
Write-Host ""

# 后台 Job 持续运行，防止被回收
Write-Host "后台进程: node server.mjs (Job: ppt-server) + cloudflared (Job: ppt-tunnel)" -ForegroundColor Gray
Write-Host "用 Get-Job 查看状态，用 Stop-Job 停止" -ForegroundColor Gray
Write-Host "按 Ctrl+C 退出脚本（后台进程继续运行）" -ForegroundColor Gray

# 保持脚本运行
while ($true) {
    Start-Sleep -Seconds 60
    # 每60秒检查状态
    $s = Receive-Job -Job $tunnelJob -Keep -ErrorAction SilentlyContinue | Select-Object -Last 1
    if ($s -match "error|failed|disconnected") {
        Write-Host "  ⚠️  隧道异常: $s" -ForegroundColor Yellow
    }
}
