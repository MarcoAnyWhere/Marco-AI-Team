@echo off
setlocal EnableExtensions
title Marco AI Team - GitHub Bootstrap
cd /d "%~dp0"

echo.
echo ============================================
echo  Marco AI Team - GitHub Bootstrap
echo ============================================
echo.
echo Repository: https://github.com/MarcoAnyWhere/Marco-AI-Team
echo.
echo Questo passaggio pubblica SOLO il programma.
echo La cartella data NON viene caricata su GitHub.
echo.

where git >nul 2>nul
if errorlevel 1 (
  echo ERRORE: Git non trovato.
  pause
  exit /b 1
)

set "PUB=%TEMP%\Marco-AI-Team-publish"
if exist "%PUB%" rmdir /s /q "%PUB%"

echo [1/5] Clono il repository...
git clone "https://github.com/MarcoAnyWhere/Marco-AI-Team.git" "%PUB%"
if errorlevel 1 goto :fail

echo [2/5] Copio i file applicativi...
copy /y "server.js" "%PUB%\server.js" >nul
copy /y "updater.js" "%PUB%\updater.js" >nul
copy /y "start.cmd" "%PUB%\start.cmd" >nul
copy /y "stop.cmd" "%PUB%\stop.cmd" >nul
copy /y "setup-local-model.cmd" "%PUB%\setup-local-model.cmd" >nul
copy /y "README.md" "%PUB%\README.md" >nul
copy /y ".gitignore" "%PUB%\.gitignore" >nul
copy /y "latest.json" "%PUB%\latest.json" >nul

if not exist "%PUB%\public" mkdir "%PUB%\public"
copy /y "public\index.html" "%PUB%\public\index.html" >nul

cd /d "%PUB%"
git config user.name "MarcoAnyWhere"
git config user.email "MarcoAnyWhere@users.noreply.github.com"

echo [3/5] Preparo il commit...
git add server.js updater.js start.cmd stop.cmd setup-local-model.cmd README.md .gitignore latest.json public\index.html
git diff --cached --quiet
if not errorlevel 1 (
  echo Repository gia allineato: nessuna modifica da pubblicare.
  goto :done
)

git commit -m "Marco AI Team v3.3.0 bootstrap"
if errorlevel 1 goto :fail

echo [4/5] Pubblico su GitHub...
echo.
echo Se Git chiede l'accesso, completa UNA VOLTA il login nel browser.
echo.
git push origin main
if errorlevel 1 goto :fail

:done
echo.
echo [5/5] GitHub configurato correttamente.
echo.
echo Da ora Marco AI Team puo leggere gli aggiornamenti dal repository.
echo Puoi chiudere questa finestra e avviare start.cmd.
echo.
pause
exit /b 0

:fail
echo.
echo ERRORE durante il bootstrap GitHub.
echo Copia o fotografa il messaggio sopra e mandamelo.
echo.
pause
exit /b 1
