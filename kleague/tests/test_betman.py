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

    def test_filter_matching_league(self):
        rows = bc.rows_of(self.data)
        self.assertEqual(len(bc.filter_rows(rows, "K리그")), 0)
        picked = bc.filter_rows(rows, "아시안게임")
        self.assertEqual({r["matchSeq"] for r in picked}, {4491, 4492, 4494})
        self.assertEqual(len(bc.filter_rows(rows, "MLB")), 1)  # 종목 제한 없음
        self.assertEqual(len(bc.filter_rows(rows, bc.DEFAULT_LEAGUE)), 0)  # 해외 친선과 MLB 는 빠진다

    def test_default_league_takes_all_domestic(self):
        def row(name, short, domastic=None, item="BS"):
            return {"itemCode": item, "leagueName": name, "leagueShortName": short, "domastic": domastic}
        rows = [row("KBO", "KBO", True), row("NPB", "NPB", False), row("MLB", "MLB", False),
                row("남자프로농구", "KBL", None, "BK"), row("여자프로농구", "WKBL", None, "BK"),
                row("아시안게임 여자농구", "AG여농", False, "BK"), row("V-리그 남자", "KOVO남", None, "VL"),
                row("코리아컵", "코리아컵", True, "SC")]
        picked = bc.filter_rows(rows, bc.DEFAULT_LEAGUE)
        self.assertEqual([r["leagueShortName"] for r in picked], ["KBO", "KBL", "WKBL", "KOVO남", "코리아컵"])
        # 리그를 직접 고르면 국내 표시만으로는 넣지 않는다
        self.assertEqual([r["leagueShortName"] for r in bc.filter_rows(rows, "KBL")], ["KBL", "WKBL"])

    def test_default_league_matches_long_and_short_names(self):
        def row(name, short=None):
            return {"itemCode": "SC", "leagueName": name, "leagueShortName": short}
        rows = [row("K리그1"), row("K리그2"), row("K1리그"), row(None, "K2리그"),
                row("WK리그"), row("J1리그", "J1리그"), row("한국FA컵"), row(None, "EFL챔"),
                row("잉글랜드 프리미어리그", "EPL"), row("J2리그", "J2리그"), row("UEFA 챔피언스리그", "UCL"),
                row("미국 메이저리그사커", "MLS")]
        picked = bc.filter_rows(rows, bc.DEFAULT_LEAGUE)
        self.assertEqual([r["leagueShortName"] or r["leagueName"] for r in picked],
                         ["K리그1", "K리그2", "K1리그", "K2리그", "WK리그", "J1리그", "EFL챔", "EPL", "MLS"])

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

class BackfillTest(unittest.TestCase):
    def setUp(self):
        with open(FIXTURE) as f:
            self.data = json.load(f)

    def run_step(self, fetch, state, max_rounds=20):
        sent = []
        with mock.patch.object(bc, "fetch_round", side_effect=fetch):
            result = bc.backfill_step(state, "아시안게임", lambda ts, rows: sent.append(ts),
                                      max_rounds, sleep=lambda s: None)
        return result, sent

    def test_moves_to_next_year_after_empty_rounds_and_stops(self):
        # 2024년은 1~2회차만 있고 2025년은 1회차만 있다
        have = {240001, 240002, 250001}
        state = {"year": 24, "no": 1, "empty": 0, "stop_at": 250002}
        result, sent = self.run_step(lambda ts: self.data if ts in have else {}, state)
        self.assertEqual(result, "done")
        self.assertEqual(sent, [240001, 240002, 250001])

    def test_limits_rounds_per_run_and_resumes(self):
        state = {"year": 24, "no": 1, "empty": 0, "stop_at": 250001}
        result, sent = self.run_step(lambda ts: self.data, state, max_rounds=3)
        self.assertEqual(result, "more")
        self.assertEqual(sent, [240001, 240002, 240003])
        self.assertEqual(state["no"], 4)

    def test_pauses_after_consecutive_failures_without_advancing(self):
        def boom(ts):
            raise OSError("reset")
        state = {"year": 24, "no": 5, "empty": 0, "stop_at": 250001}
        result, sent = self.run_step(boom, state)
        self.assertEqual(result, "paused")
        self.assertEqual(state["no"], 5)

    def test_round_that_keeps_erroring_is_treated_as_missing(self):
        def fetch(ts):
            if ts == 240002:
                raise ValueError("not json")
            return self.data if ts == 240001 else {}
        state = {"year": 24, "no": 1, "empty": 0, "stop_at": 250001}
        result, sent = self.run_step(fetch, state)
        self.assertEqual(result, "done")
        self.assertEqual(sent, [240001])



class NotifyTest(unittest.TestCase):
    def test_notify_calls_notify_endpoint_and_swallows_errors(self):
        with mock.patch.object(bc, "ingest", return_value='{"ok":true}') as ing:
            bc.notify("https://kl.usb.kr/ingest", "t")
        ing.assert_called_once_with("https://kl.usb.kr/notify", "t", {})
        with mock.patch.object(bc, "ingest", side_effect=OSError("down")):
            bc.notify("https://kl.usb.kr/ingest", "t")  # 예외가 밖으로 나오지 않는다

if __name__ == "__main__":
    unittest.main()
