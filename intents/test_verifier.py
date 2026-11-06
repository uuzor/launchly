"""Unit tests for verifier.py and social_sim.py. Chain mocked."""

import unittest
from unittest.mock import patch

from store import Store
from social_sim import SocialSim
import verifier as vmod
from verifier import Verifier, check_post, normalize_symbol

PRODUCT = {"demo_url": "https://demo.example", "symbol": "DEMO",
           "cycle_id": 1, "status": "Live"}
RULES = {"required_link": "https://demo.example", "required_tag": "#DEMO",
         "min_account_age_days": 7}


def _post(url="https://x.com/a/status/1", handle="@a"):
    return {"post_id": 1, "product_id": 1, "cycle_id": 1, "creator": "a.near",
            "url": url, "linked_account": handle, "attested": False,
            "approved": False, "live_confirmed": False}


def _social(content, age=30, alive=True):
    return SocialSim({"x|@a|https://x.com/a/status/1":
                      {"content": content, "account_age_days": age,
                       "alive": alive}})


class SymbolTests(unittest.TestCase):
    def test_normalize(self):
        self.assertEqual(normalize_symbol("demo"), "DEMO")
        self.assertEqual(normalize_symbol("GAD4"), "GAD4")
        self.assertIsNone(normalize_symbol("x"))
        self.assertIsNone(normalize_symbol("toolonggg123"))
        self.assertIsNone(normalize_symbol("A B"))
        self.assertIsNone(normalize_symbol(""))


class CheckTests(unittest.TestCase):
    def test_good_post(self):
        r = check_post(PRODUCT, RULES, _post(),
                       _social("Love it https://demo.example #DEMO"))
        self.assertTrue(r["valid"])
        self.assertGreaterEqual(r["score"], 80)
        self.assertEqual(len(r["post_hash"]), 64)
        self.assertTrue(r["simulated"])

    def test_missing_link_and_tag(self):
        r = check_post(PRODUCT, RULES, _post(), _social("just vibes"))
        self.assertFalse(r["valid"])
        self.assertIn("link or tag", r["reason"])

    def test_link_alone_passes(self):
        r = check_post(PRODUCT, RULES, _post(),
                       _social("see https://demo.example for details"))
        self.assertTrue(r["valid"])

    def test_young_account(self):
        r = check_post(PRODUCT, RULES, _post(),
                       _social("x https://demo.example #DEMO", age=2))
        self.assertFalse(r["valid"])
        self.assertIn("account age", r["reason"])

    def test_unknown_social_record(self):
        r = check_post(PRODUCT, RULES, _post(), SocialSim({}))
        self.assertFalse(r["valid"])
        self.assertIn("not found", r["reason"])
        # Chain rejects empty post_hash: placeholder must be 64 hex and
        # deterministic per URL.
        self.assertEqual(len(r["post_hash"]), 64)
        r2 = check_post(PRODUCT, RULES, _post(), SocialSim({}))
        self.assertEqual(r["post_hash"], r2["post_hash"])

    def test_no_valid_tag_skips_tag_rule(self):
        weird = dict(PRODUCT, symbol="!!!")
        # link present, tag impossible: passes on link
        r = check_post(weird, {}, _post(),
                       _social("see https://demo.example wow"))
        self.assertTrue(r["valid"])
        # neither: reason names the missing tag
        r = check_post(weird, {}, _post(), _social("just vibes"))
        self.assertFalse(r["valid"])
        self.assertIn("no valid tag", r["reason"])

    def test_product_demo_url_default(self):
        r = check_post(PRODUCT, {}, _post(),
                       _social("see https://demo.example #DEMO"))
        self.assertTrue(r["valid"])


