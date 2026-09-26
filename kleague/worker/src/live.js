// 진행 중인 국내 경기의 실시간 점수와 "지금 끝나면 추천이 맞는지"
//   점수는 네이버 스포츠 일정 API 에서 받는다 (베트맨은 경기 중 점수를 주지 않고 수집 PC 도 낮에는 꺼져 있다).
//   GET /api/live : { games: { g회차-번호: {html} }, picks: { "회차|번호|쪽": {html} } }  1분 캐시

const NAVER = "https://api-gw.sports.naver.com/schedule/games";
const CATEGORIES = [
  ["kfootball", "kleague"], ["kfootball", "kleague2"], ["kbaseball", "kbo"],
  ["kbasketball", "kbl"], ["kbasketball", "wkbl"], ["kvolleyball", "kovo"], ["kvolleyball", "wkovo"],
];

const kstDate = (ts) => new Date((ts + 9 * 3600) * 1000).toISOString().slice(0, 10);

async function naverGames(from, to) {
  const lists = await Promise.all(CATEGORIES.map(async ([up, cat]) => {
    const url = `${NAVER}?fields=basic&upperCategoryId=${up}&categoryId=${cat}&fromDate=${from}&toDate=${to}&size=100`;
    try {
      const res = await fetch(url, { headers: { "user-agent": "Mozilla/5.0", referer: "https://m.sports.naver.com/" } });
      if (!res.ok) return [];
      return (await res.json())?.result?.games || [];
    } catch {
      return [];
    }
  }));
  return lists.flat();
}

// 베트맨 "강원FC" "두산 베어스" 와 네이버 "강원" "두산" 을 맞춘다
const norm = (s) => String(s || "").replace(/\s+/g, "").toUpperCase();
const same = (betman, naver) => {
  const a = norm(betman), b = norm(naver);
  return !!a && !!b && (a.includes(b) || b.includes(a));
};

export function findLive(g, list) {
  const day = kstDate(g.game_ts);
  for (const n of list) {
    if (n.gameDate !== day) continue;
    if (same(g.home, n.homeTeamName) && same(g.away, n.awayTeamName)) return { n, hs: n.homeTeamScore, as: n.awayTeamScore };
    if (same(g.home, n.awayTeamName) && same(g.away, n.homeTeamName)) return { n, hs: n.awayTeamScore, as: n.homeTeamScore };
  }
  return null;
}

// 지금 점수로 끝나면 이 선택이 어떻게 되는지. state: win / lose / even(동점이라 아직 모름) / null(판단 못 함)
export function judgeNow(b, side, hs, as) {
  const name = String(b.bet_name || "");
  if (/전반|SUM|홀짝/.test(name) || /^배구/.test(name) && !/승패$/.test(name)) return null;  // 배구 핸디 언오는 세트 점수가 아니라 판단하지 않는다
  const outcome = (diff, threeWay) => (diff > 0 ? 0 : diff < 0 ? 2 : threeWay ? 1 : null);
  let now, locked = false;
  if (/언더오버/.test(name)) {
    const total = hs + as;
    now = total > b.handi ? 2 : 0;
    locked = total > b.handi;  // 오버는 이미 넘었으면 더 바뀌지 않는다
  } else if (/핸디캡/.test(name)) {
    now = outcome(hs + (Number(b.handi) || 0) - as, !!(b.d > 1));
  } else if (/승무패$|승패$/.test(name)) {
    now = outcome(hs - as, /승무패$/.test(name));
  } else {
    return null;
  }
  if (now == null) return { state: "even" };
  return { state: now === side ? "win" : "lose", locked };
}

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const STATE_TEXT = { win: "지금이면 적중", lose: "지금이면 실패", even: "동점 · 아직 모름" };

function stateHtml(j) {
  if (!j) return "";
  const text = j.locked ? (j.state === "win" ? "적중 확정" : "실패 확정") : STATE_TEXT[j.state];
  return `<span class="live-state ${j.state}">${esc(text)}</span>`;
}

// games: 국내 경기 목록 (loadGames 결과). picks: pick_log 에서 결과 대기 중인 추천 [{gm_ts, match_seq, side}]
export function buildLive(games, picks, list, sideName, now = Math.floor(Date.now() / 1000)) {
  const out = { games: {}, picks: {}, at: now };
  const pickMap = new Map(picks.map((p) => [`${p.gm_ts}|${p.match_seq}|${p.side}`, p]));
  for (const g of games) {
    if (g.score || g.game_ts > now || now - g.game_ts > 6 * 3600) continue;
    const hit = findLive(g, list);
    if (!hit) continue;
    const { n, hs, as } = hit;
    if (n.cancel) {
      out.games[`g${g.bets[0].gm_ts}-${g.bets[0].match_seq}`] = { html: `<span class="live off">경기 취소</span>` };
      continue;
    }
    if (n.statusCode === "BEFORE") continue;
    const ended = n.statusCode === "RESULT";
    const head = `<span class="live ${ended ? "off" : ""}">${ended ? "경기 끝" : "● LIVE"} ${esc(g.home)} <b>${hs}:${as}</b> ${esc(g.away)}${
      !ended && n.statusInfo ? ` · ${esc(n.statusInfo)}` : ""}</span>`;
    const lines = [];
    for (const b of g.bets) {
      for (const side of [0, 1, 2]) {
        const key = `${b.gm_ts}|${b.match_seq}|${side}`;
        if (!pickMap.has(key)) continue;
        const j = judgeNow(b, side, hs, as);
        const html = `${stateHtml(j) || `<span class="live-state">판단 불가</span>`}`;
        out.picks[key] = { html: `${ended ? "경기 끝" : "진행 중"} ${hs}:${as} ${html}` };
        lines.push(`<div class="live-pick">내 추천 ${esc(b.bet_name.replace(/^\S+\s/, ""))} <b>${esc(sideName(b, side))}</b> → ${html}</div>`);
      }
    }
    out.games[`g${g.bets[0].gm_ts}-${g.bets[0].match_seq}`] = { html: head + lines.join("") };
  }
  return out;
}

export async function liveData(games, picks, sideName) {
  const now = Math.floor(Date.now() / 1000);
  const list = await naverGames(kstDate(now - 86400), kstDate(now));
  return buildLive(games, picks, list, sideName, now);
}
