@echo off
setlocal
title Look At Me! Setup
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0setup_windows.ps1"
if errorlevel 1 (
  echo.
  echo Look At Me! setup failed. Read INSTALLATION.md or copy the error above.
) else (
  echo.
  echo Look At Me! setup completed successfully.
)
echo.
pause
