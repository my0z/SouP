// K리그 프로토 배당 조회 페이지 (Cloudflare Worker + D1)
//   베트맨은 해외 IP를 막으므로 국내 PC의 betman_collector.py 가 수집해서 /ingest 로 보낸다.
//   POST /ingest       : 수집기가 보낸 compSchedules 행 저장 (INGEST_TOKEN 필요)
//   GET  /             : 다가오는 경기의 게임 유형별 배당과 첫 수집 대비 변동, 최근 결과
//   GET  /api/upcoming : 같은 데이터를 JSON 으로

const DAY = 86400;
const RESULT_IDX = { 0: 0, 1: 1, 2: 2 };

const nowIso = () => new Date().toISOString().replace(/\.\d+Z$/, "Z");
// 0 은 미발표 1.0 은 미발매 자리값이라 버린다
const num = (v) => (typeof v === "number" && v > 1 ? v : null);

export function ingestStmts(db, gmTs, rows) {
  const ts = nowIso();
  const upsert = db.prepare(
    `INSERT INTO proto_matches VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
     ON CONFLICT(gm_ts, match_seq) DO UPDATE SET
       league=excluded.league, home=excluded.home, away=excluded.away, game_ts=excluded.game_ts,
       bet_name=excluded.bet_name, handi=excluded.handi, win_txt=excluded.win_txt,
       draw_txt=excluded.draw_txt, lose_txt=excluded.lose_txt, status=excluded.status,
       result=excluded.result, score=excluded.score, updated_at=excluded.updated_at`
  );
  // 직전 스냅샷과 같으면 넣지 않는다
  const snap = db.prepare(
    `INSERT INTO proto_odds (gm_ts, match_seq, win, draw, lose, handi, fetched_at)
     SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7
     WHERE NOT EXISTS (
       SELECT 1 FROM (SELECT win, draw, lose, handi FROM proto_odds
                      WHERE gm_ts = ?1 AND match_seq = ?2 ORDER BY id DESC LIMIT 1) l
       WHERE l.win IS ?3 AND l.draw IS ?4 AND l.lose IS ?5 AND l.handi IS ?6)`
  );
  const out = [];
  for (const r of rows) {
    const handi = r.winHandi ?? null;
    out.push(upsert.bind(
      gmTs, r.matchSeq, r.leagueName ?? null, r.homeName ?? null, r.awayName ?? null,
      Math.floor(r.gameDate / 1000), r.betId ?? null, r.betNm ?? null, handi,
      r.winTxt ?? null, r.drawTxt ?? null, r.loseTxt ?? null, r.protoStatus ?? null,
      r.gameResult ?? null, r.mchScore ?? null, ts
    ));
    const [w, d, l] = [num(r.winAllot), num(r.drawAllot), num(r.loseAllot)];
    if (w || d || l) out.push(snap.bind(gmTs, r.matchSeq, w, d, l, handi, ts));
  }
  return out;
}

async function runBatch(db, stmts) {
  for (let i = 0; i < stmts.length; i += 200) await db.batch(stmts.slice(i, i + 200));
}

const isMain = (b) => /승무패$/.test(b.bet_name || "") && !/전반/.test(b.bet_name || "");

// 경기(홈/원정/시각) 단위로 게임 유형들을 묶는다
function groupGames(rows) {
  const games = new Map();
  for (const r of rows) {
    const key = `${r.game_ts}|${r.home}|${r.away}`;
    if (!games.has(key)) {
      games.set(key, { game_ts: r.game_ts, league: r.league, home: r.home, away: r.away, score: null, bets: [] });
    }
    const g = games.get(key);
    // 점수는 전체 승무패 행 기준 (핸디캡과 언더오버 행은 보정된 값이 들어온다)
    if (isMain(r) && r.score && r.status === "4") g.score = r.score;
    g.bets.push(r);
  }
  return [...games.values()].sort((a, b) => a.game_ts - b.game_ts);
}

