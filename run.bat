@echo off
chcp 65001 > nul
cd /d "%~dp0listagent-app"

:: Check if node_modules exists
if not exist "node_modules\" (
    echo [INFO] Installing dependencies...
    call npm install
    echo.
)

echo [INFO] Starting ListAgent Tauri app...
echo.
npx tauri dev
pause