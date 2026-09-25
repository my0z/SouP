# K리그 프로토 배당 웹 (kl.usb.kr)

베트맨 프로토 승부식의 K리그 배당을 모아 보여주는 페이지입니다.

```
국내 PC (betman_collector.py) ──POST /ingest──▶ Cloudflare Worker ──▶ D1 kleague-odds
                                                     │
                                          https://kl.usb.kr 에서 조회
```

베트맨은 해외 IP를 막습니다. 그래서 수집은 국내 PC가 하고 Worker는 저장과 화면만 맡습니다.

## 1. Worker 배포 (한 번만)
D1 데이터베이스와 테이블은 이미 만들어 두었습니다.
```bash
cd kleague/worker
npm install
npx wrangler login
npx wrangler secret put INGEST_TOKEN   # 수집기와 같이 쓸 긴 임의 문자열
npm run deploy
```
DNS에 `kl` 레코드가 이미 있으면 배포가 실패하니 대시보드에서 먼저 지워야 합니다.

## 2. 국내 PC에서 수집기 실행
Python 3.8 이상이 필요합니다. 베트맨은 브라우저가 아닌 접속을 끊으므로 Chrome 처럼 접속하는 `curl_cffi` 를 설치합니다.
```bash
python -m pip install curl_cffi
cd kleague
python3 betman_collector.py --dry-run          # 전송 없이 동작 확인
export INGEST_URL=https://kl.usb.kr/ingest
export INGEST_TOKEN=위에서_정한_토큰
python3 betman_collector.py
```
- 최근 회차를 자동으로 찾아갑니다. 마지막 회차는 `.betman_state.json` 에 저장됩니다
- 직전 회차도 같이 받아서 경기 결과가 반영됩니다
- K리그가 없는 회차(A매치 기간 등)에는 보낼 것이 없어서 대상 0행으로 끝납니다
- 다른 리그로 시험하려면 `--league "아시안게임"` 처럼 리그명 정규식을 주면 됩니다

### 주기 실행 (리눅스 cron 예시)
```cron
*/30 * * * * cd /path/to/SouP/kleague && INGEST_URL=https://kl.usb.kr/ingest INGEST_TOKEN=토큰 python3 betman_collector.py >> betman.log 2>&1
```
로그는 UTF-8 이라 PowerShell 에서는 `Get-Content betman.log -Encoding utf8` 로 봐야 글자가 깨지지 않습니다.

Windows는 `kleague/run_betman.bat` 에 토큰을 넣고 `install_task.bat` 을 한 번 실행하면 30분마다 돌아갑니다. 토큰을 넣은 bat 파일은 커밋하지 마세요.
수집기는 시작 전 0~5분 무작위로 기다리고 한 번에 2~3회차만 조회합니다. 모든 요청이 실패하면 2시간부터 최대 24시간까지 스스로 쉽니다.

## 과거 회차 일괄 수집
프로토는 마감된 회차도 최종 배당과 결과를 돌려줍니다. 2021년 1회차부터 지금까지를 천천히 받아 둡니다.
```bash
python3 betman_collector.py --backfill 2021            # 한 번 실행에 25회차씩 이어받기
python3 betman_collector.py --backfill 2021 --dry-run  # 전송 없이 확인
```
- 한 번 실행에 25회차씩 받습니다. 해외 리그까지 받으면 Cloudflare 무료 쓰기 한도(하루 10만 행)에 가까워지기 때문입니다
- 진행 위치는 `.betman_backfill.json` 에 저장되어 다음 실행이 이어서 합니다
- 요청 사이 8~20초를 쉬고 빈 회차가 3번 이어지면 다음 해로 넘어갑니다
- 접속이 3번 연속 실패하면 6시간 쉽니다
- Windows는 `install_backfill.bat` 을 한 번 실행하면 8시간마다 25회차씩 받습니다. 토큰은 `run_betman.bat` 에서 읽습니다
- 과거 회차는 마감 배당만 남습니다. 배당 변동 이력은 실시간 수집분에만 있습니다

