@echo off
chcp 65001 >nul
setlocal EnableExtensions
cd /d "%~dp0"

set "ROOT=%~dp0"
set "PID_FILE=%ROOT%data\service.pid"
set "PORT=8000"
set "FOUND=0"

if exist "%PID_FILE%" (
    for /f "usebackq delims=" %%P in ("%PID_FILE%") do (
        taskkill /PID %%P /T /F >nul 2>&1
        if not errorlevel 1 set "FOUND=1"
    )
    del /f /q "%PID_FILE%" >nul 2>&1
)

for /f "tokens=5" %%P in ('netstat -ano ^| findstr ":%PORT% " ^| findstr LISTENING') do (
    taskkill /PID %%P /T /F >nul 2>&1
    set "FOUND=1"
)

taskkill /FI "WINDOWTITLE eq 即梦服务运行中*" /T /F >nul 2>&1

if "%FOUND%"=="1" (
    echo 已停止即梦服务。
) else (
    echo 未发现正在运行的即梦服务。
)
pause
exit /b 0
