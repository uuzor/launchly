//! Vault end-to-end tests on a local NEAR Sandbox: the real Burrow adapter
//! flow against mock-burrow — gate, deposit, measured gain, sell shortfall
//! with automatic recall, and finalize + claim with the vault active.
//!
//! Run: `cargo test -p launchly --test vault_e2e` (builds all contracts).

use near_api::signer::generate_secret_key;
use near_api::types::transaction::result::TransactionResult;
use near_api::{Account, AccountId, NearGas, NearToken, NetworkConfig, SecretKey, Signer};
use near_sdk::serde_json::json;
use std::sync::Arc;

const YOCTO: NearToken = NearToken::from_yoctonear(1);
const ZERO: NearToken = NearToken::from_yoctonear(0);
const GAS: NearGas = NearGas::from_tgas(200);
const MAX_GAS: NearGas = NearGas::from_tgas(300);

struct User {
    id: AccountId,
    signer: Arc<Signer>,
}

async fn make_user(
    sandbox: &near_sandbox::Sandbox,
    name: &str,
    balance: NearToken,
) -> anyhow::Result<User> {
    let id: AccountId = format!("{name}.sandbox").parse()?;
    let sk = generate_secret_key().map_err(|e| anyhow::anyhow!("{e:?}"))?;
    sandbox
        .create_account(id.clone())
        .initial_balance(balance)
        .public_key(sk.public_key().to_string())
        .send()
        .await?;
    Ok(User {
        id: id.clone(),
        signer: Signer::from_secret_key(sk)?,
    })
}

async fn call_raw(
    net: &NetworkConfig,
    contract_id: &AccountId,
    user: &User,
    method: &str,
    args: serde_json::Value,
    deposit: NearToken,
    gas: NearGas,
) -> anyhow::Result<TransactionResult> {
    let c = Account(contract_id.clone()).as_contract();
    Ok(c.call_function(method, args)
        .transaction()
        .deposit(deposit)
        .gas(gas)
        .with_signer(user.id.clone(), user.signer.clone())
        .send_to(net)
        .await?)
}

async fn call_ok(
    net: &NetworkConfig,
    contract_id: &AccountId,
    user: &User,
    method: &str,
    args: serde_json::Value,
    deposit: NearToken,
    gas: NearGas,
) -> anyhow::Result<()> {
    call_raw(net, contract_id, user, method, args, deposit, gas)
        .await?
        .assert_success();
    Ok(())
}

async fn view<T: serde::de::DeserializeOwned + Send + Sync>(
    net: &NetworkConfig,
    contract_id: &AccountId,
    method: &str,
    args: serde_json::Value,
) -> anyhow::Result<T> {
    let c = Account(contract_id.clone()).as_contract();
    Ok(c.call_function(method, args)
        .read_only()
        .fetch_from(net)
        .await?
        .data)
}

fn js_u128(v: &serde_json::Value) -> u128 {
    if let Some(s) = v.as_str() {
        s.parse().unwrap()
    } else {
        v.as_u64().unwrap() as u128
    }
}

async fn ft_balance(
    net: &NetworkConfig,
    token: &AccountId,
    account: &AccountId,
) -> anyhow::Result<u128> {
    let s: String = view(net, token, "ft_balance_of", json!({"account_id": account})).await?;
    Ok(s.parse()?)
}

async fn register_ft(
    net: &NetworkConfig,
    token: &AccountId,
    user: &User,
) -> anyhow::Result<()> {
    call_ok(
        net,
        token,
        user,
        "storage_deposit",
        json!({}),
        NearToken::from_yoctonear(10_000_000_000_000_000_000_000),
        GAS,
    )
    .await?;
    Ok(())
}

fn ft_metadata(name: &str, symbol: &str, decimals: u8) -> serde_json::Value {
    json!({
        "spec": "ft-1.0.0",
        "name": name,
        "symbol": symbol,
        "icon": null,
        "reference": null,
        "reference_hash": null,
        "decimals": decimals,
    })
}

async fn vault_pos(
    net: &NetworkConfig,
    main_id: &AccountId,
    product_id: u64,
) -> anyhow::Result<serde_json::Value> {
    Ok(view(net, main_id, "get_vault_position", json!({"product_id": product_id})).await?)
}