export async function loadGames(db, { from, to }) {
  const { results } = await db
    .prepare(
      `WITH r AS (
         SELECT gm_ts, match_seq, win, draw, lose,
           ROW_NUMBER() OVER (PARTITION BY gm_ts, match_seq ORDER BY id DESC) AS rn_last,
           ROW_NUMBER() OVER (PARTITION BY gm_ts, match_seq ORDER BY id ASC) AS rn_first
         FROM proto_odds WHERE (gm_ts, match_seq) IN
           (SELECT gm_ts, match_seq FROM proto_matches WHERE game_ts BETWEEN ?1 AND ?2)),
       o AS (
         SELECT gm_ts, match_seq,
           MAX(CASE WHEN rn_last = 1 THEN win END) AS w, MAX(CASE WHEN rn_last = 1 THEN draw END) AS d,
           MAX(CASE WHEN rn_last = 1 THEN lose END) AS l,
           MAX(CASE WHEN rn_first = 1 THEN win END) AS w0, MAX(CASE WHEN rn_first = 1 THEN draw END) AS d0,
           MAX(CASE WHEN rn_first = 1 THEN lose END) AS l0,
           COUNT(*) AS changes
         FROM r GROUP BY gm_ts, match_seq)
       SELECT m.*, o.w, o.d, o.l, o.w0, o.d0, o.l0, o.changes
       FROM proto_matches m LEFT JOIN o USING (gm_ts, match_seq)
       WHERE m.game_ts BETWEEN ?1 AND ?2
       ORDER BY m.game_ts, m.match_seq`
    )
    .bind(from, to).all();
  return groupGames(results);
}

async function pageData(db) {
  const now = Math.floor(Date.now() / 1000);
  const games = await loadGames(db, { from: now - 3 * DAY, to: now + 14 * DAY });
  return {
    upcoming: games.filter((g) => g.game_ts >= now - 3 * 3600 && !g.score),
    recent: games.filter((g) => g.score).reverse(),
  };
}

// ---------- HTML ----------

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const kst = (ts) =>
  new Intl.DateTimeFormat("ko-KR", {
    timeZone: "Asia/Seoul", month: "2-digit", day: "2-digit", weekday: "short",
    hour: "2-digit", minute: "2-digit", hour12: false,
  }).format(new Date(ts * 1000));

function cell(label, v, v0, hit) {
  if (!v) return `<td class="na">-</td>`;
  const diff = v0 && v !== v0 ? v - v0 : 0;
  const move = diff
    ? `<small class="${diff < 0 ? "down" : "up"}">${diff < 0 ? "▼" : "▲"}${Math.abs(diff).toFixed(2)}</small>`
    : "";
  return `<td class="${hit ? "hit" : ""}"><span class="lbl">${esc(label)}</span>${v.toFixed(2)}${move}</td>`;
}

function betRow(b) {
  const name = String(b.bet_name || "").replace(/^축구\s*/, "");
  const ou = /언더오버/.test(name);
  const handi = b.handi ? `<span class="h">${ou ? "기준 " : b.handi > 0 ? "+" : ""}${b.handi}</span>` : "";
  const hit = RESULT_IDX[b.result];
  return `<tr><th>${esc(name)}${handi}</th>
    ${cell(b.win_txt || "승", b.w, b.w0, hit === 0)}
    ${cell(b.draw_txt && b.draw_txt !== "-" ? b.draw_txt : "무", b.d, b.d0, hit === 1)}
    ${cell(b.lose_txt || "패", b.l, b.l0, hit === 2)}</tr>`;
}

function probBar(g) {
  const main = g.bets.find((b) => isMain(b) && b.w && b.d && b.l);
  if (!main) return "";
  const inv = [main.w, main.d, main.l].map((x) => 1 / x);
  const sum = inv[0] + inv[1] + inv[2];
  const seg = ["home", "draw", "away"]
    .map((c, i) => `<span class="${c}" style="flex:${inv[i]}">${((inv[i] / sum) * 100).toFixed(0)}%</span>`)
    .join("");
  return `<div class="bar">${seg}</div><p class="muted small">마진 ${((sum - 1) * 100).toFixed(1)}% · 마진 제외 확률</p>`;
}

function gameCard(g) {
  return `<article>
    <header><span class="tag">${esc(g.league)}</span><time>${kst(g.game_ts)}</time>
      ${g.score ? `<b class="score">${esc(g.score)}</b>` : ""}</header>
    <h2>${esc(g.home)} <span class="muted">vs</span> ${esc(g.away)}</h2>
    ${g.score ? "" : probBar(g)}
    <div class="scroll"><table><tbody>${g.bets.map(betRow).join("")}</tbody></table></div>
  </article>`;
}

