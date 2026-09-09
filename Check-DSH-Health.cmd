@echo off
setlocal
set "PSModulePath="
"%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\portable-health\Check-DSH-Health.ps1"
set "DSH_HEALTH_EXIT=%ERRORLEVEL%"
echo.
pause
exit /b %DSH_HEALTH_EXIT%
