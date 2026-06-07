<#
.SYNOPSIS
  PPT 智能生成服务 — 一键启动脚本
.DESCRIPTION
  自动完成：
    1. 启动 Edge（远程调试端口 9222）
    2. 打开 Kimi Slides 页面
    3. 启动 node server.mjs
    4. 启动 cloudflared tunnel
    5. 打开 Cloudflare Pages 确认可访问
#>

$ErrorActionPreference = 'Continue'
$ProjectDir = 'C:\Users\Administrator\ppt-service'
$EdgeDataDir = 'C:/Users/Administrator/AppData/Local/Microsoft/Edge/User Data'
$LogFile = "$ProjectDir\startup.log"

function Log {
    param([string]$msg, [string]$level = 'INFO')
    $ts = Get-Date -Format 'HH:mm:ss'
    $line = "$ts [$level] $msg"
    Write-Host $line
    Add-Content -Path $LogFile -Value $line -Force
}

function Wait-ProcessReady {
    param([string]$Name, [int]$TimeoutSeconds = 15)
    $start = Get-Date
    while ((Get-Date) - $start -lt [TimeSpan]::FromSeconds($TimeoutSeconds)) {
        $p = Get-Process -Name $Name -ErrorAction SilentlyContinue
        if ($p) { return $true }
        Start-Sleep -Seconds 1
    }
    return $false
}

Clear-Host
Log '═══════════════════════════════════════'
Log ' PPT 智能生成服务 — 一键启动'
Log '═══════════════════════════════════════'

# =====================
# 1. 启动 Edge（远程调试端口）
# =====================
Log '步骤 1/5: 启动 Edge（远程调试端口 9222）...'

# 检查 Edge 是否已经在 9222 端口监听
$portCheck = netstat -an 2>$null | Select-String ':9222'
if ($portCheck) {
    Log '  端口 9222 已被占用，Edge 可能已启动'
} else {
    # 关闭现有 Edge 进程（避免端口冲突）
    $edgeProcs = Get-Process -Name msedge -ErrorAction SilentlyContinue
    if ($edgeProcs) {
        Log "  关闭现有 Edge 进程 ($($edgeProcs.Count) 个)..."
        $edgeProcs | Stop-Process -Force -ErrorAction SilentlyContinue
        Start-Sleep -Seconds 3
    }

    # 启动 Edge
    Start-Process msedge -ArgumentList @(
        '--remote-debugging-port=9222',
        "--user-data-dir=`"$EdgeDataDir`"",
        'https://www.kimi.com/slides'
    )
    Log '  Edge 已启动，正在打开 Kimi Slides...'

    if (-not (Wait-ProcessReady -Name msedge -TimeoutSeconds 15)) {
        Log '  Edge 启动超时，请手动检查' 'WARN'
    } else {
        Log '  ✅ Edge 已就绪'
    }
    Start-Sleep -Seconds 5
}

# =====================
# 2. 确保 Kimi Slides 已打开
# =====================
Log '步骤 2/5: 确认 Kimi Slides 页面...'
# Edge 启动时已经传了 kimi.com/slides URL，等待加载
Start-Sleep -Seconds 3
Log '  ✅ Kimi Slides 页面已请求（请确保已登录）'

# =====================
# 3. 启动 node server.mjs
# =====================
Log '步骤 3/5: 启动本地服务 node server.mjs...'

# 检查端口 3456
$port3456 = netstat -an 2>$null | Select-String ':3456'
if ($port3456) {
    Log '  端口 3456 已被占用，检查是否是 server.mjs...'
    $nodeProc = Get-Process -Name node -ErrorAction SilentlyContinue | Where-Object { $_.CommandLine -match 'server' -or $_.MainWindowTitle -match 'server' }
    if (-not $nodeProc) {
        # 可能是残留进程，强制释放
        $p = netstat -ano 2>$null | Select-String ':3456'
        if ($p) {
            $pid = $p[0] -split '\s+' | Select-Object -Last 1
            Log "  尝试结束占用进程 PID=$pid..." 'WARN'
            Stop-Process -Id $pid -Force -ErrorAction SilentlyContinue
            Start-Sleep -Seconds 2
        }
    }
}

# 启动 server.mjs 在新窗口中（方便查看日志）
$serverWindow = Start-Process powershell -ArgumentList @(
    "-NoExit",
    "-Command",
    "cd '$ProjectDir'; Write-Host '📡 PPT Service - server.mjs' -ForegroundColor Cyan; node server.mjs"
) -PassThru -WindowStyle Normal

Start-Sleep -Seconds 3
if ($serverWindow.HasExited) {
    Log '  ❌ server.mjs 启动失败，请检查日志' 'ERROR'
} else {
    Log '  ✅ server.mjs 已启动 (PID: ' + $serverWindow.Id + ')'
}

# =====================
# 4. 启动 cloudflared tunnel
# =====================
Log '步骤 4/5: 启动 Cloudflare Tunnel...'

# 先检查 cloudflared 是否存在
if (-not (Test-Path "$ProjectDir\cloudflared.exe")) {
    Log '  ❌ cloudflared.exe 不存在，请先下载' 'ERROR'
} else {
    # 启动 cloudflared 在新窗口中
    $tunnelWindow = Start-Process powershell -ArgumentList @(
        "-NoExit",
        "-Command",
        "cd '$ProjectDir'; Write-Host '🌐 Cloudflare Tunnel' -ForegroundColor Cyan; .\cloudflared.exe tunnel --url http://localhost:3456"
    ) -PassThru -WindowStyle Normal

    Start-Sleep -Seconds 8

    # 从日志中提取 tunnel URL
    $tunnelLog = Get-Content -Path $ProjectDir\startup.log -Tail 50 -ErrorAction SilentlyContinue
    $tunnelUrl = $tunnelLog | Select-String 'https://.+\.trycloudflare\.com' | ForEach-Object { $_.Matches.Value } | Select-Object -First 1

    if ($tunnelUrl) {
        Log "  ✅ Tunnel 地址: $tunnelUrl"
    } else {
        Log '  ⚠️ 正在等待 tunnel 连接（请在新窗口中确认 URL）' 'WARN'
    }
}

# =====================
# 5. 打开 Cloudflare Pages 页面
# =====================
Log '步骤 5/5: 打开 Cloudflare Pages...'
Start-Process 'https://ppt-service.pages.dev/'
Log '  ✅ 已打开，请确认表单页面正常显示'

# =====================
# 完成
# =====================
Log ''
Log '═══════════════════════════════════════'
Log ' 🎉 启动完成！'
Log '═══════════════════════════════════════'
Log ''
Log '📋 注意事项：'
Log '  1. 请确认 Edge 已登录 kimi.com'
Log '  2. 客户打开 https://ppt-service.pages.dev/ 即可提交'
Log '  3. 关闭时直接关掉所有 PowerShell 窗口即可'
Log '  4. 如果 Tunnel URL 变了，需要更新 functions/api/submit.js 中的 TUNNEL_URL'
Log ''
Log '打开的窗口（请勿关闭）：'
Log '  [1] server.mjs — 本地 HTTP 服务'
Log '  [2] cloudflared — 隧道连接'
Log ''
Log '日志文件: startup.log'
Log '═══════════════════════════════════════'

# 弹出通知
$popup = New-Object -ComObject Wscript.Shell
$popup.Popup("PPT 智能生成服务已启动`n请确认 Edge 已登录 kimi.com", 5, 'PPT Service', 64)
