# Backend ↔ contract flow map

Reads flow backend-ward over NEAR RPC (urllib, no keys). Writes flow
chain-ward only from human wallets or the operator's `near` CLI profile
— Python never signs. SQLite sits in the middle as cache, never truth.

```text
                        ┌────────────────────────────┐
                        │  Launchly contract (chain) │
                        │  product_id │ money │ hash │
                        └────────────────────────────┘
                          ▲  ▲  ▲  ▲  │  │  │  │  │
           wallet txs ────┘  │  │  │  │ views │  │  │  └──── events ──► sync
          CLI-operator txs ──┘  │  │  │  │     │  │  └───────────────► (poll)
                                │  │  │  │     │  └──── get_vault_position
                                │  │  │  │     └──────── get_product
                                │  │  │  └────────────── list_products (paged)
                                │  │  └───────────────── list_cycle_posts
                                │  └──────────────────── confirm_liveness ◄── verifier --submit
                                └─────────────────────── attest_post ◄──────── verifier --submit


FOUNDER (product-backed listing)
────────────────────────────────
  dashboard ──POST /products/drafts───────────────► api ──► Products.create_draft
  dashboard ──PUT .../drafts/{id} (metadata/rules)─► api ──► Products.update_draft
  dashboard ──PUT .../assets/logo (raw PNG)─────────► api ──► Products.put_asset
  dashboard ──POST .../finalize─────────────────────► api ──► canonical JSON
                                                            │  ├─► sha256 ──► metadata_hash
                                                            │  └─► sha256 ──► rules_hash
                                                            └──► create_product args (JSON)
  founder wallet ──create_product(name, symbol, demo_url,
                   metadata_hash, rules_hash)───────────────► CHAIN  (founder = caller)
  founder wallet ──launch_coin()────────────────────────────► CHAIN  (founder-only)
  keeper reconcile ──sync_products()──► list_products ──► CHAIN
        │ binds draft → product_id on (founder, metadata_hash, rules_hash)
        └─► states: registered │ orphaned │ superseded │ on-chain-no-metadata


CREATOR (post → attest → payout)
────────────────────────────────
  creator ──POST /creators/{a}/social-link─────────► api (MOCK, simulated:true)
  creator wallet ──submit_post(product, url, handle)─► CHAIN (URL-unique/product,
                                                             cycle must be open)
  verifier run_once (per Live product):
        │  get_product ──► status/cycle_id/symbol/demo_url/cap
        │  list_cycle_posts ──► unattested posts
        ├── check_post: social_sim fetch ──► link? tag? age? ──► valid/score/hash
        ├── duplicate content-hash? ──► invalid (SQLite content_hashes)
        ├── creator cap pre-check? ──► invalid, still one-shot attest (new)
        └── dry: record check │ --submit: attest_post ──► CHAIN (near CLI,
                                                           verifier key)
  near close: confirm_liveness(product, cycle, [{post, live}]) ──► CHAIN
        │ unconfirmed / dead ──► fail closed (never counts)
  creator ──claim_payout()──► CHAIN (wallet; shortfall ──► vault recall queue)
  creator ──POST /quotes/payout (dry)──► 1Click quote ──► optional cash-out path


KEEPER (propose-only, never spends)
───────────────────────────────────
  keeper reconcile ──► sync_products + verifier dry-run ──► report
  keeper propose-vault --product N --deploy
        │  get_vault_position + get_product (views)
        └──► PRINTS: vault_rebalance ──► human copies ──► near CLI ──► CHAIN
  keeper propose-vault --product N --withdraw full|<base>
        └──► PRINTS: vault_withdraw(amount=null|<U128>) ──► human ──► CHAIN
  keeper serve ──► reconcile every N s (survives transient RPC failure)


TRADER / INTENTS (1Click, mainnet)
──────────────────────────────────
  trader ──POST /quotes/payin (dry)──► flows ──► 1Click /v0/quote ──► quote row
  operator ──prepare-live-swap──► LIVE quote ──► deposit address ──► STOPS
  human ──deposits from own wallet──► 1Click ──► executes swap
  operator ──watch──► /v0/status poll ──► terminal receipt ──► swaps row
  (BLOCKED 2026-11-05: /v0/quote → HTTP 400; runbook step 1 re-probes)


DASHBOARD (reads, open routes)
─────────────────────────────
  GET /products ──► product_feed: chain_state + bound draft metadata + state
  GET /products/{id}[/metadata|/rules|/milestones] ──► merged views
  GET /keeper/status?product_id= ──► live get_vault_position snapshot
  GET /verifier/posts ──► recorded checks (reason/score/simulated)
```

Trust summary: backend can lie about content (mitigated: hashes on-chain,
`simulated` labels everywhere); it cannot move money (no keys, CLI-only
writes, human-gated live swaps); chain wins every disagreement.
