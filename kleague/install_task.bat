@echo off
rem Register a task that runs run_betman.bat every 30 minutes
schtasks /Create /F /SC MINUTE /MO 30 /TN "KLeagueBetman" /TR "\"%~dp0run_betman.bat\""
echo.
echo Done. To remove: schtasks /Delete /TN KLeagueBetman /F
pause
