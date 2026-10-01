@echo off
setlocal
chcp 65001 >nul
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0Build-UI-Only.ps1" %*
set "result=%errorlevel%"
if "%result%"=="3" echo.
if "%result%"=="3" echo 门禁未通过：存在必须走全量构建的改动，未做任何替换。
if not "%result%"=="0" if not "%result%"=="3" echo 界面快通道失败，退出码 %result%。现有 App 未被替换。
pause
exit /b %result%
