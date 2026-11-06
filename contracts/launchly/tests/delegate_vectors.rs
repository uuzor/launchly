//! Test-vector generator for the Python meta-tx relay decoder.
//!
//! Serializes real NEP-366 `SignedDelegateAction`s with near-primitives so
//! `intents/test_relay.py` decodes bytes it did not invent. Regen with:
//!
//! ```sh
//! cargo test -p launchly --test delegate_vectors -- --nocapture
//! ```
//!
//! then paste the printed JSON into `test_relay.py` (VECTORS).

use near_crypto::{InMemorySigner, KeyType, Signer};
use near_primitives::action::delegate::{
    DelegateAction, NonDelegateAction, SignedDelegateAction,
};
use near_primitives::action::{Action, FunctionCallAction};
use near_primitives::types::{Balance, Gas};

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

fn signer() -> Signer {
    InMemorySigner::from_seed(
        "alice.testnet".parse().unwrap(),
        KeyType::ED25519,
        "launchly relay vector seed................................",
    )
}

fn build(
    method: &str,
    args: &[u8],
    gas: u64,
    deposit: u128,
    nonce: u64,
) -> SignedDelegateAction {
    let action = NonDelegateAction::try_from(Action::FunctionCall(Box::new(
        FunctionCallAction {
            method_name: method.to_string(),
            args: args.to_vec(),
            gas: Gas::from_gas(gas),
            deposit: Balance::from_yoctonear(deposit),
        },
    )))
    .unwrap();
    let delegate = DelegateAction {
        sender_id: "alice.testnet".parse().unwrap(),
        receiver_id: "launchly.testnet".parse().unwrap(),
        actions: vec![action],
        nonce,
        max_block_height: 19_000_000,
        public_key: signer().public_key(),
    };
    SignedDelegateAction::sign(&signer(), delegate)
}

#[test]
fn print_vectors() {
    // Two-action vector: create + launch in one delegate.
    let multi_actions = [
        ("submit_post", br#"{"url":"https://x.example/p"}"#.as_slice(), 50_000_000_000_000u64, 0u128),
        ("launch_coin", br#"{"product_id":1}"#.as_slice(), 200_000_000_000_000u64, 0u128),
    ]
    .iter()
    .map(|(m, a, g, d)| {
        NonDelegateAction::try_from(Action::FunctionCall(Box::new(
            FunctionCallAction {
                method_name: m.to_string(),
                args: a.to_vec(),
                gas: Gas::from_gas(*g),
                deposit: Balance::from_yoctonear(*d),
            },
        )))
        .unwrap()
    })
    .collect::<Vec<_>>();
    let multi = SignedDelegateAction::sign(
        &signer(),
        DelegateAction {
            sender_id: "alice.testnet".parse().unwrap(),
            receiver_id: "launchly.testnet".parse().unwrap(),
            actions: multi_actions,
            nonce: 9,
            max_block_height: 19_000_000,
            public_key: signer().public_key(),
        },
    );
    assert!(multi.verify(), "multi vector must verify");
    println!(
        "VECTOR multi {{\"borsh_hex\": \"{0}\", \"sender\": \"alice.testnet\", \
         \"receiver\": \"launchly.testnet\", \"methods\": [\"submit_post\", \"launch_coin\"], \
         \"nonce\": 9, \"max_block_height\": 19000000, \
         \"public_key\": \"{1}\"}}",
        hex(&near_primitives::borsh::to_vec(&multi).unwrap()),
        signer().public_key(),
    );
    for (name, method, args, gas, deposit, nonce) in [
        ("create", "create_product", br#"{"name":"Widget"}"#.as_slice(), 100_000_000_000_000u64, 10u128.pow(24), 7u64),
        ("launch", "launch_coin", br#"{"product_id":1}"#.as_slice(), 200_000_000_000_000u64, 0u128, 8u64),
    ] {
        let v = build(method, args, gas, deposit, nonce);
        let borsh = near_primitives::borsh::to_vec(&v).unwrap();
        assert!(v.verify(), "vector must carry a valid signature");
        println!(
            "VECTOR {name} {{\"borsh_hex\": \"{0}\", \"sender\": \"{1}\", \"receiver\": \"{2}\", \
             \"method\": \"{3}\", \"args_hex\": \"{4}\", \"gas\": {5}, \"deposit\": \"{6}\", \
             \"nonce\": {7}, \"max_block_height\": {8}, \"public_key\": \"{9}\"}}",
            hex(&borsh),
            v.delegate_action.sender_id,
            v.delegate_action.receiver_id,
            method,
            hex(args),
            gas,
            deposit,
            v.delegate_action.nonce,
            v.delegate_action.max_block_height,
            v.delegate_action.public_key,
        );
    }
}
