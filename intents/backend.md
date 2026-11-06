# Launchly backend plan (under `intents/`)

Status: plan. Implements the off-chain half of [IDEA.md](../IDEA.md)
(sections 4.4, 5, 6, 9, 10) against the shipped contracts. Demo deadline:
2026-11-14T23:59:00Z.

## 1. Where the backend fits

On-chain (done, testnet): registry, bonding curve, fee router, promo pools,
vesting + milestone votes, Burrow vault. The contracts hold money and rules.

Off-chain (this plan): everything that needs secrets, polling, or web APIs.

| Owner | Responsibility |
|---|---|
| Contracts | Money, rules, attestations, votes, vault, product registry (`product_id`, founder, hashes) |
| Backend (`intents/`) | Verifier (post checks → `attest_post`/`confirm_liveness`), Intents quote + swap orchestration, vault keeper, product metadata registry (drafts → hashes → sync), tiny JSON API |
| Dashboard (later) | Reads NEAR views directly; calls backend API for quotes, products, and verifier status |

Design rules: stdlib-only Python like the existing `adapter.py`
(zero-install demo); SQLite for state (stdlib, single file); secrets only
via environment, never in the repo (HACKATHON.md); every simulated piece
labeled `SIMULATED` in code, logs, API, and UI.

## 2. Current state

- `adapter.py`: 1Click client (`tokens`, `quote`, `deposit/submit`,
  `status` + polling) and the two Launchly flows (`payin_quote`,
  `payout_quote`). Dry-by-default, explicit `allow_live` gate. 10/10
  mocked tests green.
- `demo.py`: live dry-quote demo. **Blocked: `/v0/quote` returns
  "Internal server error" on every route** (re-checked 2026-11-05);
  `/v0/tokens` (215 assets) and `/v0/status` work.
- Missing: verifier, keeper, HTTP API, persistence, live-swap runbook.

## 3. Architecture

```text
                      +------------------+
                      |  NEAR testnet    |  views + attest/vote/keeper txs
                      |  (contracts)     |<----------------------+
                      +------------------+                       |
                               ^                                 |
                               | reads                    +------+------+
+------------------+           |                          |   backend   |
| 1Click (mainnet) |  quotes   |   +------------------+   |             |
|  Intents API     |<----------|   | social APIs      |   | verifier  |
+------------------+           |   | (SIMULATED fix-  |-->| intents   |
                               |   | tures in demo)   |   | keeper    |
                               |   +------------------+   | api (http)|
                               |                          +------+------+
                               |                                 ^ dry quotes,
                               |                                 | statuses
                               +---------------------------------+--------+
                               v                                          |
                      +------------------+                       +------+------+
                      | dashboard (later)|  NEAR views direct    |  operator   |
                      +------------------+                       |  (human)    |
                                                                 +-------------+
```

Three workers plus one HTTP server, all stdlib (`http.server`,
`sqlite3`, `urllib`, `subprocess` to `near` CLI for chain writes):

1. `verifier.py` — post checks → submits `attest_post`, `confirm_liveness`.
2. `keeper.py` — loop: `vault_rebalance` + `drain_pending` per product.
3. `flows.py` — pay-in/payout quote orchestration + deposit status
   watching; serves the API with dry quotes today, live path armed.
4. `sync.py` — chain → SQLite mirror: products, milestones, posts, and
   the draft↔`product_id` binding (section 4.5).
5. `api.py` — one `http.server` JSON API over the above + SQLite state.

