"""Testnet role simulation: 5 real-product listings, founders, traders,
creators. Drives the real v5 contract + backend end to end.

Phases (state in --state file, completed phases skip on re-run):
  funds     sweep v3/v4 owner NEAR into v5 (testnet only)
  accounts  create 12 subaccounts (5 founders, 3 traders, 4 creators)
  drafts    backend drafts + finalize -> hashes for all 5 products
  launch    create_product + launch_coin per founder
  fund      USDT to traders (mint attempt, else buyer.v5 distribution)
  trade     buys, one sell, votes, snapshots between rounds
  posts     creator submit_post + backend attest + liveness
  close     short-cycle product: finalize + claim + milestone vote

Usage:
  python3 sim_demo.py --phase funds --state /tmp/sim.json
  python3 sim_demo.py --all --state /tmp/sim.json
"""

import argparse
import json
import os
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import chain as chainmod
from store import Store
from products import Products

V5 = "launchlyv5-1105.testnet"
USDT = "usdt.fakes.testnet"
RPC = chainmod.TESTNET_RPC

PRODUCTS = [
    {"name": "Zed", "symbol": "ZED",
     "tagline": "GPU-accelerated open-source code editor",
     "description": "Demo listing (not affiliated): Zed is a fast collaborative code editor written in Rust.",
     "demo_url": "https://zed.dev", "category": "devtools"},
    {"name": "Ruff", "symbol": "RUFF",
     "tagline": "Extremely fast Python linter and formatter",
     "description": "Demo listing (not affiliated): Ruff replaces Flake8, isort and more, by Astral.",
     "demo_url": "https://docs.astral.sh/ruff/", "category": "devtools"},
    {"name": "Warp", "symbol": "WARP",
     "tagline": "The terminal reimagined with AI",
     "description": "Demo listing (not affiliated): Warp is a modern terminal with AI and collaboration.",
     "demo_url": "https://www.warp.dev", "category": "devtools"},
    {"name": "Raycast", "symbol": "RCAST",
     "tagline": "Blazing-fast macOS launcher and commands",
     "description": "Demo listing (not affiliated): Raycast controls your workflow from one shortcut.",
     "demo_url": "https://www.raycast.com", "category": "productivity"},
    {"name": "Obsidian", "symbol": "OBSD",
     "tagline": "Markdown knowledge base on local files",
     "description": "Demo listing (not affiliated): Obsidian is a personal knowledge base for plain-text notes.",
     "demo_url": "https://obsidian.md", "category": "productivity"},
]

RULES = {"required_tag": "#LAUNCHLY", "min_account_age_days": 0,
         "max_counted_posts_per_creator": 5}

FOUNDERS = [f"founder{i}-sim-1106.testnet" for i in range(1, 6)]
TRADERS = ["trader1-sim-1106.testnet", "trader2-sim-1106.testnet",
           "trader3.founder5-sim-1106.testnet"]
CREATORS = [f"creator{i}.founder5-sim-1106.testnet" for i in range(1, 5)]
SUB_FUNDER = "founder5-sim-1106.testnet"

PHASES = ["funds", "accounts", "drafts", "launch", "fund",
          "trade", "posts", "close"]


TRANSIENT = ("expired", "timeout", "Timeout", "nonce", "TryAgain")


def tx(contract, signer, method, args, deposit="0 NEAR", gas="300 Tgas",
       retries=3):
    print(f"  TX {signer} -> {contract}.{method}", flush=True)
    last = None
    for attempt in range(retries):
        try:
            return chainmod.cli_tx(contract, signer, method, args,
                                   deposit=deposit, gas=gas,
                                   network="testnet")
        except Exception as e:
            last = e
            if any(t in str(e) for t in TRANSIENT) \
                    and attempt < retries - 1:
                print(f"  transient ({str(e)[:60]}), retry",
                      flush=True)
                time.sleep(5)
                continue
            raise
    raise last


def view(contract, method, args):
    return chainmod.rpc_view(RPC, contract, method, args)


def load_state(path):
    try:
        with open(path) as f:
            return json.load(f)
    except (OSError, ValueError):
        return {"done": [], "data": {}}


def save_state(path, state):
    with open(path, "w") as f:
        json.dump(state, f, indent=1)


# ---- phases ----

