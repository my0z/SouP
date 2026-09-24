@echo off
chcp 65001 > nul
rem 8시간마다 backfill.bat 을 실행하는 작업을 등록합니다 (하루 약 150회차)
schtasks /Create /F /SC HOURLY /MO 8 /TN "KLeagueBetmanBackfill" /TR "\"%~dp0backfill.bat\""
echo.
echo 등록 완료. 진행 상황: Get-Content backfill.log -Encoding utf8 -Tail 20
echo 다 받으면 해제: schtasks /Delete /TN KLeagueBetmanBackfill /F
pause
