// Wallet-signed Launchly executions. Each builder returns wallet-selector v10
// transactions: [{ receiverId, actions: [NAJAction] }] using near-api-js
// action instances (plain {type, params} objects are rejected).
// Deposits/gas mirror the proven sim sequences (intents/sim_demo.py).
import { transactions } from "near-api-js";
import { CONTRACT_ID, GAS_300, ONE_YOCTO, STORAGE_DEPOSIT, YOCTO } from "./wallet";

const encodeArgs = (args) =>
  args instanceof Uint8Array ? args : new TextEncoder().encode(JSON.stringify(args));

const call = (methodName, args, { gas = GAS_300, deposit = "0" } = {}) =>
  transactions.functionCall(methodName, encodeArgs(args), BigInt(gas), BigInt(deposit));

const tx = (receiverId, ...actions) => ({ receiverId, actions });

// ---- token registration (idempotent: check storage_balance_of first) ----
export const storageDepositTx = (tokenId, accountId) =>
  tx(tokenId, call("storage_deposit", { account_id: accountId }, { deposit: STORAGE_DEPOSIT }));

// ---- bonding curve (NEP-141 ft_transfer_call into launchly) ----
export const buyTx = (usdtId, amountBase, productId, minTokensOut = "1") =>
  tx(
    usdtId,
    call(
      "ft_transfer_call",
      {
        receiver_id: CONTRACT_ID,
        amount: String(amountBase),
        msg: JSON.stringify({ Buy: { product_id: Number(productId), min_tokens_out: String(minTokensOut) } }),
      },
      { deposit: ONE_YOCTO }
    )
  );

export const sellTx = (tokenId, amountBase, productId, minReserveOut = "1") =>
  tx(
    tokenId,
    call(
      "ft_transfer_call",
      {
        receiver_id: CONTRACT_ID,
        amount: String(amountBase),
        msg: JSON.stringify({ Sell: { product_id: Number(productId), min_reserve_out: String(minReserveOut) } }),
      },
      { deposit: ONE_YOCTO }
    )
  );

// ---- milestone votes: lock-to-vote, weight = attached tokens ----
export const voteTx = (tokenId, productId, index, approve, weightBase) =>
  tx(
    tokenId,
    call(
      "ft_transfer_call",
      {
        receiver_id: CONTRACT_ID,
        amount: String(weightBase),
        msg: JSON.stringify({ Vote: { product_id: Number(productId), index: Number(index), approve: !!approve } }),
      },
      { deposit: ONE_YOCTO }
    )
  );

// ---- creator + founder direct calls ----
export const submitPostTx = (productId, url, linkedAccount) =>
  tx(
    CONTRACT_ID,
    call(
      "submit_post",
      { product_id: Number(productId), url, linked_account: linkedAccount },
      { deposit: (YOCTO / 100n).toString() } // 0.01 NEAR storage, excess refunded
    )
  );

export const claimTx = (productId, cycleId) =>
  tx(CONTRACT_ID, call("claim_payout", { product_id: Number(productId), cycle_id: Number(cycleId) }));

export const ratePostTx = (postId, score) =>
  tx(CONTRACT_ID, call("rate_post", { post_id: Number(postId), score: Number(score) }));

export const createProductTx = (args) =>
  tx(
    CONTRACT_ID,
    call(
      "create_product",
      {
        name: args.name,
        symbol: args.symbol,
        description: args.description,
        demo_url: args.demo_url,
        metadata_hash: args.metadata_hash ?? null,
        rules_hash: args.rules_hash ?? null,
        reserve_token: args.reserve_token,
        reserve_decimals: args.reserve_decimals,
        fee_bps: args.fee_bps,
        curve_p0: String(args.curve_p0),
        curve_rise: String(args.curve_rise),
        min_vote_holding: String(args.min_vote_holding),
        max_posts_per_creator: args.max_posts_per_creator,
        // u64 (not U128): JSON numbers. Durations fit safely (< 2^53).
        cycle_duration_ns: Number(args.cycle_duration_ns),
        dispute_duration_ns: Number(args.dispute_duration_ns),
        milestone_window_ns: Number(args.milestone_window_ns),
        milestone_deadline_ns: Number(args.milestone_deadline_ns),
      },
      { deposit: (YOCTO / 20n).toString() } // 0.05 NEAR storage, excess refunded
    )
  );

export const launchCoinTx = (productId, launchCostYocto) =>
  tx(
    CONTRACT_ID,
    call("launch_coin", { product_id: Number(productId) }, { deposit: String(launchCostYocto) })
  );

export const completeLaunchTx = (productId) =>
  tx(CONTRACT_ID, call("complete_launch", { product_id: Number(productId) }));

export const publishMilestoneTx = (productId, evidenceUrl, evidenceHash = null) =>
  tx(
    CONTRACT_ID,
    call(
      "publish_milestone",
      { product_id: Number(productId), evidence_url: evidenceUrl, evidence_hash: evidenceHash },
      { deposit: (YOCTO / 100n).toString() } // 0.01 NEAR storage, excess refunded
    )
  );

export function txHash(outcome) {
  return outcome?.transaction?.hash ?? outcome?.transaction_outcome?.id ?? null;
}

export function explorerTxUrl(hash, network = "testnet") {
  return `https://explorer.${network === "testnet" ? "testnet." : ""}near.org/transactions/${hash}`;
}
