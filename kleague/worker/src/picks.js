// 베팅 추천: 베트맨이 과거에 실제보다 후하게 준 배당 구간을 찾아 지금 배당에 적용한다.
//   같은 종목 · 같은 게임 유형 · 같은 쪽(승/무/패 언더/오버) · 비슷한 배당끼리 묶어
//   "배당이 말한 확률" 대비 "실제 적중률" 비율(보정계수)을 구한다.
//   추천 = 보정한 확률 × 지금 배당 - 1 (기대수익) 이 MIN_EV 이상이고 근거 경기가 MIN_N 이상인 선택.
//   표본이 적으면 보정계수를 1(배당 그대로)로 끌어당겨서 우연한 결과에 덜 흔들리게 한다.

export const MIN_EV = 0.03;   // 기대수익 3% 이상
export const MIN_N = 60;      // 같은 묶음 과거 경기 60개 이상
const PRIOR = 40;             // 보정계수를 1 쪽으로 끌어당기는 가상 경기 수
const ODDS_EDGES = [1.3, 1.5, 1.7, 1.9, 2.1, 2.4, 2.8, 3.3, 4, 5, 7];

const bucketOf = (odd) => {
  let i = 0;
  while (i < ODDS_EDGES.length && odd >= ODDS_EDGES[i]) i++;
  return i;
};
export const bucketLabel = (i) =>
  i === 0 ? `${ODDS_EDGES[0]} 미만` : i === ODDS_EDGES.length ? `${ODDS_EDGES[i - 1]} 이상` : `${ODDS_EDGES[i - 1]}~${ODDS_EDGES[i]}`;

// "야구 핸디캡" → ["야구", "핸디캡"]
const split = (betName) => {
  const [sport, ...rest] = String(betName || "").split(/\s+/);
  return [sport, rest.join(" ")];
};

// 마진을 뺀 각 선택의 확률 (배당이 없는 칸은 0)
function implied(w, d, l) {
  const odds = [w, d > 1 ? d : null, l];
  const inv = odds.map((x) => (x > 1 ? 1 / x : 0));
  const sum = inv[0] + inv[1] + inv[2];
  return { odds, probs: inv.map((x) => (sum ? x / sum : 0)) };
}

const keyOf = (sport, kind, side, odd) => `${sport}|${kind}|${side}|${bucketOf(odd)}`;

// 한 게임 유형(행)의 선택들: [{side, odd, p, key}]
function selections(b) {
  if (!b.bet_name || /전반/.test(b.bet_name) || !(b.w > 1 && b.l > 1)) return [];
  const [sport, kind] = split(b.bet_name);
  const { odds, probs } = implied(b.w, b.d, b.l);
  return odds.map((odd, side) => (odd ? { side, odd, p: probs[side], key: keyOf(sport, kind, side, odd) } : null)).filter(Boolean);
}

export class Model {
  constructor(entries = []) { this.stats = new Map(entries); }
  toJSON() { return [...this.stats]; }
  // 보정한 확률과 기대수익
  judge(s) {
    const st = this.stats.get(s.key) || { n: 0, hit: 0, exp: 0, ret: 0 };
    // 배당 확률대로 맞은 가상 경기 PRIOR 개를 더해서 계산한다
    const avg = st.n ? st.exp / st.n : s.p;
    const factor = (st.hit + PRIOR * avg) / (st.exp + PRIOR * avg);
    const p = Math.min(0.99, s.p * factor);
    return { ...s, n: st.n, pastHit: st.n ? st.hit / st.n : null, pastRoi: st.n ? st.ret / st.n - 1 : null, prob: p, ev: p * s.odd - 1 };
  }
  // 이 행에서 추천할 선택 (없으면 빈 배열)
  picks(b) {
    return selections(b).map((s) => this.judge(s)).filter((j) => j.n >= MIN_N && j.ev >= MIN_EV);
  }
}

// ---------- D1 에서 묶음별로 미리 집계한 행으로 계산 ----------
// 과거 행을 Worker 로 다 가져오면 읽기 한도와 CPU 한도를 넘으므로 SQL 이 (시즌 · 게임 유형 · 쪽 · 배당 구간) 별로 더해서 준다.

