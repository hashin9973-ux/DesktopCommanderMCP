@echo off
setlocal
"%~dp0DesktopCommanderBridge.exe" local-api %*
exit /b %ERRORLEVEL%