function page({ upcoming, recent }) {
  return `<!doctype html><html lang="ko"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>K리그 프로토 배당</title>
<style>
:root{--bg:#f6f7f9;--card:#fff;--fg:#14161a;--muted:#6b7280;--line:#e5e7eb;--home:#2563eb;--draw:#9ca3af;--away:#dc2626;--up:#dc2626;--down:#2563eb;--hit:#dcfce7}
@media (prefers-color-scheme:dark){:root{--bg:#0f1115;--card:#181b21;--fg:#e6e8eb;--muted:#9097a3;--line:#2a2e36;--home:#3b82f6;--draw:#6b7280;--away:#ef4444;--up:#f87171;--down:#60a5fa;--hit:#14532d}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.5 system-ui,-apple-system,"Apple SD Gothic Neo",sans-serif}
main{max-width:760px;margin:0 auto;padding:24px 16px}h1{font-size:22px;margin:0 0 4px}
h2{font-size:17px;margin:6px 0 10px}h3{font-size:16px;margin:28px 0 4px}.muted{color:var(--muted)}.small{font-size:12px;margin:-6px 0 8px}
article,section{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:16px;margin:12px 0}
article header{display:flex;gap:8px;align-items:center;font-size:13px;color:var(--muted)}
.tag{background:var(--line);color:var(--fg);border-radius:6px;padding:1px 8px;font-weight:600}
.score{margin-left:auto;color:var(--fg);font-size:15px}
.bar{display:flex;height:22px;border-radius:6px;overflow:hidden;margin-bottom:10px;font-size:12px;color:#fff;font-weight:600}
.bar span{display:flex;align-items:center;justify-content:center;min-width:32px}
.home{background:var(--home)}.draw{background:var(--draw)}.away{background:var(--away)}
.scroll{overflow-x:auto}table{width:100%;border-collapse:collapse;font-variant-numeric:tabular-nums}
th,td{padding:6px 8px;border-top:1px solid var(--line);text-align:right;white-space:nowrap}
th{text-align:left;font-weight:500}td.hit{background:var(--hit);font-weight:700}td.na{color:var(--muted)}
.lbl{color:var(--muted);font-size:12px;margin-right:4px}.h{margin-left:6px;color:var(--muted);font-size:12px}
small{margin-left:4px;font-size:11px}.up{color:var(--up)}.down{color:var(--down)}
@media (max-width:480px){th,td{padding:6px 4px}.lbl{display:block;margin:0}small{display:block;margin:0}}
</style></head><body><main>
<h1>K리그 프로토 배당</h1>
<p class="muted">베트맨 프로토 승부식 기준 · ▲▼ 는 첫 수집 대비 변동</p>
${upcoming.length ? upcoming.map(gameCard).join("") : `<section class="muted">예정된 K리그 프로토 경기가 없거나 아직 수집 전입니다</section>`}
${recent.length ? `<h3>최근 결과</h3>${recent.map(gameCard).join("")}` : ""}
</main></body></html>`;
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (url.pathname === "/ingest" && req.method === "POST") {
      const auth = req.headers.get("authorization") || "";
      if (!env.INGEST_TOKEN || auth !== `Bearer ${env.INGEST_TOKEN}`) {
        return new Response("forbidden", { status: 403 });
      }
      const body = await req.json();
      if (!Number.isInteger(body.gmTs) || !Array.isArray(body.rows)) {
        return new Response("bad request", { status: 400 });
      }
      const stmts = ingestStmts(env.DB, body.gmTs, body.rows);
      await runBatch(env.DB, stmts);
      return Response.json({ ok: true, rows: body.rows.length });
    }
    if (url.pathname === "/api/upcoming") return Response.json(await pageData(env.DB));
    if (url.pathname !== "/") return new Response("not found", { status: 404 });
    return new Response(page(await pageData(env.DB)), {
      headers: { "content-type": "text/html; charset=utf-8", "cache-control": "public, max-age=120" },
    });
  },
};
