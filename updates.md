# Launchly — Build Status

Last updated: 2026-11-05. Dev ends 2026-11-14T23:59:00Z.

## What we have built

### Smart contracts (`contracts/`) — done, tested, deployed on testnet
- `launchly`: bonding-curve launches, buy/sell, graduation, proposals, linear
  lock-to-vote milestones (5% cap, founder excluded), one-shot verifier
  attestation + liveness-gated payouts, pause/ops-claim flow, and the
  **Burrow supply vault** (phases 1+2): $1,000 start gate (per-product
  override), 70% deployment cap, 30%/$200 liquid buffer, keeper
  `vault_rebalance`, sell-shortfall queue + automatic recall, finalize
  pre-unwind during the dispute window, measured proceeds with gain to the
  current pool, full-withdraw normalization (Burrow share dust refuses
  exact-principal partials — found live, fixed, regression-tested).
  - Two-tx launch (`launch_coin` / `complete_launch`): the full callback chain
    exceeded the 300 Tgas limit, so launch is split by design.
  - NEP-141 resolver refunds the unused amount via returned `U128`; the
    deposit callback reads the resolver's USED amount (NEP-141 convention).
  - Sell chains are infallible by construction: a downstream failure after
    the burn would refund from the locked founder allocation (resolver
    mechanics) — callbacks are panic-free, gas-sized with measured margin.
  - Simulated yield (`accrue_yield`) stays for undeployed products and
    switches off per product once real funds deploy.
- `launchly-token`: NEP-141 memecoin token (manual core/resolver/storage impls;
  near-contract-standards 5.30 macros were broken).
- `mock-burrow` (test-only): Burrow subset with fake interest, 1-unit supply
  spread, and strict over-withdraw — mirrors real Burrow dust behavior.
- Tests green: 75 + 9 + 2 unit tests, full sandbox e2e (`full_loop_release_path`
  incl. hash anchors + evidence hash) plus vault e2e (`vault_loop_with_shortfall`:
  gate, ~70% deposit, measured 5% mock gain, explicit-principal regression,
  sell-all shortfall → recall → exact auto-pay, finalize + claim with vault active).
- v4 (current): product metadata anchors (`metadata_hash`/`rules_hash` on
  `create_product`, `evidence_hash` on milestones — optional, 64 lowercase
  hex, in state + views + NEP-297 events), founder-only `launch_coin`
  (`launch_coin` takes no free parameters — all rules fix at creation — so
  the guard removes timing grief, not param front-running), per-product
  post-URL uniqueness. Deployed fresh (state schema changed — no migration):
  - `launchlyv4-1105.testnet` (factory) + `p1.launchlyv4-1105.testnet`
    (fakes-USDT reserve, launched with real hashes)
  - Verified live: hashes stored/returned/emitted; bad hash rejected;
    non-founder launch rejected; founder launch → Live; buy works;
    duplicate post URL rejected.
  - Contract interface frozen in `contracts/README.md` ("Frozen ABI (v4)")
    for backend/UI sync. No dashboard config exists yet; backend `.env`
    comes with `intents/backend.md` step 5.
- v3 (vault proof, superseded): `launchlyv3-1105.testnet` family — full
  vault loop verified live (gate, 70% deploy, exact partial/full
  withdraws, $5,390.55 shortfall recall, $76.61 creator claim). Product 1
  there is the permanent "on-chain, no metadata" backend test case.
  Testnet Burrow USDT yield ≈ 0 (no borrowers): mechanics + exact
  accounting proven; mainnet venue stats (~9% supply APY) quoted.
  (`launchlyv2-1105.testnet` is the pre-vault milestone loop;
  `launchlydev1105.testnet` is stale.)

### Intents 1Click adapter (`intents/`) — code done, live quotes blocked
- `adapter.py`: stdlib-only client for `GET /v0/tokens`, `POST /v0/quote`,
  `POST /v0/deposit/submit`, `GET /v0/status` + polling; `payin_quote` /
  `payout_quote` flows per IDEA.md 5.1/5.2. Dry-by-default, explicit
  `allow_live` gate for human-approved swaps.
- `test_adapter.py`: 10/10 green (mocked HTTP). `demo.py`: live dry-quote demo.
- Live status (re-checked 2026-11-05 ~21:49 UTC): token list works (215
  assets, correct mainnet IDs); `/v0/status` healthy; **`/v0/quote` still
  returns "Internal server error" for every route including the verbatim
  docs example (now HTTP 400, was HTTP 500)** — a 1Click backend outage,
  not an adapter bug. Integration findings fixed: descriptive User-Agent
  (Cloudflare 1010), origin-chain `refundTo` (EVM 0x for Ethereum-origin
  assets).

### Docs
- `HACKATHON.md`, `IDEA.md` (spec), `contracts/README.md` (v3 deploy),
  `yield.md` (shipped adapter design + testnet proof).

## What is left

1. **Intents live verification** (blocked on 1Click): re-run
   `python3 intents/demo.py` when `/v0/quote` recovers; then a tiny
   human-approved mainnet swap. Optional: register for a JWT at
   partners.near-intents.org (docs say fee-only, untested).
2. **Dashboard / UI**: no frontend exists yet. Key views: `get_vault_position`
   (principal/queue/recall/gate), pool balances, payouts, milestone status;
   keeper pattern is `vault_rebalance` after sells + `drain_pending` polling.
3. **Repo hygiene**: root README, LICENSE.
4. **Known contract gaps**: post ratings still use vote-time `ft_balance_of`
   (bounded 0.5x–1.5x effect — documented deviation; milestones use
   lock-to-vote). Keeper bot for `vault_rebalance` is future work (manual/UI
   triggered for now). (Pool pays creators only — no other spending path.)

