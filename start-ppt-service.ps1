# start-ppt-service.ps1
# PPT Service quick start script
# Usage (Admin PowerShell): powershell -ExecutionPolicy Bypass -File start-ppt-service.ps1

$ErrorActionPreference = "Continue"
$ProjectDir = "C:\Users\Administrator\ppt-service"
$CloudflaredPath = "C:\Users\Administrator\cloudflared.exe"

Write-Host "`n" -NoNewline
Write-Host ("=" * 52) -ForegroundColor Cyan
Write-Host "  PPT Service ---- Quick Start" -ForegroundColor Cyan
Write-Host ("=" * 52) -ForegroundColor Cyan
Write-Host ""

# === Step 1: check dependencies ===
Write-Host "[1/4] Checking dependencies..." -ForegroundColor Yellow

if (-not (Test-Path $ProjectDir)) {
    Write-Host "  FAIL: Project dir not found: $ProjectDir" -ForegroundColor Red
    exit 1
}
if (-not (Test-Path "$ProjectDir\server.mjs")) {
    Write-Host "  FAIL: server.mjs not found" -ForegroundColor Red
    exit 1
}
if (-not (Test-Path $CloudflaredPath)) {
    Write-Host "  FAIL: cloudflared not found at: $CloudflaredPath" -ForegroundColor Red
    Write-Host "  Download from: https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/"
    exit 1
}
Write-Host "  OK: All dependencies present" -ForegroundColor Green

# === Step 2: start server.mjs ===
Write-Host "[2/4] Starting server.mjs (port 3456)..." -ForegroundColor Yellow

$existing = Get-Process -Name "node" -ErrorAction SilentlyContinue | Where-Object { $_.CommandLine -like "*server.mjs*" }
if ($existing) {
    Write-Host "  SKIP: server.mjs already running (PID: $($existing.Id))" -ForegroundColor Yellow
} else {
    $null = Start-Job -Name "ppt-server" -ScriptBlock {
        param($d)
        Set-Location $d
        node server.mjs
    } -ArgumentList $ProjectDir
    Start-Sleep -Seconds 2
    Write-Host "  OK: server.mjs started" -ForegroundColor Green
}

# === Step 3: cloudflared tunnel ===
Write-Host "[3/4] Starting cloudflared tunnel..." -ForegroundColor Yellow

$existingCf = Get-Process -Name "cloudflared" -ErrorAction SilentlyContinue
if ($existingCf) {
    Write-Host "  Stopping old cloudflared..." -ForegroundColor Yellow
    $existingCf | Stop-Process -Force -ErrorAction SilentlyContinue
    Start-Sleep -Seconds 2
}

$tunnelJob = Start-Job -Name "ppt-tunnel" -ScriptBlock {
    param($p)
    & $p tunnel --url http://localhost:3456 2>&1
} -ArgumentList $CloudflaredPath

Write-Host "  Waiting for tunnel URL..." -ForegroundColor Gray
$tunnelUrl = $null
for ($i = 0; $i -lt 30; $i++) {
    Start-Sleep -Seconds 1
    $output = Receive-Job -Job $tunnelJob -Keep -ErrorAction SilentlyContinue
    if ($output -match "https://([a-z0-9-]+\.trycloudflare\.com)") {
        $tunnelUrl = $matches[0]
        break
    }
    Write-Host "." -NoNewline -ForegroundColor Gray
}

if (-not $tunnelUrl) {
    Write-Host "`n  FAIL: Could not get tunnel URL" -ForegroundColor Red
    Write-Host "  Run manually: $CloudflaredPath tunnel --url http://localhost:3456" -ForegroundColor Yellow
    exit 1
}
Write-Host "`n  OK: Tunnel URL = $tunnelUrl" -ForegroundColor Green

# === Step 4: update TUNNEL_URL in submit.js ===
Write-Host "[4/4] Updating submit.js TUNNEL_URL..." -ForegroundColor Yellow

$submitJs = "$ProjectDir\functions\api\submit.js"
$content = Get-Content $submitJs -Raw
if ($content -match "const TUNNEL_URL = 'https://[^']+'") {
    $newContent = $content -replace "const TUNNEL_URL = 'https://[^']+'", "const TUNNEL_URL = '$tunnelUrl'"
    Set-Content -Path $submitJs -Value $newContent -NoNewline
    Write-Host "  OK: TUNNEL_URL updated to: $tunnelUrl" -ForegroundColor Green
} else {
    Write-Host "  WARN: Could not find TUNNEL_URL pattern in submit.js, update manually" -ForegroundColor Yellow
}

# === Done: show status and manual steps ===
Write-Host "" -NoNewline
Write-Host ("=" * 52) -ForegroundColor Cyan
Write-Host "  All services started!" -ForegroundColor Cyan
Write-Host ("=" * 52) -ForegroundColor Cyan
Write-Host "  Tunnel:  $tunnelUrl" -ForegroundColor Green
Write-Host "  Local:   http://localhost:3456" -ForegroundColor Green
Write-Host "  Pages:   https://ppt-service.pages.dev/api/submit" -ForegroundColor Green
Write-Host ("=" * 52) -ForegroundColor Cyan
Write-Host ""
Write-Host "=== MANUAL STEPS (copy & paste one by one) ===" -ForegroundColor Yellow
Write-Host ""
Write-Host "---- A. Deploy to Pages ----" -ForegroundColor Yellow
Write-Host 'cd C:\Users\Administrator\ppt-service' -ForegroundColor White
Write-Host 'git add .\functions\api\submit.js' -ForegroundColor White
Write-Host 'git commit -m "fix: update tunnel url"' -ForegroundColor White
Write-Host 'git push origin main' -ForegroundColor White
Write-Host ""
Write-Host "---- B. Open Edge with remote debugging ----" -ForegroundColor Yellow
Write-Host '"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe" --remote-debugging-port=9222' -ForegroundColor White
Write-Host ""
Write-Host "---- C. Open Kimi and login ----" -ForegroundColor Yellow
Write-Host "Open https://www.kimi.com/slides in Edge, login" -ForegroundColor White
Write-Host ""
Write-Host "---- D. Wait for Pages deploy (1-2 min) ----" -ForegroundColor Yellow
Write-Host "Check: https://dash.cloudflare.com/ -> Workers & Pages -> ppt-service -> Deployments" -ForegroundColor White
Write-Host ""
Write-Host ("=" * 52)
Write-Host "Running in background. Press Ctrl+C to stop this view (services keep running)." -ForegroundColor Gray
Write-Host "Check status:   Get-Job" -ForegroundColor Gray
Write-Host "Stop services:  Stop-Job ppt-server; Stop-Job ppt-tunnel" -ForegroundColor Gray

while ($true) { Start-Sleep -Seconds 60 }
