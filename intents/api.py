"""JSON API over the backend. Stdlib http.server only.

Read routes are open (local demo); operator routes need
`Authorization: Bearer $OPERATOR_TOKEN`; draft routes need the draft's
`edit_token` (X-Edit-Token header or body field). Refuses to start with
a missing/default operator token.

Config is env-only, see .env.example. No keys here: writes happen via
the near CLI on the operator's machine, never from this process.
"""

import base64
import json
import mimetypes
import os
import re
from concurrent.futures import ThreadPoolExecutor
from http.server import BaseHTTPRequestHandler, HTTPServer
from urllib.parse import urlparse, parse_qs

import chain as chainmod
import flows as flowsmod
import keeper as keepermod
import relay as relaymod
from adapter import OneClickClient, OneClickError
from products import Products, DraftError
from store import Store
from sync import sync_products, product_feed
from verifier import Verifier

DEFAULT_TOKEN = "change-me"


class ApiError(Exception):
    def __init__(self, status, message):
        super().__init__(message)
        self.status = status


def load_config(env=None):
    env = env if env is not None else os.environ
    token = env.get("OPERATOR_TOKEN", "")
    if not token or token == DEFAULT_TOKEN:
        raise ApiError(500, "set OPERATOR_TOKEN to a random value "
                            "(see .env.example); refusing to start")
    return {
        "operator_token": token,
        "db": env.get("BACKEND_DB", "intents.db"),
        "port": int(env.get("PORT", "8090")),
        "contract": env.get("LAUNCHLY_CONTRACT", ""),
        "rpc": env.get("NEAR_RPC", chainmod.TESTNET_RPC),
        "network": env.get("NEAR_NETWORK", "testnet"),
        "upload_dir": env.get("UPLOAD_DIR", "./uploads"),
        "oneclick_base": env.get("ONECLICK_BASE",
                                 "https://1click.chaindefuser.com"),
        "oneclick_jwt": env.get("ONECLICK_JWT", ""),
    }


