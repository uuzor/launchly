//! launchly-token: NEP-141 fungible token with a minter-controlled supply.
//!
//! One instance is deployed per Launchly product coin. The Launchly main
//! contract is the minter: it mints tokens on bonding-curve buys and burns
//! them on sells. Implements NEP-141 (core), NEP-145 (storage management)
//! and NEP-148 (metadata) via near-contract-standards.

use near_contract_standards::fungible_token::core::FungibleTokenCore;
use near_contract_standards::fungible_token::events::{FtBurn, FtMint};
use near_contract_standards::fungible_token::metadata::{
    FungibleTokenMetadata, FungibleTokenMetadataProvider,
};
use near_contract_standards::fungible_token::resolver::FungibleTokenResolver;
use near_contract_standards::fungible_token::FungibleToken;
use near_contract_standards::storage_management::{
    StorageBalance, StorageBalanceBounds, StorageManagement,
};
use near_sdk::json_types::U128;
use near_sdk::{env, near, AccountId, NearToken, PanicOnDefault, PromiseOrValue};

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Contract {
    token: FungibleToken,
    metadata: FungibleTokenMetadata,
    minter: AccountId,
}

#[near]
impl Contract {
    #[init]
    pub fn new(minter: AccountId, metadata: FungibleTokenMetadata) -> Self {
        assert!(!env::state_exists(), "Already initialized");
        metadata.assert_valid();
        Self {
            token: FungibleToken::new(b"t".to_vec()),
            metadata,
            minter,
        }
    }

    /// Mint new tokens. Only the minter (the Launchly main contract) can call.
    /// The recipient must be storage-registered first (NEP-145); otherwise
    /// this panics and the caller can handle the failure in a callback.
    pub fn mint(&mut self, account_id: AccountId, amount: U128) {
        self.assert_minter();
        self.token.internal_deposit(&account_id, amount.0);
        FtMint {
            owner_id: &account_id,
            amount,
            memo: None,
        }
        .emit();
    }

    /// Burn tokens from any account. Only the minter can call.
    pub fn burn_from(&mut self, account_id: AccountId, amount: U128) {
        self.assert_minter();
        self.token.internal_withdraw(&account_id, amount.0);
        FtBurn {
            owner_id: &account_id,
            amount,
            memo: None,
        }
        .emit();
    }

    pub fn get_minter(&self) -> AccountId {
        self.minter.clone()
    }

    fn assert_minter(&self) {
        assert_eq!(
            env::predecessor_account_id(),
            self.minter,
            "Only the minter can call this method"
        );
    }
}

// NEP-141 core + resolver + NEP-145 storage, delegated to the inner
// FungibleToken (the old macros are deprecated and broken in 5.30).
#[near]
impl FungibleTokenCore for Contract {
    #[payable]
    fn ft_transfer(&mut self, receiver_id: AccountId, amount: U128, memo: Option<String>) {
        self.token.ft_transfer(receiver_id, amount, memo)
    }

    #[payable]
    fn ft_transfer_call(
        &mut self,
        receiver_id: AccountId,
        amount: U128,
        memo: Option<String>,
        msg: String,
    ) -> PromiseOrValue<U128> {
        self.token.ft_transfer_call(receiver_id, amount, memo, msg)
    }

    fn ft_total_supply(&self) -> U128 {
        self.token.ft_total_supply()
    }

    fn ft_balance_of(&self, account_id: AccountId) -> U128 {
        self.token.ft_balance_of(account_id)
    }
}

#[near]
impl FungibleTokenResolver for Contract {
    #[private]
    fn ft_resolve_transfer(
        &mut self,
        sender_id: AccountId,
        receiver_id: AccountId,
        amount: U128,
    ) -> U128 {
        self.token.ft_resolve_transfer(sender_id, receiver_id, amount)
    }
}

#[near]
impl StorageManagement for Contract {
    #[payable]
    fn storage_deposit(
        &mut self,
        account_id: Option<AccountId>,
        registration_only: Option<bool>,
    ) -> StorageBalance {
        self.token.storage_deposit(account_id, registration_only)
    }

    #[payable]
    fn storage_withdraw(&mut self, amount: Option<NearToken>) -> StorageBalance {
        self.token.storage_withdraw(amount)
    }

    #[payable]
    fn storage_unregister(&mut self, force: Option<bool>) -> bool {
        #[allow(unused_variables)]
        if let Some((account_id, balance)) = self.token.internal_storage_unregister(force) {
            true
        } else {
            false
        }
    }

    fn storage_balance_bounds(&self) -> StorageBalanceBounds {
        self.token.storage_balance_bounds()
    }

    fn storage_balance_of(&self, account_id: AccountId) -> Option<StorageBalance> {
        self.token.storage_balance_of(account_id)
    }
}

