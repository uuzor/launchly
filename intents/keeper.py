"""Keeper: propose-only actionable opportunities. Never holds keys, never spends.

Reads the chain (read-only views) + local store, suggests what a HUMAN
should do:

- `keeper.py reconcile` -- sync products + dry-run verifier, print report.
- `keeper.py propose-vault --product <id> --deploy|--withdraw <base|full>`
  -- vault suggestion + the exact `near` CLI command for a human to run.
- `keeper.py serve --interval <s>` -- reconcile loop, forever. Idempotent.

No private keys anywhere in this module. Vault txs print as copy-paste
`near contract call-function` commands; the human signs and sends.

One exception: `--submit` lets the keeper finish stuck launches itself.
`complete_launch` is permissionless (any dust-funded account works, and
it can only advance Launching -> Live, never move funds), so making a
founder sign it adds nothing. Keys still live in the near CLI keychain,
never here -- mirroring verifier.py --submit.
"""

import argparse
import json
import os
import time

import chain as chainmod
from store import Store
from sync import sync_products
from verifier import Verifier

GAS_VAULT = "300 Tgas"


def snapshot(store, contract_id, rpc_url, product_id):
    """Read-only vault position + product. Never raises on view failure."""
    out = {"product_id": product_id}
    try:
        out["position"] = chainmod.rpc_view(
            rpc_url, contract_id, "get_vault_position",
            {"product_id": product_id})
    except chainmod.ChainError as e:
        out["position_error"] = str(e)
    try:
        out["product"] = chainmod.rpc_view(
            rpc_url, contract_id, "get_product", {"product_id": product_id})
    except chainmod.ChainError as e:
        out["product_error"] = str(e)
    return out


def _printable_cmd(contract_id, method, args):
    return ("near contract call-function as-transaction "
            f"{contract_id} {method} json-args '{json.dumps(args)}' "
            f"prepaid-gas '{GAS_VAULT}' attached-deposit '0 NEAR' "
            "sign-as <YOUR_ACCOUNT> network-config testnet "
            "sign-with-keychain send")


def propose_vault(store, contract_id, rpc_url, product_id,
                  deploy=False, withdraw=None):
    """Build a vault suggestion + human-runnable near CLI command.

    `withdraw` is base-unit amount or "full" (None on-chain). Nothing is
    executed; the returned dict contains a copy-paste command.
    """
    if bool(deploy) == (withdraw is not None):
        raise ValueError("give exactly one of deploy / withdraw")
    snap = snapshot(store, contract_id, rpc_url, product_id)
    pos = snap.get("position") or {}
    if deploy:
        method, args = "vault_rebalance", {"product_id": product_id}
        why = ("permissionless rebalance: deploys room under the cap, "
               "or services recall/queue first")
    else:
        amount = None if withdraw == "full" else str(withdraw)
        method, args = "vault_withdraw", {"product_id": product_id,
                                          "amount": amount}
        why = ("manual recall of deployed principal "
               f"(recorded principal: {pos.get('principal')})")
    return {"snapshot": snap, "method": method, "args": args, "why": why,
            "command": _printable_cmd(contract_id, method, args),
            "executed": False, "human_required": True}


def complete_stuck_launches(store, contract_id, rpc_url, signer,
                            network, submit=False):
    """Finish products stuck in Launching (launch step 2 is a separate
    call by design). Dry by default: reports would-complete entries.
    With submit=True, sends complete_launch via the near CLI keychain.
    One sick product never aborts the pass.
    """
    out = []
    for row in store.list_cached_products():
        pid = row["product_id"]
        try:
            p = chainmod.rpc_view(rpc_url, contract_id, "get_product",
                                  {"product_id": pid})
        except chainmod.ChainError as e:
            out.append({"op": "error", "product_id": pid,
                        "error": str(e)})
            continue
        if not p or p.get("status") != "Launching" \
                or not p.get("token_account"):
            continue
        entry = {"op": "complete_launch", "product_id": pid,
                 "token_account": p["token_account"], "submitted": False}
        if submit:
            try:
                chainmod.cli_tx(contract_id, signer, "complete_launch",
                                {"product_id": pid}, network=network)
                entry["submitted"] = True
            except chainmod.ChainError as e:
                entry["op"] = "error"
                entry["error"] = str(e)
        out.append(entry)
    return out


def reconcile(store, contract_id, rpc_url, network, signer=None,
              verifier_cls=Verifier, submit=False):
    """Sync products + dry-run verifier + launch completions.

    `signer` is only a label in dry mode (submit=False sends nothing).
    With submit=True, stuck launches are completed via the CLI keychain;
    the verifier half stays dry (attesting is the verifier's job).
    """
    cached, bound = sync_products(store, contract_id, rpc_url)
    verifier = verifier_cls(store, contract_id, rpc_url, signer or "dry-run",
                            network, submit=False)
    actions = verifier.run_once()
    completions = complete_stuck_launches(
        store, contract_id, rpc_url, signer or "dry-run", network,
        submit=submit)
    return {"cached_products": cached, "bound_drafts": bound,
            "verifier_actions": actions,
            "launch_completions": completions,
            "submitted": submit,
            "note": "chain is source of truth; store only caches"}


