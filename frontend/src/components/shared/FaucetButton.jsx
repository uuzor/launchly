import { useEffect, useState } from "react";
import { Droplets, X } from "lucide-react";
import { toast } from "sonner";
import {
  formatUnits,
  ftBalance,
  rpcView,
  storageBalance,
  useWallet,
} from "@/lib/wallet";
import { explorerTxUrl, storageDepositTx, txHash } from "@/lib/execute";
import { REF_ID, USDT_ID, WNEAR_ID, nearToBase, refQuoteOut, refSwapTx, wrapNearTx } from "@/lib/refSwap";
import { cn } from "@/lib/utils";

const AMOUNTS = [0.5, 1, 2];

async function nearBalance(accountId) {
  const res = await fetch("https://rpc.testnet.fastnear.com", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: "launchly-acct",
      method: "query",
      params: { request_type: "view_account", finality: "final", account_id: accountId },
    }),
  });
  const body = await res.json();
  if (body.error) throw new Error("account query failed");
  return BigInt(body.result.amount);
}

/** Button + modal: turns testnet NEAR into test USDT via Ref. */
export default function FaucetButton({ label = "Get USDT", className = "" }) {
  const [open, setOpen] = useState(false);
  const { connected, signIn } = useWallet();
  return (
    <>
      <button
        type="button"
        onClick={() => (connected ? setOpen(true) : signIn())}
        className={cn(
          "flex items-center gap-1.5 rounded-full border border-brand/30 bg-brand/[0.07] px-3.5 py-2 text-[12px] font-semibold text-brand transition-colors hover:bg-brand/[0.14]",
          className
        )}
      >
        <Droplets className="h-3.5 w-3.5" />
        {label}
      </button>
      {open && <FaucetModal onClose={() => setOpen(false)} />}
    </>
  );
}

function FaucetModal({ onClose }) {
  const [choice, setChoice] = useState(1);
  const [quote, setQuote] = useState(null);
  const [balances, setBalances] = useState(null);
  const [step, setStep] = useState("");
  const [error, setError] = useState("");
  const { accountId, signAndSend } = useWallet();

  useEffect(() => {
    let live = true;
    (async () => {
      try {
        const inBase = nearToBase(choice);
        const [q, near, usdt] = await Promise.all([
          refQuoteOut(inBase),
          nearBalance(accountId),
          ftBalance(USDT_ID, accountId),
        ]);
        if (live) {
          setQuote(q);
          setBalances({ near, usdt });
        }
      } catch (e) {
        if (live) setError(`Quote failed: ${e.message.slice(0, 120)}`);
      }
    })();
    return () => {
      live = false;
    };
  }, [choice, accountId]);

  const run = async () => {
    setError("");
    const inBase = nearToBase(choice);
    try {
      // 1. registrations (wrap + Ref + USDT receipt), only if missing
      const [sw, sr, su] = await Promise.all([
        storageBalance(WNEAR_ID, accountId),
        storageBalance(REF_ID, accountId),
        storageBalance(USDT_ID, accountId),
      ]);
      if (sw?.total == null) {
        setStep("Registering wNEAR…");
        await signAndSend([storageDepositTx(WNEAR_ID, accountId)]);
      }
      if (sr?.total == null) {
        setStep("Registering Ref…");
        await signAndSend([storageDepositTx(REF_ID, accountId)]);
      }
      if (su?.total == null) {
        setStep("Registering USDT…");
        await signAndSend([storageDepositTx(USDT_ID, accountId)]);
      }
      // 2. wrap NEAR
      setStep(`Wrapping ${choice} NEAR…`);
      await signAndSend([wrapNearTx(inBase.toString())]);
      // 3. swap with 2% slippage guard on a fresh quote
      setStep("Swapping on Ref…");
      const fresh = await refQuoteOut(inBase);
      const minOut = ((fresh * 9800n) / 10000n).toString();
      const outcomes = await signAndSend([refSwapTx(inBase.toString(), minOut)]);
      const hash = txHash(outcomes[0]);
      const usdt = await ftBalance(USDT_ID, accountId);
      setBalances((b) => ({ ...b, usdt }));
      toast.success("Test USDT received", {
        description: `Balance: ${formatUnits(usdt, 6)} USDT`,
        action: hash
          ? { label: "Explorer", onClick: () => window.open(explorerTxUrl(hash), "_blank") }
          : undefined,
      });
      onClose();
    } catch (e) {
      const msg = /reject|cancel|dismiss/i.test(e.message)
        ? "Rejected in wallet — nothing moved"
        : e.message;
      setError(msg.slice(0, 200));
    } finally {
      setStep("");
    }
  };

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/70 p-4" onClick={onClose}>
      <div
        className="w-full max-w-md rounded-2xl border border-white/10 bg-[#0c0c0c] p-5"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-[15px] font-semibold text-white">Get test USDT</h2>
            <p className="mt-0.5 text-[11.5px] text-white/40">
              Wraps your testnet NEAR and swaps it on Ref (testnet)
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="grid h-8 w-8 place-items-center rounded-full border border-white/10 text-white/50 hover:text-white"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="mt-4 flex gap-2 text-[11.5px] text-white/45">
          <span>
            NEAR: <span className="num text-white/75">{balances ? formatUnits(balances.near, 24, 3) : "…"}</span>
          </span>
          <span className="text-white/20">·</span>
          <span>
            USDT: <span className="num text-white/75">{balances ? formatUnits(balances.usdt, 6, 2) : "…"}</span>
          </span>
        </div>

        <div className="mt-3 grid grid-cols-3 gap-2">
          {AMOUNTS.map((a) => (
            <button
              key={a}
              type="button"
              onClick={() => setChoice(a)}
              className={cn(
                "rounded-xl border py-2.5 text-[13px] font-semibold transition-colors",
                choice === a
                  ? "border-brand/40 bg-brand/[0.1] text-brand"
                  : "border-white/10 text-white/50 hover:border-white/25 hover:text-white"
              )}
            >
              {a} NEAR
            </button>
          ))}
        </div>

        <p className="mt-3 text-center text-[12px] text-white/45">
          {quote == null ? "Fetching Ref quote…" : `≈ ${formatUnits(quote, 6, 2)} USDT (−2% slippage guard)`}
        </p>

        {error && (
          <p className="mt-3 rounded-xl border border-down/25 bg-down/[0.06] p-3 text-[11.5px] text-down">
            {error}
          </p>
        )}

        <button
          type="button"
          onClick={run}
          disabled={!!step || quote == null}
          className="mt-4 w-full rounded-xl bg-brand py-2.5 text-[13px] font-semibold text-black transition hover:brightness-105 disabled:opacity-35"
        >
          {step || `Swap ${choice} NEAR → USDT`}
        </button>
        <p className="mt-2 text-center text-[10px] text-white/25">
          2–5 wallet approvals (wrap + swap, plus one-time registrations)
        </p>
      </div>
    </div>
  );
}