def ph_funds(state):
    # Obsolete: faucet funds all role accounts (10 NEAR each). The v5
    # owner keeps its own balance for verifier/gas use.
    print("  skip: faucet-funded roles", flush=True)


def ph_accounts(state):
    import subprocess
    plan = FOUNDERS + TRADERS + CREATORS
    for acct in plan:
        # existence check: view_account (RPC errors are HTTP 200!)
        import urllib.request
        p = {"jsonrpc": "2.0", "id": "x", "method": "query",
             "params": {"request_type": "view_account",
                       "finality": "final", "account_id": acct}}
        req = urllib.request.Request(
            RPC, data=json.dumps(p).encode(),
            headers={"Content-Type": "application/json"})
        try:
            body = json.load(urllib.request.urlopen(req, timeout=15))
        except Exception:
            body = {"error": "net"}
        if "error" not in body:
            print(f"  exists {acct}", flush=True)
            continue
        if acct.count(".") > 1:
            cmd = ["near", "account", "create-account", "fund-myself",
                   acct, "1 NEAR", "autogenerate-new-keypair",
                   "save-to-legacy-keychain", "sign-as", SUB_FUNDER,
                   "network-config", "testnet", "sign-with-keychain",
                   "send"]
            print(f"  subaccount {acct} via {SUB_FUNDER}", flush=True)
        else:
            cmd = ["near", "account", "create-account",
                   "sponsor-by-faucet-service", acct,
                   "autogenerate-new-keypair", "save-to-legacy-keychain",
                   "network-config", "testnet", "create"]
            print(f"  faucet {acct}", flush=True)
        r = subprocess.run(cmd, capture_output=True, text=True,
                           timeout=180)
        ok = False
        for _ in range(6):
            time.sleep(5)
            req = urllib.request.Request(
                RPC, data=json.dumps(p).encode(),
                headers={"Content-Type": "application/json"})
            try:
                body = json.load(urllib.request.urlopen(req, timeout=15))
            except Exception:
                continue
            if "error" not in body:
                ok = True
                break
        if not ok:
            raise RuntimeError(
                f"create {acct}: no on-chain account. "
                f"{(r.stdout + r.stderr)[-300:]}")


def _logo_png():
    # 1x1 PNG (magic bytes pass the uploader).
    import base64
    return base64.b64decode(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8"
        "/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==")


def ph_drafts(state, db_path):
    store = Store(db_path)
    prods = Products(store, "/tmp/sim-uploads")
    out = {}
    for i, meta in enumerate(PRODUCTS):
        founder = FOUNDERS[i]
        d = prods.create_draft(founder_hint=founder)
        m = dict(meta, problem="Discovery for great tools is broken.",
                 tags=["demo"], logo="pending")
        r = dict(RULES, required_link=meta["demo_url"],
                 required_tag="#" + meta["symbol"])
        prods.update_draft(d["draft_id"], d["edit_token"], m, r)
        asset = prods.put_asset(d["draft_id"], d["edit_token"], "logo",
                                _logo_png())
        m["logo"] = "sha256:" + asset["sha256"]
        prods.update_draft(d["draft_id"], d["edit_token"], m, r)
        fin = prods.finalize(d["draft_id"], d["edit_token"])
        out[founder] = {"draft_id": d["draft_id"],
                        "metadata_hash": fin["metadata_hash"],
                        "rules_hash": fin["rules_hash"],
                        "create_args": fin["create_args"]}
        print(f"  draft {meta['symbol']} {fin['metadata_hash'][:12]}...",
              flush=True)
    store.close()
    state["data"]["drafts"] = out


def _create_args(fin, founder):
    a = fin["create_args"]
    return {
        "name": a["name"], "symbol": a["symbol"],
        "description": a["description"], "demo_url": a["demo_url"],
        "metadata_hash": a["metadata_hash"], "rules_hash": a["rules_hash"],
        "reserve_token": USDT, "reserve_decimals": 6, "fee_bps": 100,
        "curve_p0": "100", "curve_rise": "1000000",
        "min_vote_holding": "1000", "max_posts_per_creator": 5,
        "cycle_duration_ns": 600_000_000_000,
        "dispute_duration_ns": 60_000_000_000,
        "milestone_window_ns": 60_000_000_000,
        "milestone_deadline_ns": 600_000_000_000,
    }


