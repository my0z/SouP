// K리그 카카오톡 알림 (카카오톡 나에게 보내기)
//   GET  /kakao/login?key=INGEST_TOKEN : 카카오 로그인으로 알림 받을 계정 연결 (처음 한 번)
//   GET  /kakao/callback               : 카카오가 돌려보내는 주소. 토큰을 저장하고 시험 메시지를 보낸다
//   POST /notify                       : 수집기가 매 실행 끝에 부른다. 새 배당 / 큰 변동 / 경기 직전 / 결과 알림
//   GET  /alerts/pending?key=..        : 아직 안 보낸 알림 (Claude 루틴이 카카오톡으로 보낸다)
//   POST /alerts/ack?key=..            : {"ids":[...]} 보낸 알림 표시
// 카카오 앱을 직접 연결할 때만: KAKAO_REST_KEY (카카오 앱 REST API 키), 선택 KAKAO_CLIENT_SECRET

import {
  loadGames, isKLeague, mainOf, favoriteOf, kst, gameLinks, stripSport, won,
} from "./index.js";

const HOUR = 3600;
const DAY = 86400;
const SITE = "https://kl.usb.kr";
const REDIRECT = `${SITE}/kakao/callback`;
const MOVE_MIN = 0.1;       // 승무패 배당이 이만큼 바뀌면 알린다
// 경기 전 요약: 수집 PC 가 21~05시에만 켜져 있어서 낮 경기는 전날 밤 마지막 배당으로 요약한다
const PRE_SEC = 18 * HOUR;
const MAX_PER_RUN = 8;      // 한 번에 보내는 최대 메시지 (나머지는 다음 실행에)
const PREFIX = "[K리그]";
const STAKE = 100000;     // 결과 알림의 손익 기준 금액

// ---------- 저장 ----------

async function kvGet(db, key) {
  const row = await db.prepare("SELECT value FROM kv WHERE key = ?").bind(key).first();
  return row ? JSON.parse(row.value) : null;
}

