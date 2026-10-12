@echo off
rem Same app, but with a console window so errors are visible.
cd /d "%~dp0"
".venv\Scripts\python.exe" -m aurora %*
echo.
echo Aurora exited. Press any key to close.
pause >nul
