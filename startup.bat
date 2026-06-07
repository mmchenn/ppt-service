@echo off
title PPT Service — 一键启动
cd /d "C:\Users\Administrator\ppt-service"
powershell.exe -ExecutionPolicy Bypass -File "startup.ps1"
pause