@echo off
cd /d "%~dp0"
if not exist ".venv\Scripts\pythonw.exe" (
    echo Aurora is not set up yet - running Setup.bat first.
    call Setup.bat || exit /b 1
)
start "" ".venv\Scripts\pythonw.exe" -m aurora %*
