//! Launchly main contract: product registry, per-product memecoin factory,
//! bonding-curve trading with fee routing, creator promotion pools with
//! payout cycles, founder vesting with holder-approved milestones, and a
//! labeled simulated yield module.
//!
//! Money flow notes (see IDEA.md sections 3-5):
//! - Trading is in a per-product NEP-141 reserve stablecoin. Buys and sells
//!   arrive via `ft_transfer_call` and are settled in callbacks, so every
//!   failure path refunds instead of locking funds.
//! - Fees (70% pool / 20% ops / 10% founder) accrue to pull-based claimable
//!   balances; payouts are claimed after the dispute window.
//! - Posts are scored by one-shot verifier attestations (quality score 0-100,
//!   content hash) plus holder ratings; only posts confirmed still-live at
//!   cycle close count.
//! - Milestone votes lock product tokens via `ft_transfer_call` until the
//!   window ends (weight = locked amount, linear, 5%-capped). Post ratings
//!   still check `ft_balance_of` at vote time (bounded 0.5x-1.5x effect).

use near_sdk::json_types::U128;
use near_sdk::store::{IterableMap, LookupMap, LookupSet};
use near_sdk::{
    env, log, near, require, AccountId, Gas, NearToken, PanicOnDefault, Promise, PromiseError,
    PromiseOrValue,
};

mod curve;
use curve::{
    buy_quote, fee_of, sell_proceeds, split_fee, FOUNDER_SUPPLY, MAX_P0, MAX_RISE,
};

// ---------- constants ----------

const NO_DEPOSIT: NearToken = NearToken::from_yoctonear(0);
const ONE_YOCTO: NearToken = NearToken::from_yoctonear(1);

/// Extra state bytes covered by the launch deposit beyond the stored wasm
/// (account record, token init state, margin). Exactness avoids locking
/// excess funds in the keyless sub-account.
const LAUNCH_MARGIN_BYTES: u128 = 8_192;
/// NEAR the contract attaches when registering itself or the founder on a
/// newly deployed token (NEP-145). Generous; excess stays as storage balance.
const TOKEN_REGISTRATION_DEPOSIT: NearToken =
    NearToken::from_yoctonear(10_000_000_000_000_000_000_000); // 0.01 NEAR

const MIN_FEE_BPS: u16 = 50;
const MAX_FEE_BPS: u16 = 200;
const MIN_NAME_LEN: usize = 1;
const MAX_NAME_LEN: usize = 64;
const MIN_SYMBOL_LEN: usize = 1;
const MAX_SYMBOL_LEN: usize = 16;
const MAX_DESCRIPTION_LEN: usize = 4_000;
const MAX_URL_LEN: usize = 500;
/// Bounds finalize_cycle gas: posts per product-cycle.
const MAX_POSTS_PER_CYCLE: usize = 500;
/// Max verifier attestation score per post (0..=100). Final post score is
/// verifier_score * rating_multiplier / 100.
const MAX_VERIFIER_SCORE: u8 = 100;
/// Max length of the off-chain content hash stored per attestation.
const MAX_POST_HASH_LEN: usize = 128;
/// Quality multiplier for rated posts, in percent: 50 + (avg100 - 100) / 4,
/// which maps average rating 1..=5 onto 50%..=150%. Unrated posts use 100%.
const RATING_MULT_BASE_PCT: u128 = 50;
/// Simulated vault: half the pool treated as deployed at 5% APR.
/// yield = balance * dt / (40 * YEAR_NS). Labeled simulated everywhere.
const YEAR_NS: u64 = 365 * 24 * 3_600 * 1_000_000_000;
const MAX_ACCRUAL_NS: u64 = 30 * 24 * 3_600 * 1_000_000_000; // 30 days per call

// ---------- vault (Burrow supply adapter) ----------
//
// Idle reserve (curve backing + promo pool fees) is supplied to Burrow and
// recalled on demand. All measured yield credits the current cycle pool.
// Thresholds below are USD notional; the reserve IS a stablecoin, so they
// convert via the product's own `reserve_decimals` (no oracle needed).
/// Gate: a product's eligible liquidity (curve_reserve + current pool) must
/// reach this before any deposit. Per-product override via set_vault_min_start.
const VAULT_MIN_START_USD: u128 = 1_000;
/// Max share of eligible liquidity ever deployed (basis points).
const VAULT_MAX_DEPLOY_BPS: u128 = 7_000; // 70% deployed, 30%+ stays liquid
/// Liquid buffer as basis points of eligible (deposit caps respect this).
const VAULT_BUFFER_BPS: u128 = 3_000;
/// Absolute liquid floor: deposits never leave less than this behind.
const VAULT_BUFFER_FLOOR_USD: u128 = 200;
/// Dust guard: deposits/withdrawals below this are skipped.
const VAULT_MIN_OP_USD: u128 = 10;
/// NEAR attached to Burrow `storage_deposit` for this contract (Burrow min).
const VAULT_REGISTER_DEPOSIT: NearToken =
    NearToken::from_yoctonear(100_000_000_000_000_000_000_000); // 0.1 NEAR
/// Default Burrow `extra_decimals` when no per-token scale is set (fakes USDT).
const VAULT_DEFAULT_SCALE: u8 = 12;

const GAS_MINT: Gas = Gas::from_tgas(15);
const GAS_CALLBACK: Gas = Gas::from_tgas(25);
// Launch chain: each callback below must also fund its downstream promises,
// so allocations shrink along the chain. Totals stay under 300 Tgas per tx.
const GAS_CB_DEPLOYED: Gas = Gas::from_tgas(50);
const GAS_CB_MAIN_REG: Gas = Gas::from_tgas(165);
const GAS_CB_FOUNDER_REG: Gas = Gas::from_tgas(120);
const GAS_CB_MINTED: Gas = Gas::from_tgas(70);
// on_sell_burned pays the seller and chains a settlement callback. The paid
// callback may start a shortfall registration check, hence its budget.
// Measured ~18T exec + 12T pay + 75T callback ≈ 105T worst case.
const GAS_CB_SELL: Gas = Gas::from_tgas(115);
const GAS_SELL_PAID_CB: Gas = Gas::from_tgas(75);
// claim_payout's settle may start a vault recall chain, hence its budget.
const GAS_PAYOUT_CB: Gas = Gas::from_tgas(260);
const GAS_FT_TRANSFER: Gas = Gas::from_tgas(12);
const GAS_DEPLOY_BATCH: Gas = Gas::from_tgas(60);
// Vault chains: every callback's budget covers its own execution PLUS the
// promises it creates (NEAR deducts downstream attachments from the
// creator's budget). Single withdraw ≈ 202 Tgas prepaid worst case; settle
// never chains a second withdraw (the keeper loops) so chains stay bounded.
const GAS_VAULT_FT_CALL: Gas = Gas::from_tgas(60);
const GAS_VAULT_CB: Gas = Gas::from_tgas(30);
const GAS_VAULT_BEFORE_CB: Gas = Gas::from_tgas(230);
const GAS_VAULT_EXECUTED_CB: Gas = Gas::from_tgas(120);
const GAS_VAULT_SETTLE_CB: Gas = Gas::from_tgas(80);
const GAS_BURROW_EXECUTE: Gas = Gas::from_tgas(80);

// ---------- types ----------

#[near(serializers = [json, borsh])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ProductStatus {
    Created,
    Launching,
    Live,
}

#[near(serializers = [json, borsh])]
#[derive(Clone, Debug)]
pub struct Product {
    pub founder: AccountId,
    pub name: String,
    pub symbol: String,
    pub description: String,
    pub demo_url: String,
    /// sha256 of the canonical off-chain metadata JSON (BACKEND.md section 2),
    /// anchoring product content. Optional; when present, exactly 64
    /// lowercase hex chars. Immutable after creation in v1.
    pub metadata_hash: Option<String>,
    /// sha256 of the canonical campaign-rules JSON the verifier applies.
    /// Same format and immutability as `metadata_hash`.
    pub rules_hash: Option<String>,
    pub reserve_token: AccountId,
    pub reserve_decimals: u8,
    pub token_account: Option<AccountId>,
    pub status: ProductStatus,
    pub fee_bps: u16,
    pub curve_p0: u128,
    pub curve_rise: u128,
    pub min_vote_holding: u128,
    pub max_posts_per_creator: u8,
    pub cycle_duration_ns: u64,
    pub dispute_duration_ns: u64,
    pub milestone_window_ns: u64,
    pub milestone_deadline_ns: u64,
    pub curve_sold: u128,
    pub curve_reserve: u128,
    pub founder_locked: u128,
    pub founder_minted: bool,
    pub tranches_released: u8,
    pub next_milestone: u8,
    pub cycle_id: u64,
    pub cycle_end_ns: u64,
    pub last_yield_ns: u64,
    pub launched_at_ns: u64,
}

#[near(serializers = [json, borsh])]
#[derive(Clone, Debug, Default)]
pub struct CyclePool {
    pub balance: u128,
    pub finalized: bool,
    pub total_score: u128,
    pub payout_available_ns: u64,
}

#[near(serializers = [json, borsh])]
#[derive(Clone, Debug)]
pub struct Post {
    /// Registry nonce, assigned at submit. Views return bare Posts, so the
    /// id rides along — without it no backend could attest, confirm, or
    /// rate what it lists.
    pub post_id: u64,
    pub product_id: u64,
    pub cycle_id: u64,
    pub creator: AccountId,
    pub url: String,
    pub linked_account: String,
    pub created_at_ns: u64,
    pub approved: bool,
    /// One-shot verifier attestation: quality score 0-100 plus a hash of the
    /// fetched content (never the text). `attested` gates re-attestation.
    pub attested: bool,
    pub verifier_score: u8,
    pub post_hash: String,
    /// Set by `confirm_liveness` near cycle close. Unconfirmed posts fail
    /// closed: they never count toward the payout.
    pub live_confirmed: bool,
    pub rating_sum: u64,
    pub rating_count: u32,
}

#[near(serializers = [json, borsh])]
#[derive(Clone, Debug)]
pub struct Milestone {
    pub product_id: u64,
    pub index: u8,
    pub evidence_url: String,
    /// sha256 of the canonical milestone-evidence JSON served by the
    /// backend. Optional; when present, exactly 64 lowercase hex chars.
    pub evidence_hash: Option<String>,
    pub published_at_ns: u64,
    pub window_end_ns: u64,
    pub snapshot_circulating: u128,
    pub approve_weight: u128,
    pub reject_weight: u128,
    pub finalized: bool,
    pub released: bool,
    pub burned: bool,
}

#[near(serializers = [json, borsh])]
#[derive(Clone, Debug)]
pub struct PendingBuy {
    pub buyer: AccountId,
    pub product_id: u64,
    pub reserve_in: u128,
    pub tokens_out: u128,
    pub cost: u128,
    pub fee_pool: u128,
    pub fee_ops: u128,
    pub fee_founder: u128,
}

#[near(serializers = [json, borsh])]
#[derive(Clone, Debug)]
pub struct PendingSell {
    pub seller: AccountId,
    pub product_id: u64,
    pub tokens_in: u128,
    pub proceeds: u128,
    pub fee_pool: u128,
    pub fee_ops: u128,
    pub fee_founder: u128,
}

/// Message attached to `ft_transfer_call` into this contract.
#[near(serializers = [json])]
#[derive(Clone, Debug)]
pub enum TransferMsg {
    Buy {
        product_id: u64,
        min_tokens_out: U128,
    },
    Sell {
        product_id: u64,
        min_reserve_out: U128,
    },
    /// Lock product tokens as a milestone vote. Weight = locked amount
    /// (linear, 5%-capped, excess refunded); tokens unlock after finalize.
    Vote {
        product_id: u64,
        index: u8,
        approve: bool,
    },
}

/// One liveness verdict inside a `confirm_liveness` batch.
#[near(serializers = [json])]
#[derive(Clone, Debug)]
pub struct LiveConfirmation {
    pub post_id: u64,
    pub live: bool,
}

/// Tokens locked by one voter on one milestone, returned by `unlock_vote`.
#[near(serializers = [json, borsh])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct LockedVote {
    pub approve: bool,
    pub amount: u128,
}

/// A sell payout queued while the vault recalls liquid: the seller's tokens
/// are already burned, so this must pay out (or convert to claimable), never
/// vanish. Paid FIFO when a withdraw settles, remainder via `drain_pending`.
#[near(serializers = [json, borsh])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PendingPayout {
    pub seller: AccountId,
    pub amount: u128,
}

/// Vault status for one product (view).
#[near(serializers = [json])]
#[derive(Clone, Debug)]
pub struct VaultPosition {
    pub burrow: Option<AccountId>,
    pub enabled: bool,
    pub principal: U128,
    pub busy: bool,
    pub pending_count: u32,
    pub pending_total: U128,
    pub recall: U128,
    pub min_start: U128,
    pub eligible: U128,
    pub deployable: U128,
    pub asset_scale: u8,
}

#[near(serializers = [json])]
#[derive(Clone, Debug)]
pub struct ContractConfig {
    pub owner: AccountId,
    pub ops_account: AccountId,
    pub verifier: AccountId,
    pub paused: bool,
    pub token_wasm_bytes: u64,
    pub product_count: u64,
}

// ---------- state ----------

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Contract {
    owner: AccountId,
    ops_account: AccountId,
    verifier: AccountId,
    paused: bool,
    token_wasm: Vec<u8>,
    next_product_id: u64,
    products: IterableMap<u64, Product>,
    pools: LookupMap<(u64, u64), CyclePool>,
    cycle_posts: LookupMap<(u64, u64), Vec<u64>>,
    posts: LookupMap<u64, Post>,
    post_nonce: u64,
    post_votes: LookupMap<(u64, AccountId), u8>,
    creator_post_counts: LookupMap<(u64, u64, AccountId), u8>,
    payouts: LookupMap<(u64, u64, AccountId), u128>,
    claimed: LookupSet<(u64, u64, AccountId)>,
    held: LookupSet<(u64, u64, AccountId)>,
    milestones: LookupMap<(u64, u8), Milestone>,
    vote_locks: LookupMap<(u64, u8, AccountId), LockedVote>,
    pend_buys: LookupMap<u64, PendingBuy>,
    pend_sells: LookupMap<u64, PendingSell>,
    op_nonce: u64,
    claimables: LookupMap<(AccountId, AccountId), u128>,
    // Vault (Burrow supply adapter). Principal is tracked per product in
    // reserve base units; funds only move pool/curve ⇄ Burrow ⇄ pool.
    vault_burrow: Option<AccountId>,
    vault_enabled: bool,
    vault_principal: LookupMap<u64, u128>,
    vault_busy: LookupSet<u64>,
    vault_pending: LookupMap<u64, Vec<PendingPayout>>,
    vault_recall: LookupMap<u64, u128>,
    vault_min_start: LookupMap<u64, u128>,
    vault_scale: LookupMap<AccountId, u8>,
    cycle_owed: LookupMap<(u64, u64), u128>,
    // (product_id, post url) pairs already submitted. The backend dedupes
    // by content hash, but that only catches copies after the fact; the
    // chain rejects an identical URL for the same product up front.
    post_urls: LookupSet<(u64, String)>,
}

#[near]
impl Contract {
    #[init]
    pub fn new(owner: AccountId, ops_account: AccountId, verifier: AccountId) -> Self {
        assert!(!env::state_exists(), "Already initialized");
        Self {
            owner,
            ops_account,
            verifier,
            paused: false,
            token_wasm: Vec::new(),
            next_product_id: 1,
            products: IterableMap::new(b"p".to_vec()),
            pools: LookupMap::new(b"o".to_vec()),
            cycle_posts: LookupMap::new(b"cp".to_vec()),
            posts: LookupMap::new(b"t".to_vec()),
            post_nonce: 1,
            post_votes: LookupMap::new(b"pv".to_vec()),
            creator_post_counts: LookupMap::new(b"cc".to_vec()),
            payouts: LookupMap::new(b"py".to_vec()),
            claimed: LookupSet::new(b"cl".to_vec()),
            held: LookupSet::new(b"h".to_vec()),
            milestones: LookupMap::new(b"m".to_vec()),
            vote_locks: LookupMap::new(b"mv".to_vec()),
            pend_buys: LookupMap::new(b"pb".to_vec()),
            pend_sells: LookupMap::new(b"ps".to_vec()),
            op_nonce: 1,
            claimables: LookupMap::new(b"cb".to_vec()),
            vault_burrow: None,
            vault_enabled: false,
            vault_principal: LookupMap::new(b"vp".to_vec()),
            vault_busy: LookupSet::new(b"vb".to_vec()),
            vault_pending: LookupMap::new(b"vq".to_vec()),
            vault_recall: LookupMap::new(b"vr".to_vec()),
            vault_min_start: LookupMap::new(b"vs".to_vec()),
            vault_scale: LookupMap::new(b"vx".to_vec()),
            cycle_owed: LookupMap::new(b"co".to_vec()),
            post_urls: LookupSet::new(b"pu".to_vec()),
        }
    }

    // ---------- internal helpers ----------

    fn assert_owner(&self) {
        assert_eq!(
            env::predecessor_account_id(),
            self.owner,
            "Only the owner can call this method"
        );
    }

    fn assert_not_paused(&self) {
        assert!(!self.paused, "Contract is paused");
    }

    fn product(&self, product_id: u64) -> Product {
        self.products
            .get(&product_id)
            .cloned()
            .unwrap_or_else(|| env::panic_str(&format!("No product {product_id}")))
    }

    fn live_product(&self, product_id: u64) -> Product {
        let p = self.product(product_id);
        assert_eq!(p.status, ProductStatus::Live, "Product is not live");
        p
    }

    fn pool(&self, product_id: u64, cycle_id: u64) -> CyclePool {
        self.pools
            .get(&(product_id, cycle_id))
            .cloned()
            .unwrap_or_default()
    }

    fn add_claimable(&mut self, token: &AccountId, account: &AccountId, amount: u128) {
        if amount == 0 {
            return;
        }
        let key = (token.clone(), account.clone());
        let cur = self.claimables.get(&key).copied().unwrap_or(0);
        self.claimables.insert(key, cur + amount);
    }

    fn next_op_nonce(&mut self) -> u64 {
        let n = self.op_nonce;
        self.op_nonce += 1;
        n
    }

    /// Validate an optional sha256 anchor: absent is fine, present must be
    /// exactly 64 lowercase hex characters (no 0x prefix, no uppercase).
    fn assert_hash_or_none(value: &Option<String>, field: &str) {
        if let Some(h) = value {
            require!(
                h.len() == 64
                    && h.bytes()
                        .all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f')),
                format!("{field} must be 64 lowercase hex chars or omitted")
            );
        }
    }

    /// NEP-297 standard event, so dashboards and judges can trace attestations,
    /// liveness verdicts, and cycle closes off-chain.
    fn emit_event(event: &str, data: near_sdk::serde_json::Value) {
        log!(
            r#"EVENT_JSON:{{"standard":"nep297","version":"1.0.0","event":"{}","data":{}}}"#,
            event, data
        );
    }

    /// Refund storage overpayment. Callers attach NEAR; anything above the
    /// measured state growth goes back to the predecessor.
    fn refund_storage(start_usage: u64) {
        let used = env::storage_usage().saturating_sub(start_usage) as u128;
        let cost = env::storage_byte_cost().saturating_mul(used);
        let attached = env::attached_deposit();
        assert!(
            attached >= cost,
            "Attach at least {cost} yoctoNEAR for storage"
        );
        let refund = attached.saturating_sub(cost);
        if refund.as_yoctonear() > 1 {
            Promise::new(env::predecessor_account_id())
                .transfer(refund)
                .detach();
        }
    }

    // ---------- registry ----------

