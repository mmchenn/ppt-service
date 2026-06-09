@echo off
rem PPT Service 桌面版快捷启动
rem 如果已在项目目录，直接启动
cd /d "C:\Users\Administrator\ppt-service"
echo.
echo ====================================
echo   PPT 智能生成 · 桌面版
echo ====================================
echo.
echo 启动 Electron 桌面应用...
echo 前置条件：Edge 已启动 --remote-debugging-port=9222
echo           Kimi slides 已登录
echo.
npx electron electron.mjs
pause
