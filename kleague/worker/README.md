# K리그 배당 웹 (kl.usb.kr)

Cloudflare Worker 하나가 수집과 조회를 모두 맡습니다.
- 3시간마다 Cron으로 API-Football에서 일정/결과와 배당(승무패, 언더/오버)을 받아 D1 `kleague-odds` 에 쌓습니다
- `https://kl.usb.kr/` 에서 7일 안 경기의 북메이커별 승무패 배당과 첫 수집 대비 변동을 보여줍니다
- `/api/upcoming` 은 같은 데이터를 JSON으로 줍니다

D1 데이터베이스(`b56dde0a-c13e-4119-b69b-ed9ec1054632`)와 테이블은 이미 만들어 두었습니다.

## 배포
```bash
cd kleague/worker
npm install
npx wrangler login
npx wrangler secret put API_FOOTBALL_KEY   # API-Football 키
npx wrangler secret put COLLECT_TOKEN      # 수동 수집용 아무 문자열
npm run deploy
```
배포하면 `kl.usb.kr` 커스텀 도메인이 자동 연결됩니다.
DNS에 `kl` 레코드가 이미 있으면 배포가 실패하니 Cloudflare 대시보드에서 먼저 지워야 합니다.

첫 데이터는 Cron을 기다리지 않고 바로 채울 수 있습니다.
```
https://kl.usb.kr/collect?token=COLLECT_TOKEN값
```

## 호출량
한 번 실행에 리그당 약 3~5회 호출합니다. 3시간 간격이면 하루 약 60회로 무료 한도(100회) 안입니다.
배당 마켓을 늘리려면 `wrangler.toml` 의 `BET_IDS` 를 바꾸되 호출량이 마켓 수만큼 늘어납니다.

## 로컬 검증
```bash
python3 test/mock_api.py 8799 &
printf 'API_BASE=http://127.0.0.1:8799\nAPI_FOOTBALL_KEY=test-key\nCOLLECT_TOKEN=local\n' > .dev.vars
npx wrangler d1 execute kleague-odds --local --file=schema.sql
npx wrangler dev --local
curl "localhost:8787/collect?token=local" && open http://localhost:8787
```