## Suggested order
Intents re-check (cheap, when API recovers) → UI → README/LICENSE →
contract gaps as time allows.

## 2026-11-06 — frontend live + dashboard wired (done)

- Unzipped the Base44 export into `frontend/`, removed dead template deps
  (`@tanstack/ai*`, stripe), stubbed the missing `base44()` plugin and
  `base44:document` virtual module, added the `@` alias. `npm run dev` on
  :5173, `npm run build` green, all routes 200.
- Backend: `product_feed` now passes full `chain` state through so the UI can
  read curve/pool/fee facts (additive, tests still green).
- New `frontend/src/lib/launchly.js`: API client + mappers + hooks for
  products, quotes, charts, posts, milestones, votes, creators, drafts, chat.
  Live-first with demo fallback; every page carries a Live/Simulated badge.
- Wired: discover, markets, coin detail (live chart + quote-backed trade
  panel; created missing `TradePanel.jsx`), product detail (live posts,
  milestones, chat widget), creator directory + profiles (earnings chart,
  payout prefs, social link), dashboard (live pools, verifier queue),
  launch wizard (real draft create → upload → finalize with backend hashes).
- Fixed along the way: price formula (extra ÷10⁶), sell-quote key
  (`net_proceeds`), agent restart with `LAUNCHLY_CONTRACT` (chat reads chain).
- Suites: contracts 76, backend 113, agents 55 — all green. Stack live:
  :5173/:8090/:8091. Root README + MIT LICENSE written.

## What is left (updated)

1. **Intents live verification** (blocked on 1Click): re-run
   `python3 intents/demo.py` when `/v0/quote` recovers; then a tiny
   human-approved mainnet swap.
2. **Demo rehearsal**: walk the founder → trader → creator loop on the live
   dashboard before recording.
3. **Known contract gaps**: post ratings still use vote-time `ft_balance_of`
   (bounded 0.5x–1.5x effect — documented deviation; milestones use
   lock-to-vote).

## 2026-11-06 — Faucet USDT registration + real position panel (prod)

- **Faucet "not registered" fix**: `usdt.fakes.testnet` requires storage before it
  can receive tokens. FaucetButton now checks `storage_balance_of` on the USDT
  contract and registers first (one-time, extra wallet approval). Same guard
  added to the claim flow on creator pages (payouts land as USDT).
- **Real position panel** (`components/coin/PositionPanel.jsx`): coin page now
  shows live on-chain `ft_balance_of` for the product token + USDT when a
  wallet is connected, refreshing after each on-chain trade; falls back to the
  simulated fills panel when disconnected.
- **Deploy notes (corrected)**: prod serves from `/opt/launchly/frontend/dist`
  (SSR: `dist/client` + `dist/server`) via `launchly-web.service` on
  127.0.0.1:3000, NOT `/var/www/launchly` or :5173. SSH as `root@` with
  `launchly-deploy` (the `launchly` user does not exist on the box; files are
  owned by `linuxuser`). Deploy = upload dist tarball, extract over
  `/opt/launchly/frontend/dist`, `systemctl restart launchly-web`.
- Build 0, lint clean, headless position-panel check PASS, prod verified
  (new strings in client+server bundles, /coins/ZED 200, /api/health ok).

## 2026-11-06 — Creator slice 1: claims, latency, dispute countdown (prod)

- **Claimed vs claimable (was: claimed rows showed a failing Claim button)**:
  the contract keeps the payout entry after claiming and exposes no claimed
  view, so the frontend now POSTs each claim receipt to
  `POST /creators/{account}/claims`; the backend verifies it via
  `EXPERIMENTAL_tx_status` (signer == creator, receiver == contract, single
  `claim_payout` with matching args, success everywhere, no
  `payout_restored_register_and_retry` log) and records it in SQLite.
  Entries render Claimed ✓ (explorer link), "Available in Xh" during the
  dispute window, or Claim when open. Payout history is now real (verified
  claims); Pending = finalized-but-unclaimed, Lifetime paid = verified
  claims. Claims made before this feature (or outside the UI) are
  unknowable on-chain and show a graceful "Already claimed" message.
- **Latency (was: 14.2s per earnings call)**: creator posts/earnings now
  fan out RPC in parallel (`ThreadPoolExecutor`, stdlib) and cache
  finalized cycles (pool+posts+payouts) in SQLite forever — finalized
  data is immutable. Prod: 14.2s -> 3.8s cold / 2.5s warm for earnings,
  1.1s for posts. All sqlite access stays on the request thread.
- **Live verification**: permissionless `finalize_cycle(1)` executed on
  v5 (tx 3JxuSXrgpWBAEm5yJBxRzhzBtjpiJTXkUcVxMHdpKM7K, total_score 0 so
  no payouts); report endpoint verified live against that real tx
  (correctly rejected: not a claim_payout). Full claim loop still needs
  the verifier key (owner == launchlyv5-1105.testnet, key not on disk),
  so Claimed ✓ / countdown states are backend-test-covered, awaiting
  the first real payout for live observation.
- **Deploy gotcha fixed**: a fresh `npm run build` without env bakes in
  `http://localhost:8090`, breaking client-side fetches (creator pages
  failed with CORS). Always build with
  `VITE_LAUNCHLY_API=/api VITE_LAUNCHLY_AGENT=/agent`. Caught by the
  headless creator-page check, fixed, redeployed, all sections render.
- Tests: 127 Python green (5 new: cache store test, earnings fields,
  cache RPC counting, claim report accept+idempotence, 6-way reject).
  Frontend build 0, eslint 0, headless creator page PASS, no errors.
