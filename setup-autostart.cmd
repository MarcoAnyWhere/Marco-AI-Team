@echo off
setlocal
cd /d "%~dp0"
where node >nul 2>&1
if errorlevel 1 (
  echo ERRORE: Node.js non trovato nel PATH.
  exit /b 2
)
node "%~dp0background-launcher.js" --setup
exit /b %errorlevel%
