"""K리그 경기 일정과 배당을 API-Football에서 받아 SQLite에 누적 저장한다.

사용법:
    export API_FOOTBALL_KEY=발급받은키
    python odds.py collect          # 일정/결과 갱신 + 배당 스냅샷 저장
    python odds.py show             # 다가오는 경기와 최신 승무패 배당 출력
"""
import argparse
import datetime
import json
import os
import sqlite3
import sys
import urllib.parse
import urllib.request

API_BASE = "https://v3.football.api-sports.io"
LEAGUES = {292: "K League 1", 293: "K League 2"}
KST = datetime.timezone(datetime.timedelta(hours=9))
DEFAULT_DB = os.path.join(os.path.dirname(os.path.abspath(__file__)), "kleague_odds.db")

SCHEMA = """
CREATE TABLE IF NOT EXISTS fixtures (
    fixture_id   INTEGER PRIMARY KEY,
    league_id    INTEGER NOT NULL,
    season       INTEGER NOT NULL,
    round        TEXT,
    kickoff_utc  TEXT NOT NULL,
    status       TEXT,
    home_team    TEXT,
    away_team    TEXT,
    home_goals   INTEGER,
    away_goals   INTEGER,
    updated_at   TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS odds (
    fixture_id   INTEGER NOT NULL,
    bookmaker_id INTEGER NOT NULL,
    bookmaker    TEXT,
    bet_id       INTEGER NOT NULL,
    bet          TEXT,
    value        TEXT NOT NULL,
    odd          REAL NOT NULL,
    api_update   TEXT NOT NULL,
    fetched_at   TEXT NOT NULL,
    UNIQUE (fixture_id, bookmaker_id, bet_id, value, api_update)
);
CREATE INDEX IF NOT EXISTS idx_odds_fixture ON odds (fixture_id, bet_id);
"""


class ApiError(RuntimeError):
    pass


def now_utc():
    return datetime.datetime.now(datetime.timezone.utc).replace(microsecond=0).isoformat()


def current_season():
    # K리그 시즌은 달력 연도 기준
    return datetime.datetime.now(KST).year


def api_get(path, params, key):
    url = f"{API_BASE}{path}?{urllib.parse.urlencode(params)}"
    req = urllib.request.Request(url, headers={"x-apisports-key": key})
    with urllib.request.urlopen(req, timeout=30) as resp:
        remaining = resp.headers.get("x-ratelimit-requests-remaining")
        body = json.load(resp)
    errors = body.get("errors")
    if errors:
        raise ApiError(f"{path} {params}: {errors}")
    if remaining is not None:
        print(f"  {path} 남은 일일 호출: {remaining}")
    return body


def api_get_all(path, params, key):
    """paging 이 있는 엔드포인트의 모든 페이지를 합쳐 돌려준다."""
    page, items = 1, []
    while True:
        body = api_get(path, {**params, "page": page} if page > 1 else params, key)
        items.extend(body.get("response", []))
        paging = body.get("paging") or {}
        if page >= paging.get("total", 1):
            return items
        page += 1


def connect(db_path):
    conn = sqlite3.connect(db_path)
    conn.executescript(SCHEMA)
    return conn


def save_fixtures(conn, items):
    ts = now_utc()
    rows = [
        (
            it["fixture"]["id"],
            it["league"]["id"],
            it["league"]["season"],
            it["league"].get("round"),
            it["fixture"]["date"],
            it["fixture"]["status"]["short"],
            it["teams"]["home"]["name"],
            it["teams"]["away"]["name"],
            it["goals"]["home"],
            it["goals"]["away"],
            ts,
        )
        for it in items
    ]
    conn.executemany(
        """INSERT INTO fixtures VALUES (?,?,?,?,?,?,?,?,?,?,?)
           ON CONFLICT(fixture_id) DO UPDATE SET
             round=excluded.round, kickoff_utc=excluded.kickoff_utc,
             status=excluded.status, home_goals=excluded.home_goals,
             away_goals=excluded.away_goals, updated_at=excluded.updated_at""",
        rows,
    )
    return len(rows)


