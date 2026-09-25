"""베트맨 프로토 승부식 배당을 받아 국내 경기 전체(축구 야구 농구 배구)와 toto 해외 축구 리그를 골라 kl.usb.kr Worker로 보낸다.

베트맨은 해외 IP를 막으므로 반드시 국내 IP 컴퓨터에서 실행해야 한다.

사용법:
    export INGEST_URL=https://kl.usb.kr/ingest
    export INGEST_TOKEN=Worker에 설정한 토큰
    python3 betman_collector.py              # 최근 회차 자동 탐색 후 전송
    python3 betman_collector.py --dry-run    # 전송 없이 결과만 출력
    python3 betman_collector.py --gmts 260113 --league "아시안게임"   # 특정 회차와 리그로 시험
    python3 betman_collector.py --backfill 2021                       # 2021년부터 과거 회차 25개씩 이어받기
"""
import argparse
import datetime
import json
import os
import random
import re
import sys
import time
import urllib.request

BETMAN_URL = "https://www.betman.co.kr/buyPsblGame/gameInfoInq.do"
PROTO_GM_ID = "G101"  # 프로토 승부식
STATE_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), ".betman_state.json")
BACKFILL_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), ".betman_backfill.json")
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


# 국내: 베트맨이 domastic 으로 표시한 리그는 모두 받는다 (K리그 KBO KBL WKBL V리그 코리아컵 ...).
#   과거 회차처럼 표시가 없을 때를 위해 국내 리그 이름으로도 잡는다. 최근 회차는 "K리그1" 이고 짧게 "K1리그" 로 올 수도 있다.
# 해외: toto 모델에 있는 리그의 베트맨 짧은 이름 (leagueShortName 과 정확히 일치)
DOMESTIC_LEAGUE = r"K\s?[12]?\s?리그|^(?:KBO|KBL|WKBL|KOVO|V-?리그|남농|여농|남배|여배)"
OVERSEAS_LEAGUES = ["EPL", "EFL챔", "라리가", "세리에A", "분데스리", "프리그1", "에레디비", "J1리그", "MLS"]
DEFAULT_LEAGUE = DOMESTIC_LEAGUE + r"|^(?:" + "|".join(map(re.escape, OVERSEAS_LEAGUES)) + r")$"


def filter_rows(rows, league_pattern, domestic=None):
    """리그 이름이 맞는 행. 기본 설정이면 베트맨 국내 표시(domastic)가 있는 행도 넣는다."""
    if domestic is None:
        domestic = league_pattern == DEFAULT_LEAGUE
    pat = re.compile(league_pattern)
    return [r for r in rows
            if (domestic and r.get("domastic") is True)
            or pat.search(r.get("leagueName") or "") or pat.search(r.get("leagueShortName") or "")]


PREV_CHECK_SEC = 3 * 3600   # 직전 회차(결과 반영용)는 3시간에 한 번만 본다
MAX_JITTER_SEC = 300        # 실행 시각을 0~5분 무작위로 늦춘다
PAUSE_BASE_HOURS = 2        # 연속 실패 시 2 4 8 ... 최대 24시간 쉰다


def candidate_rounds(last, check_prev=False):
    """현재 회차와 다음 회차. 필요할 때만 직전 회차와 새해 1회차를 더한다."""
    year, no = divmod(last, 10000)
    cands = [last, last + 1]
    if check_prev and no > 1:
        cands.insert(0, last - 1)
    this_year = datetime.datetime.now(KST).year % 100
    if this_year > year:
        cands += [this_year * 10000 + 1, this_year * 10000 + 2]
    return cands


def pause_hours(fail_count):
    return min(PAUSE_BASE_HOURS * 2 ** (fail_count - 1), 24)


def load_state(path=STATE_FILE):
    try:
        with open(path) as f:
            return json.load(f)
    except (OSError, ValueError):
        return {}


def save_state(state, path=STATE_FILE):
    with open(path, "w") as f:
        json.dump(state, f)


def ingest(url, token, payload):
    req = urllib.request.Request(url, data=json.dumps(payload).encode(), method="POST",
                                 headers={"Content-Type": "application/json",
                                          "Authorization": f"Bearer {token}",
                                          # Cloudflare 가 Python 기본 User-Agent 를 막는 경우가 있다
                                          "User-Agent": "kleague-betman-collector/1.0"})
    with urllib.request.urlopen(req, timeout=30) as resp:
        return resp.read().decode()


def notify(url, token):
    """Worker 에 K리그 카카오톡 알림을 보내라고 한다. 실패해도 수집은 계속한다."""
    notify_url = re.sub(r"/ingest/?$", "/notify", url)
    try:
        print("알림", ingest(notify_url, token, {}))
    except Exception as e:
        print(f"알림 실패 ({e})")


EMPTY_ROUNDS_END_YEAR = 3   # 빈 회차가 3번 이어지면 그 해는 끝난 것으로 본다


