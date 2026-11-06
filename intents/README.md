# Launchly backend (`intents/`)

Stdlib-only Python, SQLite, zero-install. The backend holds content and
caches chain state; it holds no pool-moving keys and never spends.
Chain is source of truth; backend limits are stricter than chain limits.

Full design: [backend.md](backend.md). Live-swap procedure (human-only):
[LIVE_SWAP_RUNBOOK.md](LIVE_SWAP_RUNBOOK.md).

## Modules

| File | Role |
|---|---|
| `store.py` | SQLite schema + access (drafts, products, checks, quotes, swaps) |
| `products.py` | Drafts, canonical JSON + hashes, uploads, milestones, creators |
| `sync.py` | Mirror on-chain products; bind drafts by hash; merged feed |
| `chain.py` | NEAR RPC views (urllib) + `near` CLI writes (subprocess) |
| `adapter.py` | 1Click client: tokens, dry-by-default quotes, status polling |
| `flows.py` | Pay-in / pay-out quote orchestration; live-swap prep + watch |
| `social_sim.py` | Simulated social layer (fixtures; `simulated: true`) |
| `verifier.py` | Rules-engine post checks; attests via CLI only with `--submit` |
| `keeper.py` | Propose-only keeper: reconcile, vault suggestions, serve loop |
| `relay.py` | Meta-tx relay: NEP-366 decode + allowlist + quota + audit (no broadcast yet) |
| `api.py` | `http.server` JSON API (open reads, token-gated operator routes) |
| `demo.py` | Original 1Click demo probe |

## Quickstart

```bash
cp .env.example .env   # fill in OPERATOR_TOKEN etc. (never commit .env)
python3 keeper.py --db intents.db --launchly launchlyv5-1105.testnet reconcile
OPERATOR_TOKEN=$(grep OPERATOR_TOKEN .env | cut -d= -f2) \
  BACKEND_DB=intents.db LAUNCHLY_CONTRACT=launchlyv5-1105.testnet \
  python3 api.py   # serves 127.0.0.1:8090
```

## Tests

```bash
cd intents
for t in test_store test_products test_verifier test_flows \
         test_keeper test_api test_adapter; do
  python3 -m unittest $t 2>&1 | tail -1
done
```

All suites green (2026-11-06): 110 tests total — 9 store, 15 products,
19 verifier, 5 flows, 8 keeper, 26 api, 10 adapter, 18 relay — plus
55 agent service tests (`cd ../agents && npm test`).

## Token, posts, creator, vote APIs

- `GET /tokens[?product_id=]`, `GET /tokens/{acct}` — supply + curve
  state + effective price (tokens per 1.0 reserve, chain-quoted)
- `GET /tokens/{acct}/balance?holder=`, `GET /tokens/{acct}/chart`
  (`?from=&to=&resolution=raw|hour|day`) — snapshots via
  `keeper.py snapshot` (also runs in `serve`)
- `GET /products/{id}/posts[?cycle_id=]`, `GET /posts/{post_id}`,
  `POST /posts/validate` — chain posts merged with check records
- `GET /creators/{a}/posts`, `GET /creators/{a}/earnings`
- `GET /products/{id}/votes[?voter=]` — milestones + locks

## Testnet role simulation (`sim_demo.py`, 2026-11-06)

5 real-product demo listings (Zed, Ruff, Warp, Raycast, Obsidian —
names/URLs factual, descriptions marked demo/not-affiliated), 12
faucet-funded role accounts on `launchlyv5-1105.testnet` (pids 2–6):
11 buys + 1 sell in real fakes-USDT, 8 posts all attested (87–88)
and live-confirmed, 5 cycles finalized, 8 claims paid (~3.34 USDT),
1 milestone published/voted/released/unlocked.

Run: `python3 sim_demo.py --all --state /tmp/sim.json` (phase
resume supported). Lessons baked in: `complete_launch` retry for
stuck launches, lazy cycle rollover on trade, dispute-window wait
before claims, faucet 429 fallback to founder-funded subaccounts.

Infra note: `https://rpc.testnet.near.org` is deprecated and throttles
(429 "STOP USING IT NOW"); defaults now point at
`https://rpc.testnet.fastnear.com` (chain.py, agents, .env examples).

## Product coin quotes

`GET /products/{id}/quote?side=buy|sell&amount=<base units>` proxies
the chain's `get_buy_quote` / `get_sell_quote` with labeled fields
(`tokens_out`/`cost`/`fee`, `net_proceeds`/`fee`). Unknown product →
404, chain down → 502.

## Scoring agent (Vercel AI SDK + Muse)

`verifier.py --agent-url http://127.0.0.1:8091` (or `AGENT_URL`) adds a
0–10 quality bonus from `agents/` to already-valid posts, capped at 100
total. The agent never flips validity; an unreachable agent means +0
and the rules score stands. See [agents/README.md](../agents/README.md).

## Roadmap (not built)

- **Meta-transactions (relayer, validation done):** `relay.py`
  strict-decodes NEP-366 delegates (validated against Rust vectors
  with real signatures), enforces receiver + method allowlist +
  per-action gas cap + freshness + per-sender quota, and audits every
  decision (`POST /relay`, `relay.py check`). Open: the broadcast
  signer (stdlib has no ed25519, `near` CLI has no Delegate action) —
  needs a JS signer sidecar or a crypto dep before anything reaches
  the chain. Note: gas sponsorship only — `create_product` storage
  still comes from the founder's account, so true zero-balance
  onboarding needs a contract-side sponsored path too.
- **Paid product reports (x402):** verifiable-data reports for
  investors, pay-per-call. Blocked on confirming x402/NEAR infra +
  investment-advice review. Testnet-only until then.
- **Promo video generation (pay-per-call):** price above cost + margin,
  rate limits, AI-labeled output, same verifier for anything posted.
- **`launch_coin` caller change:** deferred; preferred design is founder
  signs + backend relays gas (see meta-tx), not backend-as-caller.

## Testnet end-to-end proof (2026-11-05, `launchlyv5-1105.testnet`)

Fresh DB, one reconcile — product 1 cached, verifier dry-run suggests a
liveness attestation, nothing submitted:

```json
{"cached_products": 1, "bound_drafts": 0,
 "verifier_actions": [{"op": "liveness", "count": 1}],
 "note": "chain is source of truth; store only caches"}
```

Vault proposal prints a human-runnable command and executes nothing:

```text
near contract call-function as-transaction launchlyv5-1105.testnet
  vault_withdraw json-args '{"product_id": 1, "amount": null}' ...
```

API smoke: `/health` ok, `/products` serves the live v5 product,
`/keeper/status?product_id=1` returns the on-chain vault position,
operator routes 401 without the token.

Prior proofs: verifier attestation accepted on-chain (v5 post 2, valid,
score 84); vault adapter proven on testnet (gate $1k, 70% cap,
recall/queue, measured gain); Rust suite green (76 lib + e2e +
vault_e2e).

Known blocker: 1Click `/v0/quote` returns HTTP 400 "Internal server
error", so live quotes stay unverified — see the runbook precondition.
