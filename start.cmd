@echo off
setlocal
cd /d "%~dp0"

echo.
echo ==============================================
echo  Marco AI Team v3.2.1 - ZERO COSTI VARIABILI
echo ==============================================
echo.

where node >nul 2>&1 || (
  echo ERRORE: Node.js non trovato.
  pause
  exit /b 1
)

where git >nul 2>&1 || (
  echo ERRORE: Git non trovato.
  pause
  exit /b 1
)

if not exist ".git" git init >nul 2>&1

echo Controllo eventuale vecchio server sulla porta 3210...
for /f "tokens=5" %%P in ('netstat -ano ^| findstr ":3210" ^| findstr "LISTENING"') do (
  echo Arresto processo precedente PID %%P...
  taskkill /PID %%P /F >nul 2>&1
)

echo Avvio Marco AI Team v3.2.1...
start "" http://127.0.0.1:3210
node server.js

echo.
echo Server terminato.
pause
