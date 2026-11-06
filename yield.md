# Real yield: Burrow supply adapter (shipped)

Status: implemented, tested, and verified live on testnet (2026-11-05).
The prototype's simulated vault (`accrue_yield`, labeled `SIMULATED`) stays
for products with nothing deployed, and switches off per product as soon as
real funds are deployed.

## Why Burrow (and not Ref)

- **Single-sided.** Supplying needs only the pool's USDT. Ref LP needs two
  tokens (verified: `add_liquidity` mints on the minimum proportional
  increase of *both* reserves), forcing a swap of half the pool plus IL.
- **No liquidation risk.** We only ever deposit and withdraw. Collateral and
  borrow actions are never used.
- **Live on both networks.** Testnet `contract.burrow.testnet` is fully
  deployed with `usdt.fakes.testnet` enabled (`can_deposit/can_withdraw:
  true`, verified on-chain). Mainnet `contract.main.burrow.near` holds ~$12.6M
  USDT at 85.68% utilization (Rhea Lend: $158M TVL, ~9.27% avg supply APY).
- **Testnet caveat (honest):** testnet USDT has ~no borrowers, so testnet
  yield is ~0. Testnet proves deposit/withdraw mechanics and accounting;
  the README quotes mainnet venue stats for the yield itself.

## What is deployed (per product)

Eligible liquidity = `curve_reserve` (trade backing) + current cycle
`pool.balance` (creator fees). Both pots count; all measured yield credits
the current cycle pool ("idle trading liquidity pays creators").

| Rule | Value |
|---|---|
| Start gate | eligible ≥ $1,000 (default; per-product owner override for demos) |
| Below gate | full unwind — yield only runs above the gate, both directions |
| Deployment cap | 70% of eligible |
| Liquid buffer | max(30% of eligible, $200 absolute floor) stays liquid |
| Dust guard | ops below $10 are skipped (except queue-driven recalls) |
| Yield destination | current cycle pool, measured not trusted |

Thresholds are USD notional converted via the product's own
`reserve_decimals` — the reserve IS a stablecoin, so no oracle is needed.

## Fluid mechanics

**Deposit (permissionless keeper `vault_rebalance`).** Computes room under
the 70% cap and the buffer floor; supplies to Burrow via `ft_transfer_call`
with an empty message (plain deposit, no actions). Priority each call:
recorded recall first, then below-gate unwind, then deposit, then trim of
over-deployed excess. No-op with a log when balanced — safe to fire after
every sell/claim/finalize.

**Sell fast path.** Sells pay from the liquid buffer immediately, no extra
hop. This is the 99% case.

**Sell shortfall → automatic recall.** If a sell payout transfer fails while
the vault holds funds, the contract checks the seller's registration:
registered sellers get a queued `PendingPayout` + recorded recall (their
tokens are already burned — the payout must not vanish); unregistered
sellers get the classic claimable hold. The next keeper `vault_rebalance`
withdraws and auto-pays the head of the queue; `drain_pending` (one payout
per call, works while paused) clears the rest.

**Finalize pre-unwind.** `finalize_cycle` records a recall for whatever the
newly owed payouts exceed estimated liquid, and starts the withdraw inline
when idle — the dispute window doubles as the unwind window. Never blocks
finalization: when busy, the recall is recorded and the next keeper call
picks it up.

**Creator-claim shortfall.** A failed `claim_payout` transfer unmarks the
claim (retryable), restores owed, records recall, and starts the unwind
when idle.

**Measured proceeds.** Burrow pays withdrawals via plain `ft_transfer` with
no receiver callback, so every withdraw measures our USDT balance around
the `execute{Withdraw}` call. Gain = proceeds above withdrawn principal →
pool. Shortfall (Burrow share-rounding dust, observed: 1 unit) is absorbed
by the pool ledger, never by users.

**Full-withdraw normalization.** Burrow refuses a partial for
exactly-principal (our shares are worth dust less). Every withdraw path
therefore sends `amount: null` (withdraw max) whenever the request reaches
principal. Found live on testnet; covered by a strict mock + regression
test.