class Handler(BaseHTTPRequestHandler):
    server_version = "launchly-backend/1.0"

    # -- plumbing ----------------------------------------------------
    def log_message(self, *a):
        pass

    def _send(self, obj, status=200, raw=None, ctype="application/json"):
        body = raw if raw is not None else json.dumps(obj).encode()
        self.send_response(status)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        self.wfile.write(body)

    def _err(self, status, message):
        self._send({"error": message}, status=status)

    def _body_json(self):
        try:
            length = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            length = 0
        if not length:
            return {}
        try:
            return json.loads(self.rfile.read(length).decode())
        except (ValueError, UnicodeDecodeError):
            raise ApiError(400, "invalid JSON body")

    def _body_raw(self):
        try:
            length = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            length = 0
        return self.rfile.read(length) if length else b""

    def _cfg(self):
        return self.server.cfg

    def _require_operator(self):
        want = "Bearer " + self._cfg()["operator_token"]
        if self.headers.get("Authorization", "") != want:
            raise ApiError(401, "operator auth required")

    def _edit_token(self, body):
        return (self.headers.get("X-Edit-Token", "")
                or body.get("edit_token", ""))

    @staticmethod
    def _int(value, name):
        try:
            return int(value)
        except (TypeError, ValueError):
            raise ApiError(400, f"bad {name}: {value!r}")

    # -- routing -----------------------------------------------------
    def do_GET(self):
        self._route()

    def do_POST(self):
        self._route()

    def do_PUT(self):
        self._route()

    def do_OPTIONS(self):
        self.send_response(204)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods",
                         "GET, POST, PUT, OPTIONS")
        self.send_header("Access-Control-Allow-Headers",
                         "Authorization, Content-Type, X-Edit-Token")
        self.end_headers()

    def _route(self):
        url = urlparse(self.path)
        path, qs = url.path, parse_qs(url.query)
        method = self.command
        # Per-request connections: sqlite handles are thread-bound and the
        # server runs in its own thread.
        self._req_store = Store(self._cfg()["db"])
        self._req_products = Products(self._req_store,
                                      self._cfg()["upload_dir"])
        try:
            m = re.fullmatch(r"/products/drafts/([^/]+)/assets/([^/]+)",
                             path)
            if m and method == "PUT":
                return self._send(self._draft_asset(m.group(1), m.group(2)))
            body = self._body_json() if method in ("POST", "PUT") else {}
            if method == "GET" and path == "/health":
                return self._send(self._health())
            if method == "GET" and path == "/assets":
                return self._send(self._assets(qs))
            m = re.fullmatch(r"/assets/([0-9a-f]{64})", path)
            if method == "GET" and m:
                return self._serve_asset(m.group(1))
            if method == "POST" and path == "/quotes/payin":
                return self._send(self._quote_payin(body))
            if method == "POST" and path == "/quotes/payout":
                return self._send(self._quote_payout(body))
            if method == "GET" and path == "/swaps":
                return self._send(self._swap(qs))
            if method == "GET" and path == "/verifier/posts":
                return self._send(self._verifier_posts(qs))
            if method == "POST" and path == "/verifier/run-once":
                return self._send(self._verifier_run())
            if method == "GET" and path == "/keeper/status":
                return self._send(self._keeper_status(qs))
            if method == "POST" and path == "/keeper/run-once":
                return self._send(self._keeper_run())
            if method == "POST" and path == "/products/drafts":
                return self._send(self._draft_create(body), status=201)
            m = re.fullmatch(r"/products/drafts/([^/]+)", path)
            if m and method in ("GET", "PUT"):
                did = m.group(1)
                if method == "GET":
                    return self._send(self._draft_get(did, body))
                return self._send(self._draft_put(did, body))
            m = re.fullmatch(r"/products/drafts/([^/]+)/finalize", path)
            if m and method == "POST":
                return self._send(self._draft_finalize(m.group(1), body))
            m = re.fullmatch(r"/products/drafts/([^/]+)/status", path)
            if m and method == "GET":
                return self._send(self._draft_status(m.group(1)))
            if method == "POST" and path == "/relay":
                return self._send(self._relay(body))
            m = re.fullmatch(r"/operator/relay/log", path)
            if m and method == "GET":
                return self._send(self._relay_log(qs))
            if method == "GET" and path == "/tokens":
                return self._send(self._tokens(qs))
            m = re.fullmatch(r"/tokens/([^/]+)/balance", path)
            if m and method == "GET":
                return self._send(self._token_balance(m.group(1), qs))
            m = re.fullmatch(r"/tokens/([^/]+)/chart", path)
            if m and method == "GET":
                return self._send(self._token_chart(m.group(1), qs))
            m = re.fullmatch(r"/tokens/([^/]+)", path)
            if m and method == "GET":
                return self._send(self._token_detail(m.group(1)))
            m = re.fullmatch(r"/products/(\d+)/posts", path)
            if m and method == "GET":
                return self._send(self._chain_posts(int(m.group(1)), qs))
            m = re.fullmatch(r"/posts/(\d+)", path)
            if m and method == "GET":
                return self._send(self._post(int(m.group(1))))
            if method == "POST" and path == "/posts/validate":
                return self._send(self._validate_post(body))
            m = re.fullmatch(r"/products/(\d+)/votes", path)
            if m and method == "GET":
                return self._send(self._votes(int(m.group(1)), qs))
            m = re.fullmatch(r"/creators/([^/]+)/posts", path)
            if m and method == "GET":
                return self._send(self._creator_posts(m.group(1)))
            m = re.fullmatch(r"/creators/([^/]+)/earnings", path)
            if m and method == "GET":
                return self._send(self._creator_earnings(m.group(1)))
            m = re.fullmatch(r"/creators/([^/]+)/claims", path)
            if m and method == "POST":
                return self._send(self._claim_report(m.group(1), body))
            if method == "GET" and path == "/products":
                return self._send(self._feed(qs))
            m = re.fullmatch(r"/products/(\d+)", path)
            if m and method == "GET":
                return self._send(self._product(int(m.group(1))))
            m = re.fullmatch(r"/products/(\d+)/(metadata|rules)", path)
            if m and method == "GET":
                return self._send(self._product_doc(int(m.group(1)),
                                                    m.group(2)))
            m = re.fullmatch(r"/products/(\d+)/quote", path)
            if m and method == "GET":
                return self._send(self._quote(int(m.group(1)), qs))
            m = re.fullmatch(r"/products/(\d+)/milestones", path)
            if m and method == "GET":
                return self._send(self._milestones(int(m.group(1))))
            if m and method == "POST":
                return self._send(self._milestone_add(int(m.group(1)),
                                                      body), status=201)
            m = re.fullmatch(
                r"/creators/([^/]+)/payout-preference", path)
            if m and method == "PUT":
                return self._send(self._payout_pref(m.group(1), body))
            m = re.fullmatch(r"/creators/([^/]+)/social-link", path)
            if m and method == "POST":
                return self._send(self._social_link(m.group(1), body))
            m = re.fullmatch(r"/creators/([^/]+)", path)
            if m and method == "GET":
                return self._send(self._creator(m.group(1)))
            m = re.fullmatch(r"/operator/products/(\d+)/flag", path)
            if m and method == "POST":
                return self._send(self._flag(int(m.group(1)), body))
            return self._err(404, "no such route")
        except ApiError as e:
            return self._err(e.status, str(e))
        except DraftError as e:
            msg = str(e)
            if msg == "unknown draft":
                return self._err(404, msg)
            if msg == "bad edit token":
                return self._err(403, msg)
            return self._err(400, msg)
        finally:
            self._req_store.close()

    # -- handlers ----------------------------------------------------
    def _health(self):
        cfg = self._cfg()
        return {"ok": True, "network": cfg["network"],
                "contract": cfg["contract"] or None,
                "oneclick_base": cfg["oneclick_base"],
                "simulated": {"social": True, "classifier": "stretch"}}

    def _assets(self, qs):
        client = self.server.oneclick()
        sym = (qs.get("symbol", [None])[0] or None)
        chain = (qs.get("blockchain", [None])[0] or None)
        try:
            if sym or chain:
                try:
                    found = client.find_asset(symbol=sym, blockchain=chain)
                except OneClickError as e:
                    if "asset not found" in str(e):
                        return {"assets": []}
                    raise
                return {"assets": [found]}
            return {"assets": client.tokens()}
        except OneClickError as e:
            raise ApiError(502, f"1click upstream: {e}")

    def _serve_asset(self, digest):
        row = self._req_store.get_asset(digest)
        if not row:
            raise ApiError(404, "unknown asset")
        found = self._req_products.get_asset_path(digest)
        if not found:
            raise ApiError(404, "asset file missing")
        path, mime = found
        with open(path, "rb") as f:
            data = f.read()
        ctype = mime or mimetypes.guess_type(path)[0] or \
            "application/octet-stream"
        self._send(None, raw=data, ctype=ctype)

    def _quote_payin(self, body):
        cfg = self._cfg()
        for k in ("origin_asset_id", "origin_amount", "reserve_asset_id"):
            if not body.get(k):
                raise ApiError(400, f"missing {k}")
        return flowsmod.dry_payin(
            self._req_store, self.server.oneclick(),
            body["origin_asset_id"], body["origin_amount"],
            body.get("launchly_account") or cfg["contract"],
            body["reserve_asset_id"], body.get("refund_to"))

    def _quote_payout(self, body):
        cfg = self._cfg()
        for k in ("reserve_asset_id", "reserve_amount", "dest_asset_id",
                  "dest_address"):
            if not body.get(k):
                raise ApiError(400, f"missing {k}")
        return flowsmod.dry_payout(
            self._req_store, self.server.oneclick(),
            body["reserve_asset_id"], body["reserve_amount"],
            body["dest_asset_id"], body["dest_address"],
            body.get("launchly_account") or cfg["contract"])

    def _swap(self, qs):
        addr = (qs.get("depositAddress", [None])[0]
                or qs.get("deposit_address", [None])[0])
        if not addr:
            raise ApiError(400, "missing depositAddress")
        row = self._req_store.get_swap(addr)
        if not row:
            raise ApiError(404, "unknown swap")
        return row

    def _verifier_posts(self, qs):
        pid = (qs.get("product_id", [None])[0] or None)
        cid = (qs.get("cycle_id", [None])[0] or None)
        sql = "SELECT * FROM post_checks WHERE 1=1"
        args = []
        if pid is not None:
            sql += " AND product_id = ?"
            args.append(self._int(pid, "product_id"))
        if cid is not None:
            sql += " AND cycle_id = ?"
            args.append(self._int(cid, "cycle_id"))
        return {"posts": self._req_store._all(sql, tuple(args))}

    def _verifier_run(self):
        self._require_operator()
        cfg = self._cfg()
        v = Verifier(self._req_store, cfg["contract"], cfg["rpc"],
                     "api-operator", cfg["network"], submit=False)
        return {"actions": v.run_once(), "submitted": False}

    def _keeper_status(self, qs):
        pid = qs.get("product_id", [None])[0]
        if pid is None:
            raise ApiError(400, "missing product_id")
        cfg = self._cfg()
        return keepermod.snapshot(self._req_store, cfg["contract"],
                                  cfg["rpc"],
                                  self._int(pid, "product_id"))

    def _keeper_run(self):
        self._require_operator()
        cfg = self._cfg()
        return keepermod.reconcile(self._req_store, cfg["contract"],
                                   cfg["rpc"], cfg["network"])

    def _draft_create(self, body):
        return self._req_products.create_draft(
            body.get("founder_hint", ""))

    def _draft_get(self, did, body):
        return self._req_products.get_draft(did, self._edit_token(body))

    def _draft_put(self, did, body):
        self._req_products.update_draft(
            did, self._edit_token(body), body.get("metadata"),
            body.get("rules"))
        return {"ok": True}

    def _draft_finalize(self, did, body):
        return self._req_products.finalize(did, self._edit_token(body))

    def _draft_status(self, did):
        # status needs the token too; GET has no body, use header only
        tok = self.headers.get("X-Edit-Token", "")
        return {"status": self._req_products.draft_status(did, tok)}

    def _draft_asset(self, did, kind):
        tok = self.headers.get("X-Edit-Token", "")
        data = self._body_raw()
        return self._req_products.put_asset(did, tok, kind, data)

    def _feed(self, qs):
        items = product_feed(self._req_store)
        cat = (qs.get("category", [None])[0] or None)
        if cat:
            items = [i for i in items
                     if (i.get("metadata") or {}).get("category") == cat]
        if (qs.get("sort", [""])[0]) == "-id":
            items = sorted(items, key=lambda i: i["product_id"],
                           reverse=True)
        return {"products": items}

    def _product(self, pid):
        for i in product_feed(self._req_store):
            if i["product_id"] == pid:
                return i
        raise ApiError(404, "unknown product")

    def _product_doc(self, pid, which):
        row = self._req_store.get_cached_product(pid)
        if not row or not row.get("draft_id"):
            raise ApiError(404, "no metadata bound")
        d = self._req_store.get_draft(row["draft_id"])
        if not d:
            raise ApiError(404, "draft missing")
        key = "metadata_json" if which == "metadata" else "rules_json"
        return json.loads(d.get(key) or "{}")

    def _milestones(self, pid):
        return {"milestones": self._req_store.list_milestones(pid)}

    def _token_entry(self, cfg, pid):
        """Live token facts for one product. Raises ApiError."""
        try:
            p = chainmod.rpc_view(cfg["rpc"], cfg["contract"],
                                  "get_product", {"product_id": pid})
        except chainmod.ChainError as e:
            raise ApiError(502, f"chain unavailable: {e}")
        if not p:
            raise ApiError(404, "unknown product")
        token = p.get("token_account")
        if not token:
            raise ApiError(409, "product has no token yet (not launched)")
        try:
            supply = chainmod.rpc_view(cfg["rpc"], token,
                                       "ft_total_supply", {})
            unit = str(10 ** int(p.get("reserve_decimals", 6)))
            quote = chainmod.rpc_view(
                cfg["rpc"], cfg["contract"], "get_buy_quote",
                {"product_id": pid, "reserve_in": unit})
        except chainmod.ChainError as e:
            raise ApiError(502, f"token view failed: {e}")
        return {"product_id": pid, "token_account": token,
                "name": p.get("name"), "symbol": p.get("symbol"),
                "status": p.get("status"),
                "total_supply": supply,
                "tokens_per_unit": quote[0],
                "tokens_per_unit_note": "buy 1.0 reserve, fee-inclusive",
                "curve_sold": p.get("curve_sold"),
                "curve_reserve": p.get("curve_reserve"),
                "reserve_token": p.get("reserve_token")}

    def _pid_for_token(self, token):
        for row in self._req_store.list_cached_products():
            if row.get("token_account") == token:
                return row["product_id"]
        return None

    def _tokens(self, qs):
        cfg = self._cfg()
        pid = qs.get("product_id", [None])[0]
        if pid is not None:
            return {"tokens": [self._token_entry(cfg, self._int(pid, "product_id"))]}
        out = []
        for row in self._req_store.list_cached_products():
            try:
                out.append(self._token_entry(cfg, row["product_id"]))
            except ApiError as e:
                out.append({"product_id": row["product_id"],
                            "error": str(e)})
        return {"tokens": out,
                "note": "run keeper reconcile first to refresh the cache"}

    def _token_detail(self, token):
        pid = self._pid_for_token(token)
        if pid is None:
            raise ApiError(404, "unknown token (run keeper reconcile)")
        return self._token_entry(self._cfg(), pid)

    def _token_balance(self, token, qs):
        holder = (qs.get("holder", [""])[0] or "")
        if not (2 <= len(holder) <= 64):
            raise ApiError(400, "holder query param required")
        if self._pid_for_token(token) is None:
            raise ApiError(404, "unknown token (run keeper reconcile)")
        try:
            bal = chainmod.rpc_view(self._cfg()["rpc"], token,
                                    "ft_balance_of",
                                    {"account_id": holder})
        except chainmod.ChainError as e:
            raise ApiError(502, f"balance view failed: {e}")
        return {"token_account": token, "holder": holder, "balance": bal}

    def _token_chart(self, token, qs):
        since = (qs.get("from", [None])[0] or None)
        until = (qs.get("to", [None])[0] or None)
        resolution = (qs.get("resolution", ["raw"])[0] or "raw")
        if resolution not in ("raw", "hour", "day"):
            raise ApiError(400, "resolution must be raw|hour|day")
        rows = self._req_store.list_snapshots(token, since, until)
        if resolution != "raw":
            width = 13 if resolution == "hour" else 10
            bucketed = {}
            for r in rows:
                bucketed[r["taken_at"][:width]] = r
            rows = [bucketed[k] for k in sorted(bucketed)]
        points = [{"t": r["taken_at"],
                   "tokens_per_unit": r["tokens_per_unit"],
                   "reserve": r["reserve"], "sold": r["sold"],
                   "supply": r["supply"]} for r in rows]
        return {"token_account": token, "resolution": resolution,
                "count": len(points), "points": points,
                "note": "snapshots start at keeper adoption; no backfill"}

    def _quote(self, pid, qs):
        cfg = self._cfg()
        side = (qs.get("side", [""])[0] or "").lower()
        if side not in ("buy", "sell"):
            raise ApiError(400, "side must be buy or sell")
        amount = (qs.get("amount", [""])[0] or "")
        if not amount.isdigit():
            raise ApiError(400, "amount must be base-unit digits")
        try:
            product = chainmod.rpc_view(cfg["rpc"], cfg["contract"],
                                        "get_product", {"product_id": pid})
        except chainmod.ChainError as e:
            raise ApiError(502, f"chain unavailable: {e}")
        if not product:
            raise ApiError(404, "unknown product")
        method = "get_buy_quote" if side == "buy" else "get_sell_quote"
        arg = "reserve_in" if side == "buy" else "tokens_in"
        try:
            out = chainmod.rpc_view(cfg["rpc"], cfg["contract"], method,
                                    {"product_id": pid, arg: amount})
        except chainmod.ChainError as e:
            raise ApiError(502, f"quote failed: {e}")
        labeled = ({"tokens_out": out[0], "cost": out[1], "fee": out[2]}
                   if side == "buy"
                   else {"net_proceeds": out[0], "fee": out[1]})
        return {"product_id": pid, "side": side, "amount_in": amount,
                **labeled}

    def _milestone_add(self, pid, body):
        # v1: operator-gated (founder binding is a stretch); content is
        # hash-anchored via draft_milestone's evidence_hash.
        self._require_operator()
        content = body.get("content", body)
        return self._req_products.draft_milestone(pid, content)

    def _payout_pref(self, account, body):
        self._req_products.set_payout_preference(
            account, body.get("asset"), body.get("chain"),
            body.get("address"))
        return {"ok": True}

    def _social_link(self, account, body):
        if not body.get("platform") or not body.get("handle"):
            raise ApiError(400, "platform and handle required")
        return self._req_products.link_social(
            account, body["platform"], body["handle"])

    def _creator(self, account):
        return self._req_products.get_creator(account)

    def _chain_product(self, pid):
        cfg = self._cfg()
        try:
            p = chainmod.rpc_view(cfg["rpc"], cfg["contract"],
                                  "get_product", {"product_id": pid})
        except chainmod.ChainError as e:
            raise ApiError(502, f"chain unavailable: {e}")
        if not p:
            raise ApiError(404, "unknown product")
        return p

    def _post_with_check(self, post):
        check = self._req_store.get_post_check(post.get("post_id", -1))
        return {"post": post, "check": check}

    def _chain_posts(self, pid, qs):
        cfg = self._cfg()
        p = self._chain_product(pid)
        cid = qs.get("cycle_id", [None])[0]
        cycle = self._int(cid, "cycle_id") if cid is not None else p.get("cycle_id", 0)
        try:
            posts = chainmod.rpc_view(
                cfg["rpc"], cfg["contract"], "list_cycle_posts",
                {"product_id": pid, "cycle_id": cycle})
        except chainmod.ChainError as e:
            raise ApiError(502, f"posts view failed: {e}")
        return {"product_id": pid, "cycle_id": cycle,
                "posts": [self._post_with_check(x) for x in posts]}

    def _post(self, post_id):
        cfg = self._cfg()
        try:
            post = chainmod.rpc_view(cfg["rpc"], cfg["contract"],
                                     "get_post", {"post_id": post_id})
        except chainmod.ChainError as e:
            raise ApiError(502, f"post view failed: {e}")
        if not post:
            raise ApiError(404, "unknown post")
        return self._post_with_check(post)

    def _validate_post(self, body):
        import time
        pid = body.get("product_id")
        url = body.get("url", "")
        handle = body.get("handle", "")
        if not isinstance(pid, int) or isinstance(pid, bool):
            raise ApiError(400, "product_id (int) required")
        errs = []
        if not (isinstance(url, str) and url.startswith("https://")
                and 8 <= len(url) <= 500):
            errs.append("url must be https, 8-500 chars")
        if not (isinstance(handle, str) and 2 <= len(handle) <= 128):
            errs.append("handle must be 2-128 chars")
        if errs:
            return {"ok": False, "errors": errs}
        p = self._chain_product(pid)
        if p.get("status") != "Live":
            errs.append("product is not Live")
        if p.get("cycle_end_ns", 0) <= time.time_ns():
            errs.append("cycle is over, wait for the next one")
        if not errs:
            posts = self._chain_posts(pid, {})["posts"]
            if any(x["post"].get("url") == url for x in posts):
                errs.append("URL already submitted for this product")
        if errs:
            return {"ok": False, "errors": errs}
        return {"ok": True, "errors": [],
                "submit_args": {"product_id": pid, "url": url,
                                "linked_account": handle},
                "note": "submit from your own wallet: submit_post"}

    def _cycles_capped(self, current, cap=10):
        current = int(current or 0)
        return list(range(0, min(current + 1, cap))), current + 1 > cap

    def _map_views(self, calls, workers=10):
        """Run [(method, args)] view calls in parallel. A failed call
        yields None at its position (order preserved)."""
        cfg = self._cfg()

        def one(call):
            method, args = call
            try:
                return chainmod.rpc_view(cfg["rpc"], cfg["contract"],
                                         method, args)
            except chainmod.ChainError:
                return None

        with ThreadPoolExecutor(max_workers=workers) as ex:
            return list(ex.map(one, calls))

    def _cycle_pairs(self, rows):
        """[(product_id, cycle_id)] across cached products."""
        calls = [("get_product", {"product_id": r["product_id"]})
                 for r in rows]
        pairs, truncated = [], False
        for row, p in zip(rows, self._map_views(calls)):
            if not p:
                continue
            cycles, trunc = self._cycles_capped(p.get("cycle_id", 0))
            truncated = truncated or trunc
            pairs.extend((row["product_id"], cid) for cid in cycles)
        return pairs, truncated

    def _cycle_data(self, pairs):
        """{(pid, cid): {"pool": ..., "posts": ...}}, cache-first.

        Finalized cycles are immutable on-chain: pool + posts are cached
        forever and open cycles always hit RPC. All sqlite access stays
        on this thread (handles are thread-bound); only RPC fans out.
        """
        data, need = {}, []
        for pid, cid in pairs:
            row = self._req_store.get_cycle_cache(pid, cid)
            if row:
                data[(pid, cid)] = {
                    "pool": json.loads(row["pool_json"]),
                    "posts": json.loads(row["posts_json"])}
            else:
                need.append((pid, cid))
        if need:
            calls = []
            for pid, cid in need:
                calls.append(("get_pool",
                              {"product_id": pid, "cycle_id": cid}))
                calls.append(("list_cycle_posts",
                              {"product_id": pid, "cycle_id": cid}))
            res = self._map_views(calls)
            for i, (pid, cid) in enumerate(need):
                pool, posts = res[2 * i], res[2 * i + 1]
                if pool is None or posts is None:
                    continue
                if pool.get("finalized"):
                    self._req_store.put_cycle_cache(
                        pid, cid, json.dumps(pool), json.dumps(posts))
                data[(pid, cid)] = {"pool": pool, "posts": posts}
        return data

    def _creator_posts(self, account):
        pairs, truncated = self._cycle_pairs(
            self._req_store.list_cached_products())
        data = self._cycle_data(pairs)
        out = []
        for _, d in sorted(data.items()):
            for x in d["posts"]:
                if x.get("creator") == account:
                    out.append(self._post_with_check(x))
        out.sort(key=lambda e: e["post"].get("post_id", 0), reverse=True)
        return {"account": account, "posts": out, "truncated": truncated}

    def _creator_earnings(self, account):
        pairs, truncated = self._cycle_pairs(
            self._req_store.list_cached_products())
        data = self._cycle_data(pairs)
        payouts, need = {}, []
        for (pid, cid), d in data.items():
            if d["pool"].get("finalized"):
                hit = self._req_store.get_payout_cache(pid, cid, account)
                if hit is not None:
                    payouts[(pid, cid)] = hit
                    continue
            need.append((pid, cid))
        got = dict(zip(need, self._map_views(
            [("get_payout", {"product_id": pid, "cycle_id": cid,
                             "creator": account})
             for pid, cid in need])))
        out, total = [], 0
        for (pid, cid), d in sorted(data.items()):
            pool = d["pool"]
            payout = payouts.get((pid, cid), got.get((pid, cid)))
            if payout is None:
                continue
            if pool.get("finalized") and (pid, cid) not in payouts:
                self._req_store.put_payout_cache(pid, cid, account,
                                                 payout)
            total += int(payout or 0)
            claim = self._req_store.get_claim(pid, cid, account)
            out.append({"product_id": pid, "cycle_id": cid,
                        "payout": payout,
                        "finalized": bool(pool.get("finalized")),
                        "claimable_at_ns": pool.get("payout_available_ns"),
                        "claimed": claim is not None,
                        "claim_tx": claim["tx_hash"] if claim else None,
                        "claimed_at": (claim["claimed_at"]
                                       if claim else None)})
        return {"account": account, "earnings": out,
                "total_payout": str(total), "truncated": truncated,
                "note": "payout persists after claiming; see claimed"}

    TX_HASH_RE = re.compile(r"^[1-9A-HJ-NP-Za-km-z]{43,44}$")

    @staticmethod
    def _check_claim_tx(tx, contract, account, pid, cid):
        """Raise ApiError unless tx is exactly account's successful
        claim_payout(pid, cid) with no payout-restore log."""
        status = tx.get("status", {}) or {}
        if "Failure" in status:
            raise ApiError(400, "transaction failed on-chain")
        if not any(k in status
                   for k in ("SuccessValue", "SuccessReceiptId")):
            raise ApiError(400, "transaction not successfully executed")
        t = tx.get("transaction", {}) or {}
        if t.get("signer_id") != account:
            raise ApiError(400, "tx signer is not the creator")
        if t.get("receiver_id") != contract:
            raise ApiError(400, "tx receiver is not the launchly contract")
        calls = [a.get("FunctionCall", {}) for a in t.get("actions", [])]
        if len(calls) != 1 or \
                calls[0].get("method_name") != "claim_payout":
            raise ApiError(400, "tx is not a single claim_payout call")
        try:
            args = json.loads(base64.b64decode(
                calls[0].get("args", "")).decode())
        except (ValueError, UnicodeDecodeError):
            raise ApiError(400, "claim_payout args unreadable")
        if args.get("product_id") != pid or args.get("cycle_id") != cid:
            raise ApiError(400, "claim_payout args do not match")
        for r in tx.get("receipts_outcome", []) or []:
            oc = r.get("outcome", {}) or {}
            if "Failure" in (oc.get("status", {}) or {}):
                raise ApiError(400, "claim receipt failed on-chain")
            for log in oc.get("logs", []) or []:
                if "payout_restored_register_and_retry" in str(log):
                    raise ApiError(
                        400, "payout was restored (transfer failed);"
                             " retry the claim")

    def _claim_report(self, account, body):
        cfg = self._cfg()
        pid, cid = body.get("product_id"), body.get("cycle_id")
        tx_hash = body.get("tx_hash", "")
        if not isinstance(pid, int) or isinstance(pid, bool):
            raise ApiError(400, "product_id (int) required")
        if not isinstance(cid, int) or isinstance(cid, bool):
            raise ApiError(400, "cycle_id (int) required")
        if not isinstance(tx_hash, str) or \
                not self.TX_HASH_RE.match(tx_hash):
            raise ApiError(400, "tx_hash must be a base58 tx hash")
        try:
            tx = chainmod.tx_status(cfg["rpc"], tx_hash, account)
        except chainmod.ChainError as e:
            raise ApiError(502, f"tx lookup failed: {e}")
        self._check_claim_tx(tx, cfg["contract"], account, pid, cid)
        try:
            payout = chainmod.rpc_view(
                cfg["rpc"], cfg["contract"], "get_payout",
                {"product_id": pid, "cycle_id": cid, "creator": account})
        except chainmod.ChainError as e:
            raise ApiError(502, f"payout view failed: {e}")
        if int(payout or 0) <= 0:
            raise ApiError(400, "no payout for this account")
        self._req_store.record_claim(pid, cid, account, payout, tx_hash)
        claim = self._req_store.get_claim(pid, cid, account)
        return {"claimed": True, "product_id": pid, "cycle_id": cid,
                "account": account, "amount": claim["amount"],
                "tx_hash": claim["tx_hash"],
                "claimed_at": claim["claimed_at"]}

    def _votes(self, pid, qs):
        cfg = self._cfg()
        p = self._chain_product(pid)
        voter = (qs.get("voter", [""])[0] or "")
        out = []
        for index in range(int(p.get("next_milestone", 0))):
            try:
                ms = chainmod.rpc_view(cfg["rpc"], cfg["contract"],
                                       "get_milestone",
                                       {"product_id": pid, "index": index})
            except chainmod.ChainError as e:
                raise ApiError(502, f"milestone view failed: {e}")
            entry = {"milestone": ms, "vote_lock": None}
            if voter:
                try:
                    entry["vote_lock"] = chainmod.rpc_view(
                        cfg["rpc"], cfg["contract"], "get_vote_lock",
                        {"product_id": pid, "index": index,
                         "voter": voter})
                except chainmod.ChainError as e:
                    raise ApiError(502, f"vote view failed: {e}")
            out.append(entry)
        return {"product_id": pid, "milestones": out}

    def _flag(self, pid, body):
        self._require_operator()
        if not body.get("reason"):
            raise ApiError(400, "reason required")
        self._req_store.flag_product(pid, body["reason"])
        return {"ok": True}

    def _relay(self, body):
        # Open route (gasless founders have no other channel); safety is
        # the allowlist + quota + audit inside check_and_record, and
        # nothing is broadcast today (broadcast: pending-signer).
        import base64
        b64 = body.get("delegate", "")
        if not b64 or not isinstance(b64, str):
            raise ApiError(400, "delegate (base64) required")
        try:
            raw = base64.b64decode(b64)
        except Exception:
            raise ApiError(400, "delegate is not base64")
        if len(raw) > relaymod.MAX_DELEGATE_BYTES:
            raise ApiError(400, "delegate too large")
        cfg = self._cfg()
        return relaymod.check_and_record(
            self._req_store, cfg["contract"], raw, rpc_url=cfg["rpc"])

    def _relay_log(self, qs):
        self._require_operator()
        raw = (qs.get("limit", ["20"])[0] or "20")
        return {"entries": self._req_store.list_relay_log(
            self._int(raw, "limit"))}


def make_server(cfg, store=None, products=None, oneclick=None):
    store = store or Store(cfg["db"])
    products = products or Products(store, cfg["upload_dir"])
    server = HTTPServer(("127.0.0.1", cfg["port"]), Handler)
    server.cfg = cfg
    server.store = store
    server.products = products
    # OneClickClient reads ONECLICK_BASE/ONECLICK_JWT from env itself.
    server.oneclick = oneclick or OneClickClient
    return server


def main(argv=None):
    import argparse
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=None)
    args = ap.parse_args(argv)
    cfg = load_config()
    if args.port:
        cfg["port"] = args.port
    server = make_server(cfg)
    print(f"launchly backend on 127.0.0.1:{cfg['port']}", flush=True)
    server.serve_forever()


if __name__ == "__main__":
    main()
