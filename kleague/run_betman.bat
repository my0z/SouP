@echo off
rem Betman K League odds collector (run by Windows Task Scheduler)
rem Fill in the token below and save.
set INGEST_URL=https://kl.usb.kr/ingest
set INGEST_TOKEN=PUT_TOKEN_HERE

cd /d "%~dp0"
set PYTHONIOENCODING=utf-8
python betman_collector.py >> betman.log 2>&1