#[tokio::test]
async fn vault_loop_with_shortfall() -> anyhow::Result<()> {
    // ---- build all three contracts ----
    let main_wasm = std::fs::read(
        cargo_near_build::build_with_cli(Default::default())
            .map_err(|e| anyhow::anyhow!(e.to_string()))?,
    )?;
    let token_wasm_path = cargo_near_build::build_with_cli(
        cargo_near_build::BuildOpts::builder()
            .manifest_path("../launchly-token/Cargo.toml")
            .build(),
    )
    .map_err(|e| anyhow::anyhow!(e.to_string()))?;
    let token_wasm = std::fs::read(token_wasm_path)?;
    let burrow_wasm_path = cargo_near_build::build_with_cli(
        cargo_near_build::BuildOpts::builder()
            .manifest_path("../mock-burrow/Cargo.toml")
            .build(),
    )
    .map_err(|e| anyhow::anyhow!(e.to_string()))?;
    let burrow_wasm = std::fs::read(burrow_wasm_path)?;
    assert!(!main_wasm.is_empty() && !token_wasm.is_empty() && !burrow_wasm.is_empty());

    // ---- sandbox + accounts ----
    let sandbox = near_sandbox::Sandbox::start_sandbox().await?;
    let net = NetworkConfig::from_rpc_url("sandbox", sandbox.rpc_addr.parse()?);
    let genesis_sk: SecretKey =
        near_sandbox::config::DEFAULT_GENESIS_ACCOUNT_PRIVATE_KEY.parse()?;
    let genesis = Signer::from_secret_key(genesis_sk)?;

    let main_id: AccountId = "main.sandbox".parse()?;
    let usdt_id: AccountId = "usdt.sandbox".parse()?;
    let burrow_id: AccountId = "burrow.sandbox".parse()?;
    for id in [&main_id, &usdt_id, &burrow_id] {
        sandbox
            .create_account(id.clone())
            .initial_balance(NearToken::from_near(50))
            .send()
            .await?;
    }
    let owner = make_user(&sandbox, "owner", NearToken::from_near(20)).await?;
    let verifier = make_user(&sandbox, "verifier", NearToken::from_near(10)).await?;
    let founder = make_user(&sandbox, "founder", NearToken::from_near(20)).await?;
    let alice = make_user(&sandbox, "alice", NearToken::from_near(20)).await?;
    let creator = make_user(&sandbox, "creator", NearToken::from_near(20)).await?;
    let usdt_admin = make_user(&sandbox, "usdtadmin", NearToken::from_near(10)).await?;

    // ---- deploy main + mock USDT + mock Burrow ----
    for (id, wasm) in [(&main_id, &main_wasm), (&usdt_id, &token_wasm), (&burrow_id, &burrow_wasm)] {
        near_api::Contract::deploy(id.clone())
            .use_code(wasm.clone())
            .without_init_call()
            .with_signer(genesis.clone())
            .send_to(&net)
            .await?
            .assert_success();
    }
    Account(main_id.clone())
        .as_contract()
        .call_function(
            "new",
            json!({"owner": owner.id, "ops_account": owner.id, "verifier": verifier.id}),
        )
        .transaction()
        .with_signer(main_id.clone(), genesis.clone())
        .send_to(&net)
        .await?
        .assert_success();
    Account(usdt_id.clone())
        .as_contract()
        .call_function(
            "new",
            json!({"minter": usdt_admin.id, "metadata": ft_metadata("Mock USD", "mUSD", 6)}),
        )
        .transaction()
        .with_signer(usdt_id.clone(), genesis.clone())
        .send_to(&net)
        .await?
        .assert_success();
    Account(burrow_id.clone())
        .as_contract()
        .call_function("new", json!({"owner": owner.id, "interest_bps": 500}))
        .transaction()
        .with_signer(burrow_id.clone(), genesis.clone())
        .send_to(&net)
        .await?
        .assert_success();

    // Fund traders with mock USDT ($100k each).
    for u in [&usdt_admin, &founder, &alice, &creator] {
        register_ft(&net, &usdt_id, u).await?;
    }
    for u in [&founder, &alice, &creator] {
        call_ok(
            &net,
            &usdt_id,
            &usdt_admin,
            "mint",
            json!({"account_id": u.id, "amount": "100000000000"}),
            ZERO,
            GAS,
        )
        .await?;
    }

    // ---- vault wiring (default $1,000 gate kept to test it) ----
    call_ok(
        &net,
        &main_id,
        &owner,
        "set_token_wasm",
        json!({"wasm": token_wasm}),
        NearToken::from_near(3),
        MAX_GAS,
    )
    .await?;
    call_ok(&net, &main_id, &owner, "set_vault_burrow", json!({"burrow": burrow_id}), ZERO, GAS).await?;
    call_ok(&net, &main_id, &owner, "set_vault_enabled", json!({"enabled": true}), ZERO, GAS).await?;
    call_ok(
        &net,
        &main_id,
        &owner,
        "vault_register",
        json!({}),
        NearToken::from_yoctonear(100_000_000_000_000_000_000_000),
        MAX_GAS,
    )
    .await?;
    let registered: bool = view(
        &net,
        &burrow_id,
        "is_registered",
        json!({"account_id": main_id}),
    )
    .await?;
    assert!(registered, "main registered on mock burrow");

    // The mock, like real Burrow, must hold USDT storage to receive funds.
    Account(usdt_id.clone())
        .as_contract()
        .call_function("storage_deposit", json!({}))
        .transaction()
        .deposit(NearToken::from_yoctonear(10_000_000_000_000_000_000_000))
        .gas(GAS)
        .with_signer(burrow_id.clone(), genesis.clone())
        .send_to(&net)
        .await?
        .assert_success();

    // Fund mock interest surplus ($2,000) so withdrawals carry gain.
    call_ok(
        &net,
        &usdt_id,
        &usdt_admin,
        "mint",
        json!({"account_id": usdt_admin.id, "amount": "5000000000"}),
        ZERO,
        GAS,
    )
    .await?;
    call_ok(&net, &burrow_id, &usdt_admin, "storage_deposit", json!({}), NearToken::from_yoctonear(10_000_000_000_000_000_000_000), GAS).await?;
    call_ok(
        &net,
        &usdt_id,
        &usdt_admin,
        "ft_transfer_call",
        json!({"receiver_id": burrow_id, "amount": "2000000000", "msg": "Fund"}),
        YOCTO,
        MAX_GAS,
    )
    .await?;

    // ---- create + launch product 1 ----
    call_ok(
        &net,
        &main_id,
        &founder,
        "create_product",
        json!({
            "name": "Vault Product", "symbol": "VAULT",
            "description": "vault e2e product", "demo_url": "https://demo.example",
            "metadata_hash": None::<String>, "rules_hash": None::<String>,
            "reserve_token": usdt_id, "reserve_decimals": 6,
            "fee_bps": 100, "curve_p0": "100", "curve_rise": "9900",
            "min_vote_holding": "1000000000000000000",
            "max_posts_per_creator": 5,
            "cycle_duration_ns": 120_000_000_000u64,
            "dispute_duration_ns": 60_000_000_000u64,
            "milestone_window_ns": 30_000_000_000u64,
            "milestone_deadline_ns": 120_000_000_000u64,
        }),
        NearToken::from_near(1),
        MAX_GAS,
    )
    .await?;
    let launch_cost: String = view(&net, &main_id, "get_launch_cost", json!({})).await?;
    let launch_cost = NearToken::from_yoctonear(launch_cost.parse::<u128>()?);
    call_ok(&net, &main_id, &founder, "launch_coin", json!({"product_id": 1}), launch_cost, MAX_GAS).await?;
    call_ok(&net, &main_id, &founder, "complete_launch", json!({"product_id": 1}), ZERO, MAX_GAS).await?;
    let p1: serde_json::Value = view(&net, &main_id, "get_product", json!({"product_id": 1})).await?;
    assert_eq!(p1["status"], "Live");
    let token1: AccountId = serde_json::from_value(p1["token_account"].clone())?;
    register_ft(&net, &token1, &alice).await?;
    register_ft(&net, &token1, &creator).await?;

    // ---- below the $1,000 gate: rebalance is a noop ----
    call_ok(
        &net,
        &usdt_id,
        &alice,
        "ft_transfer_call",
        json!({
            "receiver_id": main_id, "amount": "500000000",
            "msg": "{\"Buy\":{\"product_id\":1,\"min_tokens_out\":\"1\"}}",
        }),
        YOCTO,
        MAX_GAS,
    )
    .await?;
    call_ok(&net, &main_id, &alice, "vault_rebalance", json!({"product_id": 1}), ZERO, MAX_GAS).await?;
    let pos = vault_pos(&net, &main_id, 1).await?;
    assert_eq!(pos["principal"], "0", "gate blocks small pools");
    assert_eq!(pos["min_start"], "1000000000", "$1,000 default gate");

    // ---- above the gate: rebalance deploys ~70% ----
    call_ok(
        &net,
        &usdt_id,
        &alice,
        "ft_transfer_call",
        json!({
            "receiver_id": main_id, "amount": "5000000000",
            "msg": "{\"Buy\":{\"product_id\":1,\"min_tokens_out\":\"1\"}}",
        }),
        YOCTO,
        MAX_GAS,
    )
    .await?;
    call_ok(&net, &main_id, &alice, "vault_rebalance", json!({"product_id": 1}), ZERO, MAX_GAS).await?;
    let pos = vault_pos(&net, &main_id, 1).await?;
    let principal = js_u128(&pos["principal"]);
    let eligible = js_u128(&pos["eligible"]);
    assert!(eligible > 1_000_000_000, "eligible {eligible} above gate");
    assert!(
        principal > eligible * 65 / 100 && principal <= eligible * 70 / 100,
        "principal {principal} near 70% of eligible {eligible}"
    );
    let mock_supplied: String = view(
        &net,
        &burrow_id,
        "get_supplied",
        json!({"account_id": main_id, "token_id": usdt_id}),
    )
    .await?;
    assert_eq!(
        principal - mock_supplied.parse::<u128>()?,
        1,
        "burrow holds it minus 1-unit spread"
    );

    // Simulated yield stays off while principal is deployed.
    let pool_before: serde_json::Value =
        view(&net, &main_id, "get_pool", json!({"product_id": 1, "cycle_id": 1})).await?;
    sandbox.fast_forward(20).await?;
    call_ok(&net, &main_id, &alice, "accrue_yield", json!({"product_id": 1}), ZERO, GAS).await?;
    let pool_after: serde_json::Value =
        view(&net, &main_id, "get_pool", json!({"product_id": 1, "cycle_id": 1})).await?;
    assert_eq!(pool_before["balance"], pool_after["balance"], "simulated gated");

    // ---- full manual withdraw: measured gain credits the pool ----
    let pool_pre_wd = js_u128(&pool_after["balance"]);
    call_ok(&net, &main_id, &alice, "vault_withdraw", json!({"product_id": 1, "amount": null}), ZERO, MAX_GAS).await?;
    let pos = vault_pos(&net, &main_id, 1).await?;
    assert_eq!(pos["principal"], "0");
    assert_eq!(pos["busy"], false);
    let pool_wd: serde_json::Value =
        view(&net, &main_id, "get_pool", json!({"product_id": 1, "cycle_id": 1})).await?;
    let gain = js_u128(&pool_wd["balance"]) - pool_pre_wd;
    // 5% of ~$3.8k principal ≈ $190 of gain.
    assert!(gain > 100_000_000, "gain {gain} proves measured yield");
    let mock_supplied: String = view(
        &net,
        &burrow_id,
        "get_supplied",
        json!({"account_id": main_id, "token_id": usdt_id}),
    )
    .await?;
    assert_eq!(mock_supplied, "0");

    // ---- explicit-principal withdraw normalizes to full (regression) ----
    // Real Burrow refuses a partial for exactly-principal (share dust), so
    // the adapter must send amount=null. The strict mock would panic
    // otherwise; success here proves the normalization.
    call_ok(&net, &main_id, &alice, "vault_rebalance", json!({"product_id": 1}), ZERO, MAX_GAS).await?;
    let pos = vault_pos(&net, &main_id, 1).await?;
    let p = js_u128(&pos["principal"]);
    assert!(p > 0);
    call_ok(&net, &main_id, &alice, "vault_withdraw", json!({"product_id": 1, "amount": p.to_string()}), ZERO, MAX_GAS).await?;
    let pos = vault_pos(&net, &main_id, 1).await?;
    assert_eq!(pos["principal"], "0");
    assert_eq!(pos["busy"], false);

    // ---- sell shortfall: queue + automatic recall ----
    // Re-deploy, then sell everything: the net payout exceeds liquid (~30%).
    call_ok(&net, &main_id, &alice, "vault_rebalance", json!({"product_id": 1}), ZERO, MAX_GAS).await?;
    let pos = vault_pos(&net, &main_id, 1).await?;
    assert!(js_u128(&pos["principal"]) > 0);
    let alice_tokens = ft_balance(&net, &token1, &alice.id).await?;
    assert!(alice_tokens > 0);
    let alice_usdt_pre_sell = ft_balance(&net, &usdt_id, &alice.id).await?;
    call_ok(
        &net,
        &token1,
        &alice,
        "ft_transfer_call",
        json!({
            "receiver_id": main_id,
            "amount": alice_tokens.to_string(),
            "msg": "{\"Sell\":{\"product_id\":1,\"min_reserve_out\":\"0\"}}",
        }),
        YOCTO,
        MAX_GAS,
    )
    .await?;
    // Tokens burned, payout queued, nothing paid yet.
    assert_eq!(ft_balance(&net, &token1, &alice.id).await?, 0);
    let pos = vault_pos(&net, &main_id, 1).await?;
    assert_eq!(pos["pending_count"], 1);
    assert!(js_u128(&pos["recall"]) > 0);
    assert_eq!(
        ft_balance(&net, &usdt_id, &alice.id).await?,
        alice_usdt_pre_sell
    );
    // Keeper rebalance recalls and auto-pays the head of the queue.
    call_ok(&net, &main_id, &alice, "vault_rebalance", json!({"product_id": 1}), ZERO, MAX_GAS).await?;
    let pos = vault_pos(&net, &main_id, 1).await?;
    assert_eq!(pos["pending_count"], 0);
    assert_eq!(pos["recall"], "0");
    assert_eq!(pos["busy"], false);
    let alice_usdt_post = ft_balance(&net, &usdt_id, &alice.id).await?;
    assert!(
        alice_usdt_post > alice_usdt_pre_sell + 4_000_000_000,
        "alice paid ~$5.4k, got {}",
        (alice_usdt_post - alice_usdt_pre_sell) / 1_000_000
    );

    // ---- rebuy + finalize + claim with the vault active ----
    call_ok(
        &net,
        &usdt_id,
        &alice,
        "ft_transfer_call",
        json!({
            "receiver_id": main_id, "amount": "5000000000",
            "msg": "{\"Buy\":{\"product_id\":1,\"min_tokens_out\":\"1\"}}",
        }),
        YOCTO,
        MAX_GAS,
    )
    .await?;
    call_ok(&net, &main_id, &alice, "vault_rebalance", json!({"product_id": 1}), ZERO, MAX_GAS).await?;
    let pos = vault_pos(&net, &main_id, 1).await?;
    assert!(js_u128(&pos["principal"]) > 0, "deployed again");
    call_ok(
        &net,
        &main_id,
        &creator,
        "submit_post",
        json!({"product_id": 1, "url": "https://x.com/creator/status/1", "linked_account": "@creator"}),
        NearToken::from_near(1),
        MAX_GAS,
    )
    .await?;
    call_ok(&net, &main_id, &verifier, "attest_post", json!({"post_id": 1, "valid": true, "score": 100, "post_hash": "vault-e2e-hash"}), ZERO, GAS).await?;
    call_ok(&net, &main_id, &verifier, "confirm_liveness", json!({"product_id": 1, "cycle_id": 1, "confirmations": [{"post_id": 1, "live": true}]}), ZERO, MAX_GAS).await?;

    let mut finalized = false;
    for _ in 0..150 {
        let r = call_raw(&net, &main_id, &alice, "finalize_cycle", json!({"product_id": 1}), ZERO, MAX_GAS).await?;
        if matches!(r, TransactionResult::Full(f) if f.is_success()) {
            finalized = true;
            break;
        }
        sandbox.fast_forward(20).await?;
    }
    assert!(finalized, "cycle never finalized");
    let payout: String = view(
        &net,
        &main_id,
        "get_payout",
        json!({"product_id": 1, "cycle_id": 1, "creator": creator.id}),
    )
    .await?;
    assert!(payout.parse::<u128>()? > 0);
    // Common path: liquid covered the payout, principal untouched.
    let pos = vault_pos(&net, &main_id, 1).await?;
    assert!(js_u128(&pos["principal"]) > 0);

    let creator_usdt_before = ft_balance(&net, &usdt_id, &creator.id).await?;
    let mut claimed = false;
    for _ in 0..150 {
        let r = call_raw(&net, &main_id, &creator, "claim_payout", json!({"product_id": 1, "cycle_id": 1}), ZERO, MAX_GAS).await?;
        if matches!(r, TransactionResult::Full(f) if f.is_success()) {
            claimed = true;
            break;
        }
        sandbox.fast_forward(20).await?;
    }
    assert!(claimed, "claim never succeeded with vault active");
    assert!(ft_balance(&net, &usdt_id, &creator.id).await? > creator_usdt_before);

    Ok(())
}