    /// Register a product and its immutable coin rules. Payable: attach NEAR
    /// for storage, excess is refunded. The caller becomes the founder;
    /// only the founder can later `launch_coin`. Optional `metadata_hash`
    /// / `rules_hash` anchor the backend's canonical product JSON on-chain.
    #[payable]
    pub fn create_product(
        &mut self,
        name: String,
        symbol: String,
        description: String,
        demo_url: String,
        metadata_hash: Option<String>,
        rules_hash: Option<String>,
        reserve_token: AccountId,
        reserve_decimals: u8,
        fee_bps: u16,
        curve_p0: U128,
        curve_rise: U128,
        min_vote_holding: U128,
        max_posts_per_creator: u8,
        cycle_duration_ns: u64,
        dispute_duration_ns: u64,
        milestone_window_ns: u64,
        milestone_deadline_ns: u64,
    ) -> u64 {
        let start_usage = env::storage_usage();
        self.assert_not_paused();
        require!(
            name.len() >= MIN_NAME_LEN && name.len() <= MAX_NAME_LEN,
            "name must be 1-64 chars"
        );
        require!(
            symbol.len() >= MIN_SYMBOL_LEN && symbol.len() <= MAX_SYMBOL_LEN,
            "symbol must be 1-16 chars"
        );
        require!(description.len() <= MAX_DESCRIPTION_LEN, "description too long");
        require!(demo_url.len() <= MAX_URL_LEN, "demo url too long");
        Self::assert_hash_or_none(&metadata_hash, "metadata_hash");
        Self::assert_hash_or_none(&rules_hash, "rules_hash");
        require!(reserve_decimals <= 24, "reserve decimals must fit u128 math");
        require!(
            fee_bps >= MIN_FEE_BPS && fee_bps <= MAX_FEE_BPS,
            "fee_bps must be 50-200 (0.5%-2%)"
        );
        let (curve_p0, curve_rise, min_vote_holding) =
            (curve_p0.0, curve_rise.0, min_vote_holding.0);
        require!(curve_p0 >= 1 && curve_p0 <= MAX_P0, "curve_p0 out of bounds");
        require!(curve_rise <= MAX_RISE, "curve_rise out of bounds");
        require!(max_posts_per_creator >= 1, "need at least 1 counted post");
        require!(cycle_duration_ns >= 10_000_000_000, "cycle must last >= 10s");
        require!(
            milestone_window_ns >= 10_000_000_000,
            "milestone window must last >= 10s"
        );
        require!(
            milestone_deadline_ns >= milestone_window_ns,
            "deadline must cover the window"
        );

        let product_id = self.next_product_id;
        self.next_product_id += 1;
        self.products.insert(
            product_id,
            Product {
                founder: env::predecessor_account_id(),
                name: name.clone(),
                symbol: symbol.clone(),
                description,
                demo_url,
                metadata_hash: metadata_hash.clone(),
                rules_hash: rules_hash.clone(),
                reserve_token,
                reserve_decimals,
                token_account: None,
                status: ProductStatus::Created,
                fee_bps,
                curve_p0,
                curve_rise,
                min_vote_holding,
                max_posts_per_creator,
                cycle_duration_ns,
                dispute_duration_ns,
                milestone_window_ns,
                milestone_deadline_ns,
                curve_sold: 0,
                curve_reserve: 0,
                founder_locked: 0,
                founder_minted: false,
                tranches_released: 0,
                next_milestone: 0,
                cycle_id: 0,
                cycle_end_ns: 0,
                last_yield_ns: 0,
                launched_at_ns: 0,
            },
        );
        Self::emit_event(
            "product_created",
            near_sdk::serde_json::json!({
                "product_id": product_id,
                "founder": env::predecessor_account_id(),
                "name": name,
                "symbol": symbol,
                "metadata_hash": metadata_hash,
                "rules_hash": rules_hash,
            }),
        );
        Self::refund_storage(start_usage);
        product_id
    }

    // ---------- coin launch (factory) ----------

    /// Store the token-contract WASM this factory deploys per product.
    /// Owner only. Payable: attach NEAR for storage, excess is refunded.
    #[payable]
    pub fn set_token_wasm(&mut self, wasm: Vec<u8>) {
        let start_usage = env::storage_usage();
        self.assert_owner();
        require!(!wasm.is_empty(), "wasm must not be empty");
        require!(wasm.len() <= 5_000_000, "wasm too large");
        self.token_wasm = wasm;
        log!("token_wasm stored bytes={}", self.token_wasm.len());
        Self::refund_storage(start_usage);
    }

    /// Exact launch deposit for the token sub-account: storage for the
    /// deployed code plus init state and margin. Query this view, then attach
    /// exactly that amount to `launch_coin`.
    pub fn get_launch_cost(&self) -> U128 {
        U128(
            env::storage_byte_cost()
                .saturating_mul(self.token_wasm.len() as u128 + LAUNCH_MARGIN_BYTES)
                .as_yoctonear(),
        )
    }

    /// Deploy the product coin to `p<id>.<this-contract>` and initialize it
    /// with this contract as minter. Then call `complete_launch` (separate
    /// transaction: the full chain would exceed the per-tx gas limit).
    /// Attach exactly `get_launch_cost()` to fund the sub-account.
    /// Founder only. (This method takes no free parameters — every coin
    /// rule is fixed at `create_product` — so a third-party launch could
    /// not change anything; restricting it anyway removes even launch
    /// timing grief. `complete_launch` stays permissionless: it can only
    /// finish an in-flight launch with the registered parameters.)
    #[payable]
    pub fn launch_coin(&mut self, product_id: u64) -> Promise {
        self.assert_not_paused();
        require!(!self.token_wasm.is_empty(), "token wasm not stored yet");
        let required = env::storage_byte_cost()
            .saturating_mul(self.token_wasm.len() as u128 + LAUNCH_MARGIN_BYTES);
        require!(
            env::attached_deposit() == required,
            format!(
                "Attach exactly {required} yoctoNEAR (see get_launch_cost)"
            )
        );
        let mut p = self.product(product_id);
        require!(
            env::predecessor_account_id() == p.founder,
            "Only the founder can launch this product"
        );
        require!(
            p.status == ProductStatus::Created,
            "Product already launched or launching"
        );
        let token_account: AccountId = format!("p{product_id}.{}", env::current_account_id())
            .parse()
            .unwrap();
        require!(
            env::is_valid_account_id(token_account.as_bytes()),
            "Bad token account id"
        );
        p.status = ProductStatus::Launching;
        p.token_account = Some(token_account.clone());
        self.products.insert(product_id, p.clone());

        let init_args = near_sdk::serde_json::to_vec(&near_sdk::serde_json::json!({
            "minter": env::current_account_id(),
            "metadata": {
                "spec": "ft-1.0.0",
                "name": p.name,
                "symbol": p.symbol,
                "icon": null,
                "reference": null,
                "reference_hash": null,
                "decimals": 18u8,
            },
        }))
        .unwrap();
        let callback_args = near_sdk::serde_json::to_vec(&near_sdk::serde_json::json!({
            "product_id": product_id,
        }))
        .unwrap();

        Promise::new(token_account)
            .create_account()
            .transfer(required)
            .deploy_contract(self.token_wasm.clone())
            .function_call(
                "new".to_string(),
                init_args,
                NO_DEPOSIT,
                GAS_DEPLOY_BATCH,
            )
            .then(Promise::new(env::current_account_id()).function_call(
                "on_token_deployed".to_string(),
                callback_args,
                NO_DEPOSIT,
                GAS_CB_DEPLOYED,
            ))
    }

    /// Finish a launch: register on the new token, mint the locked founder
    /// allocation, register on the reserve token, then go `Live`.
    /// Permissionless; the contract pays the small registration deposits.
    /// Also retries a launch stuck in `Launching`.
    pub fn complete_launch(&mut self, product_id: u64) -> Promise {
        let p = self.product(product_id);
        require!(
            p.status == ProductStatus::Launching && p.token_account.is_some(),
            "Nothing to complete"
        );
        self.register_on_token(product_id)
    }

    /// Alias of `complete_launch` for a launch stuck in `Launching`.
    pub fn retry_launch(&mut self, product_id: u64) -> Promise {
        self.complete_launch(product_id)
    }

    fn register_on_token(&self, product_id: u64) -> Promise {
        let p = self.product(product_id);
        let token = p.token_account.clone().expect("no token account");
        let args = near_sdk::serde_json::to_vec(&near_sdk::serde_json::json!({
            "account_id": env::current_account_id(),
        }))
        .unwrap();
        let callback_args = near_sdk::serde_json::to_vec(&near_sdk::serde_json::json!({
            "product_id": product_id,
        }))
        .unwrap();
        Promise::new(token).function_call(
            "storage_deposit".to_string(),
            args,
            TOKEN_REGISTRATION_DEPOSIT,
            GAS_FT_TRANSFER,
        ).then(
            Promise::new(env::current_account_id()).function_call(
                "on_main_registered".to_string(),
                callback_args,
                NO_DEPOSIT,
                GAS_CB_MAIN_REG,
            ),
        )
    }

    #[private]
    pub fn on_token_deployed(
        &mut self,
        product_id: u64,
        #[callback_result] result: Result<(), PromiseError>,
    ) -> Promise {
        if result.is_err() {
            // The batch failed (e.g. sub-account already exists). Reset so a
            // fixed launch can be attempted again. NOTE: if the account was
            // created but init failed, the deposit sits in the keyless
            // sub-account; the stored wasm is tested, so this is unexpected.
            let mut p = self.product(product_id);
            if p.status == ProductStatus::Launching {
                p.status = ProductStatus::Created;
                p.token_account = None;
                self.products.insert(product_id, p);
            }
            log!("token deploy failed, product reset to Created");
        } else {
            log!("token deployed; call complete_launch to finish");
        }
        Promise::new(env::current_account_id()).function_call(
            "noop".to_string(),
            Vec::new(),
            NO_DEPOSIT,
            GAS_CALLBACK,
        )
    }

    #[private]
    pub fn on_main_registered(
        &mut self,
        product_id: u64,
        #[callback_result] result: Result<near_sdk::serde_json::Value, PromiseError>,
    ) -> Promise {
        if result.is_err() {
            log!("main registration on token failed; call retry_launch");
            return Promise::new(env::current_account_id())
                .function_call("noop".to_string(), Vec::new(), NO_DEPOSIT, GAS_CALLBACK);
        }
        // Register the founder too, so milestone tranche payouts never fail.
        let p = self.product(product_id);
        let token = p.token_account.clone().expect("no token account");
        let args = near_sdk::serde_json::to_vec(&near_sdk::serde_json::json!({
            "account_id": p.founder,
        }))
        .unwrap();
        let callback_args = near_sdk::serde_json::to_vec(&near_sdk::serde_json::json!({
            "product_id": product_id,
        }))
        .unwrap();
        Promise::new(token)
            .function_call(
                "storage_deposit".to_string(),
                args,
                TOKEN_REGISTRATION_DEPOSIT,
                GAS_FT_TRANSFER,
            )
            .then(
                Promise::new(env::current_account_id()).function_call(
                    "on_founder_registered".to_string(),
                    callback_args,
                    NO_DEPOSIT,
                    GAS_CB_FOUNDER_REG,
                ),
            )
    }

    #[private]
    pub fn on_founder_registered(
        &mut self,
        product_id: u64,
        #[callback_result] result: Result<near_sdk::serde_json::Value, PromiseError>,
    ) -> Promise {
        if result.is_err() {
            log!("founder registration on token failed; call retry_launch");
            return Promise::new(env::current_account_id()).function_call(
                "noop".to_string(),
                Vec::new(),
                NO_DEPOSIT,
                GAS_CALLBACK,
            );
        }
        let p = self.product(product_id);
        if p.founder_minted {
            // Retry after a later step failed: skip straight to reserve
            // registration instead of minting twice.
            return self.register_on_reserve(product_id);
        }
        // Mint the locked founder allocation (10%) to this contract.
        let token = p.token_account.clone().expect("no token account");
        let args = near_sdk::serde_json::to_vec(&near_sdk::serde_json::json!({
            "account_id": env::current_account_id(),
            "amount": U128(FOUNDER_SUPPLY),
        }))
        .unwrap();
        let callback_args = near_sdk::serde_json::to_vec(&near_sdk::serde_json::json!({
            "product_id": product_id,
        }))
        .unwrap();
        Promise::new(token)
            .function_call("mint".to_string(), args, NO_DEPOSIT, GAS_MINT)
            .then(
                Promise::new(env::current_account_id()).function_call(
                    "on_founder_minted".to_string(),
                    callback_args,
                    NO_DEPOSIT,
                    GAS_CB_MINTED,
                ),
            )
    }

    #[private]
    pub fn on_founder_minted(
        &mut self,
        product_id: u64,
        #[callback_result] result: Result<(), PromiseError>,
    ) -> Promise {
        if result.is_err() {
            log!("founder mint failed; call retry_launch");
            return Promise::new(env::current_account_id()).function_call(
                "noop".to_string(),
                Vec::new(),
                NO_DEPOSIT,
                GAS_CALLBACK,
            );
        }
        let mut p = self.product(product_id);
        p.founder_locked = FOUNDER_SUPPLY;
        p.founder_minted = true;
        self.products.insert(product_id, p);
        self.register_on_reserve(product_id)
    }

    /// Register this contract on the product's reserve token so it can
    /// receive trading fees via `ft_transfer_call`. Paid from the contract's
    /// own balance; already-registered is a harmless refund.
    fn register_on_reserve(&self, product_id: u64) -> Promise {
        let p = self.product(product_id);
        let args = near_sdk::serde_json::to_vec(&near_sdk::serde_json::json!({
            "account_id": env::current_account_id(),
        }))
        .unwrap();
        let callback_args = near_sdk::serde_json::to_vec(&near_sdk::serde_json::json!({
            "product_id": product_id,
        }))
        .unwrap();
        Promise::new(p.reserve_token)
            .function_call(
                "storage_deposit".to_string(),
                args,
                TOKEN_REGISTRATION_DEPOSIT,
                GAS_FT_TRANSFER,
            )
            .then(
                Promise::new(env::current_account_id()).function_call(
                    "on_reserve_registered".to_string(),
                    callback_args,
                    NO_DEPOSIT,
                    GAS_CALLBACK,
                ),
            )
    }

    #[private]
    pub fn on_reserve_registered(
        &mut self,
        product_id: u64,
        #[callback_result] result: Result<near_sdk::serde_json::Value, PromiseError>,
    ) {
        if result.is_err() {
            log!("reserve registration failed; call retry_launch");
            return;
        }
        let mut p = self.product(product_id);
        let now = env::block_timestamp();
        p.status = ProductStatus::Live;
        p.cycle_id = 1;
        p.cycle_end_ns = now + p.cycle_duration_ns;
        p.last_yield_ns = now;
        p.launched_at_ns = now;
        self.products.insert(product_id, p);
        self.pools.insert((product_id, 1), CyclePool::default());
        log!("product_live id={product_id}");
    }

    /// No-op target so callbacks can return a Promise on early exit.
    #[private]
    pub fn noop(&self) {}

    // ---------- trading ----------

    /// NEP-141 receiver: buys arrive as the reserve token, sells arrive as
    /// the product token. Returns the unused amount, so any invalid call is
    /// fully refunded by the token contract itself.
    #[payable]
    pub fn ft_on_transfer(
        &mut self,
        sender_id: AccountId,
        amount: U128,
        msg: String,
    ) -> PromiseOrValue<U128> {
        // NOTE: no 1-yocto check here. NEP-141 attaches the yocto to
        // `ft_transfer_call` on the token contract; the token calls us with
        // zero deposit. Unknown predecessors get a full-refund value below.
        self.assert_not_paused();
        let parsed: TransferMsg = near_sdk::serde_json::from_str(&msg)
            .unwrap_or_else(|_| env::panic_str("Bad msg: expected Buy, Sell or Vote"));
        match parsed {
            TransferMsg::Buy {
                product_id,
                min_tokens_out,
            } => self.on_buy_received(sender_id, amount.0, product_id, min_tokens_out.0),
            TransferMsg::Sell {
                product_id,
                min_reserve_out,
            } => self.on_sell_received(sender_id, amount.0, product_id, min_reserve_out.0),
            TransferMsg::Vote {
                product_id,
                index,
                approve,
            } => self.on_vote_received(sender_id, amount.0, product_id, index, approve),
        }
    }

    fn on_buy_received(
        &mut self,
        buyer: AccountId,
        reserve_in: u128,
        product_id: u64,
        min_tokens_out: u128,
    ) -> PromiseOrValue<U128> {
        let full_refund = || PromiseOrValue::Value(U128(reserve_in));
        let Some(p) = self.products.get(&product_id).cloned() else {
            return full_refund();
        };
        if p.status != ProductStatus::Live || env::predecessor_account_id() != p.reserve_token
        {
            return full_refund();
        }
        let fee = fee_of(reserve_in, p.fee_bps);
        let net = reserve_in - fee;
        let (tokens_out, cost) = buy_quote(net, p.curve_sold, p.curve_p0, p.curve_rise);
        if tokens_out == 0 || tokens_out < min_tokens_out {
            return full_refund();
        }
        let dust = net - cost;
        let (mut fee_pool, fee_ops, fee_founder) = split_fee(fee);
        fee_pool += dust; // rounding dust funds the pool, never the trader
        let token = p.token_account.clone().expect("live product has token");

        let nonce = self.next_op_nonce();
        self.pend_buys.insert(
            nonce,
            PendingBuy {
                buyer: buyer.clone(),
                product_id,
                reserve_in,
                tokens_out,
                cost,
                fee_pool,
                fee_ops,
                fee_founder,
            },
        );
        let mint_args = near_sdk::serde_json::to_vec(&near_sdk::serde_json::json!({
            "account_id": buyer,
            "amount": U128(tokens_out),
        }))
        .unwrap();
        let callback_args =
            near_sdk::serde_json::to_vec(&near_sdk::serde_json::json!({ "nonce": nonce }))
                .unwrap();
        PromiseOrValue::Promise(
            Promise::new(token)
                .function_call("mint".to_string(), mint_args, NO_DEPOSIT, GAS_MINT)
                .then(
                    Promise::new(env::current_account_id()).function_call(
                        "on_buy_minted".to_string(),
                        callback_args,
                        NO_DEPOSIT,
                        GAS_CALLBACK,
                    ),
                ),
        )
    }

    #[private]
    pub fn on_buy_minted(
        &mut self,
        nonce: u64,
        #[callback_result] result: Result<(), PromiseError>,
    ) -> U128 {
        // Return value matters: it becomes the `ft_resolve_transfer` input on
        // the token contract. Return unused reserve (0 on success, full
        // amount when the mint failed) and let the resolver refund.
        let pb = self
            .pend_buys
            .remove(&nonce)
            .unwrap_or_else(|| env::panic_str("Unknown pending buy"));
        match result {
            Ok(()) => {
                let mut p = self.product(pb.product_id);
                p.curve_sold += pb.tokens_out;
                p.curve_reserve += pb.cost;
                self.products.insert(pb.product_id, p.clone());
                let mut pool = self.pool(pb.product_id, p.cycle_id);
                pool.balance += pb.fee_pool;
                self.pools.insert((pb.product_id, p.cycle_id), pool);
                self.add_claimable(&p.reserve_token, &self.ops_account.clone(), pb.fee_ops);
                self.add_claimable(&p.reserve_token, &p.founder.clone(), pb.fee_founder);
                log!(
                    "buy product={} buyer={} tokens={} cost={}",
                    pb.product_id, pb.buyer, pb.tokens_out, pb.cost
                );
                U128(0)
            }
            Err(_) => {
                // Mint failed (buyer not registered on the token): report the
                // full amount unused so the resolver refunds it.
                log!(
                    "buy_refunded product={} buyer={} amount={}",
                    pb.product_id, pb.buyer, pb.reserve_in
                );
                U128(pb.reserve_in)
            }
        }
    }

    fn on_sell_received(
        &mut self,
        seller: AccountId,
        tokens_in: u128,
        product_id: u64,
        min_reserve_out: u128,
    ) -> PromiseOrValue<U128> {
        let full_refund = || PromiseOrValue::Value(U128(tokens_in));
        let Some(p) = self.products.get(&product_id).cloned() else {
            return full_refund();
        };
        let token = match p.token_account.clone() {
            Some(t) => t,
            None => return full_refund(),
        };
        if p.status != ProductStatus::Live
            || env::predecessor_account_id() != token
            || tokens_in == 0
            || tokens_in > p.curve_sold
        {
            return full_refund();
        }
        let proceeds = sell_proceeds(p.curve_sold, tokens_in, p.curve_p0, p.curve_rise);
        let fee = fee_of(proceeds, p.fee_bps);
        let net = proceeds - fee;
        if net < min_reserve_out {
            return full_refund();
        }
        let (fee_pool, fee_ops, fee_founder) = split_fee(fee);

        let nonce = self.next_op_nonce();
        self.pend_sells.insert(
            nonce,
            PendingSell {
                seller: seller.clone(),
                product_id,
                tokens_in,
                proceeds,
                fee_pool,
                fee_ops,
                fee_founder,
            },
        );
        let burn_args = near_sdk::serde_json::to_vec(&near_sdk::serde_json::json!({
            "account_id": env::current_account_id(),
            "amount": U128(tokens_in),
        }))
        .unwrap();
        let callback_args =
            near_sdk::serde_json::to_vec(&near_sdk::serde_json::json!({ "nonce": nonce }))
                .unwrap();
        PromiseOrValue::Promise(
            Promise::new(token)
                .function_call("burn_from".to_string(), burn_args, NO_DEPOSIT, GAS_MINT)
                .then(
                    Promise::new(env::current_account_id()).function_call(
                        "on_sell_burned".to_string(),
                        callback_args,
                        NO_DEPOSIT,
                        GAS_CB_SELL,
                    ),
                ),
        )
    }

