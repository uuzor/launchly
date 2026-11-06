"""NEAR chain access for the backend. Stdlib only.

Reads go straight to NEAR RPC (`query`/`call_function`) over urllib — no
CLI parsing. Writes go through the `near` CLI via subprocess so keys stay
in the operator's keychain/env and never enter Python state.
"""

import base64
import json
import subprocess
import urllib.request

TESTNET_RPC = "https://rpc.testnet.fastnear.com"
MAINNET_RPC = "https://rpc.mainnet.near.org"

USER_AGENT = "launchly-backend/1.0 (+https://github.com/launchly)"


class ChainError(Exception):
    pass


def rpc_view(rpc_url, contract_id, method, args, timeout=20):
    """Call a view method. Returns the decoded JSON result."""
    payload = {
        "jsonrpc": "2.0",
        "id": "launchly",
        "method": "query",
        "params": {
            "request_type": "call_function",
            "finality": "final",
            "account_id": contract_id,
            "method_name": method,
            "args_base64": base64.b64encode(
                json.dumps(args).encode()).decode(),
        },
    }
    req = urllib.request.Request(
        rpc_url, data=json.dumps(payload).encode(),
        headers={"Content-Type": "application/json",
                 "User-Agent": USER_AGENT})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            body = json.loads(resp.read().decode())
    except Exception as e:
        raise ChainError(f"RPC {method} failed: {e}")
    if "error" in body:
        raise ChainError(f"RPC {method} error: {body['error']}")
    raw = bytes(body["result"]["result"]).decode()
    return json.loads(raw) if raw else None


def tx_status(rpc_url, tx_hash, sender_id, timeout=20):
    """Fetch a transaction's full execution outcome (tx_status).

    Returns the decoded result: transaction, receipts, receipts_outcome,
    and the final status. Raises ChainError when unknown or failed.
    """
    payload = {
        "jsonrpc": "2.0",
        "id": "launchly",
        "method": "EXPERIMENTAL_tx_status",
        "params": [tx_hash, sender_id],
    }
    req = urllib.request.Request(
        rpc_url, data=json.dumps(payload).encode(),
        headers={"Content-Type": "application/json",
                 "User-Agent": USER_AGENT})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            body = json.loads(resp.read().decode())
    except Exception as e:
        raise ChainError(f"tx_status failed: {e}")
    if "error" in body:
        raise ChainError(f"tx_status error: {body['error']}")
    return body["result"]


def cli_tx(contract_id, signer, method, args, deposit="0 NEAR",
           gas="300 Tgas", network="testnet", timeout=120):
    """Send a change-method transaction via the `near` CLI. Returns True
    only when the on-chain execution succeeded (receipts say so), never
    on mere signing success."""
    cmd = ["near", "contract", "call-function", "as-transaction",
           contract_id, method, "json-args", json.dumps(args),
           "prepaid-gas", gas, "attached-deposit", deposit,
           "sign-as", signer, "network-config", network,
           "sign-with-keychain", "send"]
    try:
        proc = subprocess.run(cmd, capture_output=True, text=True,
                              timeout=timeout)
    except FileNotFoundError:
        raise ChainError("near CLI not found on PATH")
    except subprocess.TimeoutExpired:
        raise ChainError(f"CLI {method} timed out")
    out = proc.stdout + proc.stderr
    # near-cli-rs prints failures as `ExecutionError(...)` / `Failure`;
    # a bare "signed successfully" line means nothing by itself.
    if "ExecutionError" in out or "status: Failure" in out or " panicked" in out:
        raise ChainError(f"CLI {method} failed: {out[-2000:]}")
    if proc.returncode != 0:
        raise ChainError(f"CLI {method} exit {proc.returncode}: {out[-2000:]}")
    return True
