"""Off-chain verifier: checks posts, submits attestations + liveness.

Reads chain views over RPC, applies backend.md §4.1 rules against the
(simulated) social layer, records checks in SQLite, and — with --submit —
calls attest_post / confirm_liveness through the near CLI (keys stay in
the operator keychain). Stdlib only.

Usage:
    python3 verifier.py --once [--submit] [--contract launchlyv5-1105.testnet]
    python3 verifier.py --interval 60 --submit
"""

import argparse
import hashlib
import json
import os
import sys
import urllib.request

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import chain as chainmod
from store import Store
from social_sim import SocialSim

DEFAULT_MIN_AGE_DAYS = 7
LIVENESS_BATCH = 500


def normalize_symbol(symbol) -> str | None:
    """Uppercase A-Z0-9, 2-10 chars — else None ('no valid tag')."""
    s = (symbol or "").upper()
    if 2 <= len(s) <= 10 and all(c.isascii() and (c.isdigit() or
                                                     "A" <= c <= "Z")
                                 for c in s):
        return s
    return None


def score_content(content, has_link, has_tag) -> int:
    """Documented heuristic: base 50 + link 15 + tag 15 + length up to 20."""
    score = 50
    if has_link:
        score += 15
    if has_tag:
        score += 15
    score += min(20, len(content) // 14)
    return min(100, score)


def agent_bonus(content, product, rules, agent_url, timeout=20):
    """Ask the agent service for a 0..10 quality bonus.

    Returns (bonus, detail). Never raises: any failure (down, slow, bad
    shape) means (0, reason) and the rules score stands alone.
    """
    payload = {"content": content,
               "product": {"name": product.get("name"),
                           "symbol": product.get("symbol"),
                           "tagline": product.get("description", "")[:120]},
               "rules": {"required_link": rules.get("required_link"),
                         "required_tag": rules.get("required_tag")}}
    try:
        req = urllib.request.Request(
            agent_url.rstrip("/") + "/score",
            data=json.dumps(payload).encode(),
            headers={"Content-Type": "application/json"})
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            body = json.loads(resp.read().decode())
        bonus = int(body.get("bonus", 0))
        detail = str(body.get("reason", ""))[:120]
        tag = ("mock" if body.get("mock")
               else "fallback" if body.get("fallback") else "model")
        return max(0, min(10, bonus)), f"{tag}: {detail}"
    except Exception as e:
        return 0, f"unreachable ({type(e).__name__})"


def check_post(product, rules, post, social, agent=None):
    """Pure rule evaluation. Returns dict(valid, score, post_hash, reason,
    simulated). `product` is the chain Product; `rules` the backend rules
    JSON (may be {} for on-chain-no-metadata products).

    `agent` is an optional (content, product, rules) -> (bonus, detail)
    callable (see agent_bonus). It only ever ADDS up to 10 points to an
    already-valid post; it can never flip validity.
    """
    handle = post.get("linked_account", "")
    fetched = social.fetch_post("x", handle, post.get("url", ""))
    if not fetched:
        # Chain rejects empty post_hash ("bad post hash"), so anchor a
        # deterministic placeholder even for unfetchable content.
        placeholder = hashlib.sha256(
            ("missing:" + post.get("url", "")).encode()).hexdigest()
        return {"valid": False, "score": 0, "post_hash": placeholder,
                "reason": "social record not found", "simulated": True}
    content = fetched["content"]
    post_hash = hashlib.sha256(content.encode()).hexdigest()
    required_link = rules.get("required_link") or product.get("demo_url", "")
    norm = normalize_symbol(product.get("symbol", ""))
    required_tag = rules.get("required_tag") or (
        f"#{norm}" if norm else None)
    has_link = bool(required_link) and required_link in content
    has_tag = bool(required_tag) and required_tag in content
    tag_skipped = required_tag is None
    if not has_link and not has_tag:
        return {"valid": False, "score": 0, "post_hash": post_hash,
                "reason": "missing required product link or tag"
                + (" (no valid tag for symbol)" if tag_skipped else ""),
                "simulated": True}
    min_age = int(rules.get("min_account_age_days",
                            DEFAULT_MIN_AGE_DAYS))
    if fetched["account_age_days"] < min_age:
        return {"valid": False, "score": 0, "post_hash": post_hash,
                "reason": f"account age {fetched['account_age_days']}d < "
                f"{min_age}d minimum", "simulated": True}
    rules_score = score_content(content, has_link, has_tag)
    reason = "ok"
    if agent is not None:
        try:
            bonus, detail = agent(content, product, rules)
            bonus = max(0, min(10, int(bonus)))
        except Exception:
            bonus, detail = 0, "agent error"
        rules_score = min(100, rules_score + bonus)
        reason = f"ok; agent +{bonus}/10 ({detail})"
    return {"valid": True, "score": rules_score,
            "post_hash": post_hash, "reason": reason, "simulated": True}


class Verifier:
    def __init__(self, store, contract_id, rpc_url, signer, network,
                 social=None, submit=False, agent_url=None,
                 agent_timeout=90):
        self.store = store
        self.contract_id = contract_id
        self.rpc_url = rpc_url
        self.signer = signer
        self.network = network
        self.social = social or SocialSim()
        self.submit = submit
        self.actions = []
        self.agent = None
        if agent_url:
            self.agent = lambda c, p, r: agent_bonus(
                c, p, r, agent_url, agent_timeout)

    def _view(self, method, args):
        return chainmod.rpc_view(self.rpc_url, self.contract_id, method,
                                 args)

    def run_once(self):
        self.actions = []
        for row in self.store.list_cached_products():
            try:
                self._verify_product(row)
            except chainmod.ChainError as e:
                # One sick product must not abort the whole pass.
                self.actions.append({"op": "error",
                                     "product_id": row["product_id"],
                                     "error": str(e)})
        return self.actions

    def _product_rules(self, row):
        if row["draft_id"]:
            d = self.store.get_draft(row["draft_id"])
            if d:
                return json.loads(d["rules_json"] or "{}")
        return {}

    def _verify_product(self, row):
        pid = row["product_id"]
        product = self._view("get_product", {"product_id": pid})
        if not product or product.get("status") != "Live":
            return
        rules = self._product_rules(row)
        cycle_id = product["cycle_id"]
        posts = self._view("list_cycle_posts",
                           {"product_id": pid, "cycle_id": cycle_id})
        # Mirror the chain's per-creator cap (attest_post counts approved
        # posts per creator and rejects valid attests past it). Pre-check
        # here so we submit valid=false instead of a doomed tx.
        cap = int(product.get("max_posts_per_creator") or 255)
        approved = {}
        for post in posts:
            if post.get("attested") and post.get("approved"):
                creator = post.get("creator", "")
                approved[creator] = approved.get(creator, 0) + 1
        to_confirm = []
        for post in posts:
            if post.get("attested"):
                if (post.get("approved")
                        and not post.get("live_confirmed")):
                    to_confirm.append(post)
                continue
            self._check_and_attest(pid, cycle_id, product, rules, post,
                                   cap, approved)
        self._confirm_liveness(pid, cycle_id, to_confirm)

    def _check_and_attest(self, pid, cycle_id, product, rules, post,
                          cap, approved):
        post_id = post["post_id"]
        result = check_post(product, rules, post, self.social,
                            agent=self.agent)
        if result["valid"] and self.store.seen_content_hash_other(
                pid, result["post_hash"], post_id):
            result = dict(result, valid=False, score=0,
                          reason="duplicate content hash for this product")
        if result["valid"]:
            creator = post.get("creator", "")
            if approved.get(creator, 0) >= cap:
                result = dict(
                    result, valid=False, score=0,
                    reason=f"creator cap reached (pre-check: "
                    f"{approved.get(creator, 0)} approved, cap {cap})")
            else:
                approved[creator] = approved.get(creator, 0) + 1
        self.store.record_post_check(
            post_id, pid, cycle_id, post.get("creator", ""),
            result["post_hash"], result["valid"], result["score"],
            result["reason"], simulated=True)
        if result["valid"]:
            self.store.add_content_hash(pid, result["post_hash"], post_id)
        self.actions.append({"op": "check", "post_id": post_id, **result})
        if self.submit:
            chainmod.cli_tx(
                self.contract_id, self.signer, "attest_post",
                {"post_id": post_id, "valid": result["valid"],
                 "score": result["score"], "post_hash": result["post_hash"]},
                network=self.network)
            self.actions.append({"op": "attest_post", "post_id": post_id})

    def _confirm_liveness(self, pid, cycle_id, posts):
        confirmations = []
        for post in posts:
            fetched = self.social.fetch_post(
                "x", post.get("linked_account", ""), post.get("url", ""))
            alive = bool(fetched and fetched["alive"])
            confirmations.append({"post_id": post["post_id"], "live": alive})
        for i in range(0, len(confirmations), LIVENESS_BATCH):
            batch = confirmations[i:i + LIVENESS_BATCH]
            self.actions.append({"op": "liveness", "count": len(batch)})
            if self.submit:
                chainmod.cli_tx(
                    self.contract_id, self.signer, "confirm_liveness",
                    {"product_id": pid, "cycle_id": cycle_id,
                     "confirmations": batch},
                    network=self.network)


def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument("--once", action="store_true")
    ap.add_argument("--interval", type=int, default=0)
    ap.add_argument("--submit", action="store_true")
    ap.add_argument("--contract", default="launchlyv5-1105.testnet")
    ap.add_argument("--db", default="intents.db")
    ap.add_argument("--account", default=os.environ.get("VERIFIER_ACCOUNT",
                                                        ""))
    ap.add_argument("--network", default="testnet")
    ap.add_argument("--rpc", default=chainmod.TESTNET_RPC)
    ap.add_argument("--agent-url", default=os.environ.get("AGENT_URL", ""),
                    help="scoring agent base URL (unset = rules-only)")
    ap.add_argument("--fixtures", default=None,
                    help="social fixture JSON (default: package file)")
    ap.add_argument("--agent-timeout", type=int, default=90,
                    help="agent seconds per post (loop can take a while)")
    args = ap.parse_args(argv)
    if args.submit and not args.account:
        ap.error("--submit needs --account or VERIFIER_ACCOUNT")
    store = Store(args.db)
    social = None
    if args.fixtures:
        with open(args.fixtures) as f:
            social = SocialSim(json.load(f))
    v = Verifier(store, args.contract, args.rpc, args.account,
                 args.network, social=social, submit=args.submit,
                 agent_url=args.agent_url or None,
                 agent_timeout=args.agent_timeout)
    import time
    while True:
        try:
            actions = v.run_once()
        except Exception as e:  # daemon mode survives transient failure
            print(f"verifier pass failed: {e}", file=sys.stderr)
            if not args.interval:
                return 1
            time.sleep(args.interval)
            continue
        for action in actions:
            print(json.dumps(action))
        if not args.interval:
            break
        time.sleep(args.interval)
    return 0


if __name__ == "__main__":
    sys.exit(main())