async function kvPut(db, key, value) {
  await db.prepare("INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
    .bind(key, JSON.stringify(value)).run();
}

// ---------- 카카오 ----------

async function tokenRequest(env, params) {
  const body = new URLSearchParams({ client_id: env.KAKAO_REST_KEY, ...params });
  if (env.KAKAO_CLIENT_SECRET) body.set("client_secret", env.KAKAO_CLIENT_SECRET);
  const res = await fetch("https://kauth.kakao.com/oauth/token", { method: "POST", body });
  const data = await res.json();
  if (!res.ok) throw new Error(`카카오 토큰 오류 ${res.status} ${JSON.stringify(data)}`);
  return data;
}

async function saveTokens(db, data, old = {}) {
  const now = Math.floor(Date.now() / 1000);
  const tokens = {
    access_token: data.access_token,
    expires_at: now + (data.expires_in || 0),
    // 갱신할 때 refresh_token 은 만료가 가까울 때만 새로 온다
    refresh_token: data.refresh_token || old.refresh_token,
    refresh_expires_at: data.refresh_token_expires_in ? now + data.refresh_token_expires_in : old.refresh_expires_at,
  };
  await kvPut(db, "kakao_tokens", tokens);
  return tokens;
}

async function accessToken(env) {
  const t = await kvGet(env.DB, "kakao_tokens");
  if (!t) return null;
  if (t.expires_at - 300 > Date.now() / 1000) return t.access_token;
  const data = await tokenRequest(env, { grant_type: "refresh_token", refresh_token: t.refresh_token });
  return (await saveTokens(env.DB, data, t)).access_token;
}

export async function sendMemo(token, text, url = SITE) {
  const template = {
    object_type: "text",
    text: text.slice(0, 200),  // 카카오 텍스트 템플릿 최대 200자 (splitMessage 로 미리 나눈다)
    link: { web_url: url, mobile_web_url: url },
    button_title: "배당 보기",
  };
  const res = await fetch("https://kapi.kakao.com/v2/api/talk/memo/default/send", {
    method: "POST",
    headers: { authorization: `Bearer ${token}` },
    body: new URLSearchParams({ template_object: JSON.stringify(template) }),
  });
  if (!res.ok) throw new Error(`카카오 전송 오류 ${res.status} ${await res.text()}`);
}

const html = (msg, status = 200) =>
  new Response(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width">
<body style="font:16px system-ui;padding:24px">${msg}</body>`, { status, headers: { "content-type": "text/html; charset=utf-8" } });

export async function kakaoLogin(env, url) {
  if (!env.KAKAO_REST_KEY) return html("KAKAO_REST_KEY 비밀값이 없습니다", 500);
  if (!env.INGEST_TOKEN || url.searchParams.get("key") !== env.INGEST_TOKEN) return html("key 가 맞지 않습니다", 403);
  const state = crypto.randomUUID();
  await kvPut(env.DB, "kakao_state", { state, at: Date.now() });
  const auth = new URL("https://kauth.kakao.com/oauth/authorize");
  auth.search = new URLSearchParams({
    client_id: env.KAKAO_REST_KEY, redirect_uri: REDIRECT, response_type: "code", scope: "talk_message", state,
  });
  return Response.redirect(auth.toString(), 302);
}

export async function kakaoCallback(env, url) {
  const saved = await kvGet(env.DB, "kakao_state");
  const fresh = saved && Date.now() - saved.at < 10 * 60 * 1000;
  if (!fresh || url.searchParams.get("state") !== saved.state) return html("로그인 요청이 만료됐거나 맞지 않습니다. 다시 시도하세요", 403);
  const code = url.searchParams.get("code");
  if (!code) return html(`카카오 로그인 실패: ${url.searchParams.get("error_description") || "코드 없음"}`, 400);
  await kvPut(env.DB, "kakao_state", { state: null, at: 0 });
  try {
    const tokens = await saveTokens(env.DB, await tokenRequest(env, { grant_type: "authorization_code", redirect_uri: REDIRECT, code }));
    await sendMemo(tokens.access_token, `${PREFIX} 알림 연결 완료\n새 배당 · 큰 변동 · 경기 전 요약 · 결과를 보내 드립니다`);
  } catch (e) {
    return html(`연결 실패: ${String(e.message).replace(/</g, "&lt;")}`, 500);
  }
  return html("카카오톡 연결 완료. 나와의 채팅에 시험 메시지가 왔는지 확인하세요");
}

// ---------- 알림 만들기 ----------

const fmt = (x) => (x ? x.toFixed(2) : "-");
const oddsLine = (b) => `승 ${fmt(b.w)} 무 ${fmt(b.d)} 패 ${fmt(b.l)}`;
const title = (g) => `${g.home} vs ${g.away}`;
const pickName = ["홈승", "무", "원정승"];

function extraLines(g) {
  // 핸디캡과 언더오버 한 줄씩 (있으면)
  const out = [];
  for (const b of g.bets) {
    if (!b.w || !b.l || b === mainOf(g)) continue;
    const name = stripSport(b.bet_name);
    if (/전반/.test(name)) continue;
    if (/핸디캡/.test(name) && !out.some((x) => x.startsWith("핸디"))) out.push(`핸디 ${b.handi > 0 ? "+" : ""}${b.handi} · 승 ${fmt(b.w)}${b.d ? ` 무 ${fmt(b.d)}` : ""} 패 ${fmt(b.l)}`);
    if (/언더오버/.test(name) && !out.some((x) => x.startsWith("언오"))) out.push(`언오 ${b.handi} · 언더 ${fmt(b.w)} 오버 ${fmt(b.l)}`);
  }
  return out;
}

// games 와 이미 보낸 기록(sent: key → value)으로 보낼 알림 목록을 만든다
export function buildAlerts(games, sent, now = Math.floor(Date.now() / 1000)) {
  const out = [];
  for (const g of games) {
    const m = mainOf(g);
    if (!m) continue;
    const id = `${m.gm_ts}-${m.match_seq}`;
    const link = `${SITE}/#${gameLinks(g).id}`;
    const when = kst(g.game_ts);
    const single = String(m.sgl) === "1" ? " 단폴" : "";
    const odds = { w: m.w, d: m.d, l: m.l };

    if (g.score) {
      // 결과: 끝난 지 3일 안의 경기만
      if (sent[`result:${id}`] || now - g.game_ts > 3 * DAY || !["0", "1", "2"].includes(String(m.result))) continue;
      const { fav } = favoriteOf(m.w, m.d, m.l);
      const res = Number(m.result);
      const favOdd = [m.w, m.d, m.l][fav];
      const verdict = res === fav
        ? `정배 ${pickName[fav]} 적중 · 10만원 → ${won((favOdd - 1) * STAKE)}`
        : `정배 ${pickName[fav]} 실패 · 10만원 → ${won(-STAKE)}`;
      out.push({ key: `result:${id}`, value: 1, order: 3, url: link,
        text: `${PREFIX} 결과\n${g.home} ${g.score} ${g.away}\n결과 ${pickName[res]} · 마감 ${oddsLine(m)}\n${verdict}` });
      continue;
    }
    if (g.game_ts <= now) continue;

    const prev = sent[`odds:${id}`];
    if (!sent[`new:${id}`]) {
      out.push({ key: `new:${id}`, value: 1, order: 0, url: link, odds: { id, odds },
        text: `${PREFIX} 새 배당\n${title(g)}\n${when} · 번호 ${m.match_seq}${single}\n${oddsLine(m)}` });
    } else if (prev) {
      const moved = ["w", "d", "l"].filter((k) => odds[k] && prev[k] && Math.abs(odds[k] - prev[k]) >= MOVE_MIN - 1e-9);
      if (moved.length) {
        const part = (k, label) => (moved.includes(k) ? `${label} ${fmt(prev[k])}→${fmt(odds[k])}` : `${label} ${fmt(odds[k])}`);
        out.push({ key: `move:${id}:${Date.now()}`, value: 1, order: 1, url: link, odds: { id, odds }, log: false,
          text: `${PREFIX} 배당 변동\n${title(g)}\n${when}\n${part("w", "승")} ${part("d", "무")} ${part("l", "패")}` });
      }
    }
    if (!sent[`pre:${id}`] && g.game_ts - now <= PRE_SEC) {
      const { fav, probs } = favoriteOf(m.w, m.d, m.l);
      out.push({ key: `pre:${id}`, value: 1, order: 2, url: link, odds: { id, odds },
        text: [`${PREFIX} 경기 전 요약`, title(g), `${when} · 번호 ${m.match_seq}${single}`, oddsLine(m),
               `정배 ${pickName[fav]} ${Math.round(probs[fav] * 100)}%`, ...extraLines(g)].join("\n") });
    }
  }
  return out.sort((a, b) => a.order - b.order);
}

