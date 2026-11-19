@echo off
chcp 65001 >nul
cd /d "%~dp0"
where.exe node.exe >nul 2>&1
if errorlevel 1 (
  echo Для запуска игры требуется Node.js 20 или новее.
  pause
  exit /b 1
)
node.exe server.mjs
if errorlevel 1 pause
