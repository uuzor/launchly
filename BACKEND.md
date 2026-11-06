# Launchly backend addendum: product data, identity, and app flow

Addendum to `intents/backend.md`. Merge these sections into that file, or hand this file to the coding agent before replying "go" to the plan.

**Gap this fills:** the plan covers the verifier, Intents flows, keeper, and API, but nothing lets a founder publish product information, and nothing ties that information to an on-chain project. Launchly is product-backed, so both are required.

Note: this was written without access to the contract code. Section 11 lists what to check there first.

---

## 1. Principle

- **Chain holds identity, money, and rules.** Minimal data, plus hashes that anchor the off-chain data.
- **Backend holds the content** (descriptions, images, rules text, evidence links) and serves it to the UI.
- **Anything the verifier or creators rely on is hash-anchored on-chain**, so the operator cannot change it silently.

## 2. Project identity

Every product has these identifiers:

| Id | Source | Purpose |
|---|---|---|
| `draft_id` | Backend, random UUID, before launch | Lets a founder prepare a listing before any transaction |
| `product_id` | Registry contract, assigned at launch | The canonical id used everywhere (posts, cycles, pools, milestones) |
| `token_account` | Launch (for example `p1.<factory>.testnet`) | The product's NEP-141 coin |
| `founder_account` | Caller of `launch_coin` | Owner of the listing and the locked allocation |
| `metadata_hash` | sha256 of canonical metadata JSON | Anchors the product content on-chain |
| `rules_hash` | sha256 of canonical campaign rules JSON | Anchors the post rules the verifier applies |

Binding a draft to a product:
1. The founder finalizes the draft. The backend canonicalizes the metadata and rules (sorted keys, no whitespace, UTF-8) and returns the two hashes.
2. The founder signs `launch_coin` with `metadata_hash` and `rules_hash` as arguments, then `complete_launch` (the existing two-transaction launch).
3. The backend watches the registry. When it sees a new product whose hashes match a draft from the same founder account, it sets `draft.product_id` and marks the product `live`.
4. If the hashes do not match any draft, the product shows as "on-chain, no metadata" and the UI says so.

This keeps the backend away from the founder's keys. Ownership is proven by the on-chain launch call.

## 3. What each actor publishes

### 3.1 Founder: product listing (off-chain, hash on-chain)

| Field | Required | Limits |
|---|---|---|
| `name` | Yes | 2–60 chars |
| `symbol` | Yes | 2–10 chars, A–Z and 0–9 (also the `#<symbol>` tag the verifier checks) |
| `tagline` | Yes | up to 120 chars |
| `description` | Yes | up to 2,000 chars, plain text |
| `problem` | Yes | up to 500 chars |
| `category`, `tags` | Yes | one category from a fixed list, up to 5 tags |
| `demo_url` | Yes | `https` only. This is the "required product link" in posts |
| `website_url`, `repo_url` | Optional | `https` only |
| `logo` | Yes | PNG, JPEG, or WebP, up to 512 KB |
| `screenshots` | Optional | up to 4 images, up to 1 MB each |
| `founder_socials` | Optional | handles for display (mocked platform in the demo) |
| `team` | Optional | up to 5 names and roles |

On launch, the existing parameters (fee, supply, split) come from the contract, not this form.

### 3.2 Founder: campaign rules (off-chain, hash-anchored)

These feed the verifier directly:
- `required_link`: defaults to `demo_url`.
- `required_tag`: defaults to `#<symbol>`.
- `min_account_age_days`: default 7.
- `max_counted_posts_per_creator`: must match the on-chain cap.
- `banned_content_notes`: free text shown to creators, up to 500 chars.
- `cycle_length`: display only, taken from the contract.

If the contract already stores some of these (cap, cycle length), the backend reads the contract value and does not let the form override it.

### 3.3 Founder: milestones (evidence off-chain, hash on-chain)

- `title`, `description`, `evidence_urls` (up to 5, `https`), optional evidence images.
- The backend stores the content and returns `evidence_hash`. The founder anchors that hash in the milestone proposal on-chain.
- Holders see the content through the backend and vote on-chain.
- Milestone content is immutable once published. A change is a new milestone.

### 3.3b Founder: product updates (optional, if time allows)

- Short release notes shown on the product page. Off-chain only, no anchor needed.

### 3.4 Creator

