"""Route-level tests against http.server in-thread. No network."""

import json
import tempfile
import threading
import unittest
import urllib.request
import urllib.error

import api
from products import Products
from store import Store

TOKEN = "test-operator-token"
PNG = (b"\x89PNG\r\n\x1a\n" + b"\x00" * 64)

META = {"name": "Widget", "symbol": "WDG", "tagline": "does things",
        "description": "longer text", "problem": "boredom",
        "category": "tools", "demo_url": "https://example.com/demo",
        "logo": "sha256:pending"}
RULES = {"required_link": "https://example.com/p",
         "required_tag": "#WDG", "min_account_age_days": 7}


class FakeOneClick:
    def tokens(self):
        return [{"symbol": "USDT", "blockchain": "near",
                 "assetId": "nep141:usdt"}]

    def find_asset(self, symbol=None, blockchain=None, contract=None):
        for t in self.tokens():
            if symbol and t["symbol"] != symbol:
                continue
            if blockchain and t["blockchain"] != blockchain:
                continue
            return t
        from adapter import OneClickError
        raise OneClickError("asset not found: x")

    def quote(self, **kw):
        return {"depositAddress": "dep-test", "echo": kw}

    def wait_for_status(self, deposit_address, timeout_s=900,
                        interval_s=15):
        return {"status": "SUCCESS"}


class ApiTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.TemporaryDirectory()
        cls.cfg = {"operator_token": TOKEN,
                   "db": cls.tmp.name + "/t.db",
                   "port": 0, "contract": "launchly.testnet",
                   "rpc": "http://rpc", "network": "testnet",
                   "upload_dir": cls.tmp.name + "/up",
                   "oneclick_base": "http://1click", "oneclick_jwt": ""}
        store = Store(cls.cfg["db"])
        products = Products(store, cls.cfg["upload_dir"])
        cls.server = api.make_server(cls.cfg, store, products,
                                     FakeOneClick)
        cls.port = cls.server.server_address[1]
        cls.thread = threading.Thread(target=cls.server.serve_forever,
                                      daemon=True)
        cls.thread.start()

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()
        cls.server.store.close()
        cls.tmp.cleanup()

    # -- helpers -----------------------------------------------------
    def _req(self, method, path, body=None, raw=None, headers=None):
        url = f"http://127.0.0.1:{self.port}{path}"
        data = raw if raw is not None else (
            json.dumps(body).encode() if body is not None else None)
        req = urllib.request.Request(url, data=data, method=method,
                                     headers=headers or {})
        if body is not None:
            req.add_header("Content-Type", "application/json")
        try:
            with urllib.request.urlopen(req) as resp:
                payload = resp.read()
                try:
                    return resp.status, json.loads(payload.decode())
                except ValueError:
                    return resp.status, payload
        except urllib.error.HTTPError as e:
            try:
                return e.code, json.loads(e.read().decode())
            except ValueError:
                return e.code, {}

    def _op(self, extra=None):
        h = {"Authorization": "Bearer " + TOKEN}
        h.update(extra or {})
        return h

    # -- tests -------------------------------------------------------
    def test_refuses_default_token(self):
        with self.assertRaises(api.ApiError):
            api.load_config({"OPERATOR_TOKEN": "change-me"})
        with self.assertRaises(api.ApiError):
            api.load_config({})

    def test_health(self):
        code, out = self._req("GET", "/health")
        self.assertEqual(code, 200)
        self.assertTrue(out["ok"])
        self.assertTrue(out["simulated"]["social"])

    def test_assets_list_and_filter(self):
        code, out = self._req("GET", "/assets")
        self.assertEqual(out["assets"][0]["symbol"], "USDT")
        code, out = self._req("GET", "/assets?symbol=USDT&blockchain=near")
        self.assertEqual(len(out["assets"]), 1)
        code, out = self._req("GET", "/assets?symbol=NOPE")
        self.assertEqual(out["assets"], [])

    def test_quote_payout_dry_and_persisted(self):
        code, out = self._req("POST", "/quotes/payout", {
            "reserve_asset_id": "r", "reserve_amount": "1",
            "dest_asset_id": "d", "dest_address": "x"})
        self.assertEqual(code, 200)
        self.assertTrue(out["dry"])
        self.assertTrue(out["quote"]["echo"]["dry"])
        self.assertNotEqual(
            self.server.store.get_quote(out["quote_id"]), None)

    def test_quote_payin_requires_fields(self):
        code, out = self._req("POST", "/quotes/payin", {"origin_amount": "1"})
        self.assertEqual(code, 400)

    def test_swap_unknown(self):
        code, _ = self._req("GET", "/swaps?depositAddress=nope")
        self.assertEqual(code, 404)

    def test_operator_routes_need_token(self):
        code, _ = self._req("POST", "/verifier/run-once", {})
        self.assertEqual(code, 401)
        code, _ = self._req("POST", "/keeper/run-once", {})
        self.assertEqual(code, 401)

    def test_verifier_run_dry(self):
        code, out = self._req("POST", "/verifier/run-once", {},
                              headers=self._op())
        self.assertEqual(code, 200)
        self.assertFalse(out["submitted"])

    def test_keeper_run_and_status(self):
        from unittest.mock import patch
        with patch("keeper.chainmod.rpc_view", return_value=[]):
            code, out = self._req("POST", "/keeper/run-once", {},
                                  headers=self._op())
            self.assertEqual(code, 200)
            self.assertIn("cached_products", out)
        views = {"get_vault_position": {"principal": "0"},
                 "get_product": {"name": "P"}}
        with patch("keeper.chainmod.rpc_view",
                   side_effect=lambda *a, **k: views[a[2]]):
            code, out = self._req("GET", "/keeper/status?product_id=1")
            self.assertEqual(out["position"]["principal"], "0")

    def test_draft_lifecycle(self):
        code, d = self._req("POST", "/products/drafts",
                            {"founder_hint": "alice.near"})
        self.assertEqual(code, 201)
        did, tok = d["draft_id"], d["edit_token"]
        h = {"X-Edit-Token": tok}
        code, _ = self._req("PUT", f"/products/drafts/{did}",
                            {"metadata": META, "rules": RULES}, headers=h)
        self.assertEqual(code, 200)
        code, got = self._req("GET", f"/products/drafts/{did}", headers=h)
        self.assertEqual(got["metadata"]["symbol"], "WDG")
        code, fin = self._req("POST", f"/products/drafts/{did}/finalize",
                              {}, headers=h)
        self.assertEqual(code, 200)
        self.assertEqual(len(fin["metadata_hash"]), 64)
        self.assertEqual(fin["create_args"]["symbol"], "WDG")
        code, st = self._req("GET", f"/products/drafts/{did}/status",
                             headers=h)
        self.assertEqual(st["status"], "launching")
        code, _ = self._req("GET", f"/products/drafts/{did}",
                            headers={"X-Edit-Token": "wrong"})
        self.assertEqual(code, 403)

    def test_asset_upload_and_serve(self):
        code, d = self._req("POST", "/products/drafts", {})
        h = {"X-Edit-Token": d["edit_token"]}
        code, up = self._req("PUT",
                             f"/products/drafts/{d['draft_id']}/assets/logo",
                             raw=PNG, headers=h)
        self.assertEqual(code, 200)
        code, data = self._req("GET", f"/assets/{up['sha256']}")
        self.assertEqual(code, 200)
        self.assertEqual(data, PNG)

    def test_feed_product_docs_milestones(self):
        code, out = self._req("GET", "/products")
        pids = [p["product_id"] for p in out["products"]]
        self.assertNotIn(1, pids)
        code, _ = self._req("GET", "/products/1")
        self.assertEqual(code, 404)
        code, out = self._req("GET", "/products/1/milestones")
        self.assertEqual(out["milestones"], [])
        code, out = self._req("POST", "/products/1/milestones",
                              {"title": "t", "summary": "s"},
                              headers=self._op())
        self.assertEqual(code, 201)
        self.assertEqual(len(out["evidence_hash"]), 64)

    def test_creator_and_flag(self):
        code, out = self._req("GET", "/creators/alice.near")
        self.assertTrue(out["payout_defaulted"])
        code, _ = self._req("PUT", "/creators/alice.near/payout-preference",
                            {"asset": "USDC", "chain": "near",
                             "address": "alice.near"})
        self.assertEqual(code, 200)
        code, out = self._req("POST", "/creators/alice.near/social-link",
                              {"platform": "x", "handle": "alice"})
        self.assertTrue(out["simulated"])
        code, _ = self._req("POST", "/operator/products/1/flag",
                            {"reason": "spam"}, headers=self._op())
        self.assertEqual(code, 200)
        code, _ = self._req("POST", "/operator/products/1/flag", {})
        self.assertEqual(code, 401)

    def test_verifier_posts_filter(self):
        self.server.store.record_post_check(79, 77, 2, "c", "h", True, 80)
        code, out = self._req("GET", "/verifier/posts?product_id=77")
        self.assertEqual(len(out["posts"]), 1)
        code, out = self._req("GET", "/verifier/posts?product_id=78")
        self.assertEqual(out["posts"], [])

    def test_relay_accepts_rust_vector(self):
        import base64
        import os
        here = os.path.dirname(os.path.abspath(__file__))
        with open(os.path.join(here, "relay_vectors.json")) as f:
            vectors = {v["name"]: v for v in json.load(f)["vectors"]}
        raw = bytes.fromhex(vectors["launch"]["borsh_hex"])
        from unittest.mock import patch
        with patch("relay.rpc_height", return_value=18_000_000):
            code, out = self._req("POST", "/relay", {
                "delegate": base64.b64encode(raw).decode()})
        self.assertEqual(code, 200)
        self.assertTrue(out["accepted"])
        self.assertEqual(out["methods"], ["launch_coin"])
        self.assertEqual(out["broadcast"], "pending-signer")

    def test_relay_rejects_garbage(self):
        code, out = self._req("POST", "/relay", {"delegate": "!!!notb64"})
        self.assertIn(code, (200, 400))
        if code == 200:
            self.assertFalse(out["accepted"])
        code, _ = self._req("POST", "/relay", {})
        self.assertEqual(code, 400)

    def test_relay_log_operator_only(self):
        code, _ = self._req("GET", "/operator/relay/log")
        self.assertEqual(code, 401)
        code, out = self._req("GET", "/operator/relay/log?limit=5",
                              headers=self._op())
        self.assertEqual(code, 200)
        self.assertIsInstance(out["entries"], list)

    def test_quote_buy_and_sell(self):
        from unittest.mock import patch

        def fake_view(rpc, contract, method, args):
            if method == "get_product":
                return {"name": "P"}
            if method == "get_buy_quote":
                self.assertEqual(args["reserve_in"], "1000")
                return ["500", "990", "10"]
            if method == "get_sell_quote":
                self.assertEqual(args["tokens_in"], "500")
                return ["900", "90"]
            raise AssertionError(method)

        with patch("api.chainmod.rpc_view", side_effect=fake_view):
            code, out = self._req(
                "GET", "/products/1/quote?side=buy&amount=1000")
            self.assertEqual(code, 200)
            self.assertEqual(
                (out["tokens_out"], out["cost"], out["fee"]),
                ("500", "990", "10"))
            code, out = self._req(
                "GET", "/products/1/quote?side=sell&amount=500")
            self.assertEqual(
                (out["net_proceeds"], out["fee"]), ("900", "90"))

    def test_quote_validation(self):
        code, _ = self._req("GET", "/products/1/quote?side=hold&amount=1")
        self.assertEqual(code, 400)
        code, _ = self._req("GET", "/products/1/quote?side=buy&amount=1.5")
        self.assertEqual(code, 400)
        code, _ = self._req("GET", "/products/1/quote?side=buy")
        self.assertEqual(code, 400)
        from unittest.mock import patch
        with patch("api.chainmod.rpc_view", return_value=None):
            code, _ = self._req("GET", "/products/9/quote?side=buy&amount=1")
            self.assertEqual(code, 404)

    def test_tokens_endpoints(self):
        from unittest.mock import patch
        self.server.store.upsert_product_cache(
            11, founder_account="f.near", token_account="p11.t",
            chain_state_json="{}")

        def fake_view(rpc, contract, method, args):
            if method == "get_product":
                return {"name": "P", "symbol": "PP", "status": "Live",
                        "token_account": "p11.t", "reserve_decimals": 6,
                        "curve_sold": "5", "curve_reserve": "6",
                        "reserve_token": "usdt.t"}
            if method == "ft_total_supply":
                return "1000000"
            if method == "get_buy_quote":
                return ["500", "990", "10"]
            if method == "ft_balance_of":
                return "42"
            raise AssertionError(method)

        with patch("api.chainmod.rpc_view", side_effect=fake_view):
            code, out = self._req("GET", "/tokens?product_id=11")
            self.assertEqual(code, 200)
            tok = out["tokens"][0]
            self.assertEqual(
                (tok["token_account"], tok["total_supply"],
                 tok["tokens_per_unit"]),
                ("p11.t", "1000000", "500"))
            code, out = self._req("GET", "/tokens/p11.t")
            self.assertEqual(out["symbol"], "PP")
            code, out = self._req(
                "GET", "/tokens/p11.t/balance?holder=a.near")
            self.assertEqual(out["balance"], "42")
            code, _ = self._req("GET", "/tokens/nope.t")
            self.assertEqual(code, 404)
            code, _ = self._req("GET", "/tokens/p11.t/balance")
            self.assertEqual(code, 400)

    def test_token_chart_buckets(self):
        self.server.store.add_snapshot(11, "p11.t", "500", "6", "5",
                                       "1000000")
        self.server.store.add_snapshot(11, "p11.t", "501", "7", "5",
                                       "1000001")
        code, out = self._req("GET", "/tokens/p11.t/chart")
        self.assertEqual(out["count"], 2)
        self.assertEqual(out["points"][0]["tokens_per_unit"], "500")
        code, out = self._req("GET", "/tokens/p11.t/chart?resolution=hour")
        self.assertEqual(out["count"], 1)
        code, _ = self._req("GET", "/tokens/p11.t/chart?resolution=week")
        self.assertEqual(code, 400)

    def test_chain_posts_and_single_post(self):
        from unittest.mock import patch
        post = {"post_id": 3, "creator": "c.near", "url": "https://x/y",
                "attested": True}
        self.server.store.record_post_check(3, 1, 0, "c.near", "h",
                                            True, 80, "ok")

        def fake_view(rpc, contract, method, args):
            if method == "get_product":
                return {"status": "Live", "cycle_id": 0}
            if method == "list_cycle_posts":
                return [post]
            if method == "get_post":
                return post if args["post_id"] == 3 else None
            raise AssertionError(method)

        with patch("api.chainmod.rpc_view", side_effect=fake_view):
            code, out = self._req("GET", "/products/1/posts")
            self.assertEqual(out["posts"][0]["check"]["score"], 80)
            code, out = self._req("GET", "/posts/3")
            self.assertEqual(out["post"]["creator"], "c.near")
            code, _ = self._req("GET", "/posts/99")
            self.assertEqual(code, 404)

    def test_validate_post(self):
        import time
        from unittest.mock import patch

        def fake_view(rpc, contract, method, args):
            if method == "get_product":
                return {"status": "Live", "cycle_id": 0,
                        "cycle_end_ns": time.time_ns() + 10 ** 18}
            if method == "list_cycle_posts":
                return [{"url": "https://x.com/taken"}]
            raise AssertionError(method)

        with patch("api.chainmod.rpc_view", side_effect=fake_view):
            code, out = self._req("POST", "/posts/validate", {
                "product_id": 1, "url": "https://x.com/fresh",
                "handle": "@c"})
            self.assertTrue(out["ok"])
            self.assertEqual(out["submit_args"]["linked_account"], "@c")
            code, out = self._req("POST", "/posts/validate", {
                "product_id": 1, "url": "https://x.com/taken",
                "handle": "@c"})
            self.assertFalse(out["ok"])
            code, out = self._req("POST", "/posts/validate", {
                "product_id": 1, "url": "http://nope", "handle": "@c"})
            self.assertFalse(out["ok"])

    def test_creator_posts_and_earnings(self):
        from unittest.mock import patch
        self._clear_cycle_cache()
        self.server.store.upsert_product_cache(
            12, founder_account="f.near", chain_state_json="{}")

        def fake_view(rpc, contract, method, args):
            if method == "get_product":
                return {"cycle_id": 0}
            if method == "list_cycle_posts":
                return [{"post_id": 5, "creator": "c.near"},
                        {"post_id": 6, "creator": "other"}]
            if method == "get_payout":
                return "100"
            if method == "get_pool":
                return {"finalized": True}
            raise AssertionError(method)

        with patch("api.chainmod.rpc_view", side_effect=fake_view):
            n = len(self.server.store.list_cached_products())
            code, out = self._req("GET", "/creators/c.near/posts")
            self.assertEqual(len(out["posts"]), n)
            self.assertTrue(all(e["post"]["creator"] == "c.near"
                                for e in out["posts"]))
            code, out = self._req("GET", "/creators/c.near/earnings")
            self.assertEqual(out["total_payout"], str(100 * n))
            self.assertTrue(out["earnings"][0]["finalized"])

    def test_votes(self):
        from unittest.mock import patch

        def fake_view(rpc, contract, method, args):
            if method == "get_product":
                return {"next_milestone": 2}
            if method == "get_milestone":
                return {"index": args["index"], "finalized": False}
            if method == "get_vote_lock":
                return {"approve": True, "amount": "7"}
            raise AssertionError(method)

        with patch("api.chainmod.rpc_view", side_effect=fake_view):
            code, out = self._req("GET", "/products/1/votes?voter=v.near")
            self.assertEqual(len(out["milestones"]), 2)
            self.assertEqual(out["milestones"][0]["vote_lock"]["amount"],
                             "7")
            code, out = self._req("GET", "/products/1/votes")
            self.assertIsNone(out["milestones"][0]["vote_lock"])

    def test_bad_ids_are_400_not_500(self):
        code, out = self._req("GET", "/verifier/posts?product_id=abc")
        self.assertEqual(code, 400)
        code, _ = self._req("GET", "/keeper/status?product_id=1x")
        self.assertEqual(code, 400)
        code, _ = self._req("GET", "/keeper/status")
        self.assertEqual(code, 400)

    # -- creator earnings: claimed status + dispute countdown -------
    def _seed_product(self, pid):
        self.server.store.upsert_product_cache(
            pid, founder_account="f.near", chain_state_json="{}")

    def _clear_cycle_cache(self):
        # Shared class DB: each fake chain world starts uncached.
        db = self.server.store.db
        db.execute("DELETE FROM cycle_cache")
        db.execute("DELETE FROM payout_cache")
        db.commit()

    def _creator_views(self, payout="500", finalized=True,
                       claimable_at=9_999_999_999_000_000_000):
        def fake_view(rpc, contract, method, args):
            if method == "get_product":
                return {"cycle_id": 0}
            if method == "list_cycle_posts":
                return [{"post_id": 50 + args["product_id"],
                         "creator": "c.near"}]
            if method == "get_payout":
                return payout
            if method == "get_pool":
                return {"finalized": finalized,
                        "payout_available_ns": claimable_at}
            raise AssertionError(method)
        return fake_view

    def _entry_for(self, out, pid):
        rows = [e for e in out["earnings"]
                if e["product_id"] == pid and e["cycle_id"] == 0]
        self.assertEqual(len(rows), 1)
        return rows[0]

    def test_earnings_claim_fields_and_claimable_at(self):
        from unittest.mock import patch
        self._clear_cycle_cache()
        self._seed_product(21)
        self.server.store.record_claim(21, 0, "c.near", "500", "H" * 44)
        with patch("api.chainmod.rpc_view",
                   side_effect=self._creator_views()):
            code, out = self._req("GET", "/creators/c.near/earnings")
            self.assertEqual(code, 200)
            mine = self._entry_for(out, 21)
            self.assertTrue(mine["finalized"])
            self.assertEqual(mine["payout"], "500")
            self.assertEqual(mine["claimable_at_ns"],
                             9_999_999_999_000_000_000)
            self.assertTrue(mine["claimed"])
            self.assertEqual(mine["claim_tx"], "H" * 44)
            code, out = self._req("GET", "/creators/fresh.near/earnings")
            theirs = self._entry_for(out, 21)
            self.assertFalse(theirs["claimed"])
            self.assertIsNone(theirs["claim_tx"])

    def test_finalized_cache_skips_repeat_rpc(self):
        from unittest.mock import patch
        self._clear_cycle_cache()
        self._seed_product(22)
        calls = []

        def counting(rpc, contract, method, args):
            calls.append((method, args.get("product_id")))
            return self._creator_views()(rpc, contract, method, args)

        with patch("api.chainmod.rpc_view", side_effect=counting):
            self._req("GET", "/creators/c.near/earnings")
            first = [c for c in calls if c[1] == 22]
            calls.clear()
            self._req("GET", "/creators/c.near/earnings")
            second = [c for c in calls if c[1] == 22]
            # get_product repeats (cycle may advance); pool/payout/posts
            # for the finalized cycle must come from cache.
            self.assertTrue(any(m == "get_pool" for m, _ in first))
            self.assertTrue(any(m == "get_payout" for m, _ in first))
            self.assertFalse(any(m == "get_pool" for m, _ in second))
            self.assertFalse(any(m == "get_payout" for m, _ in second))
            calls.clear()
            self._req("GET", "/creators/c.near/posts")
            third = [c for c in calls if c[1] == 22]
            self.assertFalse(
                any(m == "list_cycle_posts" for m, _ in third))

    # -- claim reports: verify tx, then record ----------------------
    def _claim_tx(self, **over):
        import base64
        import json
        args = base64.b64encode(json.dumps(
            {"product_id": 21, "cycle_id": 0}).encode()).decode()
        tx = {
            "status": {"SuccessValue": ""},
            "transaction": {
                "hash": "H" * 44, "signer_id": "c.near",
                "receiver_id": "launchly.testnet",
                "actions": [{"FunctionCall": {
                    "method_name": "claim_payout", "args": args,
                    "gas": 1, "deposit": "0"}}]},
            "receipts_outcome": [
                {"outcome": {"status": {"SuccessValue": ""},
                             "logs": []}}],
        }
        tx.update(over)
        return tx

    def test_claim_report_verify_and_record(self):
        from unittest.mock import patch
        self._clear_cycle_cache()
        self._seed_product(21)
        body = {"product_id": 21, "cycle_id": 0, "tx_hash": "H" * 44}
        with patch("api.chainmod.tx_status",
                   return_value=self._claim_tx()), \
             patch("api.chainmod.rpc_view",
                   side_effect=self._creator_views(payout="500")):
            code, out = self._req("POST", "/creators/c.near/claims", body)
            self.assertEqual(code, 200)
            self.assertTrue(out["claimed"])
            self.assertEqual(out["amount"], "500")
            # Idempotent: same receipt twice, one record.
            code, out = self._req("POST", "/creators/c.near/claims", body)
            self.assertEqual(code, 200)
            code, out = self._req("GET", "/creators/c.near/earnings")
            self.assertTrue(self._entry_for(out, 21)["claimed"])

    def test_claim_report_rejects_bad_tx(self):
        from unittest.mock import patch
        self._seed_product(21)
        body = {"product_id": 21, "cycle_id": 0, "tx_hash": "H" * 44}
        bad = [
            self._claim_tx(status={"Failure": {"error": "x"}}),
            self._claim_tx(receipts_outcome=[{"outcome": {
                "status": {"SuccessValue": ""},
                "logs": ["payout_restored_register_and_retry"]}}]),
        ]
        other = self._claim_tx()
        other["transaction"]["signer_id"] = "mallory.near"
        bad.append(other)
        other = self._claim_tx()
        other["transaction"]["actions"][0]["FunctionCall"][
            "method_name"] = "buy"
        bad.append(other)
        with patch("api.chainmod.rpc_view",
                   side_effect=self._creator_views(payout="500")):
            for tx in bad:
                with patch("api.chainmod.tx_status", return_value=tx):
                    code, _ = self._req(
                        "POST", "/creators/c.near/claims", body)
                    self.assertEqual(code, 400)
            code, _ = self._req("POST", "/creators/c.near/claims",
                                {"product_id": 21, "cycle_id": 0,
                                 "tx_hash": "!!!not-a-hash!!!"})
            self.assertEqual(code, 400)
            code, _ = self._req("POST", "/creators/c.near/claims",
                                {"product_id": 21})
            self.assertEqual(code, 400)


if __name__ == "__main__":
    unittest.main()
