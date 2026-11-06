# Launchly

**A community-funded growth engine for products. Each product gets a memecoin on NEAR, trading fees fund a promotional pool, and creators earn by posting about the product.**
export PATH=~/.local/bin:$PATH
Built for [NEAR HACKATHON — Build what's next](https://nearhackathon.com/#tracks). Rules and dates are taken from the organizers' [HACKATHON.md](https://nearhackathon.com/HACKATHON.md), which should be re-read before submitting because dates and rules may change.

---

## 1. Problem

Developers and founders often build good products but cannot promote them. They have no marketing budget, no audience, and no easy way to get early attention. Paid ads are expensive and organic reach is slow.

## 2. Idea

A founder lists a product on Launchly and launches a memecoin for it on a bonding curve. Every trade pays a small fee. Most of that fee goes into a promotional pool. Creators who want a share of the pool keep posting about the product. Their posts are verified, and at the end of each payout cycle (30 days in the live design, a few minutes in the demo) the pool is split among them.

The founder spends little. The founder's own token supply is locked and unlocks only when coin holders approve published milestones. NEAR Intents lets traders enter from other chains and lets creators take payouts in the asset and chain they prefer.

> Build something. Launch it. Let the community help it grow.

## 3. The economic loop

1. **Launch:** A founder lists a product and launches its coin. The founder's allocation is locked.
2. **Trade:** People buy and sell on the bonding curve. Each trade pays a fee. Traders can enter from other chains through NEAR Intents.
3. **Fund:** The fee is split on-chain. The largest share goes to the product's promotional pool. Simulated reserve yield is also credited to the pool (see 4.3).
4. **Promote:** Creators post about the product and submit the post links.
5. **Verify:** A verifier checks each post against the rules. Holders can rate approved posts.
6. **Pay:** At the end of the cycle, the contract splits the pool among creators by score. Creators can take payouts in another asset or chain through NEAR Intents.
7. **Unlock:** The founder publishes milestones with evidence. If holders do not reject a milestone, a tranche of the locked supply unlocks.

## 4. Core mechanics

### 4.1 Per-product memecoin
- Each product has its own NEP-141 token on NEAR.
- Trading is on a bonding curve, so the coin is tradable from launch without external liquidity.
- There is no platform-wide coin. Each product's coin carries its own rules.

### 4.2 Trade fee and split
Fees are set when the coin launches and cannot change afterwards. See Decisions (section 11) for the proposed values.

### 4.3 Reserve yield (simulated)
- Part of the stablecoin reserve is treated as deployed in a yielding vault.
- In this prototype the vault is **simulated**: a mock module accrues yield at a fixed, clearly labeled APR on the "deployed" portion and credits it to the promotional pool's ledger.
- The UI and README label this yield as simulated everywhere it appears.
- The vault sits behind an adapter interface, so a real vault could replace the mock later.
- A liquid buffer is always kept outside the (simulated) vault so sells can be honored.

### 4.4 Creator promotion and verification
- Creators connect a social account (simulated in the demo) and submit post links for a product.
- A post is **qualified** when it:
  - contains the required product link or tag,
  - is original (no duplicate or reposted content),
  - comes from a linked account that meets minimum age rules,
  - is still live at the end of the cycle, and
  - is approved by the verifier.
- Creator score is the sum over qualified posts of a base score multiplied by a community quality multiplier (see 4.5).
- Each creator has a cap on counted posts per cycle, so volume alone cannot take the pool.
- At the end of the cycle, the pool is split pro rata by score.
- There is no referral tracking. Rewards depend on qualified posts and community rating, not on clicks or signups.
- Payout is delayed until a dispute window passes, which discourages post-and-delete behavior.

### 4.5 Community quality rating
- Holders of the product's coin can rate approved posts.
- One wallet gets one vote, and a minimum holding at a snapshot is required, so votes carry some cost.
- The rating changes a post's multiplier only within a narrow range, so votes cannot zero out or inflate a score.

### 4.6 Founder lock and holder-approved milestones
- The founder's allocation is locked by the contract, not by promise.
- It unlocks in tranches, each tied to a published milestone with evidence (live demo, shipped release, usage numbers).
- A tranche releases after a review window unless holders reject it.
- Voting power is snapshotted when the milestone is published, so buying in to vote does not work. Founder wallets cannot vote on their own milestones.

## 5. NEAR Intents integration

NEAR Intents is used where cross-chain movement matters, not as decoration.

### 5.1 Pay in from any chain (trader onboarding)
A trader who holds assets on another chain pays in what they have. Launchly asks the Intents 1Click API for a quote, the trader deposits to the returned address, and the swap delivers the reserve stablecoin on NEAR to the Launchly contract's account. The trader then buys the product coin.

### 5.2 Creator payout in any asset and chain
Creators choose the asset and chain they want to be paid in. After the payout cycle, Launchly takes the creator's share in the reserve asset and uses Intents to deliver it to the creator's chosen address and chain.

### 5.3 Cross-chain payouts (autonomous business angle)
Creator payouts to other chains go through the same Intents path, so the pool needs no custodian and no manual bridging. Nothing besides creator payouts spends from the pool.

### 5.4 How the flow works in code
Based on the 1Click API docs and the NEAR agent-skills guide for Intents, verified against the official docs before implementing:
1. Fetch supported tokens (`GET /v0/tokens`) and use the `assetId` values it returns. Do not construct asset ids by hand.
2. Request a dry quote (`POST /v0/quote` with `dry: true`) to preview pricing without committing.
3. Request a real quote (`dry: false`) to get a deposit address (valid for a limited time, around ten minutes per the integration guide).
4. Send the deposit, optionally notify the API with the deposit transaction, and poll `GET /v0/status` until the swap settles.
5. Keep any private keys server-side and out of the repository.

### 5.5 Constraints from HACKATHON.md (Q-006, Q-007, Q-010)
- There is **no testnet for Intents**. Use mainnet, separate dev accounts, tiny amounts, and dry quotes.
- Testnet-only projects are eligible in all tracks. Mainnet is needed only where the integration is mainnet-only, which applies to Intents here.
- A 1Click JWT is not required. Without it, a 0.2% fee applies. A key can be registered at https://partners.near-intents.org.

**Planned split in the prototype:** the Launchly contracts (token, curve, fee router, pool, vesting, voting) run on NEAR testnet with a test stablecoin. The Intents module is a separate adapter: the UI shows live dry quotes for pay-in and payout, and the demo executes one tiny real swap on mainnet from a dev account to prove the integration works. The README states this plainly.

## 6. Product discovery layer (lightweight)

- Product page: description, demo link, founder, milestones, coin and curve status, pool balance.
- Simple feed of new and active products.
- Public view of fee inflows, pool balance, simulated yield, creator payouts, and milestone votes.

## 7. User roles

| Role | What they do |
|---|---|
| Founders | List a product, launch its coin, publish milestones |
| Creators | Post about products, submit links, earn from the pool |
| Holders / traders | Trade, rate posts, vote on milestones |
| Platform admins | Handle abuse and disputes, run the verifier |

## 8. Trust, safety, and risk

Risks to design against:
- Founder rug pulls (lock plus milestone-based unlocks).
- Fake or low-quality posts, bots, and reward farming (qualified-post rules, caps, dispute window, quality rating).
- Whale-dominated or bought votes (snapshots, per-wallet caps, founder exclusion).
- Hype trading that pays creators to promote the coin instead of the product (rewards tied to qualified posts and quality, not to price).
- Vault or stablecoin failure (vault simulated in the prototype; real deployment needs disclosure, limits, and audit).
- Copyright and misleading claims in posts.

Launchly does not promise returns, virality, or growth. Any yield is described as variable and, in the prototype, simulated. This is a hackathon prototype on testnet. Legal, security, and regulatory review are required before real funds are handled.

## 9. Technical approach on NEAR

- **Contracts:** product registry, NEP-141 token factory with bonding curve, fee router, promotional pool with payout cycles, simulated vault module, founder vesting with milestone voting.
- **Verifier service (off-chain):** fetches and checks submitted posts and writes approvals on-chain as attestations. Simulated social data in the demo, labeled as such.
- **Intents adapter:** 1Click API client for pay-in quotes and payout delivery (section 5).
- **Optional Sputnik DAO / Trezu (decide early):** if the milestone vote or pool treasury is built on Sputnik DAO or Trezu, the project fits the Social Money track more directly. If it is a custom contract, do not claim that track.

## 10. MVP scope

One complete loop that runs end to end:

1. Founder lists a product and launches its coin on the bonding curve.
2. Trades split fees on-chain between the promotional pool, the founder, and platform operations.
3. A trader enters through an Intents quote (dry quote in the UI, one real tiny swap in the demo).
4. Creators submit posts; the verifier approves them (simulated social data).
5. Holders rate posts.
6. The cycle ends (compressed to minutes). The contract pays creators pro rata, and one payout goes out through Intents.
7. The founder publishes a milestone; holders vote; a tranche unlocks.
8. A dashboard shows pool balance, fee inflows, simulated yield, creator payouts, and milestone status.

Cut or mock: advanced moderation, rich discovery feeds, AI meme generation, real social-platform APIs, real vault integration.

### Demo scenario
1. A founder lists a demo product and launches its coin.
2. A trader pays in from another asset (Intents quote) and buys the coin.
3. Several trades run; fees split and the pool grows.
4. A creator submits a post; it is approved and rated.
5. The cycle ends and creators are paid, one payout via Intents.
6. The founder publishes a milestone, holders vote, and a tranche unlocks.
7. The dashboard shows every step with transaction references.

## 11. Decisions (open questions answered)

These are proposals for the hackathon build. They are chosen to be simple, safe to demo, and easy to explain. Change any of them if you disagree.

| Question | Decision | Reason |
|---|---|---|
| Platform coin? | None. Only per-product coins. | Matches the memecoin-mechanics track and avoids a second token to design. |
| Reserve and fee asset | One stablecoin on NEAR (USDT, as chosen). Pick the exact asset id from the Intents token list and verify it. | Fees and the pool stay in a stable unit, and Intents can swap other assets into it. |
| Trade fee | 1% per buy or sell, fixed at launch, allowed range 0.5%–2%. | High enough to fund promotion, low enough not to kill trading. |
| Fee split | 70% promotional pool, 20% platform operations, 10% founder. | Pool is the main purpose. A small founder fee lets a locked founder earn without unlocking supply. |
| Holder rewards | Dropped from the MVP. | Avoids "yield to holders" wording and competes with the pool for the same fees. |
| Vault | Simulated mock with a fixed labeled APR, behind an adapter interface. About half the reserve counted as deployed, the rest liquid. | Keeps the demo honest and removes vault and stablecoin risk. |
| Referral tracking | Removed. | Per your decision. Rewards depend on qualified posts and quality rating. |
| Creator reward formula | Score = qualified posts (capped per cycle) × quality multiplier (0.5–1.5). Pool split pro rata. | Simple to compute on-chain and hard to inflate with volume alone. |
| Qualified post | Required product link or tag, original, linked account meets minimum age, still live at cycle end, verifier-approved. | Replaces the old "qualified referral" definition. |
| Payout cycle | 30 days live, a few minutes in the demo. 48-hour dispute window before payout live, seconds in the demo. | Gives review time, and the demo still shows a full cycle. |
| Community rating | Holders only, one wallet one vote, minimum holding at a snapshot, multiplier range 0.5–1.5. | Gives votes a cost and limits their effect. |
| Supply and founder allocation | 1,000,000,000 tokens. 90% sold on the curve, 10% to the founder, locked. | Easy numbers. Locked supply is a small share of the total. |
| Founder unlock | Four equal tranches, each released on a published milestone. Unapproved tranches are burned after a long deadline. | No time-only unlock, so the founder must ship to unlock. |
| Milestone vote | Circulating supply snapshotted at publication (on the curve contract, no cross-contract call). 72-hour review window (minutes in the demo). Voters lock product tokens via `ft_transfer_call` until the window ends — weight is linear in the locked amount, capped at 5% of snapshot supply per wallet (excess refunded at once). Tranche releases unless more than 50% of votes cast reject it and at least 10% of snapshot supply votes. Founder wallets excluded (refunded). | Lock-to-vote stops buy-vote-sell without checkpointing; linear (not quadratic) because square roots reward wallet-splitting. |
| Treasury custody | Held by the pool contract. Only the creator-payout function can move funds. Platform share goes to a fixed platform account. The founder cannot withdraw from the pool. | No human holds the keys to the pool. |
| Pool spending | Creators only. Creator posts are the marketing; nothing else takes from the pool. | Keeps the pool's purpose single and auditable. |
| Fixed or configurable settings | Fixed per coin at launch, chosen within platform limits. | Traders can trust the rules do not change after they buy. |
| Moderation and disputes | Report button, admin can hold a creator's payout during the dispute window, decisions logged on-chain as hashes. | Gives a clear path without central control of funds. |
| On-chain vs off-chain | On-chain: token, curve, fee split, pool, payouts, vesting, votes, approval attestations, simulated yield ledger. Off-chain: post fetching and verification, content, UI, Intents calls. | Keeps money and rules on-chain, data fetching off-chain. |
| Network | Contracts on NEAR testnet. Intents on mainnet with tiny dev-account amounts and dry quotes. | Intents has no testnet (HACKATHON.md Q-007), and testnet-only projects are allowed (Q-010). |
| Legal and regulatory | Hackathon prototype only, testnet, no real-money launch. Disclaimers in the README and UI. | Real tokens and rewards need legal review first. |

## 12. Alignment with HACKATHON.md

### 12.1 Tracks (ids as used in the submission)
Track ids come from the Tracks table in HACKATHON.md. Select every track the project actually fits, but only claim what is built.

| Track | Id | Fit | Claim it? |
|---|---|---|---|
| Memecoins With Mechanics | `memecoins` | Per-product NEP-141 coin with bonding curve, fee routing, locked founder supply, milestone unlocks, payout cycles. Judged on the mechanic, not the chart. | Yes (primary) |
| Autonomous Business | `business` | Treasury, revenue sharing, cross-chain payments via NEAR Intents, humans set only the constraints. | Yes |
| Social Money | `social` | Shared budget (pool), programmable rewards, holder-approved milestones. Hinted to be built on Sputnik DAO and Trezu. | Only if the vote or treasury uses Sputnik DAO or Trezu |
| Agent Economy | `agents` | Only fits if an agent really earns, pays, or hires. | No — no agent in scope |
| Unstoppable DeFi | `defi` | Vault is simulated, so the fit is weak. | No |

Suggested `tracks` array if the plan above is built: `["memecoins", "business"]`, adding `"social"` if Sputnik DAO or Trezu is used.

HACKATHON.md says hints and named protocols are hints, not requirements (Q-011), so a custom NEAR contract that fits the track is enough. Name what you use in the README.

### 12.2 Rules and how Launchly handles them

| Rule | Launchly |
|---|---|
| Code window (Q-001, Q-003, Q-004) | Only code written from the 2026-10-19 announcement counts. Use a new repo or a dedicated branch, and keep pre-hackathon code, if any, clearly separated in the README. |
| Libraries and AI code (Q-005) | List libraries, templates, and AI-generated code in the README. |
| License (Q-014) | Add a LICENSE file (MIT is fine). The repo stays public through judging. |
| Demo (Q-012) | A local-only demo is allowed with a public repo, reproducible README, and X post with a video. Screenshots alone are not enough if judges cannot open the demo. A hosted demo is a plus and should stay up to 2026-11-18, ideally 2026-11-25. |
| Intents testnet and funds (Q-007, Q-008) | Mainnet only for Intents, tiny amounts, separate dev account, dry quotes. Mainnet costs are not reimbursed. |
| Screening (Q-017) | Claude Code and Codex screen first for reproducibility and feature verification. Humans decide. |
| Several projects (Q-015) | One person can enter at most two independent projects, each README naming the other. |
| Payout (Q-016) | A single payment in NEAR within 30 days of results. |

### 12.3 README plan (written for a machine reader and a human)
HACKATHON.md says the README should state what the product is, the problem it solves, and how to try it as "do X – see Y" steps, with no marketing.
1. What Launchly is and the problem it solves (short).
2. How NEAR and NEAR Intents are used, and what is simulated (vault yield, social data) versus real.
3. Setup: one command to install, one to run, with required environment variables listed (no secrets in the repo).
4. Walkthrough: "Launch a coin – see it on the curve. Trade – see fees split. Submit a post – see it approved. End the cycle – see creators paid. Publish a milestone – see the vote and unlock."
5. Contract addresses and transaction references from the demo run.
6. Libraries, templates, and AI-generated code used.
7. Known limitations and risks.

### 12.4 Demo post (the human writes and posts it)
- Says the project was built at NEAR HACKATHON and tags @NEARProtocol and #NEARHackathon (@NearLegion and @NearBuilders optional).
- First line explains the user problem without needing context: founders can't afford marketing.
- Shows one complete moment: a trade splitting fees, a creator getting paid, a milestone unlocking.
- Explains NEAR's role concretely: Intents moves value in and out across chains, and NEAR contracts hold the rules and the pool.
- Links the repo and demo and asks for specific feedback.

### 12.5 Submission checklist
The human provides every value below. Nothing should be guessed or filled with placeholders, and nothing is sent without the human confirming the exact payload.
- Project name: Launchly
- Team lead name, contact email, team size
- Tracks (ids, see 12.1)
- NEAR account for the payout, created by the team
- Public repository link (public before 2026-11-14T23:59:00Z)
- Public demo post link on X
- "What did you build" (20–2000 characters): problem, product, and how NEAR fits (draft in 12.6)
- Consent to the contact notice

The repository must be public before the deadline, a repository can be submitted only once, and mistakes are fixed through the request-changes page, not a second submission.

### 12.6 Draft for the "What did you build" field
Update it to match what is actually built before submitting.

> Launchly helps developers and founders who cannot afford marketing get promoted by the community. A founder lists a product and launches a memecoin for it on a NEAR bonding curve. Each trade pays a fee: 70% goes to a promotional pool, 20% to platform operations, and 10% to the founder. Creators post about the product and submit links. A verifier approves qualified posts, holders rate them, and at the end of each cycle (30 days in the design, minutes in the demo) the contract splits the pool among creators. The founder's supply is locked and unlocks in tranches only when coin holders approve published milestones, which addresses founder rug pulls. Reserve yield is simulated in this prototype and labeled as such. NEAR Intents lets traders pay in from other chains and receive the reserve stablecoin on NEAR, and lets creators take payouts in the asset and chain they prefer, using the 1Click API (dry quotes plus a tiny mainnet swap, since Intents has no testnet). The core contracts (NEP-141 token, curve, fee router, pool, vesting, voting) run on NEAR testnet.

## 13. Timeline

- Development ends: **2026-11-14, 23:59 UTC**
- Judging: 2026-11-16 to 2026-11-18. Results by 2026-11-18, 23:59 UTC.

Suggested order of work, given the short window:
1. Token, curve, and fee router contracts with tests.
2. Pool and payout cycle.
3. Vesting and milestone vote.
4. Verifier service and simulated social data.
5. Intents adapter (dry quotes first, then one real tiny swap).
6. Dashboard UI.
7. README, demo video, repo public, demo post, then submit.

## 14. One-sentence description

Launchly is a NEAR-powered growth engine where each product's memecoin turns trading fees into a promotional pool that pays creators for qualified posts, NEAR Intents moves value across chains, and founders unlock their locked supply only when holders approve their milestones.