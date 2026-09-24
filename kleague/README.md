# K리그 배당 수집기

> 베트맨 프로토 배당 수집기(`betman_collector.py`)와 웹 화면(kl.usb.kr)은 [`worker/README.md`](worker/README.md) 를 보세요.
> 아래는 API-Football 기반 수집기 설명입니다.

API-Football 무료 플랜으로 K리그1과 K리그2의 일정과 결과와 배당을 받아 SQLite(`kleague_odds.db`)에 쌓습니다.
API-Football은 배당을 경기 후 7일만 보관하므로 직접 주기적으로 받아 두어야 배당 이력이 남습니다.

## 준비
1. https://dashboard.api-football.com 에 가입하고 API 키를 복사합니다
2. 외부 라이브러리 없이 Python 3.8 이상만 있으면 됩니다

```bash
export API_FOOTBALL_KEY=발급받은키
python odds.py collect   # 일정/결과 갱신 + 배당 스냅샷 저장
python odds.py show      # 7일 안의 경기와 북메이커별 최신 승무패 배당 + 환산 확률
```

## 주기 실행
배당은 약 3시간마다 갱신됩니다. 한 번 실행에 리그당 2~3회 호출하므로 3시간 간격이면 하루 약 50회로 무료 한도(100회) 안에 들어옵니다.

```cron
0 */3 * * * cd /path/to/SouP/kleague && API_FOOTBALL_KEY=키 python3 odds.py collect >> collect.log 2>&1
```

## 테이블
- `fixtures`: 경기 일정과 상태와 최종 스코어 (실행할 때마다 갱신)
- `odds`: 북메이커별 모든 마켓 배당. API 갱신 시각(`api_update`)이 바뀔 때만 새 행이 쌓입니다

## 테스트
```bash
python -m unittest discover -s tests
```
