CREATE TABLE IF NOT EXISTS fixtures (
    fixture_id   INTEGER PRIMARY KEY,
    league_id    INTEGER NOT NULL,
    season       INTEGER NOT NULL,
    round        TEXT,
    kickoff_ts   INTEGER NOT NULL,
    status       TEXT,
    home_team    TEXT,
    away_team    TEXT,
    home_goals   INTEGER,
    away_goals   INTEGER,
    updated_at   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_fixtures_kickoff ON fixtures (kickoff_ts);
CREATE TABLE IF NOT EXISTS odds (
    fixture_id   INTEGER NOT NULL,
    bookmaker_id INTEGER NOT NULL,
    bookmaker    TEXT,
    bet_id       INTEGER NOT NULL,
    bet          TEXT,
    value        TEXT NOT NULL,
    odd          REAL NOT NULL,
    api_update   TEXT NOT NULL,
    fetched_at   TEXT NOT NULL,
    UNIQUE (fixture_id, bookmaker_id, bet_id, value, api_update)
);
CREATE INDEX IF NOT EXISTS idx_odds_fixture ON odds (fixture_id, bet_id);
