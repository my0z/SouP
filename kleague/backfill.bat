@echo off
chcp 65001 > nul
rem 과거 회차 일괄 수집. 실행할 때마다 50회차씩 이어서 받는다
rem 토큰은 run_betman.bat 에 넣어 둔 값을 그대로 읽어 온다
cd /d "%~dp0"
for /f "tokens=1,* delims==" %%a in ('findstr /b /c:"set INGEST_URL=" run_betman.bat') do set INGEST_URL=%%b
for /f "tokens=1,* delims==" %%a in ('findstr /b /c:"set INGEST_TOKEN=" run_betman.bat') do set INGEST_TOKEN=%%b
set PYTHONIOENCODING=utf-8
python betman_collector.py --backfill 2021 >> backfill.log 2>&1