def ph_launch(state):
    drafts = state["data"]["drafts"]
    cost = view(V5, "get_launch_cost", {})
    pids = dict(state["data"].get("pids", {}))
    for i, founder in enumerate(FOUNDERS):
        if founder in pids:
            continue
        args = _create_args(drafts[founder], founder)
        # Resume: adopt an existing unlaunched product with our hashes.
        existing = None
        prods = view(V5, "list_products", {"from_index": 0, "limit": 100})
        for off, p in enumerate(prods):
            if (p.get("founder") == founder
                    and p.get("metadata_hash")
                    == drafts[founder]["metadata_hash"]):
                existing = (off + 1, p)
        skip_tx = False
        if existing and existing[1]["status"] != "Live":
            pid = existing[0]
            print(f"  resume unlaunched pid={pid}", flush=True)
            skip_tx = existing[1]["status"] == "Launching"
        elif existing:
            pid = existing[0]
            pids[founder] = {"product_id": pid,
                             "token": existing[1]["token_account"]}
            continue
        else:
            before = len(prods)
            tx(V5, founder, "create_product", args, deposit="0.05 NEAR")
            after = view(V5, "list_products",
                         {"from_index": 0, "limit": 100})
            pid = len(after)  # dense 1-based ids
            assert len(after) == before + 1, "create did not land"
        if not skip_tx:
            yocto = str(cost)
            tx(V5, founder, "launch_coin", {"product_id": pid},
               deposit=f"{yocto} yoctonear", gas="300 Tgas")
        p = None
        for i in range(30):
            time.sleep(4)
            p = view(V5, "get_product", {"product_id": pid})
            if p["status"] == "Live" and p["token_account"]:
                break
            if i == 5 and p["status"] == "Launching":
                print("  complete_launch retry", flush=True)
                tx(V5, founder, "complete_launch",
                   {"product_id": pid})
        assert p["status"] == "Live", p
        assert p["token_account"], "no token"
        pids[founder] = {"product_id": pid,
                         "token": p["token_account"]}
        print(f"  live {args['symbol']} pid={pid} {p['token_account']}",
              flush=True)
        state["data"]["pids"] = pids
    state["data"]["pids"] = pids


def ph_fund(state):
    # Try permissionless mint first (small probe); else distribute.
    minted = False
    try:
        tx(USDT, V5, "ft_mint",
           {"receiver_id": TRADERS[0], "amount": "1000000"},
           deposit="1 yoctonear")
        minted = True
        print("  fakes mint works", flush=True)
    except Exception as e:
        print(f"  mint unavailable ({str(e)[:80]}), distributing",
              flush=True)
    for t in TRADERS:
        try:
            tx(USDT, t, "storage_deposit", {"account_id": t},
               deposit="0.00125 NEAR")
        except Exception:
            pass  # already registered
        if minted:
            tx(USDT, V5, "ft_mint",
               {"receiver_id": t, "amount": "2000000000"},
               deposit="1 yoctonear")
        else:
            tx(USDT, "buyer." + V5, "ft_transfer",
               {"receiver_id": t, "amount": "1000000000", "memo": "demo"},
               deposit="1 yoctonear")
    state["data"]["funded"] = True


def _buy(trader, pid, usdt_base):
    tx(USDT, trader, "ft_transfer_call",
       {"receiver_id": V5, "amount": str(usdt_base),
        "msg": json.dumps({"Buy": {"product_id": pid,
                                   "min_tokens_out": "1"}})},
       deposit="1 yoctonear", gas="300 Tgas")


def _sell(trader, token, pid, amount_base):
    tx(token, trader, "ft_transfer_call",
       {"receiver_id": V5, "amount": str(amount_base),
        "msg": json.dumps({"Sell": {"product_id": pid,
                                    "min_reserve_out": "1"}})},
       deposit="1 yoctonear", gas="300 Tgas")