// 카카오 앱을 연결했으면 바로 보내고 아니면 큐에 쌓는다.
// 큐는 Claude 루틴이 /alerts/pending 으로 읽어 PlayMCP 카카오톡 나에게 보내기로 보낸 뒤 /alerts/ack 로 지운다.
// 카카오톡 나에게 보내기(PlayMCP)는 글만 보내므로 끝에 링크를 붙인다.
// 한 메시지는 200자까지라 넘치면 줄 단위로 나눠 여러 메시지로 보낸다 (뒤 메시지에는 (2/3) 같은 표시)
export function splitMessage(text, url, max = 200) {
  const lines = [...text.split("\n"), url].flatMap((l) => {
    const out = [];
    for (let k = 0; k < l.length; k += max - 20) out.push(l.slice(k, k + max - 20));
    return out.length ? out : [""];
  });
  const parts = [];
  let cur = [];
  for (const l of lines) {
    if (cur.length && [...cur, l].join("\n").length > max - 20) { parts.push(cur); cur = []; }
    cur.push(l);
  }
  parts.push(cur);
  if (parts.length === 1) return [parts[0].join("\n")];
  return parts.map((p, n) => (n ? `${PREFIX} (${n + 1}/${parts.length})\n` : "") + p.join("\n"));
}

export async function runAlerts(env) {
  const token = await accessToken(env).catch(() => null);
  const now = Math.floor(Date.now() / 1000);
  const games = (await loadGames(env.DB, { from: now - 3 * DAY, to: now + 14 * DAY })).filter((g) => isKLeague(g.league));
  const { results } = await env.DB.prepare("SELECT key, value FROM alert_log WHERE sent_at > ?").bind(now - 30 * DAY).all();
  const sent = Object.fromEntries(results.map((r) => [r.key, JSON.parse(r.value)]));
  const alerts = buildAlerts(games, sent, now);
  const todo = token ? alerts.slice(0, MAX_PER_RUN) : alerts;
  const put = env.DB.prepare(
    "INSERT INTO alert_log (key, value, sent_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, sent_at = excluded.sent_at");
  const enqueue = env.DB.prepare("INSERT INTO alert_queue (text, url, created_at) VALUES (?, ?, ?)");
  for (const a of todo) {
    if (token) for (const part of splitMessage(a.text, a.url)) await sendMemo(token, part, a.url);
    const stmts = token ? [] : splitMessage(a.text, a.url).map((t) => enqueue.bind(t, a.url, now));
    if (a.log !== false) stmts.push(put.bind(a.key, JSON.stringify(a.value), now));
    // 변동 비교 기준은 마지막으로 알린 배당
    if (a.odds) stmts.push(put.bind(`odds:${a.odds.id}`, JSON.stringify(a.odds.odds), now));
    await env.DB.batch(stmts);
  }
  // 오래된 기록 정리
  await env.DB.batch([
    env.DB.prepare("DELETE FROM alert_log WHERE sent_at < ?").bind(now - 60 * DAY),
    env.DB.prepare("DELETE FROM alert_queue WHERE created_at < ?").bind(now - 7 * DAY),
  ]);
  return { ok: true, mode: token ? "kakao" : "queue", [token ? "sent" : "queued"]: todo.length,
           waiting: alerts.length - todo.length };
}

