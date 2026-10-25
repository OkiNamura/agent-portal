@echo off
rem Portable git wrapper: sets GIT_SSH to the key in .tools\ssh2
setlocal
cd /d "%~dp0"
if not exist ".tools\git\cmd\git.exe" (
  echo Portable git not found in .tools\git
  exit /b 1
)
set "GIT_SSH=%CD%\.tools\ssh2\git-ssh.cmd"
".tools\git\cmd\git.exe" %*
