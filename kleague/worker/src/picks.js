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
  add(b) {
    const res = Number(b.result);
    if (![0, 1, 2].includes(res) || (res === 1 && !(b.d > 1))) return;  // 승패 게임의 무승부 결과는 적특
    for (const s of selections(b)) {
      const st = this.stats.get(s.key) || { n: 0, hit: 0, exp: 0, ret: 0 };
      st.n++; st.exp += s.p;
      if (res === s.side) { st.hit++; st.ret += s.odd; }
      this.stats.set(s.key, st);
    }
  }
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

export function buildModel(history) {
  const m = new Model();
  for (const b of history) m.add(b);
  return m;
}

// 시간 순서대로 지나가며 그때까지의 데이터만으로 추천했다면 어땠는지 (10만원씩)
export function backtest(history) {
  const rows = [...history].sort((a, b) => a.game_ts - b.game_ts);
  const m = new Model();
  const out = { n: 0, hit: 0, ret: 0, bySport: {} };
  let i = 0;
  while (i < rows.length) {
    // 같은 시각 경기끼리는 서로의 결과를 모르게 한 번에 판단한다
    let j = i;
    while (j < rows.length && rows[j].game_ts === rows[i].game_ts) j++;
    const batch = rows.slice(i, j);
    for (const b of batch) {
      for (const pk of m.picks(b)) {
        const won = Number(b.result) === pk.side;
        const sport = split(b.bet_name)[0];
        const s = (out.bySport[sport] ||= { n: 0, hit: 0, ret: 0 });
        for (const acc of [out, s]) { acc.n++; acc.hit += won ? 1 : 0; acc.ret += won ? pk.odd : 0; }
      }
    }
    for (const b of batch) m.add(b);
    i = j;
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
