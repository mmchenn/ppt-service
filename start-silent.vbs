' PPT Service 静默启动器
' 双击运行：完全不弹窗口，后台启动 server.mjs
' 关闭方式：运行 stop-backend.bat 或任务管理器结束 node
' 编码: ANSI (Windows-1252) - 勿改为 UTF-8

Set WshShell = CreateObject("WScript.Shell")

' 设置工作目录到脚本所在目录
currentDir = Left(WScript.ScriptFullName, InStrRev(WScript.ScriptFullName, "\") - 1)
WshShell.CurrentDirectory = currentDir

' 使用绝对路径启动 node（避免 PATH 中找不到）
nodeCmd = "M:\app\ai\node.exe"

' 启动 server.mjs（隐藏窗口）
WshShell.Run nodeCmd & " server.mjs --silent", 0, False

' 等待 3 秒后打开浏览器
WScript.Sleep 3000
WshShell.Run "http://127.0.0.1:3456", 1, False