class AgentHookTests(unittest.TestCase):
    def test_bonus_adds_and_caps_at_100(self):
        agent = lambda c, p, r: (10, "mock: great")
        r = check_post(PRODUCT, RULES, _post(),
                       _social("Love it https://demo.example #DEMO " * 10),
                       agent=agent)
        self.assertTrue(r["valid"])
        self.assertLessEqual(r["score"], 100)
        self.assertIn("agent +", r["reason"])

    def test_bonus_never_flips_validity(self):
        agent = lambda c, p, r: (10, "mock")
        r = check_post(PRODUCT, RULES, _post(), _social("just vibes"),
                       agent=agent)
        self.assertFalse(r["valid"])
        self.assertEqual(r["score"], 0)
        self.assertNotIn("agent", r["reason"])

    def test_agent_error_falls_back_to_rules(self):
        def boom(c, p, r):
            raise RuntimeError("down")
        plain = check_post(PRODUCT, RULES, _post(),
                           _social("x https://demo.example #DEMO"))
        r = check_post(PRODUCT, RULES, _post(),
                       _social("x https://demo.example #DEMO"), agent=boom)
        self.assertTrue(r["valid"])
        self.assertEqual(r["score"], plain["score"])

    def test_agent_bonus_parses_and_clamps(self):
        import io
        import json as jsonmod

        class Resp:
            def __init__(self, payload):
                self.payload = payload

            def read(self):
                return jsonmod.dumps(self.payload).encode()

            def __enter__(self):
                return self

            def __exit__(self, *a):
                return False

        with patch("verifier.urllib.request.urlopen",
                   return_value=Resp({"bonus": 99, "reason": "x",
                                      "mock": False, "fallback": False})):
            bonus, detail = vmod.agent_bonus(
                "c", PRODUCT, RULES, "http://agent")
        self.assertEqual(bonus, 10)
        self.assertTrue(detail.startswith("model:"))

    def test_agent_bonus_unreachable_is_zero(self):
        with patch("verifier.urllib.request.urlopen",
                   side_effect=TimeoutError("slow")):
            bonus, detail = vmod.agent_bonus(
                "c", PRODUCT, RULES, "http://agent", timeout=1)
        self.assertEqual(bonus, 0)
        self.assertIn("unreachable", detail)


