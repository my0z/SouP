// K리그 프로토 배당 조회 페이지 (Cloudflare Worker + D1)
//   베트맨은 해외 IP를 막으므로 국내 PC의 betman_collector.py 가 수집해서 /ingest 로 보낸다.
//   POST /ingest       : 수집기가 보낸 compSchedules 행 저장 (INGEST_TOKEN 필요)
//   GET  /             : 다가오는 경기의 게임 유형별 배당과 첫 수집 대비 변동, 최근 결과
//   GET  /api/upcoming : 같은 데이터를 JSON 으로
//   GET  /export.csv   : 저장된 경기와 배당 CSV (분석용. gm_from gm_to league 로 나눠 받기)
//   GET  /api/rounds   : 회차별 리그별 경기 수

const DAY = 86400;
const RESULT_IDX = { 0: 0, 1: 1, 2: 2 };

const nowIso = () => new Date().toISOString().replace(/\.\d+Z$/, "Z");
// 0 은 미발표 1.0 은 미발매 자리값이라 버린다
const num = (v) => (typeof v === "number" && v > 1 ? v : null);

// 과거 회차(2021~)는 betNm 과 winTxt 가 비어 있고 handi 코드로만 게임 종류를 알 수 있다
const LEGACY_BETS = {
  0: ["축구 승무패", "승", "무", "패"],
  2: ["축구 핸디캡", "승", "무", "패"],
  23: ["축구 소수핸디캡", "승", "-", "패"],
  9: ["축구 언더오버", "언더", "-", "오버"],
  27: ["축구 SUM", "홀", "-", "짝"],
};

export function normalizeRow(r) {
  const legacy = r.betNm ? null : LEGACY_BETS[r.handi];
  if (!legacy) return r;
  const [betNm, winTxt, drawTxt, loseTxt] = legacy;
  return { ...r, betNm, winTxt: r.winTxt ?? winTxt, drawTxt: r.drawTxt ?? drawTxt, loseTxt: r.loseTxt ?? loseTxt };
}

// 결과 확정: 요즘 회차는 protoStatus 4 과거 회차는 20
export const isFinished = (b) => ["4", "20"].includes(String(b.status)) && !!b.score;

