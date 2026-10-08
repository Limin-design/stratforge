@echo off
rem One-click Kronos for StratForge: installs on the first run, then starts the server and opens the app.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0start-kronos.ps1" %*
pause