    #[private]
    pub fn on_sell_burned(
        &mut self,
        nonce: u64,
        #[callback_result] result: Result<(), PromiseError>,
    ) -> PromiseOrValue<U128> {
        // SAFETY: from here on, this chain must not fail. The burn already
        // committed, so a downstream failure makes the NEP-141 resolver
        // refund the seller out of this contract's OTHER token balance —
        // the locked founder allocation. Keep every downstream callback
        // panic-free and gas-sized with margin (see GAS_CB_SELL and the
        // vault e2e shortfall path, which exercises the deepest chain).
        // Like buys: the chain result feeds `ft_resolve_transfer` on the
        // product token. Report unused tokens so failures refund there.
        let ps = self
            .pend_sells
            .remove(&nonce)
            .unwrap_or_else(|| env::panic_str("Unknown pending sell"));
        let mut p = self.product(ps.product_id);
        if result.is_err() {
            log!(
                "sell_refunded product={} seller={} amount={}",
                ps.product_id, ps.seller, ps.tokens_in
            );
            return PromiseOrValue::Value(U128(ps.tokens_in));
        }
        p.curve_sold -= ps.tokens_in;
        p.curve_reserve -= ps.proceeds;
        self.products.insert(ps.product_id, p.clone());
        let mut pool = self.pool(ps.product_id, p.cycle_id);
        pool.balance += ps.fee_pool;
        self.pools.insert((ps.product_id, p.cycle_id), pool);
        self.add_claimable(&p.reserve_token, &self.ops_account.clone(), ps.fee_ops);
        self.add_claimable(&p.reserve_token, &p.founder.clone(), ps.fee_founder);
        let net = ps.proceeds - ps.fee_pool - ps.fee_ops - ps.fee_founder;
        log!(
            "sell product={} seller={} tokens={} net={}",
            ps.product_id, ps.seller, ps.tokens_in, net
        );
        // Pay the seller; if they never registered on the reserve token the
        // callback holds the amount as claimable instead of losing it.
        let pay_args = near_sdk::serde_json::to_vec(&near_sdk::serde_json::json!({
            "receiver_id": ps.seller,
            "amount": U128(net),
        }))
        .unwrap();
        let callback_args = near_sdk::serde_json::to_vec(&near_sdk::serde_json::json!({
            "seller": ps.seller,
            "product_id": ps.product_id,
            "amount": U128(net),
        }))
        .unwrap();
        PromiseOrValue::Promise(
            Promise::new(p.reserve_token)
                .function_call(
                    "ft_transfer".to_string(),
                    pay_args,
                    ONE_YOCTO,
                    GAS_FT_TRANSFER,
                )
                .then(
                    Promise::new(env::current_account_id()).function_call(
                        "on_sell_paid".to_string(),
                        callback_args,
                        NO_DEPOSIT,
                        GAS_SELL_PAID_CB,
                    ),
                ),
        )
    }

    #[private]
    pub fn on_sell_paid(
        &mut self,
        seller: AccountId,
        product_id: u64,
        amount: U128,
        #[callback_result] result: Result<(), PromiseError>,
    ) -> PromiseOrValue<U128> {
        if result.is_ok() {
            // Tokens were consumed by the burn either way: nothing unused.
            return PromiseOrValue::Value(U128(0));
        }
        // Payment failed. Either the seller is not registered on the reserve
        // token, or the vault left too little liquid. When the vault holds
        // funds for this product, check registration: registered sellers get
        // an automatic recall + queued payout, unregistered ones the classic
        // claimable hold.
        let principal = self
            .vault_principal
            .get(&product_id)
            .copied()
            .unwrap_or(0);
        if !self.vault_enabled || principal == 0 {
            let p = self.product(product_id);
            self.add_claimable(&p.reserve_token, &seller, amount.0);
            log!("sell_held_as_claimable product={product_id} seller={seller}");
            return PromiseOrValue::Value(U128(0));
        }
        let p = self.product(product_id);
        let args = near_sdk::serde_json::to_vec(&near_sdk::serde_json::json!({
            "account_id": seller,
        }))
        .unwrap();
        let callback_args = near_sdk::serde_json::to_vec(&near_sdk::serde_json::json!({
            "seller": seller,
            "product_id": product_id,
            "amount": amount,
        }))
        .unwrap();
        PromiseOrValue::Promise(
            Promise::new(p.reserve_token)
                .function_call(
                    "storage_balance_of".to_string(),
                    args,
                    NO_DEPOSIT,
                    GAS_FT_TRANSFER,
                )
                .then(
                    Promise::new(env::current_account_id()).function_call(
                        "on_sell_shortfall_check".to_string(),
                        callback_args,
                        NO_DEPOSIT,
                        GAS_VAULT_CB,
                    ),
                ),
        )
    }

    // ---------- fee claims ----------

    /// Pull accrued fee shares (or held sell proceeds) in any token ledger.
    /// The entry is zeroed before the transfer and restored if it fails, so
    /// concurrent claims cannot double-pay.
    pub fn claim(&mut self, token_id: AccountId) -> Promise {
        let account = env::predecessor_account_id();
        let key = (token_id.clone(), account.clone());
        let amount = self.claimables.get(&key).copied().unwrap_or(0);
        require!(amount > 0, "Nothing to claim");
        self.claimables.insert(key, 0);
        let args = near_sdk::serde_json::to_vec(&near_sdk::serde_json::json!({
            "receiver_id": account,
            "amount": U128(amount),
        }))
        .unwrap();
        let callback_args = near_sdk::serde_json::to_vec(&near_sdk::serde_json::json!({
            "token_id": token_id,
            "account": account,
            "amount": U128(amount),
        }))
        .unwrap();
        Promise::new(token_id)
            .function_call(
                "ft_transfer".to_string(),
                args,
                ONE_YOCTO,
                GAS_FT_TRANSFER,
            )
            .then(
                Promise::new(env::current_account_id()).function_call(
                    "on_claim_settled".to_string(),
                    callback_args,
                    NO_DEPOSIT,
                    GAS_CALLBACK,
                ),
            )
    }

    #[private]
    pub fn on_claim_settled(
        &mut self,
        token_id: AccountId,
        account: AccountId,
        amount: U128,
        #[callback_result] result: Result<(), PromiseError>,
    ) {
        if result.is_err() {
            // Transfer failed (account not registered on the token): restore.
            self.add_claimable(&token_id, &account, amount.0);
            log!("claim_restored token={token_id} account={account}");
        }
    }

    // ---------- creator promotion ----------

    /// Submit a promotional post for the product's current cycle. Payable:
    /// attach NEAR for storage, excess refunded.
    #[payable]
    pub fn submit_post(
        &mut self,
        product_id: u64,
        url: String,
        linked_account: String,
    ) -> u64 {
        let start_usage = env::storage_usage();
        self.assert_not_paused();
        let p = self.live_product(product_id);
        require!(url.len() >= 8 && url.len() <= MAX_URL_LEN, "bad url");
        require!(
            !self.post_urls.contains(&(product_id, url.clone())),
            "This URL was already submitted for this product"
        );
        self.post_urls.insert((product_id, url.clone()));
        require!(
            linked_account.len() >= 2 && linked_account.len() <= 128,
            "bad linked account"
        );
        let now = env::block_timestamp();
        require!(now < p.cycle_end_ns, "Cycle is over, wait for the next one");
        let key = (product_id, p.cycle_id);
        let mut ids = self.cycle_posts.get(&key).cloned().unwrap_or_default();
        require!(
            ids.len() < MAX_POSTS_PER_CYCLE,
            "Too many posts this cycle"
        );
        let post_id = self.post_nonce;
        self.post_nonce += 1;
        self.posts.insert(
            post_id,
            Post {
                post_id,
                product_id,
                cycle_id: p.cycle_id,
                creator: env::predecessor_account_id(),
                url,
                linked_account,
                created_at_ns: now,
                approved: false,
                attested: false,
                verifier_score: 0,
                post_hash: String::new(),
                live_confirmed: false,
                rating_sum: 0,
                rating_count: 0,
            },
        );
        ids.push(post_id);
        self.cycle_posts.insert(key, ids);
        log!("post_submitted id={post_id} product={product_id}");
        Self::refund_storage(start_usage);
        post_id
    }

    /// Verifier (or owner) attests a post after checking it off-chain:
    /// required link/tag, originality, account age. One attestation per
    /// post, ever: mistakes fail safe (re-attestation is rejected, and an
    /// invalid verdict simply never pays).
    ///
    /// `score` is the verifier's quality score, clamped on-chain to 0-100;
    /// `post_hash` is a hash of the fetched content, never the text. The
    /// per-creator counted-post cap is enforced here, so over-cap posts are
    /// rejected at attestation instead of silently dropped at payout.
    pub fn attest_post(&mut self, post_id: u64, valid: bool, score: u8, post_hash: String) {
        let caller = env::predecessor_account_id();
        require!(
            caller == self.verifier || caller == self.owner,
            "Only the verifier can attest posts"
        );
        require!(
            !post_hash.is_empty() && post_hash.len() <= MAX_POST_HASH_LEN,
            "bad post hash"
        );
        let mut post = self
            .posts
            .get(&post_id)
            .cloned()
            .unwrap_or_else(|| env::panic_str("No such post"));
        require!(!post.attested, "Post already attested");
        let pool = self.pool(post.product_id, post.cycle_id);
        require!(!pool.finalized, "Cycle already finalized");
        post.attested = true;
        post.post_hash = post_hash.clone();
        if valid {
            let p = self.product(post.product_id);
            let key = (post.product_id, post.cycle_id, post.creator.clone());
            let n = self.creator_post_counts.get(&key).copied().unwrap_or(0);
            require!(n < p.max_posts_per_creator, "Creator post cap reached");
            self.creator_post_counts.insert(key, n + 1);
            post.approved = true;
            post.verifier_score = score.min(MAX_VERIFIER_SCORE);
        } else {
            post.approved = false;
            post.verifier_score = 0;
        }
        self.posts.insert(post_id, post.clone());
        Self::emit_event(
            "attest_post",
            near_sdk::serde_json::json!({
                "post_id": post_id,
                "product_id": post.product_id,
                "cycle_id": post.cycle_id,
                "creator": post.creator,
                "valid": valid,
                "score": post.verifier_score,
                "post_hash": post_hash,
            }),
        );
    }

    /// Phase 2 of attestation: near cycle close, the verifier confirms which
    /// posts are still live. Only confirmed-live posts count at finalize;
    /// posts with no confirmation fail closed. Rejected by cycle: posts must
    /// belong to (product_id, cycle_id), and the cycle must still be open.
    pub fn confirm_liveness(
        &mut self,
        product_id: u64,
        cycle_id: u64,
        confirmations: Vec<LiveConfirmation>,
    ) {
        let caller = env::predecessor_account_id();
        require!(
            caller == self.verifier || caller == self.owner,
            "Only the verifier can confirm liveness"
        );
        require!(
            !confirmations.is_empty() && confirmations.len() <= MAX_POSTS_PER_CYCLE,
            "bad batch size"
        );
        let pool = self.pool(product_id, cycle_id);
        require!(!pool.finalized, "Cycle already finalized");
        let mut live = 0u32;
        let mut dead = 0u32;
        for c in &confirmations {
            let mut post = self
                .posts
                .get(&c.post_id)
                .cloned()
                .unwrap_or_else(|| env::panic_str("No such post"));
            require!(
                post.product_id == product_id && post.cycle_id == cycle_id,
                "Post is not in this cycle"
            );
            post.live_confirmed = c.live;
            self.posts.insert(c.post_id, post);
            if c.live {
                live += 1;
            } else {
                dead += 1;
            }
        }
        Self::emit_event(
            "confirm_liveness",
            near_sdk::serde_json::json!({
                "product_id": product_id,
                "cycle_id": cycle_id,
                "live": live,
                "dead": dead,
            }),
        );
    }

    /// Rate an approved post 1..=5. One wallet, one vote; the voter's product
    /// token balance is checked on-chain via callback (vote-time holding).
    pub fn rate_post(&mut self, post_id: u64, score: u8) -> Promise {
        self.assert_not_paused();
        require!((1..=5).contains(&score), "score must be 1-5");
        let post = self
            .posts
            .get(&post_id)
            .cloned()
            .unwrap_or_else(|| env::panic_str("No such post"));
        require!(post.approved, "Post is not approved");
        let voter = env::predecessor_account_id();
        require!(voter != post.creator, "Creators cannot rate their own posts");
        require!(
            !self.post_votes.contains_key(&(post_id, voter.clone())),
            "Already rated this post"
        );
        let p = self.live_product(post.product_id);
        require!(
            post.cycle_id == p.cycle_id,
            "Can only rate posts of the current cycle"
        );
        let token = p.token_account.clone().expect("live product has token");
        let balance_args = near_sdk::serde_json::to_vec(&near_sdk::serde_json::json!({
            "account_id": voter,
        }))
        .unwrap();
        let callback_args = near_sdk::serde_json::to_vec(&near_sdk::serde_json::json!({
            "post_id": post_id,
            "voter": voter,
            "score": score,
        }))
        .unwrap();
        Promise::new(token)
            .function_call(
                "ft_balance_of".to_string(),
                balance_args,
                NO_DEPOSIT,
                GAS_FT_TRANSFER,
            )
            .then(
                Promise::new(env::current_account_id()).function_call(
                    "on_post_rated".to_string(),
                    callback_args,
                    NO_DEPOSIT,
                    GAS_CALLBACK,
                ),
            )
    }

    #[private]
    pub fn on_post_rated(
        &mut self,
        post_id: u64,
        voter: AccountId,
        score: u8,
        #[callback_result] result: Result<U128, PromiseError>,
    ) {
        let Ok(balance) = result else {
            log!("rating ignored: balance check failed");
            return;
        };
        let mut post = match self.posts.get(&post_id).cloned() {
            Some(post) => post,
            None => return,
        };
        let p = self.product(post.product_id);
        if balance.0 < p.min_vote_holding {
            log!("rating ignored: {voter} below min holding");
            return;
        }
        if self.post_votes.contains_key(&(post_id, voter.clone())) {
            return;
        }
        self.post_votes.insert((post_id, voter), score);
        post.rating_sum += score as u64;
        post.rating_count += 1;
        self.posts.insert(post_id, post);
    }

    /// Close the current cycle: score qualified posts, split the pool pro
    /// rata, open the next cycle. Permissionless once the end passes.
    /// Remainder dust rolls into the next cycle's pool.
    ///
    /// Only attested-valid AND liveness-confirmed posts count (fail closed).
    /// Post score = verifier_score (0-100) * rating multiplier (50-150%) / 100.
    /// Each creator's share is precomputed and pulled via `claim_payout`, so
    /// no payout loop can run out of gas; this loop is bounded by
    /// MAX_POSTS_PER_CYCLE posts.
    ///
    /// When the vault holds funds, finalize also records a liquid recall for
    /// the newly owed payouts and starts the withdraw at once, so the dispute
    /// window doubles as the unwind window and claims find funds liquid.
    pub fn finalize_cycle(&mut self, product_id: u64) -> PromiseOrValue<()> {
        let mut p = self.live_product(product_id);
        let now = env::block_timestamp();
        require!(now >= p.cycle_end_ns, "Cycle has not ended yet");
        let cycle_id = p.cycle_id;
        let mut pool = self.pool(product_id, cycle_id);
        require!(!pool.finalized, "Cycle already finalized");

        let post_ids = self.cycle_posts.get(&(product_id, cycle_id)).cloned().unwrap_or_default();
        // First pass: per-creator post cap (earliest posts count).
        let mut counted: Vec<u64> = Vec::new();
        let mut per_creator: std::collections::HashMap<AccountId, u8> =
            std::collections::HashMap::new();
        for id in post_ids {
            let post = match self.posts.get(&id).cloned() {
                Some(post) => post,
                None => continue,
            };
            if !post.approved || !post.live_confirmed {
                continue;
            }
            let n = per_creator.entry(post.creator.clone()).or_insert(0);
            if *n >= p.max_posts_per_creator {
                continue;
            }
            *n += 1;
            counted.push(id);
        }
        // Second pass: scores.
        let mut scores: std::collections::HashMap<AccountId, u128> =
            std::collections::HashMap::new();
        let mut total_score: u128 = 0;
        for id in counted {
            let post = self.posts.get(&id).cloned().expect("counted post exists");
            let mult_pct = if post.rating_count == 0 {
                100
            } else {
                let avg100 = post.rating_sum as u128 * 100 / post.rating_count as u128;
                RATING_MULT_BASE_PCT + avg100.saturating_sub(100) / 4
            };
            let score = post.verifier_score as u128 * mult_pct / 100;
            *scores.entry(post.creator).or_insert(0) += score;
            total_score += score;
        }
        pool.finalized = true;
        pool.total_score = total_score;
        pool.payout_available_ns = now + p.dispute_duration_ns;
        let mut paid_out: u128 = 0;
        if total_score > 0 {
            for (creator, score) in scores.iter() {
                let share = pool.balance * score / total_score;
                if share > 0 {
                    self.payouts
                        .insert((product_id, cycle_id, creator.clone()), share);
                    paid_out += share;
                }
            }
        }
        self.pools.insert((product_id, cycle_id), pool.clone());
        self.cycle_owed.insert((product_id, cycle_id), paid_out);
        // Open the next cycle; unassigned dust rolls forward.
        p.cycle_id += 1;
        p.cycle_end_ns = now + p.cycle_duration_ns;
        self.products.insert(product_id, p.clone());
        let mut next = self.pool(product_id, p.cycle_id);
        next.balance += pool.balance - paid_out;
        self.pools.insert((product_id, p.cycle_id), next);
        Self::emit_event(
            "cycle_finalized",
            near_sdk::serde_json::json!({
                "product_id": product_id,
                "cycle_id": cycle_id,
                "total_score": total_score.to_string(),
                "pool_balance": pool.balance.to_string(),
            }),
        );
        // Pre-unwind for the newly owed payouts: recall whatever the
        // estimated liquid cannot cover, so claims after the dispute window
        // find funds. Never blocks finalization: when a vault op is already
        // in flight, the recall is recorded and its settle chains onward.
        let principal = self
            .vault_principal
            .get(&product_id)
            .copied()
            .unwrap_or(0);
        if self.vault_enabled && principal > 0 && paid_out > 0 {
            let eligible = p.curve_reserve.saturating_add(pool.balance);
            let liquid_est = eligible.saturating_sub(principal);
            let need = paid_out.saturating_sub(liquid_est);
            if need > 0 {
                let recall = self.vault_recall.get(&product_id).copied().unwrap_or(0);
                self.vault_recall.insert(product_id, recall + need);
                Self::emit_event(
                    "vault_recall",
                    near_sdk::serde_json::json!({
                        "product_id": product_id,
                        "cycle_id": cycle_id,
                        "need": need.to_string(),
                    }),
                );
                if !self.vault_busy.contains(&product_id) {
                    if let Some(burrow) = self.vault_burrow.clone() {
                        let amount = need.min(principal);
                        return PromiseOrValue::Promise(self.start_vault_withdraw(
                            product_id,
                            &p,
                            &burrow,
                            Self::vault_want(principal, amount),
                        ));
                    }
                }
            }
        }
        PromiseOrValue::Value(())
    }

    /// Claim a finalized cycle payout after the dispute window. The claim is
    /// marked before the transfer and unmarked if it fails.
    pub fn claim_payout(&mut self, product_id: u64, cycle_id: u64) -> Promise {
        let creator = env::predecessor_account_id();
        let pool = self.pool(product_id, cycle_id);
        require!(pool.finalized, "Cycle is not finalized");
        require!(
            env::block_timestamp() >= pool.payout_available_ns,
            "Dispute window has not passed"
        );
        let key = (product_id, cycle_id, creator.clone());
        require!(!self.held.contains(&key), "Payout is held for review");
        require!(!self.claimed.contains(&key), "Already claimed");
        let amount = self.payouts.get(&key).copied().unwrap_or(0);
        require!(amount > 0, "No payout for this account");
        self.claimed.insert(key);
        // Track owed so views stay honest; restored if the transfer fails.
        let owed_key = (product_id, cycle_id);
        let owed = self.cycle_owed.get(&owed_key).copied().unwrap_or(0);
        self.cycle_owed.insert(owed_key, owed.saturating_sub(amount));
        let p = self.product(product_id);
        let args = near_sdk::serde_json::to_vec(&near_sdk::serde_json::json!({
            "receiver_id": creator,
            "amount": U128(amount),
        }))
        .unwrap();
        let callback_args = near_sdk::serde_json::to_vec(&near_sdk::serde_json::json!({
            "product_id": product_id,
            "cycle_id": cycle_id,
            "creator": creator,
        }))
        .unwrap();
        Promise::new(p.reserve_token)
            .function_call(
                "ft_transfer".to_string(),
                args,
                ONE_YOCTO,
                GAS_FT_TRANSFER,
            )
            .then(
                Promise::new(env::current_account_id()).function_call(
                    "on_payout_settled".to_string(),
                    callback_args,
                    NO_DEPOSIT,
                    GAS_PAYOUT_CB,
                ),
            )
    }

