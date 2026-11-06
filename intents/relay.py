"""Meta-tx relay: validate NEP-366 signed delegates, quota, audit.

A founder signs a DelegateAction in their wallet; the backend checks it
against an allowlist, enforces per-sender quotas, audits the decision,
and (once a broadcast signer exists) would sponsor the gas. Today this
module validates + audits only: NOTHING is broadcast, because neither
stdlib Python (no ed25519) nor the `near` CLI (no Delegate action) can
sign the enveloping transaction. See README roadmap for the signer.

What the backend enforces (chain still verifies the signature itself):
- receiver must be the configured Launchly contract,
- every action must be a FunctionCall in the allowlist,
- per-action gas under a cap (bounds future relayer spend),
- max_block_height still in the future (freshness via RPC `status`),
- per-sender daily quota.

Usage:
    python3 relay.py check --delegate <base64> --contract X [--rpc URL]
    python3 relay.py log --db intents.db [--limit 20]
"""

import argparse
import base64
import json
import os
import sys
import urllib.request

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from store import Store
import chain as chainmod

ALLOW_METHODS = ("create_product", "launch_coin", "submit_post")
MAX_ACTIONS = 3
MAX_GAS_TGAS = 300
MAX_PER_DAY = 5
MAX_DELEGATE_BYTES = 16 * 1024

TGAS = 10 ** 12


class RelayError(Exception):
    pass


class _Reader:
    def __init__(self, raw):
        self.buf = raw
        self.pos = 0

    def take(self, n, what):
        if self.pos + n > len(self.buf):
            raise RelayError(f"truncated {what}")
        out = self.buf[self.pos:self.pos + n]
        self.pos += n
        return out

    def u8(self, what):
        return int.from_bytes(self.take(1, what), "little")

    def u32(self, what):
        return int.from_bytes(self.take(4, what), "little")

    def u64(self, what):
        return int.from_bytes(self.take(8, what), "little")

    def u128(self, what):
        return int.from_bytes(self.take(16, what), "little")

    def string(self, what, limit=64 * 1024):
        n = self.u32(what + " len")
        if n > limit:
            raise RelayError(f"{what} too long ({n})")
        try:
            return self.take(n, what).decode("utf-8")
        except UnicodeDecodeError:
            raise RelayError(f"{what} not utf-8")

    def bytes_vec(self, what, limit=1024 * 1024):
        n = self.u32(what + " len")
        if n > limit:
            raise RelayError(f"{what} too long ({n})")
        return self.take(n, what)

    def end(self):
        if self.pos != len(self.buf):
            raise RelayError(
                f"trailing bytes ({len(self.buf) - self.pos})")


def _public_key(r):
    tag = r.u8("key tag")
    if tag == 0:
        return {"curve": "ed25519", "key_hex": r.take(32, "key").hex()}
    if tag == 1:
        return {"curve": "secp256k1", "key_hex": r.take(64, "key").hex()}
    raise RelayError(f"unknown key tag {tag}")


def _signature(r):
    tag = r.u8("sig tag")
    if tag == 0:
        return {"curve": "ed25519", "sig_hex": r.take(64, "sig").hex()}
    if tag == 1:
        return {"curve": "secp256k1", "sig_hex": r.take(65, "sig").hex()}
    raise RelayError(f"unknown sig tag {tag}")


def decode_signed_delegate(raw: bytes) -> dict:
    """Strict-decode a borsh SignedDelegateAction (NEP-366 v1).

    Returns sender/receiver/actions/nonce/max_block_height/public_key/
    signature. Only FunctionCall actions decode; anything else (incl.
    nested delegates) is rejected. The SIGNATURE IS NOT VERIFIED here
    (stdlib has no ed25519) -- the chain verifies it on execution.
    """
    if not isinstance(raw, (bytes, bytearray)) or not raw:
        raise RelayError("empty delegate")
    if len(raw) > MAX_DELEGATE_BYTES:
        raise RelayError("delegate too large")
    r = _Reader(bytes(raw))
    sender = r.string("sender")
    receiver = r.string("receiver")
    n_actions = r.u32("actions len")
    if n_actions == 0 or n_actions > 64:
        raise RelayError(f"bad action count ({n_actions})")
    actions = []
    for i in range(n_actions):
        tag = r.u8(f"action[{i}] tag")
        if tag != 2:
            raise RelayError(
                f"action[{i}]: only FunctionCall(2) accepted, got {tag}")
        actions.append({
            "kind": "function_call",
            "method_name": r.string(f"action[{i}] method", limit=1024),
            "args_hex": r.bytes_vec(f"action[{i}] args").hex(),
            "gas": r.u64(f"action[{i}] gas"),
            "deposit": str(r.u128(f"action[{i}] deposit")),
        })
    nonce = r.u64("nonce")
    max_block_height = r.u64("max_block_height")
    public_key = _public_key(r)
    signature = _signature(r)
    r.end()
    return {"sender": sender, "receiver": receiver, "actions": actions,
            "nonce": nonce, "max_block_height": max_block_height,
            "public_key": public_key, "signature": signature}