export function ingestStmts(db, gmTs, rows) {
  const ts = nowIso();
  const upsert = db.prepare(
    `INSERT INTO proto_matches (gm_ts, match_seq, league, home, away, game_ts, bet_id, bet_name, handi,
       win_txt, draw_txt, lose_txt, status, result, score, updated_at, sgl)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
     ON CONFLICT(gm_ts, match_seq) DO UPDATE SET
       league=excluded.league, home=excluded.home, away=excluded.away, game_ts=excluded.game_ts,
       bet_name=excluded.bet_name, handi=excluded.handi, win_txt=excluded.win_txt,
       draw_txt=excluded.draw_txt, lose_txt=excluded.lose_txt, status=excluded.status,
       result=excluded.result, score=excluded.score, updated_at=excluded.updated_at,
       sgl=COALESCE(excluded.sgl, proto_matches.sgl)`
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
  for (const raw of rows) {
    const r = normalizeRow(raw);
    const handi = r.winHandi ?? null;
    out.push(upsert.bind(
      gmTs, r.matchSeq, r.leagueShortName || r.leagueName || null, r.homeName ?? null, r.awayName ?? null,
      Math.floor(r.gameDate / 1000), r.betId ?? null, r.betNm ?? null, handi,
      r.winTxt ?? null, r.drawTxt ?? null, r.loseTxt ?? null, r.protoStatus ?? null,
      r.gameResult ?? null, r.mchScore ?? null, ts, r.sgl ?? null
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
    if (isMain(r) && isFinished(r)) g.score = r.score;
    g.bets.push(r);
  }
  return [...games.values()].sort((a, b) => a.game_ts - b.game_ts);
}

// by: "game_ts" (경기 시각 범위) 또는 "gm_ts" (회차 범위)
export async function loadGames(db, { from, to, by = "game_ts" }) {
  const col = by === "gm_ts" ? "gm_ts" : "game_ts";
  const { results } = await db
    .prepare(
      `WITH r AS (
         SELECT gm_ts, match_seq, win, draw, lose, handi, fetched_at,
           ROW_NUMBER() OVER (PARTITION BY gm_ts, match_seq ORDER BY id DESC) AS rn_last,
           ROW_NUMBER() OVER (PARTITION BY gm_ts, match_seq ORDER BY id ASC) AS rn_first
         FROM proto_odds WHERE (gm_ts, match_seq) IN
           (SELECT gm_ts, match_seq FROM proto_matches WHERE ${col} BETWEEN ?1 AND ?2)),
       o AS (
         SELECT gm_ts, match_seq,
           MAX(CASE WHEN rn_last = 1 THEN win END) AS w, MAX(CASE WHEN rn_last = 1 THEN draw END) AS d,
           MAX(CASE WHEN rn_last = 1 THEN lose END) AS l,
           MAX(CASE WHEN rn_first = 1 THEN win END) AS w0, MAX(CASE WHEN rn_first = 1 THEN draw END) AS d0,
           MAX(CASE WHEN rn_first = 1 THEN lose END) AS l0,
           MAX(CASE WHEN rn_last = 2 THEN win END) AS w1, MAX(CASE WHEN rn_last = 2 THEN draw END) AS d1,
           MAX(CASE WHEN rn_last = 2 THEN lose END) AS l1, MAX(CASE WHEN rn_last = 2 THEN handi END) AS h1,
           MAX(CASE WHEN rn_last = 1 THEN fetched_at END) AS last_at,
           COUNT(*) AS changes
         FROM r GROUP BY gm_ts, match_seq)
       SELECT m.*, o.w, o.d, o.l, o.w0, o.d0, o.l0, o.w1, o.d1, o.l1, o.h1, o.last_at, o.changes
       FROM proto_matches m LEFT JOIN o USING (gm_ts, match_seq)
       WHERE m.${col} BETWEEN ?1 AND ?2
       ORDER BY m.game_ts, m.match_seq`
    )
    .bind(from, to).all();
  return groupGames(results);
}

export const isKLeague = (name) => /^K\s?[12]?\s?리그/.test(name || "");

async function pageData(db) {
  const now = Math.floor(Date.now() / 1000);
  // 해외 리그도 저장하지만 이 화면은 K리그만 보여 준다
  const games = (await loadGames(db, { from: now - 3 * DAY, to: now + 14 * DAY })).filter((g) => isKLeague(g.league));
  return {
    upcoming: games.filter((g) => g.game_ts >= now - 3 * 3600 && !g.score),
    recent: games.filter((g) => g.score).reverse(),
  };
}

// ---------- 배당 변경 ----------

const RECENT_SEC = 24 * 3600;
const agoSec = (iso) => (iso ? Math.floor(Date.now() / 1000) - Math.floor(Date.parse(iso) / 1000) : Infinity);
const ago = (sec) => (sec < 3600 ? `${Math.max(1, Math.floor(sec / 60))}분 전` : sec < DAY ? `${Math.floor(sec / 3600)}시간 전` : `${Math.floor(sec / DAY)}일 전`);

// 게임 유형 하나의 상태: 최근 24시간 안에 바뀜(changed) / 처음 발표됨(fresh) / 없음
export function betChange(b) {
  const sec = agoSec(b.last_at);
  if (sec > RECENT_SEC || !b.last_at) return null;
  if ((b.changes || 0) <= 1) return { kind: "fresh", sec };
  return { kind: "changed", sec };
}

function recentChanges(games) {
  const out = [];
  for (const g of games) {
    for (const b of g.bets) {
      const c = betChange(b);
      if (c && c.kind === "changed") out.push({ g, b, sec: c.sec });
    }
  }
  return out.sort((a, b) => a.sec - b.sec);
}

// ---------- HTML ----------

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const kst = (ts) =>
  new Intl.DateTimeFormat("ko-KR", {
    timeZone: "Asia/Seoul", month: "2-digit", day: "2-digit", weekday: "short",
    hour: "2-digit", minute: "2-digit", hour12: false,
  }).format(new Date(ts * 1000));

function cell(label, v, v0, v1, hit, recent) {
  if (!v) return `<td class="na">-</td>`;
  const diff = v0 && v !== v0 ? v - v0 : 0;
  const move = diff
    ? `<small class="${diff < 0 ? "down" : "up"}">${diff < 0 ? "▼" : "▲"}${Math.abs(diff).toFixed(2)}</small>`
    : "";
  // 직전 수집값과 달라졌고 24시간 안의 변경이면 칸을 강조하고 이전 값을 보여 준다
  const flip = recent && v1 && v1 !== v;
  const prev = flip ? `<s class="prev">${v1.toFixed(2)}</s>` : "";
  const cls = [hit ? "hit" : "", flip ? "flip" : ""].join(" ").trim();
  return `<td class="${cls}"><span class="lbl">${esc(label)}</span>${prev}${v.toFixed(2)}${move}</td>`;
}

function betRow(b) {
  const name = String(b.bet_name || "").replace(/^축구\s*/, "");
  const ou = /언더오버/.test(name);
  const c = isFinished(b) ? null : betChange(b);
  const recent = c && c.kind === "changed";
  const lineMoved = recent && b.h1 != null && b.h1 !== b.handi;
  const handi = b.handi
    ? `<span class="h">${ou ? "기준 " : b.handi > 0 ? "+" : ""}${lineMoved ? `<s>${b.h1}</s>→` : ""}${b.handi}</span>`
    : "";
  const badge = c ? `<span class="badge ${c.kind}">${c.kind === "fresh" ? "새 배당" : "변경"} ${ago(c.sec)}</span>` : "";
  const hit = RESULT_IDX[b.result];
  // 베트맨 화면과 판매점 용지에서 찾는 경기 번호. sgl 1 은 1경기만 사는 단폴이 가능한 경기
  const no = `<span class="no">${esc(b.match_seq)}</span>`;
  const single = String(b.sgl) === "1" ? `<span class="badge single">단폴</span>` : "";
  return `<tr class="${recent ? "moved" : ""}"><th>${no}${esc(name)}${handi}${single}${badge}</th>
    ${cell(b.win_txt || "승", b.w, b.w0, b.w1, hit === 0, recent)}
    ${cell(b.draw_txt && b.draw_txt !== "-" ? b.draw_txt : "무", b.d, b.d0, b.d1, hit === 1, recent)}
    ${cell(b.lose_txt || "패", b.l, b.l0, b.l1, hit === 2, recent)}</tr>`;
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

// 경기별 링크: 베트맨 회차 화면(마감 전은 구매 화면)과 네이버 경기 정보
const BETMAN = "https://www.betman.co.kr/main/mainPage/gamebuy";
export function gameLinks(g) {
  const gmTs = g.bets[0]?.gm_ts;
  const slip = g.score ? "closedGameSlip.do" : "gameSlip.do";
  return {
    id: `g${gmTs}-${g.bets[0]?.match_seq}`,
    betman: `${BETMAN}/${slip}?gmId=G101&gmTs=${gmTs}`,
    info: `https://search.naver.com/search.naver?query=${encodeURIComponent(`${g.home} ${g.away}`)}`,
  };
}

function gameCard(g) {
  const changed = g.score ? [] : g.bets.map(betChange).filter((c) => c && c.kind === "changed");
  const flag = changed.length
    ? `<span class="badge changed">배당 변경 ${changed.length}건 · ${ago(Math.min(...changed.map((c) => c.sec)))}</span>`
    : "";
  const link = gameLinks(g);
  return `<article id="${esc(link.id)}" class="${changed.length ? "has-change" : ""}">
    <header><span class="tag">${esc(g.league)}</span><time>${kst(g.game_ts)}</time>${flag}
      ${g.score ? `<b class="score">${esc(g.score)}</b>` : ""}</header>
    <h2><a href="${esc(link.betman)}" target="_blank" rel="noopener">${esc(g.home)} <span class="muted">vs</span> ${esc(g.away)}</a></h2>
    <nav class="links"><a href="${esc(link.betman)}" target="_blank" rel="noopener">${g.score ? "베트맨 결과" : "베트맨 구매"} ↗</a>
      <a href="${esc(link.info)}" target="_blank" rel="noopener">경기 정보 ↗</a></nav>
    ${g.score ? "" : probBar(g)}
    <div class="scroll"><table><tbody>${g.bets.map(betRow).join("")}</tbody></table></div>
  </article>`;
}

function changeList(upcoming) {
  const list = recentChanges(upcoming);
  if (!list.length) return "";
  const pick = (b, now, prev) => (prev && prev !== now ? `${prev.toFixed(2)}→<b>${now.toFixed(2)}</b>` : null);
  const rows = list.slice(0, 12).map(({ g, b, sec }) => {
    const name = String(b.bet_name || "").replace(/^축구\s*/, "");
    const parts = [
      [b.win_txt || "승", pick(b, b.w, b.w1)],
      [b.draw_txt && b.draw_txt !== "-" ? b.draw_txt : "무", pick(b, b.d, b.d1)],
      [b.lose_txt || "패", pick(b, b.l, b.l1)],
    ].filter(([, t]) => t).map(([l, t]) => `${esc(l)} ${t}`).join(" · ");
    return `<li><span class="muted">${ago(sec)}</span> <a href="#${esc(gameLinks(g).id)}">${esc(g.home)} vs ${esc(g.away)}</a> <span class="muted">${esc(name)}</span> ${parts}</li>`;
  }).join("");
  return `<section class="changes"><h2>최근 24시간 배당 변경</h2><ul>${rows}</ul></section>`;
}

function page({ upcoming, recent }) {
  return `<!doctype html><html lang="ko"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>K리그 프로토 배당</title>
<style>
:root{--chg:#fef3c7;--chg-fg:#b45309;--bg:#f6f7f9;--card:#fff;--fg:#14161a;--muted:#6b7280;--line:#e5e7eb;--home:#2563eb;--draw:#9ca3af;--away:#dc2626;--up:#dc2626;--down:#2563eb;--hit:#dcfce7}
@media (prefers-color-scheme:dark){:root{--chg:#422006;--chg-fg:#f59e0b;--bg:#0f1115;--card:#181b21;--fg:#e6e8eb;--muted:#9097a3;--line:#2a2e36;--home:#3b82f6;--draw:#6b7280;--away:#ef4444;--up:#f87171;--down:#60a5fa;--hit:#14532d}}
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
.lbl{color:var(--muted);font-size:12px;margin-right:4px}
.badge{display:inline-block;margin-left:6px;padding:0 6px;border-radius:6px;font-size:11px;font-weight:700;vertical-align:1px}
h2 a{color:inherit;text-decoration:none}h2 a:hover{text-decoration:underline}
.links{display:flex;gap:12px;margin:-4px 0 10px;font-size:13px}.links a,.changes a{color:var(--home);text-decoration:none}
.links a:hover,.changes a:hover{text-decoration:underline}article{scroll-margin-top:12px}
.no{display:inline-block;min-width:34px;margin-right:6px;font-size:12px;font-weight:700;color:var(--muted);font-variant-numeric:tabular-nums}
.badge.single{background:var(--hit);color:var(--fg)}
.badge.changed{background:var(--chg);color:var(--chg-fg)}.badge.fresh{background:var(--line);color:var(--fg)}
article.has-change{border-color:var(--chg-fg);box-shadow:0 0 0 1px var(--chg-fg) inset}
td.flip{background:var(--chg)}s.prev{color:var(--muted);font-size:11px;margin-right:4px}
.changes ul{list-style:none;padding:0;margin:0}.changes li{padding:6px 0;border-top:1px solid var(--line);font-size:14px}.changes li:first-child{border-top:0}.h{margin-left:6px;color:var(--muted);font-size:12px}
small{margin-left:4px;font-size:11px}.up{color:var(--up)}.down{color:var(--down)}
article header{flex-wrap:wrap}.tag{white-space:nowrap}
@media (max-width:480px){th,td{padding:6px 4px}th{white-space:normal}th .badge{display:block;width:max-content;margin:2px 0 0}.h{margin-left:4px}.lbl{display:block;margin:0}small{display:block;margin:0}s.prev{display:block;margin:0}}
</style></head><body><main>
<h1>K리그 프로토 배당</h1>
<p class="muted">베트맨 프로토 승부식 기준 · ▲▼ 는 첫 수집 대비 변동 · <span class="badge changed">변경</span> 은 24시간 안에 바뀐 배당 · 앞 숫자는 베트맨 경기 번호 · <span class="badge single">단폴</span> 은 1경기 구매 가능</p>
${changeList(upcoming)}
${upcoming.length ? upcoming.map(gameCard).join("") : `<section class="muted">예정된 K리그 프로토 경기가 없거나 아직 수집 전입니다</section>`}
${recent.length ? `<h3>최근 결과</h3>${recent.map(gameCard).join("")}` : ""}
</main></body></html>`;
}

// 분석용 내보내기: 게임 유형별 첫 배당과 마지막 배당과 결과
//   ?gm_from=210001&gm_to=210050  회차 범위 (한 번에 100회차까지. 없으면 최근 100회차)
//   ?league=EPL                   리그 짧은 이름 (여러 개는 쉼표)
async function exportCsv(db, url) {
  const p = url.searchParams;
  let gmTo = parseInt(p.get("gm_to")) || 0;
  let gmFrom = parseInt(p.get("gm_from")) || 0;
  if (!gmTo) gmTo = (await db.prepare("SELECT MAX(gm_ts) AS m FROM proto_matches").first())?.m || 0;
  if (!gmFrom || gmTo - gmFrom > 100 * 10000) gmFrom = gmTo - 99;  // 회차 번호가 해를 넘어가도 과하게 읽지 않도록
  if (gmTo - gmFrom >= 100 && Math.floor(gmTo / 10000) === Math.floor(gmFrom / 10000)) gmFrom = gmTo - 99;
  const leagues = (p.get("league") || "").split(",").map((x) => x.trim()).filter(Boolean);
  let games = await loadGames(db, { from: gmFrom, to: gmTo, by: "gm_ts" });
  if (leagues.length) games = games.filter((g) => leagues.includes(g.league));
  const cols = ["gm_ts", "kickoff_kst", "league", "home", "away", "bet_name", "handi",
    "win_txt", "draw_txt", "lose_txt", "w0", "d0", "l0", "w", "d", "l", "changes", "status", "result", "score"];
  const q = (v) => (v == null ? "" : /[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));
  const lines = [cols.join(",")];
  for (const g of games) {
    for (const b of g.bets) {
      const kickoff = new Date((b.game_ts + 9 * 3600) * 1000).toISOString().slice(0, 16).replace("T", " ");
      lines.push(cols.map((c) => q(c === "kickoff_kst" ? kickoff : b[c])).join(","));
    }
  }
  // 엑셀에서 한글이 깨지지 않게 BOM 을 붙인다
  return new Response("\ufeff" + lines.join("\n"), {
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": 'attachment; filename="kleague_proto.csv"',
    },
  });
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
    if (url.pathname === "/export.csv") return exportCsv(env.DB, url);
    if (url.pathname === "/api/rounds") {
      // 저장된 회차별 경기 수. 내보내기를 나눠 받을 때 쓴다
      const { results } = await env.DB
        .prepare("SELECT gm_ts, league, COUNT(DISTINCT game_ts || home || away) AS games FROM proto_matches GROUP BY gm_ts, league ORDER BY gm_ts")
        .all();
      return Response.json(results);
    }
    if (url.pathname !== "/") return new Response("not found", { status: 404 });
    return new Response(page(await pageData(env.DB)), {
      headers: { "content-type": "text/html; charset=utf-8", "cache-control": "public, max-age=120" },
    });
  },
};
