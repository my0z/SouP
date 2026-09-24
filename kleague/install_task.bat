@echo off
chcp 65001 > nul
rem 30분마다 run_betman.bat 을 실행하는 작업을 등록합니다
schtasks /Create /F /SC MINUTE /MO 30 /TN "KLeagueBetman" /TR "\"%~dp0run_betman.bat\""
echo.
echo 등록 완료. 해제하려면: schtasks /Delete /TN KLeagueBetman /F
pause
