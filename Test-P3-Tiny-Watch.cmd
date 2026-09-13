@echo off
setlocal
set "ROOT=%~dp0"
set "NODE=%ROOT%App\resources\node\node.exe"
if not exist "%NODE%" (
  echo [P3 Tiny Watch] Bundled Node not found: %NODE%
  exit /b 1
)
pushd "%ROOT%"
"%NODE%" --test "plugins\dsh-p3-tiny-watch\test\*.test.mjs"
set "CODE=%ERRORLEVEL%"
popd
exit /b %CODE%
