// 국내 프로토 배당 조회 페이지 (Cloudflare Worker + D1). 축구 야구 농구 배구 국내 리그 전체
//   베트맨은 해외 IP를 막으므로 국내 PC의 betman_collector.py 가 수집해서 /ingest 로 보낸다.
//   POST /ingest       : 수집기가 보낸 compSchedules 행 저장 (INGEST_TOKEN 필요)
//   GET  /             : 다가오는 경기의 게임 유형별 배당과 첫 수집 대비 변동, 최근 결과 (?sport=야구 로 종목 선택)
//   GET  /api/upcoming : 같은 데이터를 JSON 으로. 해외(MLB NBA 해외 축구 등)까지 전부 (?scope=domestic 이면 국내만)
//   GET  /export.csv   : 저장된 경기와 배당 CSV (분석용. gm_from gm_to league 로 나눠 받기)
//   GET  /api/rounds   : 회차별 리그별 경기 수
//   GET  /api/accuracy : 국내 경기 배당 예상과 실제 결과 비교 (?sport=야구)
//   POST /notify       : K리그 카카오톡 알림 (src/alerts.js)
//   GET  /api/picks    : 베팅 추천 근거 (과거 검증 결과와 후했던 배당 구간. src/picks.js)

import { runAlerts, kakaoLogin, kakaoCallback, alertsPending, alertsAck } from "./alerts.js";
import { Model, aggSql, modelFromAgg, backtestAgg, goodBuckets, MIN_EV, MIN_N } from "./picks.js";

const DAY = 86400;
const RESULT_IDX = { 0: 0, 1: 1, 2: 2 };

const nowIso = () => new Date().toISOString().replace(/\.\d+Z$/, "Z");
// 0 은 미발표 1.0 은 미발매 자리값이라 버린다
const num = (v) => (typeof v === "number" && v > 1 ? v : null);

// 베트맨 itemCode 로 종목을 안다
const SPORT_CODES = { SC: "축구", BS: "야구", BK: "농구", VL: "배구", VB: "배구" };
const SPORTS = ["축구", "야구", "농구", "배구"];
export const sportOf = (betName) => {
  const first = String(betName || "").split(/\s/)[0];
  return SPORTS.includes(first) ? first : "기타";
};

// 과거 회차(2021~)는 betNm 과 winTxt 가 비어 있고 handi 코드로만 게임 종류를 알 수 있다
const LEGACY_BETS = {
  0: ["승무패", "승", "무", "패"],
  2: ["핸디캡", "승", "무", "패"],
  23: ["소수핸디캡", "승", "-", "패"],
  9: ["언더오버", "언더", "-", "오버"],
  27: ["SUM", "홀", "-", "짝"],
};

export function normalizeRow(r) {
  const legacy = r.betNm ? null : LEGACY_BETS[r.handi];
  if (!legacy) return r;
  let [kind, winTxt, drawTxt, loseTxt] = legacy;
  const sport = SPORT_CODES[r.itemCode] || "축구";
  // 축구가 아닌 종목의 기본 게임은 무승부 배당이 없으면 승패다
  if (kind === "승무패" && sport !== "축구" && !(r.drawAllot > 1)) [kind, drawTxt] = ["승패", "-"];
  return { ...r, betNm: `${sport} ${kind}`, winTxt: r.winTxt ?? winTxt, drawTxt: r.drawTxt ?? drawTxt, loseTxt: r.loseTxt ?? loseTxt };
}

// 결과 확정: 요즘 회차는 protoStatus 4 과거 회차는 20
export const isFinished = (b) => ["4", "20"].includes(String(b.status)) && !!b.score;

export function ingestStmts(db, gmTs, rows) {
  const ts = nowIso();
  const upsert = db.prepare(
    `INSERT INTO proto_matches (gm_ts, match_seq, league, home, away, game_ts, bet_id, bet_name, handi,
       win_txt, draw_txt, lose_txt, status, result, score, updated_at, sgl, domestic)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
     ON CONFLICT(gm_ts, match_seq) DO UPDATE SET
       league=excluded.league, home=excluded.home, away=excluded.away, game_ts=excluded.game_ts,
       bet_name=excluded.bet_name, handi=excluded.handi, win_txt=excluded.win_txt,
       draw_txt=excluded.draw_txt, lose_txt=excluded.lose_txt, status=excluded.status,
       result=excluded.result, score=excluded.score, updated_at=excluded.updated_at,
       sgl=COALESCE(excluded.sgl, proto_matches.sgl), domestic=COALESCE(excluded.domestic, proto_matches.domestic)
     -- 바뀐 것이 없으면 쓰지 않는다 (D1 무료 쓰기 한도 절약)
     WHERE proto_matches.league IS NOT excluded.league OR proto_matches.home IS NOT excluded.home
       OR proto_matches.away IS NOT excluded.away OR proto_matches.game_ts IS NOT excluded.game_ts
       OR proto_matches.bet_name IS NOT excluded.bet_name OR proto_matches.handi IS NOT excluded.handi
       OR proto_matches.win_txt IS NOT excluded.win_txt OR proto_matches.draw_txt IS NOT excluded.draw_txt
       OR proto_matches.lose_txt IS NOT excluded.lose_txt OR proto_matches.status IS NOT excluded.status
       OR proto_matches.result IS NOT excluded.result OR proto_matches.score IS NOT excluded.score
       OR (excluded.sgl IS NOT NULL AND proto_matches.sgl IS NOT excluded.sgl)
       OR (excluded.domestic IS NOT NULL AND proto_matches.domestic IS NOT excluded.domestic)`
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
      r.gameResult ?? null, r.mchScore ?? null, ts, r.sgl ?? null,
      r.domastic === true ? 1 : r.domastic === false ? 0 : null
    ));
    const [w, d, l] = [num(r.winAllot), num(r.drawAllot), num(r.loseAllot)];
    if (w || d || l) out.push(snap.bind(gmTs, r.matchSeq, w, d, l, handi, ts));
  }
  return out;
}

async function runBatch(db, stmts) {
  for (let i = 0; i < stmts.length; i += 200) await db.batch(stmts.slice(i, i + 200));
}

