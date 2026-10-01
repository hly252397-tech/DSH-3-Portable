@echo off
rem ============================================================
rem Portable Ollama launcher for DSH Portable 3
rem Program : Data\ollama\   (extracted from ollama-windows-amd64.zip)
rem Models  : Data\ollama-models\  (same dir DSH's ollama-local route uses)
rem Idempotent: skips start when 127.0.0.1:11434 already answers.
rem ============================================================
setlocal
set "ROOT=%~dp0"
set "OLLAMA_EXE=%ROOT%Data\ollama\ollama.exe"
set "OLLAMA_MODELS=%ROOT%Data\ollama-models"
set "OLLAMA_KEEP_ALIVE=2h"
set "OLLAMA_FLASH_ATTENTION=1"
set "OLLAMA_KV_CACHE_TYPE=q8_0"
set "OLLAMA_CONTEXT_LENGTH=8192"

if not exist "%OLLAMA_EXE%" (
    echo [ERROR] Ollama program not found: %OLLAMA_EXE%
    echo Re-extract ollama-windows-amd64.zip into Data\ollama\ .
    pause
    exit /b 1
)
if not exist "%OLLAMA_MODELS%" mkdir "%OLLAMA_MODELS%"

curl -s -o nul -m 2 http://127.0.0.1:11434/api/tags >nul 2>&1
if %errorlevel% equ 0 (
    echo Ollama is already running at http://127.0.0.1:11434
) else (
    echo Starting portable Ollama: %OLLAMA_EXE%
    start "Ollama Serve" /min "%OLLAMA_EXE%" serve
    timeout /t 6 /nobreak >nul
)

echo.
echo Models dir : %OLLAMA_MODELS%
echo.
echo Installed models:
"%OLLAMA_EXE%" list
echo.
echo OpenAI-compatible endpoint (http://127.0.0.1:11434/v1/models):
curl -s http://127.0.0.1:11434/v1/models
echo.
pause
