@echo off
setlocal
chcp 65001 >nul
set "ROOT=%~dp0"
echo [ui-tweaks] 解除四份 client.js 只读锁（更新动效层前用；改完跑 Lock 复锁）...
attrib -R "%ROOT%customizations\ui-tweaks\lib\client.js"
attrib -R "%ROOT%Data\DSH-generations\v5-020rc1\home\profiles\web\local\dsh-ui-tweaks\lib\client.js"
attrib -R "%ROOT%Data\DSH-generations\v4-rc2b\home\profiles\web\local\dsh-ui-tweaks\lib\client.js"
attrib -R "%ROOT%Data\DSH\profiles\web\local\dsh-ui-tweaks\lib\client.js"
echo [ui-tweaks] 已解锁。更新流程：改源 customizations - 同步三份部署 - 过全量测试 - 跑 Lock-DSH-UiTweaks.cmd 复锁。
pause
endlocal