def ph_trade(state, db_path):
    pids = state["data"]["pids"]
    prods = [(FOUNDERS[i],
              pids[FOUNDERS[i]]["product_id"],
              pids[FOUNDERS[i]]["token"]) for i in range(5)]
    for trader in TRADERS:
        for _, _, token in prods:
            try:
                tx(token, trader, "storage_deposit",
                   {"account_id": trader}, deposit="0.00125 NEAR")
            except Exception:
                pass
    # Round 1: every trader buys on products 1..3 (10/25/50 USDT).
    amounts = [10_000_000, 25_000_000, 50_000_000]
    for ti, trader in enumerate(TRADERS):
        for _, pid, _ in prods[:3]:
            _buy(trader, pid, amounts[ti])
    # Round 2: t1 goes big on 4-5, t2 sells half of product 1.
    _buy(TRADERS[0], prods[3][1], 100_000_000)
    _buy(TRADERS[0], prods[4][1], 100_000_000)
    bal = view(prods[0][2], "ft_balance_of", {"account_id": TRADERS[1]})
    _sell(TRADERS[1], prods[0][2], prods[0][1], int(bal) // 2)
    # Snapshots after trading.
    from keeper import snapshot_products
    from sync import sync_products
    store = Store(db_path)
    sync_products(store, V5)
    snaps = snapshot_products(store, V5, RPC)
    store.close()
    print(f"  snapshots: {len([s for s in snaps if 'error' not in s])}",
          flush=True)
    state["data"]["traded"] = True


POST_TEXTS = [
    "I switched to {name} ({tag}) last week and the speed difference is unreal. Full notes: {link}",
    "{name} {tag} review: setup took minutes, docs are excellent, daily driver now. Details: {link}",
    "Why {name} {tag} replaced my old setup: faster, cleaner, fewer papercuts. Writeup: {link}",
]


def ph_close(state, db_path):
    import subprocess
    pids = state["data"]["pids"]
    # Liveness pass first (confirms approved posts while cycle open).
    r = subprocess.run(
        [sys.executable, "verifier.py", "--once", "--submit",
         "--account", V5, "--db", db_path,
         "--fixtures", "/tmp/sim-fixtures.json",
         "--contract", V5],
        capture_output=True, text=True, timeout=600,
        cwd=os.path.dirname(os.path.abspath(__file__)))
    print(r.stdout[-1000:], flush=True)
    # Milestone on product 2 (f2): publish + 2 votes, then settle.
    f2 = FOUNDERS[1]
    pid2 = pids[f2]["product_id"]
    ms = view(V5, "get_milestone",
              {"product_id": pid2, "index": 0})
    if ms is None:
        tx(V5, f2, "publish_milestone",
           {"product_id": pid2,
            "evidence_url": "https://docs.astral.sh/ruff/",
            "evidence_hash": None}, deposit="0.01 NEAR")
    tok2 = pids[f2]["token"]
    for trader in TRADERS[:2]:
        lock = view(V5, "get_vote_lock",
                    {"product_id": pid2, "index": 0, "voter": trader})
        if lock is not None:
            continue
        bal = view(tok2, "ft_balance_of", {"account_id": trader})
        amt = str(int(bal) // 4 or 1)
        tx(tok2, trader, "ft_transfer_call",
           {"receiver_id": V5, "amount": amt,
            "msg": json.dumps({"Vote": {"product_id": pid2, "index": 0,
                                        "approve": True}})},
           deposit="1 yoctonear", gas="300 Tgas")
    # Wait for the longest cycle end, then finalize + claim all.
    # Skip the wait when every product already rolled past its sim cycle.
    active_pre = state["data"].get("active_cycles", {})
    prods = [view(V5, "get_product", {"product_id": pids[f]["product_id"]})
             for f in FOUNDERS]
    pending = [p for (f, p) in zip(FOUNDERS, prods)
               if p["cycle_id"] == int(active_pre.get(
                   str(pids[f]["product_id"]), -1))]
    if pending:
        wait_s = max(p["cycle_end_ns"] for p in pending) / 1e9 \
            - time.time() + 10
        if wait_s > 0:
            print(f"  waiting {wait_s:.0f}s for cycle ends", flush=True)
            time.sleep(wait_s)
    for f in FOUNDERS:
        pid = pids[f]["product_id"]
        p = view(V5, "get_product", {"product_id": pid})
        pool = view(V5, "get_pool",
                    {"product_id": pid, "cycle_id": p["cycle_id"]})
        if not pool.get("finalized") \
                and time.time_ns() >= p["cycle_end_ns"]:
            tx(V5, f, "finalize_cycle", {"product_id": pid})
    active = state["data"].get("active_cycles", {})
    # Dispute window (60s) must pass after finalize before claims.
    print("  waiting out dispute window", flush=True)
    time.sleep(75)
    for c in CREATORS:
        for f in FOUNDERS:
            pid = pids[f]["product_id"]
            cid = int(active.get(str(pid), 0))
            pay = view(V5, "get_payout",
                       {"product_id": pid, "cycle_id": cid,
                        "creator": c})
            if int(pay or 0) > 0:
                tx(V5, c, "claim_payout",
                   {"product_id": pid, "cycle_id": cid})
                print(f"  {c} claimed {pay} on {pid}/{cid}",
                      flush=True)
    tx(V5, f2, "finalize_milestone",
       {"product_id": pid2, "index": 0})
    for trader in TRADERS[:2]:
        tx(V5, trader, "unlock_vote",
           {"product_id": pid2, "index": 0})
    ms = view(V5, "get_milestone",
              {"product_id": pid2, "index": 0})
    print(f"  milestone: released={ms['released']} "
          f"approve={ms['approve_weight']}", flush=True)
    state["data"]["closed"] = True


def ph_posts(state, db_path):
    import subprocess
    from sync import sync_products
    store = Store(db_path)
    sync_products(store, V5)
    store.close()
    pids = state["data"]["pids"]
    # Rollover: setup took longer than the 600s cycle on some products.
    active = {}
    for f in FOUNDERS:
        pid = pids[f]["product_id"]
        p = view(V5, "get_product", {"product_id": pid})
        if time.time_ns() >= p["cycle_end_ns"]:
            print(f"  rollover pid={pid}", flush=True)
            tx(V5, f, "finalize_cycle", {"product_id": pid})
            p = view(V5, "get_product", {"product_id": pid})
        active[str(pid)] = p["cycle_id"]
    state["data"]["active_cycles"] = active
    fixtures = {}
    n = 0
    for ci, creator in enumerate(CREATORS):
        for fi in range(2):  # 2 products each
            idx = (ci + fi) % 5
            founder = FOUNDERS[idx]
            pid = pids[founder]["product_id"]
            meta = PRODUCTS[idx]
            url = f"https://x.com/demo/status/{1000 + n}"
            handle = f"@creator{ci + 1}"
            tx(V5, creator, "submit_post",
               {"product_id": pid, "url": url,
                "linked_account": handle}, deposit="0.01 NEAR")
            text = POST_TEXTS[n % len(POST_TEXTS)].format(
                name=meta["name"], tag="#" + meta["symbol"],
                link=meta["demo_url"])
            fixtures[f"x|{handle}|{url}"] = {
                "content": text, "account_age_days": 30,
                "alive": True}
            n += 1
    with open("/tmp/sim-fixtures.json", "w") as f:
        json.dump(fixtures, f)
    # Attest everything through the real backend.
    r = subprocess.run(
        [sys.executable, "verifier.py", "--once", "--submit",
         "--account", V5, "--db", db_path,
         "--fixtures", "/tmp/sim-fixtures.json",
         "--contract", V5],
        capture_output=True, text=True, timeout=600,
        cwd=os.path.dirname(os.path.abspath(__file__)))
    print(r.stdout[-2000:], flush=True)
    if r.returncode != 0:
        raise RuntimeError(f"verifier: {r.stderr[-500:]}")
    state["data"]["post_count"] = n


def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument("--phase", choices=PHASES + ["all"], default="all")
    ap.add_argument("--state", default="/tmp/sim.json")
    ap.add_argument("--db", default="/tmp/sim.db")
    args = ap.parse_args(argv)
    state = load_state(args.state)
    wanted = PHASES if args.phase == "all" else [args.phase]
    fns = {"funds": lambda: ph_funds(state),
           "accounts": lambda: ph_accounts(state),
           "drafts": lambda: ph_drafts(state, args.db),
           "launch": lambda: ph_launch(state),
           "fund": lambda: ph_fund(state),
           "trade": lambda: ph_trade(state, args.db),
           "posts": lambda: ph_posts(state, args.db),
           "close": lambda: ph_close(state, args.db)}
    for ph in wanted:
        if ph in state["done"]:
            print(f"== {ph}: already done, skip", flush=True)
            continue
        print(f"== {ph}", flush=True)
        try:
            fns[ph]()
        except Exception as e:
            save_state(args.state, state)
            print(f"FAILED {ph}: {e}", flush=True)
            return 1
        state["done"].append(ph)
        save_state(args.state, state)
    print("OK", state["done"], flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
