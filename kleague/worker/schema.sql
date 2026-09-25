-- 베트맨 프로토 승부식 (matchSeq 하나가 경기 하나의 게임 유형 하나)
CREATE TABLE IF NOT EXISTS proto_matches (
    gm_ts        INTEGER NOT NULL,
    match_seq    INTEGER NOT NULL,
    league       TEXT,
    home         TEXT,
    away         TEXT,
    game_ts      INTEGER NOT NULL,   -- 경기 시작 (unix 초)
    bet_id       TEXT,
    bet_name     TEXT,               -- 축구 승무패 / 축구 핸디캡 / 축구 언더오버 ...
    handi        REAL,               -- 핸디캡 또는 언더오버 기준값
    win_txt      TEXT,
    draw_txt     TEXT,
    lose_txt     TEXT,
    status       TEXT,               -- protoStatus
    result       TEXT,               -- 0=승(왼쪽) 1=무 2=패(오른쪽) 4=적특
    score        TEXT,
    updated_at   TEXT NOT NULL,
    sgl          TEXT,               -- 1 이면 단폴(1경기) 구매 가능
    domestic     INTEGER,            -- 베트맨 국내 리그 표시 (1 국내 0 해외 NULL 모름)
    PRIMARY KEY (gm_ts, match_seq)
);
CREATE INDEX IF NOT EXISTS idx_proto_matches_game ON proto_matches (game_ts);

-- 배당이 바뀔 때만 한 줄씩 쌓인다
CREATE TABLE IF NOT EXISTS proto_odds (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    gm_ts        INTEGER NOT NULL,
    match_seq    INTEGER NOT NULL,
    win          REAL,
    draw         REAL,
    lose         REAL,
    handi        REAL,
    fetched_at   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_proto_odds_match ON proto_odds (gm_ts, match_seq, id);

-- 카카오 토큰 같은 설정값
CREATE TABLE IF NOT EXISTS kv (
    key          TEXT PRIMARY KEY,
    value        TEXT NOT NULL
);

-- 보낸 알림 기록 (같은 알림을 두 번 보내지 않도록)
CREATE TABLE IF NOT EXISTS alert_log (
    key          TEXT PRIMARY KEY,   -- new:회차-번호 / pre:... / result:... / odds:... (마지막으로 알린 배당)
    value        TEXT NOT NULL,
    sent_at      INTEGER NOT NULL
);

-- 보낼 알림 큐 (Claude 루틴이 카카오톡 나에게 보내기로 보낸다)
CREATE TABLE IF NOT EXISTS alert_queue (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    text         TEXT NOT NULL,
    url          TEXT,
    created_at   INTEGER NOT NULL,
    delivered_at INTEGER
);
