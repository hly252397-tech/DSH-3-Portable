@echo off
chcp 65001 >nul
setlocal EnableExtensions
title 重建宏建云技能链接

rem ─────────────────────────────────────────────────────────────
rem  作用：把用户级技能入口 hongjian-erp 重新链接到便携盘内的实体。
rem
rem  何时用：便携盘换盘符（G: → H:）后，Windows 的目录链接存的是绝对
rem          路径、跨盘无法用相对路径 —— 链接会断（表现为：技能还在
rem          技能列表里，但读不到内容）。双击本脚本即可修复。
rem
rem  安全：只删除「目录链接」；若同名位置是真实目录，一律拒绝，绝不删真目录。
rem  逻辑本体：.workbuddy\skills\hongjian-erp\scripts\fix-link.cjs
rem ─────────────────────────────────────────────────────────────

set "PORTABLE=%~dp0"
if "%PORTABLE:~-1%"=="\" set "PORTABLE=%PORTABLE:~0,-1%"
set "TARGET=%PORTABLE%\.workbuddy\skills\hongjian-erp"
set "FIXER=%TARGET%\scripts\fix-link.cjs"
set "NODEEXE=%PORTABLE%\Tools\node\node.exe"

if not exist "%FIXER%" (
  echo.
  echo   [错误] 找不到修复脚本：
  echo          %FIXER%
  echo.
  echo   请确认本脚本位于便携盘根目录（与 .workbuddy 文件夹同级），
  echo   且技能包 .workbuddy\skills\hongjian-erp\ 完整。
  goto :done
)

if not exist "%NODEEXE%" (
  echo [错误] 找不到经清单校验的 Node：%NODEEXE%
  goto :done
)

"%NODEEXE%" "%PORTABLE%\scripts\gate-node-run.mjs" "%FIXER%"

:done
echo.
pause
endlocal
