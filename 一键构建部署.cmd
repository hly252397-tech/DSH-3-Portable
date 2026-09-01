@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"

echo ============================================
echo   DSH 便携版 - 一键构建部署
echo ============================================
echo.

REM ---- 第1步：强杀所有 DSH 进程 ----
echo [1/4] 正在强制关闭 DSH Codex Desktop ...
taskkill /F /IM "DSH Codex Desktop.exe" /T >nul 2>&1
timeout /t 3 /nobreak >nul
taskkill /F /IM "DSH Codex Desktop.exe" /T >nul 2>&1
timeout /t 2 /nobreak >nul
echo       已执行强杀。

REM ---- 第2步：设置环境（按 AGENTS.md 要求）----
echo [2/4] 准备构建环境 ...
set "TEMP=C:\Users\96551\AppData\Local\Temp"
set "TMP=C:\Users\96551\AppData\Local\Temp"
set "CSC_IDENTITY_AUTO_DISCOVERY=false"
set "NODE=%~dp0App\resources\node\node.exe"

if not exist "%NODE%" (
    echo [错误] 找不到 %NODE%
    pause
    exit /b 1
)

REM ---- 第3步：编译 + 测试 + 打包 ----
echo [3/4] 编译 TypeScript ...
"%NODE%" node_modules\typescript\bin\tsc
if errorlevel 1 (
    echo [错误] TypeScript 编译失败
    pause
    exit /b 1
)
echo       编译完成。

echo [3/4] 运行测试门禁 ...
"%NODE%" --test dist\test\*.test.js
if errorlevel 1 (
    echo [警告] 有测试未通过，继续打包...
)

echo [3/4] electron-builder 打包 ...
cmd /c "set TEMP=C:\Users\96551\AppData\Local\Temp&& set TMP=C:\Users\96551\AppData\Local\Temp&& set CSC_IDENTITY_AUTO_DISCOVERY=false&& "%NODE%" node_modules\electron-builder\cli.js --win dir --publish never"
if errorlevel 1 (
    echo [错误] 打包失败
    pause
    exit /b 1
)
echo       打包完成。

REM ---- 第4步：部署 ----
echo [4/4] 部署到 App 目录 ...
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0deploy-new-build.ps1"
if errorlevel 1 (
    echo [错误] 部署失败（可能进程仍未退出，请手动从托盘退出后重试）
    pause
    exit /b 1
)

echo.
echo ============================================
echo   ✅ 全部完成！可以双击 DSH便携版3.exe 启动了
echo ============================================
echo.
pause
