@echo off
title Spectra - Firefox release
cd /d "%~dp0"
node tools\release-firefox.mjs --publish
echo.
pause
