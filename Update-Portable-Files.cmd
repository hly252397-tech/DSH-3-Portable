@echo off
rem DSH Portable 3 - file-replacement updater (check - prompt - apply)
title DSH Portable Updater
setlocal
set "SCRIPT_DIR=%~dp0"
set "PSHOST=powershell"
where pwsh >nul 2>nul && set "PSHOST=pwsh"
"%PSHOST%" -NoProfile -ExecutionPolicy Bypass -File "%SCRIPT_DIR%Update-Portable-Files.ps1" -Mode Interactive
echo.
pause