    #[private]
    pub fn on_payout_settled(
        &mut self,
        product_id: u64,
        cycle_id: u64,
        creator: AccountId,
        #[callback_result] result: Result<(), PromiseError>,
    ) -> PromiseOrValue<()> {
        if result.is_ok() {
            return PromiseOrValue::Value(());
        }
        // Transfer failed (creator not registered on the reserve token, or
        // the vault left too little liquid): unmark and restore owed so they
        // can retry. When the vault holds funds, also record a recall and
        // start the unwind at once when idle.
        self.claimed.remove(&(product_id, cycle_id, creator.clone()));
        let share = self
            .payouts
            .get(&(product_id, cycle_id, creator))
            .copied()
            .unwrap_or(0);
        let owed_key = (product_id, cycle_id);
        let owed = self.cycle_owed.get(&owed_key).copied().unwrap_or(0);
        self.cycle_owed.insert(owed_key, owed + share);
        log!("payout_restored_register_and_retry");
        let principal = self
            .vault_principal
            .get(&product_id)
            .copied()
            .unwrap_or(0);
        if self.vault_enabled && principal > 0 && share > 0 {
            let recall = self.vault_recall.get(&product_id).copied().unwrap_or(0);
            self.vault_recall.insert(product_id, recall + share);
            if !self.vault_busy.contains(&product_id) {
                if let Some(burrow) = self.vault_burrow.clone() {
                    let p = self.product(product_id);
                    let amount = share.min(principal);
                    return PromiseOrValue::Promise(self.start_vault_withdraw(
                        product_id,
                        &p,
                        &burrow,
                        Self::vault_want(principal, amount),
                    ));
                }
            }
        }
        PromiseOrValue::Value(())
    }

    /// Hold or release a creator payout during review. Owner only, and holds
    /// can only be placed before the payout becomes claimable.
    pub fn hold_payout(
        &mut self,
        product_id: u64,
        cycle_id: u64,
        creator: AccountId,
        hold: bool,
        reason_hash: Option<String>,
    ) {
        self.assert_owner();
        let key = (product_id, cycle_id, creator.clone());
        if hold {
            let pool = self.pool(product_id, cycle_id);
            require!(pool.finalized, "Cycle is not finalized");
            require!(
                env::block_timestamp() < pool.payout_available_ns,
                "Dispute window already passed"
            );
            self.held.insert(key);
        } else {
            self.held.remove(&key);
        }
        log!(
            "payout_hold product={product_id} cycle={cycle_id} creator={creator} hold={hold} reason={}",
            reason_hash.as_deref().unwrap_or("-")
        );
    }

    // ---------- founder vesting & milestones ----------

    /// Publish a milestone with evidence. Founder only. Each of the 4
    /// tranches (25% of the locked supply) unlocks unless holders veto it.
    /// Payable: attach NEAR for storage, excess refunded. The optional
    /// `evidence_hash` anchors the backend's canonical milestone-evidence
    /// JSON (64 lowercase hex when present).
    #[payable]
    pub fn publish_milestone(
        &mut self,
        product_id: u64,
        evidence_url: String,
        evidence_hash: Option<String>,
    ) -> u8 {
        let start_usage = env::storage_usage();
        self.assert_not_paused();
        let mut p = self.live_product(product_id);
        require!(
            env::predecessor_account_id() == p.founder,
            "Only the founder can publish milestones"
        );
        require!(p.next_milestone < 4, "All 4 tranches already have milestones");
        require!(
            evidence_url.len() >= 8 && evidence_url.len() <= MAX_URL_LEN,
            "bad evidence url"
        );
        Self::assert_hash_or_none(&evidence_hash, "evidence_hash");
        let now = env::block_timestamp();
        let index = p.next_milestone;
        p.next_milestone += 1;
        self.products.insert(product_id, p.clone());
        self.milestones.insert(
            (product_id, index),
            Milestone {
                product_id,
                index,
                evidence_url: evidence_url.clone(),
                evidence_hash: evidence_hash.clone(),
                published_at_ns: now,
                window_end_ns: now + p.milestone_window_ns,
                snapshot_circulating: p.curve_sold,
                approve_weight: 0,
                reject_weight: 0,
                finalized: false,
                released: false,
                burned: false,
            },
        );
        Self::emit_event(
            "milestone_published",
            near_sdk::serde_json::json!({
                "product_id": product_id,
                "index": index,
                "evidence_url": evidence_url,
                "evidence_hash": evidence_hash,
            }),
        );
        Self::refund_storage(start_usage);
        index
    }

    /// Lock product tokens as a milestone vote (via `ft_transfer_call` with a
    /// `Vote` message). Weight is the locked amount — linear, capped at 5% of
    /// the publish-time snapshot supply, with any excess refunded immediately
    /// through the NEP-141 resolver. Locking until the window ends stops
    /// buy-vote-sell and removes the async balance check entirely.
    ///
    /// Every invalid vote (unknown product, wrong token, founder voter, double
    /// vote, closed window, zero weight) is fully refunded, never trapped.
    fn on_vote_received(
        &mut self,
        voter: AccountId,
        amount: u128,
        product_id: u64,
        index: u8,
        approve: bool,
    ) -> PromiseOrValue<U128> {
        let full_refund = || PromiseOrValue::Value(U128(amount));
        let Some(p) = self.products.get(&product_id).cloned() else {
            return full_refund();
        };
        if p.status != ProductStatus::Live
            || Some(&env::predecessor_account_id()) != p.token_account.as_ref()
            || amount == 0
            || voter == p.founder
        {
            return full_refund();
        }
        let key = (product_id, index, voter.clone());
        if self.vote_locks.contains_key(&key) {
            return full_refund();
        }
        let Some(mut ms) = self.milestones.get(&(product_id, index)).cloned() else {
            return full_refund();
        };
        if ms.finalized || env::block_timestamp() >= ms.window_end_ns {
            return full_refund();
        }
        // 5% per-wallet cap against the publish-time snapshot; excess is
        // reported unused so the resolver refunds it at once.
        let cap = ms.snapshot_circulating * 5 / 100;
        let weight = amount.min(cap);
        if weight == 0 {
            return full_refund();
        }
        // Only the counted weight stays locked; the excess is reported
        // unused below, so the resolver refunds it immediately.
        self.vote_locks
            .insert(key, LockedVote { approve, amount: weight });
        if approve {
            ms.approve_weight += weight;
        } else {
            ms.reject_weight += weight;
        }
        self.milestones.insert((product_id, index), ms);
        log!(
            "vote_locked product={product_id} index={index} voter={voter} weight={weight}"
        );
        PromiseOrValue::Value(U128(amount - weight))
    }

    /// Return tokens locked by `unlock_vote`'s caller after the milestone is
    /// finalized (anyone can finalize once the window passes, so no lock can
    /// be held hostage). The lock is removed before the transfer and restored
    /// if the transfer fails.
    pub fn unlock_vote(&mut self, product_id: u64, index: u8) -> Promise {
        let voter = env::predecessor_account_id();
        let key = (product_id, index, voter.clone());
        let lock = self
            .vote_locks
            .get(&key)
            .cloned()
            .unwrap_or_else(|| env::panic_str("No vote lock for this account"));
        let ms = self
            .milestones
            .get(&(product_id, index))
            .cloned()
            .unwrap_or_else(|| env::panic_str("No such milestone"));
        require!(ms.finalized, "Milestone is not finalized yet");
        self.vote_locks.remove(&key);
        let p = self.product(product_id);
        let token = p.token_account.expect("voted product has token");
        let args = near_sdk::serde_json::to_vec(&near_sdk::serde_json::json!({
            "receiver_id": voter,
            "amount": U128(lock.amount),
        }))
        .unwrap();
        let callback_args = near_sdk::serde_json::to_vec(&near_sdk::serde_json::json!({
            "product_id": product_id,
            "index": index,
            "voter": voter,
            "approve": lock.approve,
            "amount": U128(lock.amount),
        }))
        .unwrap();
        Promise::new(token)
            .function_call(
                "ft_transfer".to_string(),
                args,
                ONE_YOCTO,
                GAS_FT_TRANSFER,
            )
            .then(
                Promise::new(env::current_account_id()).function_call(
                    "on_unlock_settled".to_string(),
                    callback_args,
                    NO_DEPOSIT,
                    GAS_CALLBACK,
                ),
            )
    }

    #[private]
    pub fn on_unlock_settled(
        &mut self,
        product_id: u64,
        index: u8,
        voter: AccountId,
        approve: bool,
        amount: U128,
        #[callback_result] result: Result<(), PromiseError>,
    ) {
        if result.is_err() {
            // Transfer failed (voter unregistered from the token?): restore.
            self.vote_locks.insert(
                (product_id, index, voter.clone()),
                LockedVote {
                    approve,
                    amount: amount.0,
                },
            );
            log!("vote_unlock_restored voter={voter}");
        }
    }

    /// Settle a milestone after its window. Veto-style: the tranche releases
    /// unless rejects are >50% of votes cast AND turnout is >=10% of the
    /// snapshot circulating supply. Permissionless.
    pub fn finalize_milestone(&mut self, product_id: u64, index: u8) {
        let mut p = self.live_product(product_id);
        let mut ms = self
            .milestones
            .get(&(product_id, index))
            .cloned()
            .unwrap_or_else(|| env::panic_str("No such milestone"));
        require!(!ms.finalized, "Milestone already finalized");
        require!(
            env::block_timestamp() >= ms.window_end_ns,
            "Voting window is still open"
        );
        ms.finalized = true;
        let turnout = ms.approve_weight + ms.reject_weight;
        // reject wins only with a majority of votes cast and real turnout.
        let vetoed =
            ms.reject_weight * 2 > turnout && turnout * 10 >= ms.snapshot_circulating;
        if vetoed {
            self.milestones.insert((product_id, index), ms);
            log!(
                "milestone_vetoed product={product_id} index={index}"
            );
            return;
        }
        // Release one tranche (25% of the founder allocation) to the founder,
        // who was registered on the token at launch.
        let tranche = FOUNDER_SUPPLY / 4;
        require!(p.founder_locked >= tranche, "Tranche already released");
        p.founder_locked -= tranche;
        p.tranches_released += 1;
        self.products.insert(product_id, p.clone());
        ms.released = true;
        self.milestones.insert((product_id, index), ms);
        let token = p.token_account.clone().expect("live product has token");
        let args = near_sdk::serde_json::to_vec(&near_sdk::serde_json::json!({
            "receiver_id": p.founder,
            "amount": U128(tranche),
        }))
        .unwrap();
        Promise::new(token)
            .function_call(
                "ft_transfer".to_string(),
                args,
                ONE_YOCTO,
                GAS_FT_TRANSFER,
            )
            .detach();
        log!(
            "milestone_released product={product_id} index={index} tranche={tranche}"
        );
    }

    /// Burn a vetoed tranche long after its window (deadline set at product
    /// creation). Permissionless. Unapproved supply never unlocks by time.
    pub fn burn_unclaimed_tranche(&mut self, product_id: u64, index: u8) {
        let mut p = self.live_product(product_id);
        let mut ms = self
            .milestones
            .get(&(product_id, index))
            .cloned()
            .unwrap_or_else(|| env::panic_str("No such milestone"));
        require!(ms.finalized && !ms.released && !ms.burned, "Nothing to burn");
        require!(
            env::block_timestamp() >= ms.window_end_ns + p.milestone_deadline_ns,
            "Burn deadline has not passed"
        );
        let tranche = FOUNDER_SUPPLY / 4;
        require!(p.founder_locked >= tranche, "Tranche already moved");
        p.founder_locked -= tranche;
        self.products.insert(product_id, p.clone());
        ms.burned = true;
        self.milestones.insert((product_id, index), ms);
        let token = p.token_account.clone().expect("live product has token");
        let args = near_sdk::serde_json::to_vec(&near_sdk::serde_json::json!({
            "account_id": env::current_account_id(),
            "amount": U128(tranche),
        }))
        .unwrap();
        Promise::new(token)
            .function_call("burn_from".to_string(), args, NO_DEPOSIT, GAS_MINT)
            .detach();
        log!(
            "tranche_burned product={product_id} index={index} tranche={tranche}"
        );
    }

    // ---------- simulated yield (prototype only) ----------

    /// Credit simulated vault yield to the current cycle pool: half the pool
    /// treated as deployed at a fixed 5% APR. Permissionless; capped at 30
    /// days per call. THIS IS SIMULATED — the README and UI must label it.
    ///
    /// Cutover: once real funds are deployed for a product, simulated accrual
    /// stops (the clock still advances so no phantom yield builds up).
    pub fn accrue_yield(&mut self, product_id: u64) -> U128 {
        let mut p = self.live_product(product_id);
        let now = env::block_timestamp();
        let principal = self
            .vault_principal
            .get(&product_id)
            .copied()
            .unwrap_or(0);
        if principal > 0 {
            p.last_yield_ns = now;
            self.products.insert(product_id, p);
            log!("SIMULATED yield skipped: real vault active");
            return U128(0);
        }
        let dt = now
            .saturating_sub(p.last_yield_ns)
            .min(MAX_ACCRUAL_NS) as u128;
        if dt == 0 {
            return U128(0);
        }
        p.last_yield_ns = now;
        self.products.insert(product_id, p.clone());
        let mut pool = self.pool(product_id, p.cycle_id);
        // balance * 0.5 deployed * 0.05 APR * dt / year
        let yield_amount = pool.balance * dt / (40 * YEAR_NS as u128);
        pool.balance += yield_amount;
        self.pools.insert((product_id, p.cycle_id), pool);
        log!(
            "SIMULATED yield_accrued product={product_id} amount={yield_amount}"
        );
        U128(yield_amount)
    }

    // ---------- vault (Burrow supply adapter) ----------
    //
    // Idle reserve (curve backing + promo-pool fees) is supplied to Burrow and
    // recalled on demand. Rules:
    // - Deposits start only above the per-product gate (default $1,000 of
    //   eligible liquidity = curve_reserve + current pool) and unwind fully
    //   below it. Owner can lower the gate per product for demos.
    // - At most 70% of eligible is ever deployed; deposits also respect a
    //   30% / $200 liquid buffer, so sells pay from liquid immediately.
    // - When liquid still runs short, the failure itself triggers recovery:
    //   failed sell payouts queue as PendingPayout + recall, failed creator
    //   claims record recall, and finalize_cycle pre-unwinds during the
    //   dispute window. Any `vault_rebalance` (permissionless keeper) picks
    //   recorded recall up with one withdraw per tx; the keeper repeats
    //   until recall is covered (bounded gas, no in-tx chaining).
    // - Proceeds are MEASURED (Burrow pays via plain ft_transfer with no
    //   callback), never trusted: gain credits the current cycle pool.
    // - Funds only move contract ⇄ Burrow ⇄ contract, so keeper entry points
    //   are permissionless: there is nothing to steal.

    /// USD notional to reserve base units (the reserve is a stablecoin).
    fn vault_usd_to_base(usd: u128, decimals: u8) -> u128 {
        usd.saturating_mul(10u128.pow(decimals as u32))
    }

    /// Resolved start gate for a product (override or $1,000 default).
    fn vault_min_start_for(&self, product_id: u64, decimals: u8) -> u128 {
        self.vault_min_start
            .get(&product_id)
            .copied()
            .unwrap_or_else(|| Self::vault_usd_to_base(VAULT_MIN_START_USD, decimals))
    }

    /// Eligible liquidity: curve backing + current cycle pool.
    fn vault_eligible_for(&self, product_id: u64, p: &Product) -> u128 {
        p.curve_reserve
            .saturating_add(self.pool(product_id, p.cycle_id).balance)
    }

    /// Room under the 70% deployment cap, given current principal.
    fn vault_deployable_for(eligible: u128, principal: u128) -> u128 {
        eligible
            .saturating_mul(VAULT_MAX_DEPLOY_BPS)
            .saturating_div(10_000)
            .saturating_sub(principal)
    }

    /// Pure withdraw accounting: (principal_after, gain, shortfall).
    /// `want=None` withdraws the full position. Gain is proceeds above the
    /// withdrawn principal; shortfall (should not happen on a supply-only
    /// position) is absorbed by the pool ledger, never by users.
    fn vault_settle_math(
        principal_before: u128,
        want: Option<u128>,
        proceeds: u128,
    ) -> (u128, u128, u128) {
        let withdrawn = match want {
            None => principal_before,
            Some(w) => w.min(principal_before),
        };
        (
            principal_before - withdrawn,
            proceeds.saturating_sub(withdrawn),
            withdrawn.saturating_sub(proceeds),
        )
    }

    fn vault_principal_of(&self, product_id: u64) -> u128 {
        self.vault_principal.get(&product_id).copied().unwrap_or(0)
    }

    fn vault_recall_of(&self, product_id: u64) -> u128 {
        self.vault_recall.get(&product_id).copied().unwrap_or(0)
    }

    /// Normalize a withdraw request: anything at or above principal becomes a
    /// full-position withdraw (`None`). Burrow rounds share accounting, so a
    /// partial for exactly-principal can exceed our shares by dust and get
    /// refused; `None` always withdraws whatever our shares are worth.
    fn vault_want(principal: u128, amount: u128) -> Option<u128> {
        if amount >= principal {
            None
        } else {
            Some(amount)
        }
    }

    /// Set the Burrow contract. One-way: once set it cannot change, so a
    /// live position can never be re-pointed at an attacker's contract.
    pub fn set_vault_burrow(&mut self, burrow: AccountId) {
        self.assert_owner();
        require!(self.vault_burrow.is_none(), "vault burrow already set");
        self.vault_burrow = Some(burrow.clone());
        log!("vault_burrow_set burrow={burrow}");
    }

    pub fn set_vault_enabled(&mut self, enabled: bool) {
        self.assert_owner();
        self.vault_enabled = enabled;
        log!("vault_enabled={enabled}");
    }

    /// Override the start gate for one product (reserve base units). The
    /// default is $1,000; demos set a small value. 0 disables the gate.
    pub fn set_vault_min_start(&mut self, product_id: u64, amount: U128) {
        self.assert_owner();
        let _ = self.product(product_id);
        self.vault_min_start.insert(product_id, amount.0);
        log!("vault_min_start product={product_id} amount={}", amount.0);
    }

    /// Burrow `extra_decimals` for a reserve token (verify off-chain via
    /// Burrow `get_assets`). Defaults to 12 (fakes USDT). Partial-withdraw
    /// amounts scale by this; a wrong value only mis-sizes partials, full
    /// withdraws (`amount: null`) are unaffected.
    pub fn set_vault_asset_scale(&mut self, token: AccountId, extra_decimals: u8) {
        self.assert_owner();
        require!(extra_decimals <= 24, "scale out of bounds");
        self.vault_scale.insert(token.clone(), extra_decimals);
        log!("vault_scale token={token} scale={extra_decimals}");
    }

    /// Owner escape hatch for a stuck busy flag (see
    /// `on_vault_withdraw_settled`). Clears the flag; follow with
    /// `vault_reconcile` to restore exact accounting from an off-chain
    /// Burrow `get_account` reading.
    pub fn vault_clear_busy(&mut self, product_id: u64) {
        self.assert_owner();
        self.vault_busy.remove(&product_id);
        log!("vault_busy_cleared product={product_id}");
    }

    /// Owner recovery: set principal from an off-chain Burrow reading.
    /// Requires the busy flag cleared first.
    pub fn vault_reconcile(&mut self, product_id: u64, principal: U128) {
        self.assert_owner();
        require!(
            !self.vault_busy.contains(&product_id),
            "clear the busy flag first"
        );
        let _ = self.product(product_id);
        self.vault_principal.insert(product_id, principal.0);
        log!(
            "vault_reconciled product={product_id} principal={}",
            principal.0
        );
    }

    /// Register this contract on Burrow. Payable: attach at least 0.1 NEAR,
    /// forwarded as the storage deposit. Permissionless; call once before
    /// the first deposit.
    #[payable]
    pub fn vault_register(&mut self) -> Promise {
        let burrow = self.vault_burrow.clone().expect("vault burrow not set");
        require!(
            env::attached_deposit() >= VAULT_REGISTER_DEPOSIT,
            format!("attach at least {VAULT_REGISTER_DEPOSIT} for Burrow storage")
        );
        let args = near_sdk::serde_json::to_vec(&near_sdk::serde_json::json!({
            "account_id": env::current_account_id(),
        }))
        .unwrap();
        Promise::new(burrow).function_call(
            "storage_deposit".to_string(),
            args,
            env::attached_deposit(),
            GAS_VAULT_FT_CALL,
        )
    }