class RunTests(unittest.TestCase):
    def setUp(self):
        self.db = Store(":memory:")
        self.db.upsert_product_cache(
            1, founder_account="f.near", token_account="p1.main",
            chain_state_json="{}")

    def tearDown(self):
        self.db.close()

    @patch("verifier.chainmod.cli_tx")
    @patch("verifier.chainmod.rpc_view")
    def test_attest_flow_and_duplicate_hash(self, mock_view, mock_tx):
        mock_view.side_effect = [
            dict(PRODUCT, status="Live", cycle_id=1),
            [_post(), dict(_post(), post_id=2,
                           url="https://x.com/a/status/2")],
        ]
        social = SocialSim({
            "x|@a|https://x.com/a/status/1":
            {"content": "same https://demo.example #DEMO",
             "account_age_days": 30, "alive": True},
            "x|@a|https://x.com/a/status/2":
            {"content": "same https://demo.example #DEMO",
             "account_age_days": 30, "alive": True},
        })
        v = Verifier(self.db, "main", "rpc", "verifier", "testnet",
                     social=social, submit=True)
        actions = v.run_once()
        checks = [a for a in actions if a["op"] == "check"]
        self.assertTrue(checks[0]["valid"])
        self.assertFalse(checks[1]["valid"])
        self.assertIn("duplicate", checks[1]["reason"])
        self.assertEqual(mock_tx.call_count, 2)  # both attested (T/F)

    @patch("verifier.chainmod.rpc_view")
    def test_recheck_same_post_is_idempotent(self, mock_view):
        mock_view.side_effect = [
            dict(PRODUCT, status="Live", cycle_id=1), [_post()],
            dict(PRODUCT, status="Live", cycle_id=1), [_post()],
        ]
        v = Verifier(self.db, "main", "rpc", "verifier", "testnet",
                     social=_social("x https://demo.example #DEMO"),
                     submit=False)
        first = [a for a in v.run_once() if a["op"] == "check"]
        second = [a for a in v.run_once() if a["op"] == "check"]
        self.assertTrue(first[0]["valid"])
        self.assertTrue(second[0]["valid"])

    @patch("verifier.chainmod.cli_tx")
    @patch("verifier.chainmod.rpc_view")
    def test_liveness_batch(self, mock_view, mock_tx):
        attested = dict(_post(), attested=True, approved=True,
                        live_confirmed=False)
        mock_view.side_effect = [dict(PRODUCT, status="Live", cycle_id=1),
                                 [attested]]
        v = Verifier(self.db, "main", "rpc", "verifier", "testnet",
                     social=_social("x https://demo.example #DEMO"),
                     submit=True)
        actions = v.run_once()
        live = [a for a in actions if a["op"] == "liveness"]
        self.assertEqual(live[0]["count"], 1)
        args = mock_tx.call_args[0][3]
        self.assertEqual(args["confirmations"],
                         [{"post_id": 1, "live": True}])

    @patch("verifier.chainmod.rpc_view")
    def test_non_live_skipped(self, mock_view):
        mock_view.return_value = dict(PRODUCT, status="Created")
        v = Verifier(self.db, "main", "rpc", "v", "t", submit=False)
        self.assertEqual(v.run_once(), [])

    @patch("verifier.chainmod.cli_tx")
    @patch("verifier.chainmod.rpc_view")
    def test_creator_cap_precheck(self, mock_view, mock_tx):
        prod = dict(PRODUCT, status="Live", cycle_id=1,
                    max_posts_per_creator=2)
        old = dict(_post(), post_id=0, attested=True, approved=True,
                   live_confirmed=True)
        new1 = dict(_post(), post_id=1)
        new2 = dict(_post(), post_id=2, url="https://x.com/a/status/2")
        mock_view.side_effect = [prod, [old, new1, new2]]
        social = SocialSim({
            "x|@a|https://x.com/a/status/1":
            {"content": "one https://demo.example #DEMO",
             "account_age_days": 30, "alive": True},
            "x|@a|https://x.com/a/status/2":
            {"content": "two https://demo.example #DEMO",
             "account_age_days": 30, "alive": True},
        })
        v = Verifier(self.db, "main", "rpc", "verifier", "testnet",
                     social=social, submit=True)
        checks = [a for a in v.run_once() if a["op"] == "check"]
        self.assertTrue(checks[0]["valid"])   # 2nd approved: at cap
        self.assertFalse(checks[1]["valid"])  # 3rd would fail on-chain
        self.assertIn("cap reached", checks[1]["reason"])
        # Over-cap still attests as valid=false (one-shot, no count bump).
        last_tx = mock_tx.call_args_list[-1][0][3]
        self.assertFalse(last_tx["valid"])

    @patch("verifier.chainmod.rpc_view")
    def test_one_sick_product_does_not_abort_pass(self, mock_view):
        import chain as chainmod
        self.db.upsert_product_cache(
            2, founder_account="g.near", chain_state_json="{}")
        calls = []

        def fake(rpc_url, contract_id, method, args, timeout=20):
            calls.append((method, args))
            if args.get("product_id") == 1:
                raise chainmod.ChainError("boom")
            if method == "get_product":
                return dict(PRODUCT, status="Live", cycle_id=1)
            return []
        mock_view.side_effect = fake
        v = Verifier(self.db, "main", "rpc", "v", "t", submit=False)
        actions = v.run_once()
        kinds = [a["op"] for a in actions]
        self.assertIn("error", kinds)
        # Product 2 was still visited after product 1 failed.
        pids = [a[1].get("product_id") for a in calls
                if a[0] == "get_product"]
        self.assertEqual(pids, [1, 2])


if __name__ == "__main__":
    unittest.main()
