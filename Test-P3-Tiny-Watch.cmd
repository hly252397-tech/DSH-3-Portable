@echo off
setlocal
set "ROOT=%~dp0"
set "NODE=%ROOT%Tools\node\node.exe"
if not exist "%NODE%" (
  echo [P3 Tiny Watch] Bundled Node not found: %NODE%
  exit /b 1
)
pushd "%ROOT%"
"%NODE%" "%ROOT%scripts\gate-node-run.mjs" --test "plugins\dsh-p3-tiny-watch\test\*.test.mjs"
set "CODE=%ERRORLEVEL%"
popd
exit /b %CODE%