    /// Keeper entry point (permissionless): push one product toward its
    /// target allocation. Priority: recorded recall first (withdraw),
    /// then full unwind below the gate, then deposit up to the cap, then
    /// pull back over-deployed excess. No-op with a log when balanced.
    /// Safe to call after every sell/claim/finalize; UI and keeper bots do.
    pub fn vault_rebalance(&mut self, product_id: u64) -> PromiseOrValue<()> {
        self.assert_not_paused();
        let p = self.live_product(product_id);
        let Some(burrow) = self.vault_burrow.clone() else {
            log!("vault_rebalance noop: burrow not set");
            return PromiseOrValue::Value(());
        };
        if !self.vault_enabled {
            log!("vault_rebalance noop: vault disabled");
            return PromiseOrValue::Value(());
        }
        if self.vault_busy.contains(&product_id) {
            log!("vault_rebalance noop: op in flight");
            return PromiseOrValue::Value(());
        }
        let principal = self.vault_principal_of(product_id);
        let eligible = self.vault_eligible_for(product_id, &p);
        let min_op = Self::vault_usd_to_base(VAULT_MIN_OP_USD, p.reserve_decimals);
        // 1. Recorded recall (failed payouts, finalize pre-unwind) wins.
        // Dust recall with an empty queue is noise: clear it and continue.
        // Dust recall WITH queued payouts still withdraws the exact amount.
        let recall = self.vault_recall_of(product_id);
        if recall > 0 && principal > 0 {
            let queued = !self
                .vault_pending
                .get(&product_id)
                .cloned()
                .unwrap_or_default()
                .is_empty();
            if recall >= min_op || queued {
                let amount = recall.min(principal);
                log!("vault_rebalance recall product={product_id} amount={amount}");
                return PromiseOrValue::Promise(self.start_vault_withdraw(
                    product_id,
                    &p,
                    &burrow,
                    Self::vault_want(principal, amount),
                ));
            }
            self.vault_recall.insert(product_id, 0);
            log!("vault_rebalance dust-recall cleared product={product_id}");
        }
        // 2. Below the gate with funds out: unwind fully.
        let min_start = self.vault_min_start_for(product_id, p.reserve_decimals);
        if eligible < min_start {
            if principal > 0 {
                log!("vault_rebalance unwind-below-gate product={product_id}");
                return PromiseOrValue::Promise(self.start_vault_withdraw(
                    product_id, &p, &burrow, None,
                ));
            }
            log!("vault_rebalance noop: below gate, nothing deployed");
            return PromiseOrValue::Value(());
        }
        // 3. Deposit up to the cap while respecting the liquid buffer.
        let deployable = Self::vault_deployable_for(eligible, principal);
        let floor_pct = eligible
            .saturating_mul(VAULT_BUFFER_BPS)
            .saturating_div(10_000);
        let floor_abs = Self::vault_usd_to_base(VAULT_BUFFER_FLOOR_USD, p.reserve_decimals);
        let floor = floor_pct.max(floor_abs);
        let max_deposit = eligible.saturating_sub(principal).saturating_sub(floor);
        let amount = deployable.min(max_deposit);
        if amount >= min_op {
            log!("vault_rebalance deposit product={product_id} amount={amount}");
            return PromiseOrValue::Promise(self.start_vault_deposit(
                product_id,
                &p,
                &burrow,
                amount,
            ));
        }
        // 4. Over-deployed (sells shrank eligible): pull back the excess.
        let target = eligible
            .saturating_mul(VAULT_MAX_DEPLOY_BPS)
            .saturating_div(10_000);
        if principal > target {
            let excess = principal - target;
            if excess >= min_op {
                log!("vault_rebalance trim product={product_id} excess={excess}");
                return PromiseOrValue::Promise(self.start_vault_withdraw(
                    product_id,
                    &p,
                    &burrow,
                    Self::vault_want(principal, excess),
                ));
            }
        }
        log!("vault_rebalance noop: balanced");
        PromiseOrValue::Value(())
    }

    /// Manual withdraw (permissionless keeper backstop). `amount=None`
    /// withdraws the full position; partials must clear the $10 dust guard
    /// unless they take the whole principal.
    pub fn vault_withdraw(
        &mut self,
        product_id: u64,
        amount: Option<U128>,
    ) -> PromiseOrValue<()> {
        self.assert_not_paused();
        let p = self.live_product(product_id);
        let burrow = self.vault_burrow.clone().expect("vault burrow not set");
        require!(self.vault_enabled, "vault disabled");
        require!(
            !self.vault_busy.contains(&product_id),
            "vault op already in flight"
        );
        let principal = self.vault_principal_of(product_id);
        require!(principal > 0, "nothing deployed");
        let want = match amount {
            None => None,
            Some(a) => Self::vault_want(principal, a.0.min(principal)),
        };
        if let Some(w) = want {
            let min_op = Self::vault_usd_to_base(VAULT_MIN_OP_USD, p.reserve_decimals);
            require!(w >= min_op, "withdraw below the dust guard");
        }
        log!("vault_withdraw product={product_id} want={want:?}");
        PromiseOrValue::Promise(self.start_vault_withdraw(product_id, &p, &burrow, want))
    }

    /// Owner shutdown path: full withdraw ignoring the enabled flag and
    /// recall state. Disable first, then call per product with funds out.
    pub fn vault_emergency_withdraw(&mut self, product_id: u64) -> Promise {
        self.assert_owner();
        let p = self.product(product_id);
        let burrow = self.vault_burrow.clone().expect("vault burrow not set");
        require!(
            !self.vault_busy.contains(&product_id),
            "op in flight: wait or clear busy first"
        );
        require!(self.vault_principal_of(product_id) > 0, "nothing deployed");
        log!("vault_emergency_withdraw product={product_id}");
        self.start_vault_withdraw(product_id, &p, &burrow, None)
    }

    /// Pay the head of the queued sell-payout queue (permissionless; works
    /// while paused — these sellers already had tokens burned). One payout
    /// per call keeps gas flat; repeat until the queue drains.
    pub fn drain_pending(&mut self, product_id: u64) -> PromiseOrValue<()> {
        let p = self.product(product_id);
        match self.pay_first_pending(product_id, &p) {
            Some(promise) => PromiseOrValue::Promise(promise),
            None => {
                log!("drain_pending noop: queue empty");
                PromiseOrValue::Value(())
            }
        }
    }

    /// Pop the head of the pending queue and pay it. The entry is removed
    /// before the transfer; failures convert to claimable, never vanish.
    fn pay_first_pending(&mut self, product_id: u64, p: &Product) -> Option<Promise> {
        let mut queue = self.vault_pending.get(&product_id).cloned().unwrap_or_default();
        if queue.is_empty() {
            return None;
        }
        let head = queue.remove(0);
        self.vault_pending.insert(product_id, queue);
        let args = near_sdk::serde_json::to_vec(&near_sdk::serde_json::json!({
            "receiver_id": head.seller,
            "amount": U128(head.amount),
        }))
        .unwrap();
        let callback_args = near_sdk::serde_json::to_vec(&near_sdk::serde_json::json!({
            "product_id": product_id,
            "seller": head.seller,
            "amount": U128(head.amount),
        }))
        .unwrap();
        Some(
            Promise::new(p.reserve_token.clone())
                .function_call(
                    "ft_transfer".to_string(),
                    args,
                    ONE_YOCTO,
                    GAS_FT_TRANSFER,
                )
                .then(
                    Promise::new(env::current_account_id()).function_call(
                        "on_pending_paid".to_string(),
                        callback_args,
                        NO_DEPOSIT,
                        GAS_VAULT_CB,
                    ),
                ),
        )
    }

    /// Start a supply: `ft_transfer_call` to Burrow with an empty message
    /// (plain deposit, no actions). Marks the product busy first.
    fn start_vault_deposit(
        &mut self,
        product_id: u64,
        p: &Product,
        burrow: &AccountId,
        amount: u128,
    ) -> Promise {
        self.vault_busy.insert(product_id);
        Self::emit_event(
            "vault_deposit_started",
            near_sdk::serde_json::json!({
                "product_id": product_id,
                "amount": amount.to_string(),
            }),
        );
        let args = near_sdk::serde_json::to_vec(&near_sdk::serde_json::json!({
            "receiver_id": burrow,
            "amount": U128(amount),
            "msg": "",
        }))
        .unwrap();
        let callback_args = near_sdk::serde_json::to_vec(&near_sdk::serde_json::json!({
            "product_id": product_id,
            "amount": U128(amount),
        }))
        .unwrap();
        Promise::new(p.reserve_token.clone())
            .function_call(
                "ft_transfer_call".to_string(),
                args,
                ONE_YOCTO,
                GAS_VAULT_FT_CALL,
            )
            .then(
                Promise::new(env::current_account_id()).function_call(
                    "on_vault_deposited".to_string(),
                    callback_args,
                    NO_DEPOSIT,
                    GAS_VAULT_CB,
                ),
            )
    }

    /// Start a withdraw. Burrow pays proceeds via plain `ft_transfer` (no
    /// receiver callback), so the flow measures balances around the call:
    /// read balance → Burrow `execute{Withdraw}` → read balance → settle.
    /// Marks the product busy first. `want=None` takes the full position.
    fn start_vault_withdraw(
        &mut self,
        product_id: u64,
        p: &Product,
        _burrow: &AccountId,
        want: Option<u128>,
    ) -> Promise {
        self.vault_busy.insert(product_id);
        let args = near_sdk::serde_json::to_vec(&near_sdk::serde_json::json!({
            "account_id": env::current_account_id(),
        }))
        .unwrap();
        let callback_args = near_sdk::serde_json::to_vec(&near_sdk::serde_json::json!({
            "product_id": product_id,
            "want": want.map(U128),
        }))
        .unwrap();
        Promise::new(p.reserve_token.clone())
            .function_call(
                "ft_balance_of".to_string(),
                args,
                NO_DEPOSIT,
                GAS_FT_TRANSFER,
            )
            .then(
                Promise::new(env::current_account_id()).function_call(
                    "on_vault_balance_before".to_string(),
                    callback_args,
                    NO_DEPOSIT,
                    GAS_VAULT_BEFORE_CB,
                ),
            )
    }

    #[private]
    pub fn on_vault_deposited(
        &mut self,
        product_id: u64,
        amount: U128,
        #[callback_result] result: Result<U128, PromiseError>,
    ) {
        // The callback value is `ft_resolve_transfer`'s return: the USED
        // amount (NEP-141 convention), i.e. what Burrow kept.
        self.vault_busy.remove(&product_id);
        match result {
            Ok(used) => {
                let deposited = used.0.min(amount.0);
                let principal = self.vault_principal_of(product_id);
                self.vault_principal.insert(product_id, principal + deposited);
                Self::emit_event(
                    "vault_deposited",
                    near_sdk::serde_json::json!({
                        "product_id": product_id,
                        "deposited": deposited.to_string(),
                    }),
                );
                log!("vault_deposited product={product_id} amount={deposited}");
            }
            Err(_) => {
                // The token contract refunded us; nothing moved. Usual cause:
                // this contract is not registered on Burrow yet.
                log!("vault_deposit_failed product={product_id}: call vault_register first?");
            }
        }
    }

    #[private]
    pub fn on_vault_balance_before(
        &mut self,
        product_id: u64,
        want: Option<U128>,
        #[callback_result] result: Result<U128, PromiseError>,
    ) -> PromiseOrValue<()> {
        let Ok(before) = result else {
            self.vault_busy.remove(&product_id);
            log!("vault_withdraw_aborted product={product_id}: balance read failed");
            return PromiseOrValue::Value(());
        };
        let p = self.product(product_id);
        let burrow = self
            .vault_burrow
            .clone()
            .expect("vault burrow unset mid-withdraw");
        // Burrow amounts are in internal units (ft * 10^extra_decimals);
        // `null` withdraws the whole position.
        let scale = self
            .vault_scale
            .get(&p.reserve_token)
            .copied()
            .unwrap_or(VAULT_DEFAULT_SCALE);
        let internal = want.map(|w| U128(w.0.saturating_mul(10u128.pow(scale as u32))));
        let args = near_sdk::serde_json::to_vec(&near_sdk::serde_json::json!({
            "actions": [{"Withdraw": {
                "token_id": p.reserve_token,
                "amount": internal,
                "max_amount": None::<U128>,
            }}],
        }))
        .unwrap();
        let callback_args = near_sdk::serde_json::to_vec(&near_sdk::serde_json::json!({
            "product_id": product_id,
            "want": want,
            "before": before,
        }))
        .unwrap();
        PromiseOrValue::Promise(
            Promise::new(burrow)
                .function_call(
                    "execute".to_string(),
                    args,
                    ONE_YOCTO,
                    GAS_BURROW_EXECUTE,
                )
                .then(
                    Promise::new(env::current_account_id()).function_call(
                        "on_vault_withdraw_executed".to_string(),
                        callback_args,
                        NO_DEPOSIT,
                        GAS_VAULT_EXECUTED_CB,
                    ),
                ),
        )
    }

    #[private]
    pub fn on_vault_withdraw_executed(
        &mut self,
        product_id: u64,
        want: Option<U128>,
        before: U128,
        #[callback_result] result: Result<(), PromiseError>,
    ) -> PromiseOrValue<()> {
        if result.is_err() {
            // Burrow refused (paused, utilization, caps, or this contract not
            // registered). Nothing moved: keep recall + pendings for a retry.
            self.vault_busy.remove(&product_id);
            log!("vault_withdraw_refused product={product_id}: burrow execute failed");
            return PromiseOrValue::Value(());
        }
        let p = self.product(product_id);
        let args = near_sdk::serde_json::to_vec(&near_sdk::serde_json::json!({
            "account_id": env::current_account_id(),
        }))
        .unwrap();
        let callback_args = near_sdk::serde_json::to_vec(&near_sdk::serde_json::json!({
            "product_id": product_id,
            "want": want,
            "before": before,
        }))
        .unwrap();
        PromiseOrValue::Promise(
            Promise::new(p.reserve_token.clone())
                .function_call(
                    "ft_balance_of".to_string(),
                    args,
                    NO_DEPOSIT,
                    GAS_FT_TRANSFER,
                )
                .then(
                    Promise::new(env::current_account_id()).function_call(
                        "on_vault_withdraw_settled".to_string(),
                        callback_args,
                        NO_DEPOSIT,
                        GAS_VAULT_SETTLE_CB,
                    ),
                ),
        )
    }

    #[private]
    pub fn on_vault_withdraw_settled(
        &mut self,
        product_id: u64,
        want: Option<U128>,
        before: U128,
        #[callback_result] result: Result<U128, PromiseError>,
    ) -> PromiseOrValue<()> {
        let Ok(after) = result else {
            // Burrow may have paid while the balance read failed: principal
            // is now uncertain. Keep the busy flag so no further vault op
            // can compound the error; the owner recovers with
            // vault_clear_busy + vault_reconcile from an off-chain reading.
            Self::emit_event(
                "vault_reconcile_needed",
                near_sdk::serde_json::json!({ "product_id": product_id }),
            );
            log!("VAULT_RECONCILE_NEEDED product={product_id}: balance read failed");
            return PromiseOrValue::Value(());
        };
        let proceeds = after.0.saturating_sub(before.0);
        let principal_before = self.vault_principal_of(product_id);
        let (principal_after, gain, shortfall) =
            Self::vault_settle_math(principal_before, want.map(|w| w.0), proceeds);
        self.vault_principal.insert(product_id, principal_after);
        let p = self.product(product_id);
        let mut pool = self.pool(product_id, p.cycle_id);
        pool.balance += gain;
        if shortfall > 0 {
            pool.balance = pool.balance.saturating_sub(shortfall);
            log!("vault_shortfall_absorbed product={product_id} amount={shortfall}");
        }
        self.pools.insert((product_id, p.cycle_id), pool);
        // Fully liquid means nothing left to recall: with principal at zero
        // the vault cannot cover any remainder, and a stale recall would
        // make the keeper withdraw right after every future deposit.
        let recall = if principal_after == 0 {
            0
        } else {
            self.vault_recall_of(product_id).saturating_sub(proceeds)
        };
        self.vault_recall.insert(product_id, recall);
        Self::emit_event(
            "vault_withdrawn",
            near_sdk::serde_json::json!({
                "product_id": product_id,
                "proceeds": proceeds.to_string(),
                "gain": gain.to_string(),
                "principal": principal_after.to_string(),
            }),
        );
        log!("vault_withdrawn product={product_id} proceeds={proceeds} gain={gain}");
        // Never chain a second withdraw here: one withdraw per tx keeps gas
        // bounded. Leftover recall is picked up by the next keeper
        // `vault_rebalance` (recall branch), which the UI fires after sells.
        self.vault_busy.remove(&product_id);
        // Pay the head of the pending queue; the keeper drains the rest.
        match self.pay_first_pending(product_id, &p) {
            Some(promise) => PromiseOrValue::Promise(promise),
            None => PromiseOrValue::Value(()),
        }
    }

    /// Second half of the sell-shortfall check: a failed sell payout while
    /// the vault holds funds. Registered sellers queue for automatic payment
    /// once `vault_rebalance` recalls liquid; unregistered sellers get the
    /// classic claimable hold. Returns 0 either way: the burn consumed the
    /// tokens, so the NEP-141 resolver must see nothing unused.
    #[private]
    pub fn on_sell_shortfall_check(
        &mut self,
        seller: AccountId,
        product_id: u64,
        amount: U128,
        #[callback_result] result: Result<Option<near_sdk::serde_json::Value>, PromiseError>,
    ) -> U128 {
        if matches!(result, Ok(Some(_))) {
            let mut queue = self
                .vault_pending
                .get(&product_id)
                .cloned()
                .unwrap_or_default();
            queue.push(PendingPayout {
                seller: seller.clone(),
                amount: amount.0,
            });
            self.vault_pending.insert(product_id, queue);
            let recall = self.vault_recall_of(product_id);
            self.vault_recall.insert(product_id, recall + amount.0);
            Self::emit_event(
                "vault_shortfall",
                near_sdk::serde_json::json!({
                    "product_id": product_id,
                    "seller": seller,
                    "amount": amount.0.to_string(),
                }),
            );
            log!("vault_shortfall product={product_id} seller={seller}: queued, call vault_rebalance");
        } else {
            let p = self.product(product_id);
            self.add_claimable(&p.reserve_token, &seller, amount.0);
            log!("sell_held_as_claimable product={product_id} seller={seller}");
        }
        U128(0)
    }

    #[private]
    pub fn on_pending_paid(
        &mut self,
        product_id: u64,
        seller: AccountId,
        amount: U128,
        #[callback_result] result: Result<(), PromiseError>,
    ) {
        if result.is_err() {
            // Still illiquid (or unregistered): hold as claimable so the
            // seller can pull it once registered / liquid returns.
            let p = self.product(product_id);
            self.add_claimable(&p.reserve_token, &seller, amount.0);
            log!("pending_held_as_claimable product={product_id} seller={seller}");
        } else {
            Self::emit_event(
                "pending_paid",
                near_sdk::serde_json::json!({
                    "product_id": product_id,
                    "seller": seller,
                    "amount": amount.0.to_string(),
                }),
            );
        }
    }

    /// Vault status for one product: principal, queue, recall, gate, and how
    /// much a keeper rebalance would deploy right now.
    pub fn get_vault_position(&self, product_id: u64) -> VaultPosition {
        let p = self.product(product_id);
        let principal = self.vault_principal_of(product_id);
        let eligible = self.vault_eligible_for(product_id, &p);
        let queue = self
            .vault_pending
            .get(&product_id)
            .cloned()
            .unwrap_or_default();
        VaultPosition {
            burrow: self.vault_burrow.clone(),
            enabled: self.vault_enabled,
            principal: U128(principal),
            busy: self.vault_busy.contains(&product_id),
            pending_count: queue.len() as u32,
            pending_total: U128(queue.iter().map(|q| q.amount).sum()),
            recall: U128(self.vault_recall_of(product_id)),
            min_start: U128(self.vault_min_start_for(product_id, p.reserve_decimals)),
            eligible: U128(eligible),
            deployable: U128(Self::vault_deployable_for(eligible, principal)),
            asset_scale: self
                .vault_scale
                .get(&p.reserve_token)
                .copied()
                .unwrap_or(VAULT_DEFAULT_SCALE),
        }
    }

    // ---------- admin ----------

    pub fn set_verifier(&mut self, verifier: AccountId) {
        self.assert_owner();
        self.verifier = verifier;
    }

    pub fn set_ops_account(&mut self, ops_account: AccountId) {
        self.assert_owner();
        self.ops_account = ops_account;
    }

