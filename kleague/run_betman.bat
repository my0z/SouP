@echo off
chcp 65001 > nul
rem 베트맨 K리그 배당 수집 (Windows 작업 스케줄러용)
rem 아래 두 줄의 값을 채운 뒤 저장하세요
set INGEST_URL=https://kl.usb.kr/ingest
set INGEST_TOKEN=여기에_토큰

cd /d "%~dp0"
set PYTHONIOENCODING=utf-8
python betman_collector.py >> betman.log 2>&1
