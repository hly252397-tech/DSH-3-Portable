@echo off
setlocal
chcp 65001 >nul
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "%~dp0Start-DSH-Portable.ps1" %*
if errorlevel 1 (
  echo 启动失败：请先运行 Update-DSH-Portable.cmd 获取官网程序，或检查 Data\Logs。
  pause
)
endlocal
