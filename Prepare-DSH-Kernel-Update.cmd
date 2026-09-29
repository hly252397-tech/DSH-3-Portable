@echo off
setlocal
chcp 65001 >nul
set "ROOT=%~dp0"
set "NODE=%ROOT%Tools\node\node.exe"
if not exist "%NODE%" (
  echo [Kernel Update Companion] Bundled Node not found: %NODE%
  exit /b 1
)
pushd "%ROOT%"
echo [Kernel Update Companion] Step 1/2: check plan (read-only) ...
"%NODE%" "%ROOT%scripts\gate-node-run.mjs" "%ROOT%scripts\prepare-kernel-update.mjs"
set "CODE=%ERRORLEVEL%"
if "%CODE%"=="0" (
  popd
  echo [Kernel Update Companion] Nothing to do. Kernel updates stay manual: click "check for updates" inside DSH first, then run this again.
  pause
  exit /b 0
)
if not "%CODE%"=="3" (
  popd
  echo [Kernel Update Companion] Plan check failed with code %CODE%.
  pause
  exit /b %CODE%
)
echo.
echo [Kernel Update Companion] Step 2/2: work pending (see plan above). Copy takes ~10-20 min on this drive.
set /p "ANS=Apply now? [y/N] "
if /i not "%ANS%"=="y" (
  popd
  echo [Kernel Update Companion] Aborted, nothing changed.
  exit /b 0
)
"%NODE%" "%ROOT%scripts\gate-node-run.mjs" "%ROOT%scripts\prepare-kernel-update.mjs" --apply
set "CODE=%ERRORLEVEL%"
popd
if not "%CODE%"=="0" (
  echo [Kernel Update Companion] Apply failed with code %CODE%. Completed bindings are kept; re-run to continue.
  pause
  exit /b %CODE%
)
echo [Kernel Update Companion] Done. Restart DSH from the tray, then run check-open-behavior.mjs.
pause
endlocal