    pub fn set_owner(&mut self, owner: AccountId) {
        self.assert_owner();
        self.owner = owner;
    }

    pub fn pause(&mut self, paused: bool) {
        self.assert_owner();
        self.paused = paused;
        log!("paused={paused}");
    }

    // ---------- views ----------

    pub fn get_config(&self) -> ContractConfig {
        ContractConfig {
            owner: self.owner.clone(),
            ops_account: self.ops_account.clone(),
            verifier: self.verifier.clone(),
            paused: self.paused,
            token_wasm_bytes: self.token_wasm.len() as u64,
            product_count: self.next_product_id - 1,
        }
    }

    pub fn get_product(&self, product_id: u64) -> Option<Product> {
        self.products.get(&product_id).cloned()
    }

    pub fn list_products(&self, from_index: u64, limit: u64) -> Vec<Product> {
        let limit = limit.min(100) as usize;
        self.products
            .iter()
            .skip(from_index as usize)
            .take(limit)
            .map(|(_, p)| p.clone())
            .collect()
    }

    pub fn get_pool(&self, product_id: u64, cycle_id: u64) -> CyclePool {
        self.pool(product_id, cycle_id)
    }

    pub fn get_post(&self, post_id: u64) -> Option<Post> {
        self.posts.get(&post_id).cloned()
    }

    pub fn list_cycle_posts(&self, product_id: u64, cycle_id: u64) -> Vec<Post> {
        self.cycle_posts
            .get(&(product_id, cycle_id))
            .cloned()
            .unwrap_or_default()
            .iter()
            .filter_map(|id| self.posts.get(id).cloned())
            .collect()
    }

    pub fn get_payout(&self, product_id: u64, cycle_id: u64, creator: AccountId) -> U128 {
        U128(
            self.payouts
                .get(&(product_id, cycle_id, creator))
                .copied()
                .unwrap_or(0),
        )
    }

    pub fn get_claimable(&self, token_id: AccountId, account: AccountId) -> U128 {
        U128(self.claimables.get(&(token_id, account)).copied().unwrap_or(0))
    }

    pub fn get_vote_lock(
        &self,
        product_id: u64,
        index: u8,
        voter: AccountId,
    ) -> Option<LockedVote> {
        self.vote_locks.get(&(product_id, index, voter)).cloned()
    }

    pub fn get_milestone(&self, product_id: u64, index: u8) -> Option<Milestone> {
        self.milestones.get(&(product_id, index)).cloned()
    }

    /// Quote a buy: (tokens_out, cost, fee) for `reserve_in` units of reserve.
    pub fn get_buy_quote(&self, product_id: u64, reserve_in: U128) -> (U128, U128, U128) {
        let p = self.product(product_id);
        let fee = fee_of(reserve_in.0, p.fee_bps);
        let (dq, cost) = buy_quote(
            reserve_in.0 - fee,
            p.curve_sold,
            p.curve_p0,
            p.curve_rise,
        );
        (U128(dq), U128(cost), U128(fee))
    }

