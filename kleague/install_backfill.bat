@echo off
rem The PC is on only from about 21:00 to 05:00.
rem Run backfill.bat at 21:30, 00:30 and 03:30. A run missed while the PC was off starts when it is back on.
powershell -NoProfile -Command "$a = New-ScheduledTaskAction -Execute '%~dp0backfill.bat' -WorkingDirectory '%~dp0'; $t = @((New-ScheduledTaskTrigger -Daily -At 21:30), (New-ScheduledTaskTrigger -Daily -At 00:30), (New-ScheduledTaskTrigger -Daily -At 03:30)); $s = New-ScheduledTaskSettingsSet -StartWhenAvailable; Register-ScheduledTask -TaskName KLeagueBetmanBackfill -Action $a -Trigger $t -Settings $s -Force | Out-Null"
echo.
echo Done. Check: Get-ScheduledTask KLeagueBetmanBackfill ^| Get-ScheduledTaskInfo
echo Progress: Get-Content backfill.log -Encoding utf8 -Tail 20
echo When finished: schtasks /Delete /TN KLeagueBetmanBackfill /F
pause
