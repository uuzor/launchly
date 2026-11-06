"""Unit tests for flows.py. 1Click client fully mocked."""

import unittest
from unittest.mock import MagicMock

from store import Store
import flows


def _client():
    c = MagicMock()
    c.quote.return_value = {"depositAddress": "dep1", "amountOut": "100"}
    c.wait_for_status.return_value = {"status": "SUCCESS", "tx": "0x1"}
    return c


class FlowsTests(unittest.TestCase):
    def setUp(self):
        self.db = Store(":memory:")

    def tearDown(self):
        self.db.close()

    def test_dry_payin_labels_and_persists(self):
        out = flows.dry_payin(self.db, _client(), "nep141:eth.omft.near",
                              "1000", "launchly.near",
                              "nep141:usdt.tether-token.near")
        self.assertTrue(out["dry"])
        self.assertFalse(out["live"])
        self.assertFalse(out["simulated"])
        self.assertEqual(self.db.get_quote(out["quote_id"])["kind"], "payin")

    def test_dry_payout_labels_and_persists(self):
        out = flows.dry_payout(self.db, _client(), "nep141:usdt",
                               "1000", "nep141:usdc", "alice.near",
                               "launchly.near")
        self.assertTrue(out["dry"])
        self.assertEqual(self.db.get_quote(out["quote_id"])["kind"], "payout")

    def test_dry_flows_pass_dry_true(self):
        c = _client()
        out = flows.dry_payin(self.db, c, "a", "1", "l", "r")
        _, kwargs = c.quote.call_args
        self.assertTrue(kwargs["dry"])
        self.assertFalse(kwargs["allow_live"])
        # Adapter returns (response, addr); stored quote is the dict.
        import json
        self.assertIsInstance(out["quote"], dict)
        stored = self.db.get_quote(out["quote_id"])
        self.assertIsInstance(json.loads(stored["response_json"]), dict)

    def test_prepare_live_swap_stops_at_deposit(self):
        c = _client()
        out = flows.prepare_live_swap(
            self.db, c, "payout",
            {"reserve_asset_id": "r", "reserve_amount": "1",
             "dest_asset_id": "d", "dest_address": "x",
             "launchly_account": "launchly.near"})
        self.assertTrue(out["live"])
        self.assertEqual(out["deposit_address"], "dep1")
        self.assertIn("HUMAN ACTION REQUIRED", out["instructions"])
        sw = self.db.get_swap("dep1")
        self.assertEqual(sw["status"], "PENDING_DEPOSIT")
        with self.assertRaises(ValueError):
            flows.prepare_live_swap(self.db, c, "bogus", {})

    def test_watch_records_terminal(self):
        out = flows.watch_swap(self.db, _client(), "dep1", timeout_s=1)
        self.assertEqual(out["status"], "SUCCESS")
        self.assertEqual(self.db.get_swap("dep1")["status"], "SUCCESS")


if __name__ == "__main__":
    unittest.main()
