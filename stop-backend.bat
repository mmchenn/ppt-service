@echo off
rem ===== PPT Service 停止后台服务 =====
echo 正在停止 PPT Service...
taskkill /f /im node.exe 2>nul
echo 已停止。
pause
