@echo off
setlocal
set "ROOT=%~dp0"
set "NODE=%ROOT%App\resources\node\node.exe"
if not exist "%NODE%" (
  echo [P3 Tiny Watch] Bundled Node not found: %NODE%
  exit /b 1
)
pushd "%ROOT%"
"%NODE%" "%ROOT%scripts\install-p3-tiny-watch.mjs"
set "CODE=%ERRORLEVEL%"
popd
if not "%CODE%"=="0" (
  echo [P3 Tiny Watch] Installation failed with code %CODE%.
  exit /b %CODE%
)
echo [P3 Tiny Watch] Installed. DSH will reload after the profile change is detected; otherwise restart DSH from the tray.
endlocal
