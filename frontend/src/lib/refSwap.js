// Testnet USDT onboarding: wrap NEAR and swap for usdt.fakes.testnet on Ref.
// Pool 34 (wrap.testnet <> usdt.fakes.testnet) is deep on testnet. Pure
// wallet-signed flow — the backend never touches these funds.
import { transactions } from "near-api-js";
import { GAS_300, ONE_YOCTO, YOCTO, rpcView } from "./wallet";

export const WNEAR_ID = "wrap.testnet";
export const REF_ID = "ref-finance-101.testnet";
export const USDT_ID = "usdt.fakes.testnet";
export const REF_POOL_ID = 34;

const encodeArgs = (args) =>
  args instanceof Uint8Array ? args : new TextEncoder().encode(JSON.stringify(args));

const call = (methodName, args, { gas = GAS_300, deposit = "0" } = {}) =>
  transactions.functionCall(methodName, encodeArgs(args), BigInt(gas), BigInt(deposit));

const tx = (receiverId, ...actions) => ({ receiverId, actions });

export const wrapNearTx = (nearBase) =>
  tx(WNEAR_ID, call("near_deposit", {}, { deposit: String(nearBase) }));

export const refSwapTx = (wnearBase, minUsdtOut = "1") =>
  tx(
    WNEAR_ID,
    call(
      "ft_transfer_call",
      {
        receiver_id: REF_ID,
        amount: String(wnearBase),
        msg: JSON.stringify({
          force: 0,
          actions: [
            {
              pool_id: REF_POOL_ID,
              token_in: WNEAR_ID,
              token_out: USDT_ID,
              amount_in: String(wnearBase),
              min_amount_out: String(minUsdtOut),
            },
          ],
        }),
      },
      { deposit: ONE_YOCTO }
    )
  );

/** Expected USDT base units for wNEAR base in (Ref get_return view). */
export async function refQuoteOut(wnearBase) {
  const out = await rpcView(REF_ID, "get_return", {
    pool_id: REF_POOL_ID,
    token_in: WNEAR_ID,
    token_out: USDT_ID,
    amount_in: String(wnearBase),
  });
  return BigInt(out ?? "0");
}

export function nearToBase(nearFloat) {
  return (BigInt(Math.round(nearFloat * 1e6)) * YOCTO) / 1000000n;
}