// 기본 게임: 축구는 승무패 야구 농구 배구는 승패
const isMain = (b) => /(승무패|승패)$/.test(b.bet_name || "") && !/전반/.test(b.bet_name || "");
export const mainOf = (g) => g.bets.find((b) => isMain(b) && b.w && b.l);

// 경기(홈/원정/시각) 단위로 게임 유형들을 묶는다
function groupGames(rows) {
  const games = new Map();
  for (const r of rows) {
    const key = `${r.game_ts}|${r.home}|${r.away}`;
    if (!games.has(key)) {
      games.set(key, { game_ts: r.game_ts, league: r.league, home: r.home, away: r.away, score: null,
                       sport: sportOf(r.bet_name), domestic: null, bets: [] });
    }
    const g = games.get(key);
    if (r.domestic != null) g.domestic = r.domestic;
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
// 베트맨 국내 표시가 없던 행은 국내 리그 이름으로 판단한다
const DOMESTIC_RE = /^(?:K\s?[12]?\s?리그|WK리그|KBO|KBL|WKBL|KOVO|V-?리그|남농|여농|남배|여배)/;
export const isDomestic = (g) => g.domestic === 1 || g.domestic === true || (g.domestic == null && DOMESTIC_RE.test(g.league || ""));

// 최근 3일 ~ 앞으로 14일 경기. 종목 탭과 API 가 같은 목록을 쓰도록 10분 캐시한다 (D1 읽기 절약)
async function recentGames(db, ctx) {
  const make = async () => {
    const now = Math.floor(Date.now() / 1000);
    const games = await loadGames(db, { from: now - 3 * DAY, to: now + 14 * DAY });
    for (const g of games) g.domestic = isDomestic(g);
    return games;
  };
  if (typeof caches === "undefined") return make();
  const key = new Request("https://kl.usb.kr/__cache/recent-games");
  const hit = await caches.default.match(key);
  if (hit) return hit.json();
  const games = await make();
  const put = caches.default.put(key, Response.json(games, { headers: { "cache-control": `public, max-age=${PAGE_TTL}` } }));
  if (ctx) ctx.waitUntil(put); else await put;
  return games;
}

// domesticOnly: 화면은 국내만. /api/upcoming 은 해외(MLB NBA 해외 축구 등)까지 전부 준다
async function pageData(db, { sport = "", ctx, domesticOnly = true } = {}) {
  const now = Math.floor(Date.now() / 1000);
  const loaded = await recentGames(db, ctx);
  const all = domesticOnly ? loaded.filter((g) => g.domestic) : loaded;
  const counts = Object.fromEntries(SPORTS.map((s) => [s, all.filter((g) => g.sport === s && !g.score).length]));
  const games = sport ? all.filter((g) => g.sport === sport) : all;
  const stats = await getStats(db, ctx);
  const model = new Model(stats.picks.model);
  const picks = [];
  for (const g of games) {
    if (g.score || g.game_ts < now || !g.domestic) continue;  // 추천 근거는 국내 경기 기록이라 국내만
    for (const b of g.bets) {
      b.picks = model.picks(b);
      for (const p of b.picks) picks.push({ g, b, p });
    }
  }
  picks.sort((a, b) => b.p.ev - a.p.ev);
  return {
    sport, counts, picks, backtest: stats.picks.backtest,
    upcoming: games.filter((g) => g.game_ts >= now - 3 * 3600 && !g.score),
    recent: games.filter((g) => g.score).reverse().slice(0, domesticOnly ? 40 : 200),
    accuracy: accuracyFromAgg(stats.accuracy, sport),
    ledger: domesticOnly ? await pickLedger(db) : undefined,
  };
}

// ---------- 예상과 결과 ----------
// 배당이 가장 낮은 쪽(정배)이 배당의 예상이다. 마진을 뺀 확률이 예상 적중률이고 실제 결과와 비교한다.

// d 가 없으면 무승부 없는 승패 게임 (야구 농구 배구)
export function favoriteOf(w, d, l) {
  const odds = [w, d > 1 ? d : null, l];
  const inv = odds.map((x) => (x ? 1 / x : 0));
  const sum = inv[0] + inv[1] + inv[2];
  const fav = odds.indexOf(Math.min(...odds.filter(Boolean)));
  const dog = w >= l ? 0 : 2;  // 홈과 원정 중 배당이 높은 쪽
  return { fav, dog, probs: inv.map((x) => x / sum), margin: sum - 1 };
}

const BUCKETS = ["1.5 미만", "1.5~2.0", "2.0~2.5", "2.5 이상"];

// 국내 리그 조건 (SQL). 베트맨 국내 표시가 없던 과거 행은 리그 이름으로 본다 (DOMESTIC_RE 와 같은 뜻)
const DOMESTIC_SQL = `(m.domestic = 1 OR (m.domestic IS NULL AND (${
  ["K리그%", "K1%", "K2%", "WK리그%", "KBO%", "KBL%", "WKBL%", "KOVO%", "V리그%", "V-리그%", "남농%", "여농%", "남배%", "여배%"]
    .map((x) => `m.league LIKE '${x}'`).join(" OR ")})))`;

// 기본 게임(승무패 / 승패)의 정배 · 무승부 · 역배 결과를 (종목 리그 시즌 정배배당구간) 별로 SQL 이 더한다
const ACCURACY_SQL = `
  WITH f AS (
    SELECT substr(m.bet_name, 1, instr(m.bet_name, ' ') - 1) AS sport, m.league,
      strftime('%Y', m.game_ts + 32400, 'unixepoch') AS season, CAST(m.result AS INTEGER) AS r,
      o.win AS w, CASE WHEN o.draw > 1 THEN o.draw END AS d, o.lose AS l
    FROM proto_matches m
    JOIN proto_odds o ON o.id = (SELECT MAX(id) FROM proto_odds WHERE gm_ts = m.gm_ts AND match_seq = m.match_seq)
    WHERE (m.bet_name LIKE '%승무패' OR m.bet_name LIKE '%승패') AND m.bet_name NOT LIKE '%전반%'
      AND m.status IN ('4', '20') AND m.result IN ('0', '1', '2') AND o.win > 1 AND o.lose > 1 AND ${DOMESTIC_SQL}),
  g AS (
    SELECT *, 1.0 / w + COALESCE(1.0 / d, 0) + 1.0 / l AS s,
      CASE WHEN w <= l AND (d IS NULL OR w <= d) THEN 0 WHEN d IS NOT NULL AND d <= l THEN 1 ELSE 2 END AS fav,
      CASE WHEN w >= l THEN 0 ELSE 2 END AS dog
    FROM f WHERE NOT (r = 1 AND d IS NULL)),
  h AS (SELECT *, CASE fav WHEN 0 THEN w WHEN 1 THEN d ELSE l END AS fo, CASE dog WHEN 0 THEN w ELSE l END AS go FROM g)
  SELECT sport, league, season, CASE WHEN fo < 1.5 THEN 0 WHEN fo < 2.0 THEN 1 WHEN fo < 2.5 THEN 2 ELSE 3 END AS bucket,
    COUNT(*) AS n, SUM(1.0 / fo / s) AS fexp, SUM(r = fav) AS fhit, SUM(CASE WHEN r = fav THEN fo ELSE 0 END) AS fret,
    SUM(d IS NOT NULL) AS dn, SUM(COALESCE(1.0 / d / s, 0)) AS dexp, SUM(r = 1) AS dhit, SUM(CASE WHEN r = 1 THEN d ELSE 0 END) AS dret,
    SUM(1.0 / go / s) AS gexp, SUM(r = dog) AS ghit, SUM(CASE WHEN r = dog THEN go ELSE 0 END) AS gret
  FROM h GROUP BY sport, league, season, bucket`;

// agg: ACCURACY_SQL 결과. sport 가 비면 전 종목
export function accuracyFromAgg(agg, sport = "") {
  const blank = () => ({ n: 0, exp: 0, hit: 0, ret: 0 });
  const total = blank(), draw = blank(), dog = blank();
  const buckets = BUCKETS.map((label) => ({ label, ...blank() }));
  const seasons = {}, leagues = {};
  const add = (acc, n, exp, hit, ret) => { acc.n += n; acc.exp += exp; acc.hit += hit; acc.ret += ret; };
  for (const a of agg) {
    if (sport && a.sport !== sport) continue;
    for (const acc of [total, buckets[a.bucket], (seasons[a.season] ||= blank()), (leagues[a.league] ||= blank())]) {
      add(acc, a.n, a.fexp, a.fhit, a.fret);
    }
    add(draw, a.dn, a.dexp, a.dhit, a.dret);
    add(dog, a.n, a.gexp, a.ghit, a.gret);
  }
  return { total, buckets: buckets.filter((b) => b.n), draw, dog,
           seasons: Object.entries(seasons).sort().map(([season, acc]) => ({ season, ...acc })),
           leagues: Object.entries(leagues).sort((a, b) => b[1].n - a[1].n).map(([league, acc]) => ({ league, ...acc })) };
}

// ---------- 추천 베팅 기록 ----------
// 수집기가 /notify 를 부를 때(30분마다) 앞으로 3일 안 국내 경기의 추천을 pick_log 에 남긴다.
// 경기 전 마지막 확인에서도 추천이었던 것만(active=1) 결과 기록에 넣는다. 배당은 그때 마지막 배당.
async function recordPicks(db, ctx) {
  const now = Math.floor(Date.now() / 1000);
  const games = (await loadGames(db, { from: now, to: now + 3 * DAY })).filter(isDomestic);
  const model = new Model((await getStats(db, ctx)).picks.model);
  const want = new Map();
  for (const g of games) {
    for (const b of g.bets) {
      for (const p of model.picks(b)) want.set(`${b.gm_ts}|${b.match_seq}|${p.side}`, { b, p });
    }
  }
  const { results } = await db.prepare("SELECT gm_ts, match_seq, side, odd, active FROM pick_log WHERE game_ts > ?").bind(now).all();
  const have = new Map(results.map((r) => [`${r.gm_ts}|${r.match_seq}|${r.side}`, r]));
  const stmts = [];
  for (const [key, { b, p }] of want) {
    const old = have.get(key);
    if (old && old.active === 1 && old.odd === p.odd) continue;  // 그대로면 쓰지 않는다
    stmts.push(db.prepare(
      `INSERT INTO pick_log (gm_ts, match_seq, side, game_ts, odd, ev, active, first_at, last_at) VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)
       ON CONFLICT(gm_ts, match_seq, side) DO UPDATE SET odd = excluded.odd, ev = excluded.ev, active = 1,
         game_ts = excluded.game_ts, last_at = excluded.last_at`
    ).bind(b.gm_ts, b.match_seq, p.side, b.game_ts, p.odd, p.ev, now, now));
  }
  for (const [key, r] of have) {
    if (!want.has(key) && r.active === 1) {
      stmts.push(db.prepare("UPDATE pick_log SET active = 0, last_at = ? WHERE gm_ts = ? AND match_seq = ? AND side = ?")
        .bind(now, r.gm_ts, r.match_seq, r.side));
    }
  }
  if (stmts.length) await db.batch(stmts);
  return stmts.length;
}

// 기록된 추천과 결과. 결과: won true/false, 적특(승패 게임의 무 결과)과 결과 전은 null
async function pickLedger(db) {
  const { results } = await db.prepare(
    `SELECT p.gm_ts, p.match_seq, p.side, p.game_ts, p.odd, p.ev, m.league, m.home, m.away, m.bet_name, m.handi,
       m.win_txt, m.draw_txt, m.lose_txt, m.status, m.result, m.score, m.sgl
     FROM pick_log p JOIN proto_matches m USING (gm_ts, match_seq)
     WHERE p.active = 1 ORDER BY p.game_ts DESC, p.match_seq LIMIT 300`
  ).all();
  return results.map((r) => {
    const done = isFinished(r) && ["0", "1", "2"].includes(String(r.result));
    const voided = done && String(r.result) === "1" && !r.draw_txt?.replace("-", "");
    return { ...r, won: done && !voided ? Number(r.result) === r.side : null, voided };
  });
}

export function ledgerSummary(rows) {
  const settled = rows.filter((r) => r.won !== null).sort((a, b) => a.game_ts - b.game_ts);
  let profit = 0;
  const curve = settled.map((r) => ({ ts: r.game_ts, profit: (profit += (r.won ? r.odd - 1 : -1) * STAKE) }));
  const hit = settled.filter((r) => r.won).length;
  return { n: settled.length, hit, profit, roi: settled.length ? profit / (settled.length * STAKE) : null,
           pending: rows.filter((r) => r.won === null && !r.voided).length, curve };
}

// ---------- 과거 통계 (적중률과 추천 근거) ----------
// 끝난 경기 전체를 훑는 무거운 계산이라 하루 한 번만 하고 결과를 D1 kv 에 둔다.
// (전체 스캔 한 번이 D1 읽기 수십만 행이라 요청마다 하면 무료 읽기 한도 하루 500만을 넘는다)
const STATS_TTL = 24 * 3600;

async function computeStats(db) {
  const [acc, pk] = await db.batch([db.prepare(ACCURACY_SQL), db.prepare(aggSql(DOMESTIC_SQL))]);
  const model = modelFromAgg(pk.results);
  const stats = {
    at: Math.floor(Date.now() / 1000),
    accuracy: acc.results,
    picks: { model: model.toJSON(), backtest: backtestAgg(pk.results), good: goodBuckets(model),
             rows: pk.results.reduce((s, a) => s + (a.side === 0 ? a.n : 0), 0) },
  };
  await db.prepare("INSERT INTO kv (key, value) VALUES ('stats', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
    .bind(JSON.stringify(stats)).run();
  return stats;
}

let statsMemo = null;  // 같은 Worker 인스턴스 안에서 다시 읽지 않도록
export async function getStats(db, ctx, force = false) {
  const now = Math.floor(Date.now() / 1000);
  if (!force && statsMemo && now - statsMemo.at < STATS_TTL) return statsMemo;
  const row = force ? null : await db.prepare("SELECT value FROM kv WHERE key = 'stats'").first();
  const saved = row ? JSON.parse(row.value) : null;
  if (saved && now - saved.at < STATS_TTL) return (statsMemo = saved);
  if (saved && ctx) {
    // 오래된 값을 먼저 보여 주고 뒤에서 새로 계산한다
    ctx.waitUntil(computeStats(db).then((s) => (statsMemo = s)));
    return saved;
  }
  return (statsMemo = await computeStats(db));
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
export const kst = (ts) =>
  new Intl.DateTimeFormat("ko-KR", {
    timeZone: "Asia/Seoul", month: "2-digit", day: "2-digit", weekday: "short",
    hour: "2-digit", minute: "2-digit", hour12: false,
  }).format(new Date(ts * 1000));

function cell(label, v, v0, v1, hit, recent, pick) {
  if (!v) return `<td class="na">-</td>`;
  const diff = v0 && v !== v0 ? v - v0 : 0;
  const move = diff
    ? `<small class="${diff < 0 ? "down" : "up"}">${diff < 0 ? "▼" : "▲"}${Math.abs(diff).toFixed(2)}</small>`
    : "";
  // 직전 수집값과 달라졌고 24시간 안의 변경이면 칸을 강조하고 이전 값을 보여 준다
  const flip = recent && v1 && v1 !== v;
  const prev = flip ? `<s class="prev">${v1.toFixed(2)}</s>` : "";
  const cls = [hit ? "hit" : "", flip ? "flip" : "", pick ? "pick" : ""].join(" ").trim();
  const tag = pick ? `<em class="ptag">▶ 여기 베팅</em>` : "";
  return `<td class="${cls}">${tag}<span class="lbl">${esc(label)}</span>${prev}${v.toFixed(2)}${move}</td>`;
}

export const stripSport = (name) => String(name || "").replace(/^(축구|야구|농구|배구)\s*/, "");

const pickOf = (b, side) => (b.picks || []).find((p) => p.side === side);
const sideName = (b, side) =>
  [b.win_txt || "승", b.draw_txt && b.draw_txt !== "-" ? b.draw_txt : "무", b.lose_txt || "패"][side];

// 추천 목록과 과거 검증 결과. "어디에 무엇을 얼마" 가 바로 보이게 표 대신 베팅표처럼 보여 준다
const circled = (n) => "①②③④⑤⑥⑦⑧⑨⑩⑪⑫⑬⑭⑮"[n] || `${n + 1}.`;
function picksSection(picks, bt) {
  const roi = bt && bt.n ? bt.ret / bt.n - 1 : null;
  const verdict = roi == null
    ? `과거 검증: 아직 데이터 부족 (앞 시즌 기록으로 다음 시즌을 맞혀 보는데 시즌이 2개 이상 쌓여야 합니다)`
    : `과거 검증: 같은 방법으로 ${bt.n}번 샀다면 적중 ${pc(bt.hit / bt.n)} · 수익률 <b class="${roi >= 0 ? "up" : "down"}">${roi >= 0 ? "+" : ""}${pc(roi)}</b> · 10만원씩 ${won((bt.ret - bt.n) * STAKE)}`;
  const trusted = roi != null && roi > 0;
  const warn = trusted ? ""
    : `<p class="warn">⚠️ 과거 검증 수익률이 아직 + 가 아닙니다. 사더라도 아주 적은 금액으로만 시험하세요.</p>`;
  const list = picks.slice(0, 10);
  if (!list.length) {
    return `<section class="picks"><h2>🎯 베팅할 곳</h2>
      <div class="none"><b>지금은 베팅할 경기가 없습니다</b><br>조건(기대수익 ${MIN_EV * 100}% 이상 · 비슷한 과거 ${MIN_N}번 이상)에 맞는 선택이 없으니 사지 마세요.</div>
      <p class="muted small">${verdict}</p></section>`;
  }
  const tickets = list.map(({ g, b, p }, n) => {
    const single = String(b.sgl) === "1";
    const hd = b.handi ? ` ${/언더오버/.test(b.bet_name) ? "기준 " : b.handi > 0 ? "+" : ""}${b.handi}` : "";
    const pick = sideName(b, p.side);
    const back = Math.round(p.odd * STAKE);
    return `<li class="ticket">
      <div class="t-head"><span class="t-no">${circled(n)}</span><a href="#${esc(gameLinks(g).id)}">${esc(g.home)} vs ${esc(g.away)}</a>
        <span class="muted">${kst(g.game_ts)} · ${esc(g.league)}</span></div>
      <div class="t-body">
        <div>경기 번호 <b class="big">${esc(b.match_seq)}</b> · ${esc(stripSport(b.bet_name))}${esc(hd)}</div>
        <div class="t-pick">▶ <b class="pickname">${esc(pick)}</b> 에 베팅 · 배당 <b>${p.odd.toFixed(2)}</b></div>
        <div>10만원 → 맞으면 <b>${comma(back)}원</b> 받음 (<span class="up">${won(back - STAKE)}</span>) · 틀리면 <span class="down">-100,000원</span></div>
        <div>${single ? `<span class="badge single">단폴</span> 이 경기 하나만 사도 됩니다` : `<span class="badge miss">단폴 불가</span> 다른 경기와 2개 이상 묶어야 삽니다`}</div>
        <div class="muted small2">근거: 비슷한 과거 ${p.n}번 중 ${pc(p.pastHit)} 적중 · 배당이 말한 확률 ${pc(p.p)} · 기대수익 ${p.ev >= 0 ? "+" : ""}${(p.ev * 100).toFixed(1)}%</div>
      </div></li>`;
  }).join("");
  // 단폴이 안 되는 추천은 서로 다른 경기끼리 두 개를 묶는 방법을 알려 준다 (같은 경기의 다른 게임은 묶을 수 없다)
  const multi = list.map((x, n) => ({ ...x, n })).filter(({ b }) => String(b.sgl) !== "1");
  let combo = "";
  if (multi.length) {
    const a = multi[0];
    const partner = list.map((x, n) => ({ ...x, n })).find((x) => x.n !== a.n && gameLinks(x.g).id !== gameLinks(a.g).id);
    combo = partner
      ? `<p class="combo">단폴 불가 추천은 <b>${circled(a.n)} + ${circled(partner.n)}</b> 처럼 다른 경기와 2개를 묶어 한 장으로 삽니다. 두 개 다 맞아야 하고 배당은 곱해져 <b>${(a.p.odd * partner.p.odd).toFixed(2)}배</b>입니다.</p>`
      : `<p class="combo">단폴 불가 추천만 있고 묶을 다른 추천이 없습니다. 이번에는 사지 않는 것이 좋습니다.</p>`;
  }
  return `<section class="picks"><h2>🎯 베팅할 곳 ${list.length}개</h2>
    <p class="small">베트맨 <b>게임구매 → 프로토 승부식</b> 에서 <b>경기 번호</b>를 찾아 <b>▶ 표시한 쪽</b>을 고릅니다. 판매점 용지는 경기 번호와 그 칸을 칠합니다. 경기 카드에서는 <span class="legend-pick">보라색 칸</span>이 베팅할 곳이고 다른 색은 정보입니다.</p>
    ${warn}<ol class="tickets">${tickets}</ol>${combo}
    <p class="muted small">${verdict}</p></section>`;
}

function betRow(b) {
  const name = stripSport(b.bet_name);
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
    ${cell(b.win_txt || "승", b.w, b.w0, b.w1, hit === 0, recent, pickOf(b, 0))}
    ${cell(b.draw_txt && b.draw_txt !== "-" ? b.draw_txt : "무", b.d, b.d0, b.d1, hit === 1, recent, pickOf(b, 1))}
    ${cell(b.lose_txt || "패", b.l, b.l0, b.l1, hit === 2, recent, pickOf(b, 2))}</tr>`;
}

function probBar(g) {
  const main = mainOf(g);
  if (!main) return "";
  const { probs, margin } = favoriteOf(main.w, main.d, main.l);
  const seg = ["home", "draw", "away"]
    .map((c, i) => (probs[i] ? `<span class="${c}" style="flex:${probs[i]}">${(probs[i] * 100).toFixed(0)}%</span>` : ""))
    .join("");
  return `<div class="bar">${seg}</div><p class="muted small">마진 ${(margin * 100).toFixed(1)}% · 마진 제외 확률</p>`;
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

// 경기마다 거는 금액 (예상 vs 결과 손익 계산용)
const STAKE = 100000;
const comma = (n) => String(Math.abs(Math.round(n))).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
const man = (x) => {
  const [int, dec] = (Math.abs(x) / 10000).toFixed(1).split(".");
  return `${x >= 0 ? "+" : "-"}${comma(int)}.${dec}만`;
};
export const won = (x) => `${x >= 0 ? "+" : "-"}${comma(x)}원`;

function verdict(g) {
  const main = mainOf(g);
  if (!g.score || !main || !["0", "1", "2"].includes(String(main.result))) return "";
  const { fav } = favoriteOf(main.w, main.d, main.l);
  const res = Number(main.result);
  const odd = [main.w, main.d, main.l][fav];
  if (res === 1 && !(main.d > 1)) return "";  // 승패 게임 적특
  if (res === fav) return `<span class="badge hit">정배 적중 · 10만원 → ${won((odd - 1) * STAKE)}</span>`;
  return `<span class="badge miss">${res === 1 ? "무승부" : "이변"} · 정배 ${["홈승", "무", "원정승"][fav]} 실패 · 10만원 → ${won(-STAKE)}</span>`;
}

function gameCard(g) {
  const changed = g.score ? [] : g.bets.map(betChange).filter((c) => c && c.kind === "changed");
  const flag = changed.length
    ? `<span class="badge changed">배당 변경 ${changed.length}건 · ${ago(Math.min(...changed.map((c) => c.sec)))}</span>`
    : "";
  const link = gameLinks(g);
  return `<article id="${esc(link.id)}" class="${changed.length ? "has-change" : ""}">
    <header><span class="tag">${esc(g.league)}</span><time>${kst(g.game_ts)}</time>${flag}${verdict(g)}
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
    const name = stripSport(b.bet_name);
    const parts = [
      [b.win_txt || "승", pick(b, b.w, b.w1)],
      [b.draw_txt && b.draw_txt !== "-" ? b.draw_txt : "무", pick(b, b.d, b.d1)],
      [b.lose_txt || "패", pick(b, b.l, b.l1)],
    ].filter(([, t]) => t).map(([l, t]) => `${esc(l)} ${t}`).join(" · ");
    return `<li><span class="muted">${ago(sec)}</span> <a href="#${esc(gameLinks(g).id)}">${esc(g.home)} vs ${esc(g.away)}</a> <span class="muted">${esc(name)}</span> ${parts}</li>`;
  }).join("");
  return `<section class="changes"><h2>최근 24시간 배당 변경</h2><ul>${rows}</ul></section>`;
}

const pc = (x) => `${(x * 100).toFixed(1)}%`;
function accRow(label, a) {
  const actual = a.hit / a.n, expected = a.exp / a.n, roi = a.ret / a.n - 1;
  const gap = actual - expected;
  return `<tr><th>${esc(label)}</th><td>${a.n}</td><td>${pc(expected)}</td><td><b>${pc(actual)}</b></td>
    <td class="${gap >= 0 ? "up" : "down"}">${gap >= 0 ? "+" : ""}${(gap * 100).toFixed(1)}</td>
    <td class="${roi >= 0 ? "up" : "down"}">${roi >= 0 ? "+" : ""}${pc(roi)}</td>
    <td class="${roi >= 0 ? "up" : "down"}">${man((a.ret - a.n) * STAKE)}</td></tr>`;
}

function accuracySection(acc, sport) {
  if (!acc || !acc.total.n) return "";
  const main = sport === "축구" ? "승무패" : sport ? "승패" : "승무패 (축구) 와 승패 (야구 농구 배구)";
  const head = `<thead><tr><th></th><th>경기</th><th>예상</th><th>실제</th><th>차이</th><th>수익률</th><th>손익</th></tr></thead>`;
  return `<h3 id="accuracy">배당 예상 vs 실제 결과</h3>
  <section>
    <p class="muted small">${esc(sport || "전 종목")} 국내 리그 ${esc(main)} 마감 배당 기준 · 정배는 배당이 가장 낮은 쪽 · 역배는 홈승과 원정승 중 배당이 높은 쪽 · 예상은 마진을 뺀 배당 확률 · 수익률은 매번 같은 금액을 걸었을 때 · 손익은 경기마다 10만원을 걸었을 때 총 손익 (만원)</p>
    <div class="scroll"><table class="acc">${head}<tbody>
      ${accRow("정배", acc.total)}
      ${acc.draw.n ? accRow("무승부", acc.draw) : ""}
      ${accRow("역배", acc.dog)}
    </tbody></table></div>
    <h4>리그별 정배</h4>
    <div class="scroll"><table class="acc">${head}<tbody>${acc.leagues.map((x) => accRow(x.league, x)).join("")}</tbody></table></div>
    <h4>정배 배당 구간별</h4>
    <div class="scroll"><table class="acc">${head}<tbody>${acc.buckets.map((b) => accRow(b.label, b)).join("")}</tbody></table></div>
    <h4>시즌별 정배</h4>
    <div class="scroll"><table class="acc">${head}<tbody>${acc.seasons.map((x) => accRow(`${x.season}년`, x)).join("")}</tbody></table></div>
    <p class="muted small">차이가 + 면 배당이 예상한 것보다 실제로 더 자주 맞았다는 뜻입니다. 수익률은 마진 약 15% 때문에 대부분 마이너스입니다.</p>
  </section>`;
}

function tabs(sport, counts) {
  const link = (s, label) =>
    `<a href="${s ? `/?sport=${encodeURIComponent(s)}` : "/"}" class="${s === sport ? "on" : ""}">${label}</a>`;
  return `<nav class="tabs">${link("", "전체")}${SPORTS.map((s) => link(s, `${s} <small>${counts[s] || 0}</small>`)).join("")}</nav>`;
}

// 누적 손익 선 (한 줄이라 범례 없이 제목이 이름). 점마다 마우스를 올리면 그때 손익이 보인다
function profitChart(curve) {
  if (curve.length < 2) return "";
  const W = 600, H = 160, P = 8;
  const ys = curve.map((c) => c.profit).concat(0);
  const lo = Math.min(...ys), hi = Math.max(...ys), span = hi - lo || 1;
  const x = (i) => P + (i * (W - 2 * P)) / (curve.length - 1);
  const y = (v) => P + ((hi - v) * (H - 2 * P)) / span;
  const pts = curve.map((c, i) => `${x(i).toFixed(1)},${y(c.profit).toFixed(1)}`).join(" ");
  const dots = curve.map((c, i) =>
    `<circle cx="${x(i).toFixed(1)}" cy="${y(c.profit).toFixed(1)}" r="6" class="pt"><title>${kst(c.ts)} · 누적 ${won(c.profit)}</title></circle>`).join("");
  return `<figure class="curve"><figcaption class="muted small">누적 손익 (10만원씩)</figcaption>
    <svg viewBox="0 0 ${W} ${H}" role="img" aria-label="누적 손익 선 그래프">
      <line x1="0" x2="${W}" y1="${y(0).toFixed(1)}" y2="${y(0).toFixed(1)}" class="zero"/>
      <polyline points="${pts}" class="line"/>${dots}</svg></figure>`;
}

// 페이지 맨 아래: 추천 베팅이 실제로 어땠는지
function ledgerSection(rows) {
  if (!rows) return "";
  const s = ledgerSummary(rows);
  const tile = (label, value, cls = "") => `<div class="tile"><span class="muted">${label}</span><b class="${cls}">${value}</b></div>`;
  const tiles = `<div class="tiles">
    ${tile("베팅", `${s.n}번`)}
    ${tile("적중", s.n ? `${s.hit}번 · ${pc(s.hit / s.n)}` : "-")}
    ${tile("손익 (10만원씩)", s.n ? won(s.profit) : "-", s.profit > 0 ? "up" : s.profit < 0 ? "down" : "")}
    ${tile("수익률", s.roi == null ? "-" : `${s.roi >= 0 ? "+" : ""}${pc(s.roi)}`, s.roi > 0 ? "up" : s.roi < 0 ? "down" : "")}
    ${tile("결과 대기", `${s.pending}번`)}</div>`;
  const line = (r) => {
    const b = { win_txt: r.win_txt, draw_txt: r.draw_txt, lose_txt: r.lose_txt };
    const hd = r.handi ? ` ${/언더오버/.test(r.bet_name) ? "" : r.handi > 0 ? "+" : ""}${r.handi}` : "";
    const res = r.voided ? `<span class="muted">적특</span>`
      : r.won === null ? `<span class="muted">대기</span>`
      : r.won ? `<span class="badge hit">적중 ${esc(r.score || "")}</span>` : `<span class="badge miss">실패 ${esc(r.score || "")}</span>`;
    const pl = r.won === null ? "" : won(r.won ? (r.odd - 1) * STAKE : -STAKE);
    const when = new Date((r.game_ts + 9 * 3600) * 1000).toISOString().slice(5, 16).replace("-", ".").replace("T", " ");
    return `<tr><td class="l">${esc(r.home)} vs ${esc(r.away)}<br><span class="muted">${when} · ${esc(r.league)} · ${esc(stripSport(r.bet_name))}${esc(hd)}</span></td>
      <td><b>${esc(sideName(b, r.side))}</b><br>${r.odd.toFixed(2)}</td>
      <td>${res}<br><span class="${r.won ? "up" : r.won === false ? "down" : ""}">${pl}</span></td></tr>`;
  };
  const table = rows.length
    ? `<div class="scroll"><table class="ledger"><thead><tr><th>경기</th><th>선택</th><th>결과 · 손익</th></tr></thead>
        <tbody>${rows.slice(0, 40).map(line).join("")}</tbody></table></div>`
    : `<p class="muted">아직 기록된 추천이 없습니다. 추천이 나오면 경기 전 마지막 배당으로 자동 기록됩니다.</p>`;
  return `<h3 id="ledger">추천 베팅 결과 기록</h3>
  <section class="ledger-box">
    <p class="muted small">위 추천 베팅을 경기마다 10만원씩 샀다고 치고 기록합니다 · 경기 전 마지막 확인까지 추천이었던 것만 · 배당은 그때 마지막 배당</p>
    ${tiles}${profitChart(s.curve)}${table}
  </section>`;
}

function page({ sport, counts, upcoming, recent, accuracy, picks, backtest, ledger }) {
  return `<!doctype html><html lang="ko"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>국내 프로토 배당</title>
<style>
:root{--pick:#7c3aed;--pick-bg:#f5f3ff;--chg:#fef3c7;--chg-fg:#b45309;--bg:#f6f7f9;--card:#fff;--fg:#14161a;--muted:#6b7280;--line:#e5e7eb;--home:#2563eb;--draw:#9ca3af;--away:#dc2626;--up:#dc2626;--down:#2563eb;--hit:#dcfce7}
@media (prefers-color-scheme:dark){:root{--pick:#a78bfa;--pick-bg:#2e1065;--chg:#422006;--chg-fg:#f59e0b;--bg:#0f1115;--card:#181b21;--fg:#e6e8eb;--muted:#9097a3;--line:#2a2e36;--home:#3b82f6;--draw:#6b7280;--away:#ef4444;--up:#f87171;--down:#60a5fa;--hit:#14532d}}
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
.badge.hit{background:var(--hit);color:var(--fg)}.badge.miss{background:#fee2e2;color:#991b1b}
h4{font-size:14px;margin:16px 0 4px}table.acc td,table.acc th{font-size:12px;white-space:nowrap;padding:6px 4px}
.badge.single{background:var(--hit);color:var(--fg)}
.tiles{display:grid;grid-template-columns:repeat(auto-fit,minmax(110px,1fr));gap:8px;margin:8px 0 12px}
.tile{border:1px solid var(--line);border-radius:10px;padding:8px 10px;display:flex;flex-direction:column;gap:2px}
.tile span{font-size:12px}.tile b{font-size:17px;font-variant-numeric:tabular-nums}
.curve{margin:0 0 12px}.curve svg{width:100%;height:auto;display:block}
.curve .line{fill:none;stroke:var(--pick);stroke-width:2;vector-effect:non-scaling-stroke}
.curve .zero{stroke:var(--muted);stroke-dasharray:4 4;stroke-width:1;vector-effect:non-scaling-stroke}
.curve .pt{fill:var(--pick);stroke:var(--card);stroke-width:2;vector-effect:non-scaling-stroke}
table.ledger td,table.ledger th{font-size:13px;vertical-align:top}table.ledger td.l{text-align:left;white-space:normal}table.ledger .badge{margin:0}
td.pick{box-shadow:0 0 0 2px var(--pick) inset;background:var(--pick-bg)}.ptag{display:block;font-style:normal;font-size:10px;font-weight:700;color:var(--pick)}
.picks{border:2px solid var(--pick)}.tickets{list-style:none;padding:0;margin:8px 0}
.ticket{border:1px dashed var(--pick);border-radius:10px;padding:10px 12px;margin:8px 0;font-size:14px;background:var(--pick-bg)}
.t-head{display:flex;flex-wrap:wrap;gap:4px 8px;align-items:baseline;font-weight:600}.t-no{color:var(--pick);font-size:18px}
.t-body>div{margin-top:4px}.big{font-size:18px}.t-pick{font-size:16px}.pickname{background:var(--pick);color:#fff;padding:1px 10px;border-radius:6px}
.none{border:1px solid var(--line);border-radius:10px;padding:14px;text-align:center;font-size:15px;line-height:1.7}
.combo{font-size:13px;background:var(--line);padding:8px 10px;border-radius:8px}.legend-pick{box-shadow:0 0 0 2px var(--pick) inset;background:var(--pick-bg);padding:0 6px;border-radius:4px}
.picks a{color:var(--home);text-decoration:none}.small2{display:block;font-size:12px}.warn{font-size:13px;background:var(--chg);color:var(--chg-fg);padding:6px 10px;border-radius:8px}
.tabs{display:flex;gap:6px;flex-wrap:wrap;margin:12px 0}.tabs a{padding:4px 12px;border:1px solid var(--line);border-radius:999px;background:var(--card);color:var(--fg);text-decoration:none;font-size:14px}
.tabs a.on{background:var(--fg);color:var(--bg);border-color:var(--fg)}.tabs small{margin-left:2px;color:inherit;opacity:.7;display:inline}
.badge.changed{background:var(--chg);color:var(--chg-fg)}.badge.fresh{background:var(--line);color:var(--fg)}
article.has-change{border-color:var(--chg-fg);box-shadow:0 0 0 1px var(--chg-fg) inset}
td.flip{background:var(--chg)}s.prev{color:var(--muted);font-size:11px;margin-right:4px}
.changes ul{list-style:none;padding:0;margin:0}.changes li{padding:6px 0;border-top:1px solid var(--line);font-size:14px}.changes li:first-child{border-top:0}.h{margin-left:6px;color:var(--muted);font-size:12px}
small{margin-left:4px;font-size:11px}.up{color:var(--up)}.down{color:var(--down)}
article header{flex-wrap:wrap}.tag{white-space:nowrap}
@media (max-width:480px){th,td{padding:6px 4px}th{white-space:normal}th .badge{display:block;width:max-content;margin:2px 0 0}.h{margin-left:4px}.lbl{display:block;margin:0}small{display:block;margin:0}s.prev{display:block;margin:0}}
</style></head><body><main>
<h1>국내 프로토 배당</h1>
<p class="muted">베트맨 프로토 승부식 기준 · ▲▼ 는 첫 수집 대비 변동 · <span class="badge changed">변경</span> 은 24시간 안에 바뀐 배당 · 앞 숫자는 베트맨 경기 번호 · <span class="badge single">단폴</span> 은 1경기 구매 가능 · <a href="#accuracy">예상 적중률 보기</a> · <a href="#ledger">추천 결과 기록</a></p>
${tabs(sport, counts)}
${picksSection(picks, backtest)}
${changeList(upcoming)}
${upcoming.length ? upcoming.map(gameCard).join("") : `<section class="muted">예정된 ${esc(sport || "국내")} 프로토 경기가 없거나 아직 수집 전입니다</section>`}
${recent.length ? `<h3>최근 결과</h3>${recent.map(gameCard).join("")}` : ""}
${accuracySection(accuracy, sport)}
${ledgerSection(ledger)}
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
      "content-disposition": 'attachment; filename="proto.csv"',
    },
  });
}

// 화면과 /api/upcoming 은 10분 캐시한다. 요청마다 D1 을 1만 행 넘게 읽어서 조회가 잦으면 읽기 한도를 넘는다.
// 수집이 30분마다라 10분이면 충분히 새롭다.
const PAGE_TTL = 600;
async function pageCached(req, ctx, make) {
  if (typeof caches === "undefined") return make();
  const key = new Request(req.url, { method: "GET" });
  const hit = await caches.default.match(key);
  if (hit) return hit;
  const res = await make();
  const out = new Response(res.body, res);
  out.headers.set("cache-control", `public, max-age=${PAGE_TTL}`);
  ctx.waitUntil(caches.default.put(key, out.clone()));
  return out;
}

export default {
  async fetch(req, env, ctx) {
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
    if (url.pathname === "/notify" && req.method === "POST") {
      const auth = req.headers.get("authorization") || "";
      if (!env.INGEST_TOKEN || auth !== `Bearer ${env.INGEST_TOKEN}`) return new Response("forbidden", { status: 403 });
      try {
        const logged = await recordPicks(env.DB, ctx);
        return Response.json({ ...(await runAlerts(env)), picks_logged: logged });
      } catch (e) {
        return Response.json({ ok: false, reason: String(e.message || e) }, { status: 502 });
      }
    }
    if (url.pathname === "/alerts/pending") return alertsPending(env, url);
    if (url.pathname === "/alerts/ack" && req.method === "POST") return alertsAck(env, url, req);
    if (url.pathname === "/kakao/login") return kakaoLogin(env, url);
    if (url.pathname === "/kakao/callback") return kakaoCallback(env, url);
    const sport = SPORTS.includes(url.searchParams.get("sport")) ? url.searchParams.get("sport") : "";
    if (url.pathname === "/api/upcoming") {
      // 기본은 해외 포함 전부. ?scope=domestic 이면 국내만. 경기마다 domestic(true/false) 와 sport 가 있다
      return pageCached(req, ctx, async () =>
        Response.json(await pageData(env.DB, { sport, ctx, domesticOnly: url.searchParams.get("scope") === "domestic" })));
    }
    if (url.pathname === "/api/picks") {
      const { at, picks: { backtest: bt, good, rows } } = await getStats(env.DB, ctx);
      return Response.json({ computed_at: at, rows, backtest: bt, good, min_ev: MIN_EV, min_n: MIN_N });
    }
    if (url.pathname === "/api/accuracy") return Response.json(accuracyFromAgg((await getStats(env.DB, ctx)).accuracy, sport));
    if (url.pathname === "/export.csv") return exportCsv(env.DB, url);
    if (url.pathname === "/api/rounds") {
      // 저장된 회차별 경기 수. 내보내기를 나눠 받을 때 쓴다
      const { results } = await env.DB
        .prepare("SELECT gm_ts, league, COUNT(DISTINCT game_ts || home || away) AS games FROM proto_matches GROUP BY gm_ts, league ORDER BY gm_ts")
        .all();
      return Response.json(results);
    }
    if (url.pathname !== "/") return new Response("not found", { status: 404 });
    return pageCached(req, ctx, async () => new Response(page(await pageData(env.DB, { sport, ctx })), {
      headers: { "content-type": "text/html; charset=utf-8" },
    }));
  },
};
