@echo off
REM Run the test suite (uses the bundled Electron; no npm/node required).
REM   test.cmd            run all
REM   test.cmd asset      only test files whose name contains "asset"
setlocal
cd /d "%~dp0"
set "ELECTRON_RUN_AS_NODE="
set "AMM_UI_TEST="
set "AMM_TEST_MODE="
set "AMM_DATA_DIR="
"%~dp0node_modules\electron\dist\electron.exe" "%~dp0tests\run.js" %*
exit /b %ERRORLEVEL%
