@echo off
chcp 65001 > nul
cd /d "%~dp0listagent-app"

echo [INFO] Installing / updating dependencies...
call npm install
if %errorlevel% neq 0 (
    echo [ERROR] npm install failed.
    pause
    exit /b 1
)

echo.
echo [INFO] Building ListAgent 1.0.0 portable executable...
echo.
call npx tauri build --no-bundle
if %errorlevel% neq 0 (
    echo [ERROR] Build failed.
    pause
    exit /b 1
)

set EXE=src-tauri\target\release\ListAgent.exe
if not exist "%EXE%" (
    echo [ERROR] Executable not found: %EXE%
    pause
    exit /b 1
)

copy /y "%EXE%" "..\ListAgent.exe" > nul
echo.
echo [OK] Build complete.
echo Output: %~dp0ListAgent.exe
echo.
pause
