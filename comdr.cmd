@echo off
REM Comdr CLI launcher — self-locating (works wherever the repo is cloned)
setlocal
set "COMDR_ROOT=%~dp0"
node "%COMDR_ROOT%packages\ui\dist\cli.js" %*