## 분석용 내보내기
수집 대상은 K리그와 toto 모델의 해외 리그 9개(EPL EFL챔 라리가 세리에A 분데스리 프리그1 에레디비 J1리그 MLS)입니다. 화면에는 K리그만 보입니다.
```
https://kl.usb.kr/export.csv                                  # 최근 100회차 전체
https://kl.usb.kr/export.csv?gm_from=210001&gm_to=210100      # 회차 범위 (한 번에 100회차)
https://kl.usb.kr/export.csv?league=EPL,라리가                 # 리그 짧은 이름
https://kl.usb.kr/api/rounds                                  # 회차별 리그별 경기 수
```
게임 유형마다 첫 배당(w0 d0 l0)과 마지막 배당(w d l)과 결과와 점수가 한 줄씩 들어 있습니다. 엑셀에서 바로 열립니다.

## 배당 변경 표시
- 맨 위 **최근 24시간 배당 변경** 목록에 바뀐 경기와 이전 값→새 값이 최신순으로 나옵니다
- 바뀐 경기 카드는 주황 테두리와 `배당 변경 N건` 배지가 붙습니다
- 바뀐 칸은 노란 배경에 이전 값이 취소선으로 함께 보입니다. 핸디캡과 언더오버 기준값이 바뀌면 `2.5→3.5` 처럼 보입니다
- 처음 발표된 배당은 `새 배당` 배지가 붙습니다

## 구매할 때
- 게임 이름 앞 숫자는 **베트맨 경기 번호**입니다. 베트맨 화면이나 판매점 용지에서 이 번호로 찾습니다
- 경기 카드의 **베트맨 구매** 링크는 그 회차의 베트맨 구매 화면을 엽니다. 끝난 경기는 **베트맨 결과** 로 마감 회차 화면을 엽니다
- **경기 정보** 링크는 네이버에서 두 팀 경기 정보를 검색합니다
- 맨 위 배당 변경 목록의 경기 이름을 누르면 그 경기 카드로 이동합니다
- `단폴` 배지가 있으면 그 경기 하나만 살 수 있습니다. 없으면 다른 경기와 2경기 이상 묶어야 합니다

## 예상 vs 결과
- 화면 아래 **배당 예상 vs 실제 결과** 에서 K리그 승무패 마감 배당이 실제로 얼마나 맞았는지 봅니다
- 예상은 마진을 뺀 배당 확률이고 실제는 적중 비율입니다. 차이가 + 면 배당이 예상한 것보다 자주 맞았다는 뜻입니다
- 수익률은 매 경기 같은 금액을 걸었을 때 기준입니다
- 정배와 무승부와 역배 그리고 정배 배당 구간별과 시즌별로 나눠 보여 줍니다
- 끝난 경기 카드에는 `정배 적중` 또는 `정배 X 실패` 배지가 붙습니다
- JSON 은 `/api/accuracy` 로 받습니다

## 저장 방식
- `proto_matches`: 경기의 게임 유형(승무패 핸디캡 언더오버 등) 하나당 한 행. 상태와 결과와 점수가 갱신됩니다
- `proto_odds`: 배당이 직전 값과 달라질 때만 한 줄씩 쌓입니다. 화면의 ▲▼ 는 첫 수집 대비 변동입니다

## 응답 구조 메모
`gameInfoInq.do` 는 `{"gmId":"G101","gmTs":260113}` 을 POST 하면 `compSchedules.keys` 와 `compSchedules.datas` 를 줍니다.
- `winAllot drawAllot loseAllot`: 배당 (0 이면 아직 미발표)
- `winHandi`: 핸디캡 또는 언더오버 기준값
- `gameResult`: 0 = 왼쪽(승 또는 언더) 1 = 무 2 = 오른쪽(패 또는 오버) 4 = 적특
- `protoStatus`: 4 = 결과 확정