const bucketSql = (col) =>
  `CASE ${ODDS_EDGES.map((e, i) => `WHEN ${col} < ${e} THEN ${i}`).join(" ")} ELSE ${ODDS_EDGES.length} END`;

// where: proto_matches m 에 거는 조건 (예: 국내만)
export const aggSql = (where) => `
  WITH f AS (
    SELECT m.bet_name, strftime('%Y', m.game_ts + 32400, 'unixepoch') AS season, CAST(m.result AS INTEGER) AS r,
      o.win AS w, CASE WHEN o.draw > 1 THEN o.draw END AS d, o.lose AS l
    FROM proto_matches m
    JOIN proto_odds o ON o.id = (SELECT MAX(id) FROM proto_odds WHERE gm_ts = m.gm_ts AND match_seq = m.match_seq)
    WHERE m.status IN ('4', '20') AND m.result IN ('0', '1', '2') AND m.bet_name IS NOT NULL
      AND m.bet_name NOT LIKE '%전반%' AND o.win > 1 AND o.lose > 1 AND ${where}),
  g AS (SELECT *, 1.0 / w + COALESCE(1.0 / d, 0) + 1.0 / l AS s FROM f WHERE NOT (r = 1 AND d IS NULL)),
  sel AS (
    SELECT season, bet_name, 0 AS side, w AS odd, 1.0 / w / s AS p, r = 0 AS won FROM g
    UNION ALL SELECT season, bet_name, 1, d, 1.0 / d / s, r = 1 FROM g WHERE d IS NOT NULL
    UNION ALL SELECT season, bet_name, 2, l, 1.0 / l / s, r = 2 FROM g)
  SELECT season, bet_name, side, ${bucketSql("odd")} AS bucket, COUNT(*) AS n, SUM(won) AS hit, SUM(p) AS exp,
    SUM(CASE WHEN won THEN odd ELSE 0 END) AS ret, SUM(odd) AS sodd
  FROM sel GROUP BY season, bet_name, side, bucket`;

const aggKey = (a) => {
  const [sport, kind] = split(a.bet_name);
  return `${sport}|${kind}|${a.side}|${a.bucket}`;
};
const addStat = (map, key, a) => {
  const st = map.get(key) || { n: 0, hit: 0, exp: 0, ret: 0 };
  st.n += a.n; st.hit += a.hit; st.exp += a.exp; st.ret += a.ret;
  map.set(key, st);
};

export function modelFromAgg(agg) {
  const m = new Model();
  for (const a of agg) addStat(m.stats, aggKey(a), a);
  return m;
}

// 시즌 단위로 앞으로 가며 검증: 그 시즌 전까지의 묶음 통계로 추천 묶음을 정하고 그 시즌 결과를 더한다.
// (묶음 안 평균 배당과 평균 확률로 판단하는 근사)
export function backtestAgg(agg) {
  const seasons = [...new Set(agg.map((a) => a.season))].sort();
  const past = new Model();
  const out = { n: 0, hit: 0, ret: 0, bySport: {}, bySeason: {} };
  for (const season of seasons) {
    const rows = agg.filter((a) => a.season === season);
    for (const a of rows) {
      const j = past.judge({ key: aggKey(a), odd: a.sodd / a.n, p: a.exp / a.n });
      if (j.n < MIN_N || j.ev < MIN_EV) continue;
      const sport = split(a.bet_name)[0];
      for (const acc of [out, (out.bySport[sport] ||= { n: 0, hit: 0, ret: 0 }), (out.bySeason[season] ||= { n: 0, hit: 0, ret: 0 })]) {
        acc.n += a.n; acc.hit += a.hit; acc.ret += a.ret;
      }
    }
    for (const a of rows) addStat(past.stats, aggKey(a), a);
  }
  return out;
}

// 과거 데이터에서 실제로 후했던 묶음 (보여 주기용)
export function goodBuckets(model, limit = 12) {
  const out = [];
  for (const [key, st] of model.stats) {
    if (st.n < MIN_N) continue;
    const [sport, kind, side, bucket] = key.split("|");
    const roi = st.ret / st.n - 1;
    out.push({ sport, kind, side: Number(side), bucket: bucketLabel(Number(bucket)), n: st.n, hit: st.hit / st.n, exp: st.exp / st.n, roi });
  }
  return out.sort((a, b) => b.roi - a.roi).slice(0, limit);
}
