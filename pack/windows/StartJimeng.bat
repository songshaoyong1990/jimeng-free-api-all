@echo off
chcp 65001 >nul
setlocal EnableExtensions
cd /d "%~dp0"

set "ROOT=%~dp0"
set "NODE=%ROOT%runtime\node.exe"
set "PID_FILE=%ROOT%data\service.pid"
set "PORT=8000"

if not exist "%ROOT%data" mkdir "%ROOT%data"
if not exist "%ROOT%logs" mkdir "%ROOT%logs"
if not exist "%ROOT%tmp" mkdir "%ROOT%tmp"

if not exist "%NODE%" (
    echo [错误] 未找到内置 Node 运行时，请重新下载完整安装包。
    pause
    exit /b 1
)

if not exist "%ROOT%dist\index.js" (
    echo [错误] 程序文件不完整，请重新下载完整安装包。
    pause
    exit /b 1
)

if exist "%PID_FILE%" (
    for /f "usebackq delims=" %%P in ("%PID_FILE%") do (
        tasklist /FI "PID eq %%P" 2>nul | find /I "node.exe" >nul
        if not errorlevel 1 (
            echo 服务已在运行中。
            start "" "http://127.0.0.1:%PORT%/"
            pause
            exit /b 0
        )
    )
    del /f /q "%PID_FILE%" >nul 2>&1
)

echo ========================================
echo   即梦 AI 免费接口服务
echo   正在启动，请稍候...
echo ========================================
echo.
echo 启动后浏览器会自动打开管理页面。
echo 请勿关闭标题为「即梦服务运行中」的窗口。
echo.

set "SERVER_ENV=dev"
set "DB_PATH=%ROOT%data\jimeng.db"
set "PATH=%ROOT%runtime;%PATH%"

start "" "http://127.0.0.1:%PORT%/"
start "即梦服务运行中" /min cmd /c "cd /d "%ROOT%." && "%NODE%" --enable-source-maps --no-node-snapshot dist\index.js & echo. & echo 服务已退出，按任意键关闭... & pause>nul"

timeout /t 3 /nobreak >nul

for /f "tokens=5" %%P in ('netstat -ano ^| findstr ":%PORT% " ^| findstr LISTENING') do (
    echo %%P> "%PID_FILE%"
    goto :started
)

:started
echo 管理页面: http://127.0.0.1:%PORT%/
echo 停止服务请双击 StopJimeng.bat
pause
exit /b 0
