"""Unit tests for sync.snapshot_stats + keeper.stats_products + store stats."""
import unittest
from datetime import datetime, timedelta, timezone
from unittest.mock import patch

from store import Store
import keeper
from sync import product_feed, snapshot_stats


def _snap(store, pid, token, tpu, reserve, taken_at):
    store.db.execute(
        "INSERT INTO price_snapshots (product_id, token_account,"
        " tokens_per_unit, reserve, sold, supply, taken_at)"
        " VALUES (?, ?, ?, ?, ?, ?, ?)",
        (pid, token, str(tpu), str(reserve), "0", "0",
         taken_at.strftime("%Y-%m-%dT%H:%M:%SZ")))
    store.db.commit()


class SnapshotStatsTests(unittest.TestCase):
    def setUp(self):
        self.db = Store(":memory:")

    def tearDown(self):
        self.db.close()

    def test_empty_history(self):
        s = snapshot_stats(self.db, "p1.testnet")
        self.assertIsNone(s["change_24h_pct"])
        self.assertEqual(s["spark_tpu"], [])
        self.assertIsNone(s["volume_24h_base"])

    def test_no_token(self):
        s = snapshot_stats(self.db, None)
        self.assertEqual(s["spark_tpu"], [])

    def test_change_needs_24h(self):
        now = datetime.now(timezone.utc)
        _snap(self.db, 1, "p1.testnet", 2000, 100, now - timedelta(hours=5))
        _snap(self.db, 1, "p1.testnet", 1000, 150, now)
        s = snapshot_stats(self.db, "p1.testnet")
        self.assertIsNone(s["change_24h_pct"])
        self.assertEqual(len(s["spark_tpu"]), 2)

    def test_change_and_volume(self):
        now = datetime.now(timezone.utc)
        # tpu halved => price doubled => +100%
        _snap(self.db, 1, "p1.testnet", 2000, 100,
              now - timedelta(hours=25))
        _snap(self.db, 1, "p1.testnet", 2000, 100,
              now - timedelta(hours=23))
        _snap(self.db, 1, "p1.testnet", 1000, 160, now)
        s = snapshot_stats(self.db, "p1.testnet", fee_bps=100)
        self.assertEqual(s["change_24h_pct"], 100.0)
        # only the interval starting inside 24h counts: |160-100| = 60
        self.assertEqual(s["volume_24h_base"], "60")
        self.assertEqual(s["fees_24h_base"], "0")  # 60*100//10000 = 0

    def test_volume_sums_opposing_intervals_by_abs(self):
        now = datetime.now(timezone.utc)
        _snap(self.db, 1, "p1.testnet", 1000, 100,
              now - timedelta(hours=2))
        _snap(self.db, 1, "p1.testnet", 1000, 300,
              now - timedelta(hours=1))
        _snap(self.db, 1, "p1.testnet", 1000, 150, now)
        s = snapshot_stats(self.db, "p1.testnet", fee_bps=100)
        self.assertEqual(s["volume_24h_base"], "350")  # 200 + 150
        self.assertEqual(s["fees_24h_base"], "3")

    def test_spark_capped_at_32(self):
        now = datetime.now(timezone.utc)
        for i in range(40):
            _snap(self.db, 1, "p1.testnet", 1000 + i, 100,
                  now - timedelta(minutes=40 - i))
        s = snapshot_stats(self.db, "p1.testnet")
        self.assertEqual(len(s["spark_tpu"]), 32)
        self.assertEqual(s["spark_tpu"][0], "1008")


class KeeperStatsTests(unittest.TestCase):
    def setUp(self):
        self.db = Store(":memory:")
        self.db.upsert_product_cache(2, founder_account="f.testnet")

    def tearDown(self):
        self.db.close()

    def test_stats_counts_posts_and_creators(self):
        def fake(rpc_url, contract_id, method, args, timeout=20):
            if method == "get_product":
                return {"cycle_id": 1}
            if method == "list_cycle_posts":
                if args["cycle_id"] == 0:
                    return [{"creator": "a.testnet"}, {"creator": "b.testnet"}]
                return [{"creator": "a.testnet"}]
            raise AssertionError(method)

        with patch("keeper.chainmod.rpc_view", side_effect=fake):
            out = keeper.stats_products(self.db, "launchly.testnet",
                                        "http://rpc")
        self.assertEqual(out[0]["posts_total"], 3)
        self.assertEqual(out[0]["creators_total"], 2)
        row = self.db.get_stats(2)
        self.assertEqual(row["posts_total"], 3)
        self.assertEqual(row["cycles_seen"], 2)

    def test_stats_isolates_chain_errors(self):
        import chain as chainmod

        def boom(rpc_url, contract_id, method, args, timeout=20):
            raise chainmod.ChainError("down")

        with patch("keeper.chainmod.rpc_view", side_effect=boom):
            out = keeper.stats_products(self.db, "launchly.testnet",
                                        "http://rpc")
        self.assertIn("error", out[0])


class FeedStatsTests(unittest.TestCase):
    def setUp(self):
        self.db = Store(":memory:")

    def tearDown(self):
        self.db.close()

    def test_feed_carries_stats(self):
        now = datetime.now(timezone.utc)
        self.db.upsert_product_cache(
            2, founder_account="f.testnet", token_account="p1.testnet",
            chain_state_json='{"status":"Live","fee_bps":100}')
        self.db.upsert_stats(2, 7, 3, 2)
        _snap(self.db, 2, "p1.testnet", 1000, 100,
              now - timedelta(minutes=10))
        _snap(self.db, 2, "p1.testnet", 1000, 120, now)
        feed = product_feed(self.db)
        stats = feed[0]["stats"]
        self.assertEqual(stats["posts_count"], 7)
        self.assertEqual(stats["creators_count"], 3)
        self.assertEqual(len(stats["spark_tpu"]), 2)
        self.assertEqual(stats["volume_24h_base"], "20")
        self.assertIsNone(stats["change_24h_pct"])  # < 24h history


if __name__ == "__main__":
    unittest.main()
