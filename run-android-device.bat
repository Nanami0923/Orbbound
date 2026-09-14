@echo off
setlocal
rem Usage: run-android-device.bat [-Serial SERIAL] [-BuildOnly ^| -LogsOnly] [-NoLogStream]

cd /d "%~dp0"
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\run-android-device.ps1" %*
set "exitCode=%ERRORLEVEL%"

if not "%exitCode%"=="0" (
    echo.
    echo [ERROR] Android device test flow stopped with exit code %exitCode%.
)

exit /b %exitCode%
