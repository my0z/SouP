import io
import os
import sys
import unittest
from contextlib import redirect_stdout
from unittest import mock

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
import odds  # noqa: E402

FIXTURE = {
    "fixture": {"id": 1001, "date": "2099-10-03T05:00:00+00:00", "status": {"short": "NS"}},
    "league": {"id": 292, "season": 2099, "round": "Regular Season - 32"},
    "teams": {"home": {"name": "Ulsan"}, "away": {"name": "Jeonbuk"}},
    "goals": {"home": None, "away": None},
}


def odds_item(update, home):
    return {
        "fixture": {"id": 1001},
        "update": update,
        "bookmakers": [{
            "id": 8, "name": "Bet365",
            "bets": [{"id": 1, "name": "Match Winner", "values": [
                {"value": "Home", "odd": str(home)},
                {"value": "Draw", "odd": "3.40"},
                {"value": "Away", "odd": "4.00"},
            ]}],
        }],
    }


class OddsTest(unittest.TestCase):
    def setUp(self):
        self.conn = odds.connect(":memory:")
        odds.save_fixtures(self.conn, [FIXTURE])

    def test_fixture_upsert_updates_result(self):
        done = {**FIXTURE, "fixture": {**FIXTURE["fixture"], "status": {"short": "FT"}},
                "goals": {"home": 2, "away": 1}}
        odds.save_fixtures(self.conn, [done])
        row = self.conn.execute("SELECT status, home_goals, away_goals FROM fixtures").fetchone()
        self.assertEqual(row, ("FT", 2, 1))

    def test_same_update_not_duplicated(self):
        self.assertEqual(odds.save_odds(self.conn, [odds_item("2099-10-01T00:00:00+00:00", 1.9)]), 3)
        self.assertEqual(odds.save_odds(self.conn, [odds_item("2099-10-01T00:00:00+00:00", 1.9)]), 0)
        self.assertEqual(odds.save_odds(self.conn, [odds_item("2099-10-01T03:00:00+00:00", 1.8)]), 3)

    def test_latest_match_winner_uses_newest_snapshot(self):
        odds.save_odds(self.conn, [odds_item("2099-10-01T00:00:00+00:00", 1.9)])
        odds.save_odds(self.conn, [odds_item("2099-10-01T03:00:00+00:00", 1.8)])
        self.assertEqual(odds.latest_match_winner(self.conn, 1001),
                         {"Bet365": {"Home": 1.8, "Draw": 3.4, "Away": 4.0}})

    def test_show_prints_odds(self):
        odds.save_odds(self.conn, [odds_item("2099-10-01T00:00:00+00:00", 1.9)])
        buf = io.StringIO()
        with redirect_stdout(buf):
            odds.show(self.conn, days=365 * 100)
        self.assertIn("Ulsan vs Jeonbuk", buf.getvalue())
        self.assertIn("Bet365", buf.getvalue())

    def test_api_get_all_follows_paging(self):
        pages = [
            {"errors": [], "paging": {"current": 1, "total": 2}, "response": [1]},
            {"errors": [], "paging": {"current": 2, "total": 2}, "response": [2]},
        ]
        with mock.patch.object(odds, "api_get", side_effect=pages) as m:
            self.assertEqual(odds.api_get_all("/odds", {"league": 292}, "k"), [1, 2])
        self.assertEqual(m.call_args_list[1].args[1], {"league": 292, "page": 2})


if __name__ == "__main__":
    unittest.main()
