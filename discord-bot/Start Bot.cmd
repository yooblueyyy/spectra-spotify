@echo off
title Spectra bot
cd /d "%~dp0"
if not exist .env (
  echo.
  echo   No .env yet. Copy .env.example to .env and fill it in first.
  echo.
  pause
  exit /b 1
)
call npm install --no-audit --no-fund --loglevel=error
node src\deploy-commands.js
node src\index.js
pause
