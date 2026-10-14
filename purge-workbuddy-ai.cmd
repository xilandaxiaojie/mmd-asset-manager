@echo off
setlocal
chcp 65001 >nul

set "TARGET=C:\Users\xilan\.workbuddy-ai"
set "APPDIR=D:\Apps\DSH Desktop"
set "LOG=%~dp0purge-workbuddy-ai.log"

echo ============================================>"%LOG%"
echo [%date% %time%] 开始清理>>"%LOG%"
echo 目标: %TARGET%>>"%LOG%"

echo.
echo [1/4] 关闭 DSH Desktop ...
taskkill /F /IM "DSH Desktop.exe" /T >nul 2>&1
taskkill /F /IM "DSH Desktop.exe" >nul 2>&1

rem 等待进程真正退出并释放句柄
timeout /t 4 /nobreak >nul

echo [2/4] 等待文件句柄释放 ...
set /a tries=0
:waitloop
set /a tries+=1
tasklist /FI "IMAGENAME eq DSH Desktop.exe" 2>nul | find /I "DSH Desktop.exe" >nul
if not errorlevel 1 (
    if %tries% GEQ 15 goto forcestate
    timeout /t 1 /nobreak >nul
    goto waitloop
)
goto dodelete

:forcestate
echo     警告: 仍有 DSH Desktop 进程存活，继续尝试删除。>>"%LOG%"

:dodelete
echo [3/4] 删除文件夹 ...
if not exist "%TARGET%" (
    echo     文件夹已不存在。>>"%LOG%"
    goto relaunch
)

rd /s /q "%TARGET%" >>"%LOG%" 2>&1

if exist "%TARGET%" (
    echo     rd 未完全删除，改用 takeown/icacls 提权后重试 ...>>"%LOG%"
    takeown /F "%TARGET%" /R /D Y >>"%LOG%" 2>&1
    icacls "%TARGET%" /grant "%USERNAME%":F /T /C /Q >>"%LOG%" 2>&1
    rd /s /q "%TARGET%" >>"%LOG%" 2>&1
)

if exist "%TARGET%" (
    echo     结果: 删除失败，目标仍存在。>>"%LOG%"
    echo.
    echo     结果: 删除失败，目标仍存在。
) else (
    echo     结果: 删除成功。>>"%LOG%"
    echo.
    echo     结果: 删除成功。
)

:relaunch
echo [4/4] 重新启动 DSH Desktop ...
if exist "%APPDIR%\DSH Desktop.exe" (
    start "" "%APPDIR%\DSH Desktop.exe"
    echo     已启动。>>"%LOG%"
) else (
    echo     未找到 %APPDIR%\DSH Desktop.exe，请手动启动。>>"%LOG%"
    echo     未找到程序，请手动启动。
)

echo [%date% %time%] 结束>>"%LOG%"
echo.
echo 日志: %LOG%
timeout /t 5 /nobreak >nul
endlocal
