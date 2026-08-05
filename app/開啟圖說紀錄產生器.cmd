@echo off
chcp 65001 >nul
rem Double-click to start the local server (if needed) and open the app.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0tools\start.ps1"
if errorlevel 1 pause
