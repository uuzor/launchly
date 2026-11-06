# Launchly — community-funded growth for products

Launch a product, launch its coin. Trading fees fund the pool that pays the
community for promoting it.

Each product gets its own coin on a bonding curve (no platform-wide token).
Every trade pays a fixed fee; 70% flows into that product's promotional pool.
Creators post about the product, a rules engine + agent verifier scores the
posts, and the pool splits pro rata at each cycle close. Founders vest 10% of
supply behind holder-approved milestones. Idle reserves can earn yield above a
$1,000 gate (Burrow USDT on mainnet; mock vault on testnet).

## Status: testnet prototype

- Contracts live on NEAR testnet: `launchlyv5-1105.testnet` (products 1–6)
- Reserve: `usdt.fakes.testnet` (mintable test USDT)
- Chain is source of truth; the backend caches and never holds pool-moving keys.
- Anything simulated is labelled SIMULATED in code and UI.

## Repo map

| Path | What |
|---|---|
| `contracts/launchly` | Product registry, bonding curve, pools, milestones, yield vault hooks |
| `contracts/launchly-token` | NEP-141 product coin |
| `contracts/mock-burrow` | Testnet stand-in for Burrow (faithful spread, no real yield) |
| `intents/` | Python backend (stdlib-only, SQLite): drafts, verifier, keeper, quotes, relay, HTTP API |
| `agents/` | Node agent service: post scoring + per-product chat (Vercel AI SDK, Muse) |
| `frontend/` | Dashboard (TanStack Start): discover, markets, product pages, creators, launch wizard |
| `IDEA.md` / `HACKATHON.md` | Product idea and hackathon scope |
| `yield.md` | Yield mechanics (gate, buffer, recall) |
| `intents/backend.md` | Backend contract (root `BACKEND.md` is a stub) |
| `updates.md` | Build log |

## Quickstart (testnet)

Prerequisites: Rust + `cargo-near`, Python 3.11+, Node 20.

```bash
# 1. Contracts (tests only; testnet deploy already live)
(cd contracts && cargo test -p launchly --lib)

# 2. Backend API :8090 (needs OPERATOR_TOKEN + contract)
cd intents
export OPERATOR_TOKEN=$(python3 -c "import secrets;print(secrets.token_hex(16))")
export LAUNCHLY_CONTRACT=launchlyv5-1105.testnet BACKEND_DB=$PWD/intents.db
python3 keeper.py --db $BACKEND_DB --launchly $LAUNCHLY_CONTRACT reconcile
python3 api.py &                      # HTTP API
python3 keeper.py --db $BACKEND_DB --launchly $LAUNCHLY_CONTRACT serve --interval 300 &

# 3. Agent service :8091 (needs MODEL_API_KEY for Muse in intents/.env)
cd ../agents && npm install && LAUNCHLY_CONTRACT=launchlyv5-1105.testnet node src/server.js &

# 4. Dashboard :5173
cd ../frontend && npm install && npm run dev
```

Open http://localhost:5173 — pages read live chain data when the backend is
up and fall back to labelled demo data when it isn't. Set
`VITE_LAUNCHLY_API` / `VITE_LAUNCHLY_AGENT` to point at non-default hosts.

## Key flows

- **Founder:** launch wizard → draft finalized (hashes anchored) → sign
  `create_product` → `launch_coin` → `complete_launch` (keeper retries stuck
  launches with `--submit`) → Live.
- **Trader:** coin page → live curve quote → (demo wallet fill; real fills are
  on-chain `buy`/`sell`).
- **Creator:** submit post URL on-chain → keeper/verifier attests (rules decide,
  model adds 0–10 bonus) → cycle finalizes → claim USDT.
- **Milestones:** founder publishes evidence hash → holders vote → tranche
  releases. Founders can't vote on their own milestones.
- **Gasless (meta-tx):** founder signs a NEP-366 delegate, backend sponsors gas
  via the relay allowlist (scaffold: validated, broadcast pending signer).

## Tests

```bash
(cd contracts && cargo test -p launchly --lib)  # 76 contract unit tests
(cd intents && python3 -m unittest discover)  # backend suite (113 tests)
npm test --prefix agents                # agent suite (55 tests, +4 live)
```

## Roadmap (not built)

Paid x402 product reports, promo-video generation, platform-sponsored launch
flow, holder indexer, real social fetchers. See `HACKATHON.md` and
`intents/backend.md`.

## License

MIT — see [LICENSE](LICENSE).
