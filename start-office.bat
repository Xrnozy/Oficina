@echo off
rem officeChain launcher — double-click to start the daemon and open the UI.
cd /d "%~dp0"
title officeChain daemon

rem Already running? Just open the UI.
curl -s -o nul --max-time 2 http://localhost:4780/api/health
if %errorlevel%==0 (
  echo officeChain is already running on http://localhost:4780
  start "" http://localhost:4780
  exit /b 0
)

if not exist node_modules (
  echo Installing dependencies...
  call npm install || goto :fail
)

if not exist ui\dist\index.html (
  echo Building UI...
  call npm run build -w ui || goto :fail
)

rem Open the browser once the daemon has had a moment to come up.
start "" /min cmd /c "timeout /t 3 /nobreak >nul & start """" http://localhost:4780"

echo Starting daemon on http://localhost:4780  (close this window to stop)
call npm run dev
goto :eof

:fail
echo.
echo Something failed — see messages above.
pause
