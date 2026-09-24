"""API-Football 을 흉내 내는 로컬 서버. 로컬 검증용."""
import json, time, sys
from http.server import BaseHTTPRequestHandler, HTTPServer
from urllib.parse import urlparse, parse_qs

NOW = int(time.time())
FIX = [
    (1001, 292, NOW + 2 * 86400, "NS", "Ulsan HD", "Jeonbuk Motors", None, None),
    (1002, 292, NOW + 3 * 86400, "NS", "FC Seoul", "Pohang Steelers", None, None),
    (1003, 292, NOW - 86400, "FT", "Daegu FC", "Gangwon FC", 2, 1),
    (2001, 293, NOW + 4 * 86400, "NS", "Suwon Bluewings", "Busan IPark", None, None),
]
UPDATES = {"n": 0}

def fixtures(league):
    return [{"fixture": {"id": f[0], "timestamp": f[2], "status": {"short": f[3]}},
             "league": {"id": f[1], "season": 2026, "round": "Regular Season - 32"},
             "teams": {"home": {"name": f[4]}, "away": {"name": f[5]}},
             "goals": {"home": f[6], "away": f[7]}} for f in FIX if f[1] == league]

def odds(league, bet, page):
    shift = 0.05 * UPDATES["n"]
    items = []
    for f in FIX:
        if f[1] != league or f[3] != "NS" or f[0] == 1002:
            continue
        values = ([("Home", 1.90 - shift), ("Draw", 3.40), ("Away", 4.10 + shift)] if bet == 1
                  else [("Over 2.5", 2.05), ("Under 2.5", 1.75)])
        items.append({"fixture": {"id": f[0]}, "update": f"2026-09-24T{UPDATES['n']:02d}:00:00+00:00",
                      "bookmakers": [{"id": b, "name": n, "bets": [{"id": bet, "name": "x",
                                      "values": [{"value": v, "odd": f"{o:.2f}"} for v, o in values]}]}
                                     for b, n in ((8, "Bet365"), (4, "Pinnacle"))]})
    return items[:1] if page == 1 else items[1:]

class H(BaseHTTPRequestHandler):
    def do_GET(self):
        u = urlparse(self.path); q = {k: v[0] for k, v in parse_qs(u.query).items()}
        assert self.headers.get("x-apisports-key") == "test-key"
        if u.path == "/fixtures":
            body = {"errors": [], "paging": {"current": 1, "total": 1}, "response": fixtures(int(q["league"]))}
        elif u.path == "/odds":
            page = int(q.get("page", 1))
            body = {"errors": [], "paging": {"current": page, "total": 2},
                    "response": odds(int(q["league"]), int(q["bet"]), page)}
        elif u.path == "/bump":
            UPDATES["n"] += 1; body = {"n": UPDATES["n"]}
        else:
            self.send_response(404); self.end_headers(); return
        data = json.dumps(body).encode()
        self.send_response(200); self.send_header("content-type", "application/json"); self.end_headers()
        self.wfile.write(data)
    def log_message(self, *a): pass

HTTPServer(("127.0.0.1", int(sys.argv[1])), H).serve_forever()
