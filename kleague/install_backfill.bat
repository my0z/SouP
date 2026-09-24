@echo off
rem Register a task that runs backfill.bat every 8 hours (about 150 rounds a day)
schtasks /Create /F /SC HOURLY /MO 8 /TN "KLeagueBetmanBackfill" /TR "\"%~dp0backfill.bat\""
echo.
echo Done. Progress: Get-Content backfill.log -Encoding utf8 -Tail 20
echo When finished: schtasks /Delete /TN KLeagueBetmanBackfill /F
pause
