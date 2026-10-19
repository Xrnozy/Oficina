@echo off
rem Oficina tray launcher — puts an icon in the system tray; right-click it
rem to open the UI or quit the daemon. No console window is left behind.
cd /d "%~dp0"

if not exist node_modules (
  echo Installing dependencies...
  call npm install || goto :fail
)

if not exist ui\dist\index.html (
  echo Building UI...
  call npm run build -w ui || goto :fail
)

start "" powershell -NoProfile -STA -ExecutionPolicy Bypass -WindowStyle Hidden -File "%~dp0office-tray.ps1"
exit /b 0

:fail
echo.
echo Something failed — see messages above.
pause