#[near]
impl FungibleTokenMetadataProvider for Contract {
    fn ft_metadata(&self) -> FungibleTokenMetadata {
        self.metadata.clone()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use near_contract_standards::fungible_token::metadata::FT_METADATA_SPEC;
    use near_sdk::test_utils::VMContextBuilder;
    use near_sdk::{testing_env, NearToken};

    fn alice() -> AccountId {
        "alice.testnet".parse().unwrap()
    }

    fn minter() -> AccountId {
        "launchly.testnet".parse().unwrap()
    }

    fn test_metadata() -> FungibleTokenMetadata {
        FungibleTokenMetadata {
            spec: FT_METADATA_SPEC.to_string(),
            name: "Launchly Test Coin".to_string(),
            symbol: "LTC".to_string(),
            icon: None,
            reference: None,
            reference_hash: None,
            decimals: 18,
        }
    }

    fn ctx(predecessor: AccountId) -> VMContextBuilder {
        let mut b = VMContextBuilder::new();
        b.predecessor_account_id(predecessor);
        b
    }

    #[test]
    fn init_sets_minter_and_metadata() {
        testing_env!(ctx(minter()).build());
        let c = Contract::new(minter(), test_metadata());
        assert_eq!(c.get_minter(), minter());
        assert_eq!(c.ft_metadata().decimals, 18);
        assert_eq!(c.ft_total_supply(), U128(0));
    }

    #[test]
    #[should_panic(expected = "Already initialized")]
    fn init_twice_panics() {
        testing_env!(ctx(minter()).build());
        let mut c = Contract::new(minter(), test_metadata());
        // Simulate existing state by writing it, then re-init must panic.
        // near-sdk #[init] methods check state_exists only for real state;
        // here we emulate by just calling new again after storing.
        let _ = &mut c;
        testing_env!(ctx(minter()).build());
        // state_exists is false in a fresh mock, so force state first:
        env::state_write(&c);
        let _ = Contract::new(minter(), test_metadata());
    }

    #[test]
    fn minter_can_mint_to_registered_account() {
        testing_env!(ctx(minter()).build());
        let mut c = Contract::new(minter(), test_metadata());
        c.token.internal_register_account(&alice());
        c.mint(alice(), U128(1_000));
        assert_eq!(c.ft_balance_of(alice()), U128(1_000));
        assert_eq!(c.ft_total_supply(), U128(1_000));
    }

    #[test]
    #[should_panic(expected = "Only the minter")]
    fn non_minter_cannot_mint() {
        testing_env!(ctx(minter()).build());
        let mut c = Contract::new(minter(), test_metadata());
        c.token.internal_register_account(&alice());
        testing_env!(ctx(alice()).build());
        c.mint(alice(), U128(1_000));
    }

    #[test]
    #[should_panic]
    fn mint_to_unregistered_account_panics() {
        testing_env!(ctx(minter()).build());
        let mut c = Contract::new(minter(), test_metadata());
        // alice never registered: internal_deposit must panic so the
        // Launchly main contract can refund the buyer in a callback.
        c.mint(alice(), U128(1_000));
    }

    #[test]
    fn minter_can_burn() {
        testing_env!(ctx(minter()).build());
        let mut c = Contract::new(minter(), test_metadata());
        c.token.internal_register_account(&alice());
        c.mint(alice(), U128(1_000));
        c.burn_from(alice(), U128(400));
        assert_eq!(c.ft_balance_of(alice()), U128(600));
        assert_eq!(c.ft_total_supply(), U128(600));
    }

    #[test]
    #[should_panic(expected = "Only the minter")]
    fn non_minter_cannot_burn() {
        testing_env!(ctx(minter()).build());
        let mut c = Contract::new(minter(), test_metadata());
        c.token.internal_register_account(&alice());
        c.mint(alice(), U128(1_000));
        testing_env!(ctx(alice()).build());
        c.burn_from(alice(), U128(100));
    }

    #[test]
    fn storage_deposit_registers() {
        testing_env!(ctx(minter()).build());
        let mut c = Contract::new(minter(), test_metadata());
        // Register alice by attaching NEAR as alice herself.
        testing_env!(ctx(alice())
            .attached_deposit(NearToken::from_yoctonear(10u128.pow(22)))
            .build());
        c.storage_deposit(Some(alice()), None);
        assert!(c.storage_balance_of(alice()).is_some());
        // Now minting works.
        testing_env!(ctx(minter()).build());
        c.mint(alice(), U128(5));
        assert_eq!(c.ft_balance_of(alice()), U128(5));
    }

    #[test]
    fn transfer_moves_balance_with_one_yocto() {
        testing_env!(ctx(minter()).build());
        let mut c = Contract::new(minter(), test_metadata());
        let bob: AccountId = "bob.testnet".parse().unwrap();
        c.token.internal_register_account(&alice());
        c.token.internal_register_account(&bob);
        c.mint(alice(), U128(1_000));
        testing_env!(ctx(alice())
            .attached_deposit(NearToken::from_yoctonear(1))
            .build());
        c.ft_transfer(bob.clone(), U128(250), None);
        assert_eq!(c.ft_balance_of(alice()), U128(750));
        assert_eq!(c.ft_balance_of(bob), U128(250));
    }
}