// ---------- 큐 (Claude 루틴용) ----------
// 열쇠는 D1 kv 의 alert_key 에 둔다 (INGEST_TOKEN 과 따로라 새어도 알림 읽기와 지우기만 된다)
const QUEUE_TTL = 12 * HOUR;  // 12시간 넘게 못 보낸 알림은 늦었으니 버린다

async function queueAuth(env, url) {
  const key = await kvGet(env.DB, "alert_key");
  return !!key && url.searchParams.get("key") === key;
}

export async function alertsPending(env, url) {
  if (!(await queueAuth(env, url))) return new Response("forbidden", { status: 403 });
  const now = Math.floor(Date.now() / 1000);
  const { results } = await env.DB
    .prepare("SELECT id, text, url, created_at FROM alert_queue WHERE delivered_at IS NULL AND created_at > ? ORDER BY id LIMIT 20")
    .bind(now - QUEUE_TTL).all();
  return Response.json(results);
}

export async function alertsAck(env, url, req) {
  if (!(await queueAuth(env, url))) return new Response("forbidden", { status: 403 });
  const { ids } = await req.json().catch(() => ({}));
  if (!Array.isArray(ids) || !ids.every(Number.isInteger)) return new Response("bad request", { status: 400 });
  const now = Math.floor(Date.now() / 1000);
  const stmt = env.DB.prepare("UPDATE alert_queue SET delivered_at = ? WHERE id = ?");
  if (ids.length) await env.DB.batch(ids.map((id) => stmt.bind(now, id)));
  return Response.json({ ok: true, acked: ids.length });
}
