@echo off
rem Backfill past Proto rounds, 15 rounds per run (more sports means more rows), resuming each time.
rem The token is read from run_betman.bat.
cd /d "%~dp0"
for /f "tokens=1,* delims==" %%a in ('findstr /b /c:"set INGEST_URL=" run_betman.bat') do set INGEST_URL=%%b
for /f "tokens=1,* delims==" %%a in ('findstr /b /c:"set INGEST_TOKEN=" run_betman.bat') do set INGEST_TOKEN=%%b
set PYTHONIOENCODING=utf-8
python betman_collector.py --backfill 2021 --rounds 15 >> backfill.log 2>&1