| Data | Where |
|---|---|
| `wallet_account` | On-chain identity (the caller) |
| Linked social account `(platform, handle)` | Backend. Mock platform in the demo (see section 8) |
| Payout preference `(asset, chain, address)` | Backend, used for the Intents payout quote. Optional, defaults to reserve USDT on NEAR |
| Post submission `(product_id, cycle_id, post_url)` | On-chain submit call, then the verifier picks it up |

Per-post results (rule checks, score, reason) are stored by the backend and anchored on-chain through `attest_post` with `post_hash`.

### 3.5 Trader / holder

- No uploads. Quotes (pay-in) go through the backend. Buys, sells, and votes are on-chain.

### 3.6 Operator

- Flags and holds for disputed posts, stored in the backend and reflected on-chain through the existing hold flow.

## 4. Backend API additions

Add to the routes in `backend.md` section 4.4.

```
# Product drafts (founder)
POST   /drafts                         -> {draft_id, edit_token}          create draft
GET    /drafts/{id}                    -> draft (edit_token required)
PUT    /drafts/{id}                    -> update fields (edit_token)
PUT    /drafts/{id}/assets/{kind}      -> raw image body; kind = logo | screenshot-N
POST   /drafts/{id}/finalize           -> {metadata_hash, rules_hash, canonical_json}
GET    /drafts/{id}/status             -> draft | launching | live | mismatch

# Public product data (reads chain + metadata)
GET    /products?category=&sort=       -> product feed (registry + metadata)
GET    /products/{product_id}          -> full product page data
GET    /products/{product_id}/rules    -> rules JSON + rules_hash + on-chain match flag
GET    /assets/{sha256}                -> image (served with fixed content type)

# Milestones
POST   /products/{product_id}/milestones        -> store content, return evidence_hash
GET    /products/{product_id}/milestones        -> list with on-chain proposal state

# Creators
PUT    /creators/{account}/payout-preference    -> asset/chain/address
POST   /creators/{account}/social-link          -> start link (MOCK in demo)
GET    /creators/{account}                      -> profile, posts, scores

# Operator
POST   /operator/products/{product_id}/flag     -> flag listing for review
```

All earlier routes (quotes, swaps, verifier, keeper) stay as planned.

## 5. Uploads

The plan is stdlib-only Python. Two practical points:
- **Avoid multipart.** `http.server` has no multipart parser, and the `cgi` module is removed in Python 3.13. Use raw-body uploads (`PUT` with `Content-Type: image/png` etc.). The UI can send a file as a raw body with `fetch`.
- **Validation:**
  - Allow PNG, JPEG, and WebP only. **No SVG** (script injection risk).
  - Check the file's magic bytes, not just the header or extension.
  - Enforce size limits (logo 512 KB, screenshots 1 MB) and a per-draft asset count.
  - Store files under `data/uploads/<sha256>`, served with a fixed content type and `X-Content-Type-Options: nosniff`.
- **Text:** store as plain text and escape on render. No HTML or markdown in v1.
- **URLs:** `https` only. If the backend ever fetches a URL (for example a demo link check), block private and local addresses to avoid SSRF, set a short timeout, and cap the response size.

## 6. Auth and integrity

Stdlib Python has no ed25519, so wallet-signature checks (NEP-413) would need either a small dependency or a hand-written verifier. Because ownership is proven on-chain at launch, the backend can use a simpler model for v1:

- **Pre-launch drafts:** `edit_token` (random 32 bytes, returned once at creation) acts as a capability. Anyone without it cannot edit the draft.
- **Binding to the founder:** the on-chain `launch_coin` call with matching hashes (section 2). A draft only becomes a live product when the founder account launches with its hashes.
- **Post-launch edits (stretch):** founder submits a new version and anchors the new `metadata_hash` on-chain through an update method on the registry. Without that method, treat metadata as immutable after launch in v1.
- **Operator routes:** `OPERATOR_TOKEN`, as planned.
- If wallet-signature auth is wanted, add PyNaCl (pinned version) and list it in the README as a dependency (HACKATHON.md Q-005). Otherwise keep the zero-install claim.

## 7. Chain sync

- The UI needs a joined feed (chain state plus metadata), so the backend keeps a small cache.
- Poll registry views on an interval (`list_products`, `get_product`), upsert into SQLite, and join with draft metadata by hash.
- Treat the chain as the source of truth. On any mismatch, show the chain value and flag the metadata.
- The dashboard can still read money views (pool, vault, votes) from NEAR directly. Product content comes from the backend.

## 8. What is mocked and what is real

