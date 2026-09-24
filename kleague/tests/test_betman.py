import json
import os
import sys
import unittest
from unittest import mock

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
import betman_collector as bc  # noqa: E402

FIXTURE = os.path.join(os.path.dirname(__file__), "fixtures", "betman_260113.json")


class BetmanTest(unittest.TestCase):
    def setUp(self):
        with open(FIXTURE) as f:
            self.data = json.load(f)

    def test_rows_of_maps_keys(self):
        rows = bc.rows_of(self.data)
        self.assertEqual(len(rows), 7)
        self.assertEqual(rows[0]["homeName"], "한국")
        self.assertEqual(rows[0]["winAllot"], 1.93)

    def test_rows_of_empty_round(self):
        self.assertEqual(bc.rows_of({"compSchedules": None}), [])
        self.assertEqual(bc.rows_of(None), [])

    def test_filter_only_soccer_matching_league(self):
        rows = bc.rows_of(self.data)
        self.assertEqual(len(bc.filter_rows(rows, "K리그")), 0)
        picked = bc.filter_rows(rows, "아시안게임")
        self.assertEqual({r["matchSeq"] for r in picked}, {4491, 4492, 4494})
        self.assertEqual(len(bc.filter_rows(rows, "MLB")), 0)  # 야구 제외

    def test_candidate_rounds(self):
        with mock.patch.object(bc, "datetime") as dt:
            dt.datetime.now.return_value.year = 2026
            self.assertEqual(bc.candidate_rounds(260113), [260113, 260114])
            self.assertEqual(bc.candidate_rounds(260113, check_prev=True), [260112, 260113, 260114])
            dt.datetime.now.return_value.year = 2027
            self.assertEqual(bc.candidate_rounds(260150), [260150, 260151, 270001, 270002])

    def test_pause_hours_grows_and_caps(self):
        self.assertEqual([bc.pause_hours(n) for n in (1, 2, 3, 5, 9)], [2, 4, 8, 24, 24])

    def _run_auto(self, fetch, state):
        saved = {}
        with mock.patch.object(bc, "fetch_round", side_effect=fetch), \
             mock.patch.object(bc, "ingest", return_value="ok"), \
             mock.patch.object(bc, "load_state", return_value=dict(state)), \
             mock.patch.object(bc, "save_state", side_effect=saved.update), \
             mock.patch.object(bc.time, "sleep"), \
             mock.patch.dict(os.environ, {"INGEST_URL": "http://x", "INGEST_TOKEN": "t"}):
            bc.main([])
        return saved

    def test_all_failures_pause_and_skip_next_run(self):
        def boom(ts):
            raise OSError("reset")
        saved = self._run_auto(boom, {"last_gmts": 260113})
        self.assertEqual(saved["fail_count"], 1)
        self.assertGreater(saved["pause_until"], bc.time.time() + 3600)
        fetch = mock.Mock()
        self._run_auto(fetch, saved)
        fetch.assert_not_called()

    def test_success_resets_failures_and_advances_round(self):
        saved = self._run_auto(lambda ts: self.data if ts == 260114 else {},
                               {"last_gmts": 260113, "fail_count": 3, "prev_checked_at": bc.time.time()})
        self.assertEqual(saved["fail_count"], 0)
        self.assertEqual(saved["last_gmts"], 260114)

    def test_main_ingests_picked_rows(self):
        sent = []
        with mock.patch.object(bc, "fetch_round", side_effect=lambda ts: self.data if ts == 260113 else {}), \
             mock.patch.object(bc, "ingest", side_effect=lambda u, t, p: sent.append(p) or "ok"), \
             mock.patch.dict(os.environ, {"INGEST_URL": "http://x", "INGEST_TOKEN": "t"}):
            bc.main(["--gmts", "260113", "--league", "아시안게임"])
        self.assertEqual(len(sent), 1)
        self.assertEqual(sent[0]["gmTs"], 260113)
        self.assertEqual(len(sent[0]["rows"]), 3)


if __name__ == "__main__":
    unittest.main()
