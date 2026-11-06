# Live swap runbook (Intents payout, human-executed)

> HUMAN APPROVAL REQUIRED. Every command below moves real mainnet funds
> or touches mainnet quotes. Do not run unattended. The backend never
> sends funds by itself: `prepare-live-swap` stops at the deposit
> address and waits for a human deposit from their own wallet.

## Preconditions

1. 1Click `/v0/quote` is healthy again (it returned HTTP 400 "Internal
   server error" as of 2026-11-05 — re-probe with step 1 first).
2. You hold the payout reserve (USDT on NEAR mainnet) in a wallet YOU
   control. The backend holds no pool-moving keys, ever.
3. `ONECLICK_JWT` set if you want zero-fee quotes (else 0.2% fee).
4. Refund safety: `launchly_account` below must be a NEAR account you
   control on a payout (it is the `refund_to`).

## 1. Probe the quote endpoint (dry, no funds)

```bash
cd intents
python3 flows.py --db intents.db dry-payout \
  --reserve-asset nep141:usdt.tether-token.near \
  --reserve-amount 1000000 \
  --dest-asset nep141:wrap.near \
  --dest-address <CREATOR_NEAR_ACCOUNT> \
  --launchly <LAUNCHLY_MAINNET_ACCOUNT>
```

Expect `{dry: true, live: false, simulated: false}` plus a quote.
If this 400s, STOP — the outage persists.

## 2. Prepare the live swap (stops at deposit address)

```bash
python3 flows.py --db intents.db prepare-live-swap --kind payout \
  --params '{"reserve_asset_id":"nep141:usdt.tether-token.near",
             "reserve_amount":"<BASE_UNITS>",
             "dest_asset_id":"<1CLICK_ASSET_ID>",
             "dest_address":"<CREATOR_ADDRESS>",
             "launchly_account":"<LAUNCHLY_MAINNET_ACCOUNT>"}' \
  --i-understand-this-touches-mainnet
```

Record the `deposit_address` and `quote_id`. The swap row is now
`PENDING_DEPOSIT`. Nothing has moved yet.

## 3. Human deposit (the point of no return)

From YOUR wallet (not the backend), send exactly `reserve_amount` of
the reserve asset to `deposit_address`. Double-check:

- asset contract matches `reserve_asset_id`,
- amount matches to the base unit,
- you kept enough NEAR for gas.

## 4. Watch to terminal status

```bash
python3 flows.py --db intents.db watch --address <DEPOSIT_ADDRESS> \
  --timeout 900
```

Terminal states: `SUCCESS` (receipt stored in SQLite) or
`FAILED`/`REFUNDED`. On failure, funds go to `refund_to`
(`launchly_account`) — verify receipt there before retrying.

## 5. Reconcile

```bash
python3 keeper.py --db intents.db --launchly <LAUNCHLY_MAINNET_ACCOUNT> \
  reconcile
```

Confirm the swap row, quote row, and on-chain state agree. Paste the
report into `updates.md` as the mainnet proof entry.

## Abort / rollback

- Before step 3: do nothing. The `PENDING_DEPOSIT` row expires
  harmlessly; no funds moved.
- After step 3: you cannot cancel a 1Click swap. If `watch` reports
  failure, check the refund address, then re-run from step 2 with a
  fresh quote (quotes expire).
- Never re-send to an old `deposit_address`.