def backfill_step(state, league, send, max_rounds, sleep=time.sleep):
    """과거 회차를 커서부터 max_rounds 개까지 받아 send(gm_ts, rows)로 넘긴다.

    state: {"year": 22, "no": 1, "empty": 0, "stop_at": 260113} 를 제자리에서 갱신한다.
    반환값: "done" (끝까지 받음) / "paused" (연속 실패) / "more" (다음 실행에서 계속)
    """
    fails, had_success = 0, False
    for i in range(max_rounds):
        gm_ts = state["year"] * 10000 + state["no"]
        if gm_ts >= state["stop_at"]:
            return "done"
        if i:
            sleep(random.uniform(8, 20))
        try:
            rows = rows_of(fetch_round(gm_ts))
        except Exception as e:
            print(f"{gm_ts}: 조회 실패 ({e})")
            fails += 1
            if fails < 3:
                continue
            if not had_success:
                return "paused"  # 접속 자체가 안 된다. 차단일 수 있으니 쉰다
            rows = []  # 다른 회차는 되는데 이 회차만 계속 오류면 없는 회차로 본다
        else:
            had_success = True
        fails = 0
        if not rows:
            state["empty"] += 1
            if state["empty"] >= EMPTY_ROUNDS_END_YEAR:
                print(f"20{state['year']}년 끝 ({state['no'] - state['empty']}회차까지)")
                state.update(year=state["year"] + 1, no=1, empty=0)
            else:
                state["no"] += 1
            continue
        state["empty"] = 0
        picked = filter_rows(rows, league)
        print(f"{gm_ts}: 전체 {len(rows)}행 중 대상 {len(picked)}행")
        if picked:
            send(gm_ts, picked)
        state["no"] += 1
    return "more"


def run_backfill(args, url, token):
    state = load_state(BACKFILL_FILE)
    start_year = args.backfill % 100
    if state.get("start_year") != start_year:
        stop_at = load_state().get("last_gmts") or (datetime.datetime.now(KST).year % 100) * 10000 + 1
        state = {"start_year": start_year, "year": start_year, "no": 1, "empty": 0, "stop_at": stop_at}
    if time.time() < state.get("pause_until", 0):
        print(f"연속 실패로 쉬는 중 ({(state['pause_until'] - time.time()) / 3600:.1f}시간 남음)")
        return
    if state.get("finished"):
        print("과거 회차 수집은 이미 끝났습니다")
        return

    def send(gm_ts, rows):
        if args.dry_run:
            return
        try:
            print("  ", ingest(url, token, {"gmTs": gm_ts, "rows": rows}))
        except Exception as e:
            print(f"  전송 실패 ({e})")
            raise

    try:
        result = backfill_step(state, args.league, send, args.rounds)
    except Exception:
        result = "send_failed"  # Worker 전송 실패. 커서는 그대로라 다음에 같은 회차부터 다시 한다
    if result == "done":
        state["finished"] = True
        print("과거 회차 수집 완료")
    elif result == "paused":
        state["pause_until"] = time.time() + 6 * 3600
        print("연속 실패. 6시간 뒤에 이어서 합니다")
    else:
        print(f"다음 실행은 {state['year'] * 10000 + state['no']} 회차부터")
    save_state(state, BACKFILL_FILE)


def main(argv=None):
    p = argparse.ArgumentParser(description="베트맨 프로토 승부식 국내 경기 배당 수집기")
    p.add_argument("--gmts", type=int, help="특정 회차만 수집 (예: 260113)")
    p.add_argument("--league", default=os.environ.get("LEAGUE_PATTERN", DEFAULT_LEAGUE),
                   help="리그 이름 정규식 (기본값: 국내 전 종목과 toto 해외 리그 9개)")
    p.add_argument("--dry-run", action="store_true", help="Worker로 보내지 않고 출력만")
    p.add_argument("--no-jitter", action="store_true", help="시작 전 무작위 대기 생략")
    p.add_argument("--backfill", type=int, metavar="YEAR",
                   help="YEAR년 1회차부터 과거 회차를 이어서 수집 (예: 2022). 실행할 때마다 --rounds 개씩")
    p.add_argument("--rounds", type=int, default=25, help="--backfill 한 번에 볼 회차 수 (기본 25. Cloudflare 무료 쓰기 한도 때문)")
    args = p.parse_args(argv)

    state = load_state()
    now = time.time()
    url, token = os.environ.get("INGEST_URL"), os.environ.get("INGEST_TOKEN")
    if not args.dry_run and not (url and token):
        sys.exit("INGEST_URL 과 INGEST_TOKEN 환경변수를 설정하세요. 시험만 하려면 --dry-run")
    if args.backfill:
        run_backfill(args, url, token)
        return

    auto = not args.gmts and not args.dry_run
    if auto and now < state.get("pause_until", 0):
        left = (state["pause_until"] - now) / 3600
        print(f"연속 실패로 쉬는 중 ({left:.1f}시간 남음)")
        return
    if auto and not args.no_jitter:
        time.sleep(random.uniform(0, MAX_JITTER_SEC))

    check_prev = now - state.get("prev_checked_at", 0) >= PREV_CHECK_SEC
    rounds = [args.gmts] if args.gmts else candidate_rounds(state.get("last_gmts", 260113), check_prev)

    newest, ok, failed = state.get("last_gmts", 0), 0, 0
    for i, gm_ts in enumerate(rounds):
        if i:
            time.sleep(random.uniform(2, 6))  # 요청 사이 간격도 사람처럼
        try:
            rows = rows_of(fetch_round(gm_ts))
            ok += 1
        except Exception as e:  # 네트워크 오류나 JSON 이 아닌 응답
            print(f"{gm_ts}: 조회 실패 ({e})")
            failed += 1
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

    if not auto:
        return
    if ok:
        notify(url, token)
    state["last_gmts"] = newest or state.get("last_gmts", 260113)
    if check_prev and ok:
        state["prev_checked_at"] = now
    if failed and not ok:
        # 한 번도 성공하지 못하면 차단일 수 있으니 점점 길게 쉰다
        state["fail_count"] = state.get("fail_count", 0) + 1
        hours = pause_hours(state["fail_count"])
        state["pause_until"] = now + hours * 3600
        print(f"모든 요청 실패. {hours}시간 쉽니다")
    else:
        state["fail_count"], state["pause_until"] = 0, 0
    save_state(state)


if __name__ == "__main__":
    main()
