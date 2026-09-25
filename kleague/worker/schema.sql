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
