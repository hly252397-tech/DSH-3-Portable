@echo off
setlocal
chcp 65001 >nul
echo 正在部署新构建（含内置浏览器）…
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0deploy-new-build.ps1"
set "result=%errorlevel%"
if not "%result%"=="0" echo 部署失败或应用仍在运行，请先从系统托盘退出 DSH Codex Desktop 后重试。
pause
exit /b %result%
