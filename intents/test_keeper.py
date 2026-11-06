"""Unit tests for keeper.py. Chain views patched; no keys anywhere."""

import io
import json
import unittest
from contextlib import redirect_stdout
from unittest.mock import patch

from store import Store
import keeper


def _views(method_responses):
    def fake(rpc_url, contract_id, method, args, timeout=20):
        return method_responses[method]
    return fake


class KeeperTests(unittest.TestCase):
    def setUp(self):
        self.db = Store(":memory:")

    def tearDown(self):
        self.db.close()

    def test_propose_deploy_never_executes(self):
        views = {"get_vault_position": {"principal": "0", "busy": False},
                 "get_product": {"name": "P"}}
        with patch("keeper.chainmod.rpc_view", side_effect=_views(views)):
            out = keeper.propose_vault(self.db, "launchly.near",
                                       "http://rpc", 1, deploy=True)
        self.assertFalse(out["executed"])
        self.assertTrue(out["human_required"])
        self.assertEqual(out["method"], "vault_rebalance")
        self.assertIn("vault_rebalance", out["command"])
        self.assertIn("<YOUR_ACCOUNT>", out["command"])
        self.assertIn("0 NEAR", out["command"])

    def test_propose_withdraw_full_sends_null(self):
        views = {"get_vault_position": {"principal": "500", "busy": False},
                 "get_product": {"name": "P"}}
        with patch("keeper.chainmod.rpc_view", side_effect=_views(views)):
            out = keeper.propose_vault(self.db, "launchly.near",
                                       "http://rpc", 1, withdraw="full")
        self.assertEqual(out["method"], "vault_withdraw")
        self.assertIsNone(out["args"]["amount"])
        cmd_args = json.loads(
            out["command"].split("json-args '")[1].split("' prepaid")[0])
        self.assertIsNone(cmd_args["amount"])

    def test_propose_rejects_both_or_neither(self):
        with self.assertRaises(ValueError):
            keeper.propose_vault(self.db, "l", "r", 1, deploy=True,
                                 withdraw="1")
        with self.assertRaises(ValueError):
            keeper.propose_vault(self.db, "l", "r", 1)

    def test_snapshot_survives_view_failure(self):
        import chain as chainmod

        def boom(*a, **k):
            raise chainmod.ChainError("down")
        with patch("keeper.chainmod.rpc_view", side_effect=boom):
            out = keeper.propose_vault(self.db, "l", "r", 1, deploy=True)
        self.assertIn("position_error", out["snapshot"])
        self.assertIn("product_error", out["snapshot"])

    def test_reconcile_dry_never_submits(self):
        made = {}

        class FakeVerifier:
            def __init__(self, store, contract, rpc, signer, network,
                         submit=False):
                made["submit"] = submit

            def run_once(self):
                return [{"op": "attest_post", "post_id": 7}]

        with patch("keeper.chainmod.rpc_view", return_value=[]):
            out = keeper.reconcile(self.db, "launchly.near", "http://rpc",
                                   "testnet", verifier_cls=FakeVerifier)
        self.assertFalse(made["submit"])
        self.assertEqual(out["cached_products"], 0)
        self.assertEqual(out["verifier_actions"][0]["post_id"], 7)

    def test_snapshot_products(self):
        from unittest.mock import patch
        self.db.upsert_product_cache(
            1, founder_account="f.near", token_account="p1.t",
            chain_state_json="{}")

        def fake(rpc, contract, method, args):
            if method == "get_product":
                return {"status": "Live", "token_account": "p1.t",
                        "reserve_decimals": 6, "curve_sold": "5",
                        "curve_reserve": "6"}
            if method == "get_buy_quote":
                return ["500", "990", "10"]
            if method == "ft_total_supply":
                return "1000000"
            raise AssertionError(method)

        with patch("keeper.chainmod.rpc_view", side_effect=fake):
            out = keeper.snapshot_products(self.db, "c", "http://rpc")
        self.assertEqual(out[0]["tokens_per_unit"], "500")
        rows = self.db.list_snapshots("p1.t")
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]["supply"], "1000000")

    def test_snapshot_skips_non_live_and_errors(self):
        import chain as chainmod
        from unittest.mock import patch
        self.db.upsert_product_cache(1, chain_state_json="{}")
        self.db.upsert_product_cache(2, chain_state_json="{}")

        def fake(rpc, contract, method, args):
            if args.get("product_id") == 1:
                return {"status": "Created"}
            raise chainmod.ChainError("down")

        with patch("keeper.chainmod.rpc_view", side_effect=fake):
            out = keeper.snapshot_products(self.db, "c", "http://rpc")
        self.assertEqual(len(out), 1)
        self.assertEqual(out[0]["product_id"], 2)
        self.assertIn("error", out[0])

    def test_complete_dry_reports_without_sending(self):
        from unittest.mock import patch
        self.db.upsert_product_cache(1, chain_state_json="{}")
        with patch("keeper.chainmod.rpc_view") as views, \
                patch("keeper.chainmod.cli_tx") as tx:
            views.return_value = {"status": "Launching",
                                  "token_account": "p1.t"}
            out = keeper.complete_stuck_launches(
                self.db, "c", "http://rpc", "k", "testnet",
                submit=False)
        self.assertEqual(out[0]["op"], "complete_launch")
        self.assertFalse(out[0]["submitted"])
        tx.assert_not_called()

    def test_complete_submit_sends_and_skips_live(self):
        from unittest.mock import patch
        self.db.upsert_product_cache(1, chain_state_json="{}")
        self.db.upsert_product_cache(2, chain_state_json="{}")

        def fake(rpc, contract, method, args):
            if args.get("product_id") == 1:
                return {"status": "Launching",
                        "token_account": "p1.t"}
            return {"status": "Live", "token_account": "p2.t"}

        with patch("keeper.chainmod.rpc_view",
                   side_effect=fake) as views, \
                patch("keeper.chainmod.cli_tx") as tx:
            out = keeper.complete_stuck_launches(
                self.db, "c", "http://rpc", "keeper_acct", "testnet",
                submit=True)
        self.assertEqual(len(out), 1)
        self.assertTrue(out[0]["submitted"])
        tx.assert_called_once()
        self.assertEqual(tx.call_args[0][:3],
                         ("c", "keeper_acct", "complete_launch"))

    def test_reconcile_includes_completions_dry(self):
        from unittest.mock import patch
        with patch("keeper.chainmod.rpc_view", return_value=[]):
            out = keeper.reconcile(self.db, "c", "http://rpc", "testnet",
                                   verifier_cls=type(
                                       "V", (), {"__init__": lambda self, *a, **k: None,
                                                 "run_once": lambda self: []}))
        self.assertFalse(out["submitted"])
        self.assertEqual(out["launch_completions"], [])

    def test_serve_once_prints_report(self):
        buf = io.StringIO()
        with patch("keeper.chainmod.rpc_view", return_value=[]), \
                patch("keeper.Verifier") as fake:
            fake.return_value.run_once.return_value = []
            with redirect_stdout(buf):
                keeper.serve(self.db, "l", "http://rpc", "testnet", 1,
                             once=True)
        report = json.loads(buf.getvalue().strip())
        self.assertIn("cached_products", report)


if __name__ == "__main__":
    unittest.main()
