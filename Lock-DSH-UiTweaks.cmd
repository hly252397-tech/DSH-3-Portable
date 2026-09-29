@echo off
setlocal
chcp 65001 >nul
set "ROOT=%~dp0"
echo [ui-tweaks] 重新加锁四份 client.js（防误覆盖回退）...
attrib +R "%ROOT%customizations\ui-tweaks\lib\client.js"
attrib +R "%ROOT%Data\DSH-generations\v5-020rc1\home\profiles\web\local\dsh-ui-tweaks\lib\client.js"
attrib +R "%ROOT%Data\DSH-generations\v4-rc2b\home\profiles\web\local\dsh-ui-tweaks\lib\client.js"
attrib +R "%ROOT%Data\DSH\profiles\web\local\dsh-ui-tweaks\lib\client.js"
echo [ui-tweaks] 已复锁。
pause
endlocal