**One op per product.** A busy flag serializes deposit/withdraw per
product. If the post-withdraw balance read ever fails (funds uncertain),
busy stays set and the owner recovers with `vault_clear_busy` +
`vault_reconcile` from an off-chain `get_account` reading.

**Gas discipline.** Every callback's budget covers its own execution plus
the promises it creates; one withdraw per tx, one pending payout per call,
no in-tx chaining — the keeper loops. A failed sell chain would make the
NEP-141 resolver refund from the locked founder allocation, so sell-path
callbacks are panic-free and gas-sized with measured margin (see the
SAFETY comment on `on_sell_burned`).

## Burrow mechanics used (from `ref-finance/burrowland` source)

- **Supply:** `ft_transfer_call` USDT → Burrow with **empty msg** = plain
  deposit into our account's `supplied` balance (no actions run). Burrow
  scales by the asset's `extra_decimals` (12 for fakes USDT → 18 total).
- **Withdraw:** `execute({actions: [{Withdraw: {token_id, amount,
  max_amount}}]})` with exactly 1 yocto. `amount: null` withdraws our
  whole position; partials are in internal units (ft × 10^scale, scale
  owner-set per token, default 12). Proceeds arrive by plain `ft_transfer`
  (no receiver callback), so we measure them, not trust them.
- **Account:** our contract `storage_deposit`s once on Burrow (0.1 NEAR).
- **Never used:** `IncreaseCollateral`, `DecreaseCollateral`, `Borrow`,
  `Repay`, farms, margin. No debt, no liquidation, no oracle dependence.

## Contract surface (`contracts/launchly`)

Owner: `set_vault_burrow` (one-way), `set_vault_enabled`,
`set_vault_min_start`, `set_vault_asset_scale`, `vault_clear_busy`,
`vault_reconcile`, `vault_emergency_withdraw` (full unwind, works while
disabled — the shutdown path is disable → withdraw per product).
Permissionless: `vault_register` (payable, 0.1 NEAR), `vault_rebalance`,
`vault_withdraw`, `drain_pending`. View: `get_vault_position`.
Events (NEP-297): `vault_deposit_started`, `vault_deposited`,
`vault_withdrawn` (with gain), `vault_shortfall`, `pending_paid`,
`vault_recall`, `vault_reconcile_needed`.

## Testnet verification (2026-11-05)

Deployed `launchlyv3-1105.testnet`, product 1 on `usdt.fakes.testnet`
(mintable: storage-deposit then open `mint`), Burrow
`contract.burrow.testnet`:

- Gate: $498.50 eligible → rebalance noop, principal 0.
- Buy $5,000 → rebalance → principal exactly 70% ($3,838.45), Burrow
  `get_account` shows the supplied position.
- Partial withdraw $500 → principal down exactly $500 (scale-12 math).
- Full withdraw → principal 0, Burrow `supplied: []`.
- Re-deposit → sell-all ($5,390.55 net > ~30% liquid) → queued +
  recall recorded; keeper rebalance → full withdraw (1-unit dust
  absorbed, in logs) → seller paid exactly $5,390.55, queue/recall empty.
- Post → attest → liveness → finalize → $76.61 pool to creator →
  claim after dispute: full loop with the vault live.

Testnet yield ≈ 0 (no borrowers) — the runs prove mechanics and exact
accounting; mainnet venue stats (~9% USDT supply APY) are quoted for the
yield itself.

## Risks and non-goals

- Testnet Burrow could be upgraded or paused; failed executes keep recall
  and retry cleanly, and the owner can disable + emergency-withdraw.
- Full utilization on a venue would refuse large withdraws; the buffer +
  queue + recall absorb this, and partials size down. Mainnet USDT ran at
  ~85% utilization (withdrawable).
- No auto-compounding keeper in v1: deposits/withdrawals are keeper/UI
  transactions (`vault_rebalance` after sells is the pattern). A keeper
  bot is future work.
- Mainnet deployment needs the full legal/security review in IDEA.md
  section 8; this adapter targets testnet only.