def rpc_height(rpc_url, timeout=10) -> int:
    """Current block height via RPC `status`."""
    payload = {"jsonrpc": "2.0", "id": "relay",
               "method": "status", "params": []}
    req = urllib.request.Request(
        rpc_url, data=json.dumps(payload).encode(),
        headers={"Content-Type": "application/json",
                 "User-Agent": chainmod.USER_AGENT})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            body = json.loads(resp.read().decode())
        return int(body["result"]["sync_info"]["latest_block_height"])
    except Exception as e:
        raise RelayError(f"height unavailable: {e}")


def check_and_record(store, contract_id, raw: bytes, *,
                     rpc_url=None, check_height=True,
                     allow_methods=ALLOW_METHODS,
                     max_actions=MAX_ACTIONS,
                     max_gas_tgas=MAX_GAS_TGAS,
                     max_per_day=MAX_PER_DAY, today=None):
    """Validate a delegate, bump quota, audit. Returns a decision dict.

    Never raises on bad input (RelayError paths become rejections);
    audits every decision. `today` (YYYY-MM-DD) is injectable for tests.
    """
    try:
        return _check(store, contract_id, raw, rpc_url, check_height,
                      allow_methods, max_actions, max_gas_tgas,
                      max_per_day, today)
    except RelayError as e:
        store.record_relay("", "", "", 0, 0, "", "rejected",
                           f"decode: {e}")
        return {"accepted": False, "reason": f"invalid delegate: {e}",
                "broadcast": "none"}


def _check(store, contract_id, raw, rpc_url, check_height,
           allow_methods, max_actions, max_gas_tgas, max_per_day,
           today):
    d = decode_signed_delegate(raw)
    methods = [a["method_name"] for a in d["actions"]]
    key = d["public_key"]["curve"] + ":" + d["public_key"]["key_hex"][:16]

    def reject(reason):
        store.record_relay(d["sender"], d["receiver"],
                           ",".join(methods), d["nonce"],
                           d["max_block_height"], key, "rejected", reason)
        return {"accepted": False, "reason": reason,
                "sender": d["sender"], "receiver": d["receiver"],
                "methods": methods, "broadcast": "none"}

    if d["receiver"] != contract_id:
        return reject(f"receiver {d['receiver']} != {contract_id}")
    if len(d["actions"]) > max_actions:
        return reject(f"too many actions ({len(d['actions'])})")
    for a in d["actions"]:
        if a["method_name"] not in allow_methods:
            return reject(f"method not allowlisted: {a['method_name']}")
        if a["gas"] > max_gas_tgas * TGAS:
            return reject(f"gas over cap: {a['method_name']}")
    if check_height:
        if not rpc_url:
            return reject("height check needs --rpc")
        try:
            height = rpc_height(rpc_url)
        except RelayError as e:
            return reject(str(e))
        if d["max_block_height"] <= height:
            return reject(f"expired (max {d['max_block_height']} "
                          f"<= height {height})")
    allowed, used = store.relay_quota_use(d["sender"], max_per_day,
                                          today=today)
    if not allowed:
        return reject(f"daily quota reached ({max_per_day}/day)")
    store.record_relay(d["sender"], d["receiver"], ",".join(methods),
                       d["nonce"], d["max_block_height"], key,
                       "accepted", "ok")
    return {"accepted": True, "reason": "ok", "sender": d["sender"],
            "receiver": d["receiver"], "methods": methods,
            "nonce": d["nonce"],
            "max_block_height": d["max_block_height"],
            "quota_used": used, "quota_limit": max_per_day,
            "broadcast": "pending-signer"}


def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument("--db", default="intents.db")
    sub = ap.add_subparsers(dest="cmd", required=True)
    p = sub.add_parser("check", help="validate a base64 delegate")
    p.add_argument("--delegate", required=True)
    p.add_argument("--contract", required=True)
    p.add_argument("--rpc", default=chainmod.TESTNET_RPC)
    p.add_argument("--skip-height-check", action="store_true")
    p = sub.add_parser("log", help="show audit log")
    p.add_argument("--limit", type=int, default=20)
    args = ap.parse_args(argv)
    store = Store(args.db)
    if args.cmd == "check":
        try:
            raw = base64.b64decode(args.delegate)
        except Exception:
            print(json.dumps({"accepted": False,
                              "reason": "bad base64"}))
            return 2
        out = check_and_record(
            store, args.contract, raw, rpc_url=args.rpc,
            check_height=not args.skip_height_check)
        print(json.dumps(out, indent=1))
        return 0 if out["accepted"] else 1
    rows = store.list_relay_log(args.limit)
    print(json.dumps(rows, indent=1))
    return 0


if __name__ == "__main__":
    sys.exit(main())
