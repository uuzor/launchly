//! End-to-end tests on a local NEAR Sandbox: the full Launchly loop with
//! real cross-contract calls, real time-gated cycles, and real failure paths.
//!
//! Run: `cargo test -p launchly --test e2e` (builds both contracts first).

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

/// Parse a u128 from a view result that may encode it as a JSON number
/// (raw u128 fields) or string (U128 newtype).
fn js_u128(v: &serde_json::Value) -> u128 {
    if let Some(s) = v.as_str() {
        s.parse().unwrap()
    } else {
        v.as_u64().unwrap() as u128
    }
}

fn succeeded(out: &TransactionResult) -> bool {
    match out {
        TransactionResult::Full(f) => f.is_success(),
        TransactionResult::Pending { .. } => false,
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

#[tokio::test]
async fn full_loop_release_path() -> anyhow::Result<()> {
    // ---- build both contracts ----
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
    assert!(!main_wasm.is_empty() && !token_wasm.is_empty());

    // ---- sandbox + accounts ----
    let sandbox = near_sandbox::Sandbox::start_sandbox().await?;
    let net = NetworkConfig::from_rpc_url("sandbox", sandbox.rpc_addr.parse()?);
    let genesis_sk: SecretKey =
        near_sandbox::config::DEFAULT_GENESIS_ACCOUNT_PRIVATE_KEY.parse()?;
    let genesis = Signer::from_secret_key(genesis_sk)?;

    let main_id: AccountId = "main.sandbox".parse()?;
    let usdt_id: AccountId = "usdt.sandbox".parse()?;
    for id in [&main_id, &usdt_id] {
        sandbox
            .create_account(id.clone())
            .initial_balance(NearToken::from_near(50))
            .send()
            .await?;
    }
    let owner = make_user(&sandbox, "owner", NearToken::from_near(20)).await?;
    let ops = make_user(&sandbox, "ops", NearToken::from_near(10)).await?;
    let verifier = make_user(&sandbox, "verifier", NearToken::from_near(10)).await?;
    let founder = make_user(&sandbox, "founder", NearToken::from_near(20)).await?;
    let alice = make_user(&sandbox, "alice", NearToken::from_near(20)).await?;
    let bob = make_user(&sandbox, "bob", NearToken::from_near(20)).await?;
    let creator = make_user(&sandbox, "creator", NearToken::from_near(20)).await?;
    let usdt_admin = make_user(&sandbox, "usdtadmin", NearToken::from_near(10)).await?;

    // ---- deploy main + mock USDT ----
    near_api::Contract::deploy(main_id.clone())
        .use_code(main_wasm)
        .without_init_call()
        .with_signer(genesis.clone())
        .send_to(&net)
        .await?
        .assert_success();
    near_api::Contract::deploy(usdt_id.clone())
        .use_code(token_wasm.clone())
        .without_init_call()
        .with_signer(genesis.clone())
        .send_to(&net)
        .await?
        .assert_success();

    let main = Account(main_id.clone()).as_contract();
    main.call_function(
        "new",
        json!({"owner": owner.id, "ops_account": ops.id, "verifier": verifier.id}),
    )
    .transaction()
    .with_signer(main_id.clone(), genesis.clone())
    .send_to(&net)
    .await?
    .assert_success();
    let usdt = Account(usdt_id.clone()).as_contract();
    usdt.call_function(
        "new",
        json!({"minter": usdt_admin.id, "metadata": ft_metadata("Mock USD", "mUSD", 6)}),
    )
    .transaction()
    .with_signer(usdt_id.clone(), genesis.clone())
    .send_to(&net)
    .await?
    .assert_success();

    // Fund everyone with mock USDT.
    for u in [&usdt_admin, &founder, &alice, &bob, &creator] {
        register_ft(&net, &usdt_id, u).await?;
    }
    for u in [&founder, &alice, &bob, &creator] {
        call_ok(
            &net,
            &usdt_id,
            &usdt_admin,
            "mint",
            json!({"account_id": u.id, "amount": "100000000"}),
            NearToken::from_yoctonear(0),
            GAS,
        )
        .await?;
    }
    assert_eq!(ft_balance(&net, &usdt_id, &alice.id).await?, 100_000_000);

    // ---- store token wasm, create + launch product ----
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
    let cfg: serde_json::Value = view(&net, &main_id, "get_config", json!({})).await?;
    assert!(cfg["token_wasm_bytes"].as_u64().unwrap() > 100_000);

    call_ok(
        &net,
        &main_id,
        &founder,
        "create_product",
        json!({
            "name": "Demo Product", "symbol": "DEMO",
            "description": "e2e product", "demo_url": "https://demo.example",
            "metadata_hash": "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef", "rules_hash": "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
            "reserve_token": usdt_id, "reserve_decimals": 6,
            "fee_bps": 100, "curve_p0": "100", "curve_rise": "9900",
            "min_vote_holding": "1000000000000000000",
            "max_posts_per_creator": 5,
            "cycle_duration_ns": 30_000_000_000u64,
            "dispute_duration_ns": 15_000_000_000u64,
            "milestone_window_ns": 30_000_000_000u64,
            "milestone_deadline_ns": 120_000_000_000u64,
        }),
        NearToken::from_near(1),
        MAX_GAS,
    )
    .await?;
    let launch_cost: String = view(&net, &main_id, "get_launch_cost", json!({})).await?;
    let launch_cost = NearToken::from_yoctonear(launch_cost.parse::<u128>()?);
    assert!(launch_cost.as_yoctonear() > 1_000_000_000_000_000_000_000);
    call_ok(
        &net,
        &main_id,
        &founder,
        "launch_coin",
        json!({"product_id": 1}),
        launch_cost,
        MAX_GAS,
    )
    .await?;
    call_ok(
        &net,
        &main_id,
        &founder,
        "complete_launch",
        json!({"product_id": 1}),
        NearToken::from_yoctonear(0),
        MAX_GAS,
    )
    .await?;
    let p1: serde_json::Value = view(&net, &main_id, "get_product", json!({"product_id": 1})).await?;
    assert_eq!(p1["status"], "Live");
    assert_eq!(p1["metadata_hash"], "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef");
    assert_eq!(p1["rules_hash"], "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef");
    let token1: AccountId = serde_json::from_value(p1["token_account"].clone())?;
    assert_eq!(token1.to_string(), "p1.main.sandbox");

    // ---- quotes + buy ----
    let quote: (String, String, String) = view(
        &net,
        &main_id,
        "get_buy_quote",
        json!({"product_id": 1, "reserve_in": "100000"}),
    )
    .await?;
    assert_eq!(quote.2, "1000"); // 1% fee
    assert!(quote.0.parse::<u128>()? > 0);

    register_ft(&net, &token1, &alice).await?;
    let alice_usdt_before = ft_balance(&net, &usdt_id, &alice.id).await?;
    call_ok(
        &net,
        &usdt_id,
        &alice,
        "ft_transfer_call",
        json!({
            "receiver_id": main_id, "amount": "100000", "msg": "{\"Buy\":{\"product_id\":1,\"min_tokens_out\":\"1\"}}",
        }),
        YOCTO,
        MAX_GAS,
    )
    .await?;
    let alice_tokens = ft_balance(&net, &token1, &alice.id).await?;
    assert!(alice_tokens > 0, "alice got product tokens");
    assert_eq!(
        ft_balance(&net, &usdt_id, &alice.id).await?,
        alice_usdt_before - 100_000,
        "full reserve taken on success"
    );
    let pool: serde_json::Value =
        view(&net, &main_id, "get_pool", json!({"product_id": 1, "cycle_id": 1})).await?;
    assert!(js_u128(&pool["balance"]) >= 700);

    // ---- unregistered buyer is fully refunded ----
    let sold_before: serde_json::Value =
        view(&net, &main_id, "get_product", json!({"product_id": 1})).await?;
    let bob_usdt_before = ft_balance(&net, &usdt_id, &bob.id).await?;
    call_ok(
        &net,
        &usdt_id,
        &bob,
        "ft_transfer_call",
        json!({
            "receiver_id": main_id, "amount": "50000", "msg": "{\"Buy\":{\"product_id\":1,\"min_tokens_out\":\"1\"}}",
        }),
        YOCTO,
        MAX_GAS,
    )
    .await?;
    assert_eq!(ft_balance(&net, &usdt_id, &bob.id).await?, bob_usdt_before);
    let sold_after: serde_json::Value =
        view(&net, &main_id, "get_product", json!({"product_id": 1})).await?;
    assert_eq!(sold_before["curve_sold"], sold_after["curve_sold"]);

    // ---- sell half ----
    let sell_amt = alice_tokens / 2;
    let alice_usdt_before_sell = ft_balance(&net, &usdt_id, &alice.id).await?;
    call_ok(
        &net,
        &token1,
        &alice,
        "ft_transfer_call",
        json!({
            "receiver_id": main_id,
            "amount": sell_amt.to_string(),
            "msg": "{\"Sell\":{\"product_id\":1,\"min_reserve_out\":\"0\"}}",
        }),
        YOCTO,
        MAX_GAS,
    )
    .await?;
    assert!(ft_balance(&net, &usdt_id, &alice.id).await? > alice_usdt_before_sell);
    assert_eq!(
        ft_balance(&net, &token1, &alice.id).await?,
        alice_tokens - sell_amt
    );

    // ---- pause blocks trading, unpause restores ----
    // (NEP-141 refunds via ft_resolve_transfer, so the tx succeeds at top
    // level while the receiver panics: assert balances, not tx status.)
    call_ok(&net, &main_id, &owner, "pause", json!({"paused": true}), ZERO, GAS).await?;
    let usdt_before_pause = ft_balance(&net, &usdt_id, &alice.id).await?;
    let tokens_before_pause = ft_balance(&net, &token1, &alice.id).await?;
    call_ok(
        &net,
        &usdt_id,
        &alice,
        "ft_transfer_call",
        json!({
            "receiver_id": main_id, "amount": "1000", "msg": "{\"Buy\":{\"product_id\":1,\"min_tokens_out\":\"1\"}}",
        }),
        YOCTO,
        MAX_GAS,
    )
    .await?;
    assert_eq!(ft_balance(&net, &usdt_id, &alice.id).await?, usdt_before_pause);
    assert_eq!(
        ft_balance(&net, &token1, &alice.id).await?,
        tokens_before_pause
    );
    call_ok(&net, &main_id, &owner, "pause", json!({"paused": false}), ZERO, GAS).await?;

    // ---- posts: submit, approve, rate ----
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
    let posts: serde_json::Value =
        view(&net, &main_id, "list_cycle_posts", json!({"product_id": 1, "cycle_id": 1})).await?;
    let post_id = posts[0]["creator"].as_str().unwrap();
    assert_eq!(post_id, creator.id.to_string());
    // post id is the nonce: fetch via get_post(1)
    let post: serde_json::Value = view(&net, &main_id, "get_post", json!({"post_id": 1})).await?;
    assert_eq!(post["approved"], false);
    call_ok(&net, &main_id, &verifier, "attest_post", json!({"post_id": 1, "valid": true, "score": 100, "post_hash": "e2e-content-hash"}), ZERO, GAS).await?;
    call_ok(&net, &main_id, &alice, "rate_post", json!({"post_id": 1, "score": 5}), ZERO, MAX_GAS).await?;
    // Bob holds no product tokens: his rating is ignored on-chain.
    call_ok(&net, &main_id, &bob, "rate_post", json!({"post_id": 1, "score": 1}), ZERO, MAX_GAS).await?;
    let post: serde_json::Value = view(&net, &main_id, "get_post", json!({"post_id": 1})).await?;
    assert_eq!(post["rating_count"], 1);
    assert_eq!(post["rating_sum"], 5);
    // Phase 2: verifier confirms the post is still live before close.
    call_ok(&net, &main_id, &verifier, "confirm_liveness", json!({"product_id": 1, "cycle_id": 1, "confirmations": [{"post_id": 1, "live": true}]}), ZERO, MAX_GAS).await?;

    // ---- simulated yield accrues without error ----
    call_ok(&net, &main_id, &alice, "accrue_yield", json!({"product_id": 1}), ZERO, GAS).await?;

    // ---- finalize cycle after time passes ----
    let mut finalized = false;
    for _ in 0..60 {
        let r = call_raw(&net, &main_id, &alice, "finalize_cycle", json!({"product_id": 1}), ZERO, MAX_GAS).await?;
        if succeeded(&r) {
            finalized = true;
            break;
        }
        sandbox.fast_forward(30).await?;
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

    // Claim during dispute window must fail; after it, succeed.
    let early = call_raw(&net, &main_id, &creator, "claim_payout", json!({"product_id": 1, "cycle_id": 1}), ZERO, MAX_GAS).await?;
    assert!(!succeeded(&early), "claim must fail during dispute window");
    let creator_usdt_before = ft_balance(&net, &usdt_id, &creator.id).await?;
    let mut claimed = false;
    for _ in 0..60 {
        let r = call_raw(&net, &main_id, &creator, "claim_payout", json!({"product_id": 1, "cycle_id": 1}), ZERO, MAX_GAS).await?;
        if succeeded(&r) {
            claimed = true;
            break;
        }
        sandbox.fast_forward(30).await?;
    }
    assert!(claimed, "claim never succeeded");
    assert!(ft_balance(&net, &usdt_id, &creator.id).await? > creator_usdt_before);
    // Double claim fails.
    let dbl = call_raw(&net, &main_id, &creator, "claim_payout", json!({"product_id": 1, "cycle_id": 1}), ZERO, MAX_GAS).await?;
    assert!(!succeeded(&dbl));

    // ---- milestone: publish, approve-vote, release ----
    call_ok(
        &net,
        &main_id,
        &founder,
        "publish_milestone",
        json!({"product_id": 1, "evidence_url": "https://demo.example/v2", "evidence_hash": "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"}),
        NearToken::from_near(1),
        MAX_GAS,
    )
    .await?;
    // Lock-to-vote: alice locks her full balance (capped at 5% weight,
    // excess refunded) via ft_transfer_call.
    let alice_tokens_before = ft_balance(&net, &token1, &alice.id).await?;
    assert!(alice_tokens_before > 0);
    call_ok(
        &net,
        &token1,
        &alice,
        "ft_transfer_call",
        json!({
            "receiver_id": main_id, "amount": alice_tokens_before.to_string(),
            "msg": "{\"Vote\":{\"product_id\":1,\"index\":0,\"approve\":true}}",
        }),
        YOCTO,
        MAX_GAS,
    )
    .await?;
    let mut released = false;
    for _ in 0..60 {
        let r = call_raw(&net, &main_id, &alice, "finalize_milestone", json!({"product_id": 1, "index": 0}), ZERO, MAX_GAS).await?;
        if succeeded(&r) {
            released = true;
            break;
        }
        sandbox.fast_forward(30).await?;
    }
    assert!(released, "milestone never finalized");
    let ms: serde_json::Value =
        view(&net, &main_id, "get_milestone", json!({"product_id": 1, "index": 0})).await?;
    assert_eq!(ms["released"], true);
    assert_eq!(ms["evidence_hash"], "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef");
    // One tranche = 25% of the 10% founder allocation = 2.5% of supply.
    assert_eq!(
        ft_balance(&net, &token1, &founder.id).await?,
        25_000_000_000_000_000_000_000_000u128
    );
    // Unlock returns the locked vote tokens in full.
    call_ok(&net, &main_id, &alice, "unlock_vote", json!({"product_id": 1, "index": 0}), ZERO, MAX_GAS).await?;
    assert_eq!(ft_balance(&net, &token1, &alice.id).await?, alice_tokens_before);

    // ---- fee claims: ops 20% and founder 10% shares ----
    // Ops is not registered on USDT yet: the claim restores instead of losing.
    call_ok(&net, &main_id, &ops, "claim", json!({"token_id": usdt_id}), ZERO, MAX_GAS).await?;
    assert_eq!(ft_balance(&net, &usdt_id, &ops.id).await?, 0);
    let still_there: String = view(
        &net,
        &main_id,
        "get_claimable",
        json!({"token_id": usdt_id, "account": ops.id}),
    )
    .await?;
    assert!(still_there.parse::<u128>()? > 0);
    register_ft(&net, &usdt_id, &ops).await?;
    call_ok(&net, &main_id, &ops, "claim", json!({"token_id": usdt_id}), ZERO, MAX_GAS).await?;
    assert!(ft_balance(&net, &usdt_id, &ops.id).await? > 0);
    let founder_usdt_before = ft_balance(&net, &usdt_id, &founder.id).await?;
    call_ok(&net, &main_id, &founder, "claim", json!({"token_id": usdt_id}), ZERO, MAX_GAS).await?;
    assert!(ft_balance(&net, &usdt_id, &founder.id).await? > founder_usdt_before);

    // ---- product 2: veto + burn path ----
    call_ok(
        &net,
        &main_id,
        &founder,
        "create_product",
        json!({
            "name": "Second Product", "symbol": "TWO",
            "description": "e2e veto product", "demo_url": "https://demo.example",
            "metadata_hash": None::<String>, "rules_hash": None::<String>,
            "reserve_token": usdt_id, "reserve_decimals": 6,
            "fee_bps": 100, "curve_p0": "100", "curve_rise": "9900",
            "min_vote_holding": "1000000000000000000",
            "max_posts_per_creator": 5,
            "cycle_duration_ns": 30_000_000_000u64,
            "dispute_duration_ns": 15_000_000_000u64,
            "milestone_window_ns": 30_000_000_000u64,
            "milestone_deadline_ns": 120_000_000_000u64,
        }),
        NearToken::from_near(1),
        MAX_GAS,
    )
    .await?;
    call_ok(
        &net,
        &main_id,
        &founder,
        "launch_coin",
        json!({"product_id": 2}),
        launch_cost,
        MAX_GAS,
    )
    .await?;
    call_ok(
        &net,
        &main_id,
        &founder,
        "complete_launch",
        json!({"product_id": 2}),
        NearToken::from_yoctonear(0),
        MAX_GAS,
    )
    .await?;
    let p2: serde_json::Value = view(&net, &main_id, "get_product", json!({"product_id": 2})).await?;
    assert_eq!(p2["status"], "Live");
    assert!(p2["metadata_hash"].is_null());
    assert!(p2["rules_hash"].is_null());
    let token2: AccountId = serde_json::from_value(p2["token_account"].clone())?;

    // Three holders buy in, then all vote REJECT (5%-capped weights need
    // at least two wallets to reach the 10% veto quorum).
    for u in [&alice, &bob, &creator] {
        register_ft(&net, &token2, u).await?;
        call_ok(
            &net,
            &usdt_id,
            u,
            "ft_transfer_call",
            json!({
                "receiver_id": main_id, "amount": "5000000",
                "msg": "{\"Buy\":{\"product_id\":2,\"min_tokens_out\":\"1\"}}",
            }),
            YOCTO,
            MAX_GAS,
        )
        .await?;
        assert!(ft_balance(&net, &token2, &u.id).await? > 0);
    }
    call_ok(
        &net,
        &main_id,
        &founder,
        "publish_milestone",
        json!({"product_id": 2, "evidence_url": "https://demo.example/vapor", "evidence_hash": null}),
        NearToken::from_near(1),
        MAX_GAS,
    )
    .await?;
    // All three lock full balances as REJECT votes (each capped at 5%).
    let mut pre_vote: Vec<u128> = vec![];
    for u in [&alice, &bob, &creator] {
        let bal = ft_balance(&net, &token2, &u.id).await?;
        pre_vote.push(bal);
        call_ok(
            &net,
            &token2,
            u,
            "ft_transfer_call",
            json!({
                "receiver_id": main_id, "amount": bal.to_string(),
                "msg": "{\"Vote\":{\"product_id\":2,\"index\":0,\"approve\":false}}",
            }),
            YOCTO,
            MAX_GAS,
        )
        .await?;
    }
    let mut settled = false;
    for _ in 0..60 {
        let r = call_raw(&net, &main_id, &alice, "finalize_milestone", json!({"product_id": 2, "index": 0}), ZERO, MAX_GAS).await?;
        if succeeded(&r) {
            settled = true;
            break;
        }
        sandbox.fast_forward(30).await?;
    }
    assert!(settled, "vetoed milestone never finalized");
    let ms2: serde_json::Value =
        view(&net, &main_id, "get_milestone", json!({"product_id": 2, "index": 0})).await?;
    assert_eq!(ms2["finalized"], true);
    assert!(ms2["evidence_hash"].is_null());
    assert_eq!(ms2["released"], false, "veto must block the tranche");
    assert_eq!(ft_balance(&net, &token2, &founder.id).await?, 0);
    // Veto voters unlock in full even though the tranche is blocked.
    for (u, before) in [&alice, &bob, &creator].into_iter().zip(pre_vote) {
        call_ok(&net, &main_id, u, "unlock_vote", json!({"product_id": 2, "index": 0}), ZERO, MAX_GAS).await?;
        assert_eq!(ft_balance(&net, &token2, &u.id).await?, before);
    }

    // After the burn deadline the vetoed tranche is destroyed, not unlocked.
    let mut burned = false;
    for _ in 0..120 {
        let r = call_raw(&net, &main_id, &alice, "burn_unclaimed_tranche", json!({"product_id": 2, "index": 0}), ZERO, MAX_GAS).await?;
        if succeeded(&r) {
            burned = true;
            break;
        }
        sandbox.fast_forward(30).await?;
    }
    assert!(burned, "tranche never burned");
    let ms2: serde_json::Value =
        view(&net, &main_id, "get_milestone", json!({"product_id": 2, "index": 0})).await?;
    assert_eq!(ms2["burned"], true);

    // ---- final sanity: registry + quotes ----
    let products: serde_json::Value =
        view(&net, &main_id, "list_products", json!({"from_index": 0, "limit": 10})).await?;
    assert_eq!(products.as_array().unwrap().len(), 2);
    let sq: (String, String) = view(
        &net,
        &main_id,
        "get_sell_quote",
        json!({"product_id": 1, "tokens_in": "1000000000000000000"}),
    )
    .await?;
    assert!(sq.0.parse::<u128>()? > 0);

    Ok(())
}
