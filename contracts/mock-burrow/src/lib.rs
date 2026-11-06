//! mock-burrow: test-only stand-in for the Burrow subset Launchly uses.
//!
//! Implements, with real-Burrow-compatible method names and shapes:
//! - `storage_deposit` (registration gate, like Burrow's account creation)
//! - `ft_on_transfer` with empty msg = plain supply deposit (returns U128(0));
//!   msg `"Fund"` credits interest surplus instead (test funding)
//! - `execute` with `[{Withdraw: {token_id, amount, max_amount}}]`, 1 yocto
//!   attached, proceeds paid via plain `ft_transfer` (no receiver callback)
//! - `get_account` / `get_asset` views approximating Burrow's shapes
//!
//! Partial-withdraw `amount` is in Burrow internal units (ft * 10^scale,
//! scale 12 like fakes USDT); `null` withdraws the whole position.
//! Fake interest: `interest_bps` of each withdrawal, capped by funded
//! surplus, so tests can prove gain accounting end to end.
//!
//! Fidelity notes (both observed against real Burrow on testnet):
//! - Each supply credits 1 unit less than deposited (share-rounding dust,
//!   kept by the mock as unattributed residue). Callers must therefore
//!   never request a partial for exactly their ledger principal.
//! - A partial above the held balance panics, like Burrow's
//!   amount-to-shares conversion refusing oversized requests.

use near_sdk::json_types::U128;
use near_sdk::store::{LookupMap, LookupSet};
use near_sdk::{env, log, near, AccountId, Gas, NearToken, PanicOnDefault, Promise, PromiseOrValue};

const ONE_YOCTO: NearToken = NearToken::from_yoctonear(1);
const GAS_FT_TRANSFER: Gas = Gas::from_tgas(12);
const SCALE: u32 = 12; // fakes-USDT-like scaling for partial amounts

#[near(serializers = [json])]
#[derive(Clone, Debug)]
pub struct AssetAmount {
    pub token_id: AccountId,
    pub amount: Option<U128>,
    pub max_amount: Option<U128>,
}

#[near(serializers = [json])]
#[derive(Clone, Debug)]
pub enum MockAction {
    Withdraw(AssetAmount),
}

#[near(serializers = [json])]
#[derive(Clone, Debug)]
pub struct ExecuteArgs {
    pub actions: Vec<MockAction>,
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Contract {
    owner: AccountId,
    interest_bps: u32,
    registered: LookupSet<AccountId>,
    supplied: LookupMap<(AccountId, AccountId), u128>,
    surplus: LookupMap<AccountId, u128>,
}

#[near]
impl Contract {
    #[init]
    pub fn new(owner: AccountId, interest_bps: u32) -> Self {
        assert!(!env::state_exists(), "Already initialized");
        assert!(interest_bps <= 10_000, "bps out of bounds");
        Self {
            owner,
            interest_bps,
            registered: LookupSet::new(b"r".to_vec()),
            supplied: LookupMap::new(b"s".to_vec()),
            surplus: LookupMap::new(b"u".to_vec()),
        }
    }

    fn assert_owner(&self) {
        assert_eq!(
            env::predecessor_account_id(),
            self.owner,
            "Only the owner can call this method"
        );
    }

    pub fn set_interest_bps(&mut self, interest_bps: u32) {
        self.assert_owner();
        assert!(interest_bps <= 10_000, "bps out of bounds");
        self.interest_bps = interest_bps;
    }

    /// Register an account (any deposit accepted; test-only).
    #[payable]
    pub fn storage_deposit(&mut self, account_id: Option<AccountId>) {
        let account = account_id.unwrap_or_else(env::predecessor_account_id);
        self.registered.insert(account);
    }

    /// NEP-141 receiver: empty msg supplies, `"Fund"` funds interest surplus.
    #[payable]
    pub fn ft_on_transfer(
        &mut self,
        sender_id: AccountId,
        amount: U128,
        msg: String,
    ) -> PromiseOrValue<U128> {
        assert!(
            self.registered.contains(&sender_id),
            "account not registered: call storage_deposit first"
        );
        let token = env::predecessor_account_id();
        if msg.is_empty() {
            let key = (sender_id.clone(), token);
            let cur = self.supplied.get(&key).copied().unwrap_or(0);
            // 1-unit share-rounding spread, mirroring real Burrow dust.
            let credited = amount.0.saturating_sub(1);
            self.supplied.insert(key, cur + credited);
            log!("mock_supplied account={sender_id} amount={credited}");
        } else if msg == "Fund" {
            let cur = self.surplus.get(&token).copied().unwrap_or(0);
            self.surplus.insert(token, cur + amount.0);
            log!("mock_funded amount={}", amount.0);
        } else {
            env::panic_str("bad msg: expected empty (supply) or Fund");
        }
        PromiseOrValue::Value(U128(0))
    }

