"""Unit tests for store.py. In-memory SQLite, no network, no files."""

import unittest

from store import Store


class StoreTests(unittest.TestCase):
    def setUp(self):
        self.db = Store(":memory:")

    def tearDown(self):
        self.db.close()

    def test_draft_crud_and_hash_lookup(self):
        self.db.upsert_draft("d1", "tokhash", founder_hint="alice.near")
        d = self.db.get_draft("d1")
        self.assertEqual(d["status"], "draft")
        self.assertIsNone(d["product_id"])
        self.db.upsert_draft("d1", "tokhash", status="finalized",
                             metadata_hash="aa", rules_hash="bb")
        found = self.db.find_draft_by_hashes("alice.near", "aa", "bb")
        self.assertEqual(found["draft_id"], "d1")
        self.assertIsNone(
            self.db.find_draft_by_hashes("alice.near", "aa", "xx"))

    def test_assets(self):
        self.db.upsert_draft("d1", "t")
        self.db.add_asset("s1", "d1", "logo", "image/png", 100)
        self.assertEqual(self.db.count_draft_assets("d1"), 1)
        self.assertEqual(self.db.get_asset("s1")["mime"], "image/png")

    def test_products_cache(self):
        self.assertEqual(self.db.list_cached_products(), [])
        self.db.upsert_product_cache(1, founder_account="f.near",
                                     metadata_hash="aa")
        self.db.upsert_product_cache(1, founder_account="f.near",
                                     metadata_hash="aa", draft_id="d1")
        prods = self.db.list_cached_products()
        self.assertEqual(len(prods), 1)
        self.assertEqual(prods[0]["draft_id"], "d1")

    def test_milestones(self):
        mid = self.db.add_milestone(1, evidence_hash="ee")
        rows = self.db.list_milestones(1)
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]["id"], mid)
        self.assertEqual(rows[0]["status"], "draft")

    def test_creator_profile_and_social(self):
        self.db.set_payout_preference("c.near", "USDC", "eth", "0xabc")
        p = self.db.get_creator_profile("c.near")
        self.assertEqual(p["payout_chain"], "eth")
        self.db.link_social("c.near", "x", "@c", simulated=True)
        link = self.db.get_social_link("c.near", "x")
        self.assertEqual(link["handle"], "@c")
        self.assertEqual(link["simulated"], 1)

    def test_post_checks_and_content_hashes(self):
        self.assertFalse(self.db.seen_content_hash(1, "h1"))
        self.db.record_post_check(7, 1, 2, "c.near", "h1", True, 90,
                                  reason="ok", simulated=True)
        self.assertEqual(self.db.get_post_check(7)["score"], 90)
        self.db.add_content_hash(1, "h1", 7)
        self.assertTrue(self.db.seen_content_hash(1, "h1"))

    def test_operator_flags(self):
        fid = self.db.flag_product(1, "suspicious links")
        self.assertGreater(fid, 0)

    def test_quotes_and_swaps(self):
        qid = self.db.add_quote("payout", {"a": 1}, {"dry": True})
        self.assertEqual(self.db.get_quote(qid)["kind"], "payout")
        self.db.upsert_swap("addr1", "PENDING_DEPOSIT", quote_id=qid)
        self.db.upsert_swap("addr1", "SUCCESS", receipt={"tx": "0x1"})
        sw = self.db.get_swap("addr1")
        self.assertEqual(sw["status"], "SUCCESS")
        self.assertIn("0x1", sw["receipt_json"])

    def test_kv(self):
        self.assertIsNone(self.db.kv_get("k"))
        self.db.kv_set("k", "v")
        self.assertEqual(self.db.kv_get("k"), "v")

    def test_cycle_payout_claim_cache(self):
        self.assertIsNone(self.db.get_cycle_cache(21, 0))
        self.assertIsNone(self.db.get_payout_cache(21, 0, "c.near"))
        self.db.put_cycle_cache(21, 0, '{"finalized": true}', "[]")
        row = self.db.get_cycle_cache(21, 0)
        self.assertIn("finalized", row["pool_json"])
        self.assertEqual(row["posts_json"], "[]")
        self.db.put_payout_cache(21, 0, "c.near", "500")
        self.assertEqual(
            self.db.get_payout_cache(21, 0, "c.near"), "500")
        self.assertIsNone(self.db.get_claim(21, 0, "c.near"))
        self.db.record_claim(21, 0, "c.near", "500", "H" * 44)
        claim = self.db.get_claim(21, 0, "c.near")
        self.assertEqual(claim["amount"], "500")
        self.assertEqual(claim["tx_hash"], "H" * 44)
        # Re-recording keeps the first tx (idempotent).
        self.db.record_claim(21, 0, "c.near", "500", "G" * 44)
        self.assertEqual(
            self.db.get_claim(21, 0, "c.near")["tx_hash"], "H" * 44)
        mine = self.db.list_claims("c.near")
        self.assertEqual(len(mine), 1)
        self.assertEqual(mine[0]["product_id"], 21)


if __name__ == "__main__":
    unittest.main()