| Piece | Status in the demo |
|---|---|
| Social platform (X) fetch and account linking | **Mock** (`social_sim.py` fixtures, labeled `simulated: true`) |
| Account ownership check for the linked social handle | Mock. Real design: creator posts a code from the linked account |
| Post classification agent | Real or mock, depending on credentials. Needs a no-key fixture mode so reviewers can run it |
| Product uploads, metadata, hashes, feed | **Real** |
| NEAR views and transactions | **Real** (testnet) |
| Intents quotes and the tiny swap | **Real** when the 1Click backend recovers (mainnet) |
| Vault | Burrow mechanics on testnet, with yield labeled as near zero there |

Keep every mock behind the same interface as the real version (`fetch_post()`), so swapping it later does not touch the verifier.

## 9. App flows with backend touchpoints

### Founder
1. Connect a NEAR wallet.
2. `POST /drafts`, then fill the form (`PUT /drafts/{id}`), upload the logo and screenshots, set campaign rules.
3. Preview, then `POST /drafts/{id}/finalize`, which returns the two hashes.
4. Sign `launch_coin` (with the hashes), then `complete_launch`.
5. The backend sync sees the product, matches the hashes, and the page goes live.
6. Later: publish milestones (`POST .../milestones`), anchor the `evidence_hash` in a proposal, and watch the vote.

### Creator
1. Connect a wallet. Link a social account (mock). Optionally set a payout preference.
2. Browse `GET /products`, read the rules (`GET .../rules`, with the on-chain hash match shown).
3. Post on the social platform, then submit the post URL on-chain.
4. The verifier checks rules and (optionally) the agent, then calls `attest_post`.
5. At cycle close, the verifier calls `confirm_liveness`, then the creator claims on-chain.
6. Optional: ask for a payout quote (`POST /quotes/payout`) to receive the claim in another asset or chain.

### Trader / holder
1. Browse products and pool data.
2. Optional pay-in quote (`POST /quotes/payin`) to bring assets from another chain.
3. Buy or sell on-chain. Vote on milestones on-chain, reading the milestone content from the backend.

### Operator
1. Run the verifier and keeper (`--once` or loop).
2. Review flagged listings and held posts, and act through the contract's hold flow.

## 10. SQLite tables to add

```
drafts(draft_id PK, edit_token_hash, founder_hint, status, product_id NULL,
       metadata_json, rules_json, metadata_hash, rules_hash, created_at, updated_at)
assets(sha256 PK, draft_id, kind, mime, size, created_at)
products_cache(product_id PK, founder_account, token_account, metadata_hash,
               rules_hash, draft_id NULL, chain_state_json, synced_at)
milestones(id PK, product_id, content_json, evidence_hash, proposal_id NULL, created_at)
creator_profiles(account PK, payout_asset, payout_chain, payout_address, updated_at)
social_links(account, platform, handle, verified, simulated, PRIMARY KEY(account, platform))
post_checks(post_id PK, product_id, cycle_id, creator, post_hash, valid,
            score, reason, simulated, checked_at)
```

Store only the hash of `edit_token`, not the token itself.

## 11. Check in the contract code first

I have not seen the contracts. Before building, confirm these, since each one changes the plan:
1. Does the registry already assign a `product_id` and store `founder`, `token_account`, `symbol`, and `demo_url`? (The backend plan already uses `product_id` and `list_products`, so likely yes.)
2. Does `launch_coin` accept (or can it be extended to accept) `metadata_hash` and `rules_hash`? If not, add two optional string fields stored on the product and returned by `get_product`. This is a small change and avoids a new method.
3. Is there an update method for the hashes, and who can call it? If not, treat metadata as immutable after launch for v1.
4. Do milestone proposals carry a description or `evidence_hash` field? If not, add one.
5. Which rules are already enforced on-chain (cap per creator, cycle length, min account age)? Rules enforced on-chain should be read from the chain, not duplicated in the form.
6. Is the post-submission call on-chain (`submit_post`)? The verifier plan assumes it and polls `list_cycle_posts`.

## 12. Build order (backend only)

1. Draft and asset routes, canonical JSON and hashing, SQLite tables.
2. Chain sync plus `GET /products`, with hash matching.
3. Contract change for the two hashes (if needed), then the launch binding test.
4. Verifier reading rules from the product record.
5. Milestone content routes and `evidence_hash`.
6. Creator profile and payout preference.

Tests worth writing: hash canonicalization is stable (key order, whitespace, unicode), a draft with a changed field fails the hash match, an oversized or wrong-type upload is rejected, a draft cannot be edited without its token, and a product with no matching draft shows the "no metadata" state.