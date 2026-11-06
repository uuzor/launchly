# Launchly contracts

Per-product memecoins on bonding curves whose trading fees fund creator
promotion pools. See `/HACKATHON.md` (rules) and `/IDEA.md` (full spec).

Three crates, one Cargo workspace:

| Crate | Account pattern | Purpose |
|---|---|---|
| `launchly` | `<main>` | Registry, coin factory, bonding curve, fee router, promo pools, vesting, milestone votes, Burrow vault |
| `launchly-token` | `p<id>.<main>` | NEP-141 token with minter-controlled supply (one instance per product) |
| `mock-burrow` | test-only | Burrow subset for sandbox tests (supply, Withdraw, fake interest, 1-unit spread, strict over-withdraw) |

Built with `near-sdk` 5.30 / `near-contract-standards` 5.30 (NEP-141 core,
NEP-145 storage, NEP-148 metadata), following
[nearbuilders.org/build](https://nearbuilders.org/build) →
[docs.near.org](https://docs.near.org/) (Rust SDK, factory pattern, sandbox
testing).

## Layout

```text
contracts/
├── Cargo.toml              # workspace (release profile lives here)
├── launchly/
│   ├── src/lib.rs          # main contract + unit tests
│   ├── src/curve.rs        # bonding-curve math (pure, unit-tested)
│   └── tests/
│       ├── e2e.rs          # sandbox end-to-end suite (real node, real txs)
│       └── vault_e2e.rs    # vault suite vs mock-burrow (gate, gain,
│                           #   shortfall recall, finalize + claim)
├── launchly-token/
│   └── src/lib.rs          # NEP-141 token + unit tests
└── mock-burrow/
    └── src/lib.rs          # test-only Burrow stand-in + unit tests
```

## Prerequisites

- Rust stable + `wasm32-unknown-unknown` target
- `cargo-near` (`cargo install cargo-near`, or the prebuilt installer from
  `near/cargo-near` releases)
- `near-cli-rs` (`near` binary) for testnet

## Build

```sh
cd contracts/launchly-token && cargo near build non-reproducible-wasm
cd ../launchly && cargo near build non-reproducible-wasm
# artifacts: contracts/target/near/<crate>/<crate>.wasm (+ ABI)
```

## Test

```sh
cd contracts
cargo test -p launchly-token --lib   # 9 unit tests
cargo test -p mock-burrow --lib      # 2 unit tests (supply, interest, guards)
cargo test -p launchly --lib         # 70 unit tests (curve math, state
                                     # machine, every callback's logic,
                                     # vault math + recall + settle paths)
cargo test -p launchly --test e2e    # sandbox: full loop on a local node
cargo test -p launchly --test vault_e2e  # sandbox: vault vs mock-burrow
```

The e2e suite builds both WASMs, boots a sandbox node, and runs the whole
economy with real cross-contract calls: deploy, fund, `set_token_wasm`,
create + launch ×2, buy, unregistered-buyer refund, sell, pause, post,
attest, rate (incl. ignored zero-balance rating), liveness confirm, yield
accrual, cycle finalize, dispute-window rejection, payout claim,
double-claim rejection, milestone release (lock-vote + unlock), fee claims
(incl. unregistered restore), vetoed milestone (lock-votes + unlocks),
tranche burn, and view checks.

## Testnet deploy (v4: anchors + guards, verified 2026-11-05)

Fresh deploy with product metadata anchors, founder-only launch, and
per-product post-URL uniqueness, verified live:

- `create_product` with `metadata_hash`/`rules_hash` → stored, returned
  by `get_product`, and emitted in the `product_created` NEP-297 event
- bad hash (`"ZZZ"`) rejected: "must be 64 lowercase hex chars or omitted"
- non-founder `launch_coin` rejected: "Only the founder can launch"
- founder launch → Live; buy works; post works; duplicate post URL
  rejected: "This URL was already submitted for this product"

Accounts:

- main: `launchlyv4-1105.testnet`
- reserve: `usdt.fakes.testnet` (6 decimals, mintable)
- product-1 coin: `p1.launchlyv4-1105.testnet`
- burrow: `contract.burrow.testnet`
- (older: `launchlyv3-1105.testnet` family — vault full loop incl.
  shortfall recall and $76.61 creator claim; product 1 there is the
  permanent "on-chain, no metadata" backend test case.
  `launchlyv2-1105.testnet` — pre-vault mock-USDT milestone loop.
  `launchlydev1105.testnet` is stale pre-attestation.)

```sh
export MAIN=launchlyv4-1105.testnet
export USDT=usdt.fakes.testnet   # Burrow-listed, mintable test USDT (6 dec)
export BURROW=contract.burrow.testnet
N=contracts/target/near

# 1. accounts (faucet sponsors the first)
near account create-account sponsor-by-faucet-service $MAIN \
  autogenerate-new-keypair save-to-keychain network-config testnet create
near account create-account fund-myself buyer.$MAIN '1 NEAR' \
  autogenerate-new-keypair save-to-keychain sign-as $MAIN \
  network-config testnet sign-with-keychain send

# 2. deploy + init, store token wasm
near contract deploy $MAIN use-file $N/launchly/launchly.wasm with-init-call new \
  json-args '{"owner":"'$MAIN'","ops_account":"'$MAIN'","verifier":"'$MAIN'"}' \
  prepaid-gas '100 Tgas' attached-deposit '0 NEAR' \
  network-config testnet sign-with-keychain send
python3 -c "import json;json.dump({'wasm':list(open('$N/launchly_token/launchly_token.wasm','rb').read())},open('/tmp/wasm_args.json','w'))"
near contract call-function as-transaction $MAIN set_token_wasm \
  file-args /tmp/wasm_args.json prepaid-gas '300 Tgas' attached-deposit '2 NEAR' \
  sign-as $MAIN network-config testnet sign-with-keychain send

# 3. vault wiring (one-way burrow address, then enable + register)
near contract call-function as-transaction $MAIN set_vault_burrow \
  json-args '{"burrow":"'$BURROW'"}' prepaid-gas '100 Tgas' attached-deposit '0 NEAR' \
  sign-as $MAIN network-config testnet sign-with-keychain send
near contract call-function as-transaction $MAIN set_vault_enabled \
  json-args '{"enabled":true}' prepaid-gas '100 Tgas' attached-deposit '0 NEAR' \
  sign-as $MAIN network-config testnet sign-with-keychain send
near contract call-function as-transaction $MAIN vault_register \
  json-args '{}' prepaid-gas '100 Tgas' attached-deposit '0.15 NEAR' \
  sign-as $MAIN network-config testnet sign-with-keychain send

# 4. fund a buyer with fakes USDT (open mint after storage registration)
near contract call-function as-transaction $USDT storage_deposit json-args '{}' \
  prepaid-gas '100 Tgas' attached-deposit '0.01 NEAR' \
  sign-as buyer.$MAIN network-config testnet sign-with-keychain send
near contract call-function as-transaction $USDT mint \
  json-args '{"account_id":"buyer.'$MAIN'","amount":"50000000000"}' \
  prepaid-gas '100 Tgas' attached-deposit '0 NEAR' \
  sign-as buyer.$MAIN network-config testnet sign-with-keychain send

# 5. create + launch product 1, buy on the curve
near contract call-function as-transaction $MAIN create_product \
  json-args '{"name":"V4 Gadget","symbol":"VG4","description":"v4 anchored product","demo_url":"https://example.com/v4","metadata_hash":"0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef","rules_hash":"0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef","reserve_token":"'$USDT'","reserve_decimals":6,"fee_bps":100,"curve_p0":"100","curve_rise":"9900","min_vote_holding":"1000000000000000000","max_posts_per_creator":5,"cycle_duration_ns":600000000000,"dispute_duration_ns":300000000000,"milestone_window_ns":300000000000,"milestone_deadline_ns":600000000000}' \
  prepaid-gas '300 Tgas' attached-deposit '1 NEAR' \
  sign-as $MAIN network-config testnet sign-with-keychain send
# attach exactly get_launch_cost (e.g. 1781130000000000000000000 = 1.78113 NEAR)
near contract call-function as-transaction $MAIN launch_coin \
  json-args '{"product_id":1}' prepaid-gas '300 Tgas' \
  attached-deposit '1.78113 NEAR' \
  sign-as $MAIN network-config testnet sign-with-keychain send
near contract call-function as-transaction $MAIN complete_launch \
  json-args '{"product_id":1}' prepaid-gas '300 Tgas' attached-deposit '0 NEAR' \
  sign-as $MAIN network-config testnet sign-with-keychain send
near contract call-function as-transaction p1.$MAIN storage_deposit json-args '{}' \
  prepaid-gas '100 Tgas' attached-deposit '0.01 NEAR' \
  sign-as buyer.$MAIN network-config testnet sign-with-keychain send
near contract call-function as-transaction $USDT ft_transfer_call \
  json-args '{"receiver_id":"'$MAIN'","amount":"5000000000","msg":"{\"Buy\":{\"product_id\":1,\"min_tokens_out\":\"1\"}}"}' \
  prepaid-gas '300 Tgas' attached-deposit '1 yoctoNEAR' \
  sign-as buyer.$MAIN network-config testnet sign-with-keychain send

# 5b. vault: rebalance deploys ~70% once eligible passes $1,000
near contract call-function as-transaction $MAIN vault_rebalance \
  json-args '{"product_id":1}' prepaid-gas '300 Tgas' attached-deposit '0 NEAR' \
  sign-as buyer.$MAIN network-config testnet sign-with-keychain send
near contract call-function as-read-only $MAIN get_vault_position \
  json-args '{"product_id":1}' network-config testnet now
near contract call-function as-read-only $BURROW get_account \
  json-args '{"account_id":"'$MAIN'"}' network-config testnet now

# 6. post → attest → liveness → finalize → claim (waits depend on durations)
near contract call-function as-transaction $MAIN submit_post \
  json-args '{"product_id":1,"url":"https://x.com/buyer/status/1","linked_account":"@buyer"}' \
  prepaid-gas '100 Tgas' attached-deposit '0.1 NEAR' \
  sign-as buyer.$MAIN network-config testnet sign-with-keychain send
near contract call-function as-transaction $MAIN attest_post \
  json-args '{"post_id":1,"valid":true,"score":90,"post_hash":"<sha256-of-content>"}' \
  prepaid-gas '100 Tgas' attached-deposit '0 NEAR' \
  sign-as $MAIN network-config testnet sign-with-keychain send
near contract call-function as-transaction $MAIN confirm_liveness \
  json-args '{"product_id":1,"cycle_id":1,"confirmations":[{"post_id":1,"live":true}]}' \
  prepaid-gas '100 Tgas' attached-deposit '0 NEAR' \
  sign-as $MAIN network-config testnet sign-with-keychain send
# ... wait for cycle end ...
near contract call-function as-transaction $MAIN finalize_cycle \
  json-args '{"product_id":1}' prepaid-gas '300 Tgas' attached-deposit '0 NEAR' \
  sign-as $MAIN network-config testnet sign-with-keychain send
# ... wait out the dispute window ...
near contract call-function as-transaction $MAIN claim_payout \
  json-args '{"product_id":1,"cycle_id":1}' prepaid-gas '300 Tgas' \
  attached-deposit '0 NEAR' \
  sign-as buyer.$MAIN network-config testnet sign-with-keychain send

# 7. milestone → lock-vote → release → unlock
near contract call-function as-transaction $MAIN publish_milestone \
  json-args '{"product_id":1,"evidence_url":"https://demo.example/v2","evidence_hash":"0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"}' \
  prepaid-gas '300 Tgas' attached-deposit '0.1 NEAR' \
  sign-as $MAIN network-config testnet sign-with-keychain send
BAL=$(near contract call-function as-read-only p1.$MAIN ft_balance_of \
  json-args '{"account_id":"buyer.'$MAIN'"}' network-config testnet now \
  | grep -o '[0-9]\{10,\}' | head -1)
python3 -c "import json;json.dump({'receiver_id':'$MAIN','amount':'$BAL','msg':json.dumps({'Vote':{'product_id':1,'index':0,'approve':True}})},open('/tmp/vote_args.json','w'))"
near contract call-function as-transaction p1.$MAIN ft_transfer_call \
  file-args /tmp/vote_args.json prepaid-gas '300 Tgas' \
  attached-deposit '1 yoctoNEAR' \
  sign-as buyer.$MAIN network-config testnet sign-with-keychain send
# ... wait for the window to pass ...
near contract call-function as-transaction $MAIN finalize_milestone \
  json-args '{"product_id":1,"index":0}' prepaid-gas '300 Tgas' \
  attached-deposit '0 NEAR' \
  sign-as $MAIN network-config testnet sign-with-keychain send
near contract call-function as-transaction $MAIN unlock_vote \
  json-args '{"product_id":1,"index":0}' prepaid-gas '300 Tgas' \
  attached-deposit '0 NEAR' \
  sign-as buyer.$MAIN network-config testnet sign-with-keychain send
```

## Method reference (main contract)

Change methods: `new`, `create_product`, `set_token_wasm`, `get_launch_cost`
(view), `launch_coin`, `complete_launch`, `retry_launch`, `ft_on_transfer`
(Buy/Sell/Vote via `ft_transfer_call`), `claim`, `submit_post`,
`attest_post`, `confirm_liveness`, `rate_post`, `finalize_cycle`,
`claim_payout`, `hold_payout`, `publish_milestone`, `unlock_vote`,
`finalize_milestone`, `burn_unclaimed_tranche`, `accrue_yield`,
`set_vault_burrow`, `set_vault_enabled`, `set_vault_min_start`,
`set_vault_asset_scale`, `vault_clear_busy`, `vault_reconcile`,
`vault_register`, `vault_rebalance`, `vault_withdraw`,
`vault_emergency_withdraw`, `drain_pending`, `set_verifier`,
`set_ops_account`, `set_owner`, `pause`.
Views: `get_config`, `get_product`, `list_products`, `get_pool`,
`get_post`, `list_cycle_posts`, `get_payout`, `get_claimable`,
`get_milestone`, `get_vote_lock`, `get_buy_quote`, `get_sell_quote`,
`get_vault_position`.

Voting: milestone votes lock product tokens (`ft_transfer_call` with
`{"Vote":{"product_id":N,"index":I,"approve":B}}`). Weight is linear in the
locked amount, capped at 5% of the publish-time snapshot (excess refunded
at once); `unlock_vote` returns the lock after finalize. Attestation,
liveness, and cycle-close emit NEP-297 events.

## Frozen ABI (v4 — backend and UI sync against this)

Deployed at `launchlyv4-1105.testnet`. Argument names and JSON shapes
below are stable; any change requires a new deploy + a version bump here.
`u128`/`U128` values serialize as decimal strings. `Option<T>` serializes
as `T | null` and may be omitted only where marked.

Registry (PRODUCT-BACKED CORE — see `intents/backend.md` §4.5):

- `create_product(name: string[1..64], symbol: string[1..16],
  description: string[..4000], demo_url: string[..500],
  metadata_hash?: 64-hex|null, rules_hash?: 64-hex|null,
  reserve_token: AccountId, reserve_decimals: u8[..24],
  fee_bps: u16[50..200], curve_p0: U128[1..1e12], curve_rise: U128,
  min_vote_holding: U128, max_posts_per_creator: u8,
  cycle_duration_ns: u64, dispute_duration_ns: u64,
  milestone_window_ns: u64, milestone_deadline_ns: u64) -> u64`
  payable (storage, excess refunded). Caller becomes founder.
- `launch_coin(product_id: u64)` — founder only, exact `get_launch_cost()`.
- `complete_launch(product_id: u64)` / `retry_launch(product_id: u64)` —
  permissionless completion, registered params only.
- `get_product(product_id: u64) -> Product|null`
- `list_products(from_index: u64, limit: u64) -> Product[]`

`Product`: `{founder, name, symbol, description, demo_url,
metadata_hash: string|null, rules_hash: string|null, reserve_token,
reserve_decimals, fee_bps, curve_p0, curve_rise, min_vote_holding,
max_posts_per_creator, cycle_id, cycle_end_ns, launched_at_ns,
status: "Created"|"Launching"|"Live", token_account: AccountId|null,
curve_sold: U128, curve_reserve: U128, founder_locked: U128,
founder_minted: bool, next_milestone: u8, last_yield_ns}`.

Trading: `ft_on_transfer` receiver with
`{"Buy":{"product_id","min_tokens_out"}}` /
`{"Sell":{"product_id","min_reserve_out"}}` /
`{"Vote":{"product_id","index","approve"}}` via `ft_transfer_call`;
`claim(token_id)`; quotes `get_buy_quote(product_id, reserve_in)`,
`get_sell_quote(product_id, tokens_in)`.

Posts / cycles: `submit_post(product_id, url[8..500], linked_account)
-> u64` (URL unique per product; the returned id also rides on the
`Post` struct so list views are actionable); `attest_post(post_id, valid, score,
post_hash)`; `confirm_liveness(product_id, cycle_id, confirmations[])`;
`rate_post(post_id, score)`; `finalize_cycle(product_id)`;
`claim_payout(product_id, cycle_id)`; `hold_payout(product_id, cycle_id,
creator, hold, reason_hash)`; views `get_pool`, `get_post`,
`list_cycle_posts`, `get_payout`, `get_claimable`.

Milestones: `publish_milestone(product_id, evidence_url[8..500],
evidence_hash?: 64-hex|null) -> u8`; `unlock_vote(product_id, index)`;
`finalize_milestone(product_id, index)`; `burn_unclaimed_tranche(...)`;
views `get_milestone`, `get_vote_lock`. `Milestone` carries
`evidence_hash: string|null`.

Vault: `set_vault_burrow` (one-way), `set_vault_enabled`,
`set_vault_min_start`, `set_vault_asset_scale`, `vault_clear_busy`,
`vault_reconcile`, `vault_register` (payable), `vault_rebalance`,
`vault_withdraw(product_id, amount?: U128|null)`,
`vault_emergency_withdraw`, `drain_pending`; view `get_vault_position`.

Admin/views: `set_verifier`, `set_ops_account`, `set_owner`,
`pause(bool)`; `get_config`.

NEP-297 events (`EVENT_JSON`, standard `nep297`): `product_created`
(incl. `metadata_hash`, `rules_hash`), `attest_post`,
`confirm_liveness`, `cycle_finalized`, `milestone_published` (incl.
`evidence_hash`), `vault_deposit_started`, `vault_deposited`,
`vault_withdrawn` (incl. `gain`), `vault_shortfall`, `pending_paid`,
`vault_recall`, `vault_reconcile_needed`. (Post submission, claims,
and milestone finalization use plain `log!` lines, not events.)

## Design notes (deviations from IDEA.md, all covered by tests)

- **Two-tx launch.** Deploy+init and registration+mint are split across
  `launch_coin` / `complete_launch`: the full callback chain exceeds the
  300 Tgas per-tx limit (each step re-reads the ~170 KB stored wasm).
- **Lock-to-vote (milestones).** Instead of publish-time snapshots
  (checkpointing: future work), voters lock tokens until the window ends, so
  buy-vote-sell is impossible and no async balance check is needed. Weight is
  linear in the locked amount with the 5%-per-wallet cap, founder exclusion,
  and 10% veto quorum enforced. Linear (not quadratic) is deliberate: with
  token balances, square roots reward splitting across wallets, which the cap
  cannot stop.
- **Vote-time balances (post ratings only).** Rating weights still check
  `ft_balance_of` when the vote lands. This is the known weaker path: a
  rater can buy, rate, and sell. Impact is bounded — ratings only move a
  0.5x–1.5x multiplier on the verifier's 0–100 score — so lock-to-vote was
  spent on the trust-critical milestone path instead.
- **Resolver refunds.** Buy/sell settlement callbacks return the NEP-141
  unused amount (`U128`), so `ft_resolve_transfer` refunds failures; no ad-hoc
  refund transfers that could fail or double-pay.
- **Rounding dust** (buy leftover, fee-split remainders) accrues to the
  current cycle pool; cycle-finalize dust rolls into the next cycle.
- **`accrue_yield` is simulated** (fixed 5% APR on half the pool) and logs
  `SIMULATED` every call — and it switches off per product once real
  vault funds are deployed. The UI must label simulated yield until the
  real adapter ships.
- **Vault (Burrow supply).** Idle reserve deploys above a $1,000 gate
  (per-product override), max 70% with a 30%/$200 liquid buffer; measured
  proceeds only, gain to the current pool; sell shortfalls queue +
  recall automatically; one op per product; full-withdraw normalization
  (`amount: null` at/above principal) because Burrow share dust refuses
  exact-principal partials. See `/yield.md`.
- **Sell chains must not fail.** The burn commits before the payout
  chain runs, so a downstream failure would make the NEP-141 resolver
  refund the seller from the locked founder allocation. Sell-path
  callbacks are panic-free and gas-sized with measured margin; the
  vault e2e shortfall path exercises the deepest chain.
- Launch deposits are **exact and queryable** (`get_launch_cost`), so no
  excess NEAR is ever locked in the keyless token sub-account.
- **Founder-only `launch_coin`.** The method takes no free parameters
  (every rule fixes at `create_product`), so third-party launch could
  never change anything — but the guard removes even timing grief.
  `complete_launch` stays permissionless (registered params only).
- **URLs unique per product.** The chain rejects a reposted URL up
  front; the backend verifier still dedupes by content hash for
  re-uploads under different URLs.
