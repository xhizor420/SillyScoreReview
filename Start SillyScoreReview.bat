@echo off
setlocal
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js was not found on this PC.
  echo Install it from https://nodejs.org/ ^(the LTS version^), then run this file again.
  pause
  exit /b 1
)

if not exist node_modules (
  echo Installing dependencies, this only happens once...
  call npm install
  if errorlevel 1 (
    echo.
    echo npm install failed - see the errors above.
    pause
    exit /b 1
  )
)

if not exist config.json (
  copy config.example.json config.json >nul
  echo Created config.json. You can set everything else - folder, NanoGPT key, model - from the Settings panel in the browser.
)

echo.
echo Starting SillyScoreReview...
start "SillyScoreReview server" cmd /k "npm run serve"
timeout /t 3 /nobreak >nul
start "" http://localhost:4180

echo.
echo The server is running in the other window titled "SillyScoreReview server".
echo Close that window (or press Ctrl+C in it) to stop it. This window can be closed now.
pause
endlocal
