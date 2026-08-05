@echo off
chcp 65001 >nul
rem Stops the local server. Your records stay in the browser; nothing is deleted.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0tools\stop.ps1"
timeout /t 2 >nul
