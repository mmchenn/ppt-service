@echo off
rem ===== PPT Service 静默启动器（万能版）=====
rem 双击运行：完全不弹黑窗口，后台启动服务后自动打开浏览器
rem 关闭方式：双击 stop-backend.bat 或任务管理器结束 node

cd /d "%~dp0"

rem 直接使用完整路径启动 node
set NODE_CMD=M:\app\ai\node.exe

rem POLL_TOKEN 必须与 Cloudflare Pages 上设置的一致
set POLL_TOKEN=0408tianse
if not exist "%NODE_CMD%" (
  msg "%username%" PPT Service 错误：找不到 %NODE_CMD%
  exit /b 1
)

rem 启动服务，完全隐藏窗口（传入 POLL_TOKEN 环境变量）
start /B "" cmd /c "set POLL_TOKEN=%POLL_TOKEN% && "%NODE_CMD%" server.mjs --silent"

rem 等待 3 秒（用 WScript.Sleep 不弹窗口）
echo >"%TEMP%\ppt_wait.vbs" WScript.Sleep 3000
echo >>"%TEMP%\ppt_wait.vbs" CreateObject("WScript.Shell").Run "http://127.0.0.1:3456", 1, False
echo >>"%TEMP%\ppt_wait.vbs" CreateObject("Scripting.FileSystemObject").DeleteFile WScript.ScriptFullName

cscript //nologo "%TEMP%\ppt_wait.vbs"

exit /b 0
