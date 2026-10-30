@echo off
chcp 65001 >nul
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0setup.ps1" %*
set "RC=%ERRORLEVEL%"
if "%~1"=="" pause
exit /b %RC%
