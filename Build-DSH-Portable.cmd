@echo off
setlocal
chcp 65001 >nul
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0Build-DSH-Portable.ps1" %*
set "result=%errorlevel%"
if not "%result%"=="0" echo 构建失败，退出码 %result%。现有 App 未被替换。
pause
exit /b %result%
