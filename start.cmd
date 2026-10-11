@echo off
setlocal
cd /d "%~dp0"
where node >nul 2>&1
if errorlevel 1 (
  echo ERRORE: Node.js non trovato nel PATH.
  exit /b 2
)
node "%~dp0background-launcher.js" --check
if errorlevel 2 (
  echo ERRORE: impossibile verificare la porta 3210.
  exit /b 2
)
if not errorlevel 1 (
  start "" http://127.0.0.1:3210
  exit /b 0
)
where git >nul 2>&1
if errorlevel 1 (
  echo ERRORE: Git non trovato.
  pause
  exit /b 1
)
if not exist ".git" git init >nul 2>&1
echo Avvio Marco AI Team v3.3.23 - ZERO COSTI VARIABILI
set "PORT=3210"
start "" http://127.0.0.1:3210
node "%~dp0server.js"
echo Server terminato.
pause