def save_odds(conn, items):
    """API 의 update 시각이 같으면 중복 저장하지 않는다. 새로 들어간 행 수를 돌려준다."""
    ts = now_utc()
    rows = []
    for it in items:
        fid = it["fixture"]["id"]
        for bm in it.get("bookmakers", []):
            for bet in bm.get("bets", []):
                for v in bet.get("values", []):
                    rows.append((fid, bm["id"], bm["name"], bet["id"], bet["name"],
                                 str(v["value"]), float(v["odd"]), it["update"], ts))
    before = conn.total_changes
    conn.executemany("INSERT OR IGNORE INTO odds VALUES (?,?,?,?,?,?,?,?,?)", rows)
    return conn.total_changes - before


def collect(conn, key, season, leagues):
    for league_id in leagues:
        print(f"[{LEAGUES.get(league_id, league_id)}] season {season}")
        fixtures = api_get_all("/fixtures", {"league": league_id, "season": season}, key)
        print(f"  경기 {save_fixtures(conn, fixtures)}건 갱신")
        odds = api_get_all("/odds", {"league": league_id, "season": season}, key)
        print(f"  배당 {save_odds(conn, odds)}건 신규 저장 (경기 {len(odds)}개)")
        conn.commit()


def latest_match_winner(conn, fixture_id):
    """북메이커별 최신 승무패(bet_id=1) 배당을 {bookmaker: {Home, Draw, Away}} 로 돌려준다."""
    rows = conn.execute(
        """SELECT o.bookmaker, o.value, o.odd FROM odds o
           JOIN (SELECT bookmaker_id, MAX(api_update) AS u FROM odds
                 WHERE fixture_id=? AND bet_id=1 GROUP BY bookmaker_id) m
             ON o.bookmaker_id=m.bookmaker_id AND o.api_update=m.u
           WHERE o.fixture_id=? AND o.bet_id=1""",
        (fixture_id, fixture_id),
    ).fetchall()
    out = {}
    for bookmaker, value, odd in rows:
        out.setdefault(bookmaker, {})[value] = odd
    return out


def show(conn, days):
    until = (datetime.datetime.now(datetime.timezone.utc) + datetime.timedelta(days=days)).isoformat()
    fixtures = conn.execute(
        """SELECT fixture_id, league_id, kickoff_utc, home_team, away_team FROM fixtures
           WHERE status='NS' AND kickoff_utc <= ? ORDER BY kickoff_utc""",
        (until,),
    ).fetchall()
    if not fixtures:
        print("표시할 예정 경기가 없습니다. 먼저 collect 를 실행하세요.")
        return
    for fid, league_id, kickoff, home, away in fixtures:
        kst = datetime.datetime.fromisoformat(kickoff).astimezone(KST).strftime("%m-%d %H:%M")
        print(f"\n{kst} KST  [{LEAGUES.get(league_id, league_id)}]  {home} vs {away}  (#{fid})")
        books = latest_match_winner(conn, fid)
        if not books:
            print("    배당 없음")
            continue
        for name, o in sorted(books.items()):
            h, d, a = o.get("Home"), o.get("Draw"), o.get("Away")
            if not (h and d and a):
                continue
            inv = 1 / h + 1 / d + 1 / a
            probs = " ".join(f"{p / inv * 100:4.1f}%" for p in (1 / h, 1 / d, 1 / a))
            print(f"    {name:<14} {h:5.2f} {d:5.2f} {a:5.2f}  | 확률 {probs}  마진 {(inv - 1) * 100:.1f}%")


def main(argv=None):
    p = argparse.ArgumentParser(description="K리그 배당 수집기 (API-Football)")
    p.add_argument("--db", default=os.environ.get("KLEAGUE_DB", DEFAULT_DB))
    sub = p.add_subparsers(dest="cmd", required=True)
    c = sub.add_parser("collect", help="일정/결과 갱신 + 배당 스냅샷 저장")
    c.add_argument("--season", type=int, default=current_season())
    c.add_argument("--league", type=int, action="append", choices=sorted(LEAGUES),
                   help="기본값: K리그1 과 K리그2 모두")
    s = sub.add_parser("show", help="다가오는 경기와 최신 승무패 배당 출력")
    s.add_argument("--days", type=int, default=7)
    args = p.parse_args(argv)

    conn = connect(args.db)
    if args.cmd == "collect":
        key = os.environ.get("API_FOOTBALL_KEY")
        if not key:
            sys.exit("API_FOOTBALL_KEY 환경변수를 설정하세요.")
        collect(conn, key, args.season, args.league or sorted(LEAGUES))
    else:
        show(conn, args.days)


if __name__ == "__main__":
    main()
