// K리그 배당 수집 + 조회 페이지 (Cloudflare Worker + D1)
//   scheduled: API-Football 에서 일정/결과와 배당을 받아 D1 에 누적
//   GET /            : 다가오는 경기와 북메이커별 승무패 배당 (첫 수집 대비 변동 포함)
//   GET /api/upcoming: 같은 데이터를 JSON 으로
//   GET /collect?token=... : 수동 수집 (COLLECT_TOKEN 시크릿이 있을 때만)

const DEFAULT_API = "https://v3.football.api-sports.io";
const LEAGUE_NAMES = { 292: "K리그1", 293: "K리그2" };
const DAY = 86400;
const DONE = ["FT", "AET", "PEN"];

const list = (s) => String(s).split(",").map((x) => parseInt(x, 10)).filter(Boolean);
const nowIso = () => new Date().toISOString().replace(/\.\d+Z$/, "Z");
const kstYear = () => new Date(Date.now() + 9 * 3600e3).getUTCFullYear();
const ymd = (ts) => new Date(ts * 1000).toISOString().slice(0, 10);

async function apiGet(env, path, params) {
  const url = `${env.API_BASE || DEFAULT_API}${path}?${new URLSearchParams(params)}`;
  const res = await fetch(url, { headers: { "x-apisports-key": env.API_FOOTBALL_KEY } });
  if (!res.ok) throw new Error(`${path} HTTP ${res.status}`);
  const body = await res.json();
  const errors = body.errors;
  if (errors && (Array.isArray(errors) ? errors.length : Object.keys(errors).length)) {
    throw new Error(`${path} ${JSON.stringify(params)}: ${JSON.stringify(errors)}`);
  }
  return body;
}

async function apiGetAll(env, path, params) {
  const items = [];
  for (let page = 1; ; page++) {
    const body = await apiGet(env, path, page > 1 ? { ...params, page } : params);
    items.push(...(body.response || []));
    if (page >= (body.paging?.total || 1)) return items;
  }
}

async function runBatch(db, stmts) {
  for (let i = 0; i < stmts.length; i += 500) await db.batch(stmts.slice(i, i + 500));
}

export function fixtureStmts(db, items) {
  const ts = nowIso();
  const sql = db.prepare(
    `INSERT INTO fixtures VALUES (?,?,?,?,?,?,?,?,?,?,?)
     ON CONFLICT(fixture_id) DO UPDATE SET
       round=excluded.round, kickoff_ts=excluded.kickoff_ts, status=excluded.status,
       home_goals=excluded.home_goals, away_goals=excluded.away_goals, updated_at=excluded.updated_at`
  );
  return items.map((it) =>
    sql.bind(
      it.fixture.id, it.league.id, it.league.season, it.league.round ?? null,
      it.fixture.timestamp, it.fixture.status.short,
      it.teams.home.name, it.teams.away.name,
      it.goals.home ?? null, it.goals.away ?? null, ts
    )
  );
}

export function oddsStmts(db, items) {
  const ts = nowIso();
  const sql = db.prepare("INSERT OR IGNORE INTO odds VALUES (?,?,?,?,?,?,?,?,?)");
  const out = [];
  for (const it of items)
    for (const bm of it.bookmakers || [])
      for (const bet of bm.bets || [])
        for (const v of bet.values || [])
          out.push(sql.bind(it.fixture.id, bm.id, bm.name, bet.id, bet.name,
                            String(v.value), parseFloat(v.odd), it.update, ts));
  return out;
}

export async function collect(env) {
  if (!env.API_FOOTBALL_KEY) throw new Error("API_FOOTBALL_KEY 시크릿이 없습니다");
  const season = kstYear();
  const now = Math.floor(Date.now() / 1000);
  const log = [];
  for (const league of list(env.LEAGUES || "292,293")) {
    // 최근 3일 결과 갱신 + 2주 뒤 경기까지
    const fixtures = await apiGetAll(env, "/fixtures", {
      league, season, from: ymd(now - 3 * DAY), to: ymd(now + 14 * DAY),
    });
    await runBatch(env.DB, fixtureStmts(env.DB, fixtures));
    let odds = 0;
    for (const bet of list(env.BET_IDS || "1,5")) {
      const items = await apiGetAll(env, "/odds", { league, season, bet });
      const stmts = oddsStmts(env.DB, items);
      await runBatch(env.DB, stmts);
      odds += stmts.length;
    }
    log.push(`${LEAGUE_NAMES[league] || league}: 경기 ${fixtures.length} 배당행 ${odds}`);
  }
  return log.join("\n");
}

