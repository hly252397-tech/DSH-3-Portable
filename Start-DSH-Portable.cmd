@echo off
setlocal
chcp 65001 >nul
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "%~dp0Start-DSH-Portable.ps1" %*
if errorlevel 1 (
  echo 启动失败：请检查 Data\Updates\Desktop\launcher.log 和 Data\Electron\UserData\startup-error.log。
  pause
)
endlocal
