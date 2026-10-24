@echo off
rem Agent Portal launcher: uses system Node, falls back to the DSH bundled runtime.
cd /d "%~dp0"
setlocal

where node >nul 2>nul && goto run

set "NODE=%USERPROFILE%\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe"
if not exist "%NODE%" (
  echo.
  echo   Node.js не найден.
  echo   Поставь LTS с https://nodejs.org и запусти снова.
  echo.
  pause
  exit /b 1
)
"%NODE%" server.mjs %*
pause
exit /b 0

:run
node server.mjs %*
pause
