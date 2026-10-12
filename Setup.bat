@echo off
rem One-time setup: builds the private Python environment Aurora runs in.
setlocal
cd /d "%~dp0"

echo.
echo  Aurora setup
echo  ------------

rem Aurora needs Python 3.12: the audio-capture library has no wheels for 3.13+.
set "PY="
py -3.12 --version >nul 2>&1 && set "PY=py -3.12"
if not defined PY (
    python --version 2>nul | findstr /b /c:"Python 3.12" >nul && set "PY=python"
)
if not defined PY (
    echo  Python 3.12 was not found.
    echo.
    echo  Install it with:   winget install Python.Python.3.12
    echo  or from:           https://www.python.org/downloads/release/python-31210/
    echo.
    echo  Then run Setup.bat again.
    pause
    exit /b 1
)

echo  Using %PY%
if not exist ".venv\Scripts\python.exe" (
    echo  Creating virtual environment...
    %PY% -m venv .venv || goto :fail
)

echo  Installing dependencies, this takes a minute...
".venv\Scripts\python.exe" -m pip install --upgrade pip --quiet || goto :fail
".venv\Scripts\python.exe" -m pip install -r requirements.txt --quiet || goto :fail
".venv\Scripts\python.exe" -m aurora.icon >nul

echo.
choice /c YN /m " Add an Aurora shortcut to your Desktop"
if %errorlevel%==1 powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0Create-Shortcut.ps1"

echo.
echo  Done. Start Aurora with Aurora.bat or the Desktop shortcut.
pause
exit /b 0

:fail
echo.
echo  Setup failed - see the messages above.
pause
exit /b 1