def snapshot_products(store, contract_id, rpc_url):
    """One price snapshot per live cached product. Never raises per
    product: failures come back as {product_id, error} entries.

    Price = tokens_out for buying 1.0 reserve (chain-computed
    get_buy_quote, fee-inclusive). No curve math duplicated here.
    """
    out = []
    for row in store.list_cached_products():
        pid = row["product_id"]
        try:
            p = chainmod.rpc_view(rpc_url, contract_id, "get_product",
                                  {"product_id": pid})
            if not p or p.get("status") != "Live":
                continue
            token = p.get("token_account")
            if not token:
                continue
            unit = str(10 ** int(p.get("reserve_decimals", 6)))
            quote = chainmod.rpc_view(
                rpc_url, contract_id, "get_buy_quote",
                {"product_id": pid, "reserve_in": unit})
            supply = chainmod.rpc_view(rpc_url, token, "ft_total_supply",
                                       {})
            store.add_snapshot(pid, token, quote[0],
                               p.get("curve_reserve", "0"),
                               p.get("curve_sold", "0"), supply)
            out.append({"product_id": pid, "token_account": token,
                        "tokens_per_unit": quote[0], "supply": supply})
        except chainmod.ChainError as e:
            out.append({"product_id": pid, "error": str(e)})
    return out


def stats_products(store, contract_id, rpc_url, max_cycles=500):
    """Per-product post/creator counts via chain views, cached in SQLite.

    Never raises per product: failures come back as {product_id, error}
    entries. Cycles cap bounds RPC fan-out on old products.
    """
    out = []
    for row in store.list_cached_products():
        pid = row["product_id"]
        try:
            p = chainmod.rpc_view(rpc_url, contract_id, "get_product",
                                  {"product_id": pid})
            if not p:
                continue
            cycles = min(int(p.get("cycle_id", 0)), max_cycles)
            posts_total = 0
            creators = set()
            for cycle in range(cycles + 1):
                posts = chainmod.rpc_view(
                    rpc_url, contract_id, "list_cycle_posts",
                    {"product_id": pid, "cycle_id": cycle}) or []
                posts_total += len(posts)
                for post in posts:
                    if post.get("creator"):
                        creators.add(post["creator"])
            store.upsert_stats(pid, posts_total, len(creators), cycles + 1)
            out.append({"product_id": pid, "posts_total": posts_total,
                        "creators_total": len(creators)})
        except chainmod.ChainError as e:
            out.append({"product_id": pid, "error": str(e)})
    return out


def serve(store, contract_id, rpc_url, network, interval_s, signer=None,
          once=False, submit=False):
    """Loop reconcile forever (or once with once=True, for tests)."""
    import sys
    while True:
        try:
            report = reconcile(store, contract_id, rpc_url, network,
                               signer, submit=submit)
            report["snapshots"] = snapshot_products(store, contract_id,
                                                    rpc_url)
            report["stats"] = stats_products(store, contract_id, rpc_url)
        except Exception as e:  # daemon mode survives transient failure
            print(f"keeper pass failed: {e}", file=sys.stderr, flush=True)
            if once:
                raise
            time.sleep(interval_s)
            continue
        print(json.dumps(report), flush=True)
        if once:
            return
        time.sleep(interval_s)


def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument("--db", default="intents.db")
    ap.add_argument("--launchly", required=True)
    ap.add_argument("--rpc", default=chainmod.TESTNET_RPC)
    ap.add_argument("--network", default="testnet")
    ap.add_argument("--signer", default=None)
    ap.add_argument("--account", default=os.environ.get("KEEPER_ACCOUNT", ""),
                    help="keychain account for --submit (default: KEEPER_ACCOUNT)")
    ap.add_argument("--submit", action="store_true",
                    help="actually send complete_launch for stuck launches")
    sub = ap.add_subparsers(dest="cmd", required=True)
    sub.add_parser("reconcile")
    p = sub.add_parser("propose-vault")
    p.add_argument("--product", type=int, required=True)
    p.add_argument("--deploy", action="store_true")
    p.add_argument("--withdraw", default=None,
                   help="base-unit amount or 'full'")
    p = sub.add_parser("snapshot")
    p = sub.add_parser("serve")
    p.add_argument("--interval", type=int, default=300)
    args = ap.parse_args(argv)
    if args.submit and not (args.account or args.signer):
        ap.error("--submit needs --account (or KEEPER_ACCOUNT)")
    store = Store(args.db)
    if args.cmd == "reconcile":
        print(json.dumps(reconcile(store, args.launchly, args.rpc,
                                   args.network,
                                   args.account or args.signer,
                                   submit=args.submit), indent=1))
    elif args.cmd == "propose-vault":
        print(json.dumps(propose_vault(
            store, args.launchly, args.rpc, args.product, args.deploy,
            args.withdraw), indent=1))
    elif args.cmd == "snapshot":
        print(json.dumps(snapshot_products(store, args.launchly,
                                           args.rpc), indent=1))
    elif args.cmd == "serve":
        serve(store, args.launchly, args.rpc, args.network, args.interval,
              args.account or args.signer, submit=args.submit)


if __name__ == "__main__":
    main()
