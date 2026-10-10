@echo off
echo Arresto Marco AI Team sulla porta 3210...
for /f "tokens=5" %%P in ('netstat -ano ^| findstr ":3210" ^| findstr "LISTENING"') do (
  taskkill /PID %%P /F >nul 2>&1
)
echo Fatto.
pause