    /// Execute Withdraw actions. Requires exactly 1 yocto like real Burrow.
    /// Proceeds (principal + fake interest from surplus) arrive via plain
    /// `ft_transfer`, exactly like Burrow — the caller must measure them.
    #[payable]
    pub fn execute(&mut self, actions: Vec<MockAction>) -> Promise {
        assert_eq!(
            env::attached_deposit(),
            ONE_YOCTO,
            "requires exactly 1 yocto"
        );
        let caller = env::predecessor_account_id();
        assert!(
            self.registered.contains(&caller),
            "account not registered: call storage_deposit first"
        );
        // Single-action support is enough for the Launchly adapter.
        assert_eq!(actions.len(), 1, "mock supports exactly one action");
        let MockAction::Withdraw(a) = &actions[0];
        let key = (caller.clone(), a.token_id.clone());
        let held = self.supplied.get(&key).copied().unwrap_or(0);
        let want_ft = match a.amount {
            None => held,
            Some(internal) => internal.0 / 10u128.pow(SCALE),
        };
        assert!(
            want_ft <= held,
            "withdraw exceeds supplied: want {want_ft}, held {held}"
        );
        let pay = want_ft;
        let interest = (pay * self.interest_bps as u128 / 10_000)
            .min(self.surplus.get(&a.token_id).copied().unwrap_or(0));
        self.supplied.insert(key, held - pay);
        if interest > 0 {
            let s = self.surplus.get(&a.token_id).copied().unwrap_or(0);
            self.surplus.insert(a.token_id.clone(), s - interest);
        }
        let total = pay + interest;
        log!("mock_withdraw account={caller} pay={pay} interest={interest}");
        let args = near_sdk::serde_json::to_vec(&near_sdk::serde_json::json!({
            "receiver_id": caller,
            "amount": U128(total),
        }))
        .unwrap();
        Promise::new(a.token_id.clone()).function_call(
            "ft_transfer".to_string(),
            args,
            ONE_YOCTO,
            GAS_FT_TRANSFER,
        )
    }

    pub fn is_registered(&self, account_id: AccountId) -> bool {
        self.registered.contains(&account_id)
    }

    pub fn get_supplied(&self, account_id: AccountId, token_id: AccountId) -> U128 {
        U128(
            self.supplied
                .get(&(account_id, token_id))
                .copied()
                .unwrap_or(0),
        )
    }

    pub fn get_account(&self, account_id: AccountId) -> Option<near_sdk::serde_json::Value> {
        if !self.registered.contains(&account_id) {
            return None;
        }
        // Shape approximates Burrow's AccountDetailed.supplied for UI parity.
        Some(near_sdk::serde_json::json!({
            "account_id": account_id,
            "supplied": [], // per-token balances via get_supplied in tests
        }))
    }

    pub fn get_asset(&self, token_id: AccountId) -> near_sdk::serde_json::Value {
        near_sdk::serde_json::json!({
            "token_id": token_id,
            "config": {
                "can_deposit": true,
                "can_withdraw": true,
                "extra_decimals": SCALE,
            },
        })
    }

}

#[cfg(test)]
mod tests {
    use super::*;
    use near_sdk::test_utils::VMContextBuilder;
    use near_sdk::testing_env;

    fn owner() -> AccountId {
        "owner.testnet".parse().unwrap()
    }
    fn alice() -> AccountId {
        "alice.testnet".parse().unwrap()
    }
    fn token() -> AccountId {
        "usdt.testnet".parse().unwrap()
    }

    fn setup() -> Contract {
        let mut b = VMContextBuilder::new();
        b.predecessor_account_id(owner());
        testing_env!(b.build());
        Contract::new(owner(), 500)
    }

    #[test]
    fn supply_and_withdraw_with_interest() {
        let mut c = setup();
        let mut b = VMContextBuilder::new();
        b.predecessor_account_id(owner());
        testing_env!(b.build());
        c.storage_deposit(Some(alice()));
        // Supply 1,000 as alice (token contract is the predecessor).
        let mut b = VMContextBuilder::new();
        b.predecessor_account_id(token());
        testing_env!(b.build());
        let r = c.ft_on_transfer(alice(), U128(1_000), "".to_string());
        assert!(matches!(r, PromiseOrValue::Value(U128(0))));
        assert_eq!(c.get_supplied(alice(), token()), U128(999)); // 1-unit spread
        // Fund 100 surplus, then withdraw: 5% of 999 = 49 interest.
        let r = c.ft_on_transfer(alice(), U128(100), "Fund".to_string());
        assert!(matches!(r, PromiseOrValue::Value(U128(0))));
        let mut b = VMContextBuilder::new();
        b.predecessor_account_id(alice())
            .attached_deposit(ONE_YOCTO);
        testing_env!(b.build());
        let _ = c.execute(vec![MockAction::Withdraw(AssetAmount {
            token_id: token(),
            amount: None,
            max_amount: None,
        })]);
        assert_eq!(c.get_supplied(alice(), token()), U128(0));
        assert_eq!(c.surplus.get(&token()).copied().unwrap(), 51);
    }

    #[test]
    #[should_panic(expected = "not registered")]
    fn unregistered_supply_panics() {
        let mut c = setup();
        let mut b = VMContextBuilder::new();
        b.predecessor_account_id(token());
        testing_env!(b.build());
        let _ = c.ft_on_transfer(alice(), U128(1_000), "".to_string());
    }
}
