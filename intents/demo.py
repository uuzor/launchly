"""Live demo of the 1Click adapter. DRY QUOTES ONLY: no funds move.

1. Lists priced assets, resolves the assets Launchly needs.
2. Dry pay-in quote: 0.001 ETH (Ethereum) -> USDT on NEAR to Launchly.
3. Dry payout quote: 10 USDT (NEAR) -> USDC on NEAR to a creator address.

1Click is mainnet-only: recipients must be mainnet NEAR accounts and refunds
must be addresses on the ORIGIN chain (0x... for Ethereum-origin assets).

NOTE (2026-11-05): /v0/quote returns HTTP 500 for every route, including the
verbatim docs example, while /v0/tokens (200) and /v0/status (correct 404)
work. The quote path is blocked by a 1Click backend outage, not this code.
Re-run when the API recovers.

Run:  python3 intents/demo.py
"""

import json
import sys

sys.path.insert(0, "intents")

from adapter import (  # noqa: E402
    OneClickClient,
    OneClickError,
    payin_quote,
    payout_quote,
)

# Placeholder mainnet recipient for DRY quotes (1Click rejects testnet names).
# Replace with the real Launchly mainnet account before any live use.
LAUNCHLY_ACCOUNT = "launchly.near"
# Placeholder origin-chain refund for the ETH pay-in (dry quotes move nothing).
EVM_REFUND = "0x1111111111111111111111111111111111111111"


def main():
    client = OneClickClient()
    try:
        toks = client.tokens()
    except OneClickError as e:
        print("tokens failed:", e)
        return 1
    print(f"assets listed: {len(toks)}")

    eth = client.find_asset(symbol="ETH", blockchain="eth")
    usdt_near = client.find_asset(symbol="USDT", blockchain="near")
    usdc_near = client.find_asset(symbol="USDC", blockchain="near")
    print("ETH   :", eth["assetId"], f"({eth['decimals']} dec, ${eth.get('price')})")
    print("USDT  :", usdt_near["assetId"], f"({usdt_near['decimals']} dec)")
    print("USDC  :", usdc_near["assetId"], f"({usdc_near['decimals']} dec)")

    print("\n--- dry pay-in: 0.001 ETH -> USDT on NEAR ---")
    try:
        res, _ = payin_quote(
            client,
            eth["assetId"],
            str(int(0.001 * 10 ** eth["decimals"])),
            LAUNCHLY_ACCOUNT,
            usdt_near["assetId"],
            refund_to=EVM_REFUND,
        )
        print(json.dumps(res, indent=2)[:1200])
    except OneClickError as e:
        print("pay-in quote failed:", e)

    print("\n--- dry payout: 10 USDT -> USDC on NEAR ---")
    try:
        res, _ = payout_quote(
            client,
            usdt_near["assetId"],
            str(10 * 10 ** usdt_near["decimals"]),
            usdc_near["assetId"],
            LAUNCHLY_ACCOUNT,  # demo stands in for the creator address
            LAUNCHLY_ACCOUNT,
        )
        print(json.dumps(res, indent=2)[:1200])
    except OneClickError as e:
        print("payout quote failed:", e)
    print("\nOK: dry quotes only, nothing executed.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
