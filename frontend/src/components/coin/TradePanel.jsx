import { useEffect, useState } from "react";
import { ArrowDownUp } from "lucide-react";
import { toast } from "sonner";
import { TOKEN_DECIMALS, useQuote } from "@/lib/launchly";
import {
  formatUnits,
  ftBalance,
  parseUnits,
  storageBalance,
  useWallet,
} from "@/lib/wallet";
import {
  buyTx,
  explorerTxUrl,
  sellTx,
  storageDepositTx,
  txHash,
} from "@/lib/execute";
import { usd } from "@/lib/format";
import FaucetButton from "@/components/shared/FaucetButton";
import { cn } from "@/lib/utils";

const SLIPPAGE_BPS = 200; // 2%

/**
 * Trade panel. Wallet-connected + live backend: real bonding-curve trades,
 * signed by the user (ft_transfer_call with slippage protection).
 * Otherwise: clearly-labelled simulated fills in the demo wallet.
 */
export default function TradePanel({ product, balance, holdings, onTrade, onChainTrade = null, live }) {
  const [mode, setMode] = useState("buy");
  const [amount, setAmount] = useState("");
  const [busy, setBusy] = useState("");
  const { accountId, connected, signIn, signAndSend } = useWallet();

  const chain = product?.chain ?? {};
  const decimals = chain.reserve_decimals ?? 6;
  const usdtId = chain.reserve_token ?? null;
  const tokenId = product?.tokenAccount ?? null;
  const real = live && connected && !!usdtId && !!tokenId;

  const [usdtBal, setUsdtBal] = useState(null);
  const [tokenBal, setTokenBal] = useState(null);
  const [registered, setRegistered] = useState({ usdt: true, token: true });

  const refreshBalances = async () => {
    if (!real) return;
    const [u, t, su, st] = await Promise.all([
      ftBalance(usdtId, accountId),
      ftBalance(tokenId, accountId),
      storageBalance(usdtId, accountId),
      storageBalance(tokenId, accountId),
    ]);
    setUsdtBal(u);
    setTokenBal(t);
    setRegistered({ usdt: su?.total != null, token: st?.total != null });
  };

  useEffect(() => {
    refreshBalances();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [real, accountId, usdtId, tokenId]);

  const payBase = parseUnits(amount, mode === "buy" ? decimals : TOKEN_DECIMALS);
  const { quote, error, loading } = useQuote(
    live ? product?.productId : null,
    mode,
    payBase && payBase > 0n ? payBase.toString() : ""
  );

  const feeBps = chain.fee_bps ?? 100;
  const quotedRaw = quote ? (mode === "buy" ? quote.tokens_out : quote.net_proceeds) : null;
  const quotedOut =
    quotedRaw != null ? Number(quotedRaw) / 10 ** (mode === "buy" ? TOKEN_DECIMALS : decimals) : null;
  const quotedFee = quote ? Number(quote.fee ?? 0) / 10 ** decimals : null;
  const spotOut = product?.price ? Number(amount || 0) / product.price : 0;
  const fallbackFee = Number(amount || 0) * (feeBps / 10000);
  const out = live && quotedOut != null ? quotedOut : spotOut;
  const fee = live && quotedFee != null ? quotedFee : fallbackFee;

  const needUsdtReg = real && !registered.usdt;
  const needTokenReg = real && !registered.token;
  const maxPay = real ? (mode === "buy" ? usdtBal : tokenBal) : null;

  const runTx = async (label, transactions, done) => {
    setBusy(label);
    try {
      const outcomes = await signAndSend(transactions);
      const hash = txHash(outcomes[0]);
      toast.success(`${label} submitted`, {
        description: hash ? `View on NEAR Explorer` : undefined,
        action: hash
          ? { label: "Explorer", onClick: () => window.open(explorerTxUrl(hash), "_blank") }
          : undefined,
      });
      await refreshBalances();
      onChainTrade?.();
      done?.();
    } catch (e) {
      const msg = /reject|cancel|dismiss/i.test(e.message) ? "Transaction rejected in wallet" : e.message;
      toast.error(`${label} failed`, { description: msg.slice(0, 160) });
    } finally {
      setBusy("");
    }
  };

  // Slippage-protected minimum from the live quote (quote is pre-tx, so take
  // (100% - slippage) of the quoted output, floored at 1 base unit).
  const minOut = (raw, outDecimals) => {
    if (raw == null) return "1";
    const v = (BigInt(raw) * BigInt(10000 - SLIPPAGE_BPS)) / 10000n;
    return (v > 0n ? v : 1n).toString();
  };

  const submit = async () => {
    if (!payBase || payBase <= 0n) return;
    if (!real) {
      if (live && error) {
        toast.error("Quote failed — trade blocked, not estimated");
        return;
      }
      onTrade({ mode, amount: Number(amount), fee });
      setAmount("");
      return;
    }
    if (maxPay != null && payBase > maxPay) {
      toast.error(`Insufficient ${mode === "buy" ? "USDT" : product.symbol} balance`);
      return;
    }
    if (error || quotedRaw == null) {
      toast.error("Quote failed — trade blocked, not estimated");
      return;
    }
    if (mode === "buy") {
      await runTx(
        `Buy ${product.symbol}`,
        [buyTx(usdtId, payBase.toString(), product.productId, minOut(quotedRaw))],
        () => setAmount("")
      );
    } else {
      await runTx(
        `Sell ${product.symbol}`,
        [sellTx(tokenId, payBase.toString(), product.productId, minOut(quotedRaw))],
        () => setAmount("")
      );
    }
  };

  const payLabel = mode === "buy" ? "Pay (USDT)" : `Pay (${product.symbol})`;
  const payHint = real
    ? mode === "buy"
      ? `${formatUnits(usdtBal, decimals)} USDT`
      : `${formatUnits(tokenBal, TOKEN_DECIMALS)} ${product.symbol}`
    : mode === "buy"
      ? usd(balance)
      : `${holdings.toLocaleString("en-US", { maximumFractionDigits: 2 })} ${product.symbol}`;

  return (
    <div className="rounded-2xl border border-white/[0.08] bg-[#0a0a0a] p-5">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-1 rounded-full border border-white/10 bg-white/[0.03] p-1">
          {["buy", "sell"].map((m) => (
            <button
              key={m}
              type="button"
              onClick={() => {
                setMode(m);
                setAmount("");
              }}
              className={cn(
                "rounded-full px-4 py-1.5 text-[12px] font-semibold capitalize transition-colors",
                mode === m
                  ? m === "buy"
                    ? "bg-up/20 text-up"
                    : "bg-down/20 text-down"
                  : "text-white/40 hover:text-white/80"
              )}
            >
              {m}
            </button>
          ))}
        </div>
        <span
          className={cn(
            "rounded-full border px-2 py-0.5 text-[9px] font-bold uppercase tracking-wider",
            real
              ? "border-brand/25 bg-brand/[0.07] text-brand"
              : live
                ? "border-amber-400/25 bg-amber-400/10 text-amber-300"
                : "border-white/10 text-white/35"
          )}
        >
          {real ? "Live trade" : live ? "Wallet needed" : "Simulated"}
        </span>
      </div>

      {live && !connected && (
        <button
          type="button"
          onClick={signIn}
          className="mt-4 w-full rounded-xl border border-brand/30 bg-brand/[0.07] py-2.5 text-[12.5px] font-semibold text-brand transition-colors hover:bg-brand/[0.12]"
        >
          Connect wallet to trade for real
        </button>
      )}

      {needUsdtReg && (
        <SetupRow
          label="Register USDT storage (one-time, ~0.00125 NEAR)"
          action="Register"
          busy={busy === "Register USDT"}
          onClick={() => runTx("Register USDT", [storageDepositTx(usdtId, accountId)])}
        />
      )}
      {needTokenReg && (
        <SetupRow
          label={`Register ${product.symbol} storage (one-time, ~0.00125 NEAR)`}
          action="Register"
          busy={busy === `Register ${product.symbol}`}
          onClick={() => runTx(`Register ${product.symbol}`, [storageDepositTx(tokenId, accountId)])}
        />
      )}
      {real && registered.usdt && usdtBal === 0n && (
        <div className="mt-3 rounded-xl border border-amber-400/20 bg-amber-400/[0.05] px-3 py-2.5">
          <p className="text-[11.5px] text-amber-200/80">
            You hold no test USDT. Swap testnet NEAR for USDT without leaving the page.
          </p>
          <FaucetButton label="Get test USDT" className="mt-2 border-amber-400/30 bg-amber-400/10 text-amber-200 hover:bg-amber-400/20" />
        </div>
      )}

      <div className="mt-4 rounded-xl border border-white/10 bg-white/[0.02] p-3">
        <div className="flex items-center justify-between text-[10px] uppercase tracking-[0.16em] text-white/30">
          <span>{payLabel}</span>
          <button
            type="button"
            onClick={() => {
              if (maxPay != null) {
                const d = mode === "buy" ? decimals : TOKEN_DECIMALS;
                setAmount((Number(maxPay) / 10 ** d).toString());
              }
            }}
            className="num normal-case tracking-normal text-white/40 hover:text-white"
            title="Use max balance"
          >
            {payHint}
          </button>
        </div>
        <input
          value={amount}
          onChange={(e) => setAmount(e.target.value.replace(/[^0-9.]/g, ""))}
          placeholder="0.00"
          inputMode="decimal"
          className="num mt-1 w-full bg-transparent text-2xl font-semibold text-white placeholder:text-white/15 focus:outline-none"
        />
      </div>

      <div className="my-2 flex justify-center">
        <span className="grid h-7 w-7 place-items-center rounded-full border border-white/10 bg-[#111] text-white/40">
          <ArrowDownUp className="h-3.5 w-3.5" />
        </span>
      </div>

      <div className="rounded-xl border border-white/10 bg-white/[0.02] p-3">
        <p className="text-[10px] uppercase tracking-[0.16em] text-white/30">
          Receive {loading ? "(quoting…)" : ""} {real && "(min −2% slip.)"}
        </p>
        <p className="num mt-1 text-2xl font-semibold text-white">
          {out
            ? `${out.toLocaleString("en-US", { maximumFractionDigits: mode === "buy" ? 0 : 4 })} ${mode === "buy" ? product.symbol : "USDT"}`
            : "—"}
        </p>
        <div className="mt-2 space-y-1 text-[11px] text-white/40">
          <div className="flex justify-between">
            <span>Curve fee ({(feeBps / 100).toFixed(2)}%)</span>
            <span className="num">{usd(fee)}</span>
          </div>
          <div className="flex justify-between">
            <span>To creator pool (70%)</span>
            <span className="num text-brand">{usd(fee * 0.7)}</span>
          </div>
          {live && error && (
            <p className="pt-1 text-[11px] text-down">Quote unavailable: {error.message}</p>
          )}
        </div>
      </div>

      <button
        type="button"
        onClick={submit}
        disabled={!payBase || payBase <= 0n || !!busy}
        className={cn(
          "mt-4 w-full rounded-xl py-3 text-[13px] font-semibold transition-all disabled:cursor-not-allowed disabled:opacity-30",
          mode === "buy" ? "bg-up text-black hover:brightness-105" : "bg-down text-black hover:brightness-105"
        )}
      >
        {busy ||
          (real
            ? `${mode === "buy" ? "Buy" : "Sell"} ${product.symbol} on-chain`
            : `${mode === "buy" ? "Buy" : "Sell"} ${product.symbol} (simulated)`)}
      </button>
      <p className="mt-2 text-center text-[10px] text-white/25">
        {real
          ? "Signed in your wallet · 1 yocto + gas · slippage-protected"
          : live
            ? "Connect a wallet for real trades · fills simulated until then"
            : "Simulated price · connect the backend for live quotes"}
      </p>
    </div>
  );
}

function SetupRow({ label, action, onClick, busy, icon }) {
  return (
    <div className="mt-3 flex items-center justify-between gap-3 rounded-xl border border-amber-400/20 bg-amber-400/[0.05] px-3 py-2.5">
      <p className="text-[11.5px] text-amber-200/80">{label}</p>
      <button
        type="button"
        onClick={onClick}
        disabled={busy}
        className="flex shrink-0 items-center gap-1.5 rounded-lg bg-amber-400/15 px-3 py-1.5 text-[11.5px] font-semibold text-amber-200 transition-colors hover:bg-amber-400/25 disabled:opacity-40"
      >
        {icon}
        {busy ? "…" : action}
      </button>
    </div>
  );
}
