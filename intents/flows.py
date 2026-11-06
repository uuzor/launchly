"""Intents flow orchestration on top of adapter.py (backend.md §4.2).

- Dry quotes for pay-in and payout (UI power, no keys, no funds).
- prepare-live-swap: fetches a LIVE quote (deposit address) and STOPS for
  a human to deposit from their own wallet. The backend never holds
  mainnet swap keys in v1.
- watch: polls deposit status to terminal and records the receipt.

Every result carries explicit dry/live/simulated labels. Stdlib only.
"""

import argparse
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from adapter import OneClickClient, payin_quote, payout_quote
from store import Store


def dry_payin(store, client, origin_asset_id, origin_amount, launchly_account,
              reserve_asset_id, refund_to=None):
    params = {"origin_asset_id": origin_asset_id,
              "origin_amount": origin_amount,
              "launchly_account": launchly_account,
              "reserve_asset_id": reserve_asset_id,
              "refund_to": refund_to}
    quote, _ = payin_quote(client, origin_asset_id, origin_amount,
                           launchly_account, reserve_asset_id, dry=True,
                           refund_to=refund_to)
    qid = store.add_quote("payin", params, quote)
    return {"quote_id": qid, "dry": True, "live": False,
            "simulated": False, "quote": quote}


def dry_payout(store, client, reserve_asset_id, reserve_amount,
               dest_asset_id, dest_address, launchly_account):
    params = {"reserve_asset_id": reserve_asset_id,
              "reserve_amount": reserve_amount,
              "dest_asset_id": dest_asset_id, "dest_address": dest_address,
              "launchly_account": launchly_account}
    quote, _ = payout_quote(client, reserve_asset_id, reserve_amount,
                            dest_asset_id, dest_address, launchly_account,
                            dry=True)
    qid = store.add_quote("payout", params, quote)
    return {"quote_id": qid, "dry": True, "live": False,
            "simulated": False, "quote": quote}


def prepare_live_swap(store, client, kind, params):
    """Fetch a live quote and STOP. Returns deposit instructions for the
    human; nothing moves until they deposit from their own wallet."""
    if kind == "payin":
        quote, deposit = payin_quote(
            client, params["origin_asset_id"], params["origin_amount"],
            params["launchly_account"], params["reserve_asset_id"],
            dry=False, allow_live=True, refund_to=params.get("refund_to"))
    elif kind == "payout":
        quote, deposit = payout_quote(
            client, params["reserve_asset_id"], params["reserve_amount"],
            params["dest_asset_id"], params["dest_address"],
            params["launchly_account"], dry=False, allow_live=True)
    else:
        raise ValueError("kind must be payin or payout")
    qid = store.add_quote("live-" + kind, params, quote)
    if deposit:
        store.upsert_swap(deposit, "PENDING_DEPOSIT", quote_id=qid)
    return {"quote_id": qid, "dry": False, "live": True,
            "deposit_address": deposit, "quote": quote,
            "instructions": "HUMAN ACTION REQUIRED: deposit exactly the"
            " quoted amount to the deposit address from your own wallet,"
            " then run: flows.py watch --address " + str(deposit)}


def watch_swap(store, client, deposit_address, timeout_s=900):
    terminal = client.wait_for_status(deposit_address, timeout_s=timeout_s)
    status = terminal.get("status", "UNKNOWN")
    store.upsert_swap(deposit_address, status, receipt=terminal)
    return {"deposit_address": deposit_address, "status": status,
            "receipt": terminal}


def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument("--db", default="intents.db")
    sub = ap.add_subparsers(dest="cmd", required=True)
    p = sub.add_parser("dry-payin")
    p.add_argument("--origin-asset", required=True)
    p.add_argument("--origin-amount", required=True)
    p.add_argument("--launchly", required=True)
    p.add_argument("--reserve-asset", required=True)
    p.add_argument("--refund-to", default=None)
    p = sub.add_parser("dry-payout")
    p.add_argument("--reserve-asset", required=True)
    p.add_argument("--reserve-amount", required=True)
    p.add_argument("--dest-asset", required=True)
    p.add_argument("--dest-address", required=True)
    p.add_argument("--launchly", required=True)
    p = sub.add_parser("prepare-live-swap")
    p.add_argument("--kind", required=True, choices=["payin", "payout"])
    p.add_argument("--params", required=True,
                   help="JSON params matching the dry variant")
    p.add_argument("--i-understand-this-touches-mainnet",
                   action="store_true", required=True)
    p = sub.add_parser("watch")
    p.add_argument("--address", required=True)
    p.add_argument("--timeout", type=int, default=900)
    args = ap.parse_args(argv)
    store = Store(args.db)
    client = OneClickClient()
    if args.cmd == "dry-payin":
        print(json.dumps(dry_payin(
            store, client, args.origin_asset, args.origin_amount,
            args.launchly, args.reserve_asset, args.refund_to), indent=1))
    elif args.cmd == "dry-payout":
        print(json.dumps(dry_payout(
            store, client, args.reserve_asset, args.reserve_amount,
            args.dest_asset, args.dest_address, args.launchly), indent=1))
    elif args.cmd == "prepare-live-swap":
        print(json.dumps(prepare_live_swap(
            store, client, args.kind, json.loads(args.params)), indent=1))
    elif args.cmd == "watch":
        print(json.dumps(watch_swap(store, client, args.address,
                                    args.timeout), indent=1))


if __name__ == "__main__":
    main()
