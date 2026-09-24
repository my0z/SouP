"""베트맨 프로토 승부식 배당을 받아 K리그 경기만 골라 kl.usb.kr Worker로 보낸다.

베트맨은 해외 IP를 막으므로 반드시 국내 IP 컴퓨터에서 실행해야 한다.

사용법:
    export INGEST_URL=https://kl.usb.kr/ingest
    export INGEST_TOKEN=Worker에 설정한 토큰
    python3 betman_collector.py              # 최근 회차 자동 탐색 후 전송
    python3 betman_collector.py --dry-run    # 전송 없이 결과만 출력
    python3 betman_collector.py --gmts 260113 --league "아시안게임"   # 특정 회차와 리그로 시험
"""
import argparse
import datetime
import json
import os
import re
import sys
import time
import urllib.request

BETMAN_URL = "https://www.betman.co.kr/buyPsblGame/gameInfoInq.do"
PROTO_GM_ID = "G101"  # 프로토 승부식
STATE_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), ".betman_state.json")
HEADERS = {
    "Accept": "application/json, text/javascript, */*; q=0.01",
    "Content-Type": "application/json; charset=UTF-8",
    "Origin": "https://www.betman.co.kr",
    "X-Requested-With": "XMLHttpRequest",
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
                  "(KHTML, like Gecko) Chrome/153.0.0.0 Safari/537.36",
}
KST = datetime.timezone(datetime.timedelta(hours=9))


try:
    # 베트맨은 브라우저가 아닌 TLS 접속을 끊는다. curl_cffi 가 있으면 Chrome 처럼 접속한다.
    from curl_cffi import requests as cffi_requests
except ImportError:
    cffi_requests = None

_session = None


def _cffi_session():
    global _session
    if _session is None:
        _session = cffi_requests.Session(impersonate="chrome")
        _session.get("https://www.betman.co.kr/main/mainPage/gamebuy/buyableGameList.do", timeout=30)
    return _session


def fetch_round(gm_ts, retries=2):
    """베트맨이 가끔 연결을 끊으므로 몇 번 다시 시도한다."""
    for attempt in range(retries + 1):
        try:
            return _fetch_round(gm_ts)
        except Exception:
            if attempt == retries:
                raise
            time.sleep(3)


def _fetch_round(gm_ts):
    payload = {"gmId": PROTO_GM_ID, "gmTs": gm_ts, "gameYear": "",
               "_sbmInfo": {"_sbmInfo": {"debugMode": "false"}}}
    headers = {**HEADERS, "Referer": "https://www.betman.co.kr/main/mainPage/gamebuy/"
                                     f"gameSlip.do?gmId={PROTO_GM_ID}&gmTs={gm_ts}"}
    if cffi_requests:
        # User-Agent 는 impersonate 값과 맞아야 하므로 직접 넣지 않는다
        headers.pop("User-Agent")
        resp = _cffi_session().post(BETMAN_URL, json=payload, headers=headers, timeout=30)
        resp.raise_for_status()
        return resp.json()
    req = urllib.request.Request(BETMAN_URL, data=json.dumps(payload).encode(), headers=headers, method="POST")
    with urllib.request.urlopen(req, timeout=30) as resp:
        return json.load(resp)


def rows_of(data):
    """compSchedules 의 keys/datas 를 dict 목록으로 바꾼다. 회차가 없으면 빈 목록."""
    comp = (data or {}).get("compSchedules") or {}
    keys, datas = comp.get("keys") or [], comp.get("datas") or []
    return [dict(zip(keys, row)) for row in datas]


def filter_rows(rows, league_pattern):
    pat = re.compile(league_pattern)
    return [r for r in rows if r.get("itemCode") == "SC" and pat.search(r.get("leagueName") or "")]


def candidate_rounds(last):
    """직전 회차(결과 갱신용)부터 다음 몇 회차와 해가 바뀐 경우의 1회차를 후보로 돌려준다."""
    year, no = divmod(last, 10000)
    cands = [year * 10000 + no + i for i in range(-1, 4) if no + i > 0]
    this_year = datetime.datetime.now(KST).year % 100
    if this_year > year:
        cands += [this_year * 10000 + i for i in range(1, 4)]
    return cands


def load_state():
    try:
        with open(STATE_FILE) as f:
            return json.load(f)
    except (OSError, ValueError):
        return {}


def save_state(state):
    with open(STATE_FILE, "w") as f:
        json.dump(state, f)


def ingest(url, token, payload):
    req = urllib.request.Request(url, data=json.dumps(payload).encode(), method="POST",
                                 headers={"Content-Type": "application/json",
                                          "Authorization": f"Bearer {token}",
                                          # Cloudflare 가 Python 기본 User-Agent 를 막는 경우가 있다
                                          "User-Agent": "kleague-betman-collector/1.0"})
    with urllib.request.urlopen(req, timeout=30) as resp:
        return resp.read().decode()


def main(argv=None):
    p = argparse.ArgumentParser(description="베트맨 프로토 승부식 K리그 배당 수집기")
    p.add_argument("--gmts", type=int, help="특정 회차만 수집 (예: 260113)")
    p.add_argument("--league", default=os.environ.get("LEAGUE_PATTERN", "K리그"),
                   help="leagueName 정규식 (기본값: K리그)")
    p.add_argument("--dry-run", action="store_true", help="Worker로 보내지 않고 출력만")
    args = p.parse_args(argv)

    state = load_state()
    rounds = [args.gmts] if args.gmts else candidate_rounds(state.get("last_gmts", 260113))
    url, token = os.environ.get("INGEST_URL"), os.environ.get("INGEST_TOKEN")
    if not args.dry_run and not (url and token):
        sys.exit("INGEST_URL 과 INGEST_TOKEN 환경변수를 설정하세요. 시험만 하려면 --dry-run")

    newest = state.get("last_gmts", 0)
    for gm_ts in rounds:
        try:
            rows = rows_of(fetch_round(gm_ts))
        except Exception as e:  # 네트워크 오류나 JSON 이 아닌 응답
            print(f"{gm_ts}: 조회 실패 ({e})")
            continue
        if not rows:
            continue
        newest = max(newest, gm_ts)
        picked = filter_rows(rows, args.league)
        print(f"{gm_ts}: 전체 {len(rows)}행 중 대상 {len(picked)}행")
        if not picked:
            continue
        if args.dry_run:
            for r in picked:
                kst = datetime.datetime.fromtimestamp(r["gameDate"] / 1000, KST).strftime("%m-%d %H:%M")
                print(f"  {kst} {r['leagueName']} {r['homeName']} vs {r['awayName']} "
                      f"[{r['betNm']} {r['winHandi']}] {r['winAllot']} {r['drawAllot']} {r['loseAllot']}")
        else:
            try:
                print("  ", ingest(url, token, {"gmTs": gm_ts, "rows": picked}))
            except Exception as e:
                print(f"  전송 실패 ({e})")
    if not args.gmts and newest:
        save_state({"last_gmts": newest})


if __name__ == "__main__":
    main()
