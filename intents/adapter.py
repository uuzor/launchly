"""NEAR Intents 1Click adapter for Launchly (stdlib only, no dependencies).

Covers IDEA.md section 5:
- pay-in quotes: trader's asset on any chain -> reserve USDT on NEAR
  delivered to the Launchly contract account;
- payout quotes: pool USDT on NEAR -> creator's asset/chain of choice.

Safety: quotes are DRY by default (free, no funds move). A live quote
requires explicit opt-in (see OneClickClient.quote), and deposits +
mainnet swaps are always executed by a human. There is no Intents testnet.

Docs: https://docs.near-intents.org/integration/distribution-channels/1click-api
Base URL override: ONECLICK_BASE (default https://1click.chaindefuser.com)
Optional auth: ONECLICK_JWT (else an unauthenticated fee applies).
"""

import json
import os
import time
import urllib.error
import urllib.parse
import urllib.request

BASE_URL = os.environ.get("ONECLICK_BASE", "https://1click.chaindefuser.com")
JWT = os.environ.get("ONECLICK_JWT", "")

# Terminal statuses from GET /v0/status (docs: quickstart/making-a-request).
TERMINAL_STATUSES = {"SUCCESS", "REFUNDED", "FAILED"}


class OneClickError(Exception):
    """1Click API or adapter error (message includes HTTP status when known)."""


def _request(method, path, body=None, timeout=30):
    url = BASE_URL + path
    data = json.dumps(body).encode() if body is not None else None
    headers = {
        "Content-Type": "application/json",
        # Cloudflare in front of 1Click rejects bare script UAs (HTTP 1010).
        "User-Agent": "launchly-intents-adapter/0.1 (NEAR hackathon demo)",
    }
    if JWT:
        headers["Authorization"] = "Bearer " + JWT
    req = urllib.request.Request(url, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return json.loads(resp.read().decode())
    except urllib.error.HTTPError as e:
        try:
            detail = e.read().decode()[:500]
        except Exception:
            detail = ""
        raise OneClickError(f"{method} {path} -> HTTP {e.code}: {detail}")
    except (urllib.error.URLError, TimeoutError, json.JSONDecodeError) as e:
        raise OneClickError(f"{method} {path} failed: {e}")


class OneClickClient:
    """Thin client for the 1Click Swap API (GET tokens, POST quote, status)."""

    def tokens(self):
        """Return the priced asset list. Each entry has assetId/decimals/etc."""
        res = _request("GET", "/v0/tokens")
        return res if isinstance(res, list) else res.get("tokens", [])

    def find_asset(self, symbol=None, blockchain=None, contract=None):
        """Find an assetId by symbol/chain/contract (case-insensitive symbol).

        Never construct assetIds by hand: always resolve them from /v0/tokens.
        """
        sym = (symbol or "").upper()
        for t in self.tokens():
            if symbol and t.get("symbol", "").upper() != sym:
                continue
            if blockchain and t.get("blockchain") != blockchain:
                continue
            if contract and t.get("contractAddress") != contract:
                continue
            return t
        raise OneClickError(
            f"asset not found: symbol={symbol} chain={blockchain} contract={contract}"
        )

    def quote(
        self,
        origin_asset,
        destination_asset,
        amount,
        recipient,
        refund_to,
        dry=True,
        allow_live=False,
        swap_type="EXACT_INPUT",
        slippage_bps=100,
        deposit_type="ORIGIN_CHAIN",
        recipient_type="DESTINATION_CHAIN",
        refund_type="ORIGIN_CHAIN",
        deadline_minutes=10,
    ):
        """Request a swap quote.

        dry=True (default): validates parameters and returns pricing without
        executing anything. Pass dry=False AND allow_live=True for a real
        quote with a deposit address. `amount` is a string in the origin
        asset's smallest unit; `slippage_bps` is basis points (100 = 1%).
        """
        if not dry and not allow_live:
            raise OneClickError(
                "refusing live quote: pass allow_live=True explicitly "
                "(a human must approve every real swap)"
            )
        deadline = time.strftime(
            "%Y-%m-%dT%H:%M:%S.000Z", time.gmtime(time.time() + deadline_minutes * 60)
        )
        return _request(
            "POST",
            "/v0/quote",
            {
                "dry": dry,
                "swapType": swap_type,
                "slippageTolerance": slippage_bps,
                "originAsset": origin_asset,
                "depositType": deposit_type,
                "destinationAsset": destination_asset,
                "amount": str(amount),
                "recipient": recipient,
                "recipientType": recipient_type,
                "refundTo": refund_to,
                "refundType": refund_type,
                "deadline": deadline,
            },
        )

    @staticmethod
    def deposit_address(quote_res):
        """Extract the deposit address from a live quote response."""
        q = quote_res.get("quote", quote_res)
        addr = q.get("depositAddress") or quote_res.get("depositAddress")
        if not addr:
            raise OneClickError(f"no depositAddress in quote: {quote_res!r:.300}")
        return addr

    def submit_deposit_tx(self, deposit_address, tx_hash):
        """Notify 1Click of a deposit tx (optional, speeds up processing)."""
        return _request(
            "POST",
            "/v0/deposit/submit",
            {"depositAddress": deposit_address, "txHash": tx_hash},
        )

    def status(self, deposit_address):
        """Return the raw status object for a deposit address."""
        path = "/v0/status?depositAddress=" + urllib.parse.quote(deposit_address, safe="")
        return _request("GET", path)

    def wait_for_status(self, deposit_address, timeout_s=900, interval_s=15):
        """Poll status until terminal (SUCCESS/REFUNDED/FAILED) or timeout."""
        started = time.time()
        last = None
        while time.time() - started < timeout_s:
            last = self.status(deposit_address)
            state = last.get("status", last)
            if isinstance(state, str) and state in TERMINAL_STATUSES:
                return last
            time.sleep(interval_s)
        raise OneClickError(f"status timed out after {timeout_s}s (last: {last!r:.300})")


# ---- Launchly flows (IDEA.md 5.1 / 5.2) ----


def payin_quote(client, origin_asset_id, origin_amount_smallest, launchly_account,
                reserve_asset_id, dry=True, allow_live=False, refund_to=None):
    """Quote: trader's asset (any chain) -> reserve USDT on NEAR to Launchly.

    `refund_to` must be an address on the ORIGIN chain (e.g. 0x... when the
    origin asset lives on Ethereum). Defaults to `launchly_account`, which is
    only valid when origin and destination are both NEAR.

    Returns (quote_response, deposit_address_or_None). Dry by default.
    """
    res = client.quote(
        origin_asset=origin_asset_id,
        destination_asset=reserve_asset_id,
        amount=origin_amount_smallest,
        recipient=launchly_account,
        refund_to=refund_to or launchly_account,
        dry=dry,
        allow_live=allow_live,
    )
    addr = None if dry else OneClickClient.deposit_address(res)
    return res, addr


def payout_quote(client, reserve_asset_id, reserve_amount_smallest,
                 creator_asset_id, creator_address, launchly_account,
                 dry=True, allow_live=False):
    """Quote: pool USDT on NEAR -> creator's asset/chain of choice.

    Returns (quote_response, deposit_address_or_None). Dry by default.
    """
    res = client.quote(
        origin_asset=reserve_asset_id,
        destination_asset=creator_asset_id,
        amount=reserve_amount_smallest,
        recipient=creator_address,
        refund_to=launchly_account,
        dry=dry,
        allow_live=allow_live,
    )
    addr = None if dry else OneClickClient.deposit_address(res)
    return res, addr
