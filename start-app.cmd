@echo off
REM ============================================================
REM  Launch the Asset Manager (uses the bundled Electron).
REM  No node/npm installation required.
REM
REM  NOTE: This file is kept PURE ASCII on purpose.
REM    cmd.exe parses .cmd files using the console's OEM codepage
REM    (936/GBK on a Chinese Windows). A UTF-8 encoded Chinese
REM    comment gets decoded as GBK -> mojibake -> stray fragments
REM    are executed as commands, and the script fails with
REM    "not recognized as an internal or external command".
REM    Keep every byte in this file ASCII.
REM ============================================================

REM "%~dp0" is the folder this script lives in (with trailing
REM backslash), so it works no matter where it is launched from.
setlocal
cd /d "%~dp0"

set "ELECTRON=%~dp0node_modules\electron\dist\electron.exe"

if not exist "%ELECTRON%" (
  echo.
  echo   [ERROR] Electron runtime not found.
  echo.
  echo   Looked for:
  echo     %ELECTRON%
  echo.
  echo   This folder is missing node_modules, which is normal right
  echo   after downloading the source from GitHub - dependencies are
  echo   not stored in the repository. Install them once:
  echo.
  echo     npm install
  echo.
  echo   or pnpm install / yarn install
  echo.
  echo   Alternative without a package manager: copy a working
  echo   node_modules folder from another machine into this folder.
  echo   Only node_modules\electron is actually needed.
  echo.
  pause
  exit /b 1
)

REM Clear leftover test-mode variables so we do not start in test mode.
set "ELECTRON_RUN_AS_NODE="
set "UI_SMOKE="
set "AMM_UI_TEST="
set "AMM_TEST_MODE="
set "AMM_DATA_DIR="

REM Quote the exe path: the project folder may contain spaces,
REM and an unquoted path would be split into several arguments.
start "" "%ELECTRON%" "%~dp0."
exit /b 0