export async function upcoming(db, days = 7) {
  const now = Math.floor(Date.now() / 1000);
  const { results: fixtures } = await db
    .prepare(`SELECT * FROM fixtures WHERE status='NS' AND kickoff_ts BETWEEN ? AND ? ORDER BY kickoff_ts`)
    .bind(now - 3 * 3600, now + days * DAY).all();
  const { results: recent } = await db
    .prepare(`SELECT * FROM fixtures WHERE status IN (${DONE.map(() => "?").join(",")})
              AND kickoff_ts >= ? ORDER BY kickoff_ts DESC`)
    .bind(...DONE, now - 3 * DAY).all();
  const ids = fixtures.map((f) => f.fixture_id);
  const odds = {};
  if (ids.length) {
    const { results } = await db
      .prepare(
        `WITH r AS (
           SELECT fixture_id, bookmaker_id, bookmaker, value, odd, api_update,
             ROW_NUMBER() OVER (PARTITION BY fixture_id, bookmaker_id, value ORDER BY api_update DESC) AS rn_last,
             ROW_NUMBER() OVER (PARTITION BY fixture_id, bookmaker_id, value ORDER BY api_update ASC) AS rn_first
           FROM odds WHERE bet_id = 1 AND fixture_id IN (${ids.map(() => "?").join(",")}))
         SELECT fixture_id, bookmaker, value,
           MAX(CASE WHEN rn_last = 1 THEN odd END) AS last,
           MAX(CASE WHEN rn_first = 1 THEN odd END) AS first,
           MAX(api_update) AS updated
         FROM r GROUP BY fixture_id, bookmaker_id, value`
      )
      .bind(...ids).all();
    for (const r of results) {
      const book = ((odds[r.fixture_id] ||= {})[r.bookmaker] ||= { updated: r.updated });
      book[r.value] = { last: r.last, first: r.first };
    }
  }
  return {
    fixtures: fixtures.map((f) => ({ ...f, odds: odds[f.fixture_id] || {} })),
    recent,
  };
}

// ---------- HTML ----------

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const kst = (ts) =>
  new Intl.DateTimeFormat("ko-KR", {
    timeZone: "Asia/Seoul", month: "2-digit", day: "2-digit", weekday: "short",
    hour: "2-digit", minute: "2-digit", hour12: false,
  }).format(new Date(ts * 1000));

function oddCell(o) {
  if (!o) return "<td>-</td>";
  const diff = o.first && o.last !== o.first ? o.last - o.first : 0;
  const move = diff
    ? `<small class="${diff < 0 ? "down" : "up"}">${diff < 0 ? "▼" : "▲"}${Math.abs(diff).toFixed(2)}</small>`
    : "";
  return `<td>${o.last.toFixed(2)}${move}</td>`;
}

function fixtureCard(f) {
  const books = Object.entries(f.odds).filter(([, o]) => o.Home && o.Draw && o.Away);
  let body = `<p class="muted">아직 배당이 없습니다</p>`;
  if (books.length) {
    const avg = [0, 0, 0];
    const rows = books.map(([name, o]) => {
      const inv = [o.Home, o.Draw, o.Away].map((x) => 1 / x.last);
      const sum = inv[0] + inv[1] + inv[2];
      inv.forEach((p, i) => (avg[i] += p / sum / books.length));
      return `<tr><th>${esc(name)}</th>${oddCell(o.Home)}${oddCell(o.Draw)}${oddCell(o.Away)}
              <td class="muted">${((sum - 1) * 100).toFixed(1)}%</td></tr>`;
    });
    const bar = ["home", "draw", "away"]
      .map((c, i) => `<span class="${c}" style="flex:${avg[i]}">${(avg[i] * 100).toFixed(0)}%</span>`)
      .join("");
    body = `<div class="bar">${bar}</div>
      <div class="scroll"><table><thead><tr><th>북메이커</th><th>홈</th><th>무</th><th>원정</th><th>마진</th></tr></thead>
      <tbody>${rows.join("")}</tbody></table></div>`;
  }
  return `<article>
    <header><span class="tag">${esc(LEAGUE_NAMES[f.league_id] || f.league_id)}</span>
      <time>${kst(f.kickoff_ts)}</time></header>
    <h2>${esc(f.home_team)} <span class="muted">vs</span> ${esc(f.away_team)}</h2>
    ${body}</article>`;
}