Chain writes go through the `near` CLI via subprocess (keys stay in the
operator's keychain/env, never in Python state). Reads use NEAR RPC views
directly (no CLI needed).

## 4. Component specs

### 4.1 Verifier (`verifier.py`, IDEA.md 4.4 + 9)

Input: submitted posts, polled from chain (`list_cycle_posts` per live
product/cycle) for posts with `attested == false`, plus attested posts
needing liveness near cycle close.

Social layer (demo): `social_sim.py` — fixture store mapping
`(linked_account, url)` → `{content, posted_at, account_age_days,
alive}`. Seeded from `social_fixtures.json` (checked in, clearly fake
handles). Every fixture response and every log line carries
`simulated: true`. Real-platform fetchers (X API etc.) are future work
behind the same `fetch_post()` interface.

Rules engine (exact IDEA.md 4.4 wording):

- contains required product link or tag (product's `demo_url` or
  `#<symbol>` in content). Symbol normalization: the chain allows any
  1–16 char symbol, so the verifier normalizes to uppercase A–Z0–9 and
  requires 2–10 chars; anything else marks the product "no valid tag"
  and the tag rule is skipped (link rule still applies). Backend forms
  enforce the strict shape up front; normalization only protects
  products created by direct contract calls.
- original: sha256(content) not seen before for this product (SQLite
  `content_hashes`; doubles as the on-chain `post_hash`). The chain
  additionally rejects a duplicate post URL per product up front.
- linked account age ≥ minimum (fixture field; default 7 days),
- alive at confirm time (fixture `alive` flag),
- per-creator cap is enforced on-chain at attestation; the verifier
  pre-checks it (and the backend-known `max_counted_posts_per_creator`)
  to skip doomed work.

Outputs: `attest_post(post_id, valid, score, post_hash)` — score 0–100
from a documented heuristic (length + link + tag presence, capped);
invalid posts get `valid: false` with the hash still recorded.
`confirm_liveness(product_id, cycle_id, confirmations)` in batches ≤ 500.
One-shot semantics: never re-attest (chain enforces; verifier checks
`attested` first). NEP-297 events from chain are the audit trail.

Keys: `VERIFIER_ACCOUNT` + keychain (the account set as `verifier` at
`new`). Runs: on demand (`verifier.py --once`) and loop
(`--interval 60`).

### 4.2 Intents flows (`flows.py` on top of `adapter.py`, IDEA.md 5)

Honest scope split (testnet contracts vs mainnet-only 1Click):

- **Dry quotes (works today, powers the UI):** pay-in (any asset →
  reserve USDT on NEAR to Launchly) and payout (pool USDT → creator's
  asset/chain) via `/v0/quote` with `dry: true`. No keys, no funds.
  Currently blocked by the 1Click outage; retries + cached asset list.
- **Live proof swap (one tiny dev-funded mainnet swap, human-executed):**
  `flows.py prepare-live-swap` prints the exact live quote request and
  deposit address and STOPS. The human deposits from their own wallet,
  then `flows.py watch <depositAddress>` polls `/v0/status` to terminal
  and records the receipt. The backend never holds mainnet swap keys in
  v1. This matches IDEA.md 5.5: the demo proves the path; testnet pool
  funds never touch mainnet.

Explicitly NOT in v1: backend custody of pool payouts, auto-depositing
creator shares, auto-buying after pay-in settles. Those need a mainnet
treasury design + audit, listed in section 8. The API returns
`live: false, simulated: false, dry: true` labels so the UI states
exactly what happened.

State (SQLite `intents.db`): `quotes(id, kind, params, response,
created_at)`, `swaps(deposit_address PK, quote_id, status, receipt)`.
`tokens` cached 1h to survive outages.

### 4.3 Keeper (`keeper.py`, yield.md future work, promoted)

Loop over live products (from `list_products`): call `vault_rebalance`;
if `pending_count > 0`, call `drain_pending` (repeat while it pays);
log `get_vault_position` deltas. Interval 60s, `--once` for demos.
Any funded key works (permissionless); recommend a dedicated
`keeper.<main>` account with 1 NEAR. All actions are already
no-op-safe on-chain (recall priority, busy guard, dust rules).

### 4.4 HTTP API (`api.py`, stdlib `http.server`, JSON)

```text
GET  /health                        -> {ok, network, burrow, oneclick}
GET  /assets?symbol=&blockchain=     -> cached 1Click asset list
POST /quotes/payin                   -> {quote} dry pay-in quote
POST /quotes/payout                  -> {quote} dry payout quote
GET  /swaps?depositAddress=          -> status record
GET  /verifier/posts?product_id=&cycle_id=  -> posts + check results
POST /verifier/run-once              -> run one verifier pass (operator)
GET  /keeper/status?product_id=      -> vault position + last actions
POST /keeper/run-once                -> one keeper pass (operator)
POST /products/drafts                -> create draft (founder auth)
GET  /products/drafts/{id}           -> draft + canonical JSON + hashes
PUT  /products/drafts/{id}           -> replace draft (pre-finalize)
POST /products/drafts/{id}/finalize  -> freeze + return create args
GET  /products/drafts/{id}/status    -> draft|launching|live|mismatch
PUT  /products/drafts/{id}/assets/{kind} -> upload logo/screenshot-N
GET  /products?category=&sort=       -> merged on-chain + off-chain feed
GET  /products/{id}                  -> one product, merged view
GET  /products/{id}/metadata         -> canonical metadata JSON
GET  /products/{id}/rules            -> canonical rules JSON
GET  /products/{id}/milestones       -> milestone evidence JSON list
POST /products/{id}/milestones       -> draft milestone evidence (founder)
GET  /assets/{sha256}                -> served upload (immutable)
PUT  /creators/{account}/payout-preference -> asset/chain/address
POST /creators/{account}/social-link -> start link (MOCK in demo)
GET  /creators/{account}             -> profile, posts, scores
GET  /creators/{account}/posts       -> chain posts (finalized cached)
GET  /creators/{account}/earnings    -> payout + finalized +
                                        claimable_at_ns + claimed/claim_tx
POST /creators/{account}/claims      -> report claim receipt; verified
                                        via tx_status (signer, receiver,
                                        single claim_payout, args match,
                                        no restore log), then recorded
POST /operator/products/{id}/flag    -> flag listing for review
```

Operator routes require `OPERATOR_TOKEN` bearer header. Read routes are
open (local demo). Port from `PORT` env, default 8090. CORS open for the
dashboard.

### 4.5 Product registry + metadata (product-backed core)

The app is product-backed: founders upload product info through the
backend, and the chain holds the money plus a tamper-evident anchor.
Ownership is established at `create_product` (the caller becomes
founder; only the founder can `launch_coin`).

Principle: the chain holds identity, money, and rules (minimal data
plus hashes); the backend holds content (descriptions, images, rules
text, evidence) and serves it to the UI; anything the verifier or
creators rely on is hash-anchored on-chain so the operator cannot
change it silently.

**Identity (corrected).** On-chain source of truth is the main
contract, keyed by `product_id: u64`:

| Field | On-chain | Backend |
|---|---|---|
| Product ref | `product_id` (registry sequence) | same, foreign key everywhere |
| Founder | caller of `create_product` | must match draft owner |
| Name / symbol | `name`, `symbol` | same strings |
| Anchors | `metadata_hash`, `rules_hash` (optional, 64 lowercase hex) | backend computes both from canonical JSON |
| Milestone evidence | `evidence_hash` on milestone | backend serves the JSON |

**Draft flow (no founder keys in backend).** Founder creates a draft
(backend random id + `edit_token`), uploads assets, validates, and
finalizes: the backend freezes the draft and returns exact
`create_product` arguments (name, symbol, tagline-as-description,
`demo_url`, both hashes). The founder submits from their own wallet.
`sync.py` then binds draft → `product_id` by matching
`(founder, metadata_hash, rules_hash)` on new registry entries.
States: draft → finalized-unregistered → registered (happy path),
plus orphaned (hashes never appear), superseded (hashes differ —
re-finalize), and on-chain-no-metadata (direct contract calls, e.g.
testnet v3 product 1 — the permanent test case for this state).

**Listing fields.** Founder form (backend limits are stricter than
chain limits; the chain stays permissive):

| Field | Required | Limits |
|---|---|---|
| `name` | Yes | 2–60 chars |
| `symbol` | Yes | 2–10 chars, A–Z0–9 (also the `#<symbol>` tag) |
| `tagline` | Yes | ≤ 120 chars (mirrored into on-chain `description`) |
| `description` | Yes | ≤ 2000 chars, plain text |
| `problem` | Yes | ≤ 500 chars |
| `category`, `tags` | Yes | one fixed-list category, ≤ 5 tags |
| `demo_url` | Yes | `https` only, ≤ 300 chars — must equal the on-chain value exactly (the verifier checks the on-chain one) |
| `website_url`, `repo_url` | No | `https` only |
| `logo` | Yes | PNG/JPEG/WebP, ≤ 512 KB |
| `screenshots` | No | ≤ 4 images, ≤ 1 MB each |
| `founder_socials` | No | handles for display (mocked platform in demo) |
| `team` | No | ≤ 5 names + roles |

**Canonical JSON + hashes.** `metadata.json` (above + assets, contact,
version, created_at) and `rules.json` (checklist,
`min_account_age_days`, `required_link_or_tag`, `originality_window`,
`max_counted_posts_per_creator` mirrored from chain at finalize —
never overridden by the form, `banned_content_notes` ≤ 500 chars,
cycle length display-only from chain, `policy_version`). Canonical
form: UTF-8, sorted keys, no insignificant whitespace, `\n` newlines;
sha256 over those bytes. Text stored plain, escaped on render, no
HTML/markdown in v1.

**Milestones.** Founder drafts evidence via the backend (title,
summary, ≤ 5 `https` evidence links, optional images → canonical JSON
→ `evidence_hash`), then calls `publish_milestone(product_id,
evidence_url, evidence_hash)` from the founder wallet. Holders read
the content from the backend and vote on-chain. Milestone content is
immutable once published — a change is a new milestone. The dashboard
re-hashes served JSON and compares with the on-chain value; mismatch
= flagged. (Product release notes: optional, off-chain only, stretch.)

**Creators (backend profile).** `wallet_account` is the on-chain
identity; the backend stores the linked social `(platform, handle)`
(mock link flow in demo), payout preference `(asset, chain, address)`
for Intents payout quotes (default: reserve USDT on NEAR), and
per-post check results (anchored via `attest_post` + `post_hash`).
Real account-ownership design (creator posts a code from the linked
account) is future work.

**Posts via backend (optional helper).** Client-side only: fetch rules
(`required_link_or_tag`, min age, cap), validate URL/handle, then the
user calls chain `submit_post(product_id, url, linked_account)` from
their own wallet. The chain enforces URL uniqueness per product; the
verifier enforces content-hash originality.

**Uploads.** `PUT` raw bytes (no `cgi` — removed in Python 3.13),
kinds `logo|screenshot-N`, PNG/JPEG/WebP by magic bytes (no SVG),
logo ≤ 512 KB, screenshots ≤ 1 MB, stored at
`UPLOAD_DIR/sha256[:2]/sha256`, served immutable with fixed content
type + `nosniff`. Backend never fetches founder-supplied URLs
server-side (SSRF — block private/local addresses if that ever
changes); the classifier (stretch) may fetch with an allowlist +
timeout + cap.

**Operator moderation.** `POST /operator/products/{id}/flag`
(operator token) records review flags; serious cases use the on-chain
`hold_payout(product, cycle, creator, hold, reason_hash)` with the
flag reason hashed — no chain changes needed. Store only the hash of
`edit_token`, never the token.

**SQLite additions:** `drafts(draft_id, edit_token_hash, ...,
product_id NULL, metadata_json, rules_json, hashes)`, `assets`,
`products_cache`, `milestones(product_id, milestone_index,
evidence_hash, status)`, `creator_profiles`, `social_links`,
`post_checks`, `content_hashes`, `operator_flags`.

**What is mocked vs real (demo).** Social fetch + account linking:
mock (`social_sim.py`, `simulated: true`); post classification agent:
real-or-mock with no-key fixture mode (stretch); uploads, metadata,
hashes, feed: real; NEAR views + txs: real (testnet); Intents quotes +
tiny swap: real when 1Click recovers (mainnet); vault: real Burrow
mechanics, yield ~0 on testnet (labeled).

**App flows (backend touchpoints).** Founder: draft → assets → rules
→ finalize (hashes) → `create_product` + `launch_coin` from wallet →
sync binds → page live → milestones + `evidence_hash`. Creator: link
social (mock) → optional payout preference → read rules → post →
submit URL on-chain → verifier attests → claim → optional payout
quote. Trader: feed → optional pay-in quote → trade/vote on-chain.
Operator: run verifier/keeper → review flags → hold flow.

## 5. Secrets, keys, and networks

| Secret | Env | Used by | Notes |
|---|---|---|---|
| Verifier key | keychain (`VERIFIER_ACCOUNT`) | verifier | `near` CLI profile, never in repo |
| Keeper key | keychain (`KEEPER_ACCOUNT`) | keeper | 1 NEAR suffices, permissionless |
| Operator token | `OPERATOR_TOKEN` | api | random 32B for demo |
| 1Click JWT | `ONECLICK_JWT` (optional) | flows | else 0.2% fee; mainnet only |
| API base | `ONECLICK_BASE` (optional) | flows | default 1click.chaindefuser.com |
| Upload dir | `UPLOAD_DIR` | api | default `./uploads`; logo 512 KB, screenshots 1 MB |
| Founder auth | `edit_token` per draft | api | v1 capability token (NEP-413 stretch) |

`.env.example` documents all of the above with empty values. `api.py`
refuses to start with the default operator token. Nothing mainnet moves
without a human typing a live command (adapter `allow_live` gate stays).

## 6. Testing

- Extend `test_adapter.py` style (stdlib `unittest`, mocked HTTP):
  `test_flows.py` (quote orchestration, dry-default, live refusal,
  status polling with fake terminal), `test_verifier.py` (each 4.4 rule
  incl. duplicate hash, dead-at-close, cap pre-check),
  `test_keeper.py` (decision table over vault positions, mocked CLI).
- `test_api.py`: route-level tests against `http.server` in-thread.
- `test_products.py`: canonical JSON byte-stability (hash of a fixed fixture),
  limit enforcement (over-long name, lowercase symbol, non-https demo_url),
  draft→finalize→sync-join incl. orphaned/superseded/on-chain-no-metadata
  states, milestone hash round-trip, upload kind/size/magic validation,
  creator profile + payout-preference defaults, changed-field hash mismatch.
- Sandbox: verifier + keeper against local contracts in a new
  `contracts/launchly/tests/offchain_e2e.rs`? NO — keep it Python: a
  `demo_offchain.py` script driving sandbox is out of scope; chain
  behavior is already covered by `vault_e2e`. Python tests mock the
  `near` CLI boundary.
- Acceptance = section 7 runbook passing against testnet + dry quotes
  passing against 1Click when it recovers.

## 7. Build order + acceptance (do-X-see-Y)

1. `store.py` (SQLite schema incl. §4.5 tables + helpers) + `test_store.py`.
   Do: `python3 -m unittest -v` → see all green.
2. `products.py` (canonical JSON, hashing, drafts, uploads, `sync.py`
   join, creator profiles) + `test_products.py` + product API routes.
   Do: create + finalize a draft → submit `create_product` on testnet →
   see the draft bind to `product_id`; v3 product 1 shows
   on-chain-no-metadata.
3. `social_sim.py` + fixtures + `verifier.py --once` (checks only,
   `--submit` to attest on testnet).
   Do: submit a post on testnet → run verifier → see `attest_post`
   receipt; flip fixture `alive:false` → run liveness → see the post
   excluded at finalize.
4. `flows.py` dry flows + `test_flows.py`.
   Do: `demo.py` (existing) → see dry pay-in + payout quotes when
   1Click recovers; `flows.py watch` against a known address → see
   terminal status.
5. `keeper.py --once` + loop + `test_keeper.py`.
   Do: deploy funds → run keeper → see `vault_rebalance` deposit;
   force a shortfall on testnet → run keeper → see recall + payout.
6. `api.py` + `test_api.py` + `.env.example`.
   Do: `python3 intents/api.py` → `curl localhost:8090/health` →
   see `{ok:true,...}`; POST a dry payout quote → see priced quote.
7. `flows.py prepare-live-swap` + runbook (human mainnet dust swap).
   Do: run prepare → human deposits → run watch → see SUCCESS +
   recorded receipt. Only after explicit human approval, per
   HACKATHON.md (never without confirmation).
8. README section (root + `intents/`): install (none), env, run each
   worker, API examples, demo-video script using the API + dashboard.

## 8. Out of scope (v1) / future

- Backend custody of payouts, auto-deposit, auto-buy-after-settlement.
- Real social-platform fetchers (X/YouTube APIs) — interface reserved.
- Mainnet Launchly deployment, real JWT registration, fee accounting.
- Auth beyond the operator token, persistence beyond SQLite, container
  packaging (a `Dockerfile` + `systemd` units are a stretch goal).
- Post classification agent (optional stretch, never blocks the rules
  engine; no-key fixture mode for demo).
- Product release notes (off-chain only, if time allows).
- Sputnik DAO / Trezu vote integration (track decision, see IDEA.md 12.1).
