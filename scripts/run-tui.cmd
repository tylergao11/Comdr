@echo off
cd /d "%~dp0.."
echo Starting Comdr TUI...
echo If you see an error about "Raw mode", this terminal doesn't support TTY.
echo.
node scripts\run-tui.mjs 2>&1
echo.
echo --- Comdr exited (code: %ERRORLEVEL%) ---
pause
