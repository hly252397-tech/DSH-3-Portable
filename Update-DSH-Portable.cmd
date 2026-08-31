@echo off
setlocal
chcp 65001 >nul
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0Update-DSH-Portable.ps1" %*
set "result=%errorlevel%"
if not "%result%"=="0" echo 更新失败，退出码 %result%。当前应用未被替换，可继续使用。
pause
exit /b %result%