    /// Quote a sell: (net_proceeds, fee) for `tokens_in` base units.
    pub fn get_sell_quote(&self, product_id: u64, tokens_in: U128) -> (U128, U128) {
        let p = self.product(product_id);
        if tokens_in.0 == 0 || tokens_in.0 > p.curve_sold {
            return (U128(0), U128(0));
        }
        let proceeds = sell_proceeds(p.curve_sold, tokens_in.0, p.curve_p0, p.curve_rise);
        let fee = fee_of(proceeds, p.fee_bps);
        (U128(proceeds - fee), U128(fee))
    }

}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::curve::DECIMALS_T;
    use near_sdk::test_utils::VMContextBuilder;
    use near_sdk::testing_env;

    const T0: u64 = 1_700_000_000_000_000_000; // fixed test timestamp (ns)
    const DAY: u64 = 24 * 3_600 * 1_000_000_000;

    fn owner() -> AccountId {
        "owner.testnet".parse().unwrap()
    }
    fn ops() -> AccountId {
        "ops.testnet".parse().unwrap()
    }
    fn verifier() -> AccountId {
        "verifier.testnet".parse().unwrap()
    }
    fn founder() -> AccountId {
        "founder.testnet".parse().unwrap()
    }
    fn alice() -> AccountId {
        "alice.testnet".parse().unwrap()
    }
    fn bob() -> AccountId {
        "bob.testnet".parse().unwrap()
    }
    fn this() -> AccountId {
        "launchly.testnet".parse().unwrap()
    }
    fn reserve() -> AccountId {
        "usdt.testnet".parse().unwrap()
    }
    fn token() -> AccountId {
        "p1.launchly.testnet".parse().unwrap()
    }

    fn ctx(prev: AccountId) -> VMContextBuilder {
        let mut b = VMContextBuilder::new();
        b.current_account_id(this())
            .signer_account_id(prev.clone())
            .predecessor_account_id(prev)
            .block_timestamp(T0);
        b
    }

    fn setup() -> Contract {
        testing_env!(ctx(owner()).build());
        Contract::new(owner(), ops(), verifier())
    }

    #[allow(clippy::too_many_arguments)]
    fn make_product(c: &mut Contract, caller: AccountId, deposit: NearToken) -> u64 {
        testing_env!(ctx(caller).attached_deposit(deposit).build());
        c.create_product(
            "Demo Product".to_string(),
            "DEMO".to_string(),
            "A demo product".to_string(),
            "https://demo.example".to_string(),
            None,
            None,
            reserve(),
            6,
            100,
            U128(100),
            U128(9_900),
            U128(1_000 * DECIMALS_T),
            5,
            30 * DAY,
            2 * DAY,
            3 * DAY,
            365 * DAY,
        )
    }

    /// Flip a created product to Live, as a successful launch would.
    fn go_live(c: &mut Contract, product_id: u64) {
        let mut p = c.product(product_id);
        p.status = ProductStatus::Live;
        p.token_account = Some(token());
        p.founder_locked = FOUNDER_SUPPLY;
        p.cycle_id = 1;
        p.cycle_end_ns = T0 + p.cycle_duration_ns;
        p.last_yield_ns = T0;
        p.launched_at_ns = T0;
        c.products.insert(product_id, p);
        c.pools.insert((product_id, 1), CyclePool::default());
    }

    #[test]
    fn init_sets_config() {
        let c = setup();
        let cfg = c.get_config();
        assert_eq!(cfg.owner, owner());
        assert_eq!(cfg.ops_account, ops());
        assert_eq!(cfg.verifier, verifier());
        assert!(!cfg.paused);
        assert_eq!(cfg.product_count, 0);
    }

    #[test]
    fn owner_can_set_wasm_and_other_cannot() {
        let mut c = setup();
        testing_env!(ctx(owner())
            .attached_deposit(NearToken::from_near(1))
            .build());
        c.set_token_wasm(vec![0, 1, 2, 3]);
        assert_eq!(c.get_config().token_wasm_bytes, 4);
    }

    #[test]
    #[should_panic(expected = "Only the owner")]
    fn non_owner_cannot_set_wasm() {
        let mut c = setup();
        testing_env!(ctx(alice())
            .attached_deposit(NearToken::from_near(1))
            .build());
        c.set_token_wasm(vec![0, 1, 2, 3]);
    }

    #[test]
    fn create_product_ok() {
        let mut c = setup();
        let id = make_product(&mut c, founder(), NearToken::from_near(1));
        assert_eq!(id, 1);
        let p = c.get_product(1).unwrap();
        assert_eq!(p.founder, founder());
        assert_eq!(p.status, ProductStatus::Created);
        assert_eq!(p.fee_bps, 100);
        assert_eq!(c.get_config().product_count, 1);
        assert_eq!(c.list_products(0, 10).len(), 1);
    }

    #[test]
    #[should_panic(expected = "fee_bps must be 50-200")]
    fn create_product_rejects_low_fee() {
        let mut c = setup();
        testing_env!(ctx(founder())
            .attached_deposit(NearToken::from_near(1))
            .build());
        c.create_product(
            "x".to_string(),
            "X".to_string(),
            String::new(),
            String::new(),
            None,
            None,
            reserve(),
            6,
            49,
            U128(100),
            U128(9_900),
            U128(0),
            5,
            30 * DAY,
            DAY,
            3 * DAY,
            365 * DAY,
        );
    }

    #[test]
    #[should_panic(expected = "curve_p0 out of bounds")]
    fn create_product_rejects_zero_p0() {
        let mut c = setup();
        testing_env!(ctx(founder())
            .attached_deposit(NearToken::from_near(1))
            .build());
        c.create_product(
            "x".to_string(),
            "X".to_string(),
            String::new(),
            String::new(),
            None,
            None,
            reserve(),
            6,
            100,
            U128(0),
            U128(9_900),
            U128(0),
            5,
            30 * DAY,
            DAY,
            3 * DAY,
            365 * DAY,
        );
    }

    #[test]
    fn pause_blocks_trading_and_posts() {
        let mut c = setup();
        let id = make_product(&mut c, founder(), NearToken::from_near(1));
        go_live(&mut c, id);
        testing_env!(ctx(owner()).build());
        c.pause(true);
        assert!(c.get_config().paused);
        // ft_on_transfer must panic while paused.
        testing_env!(ctx(reserve()).attached_deposit(ONE_YOCTO).build());
        let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            c.ft_on_transfer(alice(), U128(100), "{\"Buy\":{\"product_id\":1,\"min_tokens_out\":\"1\"}}".to_string())
        }));
        assert!(r.is_err());
        testing_env!(ctx(owner()).build());
        c.pause(false);
        assert!(!c.get_config().paused);
    }

    #[test]
    fn ft_on_transfer_from_user_account_refunds_without_panic() {
        // Direct call (not via a token contract): no deposit attached, the
        // predecessor is not a known token, so the full amount is returned
        // as unused and no state changes.
        let mut c = setup();
        let _ = make_product(&mut c, founder(), NearToken::from_near(1));
        testing_env!(ctx(alice()).build());
        let out = c.ft_on_transfer(
            alice(),
            U128(100),
            "{\"Buy\":{\"product_id\":1,\"min_tokens_out\":\"1\"}}".to_string(),
        );
        match out {
            PromiseOrValue::Value(U128(v)) => assert_eq!(v, 100),
            _ => panic!("expected full refund value"),
        }
    }

    #[test]
    #[should_panic(expected = "Bad msg")]
    fn ft_on_transfer_rejects_bad_msg() {
        let mut c = setup();
        testing_env!(ctx(reserve()).attached_deposit(ONE_YOCTO).build());
        let _ = c.ft_on_transfer(alice(), U128(100), "{\"Nope\":{}}".to_string());
    }

    #[test]
    fn buy_refunds_fully_when_not_live() {
        let mut c = setup();
        let _ = make_product(&mut c, founder(), NearToken::from_near(1));
        testing_env!(ctx(reserve()).attached_deposit(ONE_YOCTO).build());
        let out = c.ft_on_transfer(
            alice(),
            U128(5_000),
            "{\"Buy\":{\"product_id\":1,\"min_tokens_out\":\"1\"}}".to_string(),
        );
        match out {
            PromiseOrValue::Value(U128(v)) => assert_eq!(v, 5_000),
            _ => panic!("expected full refund"),
        }
    }

    #[test]
    fn buy_refunds_on_slippage_and_wrong_token() {
        let mut c = setup();
        let id = make_product(&mut c, founder(), NearToken::from_near(1));
        go_live(&mut c, id);
        // Impossible slippage -> full refund.
        testing_env!(ctx(reserve()).attached_deposit(ONE_YOCTO).build());
        let out = c.ft_on_transfer(
            alice(),
            U128(5_000),
            "{\"Buy\":{\"product_id\":1,\"min_tokens_out\":\"999999999999999999999999999\"}}"
                .to_string(),
        );
        match out {
            PromiseOrValue::Value(U128(v)) => assert_eq!(v, 5_000),
            _ => panic!("expected slippage refund"),
        }
        // Wrong token (not the reserve) -> full refund.
        testing_env!(ctx(token()).attached_deposit(ONE_YOCTO).build());
        let out = c.ft_on_transfer(
            alice(),
            U128(5_000),
            "{\"Buy\":{\"product_id\":1,\"min_tokens_out\":\"1\"}}".to_string(),
        );
        match out {
            PromiseOrValue::Value(U128(v)) => assert_eq!(v, 5_000),
            _ => panic!("expected wrong-token refund"),
        }
    }

    #[test]
    fn buy_live_creates_pending_and_callback_applies() {
        let mut c = setup();
        let id = make_product(&mut c, founder(), NearToken::from_near(1));
        go_live(&mut c, id);
        testing_env!(ctx(reserve()).attached_deposit(ONE_YOCTO).build());
        let out = c.ft_on_transfer(
            alice(),
            U128(10_000),
            "{\"Buy\":{\"product_id\":1,\"min_tokens_out\":\"1\"}}".to_string(),
        );
        assert!(matches!(out, PromiseOrValue::Promise(_)));
        assert!(c.pend_buys.get(&1).is_some());
        // Simulate successful mint callback (predecessor must be self).
        testing_env!(ctx(this()).build());
        assert_eq!(c.on_buy_minted(1, Ok(())), U128(0));
        let p = c.product(id);
        assert!(p.curve_sold > 0);
        assert!(p.curve_reserve > 0);
        let pool = c.pool(id, 1);
        // 1% fee of 10000 = 100; pool gets 70 + dust.
        assert!(pool.balance >= 70);
        assert!(c.claimables.get(&(reserve(), ops())).copied().unwrap_or(0) >= 20);
        assert!(c.pend_buys.get(&1).is_none());
    }

    #[test]
    fn buy_callback_failure_clears_pending() {
        let mut c = setup();
        let id = make_product(&mut c, founder(), NearToken::from_near(1));
        go_live(&mut c, id);
        testing_env!(ctx(reserve()).attached_deposit(ONE_YOCTO).build());
        let _ = c.ft_on_transfer(
            alice(),
            U128(10_000),
            "{\"Buy\":{\"product_id\":1,\"min_tokens_out\":\"1\"}}".to_string(),
        );
        testing_env!(ctx(this()).build());
        let unused = c.on_buy_minted(1, Err(PromiseError::Failed));
        assert_eq!(unused, U128(10_000));
        assert!(c.pend_buys.get(&1).is_none());
        assert_eq!(c.product(id).curve_sold, 0);
    }

    #[test]
    fn sell_refunds_when_too_much_or_wrong_token() {
        let mut c = setup();
        let id = make_product(&mut c, founder(), NearToken::from_near(1));
        go_live(&mut c, id);
        // Nothing sold yet: any sell refunds.
        testing_env!(ctx(token()).attached_deposit(ONE_YOCTO).build());
        let out = c.ft_on_transfer(
            alice(),
            U128(100),
            "{\"Sell\":{\"product_id\":1,\"min_reserve_out\":\"0\"}}".to_string(),
        );
        match out {
            PromiseOrValue::Value(U128(v)) => assert_eq!(v, 100),
            _ => panic!("expected refund"),
        }
        // Sell paid in reserve token (wrong direction) refunds.
        testing_env!(ctx(reserve()).attached_deposit(ONE_YOCTO).build());
        let out = c.ft_on_transfer(
            alice(),
            U128(100),
            "{\"Sell\":{\"product_id\":1,\"min_reserve_out\":\"0\"}}".to_string(),
        );
        match out {
            PromiseOrValue::Value(U128(v)) => assert_eq!(v, 100),
            _ => panic!("expected refund"),
        }
    }

    #[test]
    fn sell_callback_applies_and_pays() {
        let mut c = setup();
        let id = make_product(&mut c, founder(), NearToken::from_near(1));
        go_live(&mut c, id);
        // Simulate a prior buy: tokens sold and reserve in the curve.
        let mut p = c.product(id);
        p.curve_sold = 1_000 * DECIMALS_T;
        p.curve_reserve = 100_000;
        c.products.insert(id, p);
        testing_env!(ctx(token()).attached_deposit(ONE_YOCTO).build());
        let out = c.ft_on_transfer(
            alice(),
            U128(100 * DECIMALS_T),
            "{\"Sell\":{\"product_id\":1,\"min_reserve_out\":\"0\"}}".to_string(),
        );
        assert!(matches!(out, PromiseOrValue::Promise(_)));
        testing_env!(ctx(this()).build());
        assert!(matches!(
            c.on_sell_burned(1, Ok(())),
            PromiseOrValue::Promise(_)
        ));
        let p = c.product(id);
        assert_eq!(p.curve_sold, 900 * DECIMALS_T);
        assert!(p.curve_reserve < 100_000);
        assert!(c.pool(id, 1).balance > 0);
    }

    #[test]
    fn launch_requires_exact_deposit_and_wasm() {
        let mut c = setup();
        let _ = make_product(&mut c, founder(), NearToken::from_near(1));
        testing_env!(ctx(founder())
            .attached_deposit(NearToken::from_near(1))
            .build());
        let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            let _ = c.launch_coin(1);
        }));
        assert!(r.is_err(), "must fail without stored wasm");
    }

    #[test]
    fn launch_sets_launching_and_failure_resets() {
        let mut c = setup();
        let _ = make_product(&mut c, founder(), NearToken::from_near(1));
        testing_env!(ctx(owner())
            .attached_deposit(NearToken::from_near(1))
            .build());
        c.set_token_wasm(vec![0, 1, 2]);
        let cost = c.get_launch_cost().0;
        testing_env!(ctx(founder())
            .attached_deposit(NearToken::from_yoctonear(cost))
            .build());
        let _ = c.launch_coin(1);
        assert_eq!(c.product(1).status, ProductStatus::Launching);
        // Failed deploy callback resets to Created.
        testing_env!(ctx(this()).build());
        let _ = c.on_token_deployed(1, Err(PromiseError::Failed));
        assert_eq!(c.product(1).status, ProductStatus::Created);
    }

    #[test]
    fn submit_attest_and_confirm_post() {
        let mut c = setup();
        let id = make_product(&mut c, founder(), NearToken::from_near(1));
        go_live(&mut c, id);
        testing_env!(ctx(alice())
            .attached_deposit(NearToken::from_near(1))
            .build());
        let post_id = c.submit_post(
            id,
            "https://x.com/alice/status/1".to_string(),
            "@alice".to_string(),
        );
        assert!(!c.get_post(post_id).unwrap().approved);
        testing_env!(ctx(verifier()).build());
        c.attest_post(post_id, true, 90, "content-hash-1".to_string());
        let post = c.get_post(post_id).unwrap();
        assert!(post.attested && post.approved);
        assert_eq!(post.verifier_score, 90);
        assert_eq!(post.post_hash, "content-hash-1");
        assert!(!post.live_confirmed);
        c.confirm_liveness(id, 1, vec![LiveConfirmation { post_id, live: true }]);
        assert!(c.get_post(post_id).unwrap().live_confirmed);
        assert_eq!(c.list_cycle_posts(id, 1).len(), 1);
    }

    #[test]
    #[should_panic(expected = "Only the verifier")]
    fn attest_post_rejects_stranger() {
        let mut c = setup();
        let id = make_product(&mut c, founder(), NearToken::from_near(1));
        go_live(&mut c, id);
        testing_env!(ctx(alice())
            .attached_deposit(NearToken::from_near(1))
            .build());
        let post_id = c.submit_post(
            id,
            "https://x.com/alice/status/1".to_string(),
            "@alice".to_string(),
        );
        testing_env!(ctx(bob()).build());
        c.attest_post(post_id, true, 100, "h".to_string());
    }

    #[test]
    #[should_panic(expected = "Post already attested")]
    fn attest_post_rejects_double_attestation() {
        let mut c = setup();
        let id = make_product(&mut c, founder(), NearToken::from_near(1));
        go_live(&mut c, id);
        testing_env!(ctx(alice())
            .attached_deposit(NearToken::from_near(1))
            .build());
        let post_id = c.submit_post(
            id,
            "https://x.com/alice/status/1".to_string(),
            "@alice".to_string(),
        );
        testing_env!(ctx(verifier()).build());
        c.attest_post(post_id, true, 80, "h".to_string());
        c.attest_post(post_id, true, 100, "h2".to_string());
    }

    #[test]
    fn attest_post_clamps_score_and_records_invalid() {
        let mut c = setup();
        let id = make_product(&mut c, founder(), NearToken::from_near(1));
        go_live(&mut c, id);
        testing_env!(ctx(alice())
            .attached_deposit(NearToken::from_near(1))
            .build());
        let pid = c.submit_post(
            id,
            "https://x.com/alice/status/1".to_string(),
            "@alice".to_string(),
        );
        testing_env!(ctx(verifier()).build());
        c.attest_post(pid, true, 200, "h".to_string()); // clamped to 100
        assert_eq!(c.get_post(pid).unwrap().verifier_score, 100);
        testing_env!(ctx(bob()).attached_deposit(NearToken::from_near(1)).build());
        let pid2 = c.submit_post(
            id,
            "https://x.com/bob/status/1".to_string(),
            "@bob".to_string(),
        );
        testing_env!(ctx(verifier()).build());
        c.attest_post(pid2, false, 100, "h2".to_string());
        let post = c.get_post(pid2).unwrap();
        assert!(post.attested && !post.approved);
        assert_eq!(post.verifier_score, 0);
        // Invalid verdicts do not consume the per-creator cap.
        assert_eq!(c.creator_post_counts.get(&(id, 1, bob())), None);
    }

    #[test]
    #[should_panic(expected = "Only the verifier")]
    fn confirm_liveness_rejects_stranger() {
        let mut c = setup();
        let id = make_product(&mut c, founder(), NearToken::from_near(1));
        go_live(&mut c, id);
        testing_env!(ctx(bob()).build());
        c.confirm_liveness(id, 1, vec![LiveConfirmation { post_id: 1, live: true }]);
    }

    #[test]
    fn finalize_cycle_fails_closed_without_liveness() {
        let mut c = setup();
        let id = make_product(&mut c, founder(), NearToken::from_near(1));
        go_live(&mut c, id);
        testing_env!(ctx(alice())
            .attached_deposit(NearToken::from_near(1))
            .build());
        let pid = c.submit_post(
            id,
            "https://x.com/alice/status/1".to_string(),
            "@alice".to_string(),
        );
        testing_env!(ctx(verifier()).build());
        c.attest_post(pid, true, 100, "h".to_string());
        // No liveness confirmation: finalize excludes the post entirely.
        let mut pool = c.pool(id, 1);
        pool.balance = 1_000;
        c.pools.insert((id, 1), pool);
        testing_env!(ctx(alice()).block_timestamp(T0 + 31 * DAY).build());
        let _ = c.finalize_cycle(id);
        assert_eq!(c.pool(id, 1).total_score, 0);
        assert_eq!(c.get_payout(id, 1, alice()), U128(0));
        // Full balance rolls to the next cycle as dust.
        assert_eq!(c.pool(id, 2).balance, 1_000);
    }

    #[test]
    fn finalize_cycle_splits_pro_rata_and_rolls_dust() {
        let mut c = setup();
        let id = make_product(&mut c, founder(), NearToken::from_near(1));
        go_live(&mut c, id);
        // Two attested posts: alice unrated (100 pts), bob rated 5,5 (150 pts).
        let mut pids = vec![];
        for (creator, handle, ratings) in
            [(alice(), "alice", vec![]), (bob(), "bob", vec![5u8, 5u8])]
        {
            testing_env!(ctx(creator.clone())
                .attached_deposit(NearToken::from_near(1))
                .build());
            let pid = c.submit_post(
                id,
                format!("https://x.com/{handle}/status/1"),
                format!("@{handle}"),
            );
            testing_env!(ctx(verifier()).build());
            c.attest_post(pid, true, 100, "h".to_string());
            let mut post = c.posts.get(&pid).cloned().unwrap();
            for r in ratings {
                post.rating_sum += r as u64;
                post.rating_count += 1;
            }
            c.posts.insert(pid, post);
            pids.push(pid);
        }
        testing_env!(ctx(verifier()).build());
        c.confirm_liveness(
            id,
            1,
            pids.iter()
                .map(|pid| LiveConfirmation { post_id: *pid, live: true })
                .collect(),
        );
        let mut pool = c.pool(id, 1);
        pool.balance = 1_000;
        c.pools.insert((id, 1), pool);
        // Fast-forward past cycle end.
        testing_env!(ctx(alice()).block_timestamp(T0 + 31 * DAY).build());
        let _ = c.finalize_cycle(id);
        // Scores: alice 100, bob 150, total 250.
        assert_eq!(c.get_payout(id, 1, alice()), U128(400));
        assert_eq!(c.get_payout(id, 1, bob()), U128(600));
        // Next cycle opened; dust (0 here) rolled.
        assert_eq!(c.product(id).cycle_id, 2);
        assert_eq!(c.pool(id, 2).balance, 0);
    }

    #[test]
    fn attest_post_enforces_creator_cap() {
        let mut c = setup();
        let id = make_product(&mut c, founder(), NearToken::from_near(1));
        go_live(&mut c, id);
        // max_posts_per_creator = 5: submit 7, attest 5, the 6th is rejected.
        let mut pids = vec![];
        for i in 0..7 {
            testing_env!(ctx(alice())
                .attached_deposit(NearToken::from_near(1))
                .build());
            pids.push(c.submit_post(
                id,
                format!("https://x.com/x/status/{i}"),
                "@x".to_string(),
            ));
        }
        testing_env!(ctx(verifier()).build());
        for pid in &pids[..5] {
            c.attest_post(*pid, true, 100, "h".to_string());
        }
        let sixth = pids[5];
        let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            c.attest_post(sixth, true, 100, "h".to_string());
        }));
        assert!(r.is_err());
        c.confirm_liveness(
            id,
            1,
            pids[..5]
                .iter()
                .map(|pid| LiveConfirmation { post_id: *pid, live: true })
                .collect(),
        );
        let mut pool = c.pool(id, 1);
        pool.balance = 500;
        c.pools.insert((id, 1), pool);
        testing_env!(ctx(alice()).block_timestamp(T0 + 31 * DAY).build());
        let _ = c.finalize_cycle(id);
        assert_eq!(c.pool(id, 1).total_score, 500); // 5 * 100, not 7 * 100
        assert_eq!(c.get_payout(id, 1, alice()), U128(500));
    }

    #[test]
    #[should_panic(expected = "Cycle is not finalized")]
    fn claim_payout_before_close_panics() {
        let mut c = setup();
        let id = make_product(&mut c, founder(), NearToken::from_near(1));
        go_live(&mut c, id);
        testing_env!(ctx(alice()).build());
        let _ = c.claim_payout(id, 1);
    }

    #[test]
    #[should_panic(expected = "Already claimed")]
    fn claim_payout_twice_panics() {
        let mut c = setup();
        let id = make_product(&mut c, founder(), NearToken::from_near(1));
        go_live(&mut c, id);
        testing_env!(ctx(alice()).block_timestamp(T0 + 31 * DAY).build());
        let _ = c.finalize_cycle(id);
        c.payouts.insert((id, 1, alice()), 250);
        testing_env!(ctx(alice()).block_timestamp(T0 + 40 * DAY).build());
        let _ = c.claim_payout(id, 1);
        let _ = c.claim_payout(id, 1);
    }

    #[test]
    fn claim_payout_marks_and_callback_restores() {
        let mut c = setup();
        let id = make_product(&mut c, founder(), NearToken::from_near(1));
        go_live(&mut c, id);
        // Finalize an empty cycle, then credit alice manually.
        testing_env!(ctx(alice()).block_timestamp(T0 + 31 * DAY).build());
        let _ = c.finalize_cycle(id);
        c.payouts.insert((id, 1, alice()), 250);
        testing_env!(ctx(alice()).block_timestamp(T0 + 40 * DAY).build());
        let _ = c.claim_payout(id, 1);
        assert!(c.claimed.contains(&(id, 1, alice())));
        // Failed transfer restores the claim.
        testing_env!(ctx(this()).build());
        let _ = c.on_payout_settled(id, 1, alice(), Err(PromiseError::Failed));
        assert!(!c.claimed.contains(&(id, 1, alice())));
    }

    #[test]
    fn hold_blocks_claim_until_released() {
        let mut c = setup();
        let id = make_product(&mut c, founder(), NearToken::from_near(1));
        go_live(&mut c, id);
        testing_env!(ctx(alice()).block_timestamp(T0 + 31 * DAY).build());
        let _ = c.finalize_cycle(id);
        c.payouts.insert((id, 1, alice()), 250);
        // Hold during the dispute window (available at +2d after finalize).
        testing_env!(ctx(owner()).block_timestamp(T0 + 32 * DAY).build());
        c.hold_payout(id, 1, alice(), true, Some("review".to_string()));
        testing_env!(ctx(alice()).block_timestamp(T0 + 40 * DAY).build());
        let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            let _ = c.claim_payout(id, 1);
        }));
        assert!(r.is_err());
        testing_env!(ctx(owner()).build());
        c.hold_payout(id, 1, alice(), false, None);
        testing_env!(ctx(alice()).block_timestamp(T0 + 40 * DAY).build());
        let _ = c.claim_payout(id, 1);
        assert!(c.claimed.contains(&(id, 1, alice())));
    }

    #[test]
    fn milestone_release_without_veto() {
        let mut c = setup();
        let id = make_product(&mut c, founder(), NearToken::from_near(1));
        go_live(&mut c, id);
        let mut p = c.product(id);
        p.curve_sold = 10_000 * DECIMALS_T;
        c.products.insert(id, p);
        testing_env!(ctx(founder())
            .attached_deposit(NearToken::from_near(1))
            .build());
        let idx = c.publish_milestone(id, "https://demo.example/v2".to_string(), None);
        assert_eq!(idx, 0);
        // No votes at all: veto-style release after the window.
        testing_env!(ctx(alice()).block_timestamp(T0 + 4 * DAY).build());
        c.finalize_milestone(id, 0);
        let ms = c.get_milestone(id, 0).unwrap();
        assert!(ms.finalized && ms.released);
        assert_eq!(c.product(id).tranches_released, 1);
        assert_eq!(c.product(id).founder_locked, FOUNDER_SUPPLY * 3 / 4);
    }

    #[test]
    fn milestone_veto_with_quorum_blocks_release() {
        let mut c = setup();
        let id = make_product(&mut c, founder(), NearToken::from_near(1));
        go_live(&mut c, id);
        let _ = self_product_sold(&mut c, id, 10_000 * DECIMALS_T);
        testing_env!(ctx(founder())
            .attached_deposit(NearToken::from_near(1))
            .build());
        c.publish_milestone(id, "https://demo.example/v2".to_string(), None);
        // Reject majority with 10%+ turnout.
        let mut ms = c.milestones.get(&(id, 0)).cloned().unwrap();
        ms.reject_weight = 6_000 * DECIMALS_T;
        ms.approve_weight = 1_000 * DECIMALS_T;
        c.milestones.insert((id, 0), ms);
        testing_env!(ctx(alice()).block_timestamp(T0 + 4 * DAY).build());
        c.finalize_milestone(id, 0);
        let ms = c.get_milestone(id, 0).unwrap();
        assert!(ms.finalized && !ms.released);
        assert_eq!(c.product(id).tranches_released, 0);
    }

    #[test]
    fn milestone_reject_majority_without_quorum_releases() {
        let mut c = setup();
        let id = make_product(&mut c, founder(), NearToken::from_near(1));
        go_live(&mut c, id);
        let mut p = c.product(id);
        p.curve_sold = 10_000 * DECIMALS_T;
        c.products.insert(id, p);
        testing_env!(ctx(founder())
            .attached_deposit(NearToken::from_near(1))
            .build());
        c.publish_milestone(id, "https://demo.example/v2".to_string(), None);
        // 100% reject but only 5% turnout: no veto.
        let mut ms = c.milestones.get(&(id, 0)).cloned().unwrap();
        ms.reject_weight = 500 * DECIMALS_T;
        c.milestones.insert((id, 0), ms);
        testing_env!(ctx(alice()).block_timestamp(T0 + 4 * DAY).build());
        c.finalize_milestone(id, 0);
        assert!(c.get_milestone(id, 0).unwrap().released);
    }

    fn self_product_sold(c: &mut Contract, id: u64, sold: u128) -> Product {
        let mut p = c.product(id);
        p.curve_sold = sold;
        c.products.insert(id, p.clone());
        p
    }

    /// Drive a lock-to-vote transfer in unit tests: predecessor is the token
    /// contract, sender/amount travel as `ft_transfer_call` would send them.
    fn vote_transfer(
        c: &mut Contract,
        token: AccountId,
        voter: AccountId,
        amount: u128,
        product_id: u64,
        index: u8,
        approve: bool,
    ) -> PromiseOrValue<U128> {
        testing_env!(ctx(token).block_timestamp(T0).build());
        let msg = format!(
            r#"{{"Vote":{{"product_id":{product_id},"index":{index},"approve":{approve}}}}}"#
        );
        c.ft_on_transfer(voter, U128(amount), msg)
    }

    fn vote_unused(res: PromiseOrValue<U128>) -> u128 {
        match res {
            PromiseOrValue::Value(v) => v.0,
            PromiseOrValue::Promise(_) => panic!("vote must settle inline, not via promise"),
        }
    }

    #[test]
    fn vote_locks_tokens_and_caps_weight() {
        let mut c = setup();
        let id = make_product(&mut c, founder(), NearToken::from_near(1));
        go_live(&mut c, id);
        let mut p = c.product(id);
        p.curve_sold = 10_000 * DECIMALS_T;
        c.products.insert(id, p);
        testing_env!(ctx(founder())
            .attached_deposit(NearToken::from_near(1))
            .build());
        c.publish_milestone(id, "https://demo.example/v2".to_string(), None);
        // Whale locks 50% of snapshot: weight capped at 5%, excess refunded.
        let res = vote_transfer(&mut c, token(), alice(), 5_000 * DECIMALS_T, id, 0, true);
        assert_eq!(vote_unused(res), 4_500 * DECIMALS_T);
        let ms = c.milestones.get(&(id, 0)).cloned().unwrap();
        assert_eq!(ms.approve_weight, 500 * DECIMALS_T);
        let lock = c.get_vote_lock(id, 0, alice()).unwrap();
        assert!(lock.approve);
        assert_eq!(lock.amount, 500 * DECIMALS_T); // only counted weight locks
    }

    #[test]
    fn vote_then_transfer_is_impossible_and_unlock_returns() {
        let mut c = setup();
        let id = make_product(&mut c, founder(), NearToken::from_near(1));
        go_live(&mut c, id);
        let mut p = c.product(id);
        p.curve_sold = 10_000 * DECIMALS_T;
        c.products.insert(id, p);
        testing_env!(ctx(founder())
            .attached_deposit(NearToken::from_near(1))
            .build());
        c.publish_milestone(id, "https://demo.example/v2".to_string(), None);
        // Alice locks 100 tokens (below cap: fully counted, nothing refunded).
        let res = vote_transfer(&mut c, token(), alice(), 100, id, 0, false);
        assert_eq!(vote_unused(res), 0);
        assert_eq!(
            c.milestones.get(&(id, 0)).cloned().unwrap().reject_weight,
            100
        );
        // Locked tokens sit in the contract: a second vote from alice is a
        // double vote and fully refunded, and her weight cannot move.
        let res = vote_transfer(&mut c, token(), alice(), 50, id, 0, true);
        assert_eq!(vote_unused(res), 50);
        assert_eq!(
            c.milestones.get(&(id, 0)).cloned().unwrap().approve_weight,
            0
        );
        // Unlock before finalize: rejected.
        testing_env!(ctx(alice()).build());
        let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            let _ = c.unlock_vote(id, 0);
        }));
        assert!(r.is_err());
        // After finalize, unlock removes the lock (transfer runs on-chain).
        testing_env!(ctx(alice()).block_timestamp(T0 + 4 * DAY).build());
        c.finalize_milestone(id, 0);
        let _ = c.unlock_vote(id, 0);
        assert_eq!(c.get_vote_lock(id, 0, alice()), None);
        // Failed unlock transfer restores the lock.
        testing_env!(ctx(this()).build());
        c.on_unlock_settled(id, 0, alice(), false, U128(100), Err(PromiseError::Failed));
        assert_eq!(c.get_vote_lock(id, 0, alice()).unwrap().amount, 100);
    }

    #[test]
    fn invalid_votes_are_fully_refunded() {
        let mut c = setup();
        let id = make_product(&mut c, founder(), NearToken::from_near(1));
        go_live(&mut c, id);
        let mut p = c.product(id);
        p.curve_sold = 10_000 * DECIMALS_T;
        c.products.insert(id, p);
        testing_env!(ctx(founder())
            .attached_deposit(NearToken::from_near(1))
            .build());
        c.publish_milestone(id, "https://demo.example/v2".to_string(), None);
        // Founder voter: refunded.
        let res = vote_transfer(&mut c, token(), founder(), 100, id, 0, true);
        assert_eq!(vote_unused(res), 100);
        // Wrong token (reserve instead of product token): refunded.
        let res = vote_transfer(&mut c, reserve(), alice(), 100, id, 0, true);
        assert_eq!(vote_unused(res), 100);
        // Unknown milestone: refunded.
        let res = vote_transfer(&mut c, token(), alice(), 100, id, 3, true);
        assert_eq!(vote_unused(res), 100);
        // Unknown product: refunded.
        let res = vote_transfer(&mut c, token(), alice(), 100, 999, 0, true);
        assert_eq!(vote_unused(res), 100);
        // Zero amount: refunded.
        let res = vote_transfer(&mut c, token(), alice(), 0, id, 0, true);
        assert_eq!(vote_unused(res), 0);
        assert_eq!(
            c.milestones.get(&(id, 0)).cloned().unwrap().approve_weight,
            0
        );
        // After the window: refunded.
        testing_env!(ctx(token()).block_timestamp(T0 + 4 * DAY).build());
        let msg = format!(r#"{{"Vote":{{"product_id":{id},"index":0,"approve":true}}}}"#);
        let res = c.ft_on_transfer(alice(), U128(100), msg);
        assert_eq!(vote_unused(res), 100);
    }

    #[test]
    fn burn_unclaimed_tranche_after_deadline() {
        let mut c = setup();
        let id = make_product(&mut c, founder(), NearToken::from_near(1));
        go_live(&mut c, id);
        let mut p = c.product(id);
        p.curve_sold = 10_000 * DECIMALS_T;
        c.products.insert(id, p);
        testing_env!(ctx(founder())
            .attached_deposit(NearToken::from_near(1))
            .build());
        c.publish_milestone(id, "https://demo.example/v2".to_string(), None);
        let mut ms = c.milestones.get(&(id, 0)).cloned().unwrap();
        ms.finalized = true; // vetoed, manually settled
        c.milestones.insert((id, 0), ms);
        // Too early: panics.
        testing_env!(ctx(alice()).block_timestamp(T0 + 100 * DAY).build());
        let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            c.burn_unclaimed_tranche(id, 0);
        }));
        assert!(r.is_err());
        // After window + 365d deadline: burns.
        testing_env!(ctx(alice()).block_timestamp(T0 + 400 * DAY).build());
        c.burn_unclaimed_tranche(id, 0);
        let ms = c.get_milestone(id, 0).unwrap();
        assert!(ms.burned);
        assert_eq!(c.product(id).founder_locked, FOUNDER_SUPPLY * 3 / 4);
    }

    #[test]
    fn accrue_yield_math_and_cap() {
        let mut c = setup();
        let id = make_product(&mut c, founder(), NearToken::from_near(1));
        go_live(&mut c, id);
        // balance chosen for exact math: B * 30d / (40 * 365d).
        let year_units: u128 = 40 * YEAR_NS as u128; // 1_261_440_000_000_000_000_000
        let balance = year_units * 1_000;
        let mut pool = c.pool(id, 1);
        pool.balance = balance;
        c.pools.insert((id, 1), pool);
        // One full year later: capped to 30 days.
        testing_env!(ctx(alice()).block_timestamp(T0 + YEAR_NS).build());
        let got = c.accrue_yield(id);
        let expected = balance * (MAX_ACCRUAL_NS as u128) / year_units;
        assert_eq!(got, U128(expected));
        assert_eq!(expected, 2_592_000_000_000_000_000u128);
        // Same timestamp again: zero.
        let again = c.accrue_yield(id);
        assert_eq!(again, U128(0));
    }

    #[test]
    fn rating_callback_enforces_min_holding() {
        let mut c = setup();
        let id = make_product(&mut c, founder(), NearToken::from_near(1));
        go_live(&mut c, id);
        testing_env!(ctx(alice())
            .attached_deposit(NearToken::from_near(1))
            .build());
        let pid = c.submit_post(
            id,
            "https://x.com/alice/status/1".to_string(),
            "@alice".to_string(),
        );
        testing_env!(ctx(verifier()).build());
        c.attest_post(pid, true, 100, "h".to_string());
        // Below-minimum balance: ignored.
        testing_env!(ctx(this()).build());
        c.on_post_rated(pid, bob(), 5, Ok(U128(1)));
        assert_eq!(c.get_post(pid).unwrap().rating_count, 0);
        // Sufficient balance: recorded.
        c.on_post_rated(pid, bob(), 5, Ok(U128(1_000 * DECIMALS_T)));
        let post = c.get_post(pid).unwrap();
        assert_eq!(post.rating_count, 1);
        assert_eq!(post.rating_sum, 5);
        // Failed balance check: ignored.
        c.on_post_rated(pid, alice(), 5, Err(PromiseError::Failed));
        assert_eq!(c.get_post(pid).unwrap().rating_count, 1);
    }

    #[test]
    fn claim_zeroes_then_restores_on_failure() {
        let mut c = setup();
        c.add_claimable(&reserve(), &alice(), 777);
        testing_env!(ctx(alice()).build());
        let _ = c.claim(reserve());
        assert_eq!(c.get_claimable(reserve(), alice()), U128(0));
        testing_env!(ctx(this()).build());
        c.on_claim_settled(reserve(), alice(), U128(777), Err(PromiseError::Failed));
        assert_eq!(c.get_claimable(reserve(), alice()), U128(777));
        // Success path keeps it zeroed.
        testing_env!(ctx(alice()).build());
        let _ = c.claim(reserve());
        testing_env!(ctx(this()).build());
        c.on_claim_settled(reserve(), alice(), U128(777), Ok(()));
        assert_eq!(c.get_claimable(reserve(), alice()), U128(0));
    }

    #[test]
    fn quotes_match_curve_math() {
        let mut c = setup();
        let id = make_product(&mut c, founder(), NearToken::from_near(1));
        go_live(&mut c, id);
        testing_env!(ctx(alice()).build());
        let (dq, cost, fee) = c.get_buy_quote(id, U128(10_000));
        assert_eq!(fee, U128(100));
        assert!(dq.0 > 0 && cost.0 + 100 + 0 < 10_001);
        let (proceeds, _) = c.get_sell_quote(id, U128(dq.0));
        // Can't sell more than sold (nothing sold yet in this view).
        assert_eq!(proceeds, U128(0));
    }

    #[test]
    fn admin_setters_require_owner() {
        let mut c = setup();
        testing_env!(ctx(alice()).build());
        let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            c.set_verifier(alice());
        }));
        assert!(r.is_err());
        testing_env!(ctx(owner()).build());
        c.set_verifier(alice());
        c.set_ops_account(alice());
        c.set_owner(alice());
        assert_eq!(c.get_config().verifier, alice());
        assert_eq!(c.get_config().owner, alice());
    }

    // ---------- vault unit tests ----------

    fn burrow() -> AccountId {
        "burrow.testnet".parse().unwrap()
    }

    /// Product with vault configured: burrow set, enabled, live.
    fn vault_setup(c: &mut Contract) -> u64 {
        let id = make_product(c, founder(), NearToken::from_near(1));
        go_live(c, id);
        testing_env!(ctx(owner()).build());
        c.set_vault_burrow(burrow());
        c.set_vault_enabled(true);
        id
    }

    #[test]
    fn vault_usd_and_deployable_math() {
        // 6-decimal reserve: $1,000 = 1e9 base units.
        assert_eq!(Contract::vault_usd_to_base(1_000, 6), 1_000_000_000);
        assert_eq!(Contract::vault_usd_to_base(10, 6), 10_000_000);
        assert_eq!(Contract::vault_usd_to_base(1_000, 18), 1_000_000_000_000_000_000_000);
        // 70% cap: 100k eligible deploys 70k, then nothing, never negative.
        assert_eq!(Contract::vault_deployable_for(100_000, 0), 70_000);
        assert_eq!(Contract::vault_deployable_for(100_000, 70_000), 0);
        assert_eq!(Contract::vault_deployable_for(100_000, 90_000), 0);
        assert_eq!(Contract::vault_deployable_for(0, 0), 0);
    }

    #[test]
    fn vault_settle_math_cases() {
        // Full withdraw with gain.
        assert_eq!(
            Contract::vault_settle_math(1_000, None, 1_050),
            (0, 50, 0)
        );
        // Partial exact: no gain, no shortfall.
        assert_eq!(
            Contract::vault_settle_math(1_000, Some(400), 400),
            (600, 0, 0)
        );
        // Partial with gain.
        assert_eq!(
            Contract::vault_settle_math(1_000, Some(400), 450),
            (600, 50, 0)
        );
        // Shortfall is reported (pool absorbs it, never users).
        assert_eq!(
            Contract::vault_settle_math(1_000, Some(400), 350),
            (600, 0, 50)
        );
        // Want above principal clamps to principal.
        assert_eq!(
            Contract::vault_settle_math(1_000, Some(9_999), 1_010),
            (0, 10, 0)
        );
    }

    #[test]
    fn vault_want_normalizes_full_to_none() {
        assert_eq!(Contract::vault_want(1_000, 1_000), None);
        assert_eq!(Contract::vault_want(1_000, 1_001), None);
        assert_eq!(Contract::vault_want(1_000, 999), Some(999));
        assert_eq!(Contract::vault_want(0, 0), None);
    }

    #[test]
    fn vault_min_start_default_and_override() {
        let mut c = setup();
        let id = make_product(&mut c, founder(), NearToken::from_near(1));
        assert_eq!(c.vault_min_start_for(id, 6), 1_000_000_000);
        testing_env!(ctx(owner()).build());
        c.set_vault_min_start(id, U128(5_000));
        assert_eq!(c.vault_min_start_for(id, 6), 5_000);
        let pos = c.get_vault_position(id);
        assert_eq!(pos.min_start, U128(5_000));
        assert_eq!(pos.asset_scale, 12); // default fakes-USDT scale
    }

    #[test]
    fn vault_accrue_gated_by_principal() {
        let mut c = setup();
        let id = vault_setup(&mut c);
        let mut pool = c.pool(id, 1);
        pool.balance = 1_000_000;
        c.pools.insert((id, 1), pool);
        c.vault_principal.insert(id, 100_000);
        testing_env!(ctx(alice()).block_timestamp(T0 + 10 * DAY).build());
        assert_eq!(c.accrue_yield(id), U128(0));
        assert_eq!(c.pool(id, 1).balance, 1_000_000, "no phantom yield");
        assert_eq!(c.product(id).last_yield_ns, T0 + 10 * DAY);
    }

    #[test]
    fn vault_deposit_callback_success_and_failure() {
        let mut c = setup();
        let id = vault_setup(&mut c);
        c.vault_busy.insert(id);
        testing_env!(ctx(this()).build());
        // Callback carries the USED amount: full success credits all.
        c.on_vault_deposited(id, U128(50_000), Ok(U128(50_000)));
        assert_eq!(c.vault_principal_of(id), 50_000);
        assert!(!c.vault_busy.contains(&id));
        // Partial consumption credits only what Burrow kept.
        c.vault_busy.insert(id);
        c.on_vault_deposited(id, U128(50_000), Ok(U128(40_000)));
        assert_eq!(c.vault_principal_of(id), 90_000);
        // Failure (e.g. Burrow not registered): refunded, nothing recorded.
        c.vault_busy.insert(id);
        c.on_vault_deposited(id, U128(50_000), Err(PromiseError::Failed));
        assert_eq!(c.vault_principal_of(id), 90_000);
        assert!(!c.vault_busy.contains(&id));
    }

    #[test]
    fn vault_withdraw_settle_credits_gain_and_keeps_recall() {
        let mut c = setup();
        let id = vault_setup(&mut c);
        c.vault_principal.insert(id, 1_000);
        c.vault_recall.insert(id, 1_500);
        c.vault_busy.insert(id);
        testing_env!(ctx(this()).build());
        // Withdraw 400 of 1,000; 450 arrives: gain 50 to the pool.
        let _ = c.on_vault_withdraw_settled(
            id,
            Some(U128(400)),
            U128(10_000),
            Ok(U128(10_450)),
        );
        assert_eq!(c.vault_principal_of(id), 600);
        assert_eq!(c.pool(id, 1).balance, 50);
        assert_eq!(c.vault_recall_of(id), 1_050); // 1500 - 450 proceeds
        // No in-tx chaining (bounded gas): the keeper picks recall up next.
        assert!(!c.vault_busy.contains(&id));
    }

    #[test]
    fn vault_withdraw_settle_absorbs_shortfall_and_clears() {
        let mut c = setup();
        let id = vault_setup(&mut c);
        c.vault_principal.insert(id, 1_000);
        let mut pool = c.pool(id, 1);
        pool.balance = 500;
        c.pools.insert((id, 1), pool);
        c.vault_busy.insert(id);
        testing_env!(ctx(this()).build());
        // Full withdraw, only 900 of 1,000 arrives: pool absorbs 100.
        let _ = c.on_vault_withdraw_settled(id, None, U128(10_000), Ok(U128(10_900)));
        assert_eq!(c.vault_principal_of(id), 0);
        assert_eq!(c.pool(id, 1).balance, 400);
        assert!(!c.vault_busy.contains(&id));
    }

    #[test]
    fn vault_full_unwind_clears_stale_recall() {
        let mut c = setup();
        let id = vault_setup(&mut c);
        c.vault_principal.insert(id, 1_000);
        c.vault_recall.insert(id, 5_000); // exceeds what the vault holds
        c.vault_busy.insert(id);
        testing_env!(ctx(this()).build());
        let _ = c.on_vault_withdraw_settled(id, None, U128(10_000), Ok(U128(11_000)));
        assert_eq!(c.vault_principal_of(id), 0);
        assert_eq!(c.vault_recall_of(id), 0, "nothing left to recall from");
        assert!(!c.vault_busy.contains(&id));
    }

    #[test]
    fn vault_withdraw_settle_keeps_busy_on_read_failure() {
        let mut c = setup();
        let id = vault_setup(&mut c);
        c.vault_principal.insert(id, 1_000);
        c.vault_busy.insert(id);
        testing_env!(ctx(this()).build());
        let _ =
            c.on_vault_withdraw_settled(id, None, U128(10_000), Err(PromiseError::Failed));
        // Uncertain books: busy stays until owner clear + reconcile.
        assert!(c.vault_busy.contains(&id));
        assert_eq!(c.vault_principal_of(id), 1_000);
        testing_env!(ctx(owner()).build());
        c.vault_clear_busy(id);
        c.vault_reconcile(id, U128(200));
        assert_eq!(c.vault_principal_of(id), 200);
    }

    #[test]
    fn vault_rebalance_priority_and_gate() {
        let mut c = setup();
        let id = vault_setup(&mut c);
        // Disabled: noop.
        testing_env!(ctx(owner()).build());
        c.set_vault_enabled(false);
        testing_env!(ctx(alice()).build());
        assert!(matches!(c.vault_rebalance(id), PromiseOrValue::Value(())));
        // Below gate, nothing deployed: noop.
        testing_env!(ctx(owner()).build());
        c.set_vault_enabled(true);
        testing_env!(ctx(alice()).build());
        assert!(matches!(c.vault_rebalance(id), PromiseOrValue::Value(())));
        // Above gate: starts a deposit (busy set).
        let mut p = c.product(id);
        p.curve_reserve = 2_000_000_000; // $2,000 eligible
        c.products.insert(id, p);
        let r = c.vault_rebalance(id);
        assert!(matches!(r, PromiseOrValue::Promise(_)));
        assert!(c.vault_busy.contains(&id));
        // Busy: noop.
        assert!(matches!(c.vault_rebalance(id), PromiseOrValue::Value(())));
    }

    #[test]
    fn vault_rebalance_recall_and_unwind() {
        let mut c = setup();
        let id = vault_setup(&mut c);
        let mut p = c.product(id);
        p.curve_reserve = 2_000_000_000;
        c.products.insert(id, p);
        c.vault_principal.insert(id, 1_000_000_000);
        // Recorded recall starts a withdraw even when balanced.
        c.vault_recall.insert(id, 100_000_000);
        testing_env!(ctx(alice()).build());
        assert!(matches!(c.vault_rebalance(id), PromiseOrValue::Promise(_)));
        assert!(c.vault_busy.contains(&id));
        testing_env!(ctx(owner()).build());
        c.vault_clear_busy(id);
        // Liquidity fell below the gate: full unwind.
        let mut p = c.product(id);
        p.curve_reserve = 100_000_000; // $100 < $1,000 gate
        c.products.insert(id, p);
        c.vault_recall.insert(id, 0);
        testing_env!(ctx(alice()).build());
        assert!(matches!(c.vault_rebalance(id), PromiseOrValue::Promise(_)));
    }

    #[test]
    fn vault_shortfall_registered_queues_unregistered_claims() {
        let mut c = setup();
        let id = vault_setup(&mut c);
        testing_env!(ctx(this()).build());
        // Registered seller: queued + recall recorded.
        let registered: Result<Option<near_sdk::serde_json::Value>, PromiseError> =
            Ok(Some(near_sdk::serde_json::json!({"total": "1"})));
        assert_eq!(
            c.on_sell_shortfall_check(alice(), id, U128(777), registered),
            U128(0)
        );
        assert_eq!(c.vault_recall_of(id), 777);
        let queue = c.vault_pending.get(&id).cloned().unwrap();
        assert_eq!(queue.len(), 1);
        assert_eq!(queue[0].seller, alice());
        // Unregistered seller: classic claimable hold, no queue growth.
        let missing: Result<Option<near_sdk::serde_json::Value>, PromiseError> = Ok(None);
        assert_eq!(
            c.on_sell_shortfall_check(bob(), id, U128(111), missing),
            U128(0)
        );
        assert_eq!(c.get_claimable(reserve(), bob()), U128(111));
        assert_eq!(c.vault_pending.get(&id).cloned().unwrap().len(), 1);
    }

    #[test]
    fn vault_pending_paid_failure_becomes_claimable() {
        let mut c = setup();
        let id = vault_setup(&mut c);
        testing_env!(ctx(this()).build());
        c.on_pending_paid(id, alice(), U128(500), Err(PromiseError::Failed));
        assert_eq!(c.get_claimable(reserve(), alice()), U128(500));
        c.on_pending_paid(id, bob(), U128(300), Ok(()));
        assert_eq!(c.get_claimable(reserve(), bob()), U128(0));
    }

    #[test]
    fn vault_finalize_records_recall_and_owed() {
        let mut c = setup();
        let id = vault_setup(&mut c);
        // One qualified post so the pool splits to a creator.
        testing_env!(ctx(alice())
            .attached_deposit(NearToken::from_near(1))
            .build());
        let pid = c.submit_post(
            id,
            "https://x.com/alice/status/1".to_string(),
            "@alice".to_string(),
        );
        testing_env!(ctx(verifier()).build());
        c.attest_post(pid, true, 100, "h".to_string());
        c.confirm_liveness(id, 1, vec![LiveConfirmation { post_id: pid, live: true }]);
        // $10 pool, $8 deployed: liquid estimate $2, payout $10 → recall $8.
        // Busy is preset so finalize only records (no promise in unit env).
        let mut pool = c.pool(id, 1);
        pool.balance = 10_000;
        c.pools.insert((id, 1), pool);
        c.vault_principal.insert(id, 8_000);
        c.vault_busy.insert(id);
        testing_env!(ctx(alice()).block_timestamp(T0 + 31 * DAY).build());
        let _ = c.finalize_cycle(id);
        assert_eq!(c.get_payout(id, 1, alice()), U128(10_000));
        assert_eq!(c.cycle_owed.get(&(id, 1)).copied().unwrap(), 10_000);
        assert_eq!(c.vault_recall_of(id), 8_000);
    }

    #[test]
    fn vault_burrow_set_once_and_owner_guarded() {
        let mut c = setup();
        let id = make_product(&mut c, founder(), NearToken::from_near(1));
        testing_env!(ctx(alice()).build());
        let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            c.set_vault_enabled(true);
        }));
        assert!(r.is_err());
        testing_env!(ctx(owner()).build());
        c.set_vault_burrow(burrow());
        let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            c.set_vault_burrow(alice());
        }));
        assert!(r.is_err(), "burrow address is one-way");
        // Reconcile passes when idle, panics while busy.
        c.vault_reconcile(id, U128(1));
        assert_eq!(c.vault_principal_of(id), 1);
        c.vault_busy.insert(id);
        let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            c.vault_reconcile(id, U128(2));
        }));
        assert!(r.is_err(), "reconcile needs clear busy first");
    }

    // ---------- product anchors / launch guard / url uniqueness ----------

    const GOOD_HASH: &str =
        "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

    fn make_product_hashed(
        c: &mut Contract,
        metadata_hash: Option<String>,
        rules_hash: Option<String>,
    ) -> u64 {
        testing_env!(ctx(founder())
            .attached_deposit(NearToken::from_near(1))
            .build());
        c.create_product(
            "Demo Product".to_string(),
            "DEMO".to_string(),
            "A demo product".to_string(),
            "https://demo.example".to_string(),
            metadata_hash,
            rules_hash,
            reserve(),
            6,
            100,
            U128(100),
            U128(9_900),
            U128(1_000 * DECIMALS_T),
            5,
            30 * DAY,
            2 * DAY,
            3 * DAY,
            365 * DAY,
        )
    }

    #[test]
    fn create_product_with_and_without_hashes() {
        let mut c = setup();
        let id = make_product_hashed(
            &mut c,
            Some(GOOD_HASH.to_string()),
            Some(GOOD_HASH.to_string()),
        );
        let p = c.get_product(id).unwrap();
        assert_eq!(p.metadata_hash, Some(GOOD_HASH.to_string()));
        assert_eq!(p.rules_hash, Some(GOOD_HASH.to_string()));
        let id2 = make_product_hashed(&mut c, None, None);
        let p2 = c.get_product(id2).unwrap();
        assert_eq!(p2.metadata_hash, None);
        assert_eq!(p2.rules_hash, None);
    }

    #[test]
    fn create_product_rejects_bad_hashes() {
        for bad in [
            "abc",                                             // too short
            &("ab".repeat(40)),                                // too long
            &"0123456789ABCDEF0123456789abcdef0123456789abcdef0123456789abcdef"
                .to_string(), // uppercase
            &"zz23456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
                .to_string(), // non-hex
        ] {
            let mut c = setup();
            let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                make_product_hashed(&mut c, Some(bad.to_string()), None);
            }));
            assert!(r.is_err(), "hash must be rejected: {bad}");
        }
    }

    #[test]
    fn milestone_evidence_hash_stored_and_returned() {
        let mut c = setup();
        let id = make_product(&mut c, founder(), NearToken::from_near(1));
        go_live(&mut c, id);
        testing_env!(ctx(founder())
            .attached_deposit(NearToken::from_near(1))
            .build());
        let idx = c.publish_milestone(
            id,
            "https://demo.example/v2".to_string(),
            Some(GOOD_HASH.to_string()),
        );
        assert_eq!(c.get_milestone(id, idx).unwrap().evidence_hash, Some(GOOD_HASH.to_string()));
        let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            c.publish_milestone(id, "https://demo.example/v3".to_string(), Some("nope".to_string()));
        }));
        assert!(r.is_err(), "bad evidence hash must be rejected");
    }

    #[test]
    fn launch_coin_rejected_for_non_founders() {
        let mut c = setup();
        let _ = make_product(&mut c, founder(), NearToken::from_near(1));
        testing_env!(ctx(alice())
            .attached_deposit(NearToken::from_near(10))
            .build());
        let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            let _ = c.launch_coin(1);
        }));
        assert!(r.is_err());
    }

    #[test]
    fn duplicate_post_url_rejected_per_product() {
        let mut c = setup();
        let id = make_product(&mut c, founder(), NearToken::from_near(1));
        go_live(&mut c, id);
        testing_env!(ctx(alice())
            .attached_deposit(NearToken::from_near(1))
            .build());
        let _ = c.submit_post(
            id,
            "https://x.com/alice/status/1".to_string(),
            "@alice".to_string(),
        );
        // Same URL, different account, same product: rejected.
        testing_env!(ctx(bob())
            .attached_deposit(NearToken::from_near(1))
            .build());
        let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            c.submit_post(
                id,
                "https://x.com/alice/status/1".to_string(),
                "@bob".to_string(),
            );
        }));
        assert!(r.is_err());
        // Same URL on a different product: fine.
        let id2 = make_product(&mut c, founder(), NearToken::from_near(1));
        go_live(&mut c, id2);
        testing_env!(ctx(bob())
            .attached_deposit(NearToken::from_near(1))
            .build());
        let pid = c.submit_post(
            id2,
            "https://x.com/alice/status/1".to_string(),
            "@bob".to_string(),
        );
        assert!(pid > 0);
    }

    #[test]
    fn submitted_post_carries_its_id() {
        let mut c = setup();
        let id = make_product(&mut c, founder(), NearToken::from_near(1));
        go_live(&mut c, id);
        testing_env!(ctx(alice())
            .attached_deposit(NearToken::from_near(1))
            .build());
        let pid = c.submit_post(
            id,
            "https://x.com/alice/status/9".to_string(),
            "@alice".to_string(),
        );
        assert_eq!(c.get_post(pid).unwrap().post_id, pid);
        let listed = c.list_cycle_posts(id, 1);
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].post_id, pid);
    }
}
