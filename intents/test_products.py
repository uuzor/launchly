"""Unit tests for products.py and sync.py. No network (RPC mocked)."""

import json
import os
import tempfile
import unittest
from unittest.mock import patch

from products import (Products, canonical_bytes, is_hex64, sha256_hex,
                      validate_metadata, validate_rules, DraftError)
from store import Store
import sync as syncmod

FIXTURE_HASH = "157b4d1b1fc0312fe1057848da29a15cb8ca4974a456c50c5d59223812180f2e"

GOOD_META = {
    "name": "Gadget", "symbol": "GAD", "tagline": "A fine gadget",
    "description": "Does things.", "problem": "Boredom.",
    "category": "tools", "tags": ["a"], "demo_url": "https://demo.example",
    "logo": "deadbeef",
}
GOOD_RULES = {
    "required_link": "https://demo.example", "required_tag": "#GAD",
    "min_account_age_days": 7, "max_counted_posts_per_creator": 5,
}


def _png():
    return b"\x89PNG\r\n\x1a\n" + b"\x00" * 100


class CanonicalTests(unittest.TestCase):
    def test_byte_stability(self):
        b1 = canonical_bytes({"b": 1, "a": [1, 2]})
        self.assertEqual(b1, b'{"a":[1,2],"b":1}\n')
        self.assertEqual(sha256_hex(b1), FIXTURE_HASH)
        # key order must not matter
        self.assertEqual(canonical_bytes({"a": [1, 2], "b": 1}), b1)

    def test_changed_field_changes_hash(self):
        m2 = dict(GOOD_META, tagline="Another tagline")
        self.assertNotEqual(
            sha256_hex(canonical_bytes(GOOD_META)),
            sha256_hex(canonical_bytes(m2)))

    def test_is_hex64(self):
        self.assertTrue(is_hex64("ab" * 32))
        self.assertFalse(is_hex64("ab" * 31))
        self.assertFalse(is_hex64("AB" * 32))
        self.assertFalse(is_hex64(None))


class ValidationTests(unittest.TestCase):
    def test_good_passes(self):
        self.assertEqual(validate_metadata(GOOD_META), [])
        self.assertEqual(validate_rules(GOOD_RULES, 5), [])

    def test_bad_fields(self):
        bad = dict(GOOD_META, name="x", symbol="toolonggg123",
                   demo_url="http://x")
        errs = validate_metadata(bad)
        self.assertEqual(len(errs), 3)
        lower = dict(GOOD_META, symbol="gad")
        self.assertTrue(validate_metadata(lower))
        self.assertTrue(validate_rules(
            dict(GOOD_RULES, max_counted_posts_per_creator=9), 5))

    def test_https_fields(self):
        bad = dict(GOOD_META, website_url="http://evil.example")
        self.assertTrue([e for e in validate_metadata(bad)
                         if "website_url" in e])


class DraftTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.db = Store(":memory:")
        self.p = Products(self.db, upload_dir=self.tmp)

    def tearDown(self):
        self.db.close()

    def test_create_update_finalize(self):
        d = self.p.create_draft(founder_hint="f.near")
        self.p.update_draft(d["draft_id"], d["edit_token"],
                            metadata=GOOD_META, rules=GOOD_RULES)
        out = self.p.finalize(d["draft_id"], d["edit_token"],
                              chain_max_posts=5)
        self.assertTrue(is_hex64(out["metadata_hash"]))
        self.assertEqual(out["create_args"]["description"], "A fine gadget")
        self.assertEqual(out["create_args"]["demo_url"],
                         "https://demo.example")
        # frozen after finalize
        with self.assertRaises(DraftError):
            self.p.update_draft(d["draft_id"], d["edit_token"],
                                metadata=GOOD_META)
        self.assertEqual(
            self.p.draft_status(d["draft_id"], d["edit_token"]), "launching")

    def test_bad_token_rejected(self):
        d = self.p.create_draft()
        with self.assertRaises(DraftError):
            self.p.get_draft(d["draft_id"], "wrong")

    def test_finalize_validates(self):
        d = self.p.create_draft()
        with self.assertRaises(DraftError):
            self.p.finalize(d["draft_id"], d["edit_token"])

    def test_assets(self):
        d = self.p.create_draft()
        r = self.p.put_asset(d["draft_id"], d["edit_token"], "logo", _png())
        self.assertTrue(is_hex64(r["sha256"]))
        self.assertEqual(r["mime"], "image/png")
        path, mime = self.p.get_asset_path(r["sha256"])
        self.assertTrue(os.path.exists(path))
        with self.assertRaises(DraftError):
            self.p.put_asset(d["draft_id"], d["edit_token"], "logo",
                             b"<svg>nope</svg>")
        with self.assertRaises(DraftError):
            self.p.put_asset(d["draft_id"], d["edit_token"], "banner", _png())
        with self.assertRaises(DraftError):
            self.p.put_asset(d["draft_id"], d["edit_token"], "logo",
                             _png() * 10000)
        self.assertIsNone(self.p.get_asset_path("zz"))

    def test_milestone(self):
        r = self.p.draft_milestone(1, {"title": "t", "summary": "s",
                                       "evidence_urls": ["https://x.example"]})
        self.assertTrue(is_hex64(r["evidence_hash"]))
        with self.assertRaises(DraftError):
            self.p.draft_milestone(1, {"title": "", "summary": "s"})

    def test_creator_defaults(self):
        c = self.p.get_creator("c.near")
        self.assertTrue(c["payout_defaulted"])
        self.assertEqual(c["payout_asset"], "USDT")
        self.p.set_payout_preference("c.near", "USDC", "eth", "0xabc")
        c = self.p.get_creator("c.near")
        self.assertFalse(c["payout_defaulted"])
        link = self.p.link_social("c.near", "x", "@c")
        self.assertTrue(link["simulated"])


class SyncTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.db = Store(":memory:")
        self.p = Products(self.db, upload_dir=self.tmp)

    def tearDown(self):
        self.db.close()

    def _chain_product(self, pid, founder, mh, rh):
        # faithful: no product_id field (id is the registry position)
        return {"founder": founder,
                "token_account": f"p{pid}.main.testnet", "status": "Live",
                "metadata_hash": mh, "rules_hash": rh}

    @patch("sync.chainmod.rpc_view")
    def test_sync_binds_draft(self, mock_view):
        d = self.p.create_draft(founder_hint="f.near")
        self.p.update_draft(d["draft_id"], d["edit_token"],
                            metadata=GOOD_META, rules=GOOD_RULES)
        out = self.p.finalize(d["draft_id"], d["edit_token"],
                              chain_max_posts=5)
        mock_view.side_effect = [
            [self._chain_product(1, "f.near", out["metadata_hash"],
                                 out["rules_hash"])],
            [],
        ]
        cached, bound = syncmod.sync_products(self.db, "main.testnet")
        self.assertEqual((cached, bound), (1, 1))
        self.assertEqual(
            self.db.get_draft(d["draft_id"])["product_id"], 1)
        feed = syncmod.product_feed(self.db)
        self.assertEqual(feed[0]["metadata_state"], "registered")

    @patch("sync.chainmod.rpc_view")
    def test_no_metadata_state(self, mock_view):
        mock_view.side_effect = [
            [self._chain_product(1, "stranger.near", None, None)], []]
        syncmod.sync_products(self.db, "main.testnet")
        feed = syncmod.product_feed(self.db)
        self.assertEqual(feed[0]["metadata_state"], "on-chain, no metadata")

    @patch("sync.chainmod.rpc_view")
    def test_mismatch_flagged(self, mock_view):
        d = self.p.create_draft(founder_hint="f.near")
        self.p.update_draft(d["draft_id"], d["edit_token"],
                            metadata=GOOD_META, rules=GOOD_RULES)
        self.p.finalize(d["draft_id"], d["edit_token"], chain_max_posts=5)
        # chain shows DIFFERENT hashes for the founder's product
        mock_view.side_effect = [
            [self._chain_product(1, "f.near", "aa" * 32, "bb" * 32)], []]
        cached, bound = syncmod.sync_products(self.db, "main.testnet")
        self.assertEqual(bound, 0)
        row = self.db.get_cached_product(1)
        self.assertIsNone(row["draft_id"])
        feed = syncmod.product_feed(self.db)
        self.assertEqual(feed[0]["metadata_state"], "on-chain, no metadata")


if __name__ == "__main__":
    unittest.main()
