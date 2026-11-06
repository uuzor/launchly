# Launchly roadmap

Seeded from the 2026-11-06 frontend gap analysis (vs four.meme, Product Hunt).

## P0 — Wallet + real execution (shipped, needs real-wallet E2E)

- [x] NEAR Wallet Selector: connect/disconnect, testnet, account in header
- [x] Real buy/sell on the bonding curve (wallet-signed, live balances,
  faucet + storage setup, slippage-protected)
- [x] Submit-post flow: validate → sign `submit_post`
- [x] Claim button on creator pages (own account)
- [x] Signed milestone voting (token weight, founder-blocked)
- [x] Founder in-app signing: `create_product` / `launch_coin` /
  `complete_launch` / `publish_milestone` from the wizard + product pages
- [x] E2E pass (2026-11-06): headless UI 15/15 + on-chain 15/15 with funded
  `launchly-e2e-1106.testnet` (key in `launchly-e2e.testnet.json`, gitignored).
  Covered: connect modal, buy, sell, submit, rate/claim rejections, full
  founder flow (pids 7–8), milestone publish, vote refund. Fixed: buffer/global
  shims, missing `live` flags, faucet removal, v10 NAJ action instances +
  signerId (all 13 builders pass the real selector converter). Remaining:
  interactive sign + disconnect with a real wallet app (needs a human click).
- [ ] Creator endpoint latency (27s page loads: earnings fan-out is
  O(products × cycles) sequential RPC views — cache or parallelize)
- [x] One-click testnet USDT onboarding: `FaucetButton` in header (next to
  wallet) + trade panel zero-state; wraps NEAR and swaps on Ref pool 34
  with live quotes and slippage guard. Builders proven on-chain
  (0.5 NEAR → 399M test USDT at test-pool rates).

## P1 — Intents + chat depth

- [ ] Wire `IntentsQuoteCard` to real `POST /quotes/payin|payout`
- [ ] Cross-chain deposit + swap execution (1Click live when `/v0/quote`
  recovers; human approval before any mainnet value moves)
- [ ] Chat on coin pages + dashboard, suggested questions, markdown replies,
  visible `tools_used`, persisted history

## P2 — Engagement (Product Hunt layer)

- [ ] Per-product discussion threads + maker replies
- [ ] Leaderboard with time-weighted ranking + daily badges
- [ ] Watchlist/follow persistence + notifications (cycle close, payouts)
- [ ] Creator reputation surface (score history, badges)

## P3 — Market depth (four.meme layer)

- [ ] Holders list + real trade history + volume/fees history (indexer)
- [x] Discover stats without redeploy: keeper-cached posts/creators counts,
  32-pt sparklines, change-24h (needs 24h snapshots — live ~tomorrow),
  volume/fees-24h estimated from 5-min reserve deltas (exact for
  single-trade intervals; labelled as estimates).
- [ ] HOLD (after user verifies frontend executions): v6 contract with
  trade events + cumulative counters + token-side holder tracking for
  exact volume/fees/holders, then re-run sim (no testnet holder API
  exists; FastNEAR covers mainnet only)
- [ ] Curve graduation: threshold event + Ref pool migration path
- [ ] Landing page wired to live data; global search palette
- [ ] Curve-completion urgency UI (progress, about-to-graduate)

## Later / out of scope for now

- Paid x402 product reports; promo-video generation
- Platform-sponsored launch flow; meta-tx broadcast signer
- Mainnet treasury + audit; real social fetchers; investment-advice review