function page({ fixtures, recent }) {
  const results = recent
    .map((f) => `<li><time>${kst(f.kickoff_ts)}</time> ${esc(f.home_team)}
      <b>${f.home_goals} : ${f.away_goals}</b> ${esc(f.away_team)}</li>`)
    .join("");
  return `<!doctype html><html lang="ko"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>K리그 배당</title>
<style>
:root{--bg:#f6f7f9;--card:#fff;--fg:#14161a;--muted:#6b7280;--line:#e5e7eb;--home:#2563eb;--draw:#9ca3af;--away:#dc2626;--up:#dc2626;--down:#2563eb}
@media (prefers-color-scheme:dark){:root{--bg:#0f1115;--card:#181b21;--fg:#e6e8eb;--muted:#9097a3;--line:#2a2e36;--home:#3b82f6;--draw:#6b7280;--away:#ef4444;--up:#f87171;--down:#60a5fa}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.5 system-ui,-apple-system,"Apple SD Gothic Neo",sans-serif}
main{max-width:760px;margin:0 auto;padding:24px 16px}h1{font-size:22px;margin:0 0 4px}
h2{font-size:17px;margin:6px 0 12px}.muted{color:var(--muted)}
article,section{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:16px;margin:12px 0}
article header{display:flex;gap:8px;align-items:center;font-size:13px;color:var(--muted)}
.tag{background:var(--line);color:var(--fg);border-radius:6px;padding:1px 8px;font-weight:600}
.bar{display:flex;height:22px;border-radius:6px;overflow:hidden;margin-bottom:10px;font-size:12px;color:#fff;font-weight:600}
.bar span{display:flex;align-items:center;justify-content:center;min-width:32px}
.home{background:var(--home)}.draw{background:var(--draw)}.away{background:var(--away)}
.scroll{overflow-x:auto}table{width:100%;border-collapse:collapse;font-variant-numeric:tabular-nums}
th,td{padding:6px 8px;border-top:1px solid var(--line);text-align:right;white-space:nowrap}
th:first-child{text-align:left;font-weight:500}thead th{border-top:0;color:var(--muted);font-weight:500;font-size:13px}
small{margin-left:4px;font-size:11px}.up{color:var(--up)}.down{color:var(--down)}
ul{list-style:none;padding:0;margin:0}li{padding:6px 0;border-top:1px solid var(--line)}li:first-child{border-top:0}
li time{color:var(--muted);font-size:13px;margin-right:8px}
@media (max-width:480px){th,td{padding:6px 4px}small{display:block;margin:0}}
</style></head><body><main>
<h1>K리그 배당</h1>
<p class="muted">7일 안 경기 · 승무패 최신 배당 · ▲▼ 는 첫 수집 대비 변동 · 막대는 마진을 뺀 평균 확률</p>
${fixtures.length ? fixtures.map(fixtureCard).join("") : `<section class="muted">7일 안에 예정된 경기가 없거나 아직 수집 전입니다</section>`}
${results ? `<section><h2>최근 결과</h2><ul>${results}</ul></section>` : ""}
</main></body></html>`;
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (url.pathname === "/api/upcoming") {
      return Response.json(await upcoming(env.DB, parseInt(url.searchParams.get("days")) || 7));
    }
    if (url.pathname === "/collect") {
      if (!env.COLLECT_TOKEN || url.searchParams.get("token") !== env.COLLECT_TOKEN) {
        return new Response("forbidden", { status: 403 });
      }
      return new Response(await collect(env), { headers: { "content-type": "text/plain; charset=utf-8" } });
    }
    if (url.pathname !== "/") return new Response("not found", { status: 404 });
    return new Response(page(await upcoming(env.DB)), {
      headers: { "content-type": "text/html; charset=utf-8", "cache-control": "public, max-age=300" },
    });
  },

  async scheduled(_event, env, ctx) {
    ctx.waitUntil(collect(env).then(console.log));
  },
};
