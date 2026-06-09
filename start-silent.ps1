# PPT Service 静默启动 (PowerShell)
# 右键 → 使用 PowerShell 运行
# 完全不弹窗口，后台启动 server.mjs

$ProjectDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$nodePath = "$ProjectDir\node_modules\.bin\node.cmd"
if (-not (Test-Path $nodePath)) { $nodePath = "node" }

# 启动服务，隐藏窗口
$psi = New-Object System.Diagnostics.ProcessStartInfo
$psi.FileName = $nodePath
$psi.Arguments = "server.mjs --silent"
$psi.WorkingDirectory = $ProjectDir
$psi.WindowStyle = [System.Diagnostics.ProcessWindowStyle]::Hidden
$psi.CreateNoWindow = $true
[System.Diagnostics.Process]::Start($psi) | Out-Null

Start-Sleep -Seconds 3

# 打开浏览器
Start-Process "http://localhost:3456"
